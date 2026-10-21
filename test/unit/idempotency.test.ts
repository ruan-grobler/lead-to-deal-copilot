import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  emailIdempotencyKey,
  formIdempotencyKey,
  normalizeMessageId,
  slackIdempotencyKey,
} from '../../src/reliability/idempotency.ts';

describe('idempotency keys', () => {
  it('uses the form provider submission id when there is one', () => {
    expect(formIdempotencyKey({ submissionId: ' wf_10001 ', message: 'hi' })).toBe('form:wf_10001');
  });

  it('hashes the payload otherwise, independent of key order', () => {
    const a = formIdempotencyKey({ message: 'hi', email: 'a@example.com' });
    const b = formIdempotencyKey({ email: 'a@example.com', message: 'hi' });
    const c = formIdempotencyKey({ email: 'a@example.com', message: 'hello' });
    expect(a).toMatch(/^form:sha256:[0-9a-f]{32}$/);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('uses the Message-ID for email, normalised', () => {
    expect(normalizeMessageId(' <ABC@Mail.Example.com> ')).toBe('abc@mail.example.com');
    expect(emailIdempotencyKey('<ABC@Mail.Example.com>', 'raw')).toBe('email:abc@mail.example.com');
    expect(normalizeMessageId('<>')).toBeNull();
  });

  it('hashes the raw message when there is no Message-ID', () => {
    const key = emailIdempotencyKey(undefined, 'From: a\n\nbody');
    expect(key).toMatch(/^email:sha256:[0-9a-f]{32}$/);
    expect(emailIdempotencyKey(null, 'From: a\n\nbody')).toBe(key);
  });

  it('identifies a Slack message by workspace, channel and ts', () => {
    expect(slackIdempotencyKey('T1', 'C1', '1760947200.000100')).toBe('slack:T1:C1:1760947200.000100');
  });

  it('serialises JSON canonically', () => {
    expect(canonicalJson({ b: [2, { d: 1, c: null }], a: 'x', skip: undefined })).toBe('{"a":"x","b":[2,{"c":null,"d":1}]}');
  });
});
