/**
 * Personal mailbox domains never become HubSpot companies. The bare
 * example.com domain stands in for a personal mailbox in the synthetic data.
 */
export const DEFAULT_FREE_MAIL_DOMAINS: readonly string[] = [
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'yahoo.com',
  'icloud.com',
  'me.com',
  'aol.com',
  'gmx.com',
  'proton.me',
  'protonmail.com',
  'mweb.co.za',
  'telkomsa.net',
  'webmail.co.za',
  'vodamail.co.za',
  'example.com',
];

const EMAIL_PATTERN = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,}$/;

export const isValidEmail = (value: string): boolean => {
  const email = value.trim().toLowerCase();
  if (email.length > 254 || email.includes('..')) {
    return false;
  }
  const local = email.split('@')[0] ?? '';
  return local.length > 0 && local.length <= 64 && !local.startsWith('.') && !local.endsWith('.') && EMAIL_PATTERN.test(email);
};

/** Lower case, strip mailto: and angle brackets. Returns null for anything that is not a valid address. */
export const normalizeEmail = (raw: string | null | undefined): string | null => {
  if (!raw) {
    return null;
  }
  const cleaned = raw.trim().replace(/^mailto:/i, '').replace(/^<|>$/g, '').trim().toLowerCase();
  return isValidEmail(cleaned) ? cleaned : null;
};

export const emailDomain = (email: string): string => email.slice(email.lastIndexOf('@') + 1).toLowerCase();

export const hostFromWebsite = (website: string | null | undefined): string | null => {
  if (!website) {
    return null;
  }
  const candidate = /^https?:\/\//i.test(website.trim()) ? website.trim() : `https://${website.trim()}`;
  try {
    const host = new URL(candidate).hostname.toLowerCase().replace(/^www\./, '');
    return host.includes('.') ? host : null;
  } catch {
    return null;
  }
};

/**
 * The company domain used for dedupe: the website host if the form gave one,
 * otherwise the email domain, unless it is a personal mailbox domain.
 */
export const companyDomainFor = (
  email: string | null,
  website: string | null | undefined,
  freeMailDomains: ReadonlySet<string>,
): string | null => {
  const fromWebsite = hostFromWebsite(website);
  if (fromWebsite && !freeMailDomains.has(fromWebsite)) {
    return fromWebsite;
  }
  if (!email) {
    return null;
  }
  const domain = emailDomain(email);
  return freeMailDomains.has(domain) ? null : domain;
};

/**
 * South African numbers to E.164 (+27...). Other international numbers keep
 * their digits. Returns null when it does not look like a phone number.
 */
export const normalizePhone = (raw: string | null | undefined): string | null => {
  if (!raw) {
    return null;
  }
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, '');
  if (digits.startsWith('27') && digits.length === 11) {
    return `+${digits}`;
  }
  if (digits.startsWith('0') && digits.length === 10) {
    return `+27${digits.slice(1)}`;
  }
  if (trimmed.startsWith('+') && digits.length >= 8 && digits.length <= 15) {
    return `+${digits}`;
  }
  return null;
};

/** +27000000001 to "+27 00 000 0001" for display. */
export const formatPhone = (phone: string): string => {
  const match = /^\+27(\d{2})(\d{3})(\d{4})$/.exec(phone);
  return match ? `+27 ${match[1] ?? ''} ${match[2] ?? ''} ${match[3] ?? ''}` : phone;
};

export const splitName = (fullName: string): { firstname: string; lastname: string | null } => {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) {
    return { firstname: parts[0] ?? '', lastname: null };
  }
  return { firstname: parts[0] ?? '', lastname: parts.slice(1).join(' ') };
};

/** karoo-freight.example.com to "Karoo Freight". Used only as a low confidence fallback. */
export const companyNameFromDomain = (domain: string): string => {
  const label = domain.split('.')[0] ?? domain;
  return label
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
};

/** Shortens to `max` characters, cutting at a word boundary when one is close. */
export const truncate = (value: string, max: number): string => {
  if (value.length <= max) {
    return value;
  }
  const cut = value.slice(0, Math.max(0, max - 3));
  const lastSpace = cut.lastIndexOf(' ');
  const base = lastSpace >= max * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${base.trimEnd().replace(/[\s,;:.-]+$/, '')}...`;
};

export const collapseWhitespace = (value: string): string => value.replace(/\s+/g, ' ').trim();
