import { describe, expect, it } from 'vitest';
import type { InboundLead } from '../../src/domain/types.ts';
import type { AiExtractor, AiOutcome } from '../../src/extraction/claude.ts';
import { createLeadExtractor, lowConfidenceFields } from '../../src/extraction/extract.ts';
import { silentLogger } from '../../src/logger.ts';
import { createMetrics } from '../../src/metrics.ts';
import { decideRoute, isPriority } from '../../src/pipeline/route.ts';
import { extraction } from '../helpers/harness.ts';

const lead = (overrides: Partial<InboundLead> = {}): InboundLead => ({
  source: 'form',
  idempotencyKey: 'form:x',
  receivedAt: '2026-10-20T07:00:00.000Z',
  subject: null,
  text: 'We need managed IT for 20 staff. Call 000 000 0031 or mail test.person@test-company.example.com',
  hints: {},
  meta: {},
  parseWarnings: [],
  ...overrides,
});

const fakeAi = (outcome: AiOutcome): AiExtractor & { calls: number } => {
  const ai = {
    calls: 0,
    extract: async (): Promise<AiOutcome> => {
      ai.calls += 1;
      return Promise.resolve(outcome);
    },
  };
  return ai;
};

const build = (ai: AiExtractor | null): { extract: (input: InboundLead) => ReturnType<ReturnType<typeof createLeadExtractor>['extract']>; metrics: ReturnType<typeof createMetrics> } => {
  const metrics = createMetrics();
  const extractor = createLeadExtractor({ ai, minConfidence: 0.7, logger: silentLogger, metrics });
  return { extract: async (input) => extractor.extract(input), metrics };
};

describe('extraction with fallback', () => {
  it('uses Claude when it answers confidently, and routes to auto draft', async () => {
    const { extract, metrics } = build(fakeAi({ ok: true, extraction: extraction(), latencyMs: 12, model: 'claude-opus-5-5' }));
    const decision = await extract(lead());
    expect(decision.method).toBe('ai');
    expect(decision.fallbackReason).toBeNull();
    expect(decision.aiLatencyMs).toBe(12);
    expect(decideRoute(decision, lead(), 0.7)).toBe('auto_draft');
    expect(metrics.get('ai.calls')).toBe(1);
  });

  it.each(['timeout', 'api_error', 'invalid_output', 'refusal'] as const)('falls back to rules on %s and sends the lead to review', async (reason) => {
    const { extract, metrics } = build(fakeAi({ ok: false, reason, detail: 'boom', latencyMs: 5 }));
    const decision = await extract(lead({ hints: { email: 'test.person@test-company.example.com' } }));
    expect(decision.method).toBe('rules');
    expect(decision.fallbackReason).toBe(reason);
    expect(decision.extraction.email.value).toBe('test.person@test-company.example.com');
    expect(decideRoute(decision, lead(), 0.7)).toBe('human_review');
    expect(metrics.get(`ai.fallback.${reason}`)).toBe(1);
  });

  it('runs on rules alone when no API key is configured', async () => {
    const { extract } = build(null);
    const decision = await extract(lead());
    expect(decision.fallbackReason).toBe('ai_disabled');
    expect(decision.fallbackDetail).toContain('ANTHROPIC_API_KEY');
  });

  it('flags an email the model invented and replaces it with the rules value', async () => {
    const { extract } = build(fakeAi({ ok: true, extraction: extraction({ email: ['invented@test-company.example.com', 0.9] }), latencyMs: 1, model: 'm' }));
    const decision = await extract(lead());
    expect(decision.fallbackReason).toBe('ungrounded');
    expect(decision.extraction.email.value).toBe('test.person@test-company.example.com');
  });

  it('flags a phone number that is not in the message', async () => {
    const { extract } = build(fakeAi({ ok: true, extraction: extraction({ phone: ['+27 00 999 9999', 0.9] }), latencyMs: 1, model: 'm' }));
    const decision = await extract(lead());
    expect(decision.fallbackReason).toBe('ungrounded');
    expect(decision.extraction.phone.value).toBe('+27000000031');
  });

  it('keeps contact details that are in the message, normalised', async () => {
    const { extract } = build(fakeAi({ ok: true, extraction: extraction({ email: ['TEST.PERSON@test-company.example.com', 0.9], phone: ['000 000 0031', 0.9] }), latencyMs: 1, model: 'm' }));
    const decision = await extract(lead());
    expect(decision.fallbackReason).toBeNull();
    expect(decision.extraction.email.value).toBe('test.person@test-company.example.com');
    expect(decision.extraction.phone.value).toBe('+27000000031');
  });

  it('treats a copied but invalid address as no email, not as a hallucination', async () => {
    const junk = extraction({ email: ['asdf@asdf', 0.4], intent: { value: 'spam', confidence: 0.95 } });
    const { extract } = build(fakeAi({ ok: true, extraction: junk, latencyMs: 1, model: 'm' }));
    const input = lead({ text: 'test test 123', meta: { rawEmailField: 'asdf@asdf' }, parseWarnings: ['invalid_email_field'] });
    const decision = await extract(input);
    expect(decision.fallbackReason).toBeNull();
    expect(decision.extraction.email).toEqual({ value: null, confidence: 0 });
    expect(decideRoute(decision, input, 0.7)).toBe('spam');
  });

  it('sends unsure answers to review and fills gaps from the rules', async () => {
    const unsure = extraction({ email: [null, 0], intent: { value: 'sales_lead', confidence: 0.55 } });
    const { extract } = build(fakeAi({ ok: true, extraction: unsure, latencyMs: 1, model: 'm' }));
    const decision = await extract(lead());
    expect(decision.fallbackReason).toBe('low_confidence');
    expect(decision.method).toBe('ai');
    expect(decision.extraction.email.value).toBe('test.person@test-company.example.com');
    expect(decision.lowConfidenceFields).toContain('intent');
  });

  it('applies form fields over the model for who sent it', async () => {
    const { extract } = build(fakeAi({ ok: true, extraction: extraction({ name: [null, 0], company: [null, 0] }), latencyMs: 1, model: 'm' }));
    const decision = await extract(lead({ hints: { name: 'Form Name', company: 'Form Co', email: 'test.person@test-company.example.com', phone: '+27000000031' } }));
    expect(decision.extraction.name).toEqual({ value: 'Form Name', confidence: 0.9 });
    expect(decision.extraction.company).toEqual({ value: 'Form Co', confidence: 0.9 });
    expect(decision.extraction.email.confidence).toBeGreaterThanOrEqual(0.95);
  });
});

describe('routing policy', () => {
  const decision = (overrides: Parameters<typeof extraction>[0], fallbackReason: null | 'timeout' = null): Parameters<typeof decideRoute>[0] => ({
    extraction: extraction(overrides),
    method: 'ai',
    fallbackReason,
    fallbackDetail: null,
    lowConfidenceFields: [],
    aiLatencyMs: 1,
  });

  it('filters confident spam even when the message had parse problems', () => {
    expect(decideRoute(decision({ intent: { value: 'spam', confidence: 0.9 } }), lead({ parseWarnings: ['invalid_from_address'] }), 0.7)).toBe('spam');
  });

  it('reviews unsure spam instead of dropping it', () => {
    expect(decideRoute(decision({ intent: { value: 'spam', confidence: 0.5 } }), lead(), 0.7)).toBe('human_review');
  });

  it('routes support, reviews parse warnings and leads without a usable email', () => {
    expect(decideRoute(decision({ intent: { value: 'support', confidence: 0.9 } }), lead(), 0.7)).toBe('support');
    expect(decideRoute(decision({}), lead({ parseWarnings: ['missing_from'] }), 0.7)).toBe('human_review');
    expect(decideRoute(decision({ email: [null, 0] }), lead(), 0.7)).toBe('human_review');
    expect(decideRoute(decision({}, 'timeout'), lead(), 0.7)).toBe('human_review');
  });

  it('marks high value leads', () => {
    expect(isPriority(extraction({ budgetBand: { value: 'over_1m', confidence: 0.9 } }))).toBe(true);
    expect(isPriority(extraction({ budgetBand: { value: '250k_to_1m', confidence: 0.9 }, urgency: { value: 'high', confidence: 0.9 } }))).toBe(true);
    expect(isPriority(extraction({ budgetBand: { value: '250k_to_1m', confidence: 0.9 }, urgency: { value: 'low', confidence: 0.9 } }))).toBe(false);
    expect(isPriority(extraction({ budgetBand: { value: 'over_1m', confidence: 0.9 }, intent: { value: 'spam', confidence: 0.9 } }))).toBe(false);
  });

  it('lists low confidence fields that have a value', () => {
    const fields = lowConfidenceFields(extraction({ name: ['X', 0.5], phone: [null, 0], urgency: { value: 'unknown', confidence: 0.1 } }), 0.7);
    expect(fields).toEqual(['name']);
  });
});
