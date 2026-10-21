import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db/database.ts';
import { createRepository, type Repository } from '../../src/db/repository.ts';
import type { ExtractionDecision, InboundLead } from '../../src/domain/types.ts';
import { extraction } from '../helpers/harness.ts';

const now = new Date('2026-10-20T07:00:00.000Z');
const later = (minutes: number): Date => new Date(now.getTime() + minutes * 60_000);

const inbound = (key: string): InboundLead => ({
  source: 'form',
  idempotencyKey: key,
  receivedAt: now.toISOString(),
  subject: null,
  text: 'hello',
  hints: {},
  meta: {},
  parseWarnings: [],
});

const decision: ExtractionDecision = { extraction: extraction(), method: 'ai', fallbackReason: null, fallbackDetail: null, lowConfidenceFields: [], aiLatencyMs: 5 };

describe('repository', () => {
  let db: DatabaseSync;
  let repo: Repository;

  beforeEach(() => {
    db = openDatabase(':memory:');
    repo = createRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it('migrates once and records the schema version', () => {
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 });
    expect(repo.ping()).toBe(true);
  });

  it('claims a lead once per idempotency key', () => {
    const first = repo.claimLead(inbound('form:1'), now);
    const second = repo.claimLead(inbound('form:1'), now);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.lead.id).toBe(first.lead.id);
    repo.recordDuplicateHit(first.lead.id, now);
    expect(repo.getLead(first.lead.id)?.duplicateHits).toBe(1);
    expect(repo.listLeads()).toHaveLength(1);
  });

  it('round trips the decision and CRM checkpoints', () => {
    const { lead } = repo.claimLead(inbound('form:2'), now);
    repo.markProcessing(lead.id, now);
    repo.saveDecision(lead.id, decision, 'auto_draft', true, now);
    repo.saveCrmCheckpoint(lead.id, { contactId: '1001', dedupeMatch: 'contact_email' }, now);
    repo.saveCrmCheckpoint(lead.id, { companyId: null, dealId: '3001' }, now);
    repo.saveCrmCheckpoint(lead.id, {}, now);
    repo.saveSlackCard(lead.id, 'C1', '1.1', now);
    repo.completeLead(lead.id, 'drafted', now, 12.4);
    const row = repo.getLead(lead.id);
    expect(row).toMatchObject({
      status: 'drafted',
      route: 'auto_draft',
      priority: true,
      attempts: 1,
      contactId: '1001',
      companyId: null,
      dealId: '3001',
      dedupeMatch: 'contact_email',
      slackChannel: 'C1',
      slackTs: '1.1',
      latencyMs: 12,
    });
    expect(row?.decision?.extraction.email.value).toBe('test.person@test-company.example.com');
    expect(repo.getLeadThatCreatedDeal('3001')?.id).toBe(lead.id);
    expect(repo.getLeadByKey('form:2')?.id).toBe(lead.id);
    expect(repo.getLead(999)).toBeNull();
  });

  it('dead letters a lead and tracks replays', () => {
    const { lead } = repo.claimLead(inbound('form:3'), now);
    const id = repo.deadLetter({ leadId: lead.id, stage: 'hubspot.contacts.search', error: 'x'.repeat(3000), httpStatus: 429, attempts: 5 }, now);
    expect(repo.getLead(lead.id)?.status).toBe('dead_lettered');
    expect(repo.countPendingDeadLetters()).toBe(1);
    const row = repo.getDeadLetter(id);
    expect(row).toMatchObject({ leadId: lead.id, stage: 'hubspot.contacts.search', httpStatus: 429, attempts: 5, idempotencyKey: 'form:3' });
    expect(row?.error).toHaveLength(2000);
    repo.markReplayed(id, 'ok: drafted', now);
    expect(repo.countPendingDeadLetters()).toBe(0);
    expect(repo.listDeadLetters({ pendingOnly: true })).toHaveLength(0);
    expect(repo.listDeadLetters()).toHaveLength(1);
    expect(repo.getDeadLetter(12345)).toBeNull();
    expect(() => repo.deadLetter({ leadId: 404, stage: 's', error: 'e', httpStatus: null, attempts: 1 }, now)).toThrow('Lead 404 not found');
  });

  it('lets only one person decide a lead', () => {
    const { lead } = repo.claimLead(inbound('form:4'), now);
    repo.completeLead(lead.id, 'drafted', now, 1);
    expect(repo.recordDecision(lead.id, 'approved', 'U1', now)).toBe(true);
    expect(repo.recordDecision(lead.id, 'not_a_fit', 'U2', now)).toBe(false);
    expect(repo.getLead(lead.id)).toMatchObject({ status: 'approved', decidedBy: 'U1' });
    repo.revertDecision(lead.id, 'drafted', now);
    expect(repo.getLead(lead.id)).toMatchObject({ status: 'drafted', decidedBy: null });
  });

  it('assigns once, and the same person may click again', () => {
    const { lead } = repo.claimLead(inbound('form:5'), now);
    expect(repo.recordAssignment(lead.id, 'U1', now)).toBe(true);
    expect(repo.recordAssignment(lead.id, 'U1', now)).toBe(true);
    expect(repo.recordAssignment(lead.id, 'U2', now)).toBe(false);
  });

  it('finds untouched cards for reminders', () => {
    const touched = repo.claimLead(inbound('form:6'), now).lead;
    const untouched = repo.claimLead(inbound('form:7'), now).lead;
    const recent = repo.claimLead(inbound('form:8'), now).lead;
    for (const lead of [touched, untouched, recent]) {
      repo.completeLead(lead.id, 'drafted', now, 1);
    }
    repo.saveSlackCard(touched.id, 'C1', '1.1', now);
    repo.saveSlackCard(untouched.id, 'C1', '1.2', now);
    repo.saveSlackCard(recent.id, 'C1', '1.3', later(100));
    repo.recordAssignment(touched.id, 'U1', now);
    const candidates = repo.listReminderCandidates(later(90).toISOString());
    expect(candidates.map((lead) => lead.id)).toEqual([untouched.id]);
    repo.markReminded(untouched.id, later(121));
    expect(repo.listReminderCandidates(later(300).toISOString()).map((lead) => lead.id)).toEqual([recent.id]);
    expect(repo.listAwaitingDecision()).toHaveLength(3);
  });

  it('claims a digest date once and can release a failed claim', () => {
    expect(repo.claimDigest('2026-10-21', now)).toBe(true);
    expect(repo.claimDigest('2026-10-21', now)).toBe(false);
    repo.releaseDigest('2026-10-21');
    expect(repo.claimDigest('2026-10-21', now)).toBe(true);
    repo.completeDigest('2026-10-21', '1.9');
    repo.releaseDigest('2026-10-21');
    expect(repo.claimDigest('2026-10-21', now)).toBe(false);
  });

  it('lists interrupted and recent leads', () => {
    const stuck = repo.claimLead(inbound('form:9'), now).lead;
    repo.markProcessing(stuck.id, now);
    const done = repo.claimLead(inbound('form:10'), now).lead;
    repo.completeLead(done.id, 'spam', now, 1);
    expect(repo.listInterrupted(later(1).toISOString()).map((lead) => lead.id)).toEqual([stuck.id]);
    expect(repo.listLeadsReceivedBetween(now.toISOString(), later(1).toISOString())).toHaveLength(2);
    expect(repo.listLeadsReceivedBetween(later(1).toISOString(), later(2).toISOString())).toHaveLength(0);
  });

  it('creates the database file and folder on disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ltd-'));
    const path = join(dir, 'nested', 'copilot.db');
    const fileDb = openDatabase(path);
    expect(existsSync(path)).toBe(true);
    expect(fileDb.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    fileDb.close();
    const reopened = openDatabase(path);
    expect(reopened.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 });
    reopened.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
