import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { signBody, SIGNATURE_HEADER } from '../../src/http/signature.ts';
import { createHarness, formPayload, type Harness } from '../helpers/harness.ts';

const SECRET = 'test-signing-secret';

describe('HTTP server', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness({ listen: true, env: { FORM_WEBHOOK_SECRET: SECRET, MAX_BODY_BYTES: '20000' } });
  });

  afterEach(async () => {
    await h.close();
  });

  const postForm = async (payload: unknown, options: { sign?: boolean; contentType?: string; raw?: string } = {}): Promise<Response> => {
    const body = options.raw ?? JSON.stringify(payload);
    return fetch(`${h.baseUrl()}/webhooks/form`, {
      method: 'POST',
      headers: { 'content-type': options.contentType ?? 'application/json', ...(options.sign === false ? {} : { [SIGNATURE_HEADER]: signBody(SECRET, body) }) },
      body,
    });
  };

  it('reports health', async () => {
    const response = await fetch(`${h.baseUrl()}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'ok', mode: 'mock', database: 'ok', queue: { waiting: 0, running: 0 }, deadLettersPending: 0 });
  });

  it('accepts a signed form lead with 202, processes it, and answers a replay with 200', async () => {
    const payload = formPayload({ submissionId: 'http_1' });
    const accepted = await postForm(payload);
    expect(accepted.status).toBe(202);
    const { leadId } = (await accepted.json()) as { leadId: number };
    await h.runtime.queue.onIdle();
    expect(h.runtime.repo.getLead(leadId)?.status).toBe('drafted');

    const replay = await postForm(payload);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ status: 'duplicate', leadId, leadStatus: 'drafted' });
    expect(h.hubspot.objects.deals.size).toBe(1);
  });

  it('rejects unsigned or tampered requests when a secret is set', async () => {
    expect((await postForm(formPayload(), { sign: false })).status).toBe(401);
    const body = JSON.stringify(formPayload());
    const tampered = await fetch(`${h.baseUrl()}/webhooks/form`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: signBody(SECRET, body) },
      body: body.replace('Test Person', 'Evil Person'),
    });
    expect(tampered.status).toBe(401);
    expect(h.runtime.repo.listLeads()).toHaveLength(0);
  });

  it('validates the request', async () => {
    const missing = await postForm({ email: 'a@example.com' });
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error: string }).error).toContain('message');
    expect((await postForm(null, { raw: '{not json' })).status).toBe(400);
    expect((await postForm(formPayload(), { contentType: 'text/plain' })).status).toBe(415);
    expect((await postForm(formPayload({ message: 'x'.repeat(30_000) }))).status).toBe(413);
  });

  it('accepts raw and JSON wrapped emails', async () => {
    const raw = readFileSync(join(import.meta.dirname, '..', '..', 'fixtures', 'email', 'e01-noordhoek-brewing.eml'), 'utf8');
    const direct = await fetch(`${h.baseUrl()}/webhooks/email`, { method: 'POST', headers: { 'content-type': 'message/rfc822' }, body: raw });
    expect(direct.status).toBe(202);
    const wrapped = await fetch(`${h.baseUrl()}/webhooks/email`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ raw }) });
    expect(wrapped.status).toBe(200);
    await h.runtime.queue.onIdle();
    expect(h.runtime.repo.listLeads()).toHaveLength(1);

    expect((await fetch(`${h.baseUrl()}/webhooks/email`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(400);
    expect((await fetch(`${h.baseUrl()}/webhooks/email`, { method: 'POST', headers: { 'content-type': 'image/png' }, body: 'x' })).status).toBe(415);
    expect((await fetch(`${h.baseUrl()}/webhooks/email`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '   ' })).status).toBe(400);
  });

  it('answers unknown routes and wrong methods', async () => {
    expect((await fetch(`${h.baseUrl()}/nope`)).status).toBe(404);
    expect((await fetch(`${h.baseUrl()}/webhooks/form`)).status).toBe(405);
    const logged = h.logs.filter((line) => line.includes('"msg":"http.request"'));
    expect(logged.length).toBeGreaterThanOrEqual(2);
    expect(JSON.parse(logged.at(-1) ?? '{}')).toMatchObject({ status: 405, route: 'GET /webhooks/form' });
  });

  it('reports degraded health when the database is gone', async () => {
    h.runtime.db.close();
    const response = await fetch(`${h.baseUrl()}/health`);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ status: 'degraded', database: 'unavailable', deadLettersPending: null });
    // stop() closes the database again, so give it a fresh handle to close.
    h.runtime.db.open();
  });
});
