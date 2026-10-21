import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import type {
  DedupeMatch,
  ExtractionDecision,
  InboundLead,
  LeadSource,
  LeadStatus,
  Route,
} from '../domain/types.ts';

export interface LeadRow {
  id: number;
  idempotencyKey: string;
  source: LeadSource;
  status: LeadStatus;
  route: Route | null;
  priority: boolean;
  inbound: InboundLead;
  decision: ExtractionDecision | null;
  contactId: string | null;
  companyId: string | null;
  dealId: string | null;
  noteId: string | null;
  dedupeMatch: DedupeMatch | null;
  mergedIntoDealId: string | null;
  slackChannel: string | null;
  slackTs: string | null;
  cardPostedAt: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  assignedTo: string | null;
  assignedAt: string | null;
  remindedAt: string | null;
  attempts: number;
  duplicateHits: number;
  receivedAt: string;
  updatedAt: string;
  completedAt: string | null;
  latencyMs: number | null;
}

export interface DeadLetterRow {
  id: number;
  leadId: number;
  idempotencyKey: string;
  source: LeadSource;
  stage: string;
  error: string;
  httpStatus: number | null;
  attempts: number;
  createdAt: string;
  replayedAt: string | null;
  replayOutcome: string | null;
}

export interface CrmCheckpoint {
  contactId?: string;
  companyId?: string | null;
  dealId?: string;
  noteId?: string;
  dedupeMatch?: DedupeMatch;
  mergedIntoDealId?: string | null;
}

export interface Repository {
  /** Inserts the lead unless its idempotency key exists. `created: false` means a replay. */
  claimLead: (lead: InboundLead, now: Date) => { created: boolean; lead: LeadRow };
  getLead: (id: number) => LeadRow | null;
  getLeadByKey: (idempotencyKey: string) => LeadRow | null;
  /** The lead whose card announced a deal, so follow ups can be threaded under it. */
  getLeadThatCreatedDeal: (dealId: string) => LeadRow | null;
  listLeads: () => LeadRow[];
  listAwaitingDecision: () => LeadRow[];
  listLeadsReceivedBetween: (fromIso: string, toIso: string) => LeadRow[];
  recordDuplicateHit: (id: number, now: Date) => void;
  markProcessing: (id: number, now: Date) => void;
  saveDecision: (id: number, decision: ExtractionDecision, route: Route, priority: boolean, now: Date) => void;
  saveCrmCheckpoint: (id: number, checkpoint: CrmCheckpoint, now: Date) => void;
  saveSlackCard: (id: number, channel: string, ts: string, now: Date) => void;
  completeLead: (id: number, status: LeadStatus, now: Date, latencyMs: number) => void;
  deadLetter: (input: { leadId: number; stage: string; error: string; httpStatus: number | null; attempts: number }, now: Date) => number;
  listDeadLetters: (options?: { pendingOnly?: boolean }) => DeadLetterRow[];
  getDeadLetter: (id: number) => DeadLetterRow | null;
  markReplayed: (deadLetterId: number, outcome: string, now: Date) => void;
  countPendingDeadLetters: () => number;
  /** Conditional update, so two people clicking at once cannot both win. */
  recordDecision: (id: number, status: 'approved' | 'not_a_fit', userId: string, now: Date) => boolean;
  revertDecision: (id: number, previousStatus: LeadStatus, now: Date) => void;
  recordAssignment: (id: number, userId: string, now: Date) => boolean;
  listReminderCandidates: (postedBeforeIso: string) => LeadRow[];
  markReminded: (id: number, now: Date) => void;
  claimDigest: (digestDate: string, now: Date) => boolean;
  completeDigest: (digestDate: string, slackTs: string) => void;
  releaseDigest: (digestDate: string) => void;
  /** Leads stuck in received or processing since before the cutoff, for crash recovery. */
  listInterrupted: (updatedBeforeIso: string) => LeadRow[];
  ping: () => boolean;
}

type Row = Record<string, SQLOutputValue>;

const text = (row: Row, key: string): string => {
  const value = row[key];
  if (typeof value !== 'string') {
    throw new Error(`Column ${key} is not text`);
  }
  return value;
};

const textOrNull = (row: Row, key: string): string | null => {
  const value = row[key];
  return typeof value === 'string' ? value : null;
};

const integer = (row: Row, key: string): number => {
  const value = row[key];
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  throw new Error(`Column ${key} is not a number`);
};

const integerOrNull = (row: Row, key: string): number | null => {
  const value = row[key];
  if (value === null || value === undefined) {
    return null;
  }
  return integer(row, key);
};

const toLead = (row: Row): LeadRow => {
  const extractionJson = textOrNull(row, 'extraction_json');
  return {
    id: integer(row, 'id'),
    idempotencyKey: text(row, 'idempotency_key'),
    source: text(row, 'source') as LeadSource,
    status: text(row, 'status') as LeadStatus,
    route: textOrNull(row, 'route') as Route | null,
    priority: integer(row, 'priority') === 1,
    inbound: JSON.parse(text(row, 'inbound_json')) as InboundLead,
    decision: extractionJson === null ? null : (JSON.parse(extractionJson) as ExtractionDecision),
    contactId: textOrNull(row, 'contact_id'),
    companyId: textOrNull(row, 'company_id'),
    dealId: textOrNull(row, 'deal_id'),
    noteId: textOrNull(row, 'note_id'),
    dedupeMatch: textOrNull(row, 'dedupe_match') as DedupeMatch | null,
    mergedIntoDealId: textOrNull(row, 'merged_into_deal_id'),
    slackChannel: textOrNull(row, 'slack_channel'),
    slackTs: textOrNull(row, 'slack_ts'),
    cardPostedAt: textOrNull(row, 'card_posted_at'),
    decidedBy: textOrNull(row, 'decided_by'),
    decidedAt: textOrNull(row, 'decided_at'),
    assignedTo: textOrNull(row, 'assigned_to'),
    assignedAt: textOrNull(row, 'assigned_at'),
    remindedAt: textOrNull(row, 'reminded_at'),
    attempts: integer(row, 'attempts'),
    duplicateHits: integer(row, 'duplicate_hits'),
    receivedAt: text(row, 'received_at'),
    updatedAt: text(row, 'updated_at'),
    completedAt: textOrNull(row, 'completed_at'),
    latencyMs: integerOrNull(row, 'latency_ms'),
  };
};

const toDeadLetter = (row: Row): DeadLetterRow => ({
  id: integer(row, 'id'),
  leadId: integer(row, 'lead_id'),
  idempotencyKey: text(row, 'idempotency_key'),
  source: text(row, 'source') as LeadSource,
  stage: text(row, 'stage'),
  error: text(row, 'error'),
  httpStatus: integerOrNull(row, 'http_status'),
  attempts: integer(row, 'attempts'),
  createdAt: text(row, 'created_at'),
  replayedAt: textOrNull(row, 'replayed_at'),
  replayOutcome: textOrNull(row, 'replay_outcome'),
});

const CHECKPOINT_COLUMNS: Record<keyof CrmCheckpoint, string> = {
  contactId: 'contact_id',
  companyId: 'company_id',
  dealId: 'deal_id',
  noteId: 'note_id',
  dedupeMatch: 'dedupe_match',
  mergedIntoDealId: 'merged_into_deal_id',
};

const DECIDABLE_STATUSES = "('drafted', 'needs_review')";

export const createRepository = (db: DatabaseSync): Repository => {
  const inTransaction = <T>(work: () => T): T => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };

  const getLead = (id: number): LeadRow | null => {
    const row = db.prepare('SELECT * FROM leads WHERE id = :id').get({ id });
    return row ? toLead(row) : null;
  };

  const getLeadByKey = (idempotencyKey: string): LeadRow | null => {
    const row = db.prepare('SELECT * FROM leads WHERE idempotency_key = :key').get({ key: idempotencyKey });
    return row ? toLead(row) : null;
  };

  const requireLead = (id: number): LeadRow => {
    const lead = getLead(id);
    if (!lead) {
      throw new Error(`Lead ${String(id)} not found`);
    }
    return lead;
  };

  const deadLetterSelect = `
    SELECT d.*, l.idempotency_key, l.source
    FROM dead_letters d JOIN leads l ON l.id = d.lead_id`;

  return {
    claimLead: (lead, now) => {
      const result = db
        .prepare(
          `INSERT INTO leads (idempotency_key, source, status, inbound_json, received_at, updated_at)
           VALUES (:key, :source, 'received', :inbound, :receivedAt, :now)
           ON CONFLICT (idempotency_key) DO NOTHING`,
        )
        .run({
          key: lead.idempotencyKey,
          source: lead.source,
          inbound: JSON.stringify(lead),
          receivedAt: lead.receivedAt,
          now: now.toISOString(),
        });
      const row = getLeadByKey(lead.idempotencyKey);
      if (!row) {
        throw new Error(`Lead with key ${lead.idempotencyKey} vanished after insert`);
      }
      return { created: Number(result.changes) === 1, lead: row };
    },

    getLead,
    getLeadByKey,

    getLeadThatCreatedDeal: (dealId) => {
      const row = db
        .prepare('SELECT * FROM leads WHERE deal_id = :dealId AND merged_into_deal_id IS NULL ORDER BY id LIMIT 1')
        .get({ dealId });
      return row ? toLead(row) : null;
    },

    listLeads: () => db.prepare('SELECT * FROM leads ORDER BY id').all().map(toLead),

    listAwaitingDecision: () =>
      db.prepare(`SELECT * FROM leads WHERE status IN ${DECIDABLE_STATUSES} ORDER BY card_posted_at, id`).all().map(toLead),

    listLeadsReceivedBetween: (fromIso, toIso) =>
      db
        .prepare('SELECT * FROM leads WHERE received_at >= :from AND received_at < :to ORDER BY received_at, id')
        .all({ from: fromIso, to: toIso })
        .map(toLead),

    recordDuplicateHit: (id, now) => {
      db.prepare('UPDATE leads SET duplicate_hits = duplicate_hits + 1, updated_at = :now WHERE id = :id').run({ id, now: now.toISOString() });
    },

    markProcessing: (id, now) => {
      db.prepare("UPDATE leads SET status = 'processing', attempts = attempts + 1, updated_at = :now WHERE id = :id").run({
        id,
        now: now.toISOString(),
      });
    },

    saveDecision: (id, decision, route, priority, now) => {
      db.prepare(
        'UPDATE leads SET extraction_json = :decision, route = :route, priority = :priority, updated_at = :now WHERE id = :id',
      ).run({ id, decision: JSON.stringify(decision), route, priority: priority ? 1 : 0, now: now.toISOString() });
    },

    saveCrmCheckpoint: (id, checkpoint, now) => {
      const entries = (Object.keys(checkpoint) as (keyof CrmCheckpoint)[]).filter((key) => checkpoint[key] !== undefined);
      if (entries.length === 0) {
        return;
      }
      const assignments = entries.map((key) => `${CHECKPOINT_COLUMNS[key]} = :${key}`).join(', ');
      const params: Record<string, string | number | null> = { id, now: now.toISOString() };
      for (const key of entries) {
        params[key] = checkpoint[key] ?? null;
      }
      db.prepare(`UPDATE leads SET ${assignments}, updated_at = :now WHERE id = :id`).run(params);
    },

    saveSlackCard: (id, channel, ts, now) => {
      db.prepare(
        'UPDATE leads SET slack_channel = :channel, slack_ts = :ts, card_posted_at = :now, updated_at = :now WHERE id = :id',
      ).run({ id, channel, ts, now: now.toISOString() });
    },

    completeLead: (id, status, now, latencyMs) => {
      db.prepare(
        'UPDATE leads SET status = :status, completed_at = :now, latency_ms = :latency, updated_at = :now WHERE id = :id',
      ).run({ id, status, latency: Math.round(latencyMs), now: now.toISOString() });
    },

    deadLetter: (input, now) =>
      inTransaction(() => {
        requireLead(input.leadId);
        const result = db
          .prepare(
            `INSERT INTO dead_letters (lead_id, stage, error, http_status, attempts, created_at)
             VALUES (:leadId, :stage, :error, :httpStatus, :attempts, :now)`,
          )
          .run({
            leadId: input.leadId,
            stage: input.stage,
            error: input.error.slice(0, 2000),
            httpStatus: input.httpStatus,
            attempts: input.attempts,
            now: now.toISOString(),
          });
        db.prepare("UPDATE leads SET status = 'dead_lettered', updated_at = :now WHERE id = :id").run({
          id: input.leadId,
          now: now.toISOString(),
        });
        return Number(result.lastInsertRowid);
      }),

    listDeadLetters: (options = {}) =>
      db
        .prepare(`${deadLetterSelect} ${options.pendingOnly ? 'WHERE d.replayed_at IS NULL' : ''} ORDER BY d.id`)
        .all()
        .map(toDeadLetter),

    getDeadLetter: (id) => {
      const row = db.prepare(`${deadLetterSelect} WHERE d.id = :id`).get({ id });
      return row ? toDeadLetter(row) : null;
    },

    markReplayed: (deadLetterId, outcome, now) => {
      db.prepare('UPDATE dead_letters SET replayed_at = :now, replay_outcome = :outcome WHERE id = :id').run({
        id: deadLetterId,
        outcome,
        now: now.toISOString(),
      });
    },

    countPendingDeadLetters: () => {
      const row = db.prepare('SELECT COUNT(*) AS n FROM dead_letters WHERE replayed_at IS NULL').get();
      return row ? integer(row, 'n') : 0;
    },

    recordDecision: (id, status, userId, now) => {
      const result = db
        .prepare(
          `UPDATE leads SET status = :status, decided_by = :user, decided_at = :now, updated_at = :now
           WHERE id = :id AND status IN ${DECIDABLE_STATUSES}`,
        )
        .run({ id, status, user: userId, now: now.toISOString() });
      return Number(result.changes) === 1;
    },

    revertDecision: (id, previousStatus, now) => {
      db.prepare(
        'UPDATE leads SET status = :status, decided_by = NULL, decided_at = NULL, updated_at = :now WHERE id = :id',
      ).run({ id, status: previousStatus, now: now.toISOString() });
    },

    recordAssignment: (id, userId, now) => {
      const result = db
        .prepare(
          `UPDATE leads SET assigned_to = :user, assigned_at = :now, updated_at = :now
           WHERE id = :id AND (assigned_to IS NULL OR assigned_to = :user)`,
        )
        .run({ id, user: userId, now: now.toISOString() });
      return Number(result.changes) === 1;
    },

    listReminderCandidates: (postedBeforeIso) =>
      db
        .prepare(
          `SELECT * FROM leads
           WHERE status IN ${DECIDABLE_STATUSES} AND slack_ts IS NOT NULL AND assigned_to IS NULL
             AND reminded_at IS NULL AND card_posted_at <= :cutoff
           ORDER BY card_posted_at, id`,
        )
        .all({ cutoff: postedBeforeIso })
        .map(toLead),

    markReminded: (id, now) => {
      db.prepare('UPDATE leads SET reminded_at = :now, updated_at = :now WHERE id = :id').run({ id, now: now.toISOString() });
    },

    claimDigest: (digestDate, now) => {
      const result = db
        .prepare(
          `INSERT INTO digests (digest_date, status, claimed_at) VALUES (:date, 'pending', :now)
           ON CONFLICT (digest_date) DO NOTHING`,
        )
        .run({ date: digestDate, now: now.toISOString() });
      return Number(result.changes) === 1;
    },

    completeDigest: (digestDate, slackTs) => {
      db.prepare("UPDATE digests SET status = 'posted', slack_ts = :ts WHERE digest_date = :date").run({ date: digestDate, ts: slackTs });
    },

    releaseDigest: (digestDate) => {
      db.prepare("DELETE FROM digests WHERE digest_date = :date AND status = 'pending'").run({ date: digestDate });
    },

    listInterrupted: (updatedBeforeIso) =>
      db
        .prepare("SELECT * FROM leads WHERE status IN ('received', 'processing') AND updated_at <= :cutoff ORDER BY id")
        .all({ cutoff: updatedBeforeIso })
        .map(toLead),

    ping: () => {
      const row = db.prepare('SELECT 1 AS ok').get();
      return row?.ok === 1;
    },
  };
};
