import { describe, expect, it } from 'vitest';
import {
  companyDomainFor,
  companyNameFromDomain,
  DEFAULT_FREE_MAIL_DOMAINS,
  formatPhone,
  hostFromWebsite,
  isValidEmail,
  normalizeEmail,
  normalizePhone,
  splitName,
  truncate,
} from '../../src/domain/normalize.ts';

const freeMail = new Set(DEFAULT_FREE_MAIL_DOMAINS);

describe('email normalisation', () => {
  it('lower cases and strips mailto and angle brackets', () => {
    expect(normalizeEmail('  <Thandi.Mokoena@Kestrel-Freight.example.com> ')).toBe('thandi.mokoena@kestrel-freight.example.com');
    expect(normalizeEmail('mailto:sam@example.com')).toBe('sam@example.com');
  });

  it('rejects things that are not addresses', () => {
    for (const bad of ['asdf@asdf', 'lerato[at]example.com', 'no-at-sign.example.com', 'a..b@example.com', '.a@example.com', '', null, undefined]) {
      expect(normalizeEmail(bad)).toBeNull();
    }
    expect(isValidEmail('x'.repeat(65) + '@example.com')).toBe(false);
  });
});

describe('company domain for dedupe', () => {
  it('prefers the website host and strips www', () => {
    expect(hostFromWebsite('https://www.Kestrel-Freight.example.com/contact')).toBe('kestrel-freight.example.com');
    expect(hostFromWebsite('kestrel-freight.example.com')).toBe('kestrel-freight.example.com');
    expect(hostFromWebsite('not a url')).toBeNull();
    expect(hostFromWebsite('localhost')).toBeNull();
    expect(companyDomainFor('someone@other.example.com', 'www.kestrel-freight.example.com', freeMail)).toBe('kestrel-freight.example.com');
  });

  it('falls back to the email domain but never a personal mailbox domain', () => {
    expect(companyDomainFor('sipho@kestrel-freight.example.com', undefined, freeMail)).toBe('kestrel-freight.example.com');
    expect(companyDomainFor('someone@gmail.com', undefined, freeMail)).toBeNull();
    expect(companyDomainFor('someone@example.com', 'https://gmail.com', freeMail)).toBeNull();
    expect(companyDomainFor(null, undefined, freeMail)).toBeNull();
  });
});

describe('phone normalisation', () => {
  it('turns South African formats into E.164', () => {
    expect(normalizePhone('+27 00 000 0001')).toBe('+27000000001');
    expect(normalizePhone('000 000 0007')).toBe('+27000000007');
    expect(normalizePhone('27000000009')).toBe('+27000000009');
    expect(formatPhone('+27000000001')).toBe('+27 00 000 0001');
  });

  it('keeps other international numbers and rejects junk', () => {
    expect(normalizePhone('+44 20 0000 0000')).toBe('+442000000000');
    expect(formatPhone('+442000000000')).toBe('+442000000000');
    expect(normalizePhone('call me')).toBeNull();
    expect(normalizePhone('12345')).toBeNull();
    expect(normalizePhone(undefined)).toBeNull();
  });
});

describe('names and text', () => {
  it('splits a full name', () => {
    expect(splitName('Pieter van Wyk')).toEqual({ firstname: 'Pieter', lastname: 'van Wyk' });
    expect(splitName('Sam')).toEqual({ firstname: 'Sam', lastname: null });
  });

  it('guesses a company name from a domain', () => {
    expect(companyNameFromDomain('kestrel-freight.example.com')).toBe('Kestrel Freight');
  });

  it('truncates on a word boundary', () => {
    expect(truncate('short', 10)).toBe('short');
    expect(truncate('Managed IT for 45 staff across two depots', 25)).toBe('Managed IT for 45...');
    expect(truncate('abcdefghijklmnopqrstuvwxyz', 10)).toBe('abcdefg...');
  });
});
