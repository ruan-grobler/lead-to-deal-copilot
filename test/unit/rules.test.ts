import { describe, expect, it } from 'vitest';
import type { InboundLead } from '../../src/domain/types.ts';
import { budgetBandFor, detectIntent, detectUrgency, extractWithRules, findAnnualBudgetZar, nameFromSignature } from '../../src/extraction/rules.ts';

const lead = (overrides: Partial<InboundLead>): InboundLead => ({
  source: 'email',
  idempotencyKey: 'email:test',
  receivedAt: '2026-10-20T07:00:00.000Z',
  subject: null,
  text: '',
  hints: {},
  meta: {},
  parseWarnings: [],
  ...overrides,
});

describe('budget parsing', () => {
  it('reads rand amounts in the usual South African formats', () => {
    expect(findAnnualBudgetZar('Budget is R90 000 for the setup')).toBe(90_000);
    expect(findAnnualBudgetZar('We approved R2.4 million per year')).toBe(2_400_000);
    expect(findAnnualBudgetZar('about R150,000')).toBe(150_000);
    expect(findAnnualBudgetZar('R1,2m all in')).toBe(1_200_000);
    expect(findAnnualBudgetZar('ZAR 400 000')).toBe(400_000);
    expect(findAnnualBudgetZar('R250k')).toBe(250_000);
  });

  it('annualises monthly amounts and keeps the largest figure', () => {
    expect(findAnnualBudgetZar('Budget is around R40 000 per month')).toBe(480_000);
    expect(findAnnualBudgetZar('R6 500 a month')).toBe(78_000);
    expect(findAnnualBudgetZar('R3k pm, or R20k once off')).toBe(36_000);
    expect(findAnnualBudgetZar('No budget mentioned, about $500')).toBeNull();
  });

  it('maps amounts to bands', () => {
    expect(budgetBandFor(null)).toBe('unknown');
    expect(budgetBandFor(49_999)).toBe('under_50k');
    expect(budgetBandFor(50_000)).toBe('50k_to_250k');
    expect(budgetBandFor(250_000)).toBe('250k_to_1m');
    expect(budgetBandFor(1_000_000)).toBe('over_1m');
  });
});

describe('urgency, intent and names', () => {
  it('detects urgency from wording', () => {
    expect(detectUrgency('our server is down, please help ASAP')).toBe('high');
    expect(detectUrgency('we open in two weeks')).toBe('high');
    expect(detectUrgency('sometime this quarter')).toBe('medium');
    expect(detectUrgency('just exploring options for next year')).toBe('low');
    expect(detectUrgency('we need laptops')).toBe('unknown');
  });

  it('spots spam, junk and support', () => {
    expect(detectIntent('We offer guaranteed backlinks and SEO').value).toBe('spam');
    expect(detectIntent('test').value).toBe('spam');
    expect(detectIntent('Verify your password within 24 hours').value).toBe('spam');
    expect(detectIntent('Our printer is offline again, ticket NW-1').value).toBe('support');
    expect(detectIntent('We need managed IT for 40 people in Paarl')).toEqual({ value: 'sales_lead', confidence: 0.4 });
  });

  it('finds a name in a sign off', () => {
    expect(nameFromSignature('Hi,\nplease call.\n\nKind regards,\nPieter van Wyk\nOperations')).toBe('Pieter van Wyk');
    expect(nameFromSignature('can someone call me\n- Sam')).toBe('Sam');
    expect(nameFromSignature('no sign off here')).toBeNull();
  });
});

describe('extractWithRules', () => {
  it('trusts structured hints over guesses', () => {
    const result = extractWithRules(
      lead({
        source: 'form',
        text: 'We roast coffee and run an online shop with 18 staff. We were thinking about R6 500 a month.',
        hints: { name: 'Ayesha Davids', email: 'ayesha@bokaap-coffee.example.com', company: 'Bo-Kaap Coffee Roasters', phone: '+27000000008' },
      }),
    );
    expect(result.name).toEqual({ value: 'Ayesha Davids', confidence: 0.9 });
    expect(result.email).toEqual({ value: 'ayesha@bokaap-coffee.example.com', confidence: 0.95 });
    expect(result.company.value).toBe('Bo-Kaap Coffee Roasters');
    expect(result.phone.value).toBe('+27000000008');
    expect(result.budgetBand.value).toBe('50k_to_250k');
    expect(result.intent.value).toBe('sales_lead');
    expect(result.need.value).toBe('We roast coffee and run an online shop with 18 staff.');
    expect(result.summary).toBe('Bo-Kaap Coffee Roasters: We roast coffee and run an online shop with 18 staff.');
  });

  it('falls back to the text when there are no hints', () => {
    const result = extractWithRules(
      lead({
        subject: 'Laptops',
        text: 'Please email me at riaan@obs-bikes.example.com or call 000 000 0012.\n\nRegards,\nRiaan Smit',
      }),
    );
    expect(result.email).toEqual({ value: 'riaan@obs-bikes.example.com', confidence: 0.8 });
    expect(result.phone).toEqual({ value: '+27000000012', confidence: 0.75 });
    expect(result.name).toEqual({ value: 'Riaan Smit', confidence: 0.5 });
    expect(result.company).toEqual({ value: 'Obs Bikes', confidence: 0.4 });
    expect(result.need.value).toBe('Laptops');
  });

  it('returns null with zero confidence when nothing is found', () => {
    const result = extractWithRules(lead({ text: 'hello there friends' }));
    expect(result.email).toEqual({ value: null, confidence: 0 });
    expect(result.company).toEqual({ value: null, confidence: 0 });
    expect(result.budgetBand).toEqual({ value: 'unknown', confidence: 0.3 });
    expect(result.summary).toBe('Unknown sender: hello there friends');
  });
});
