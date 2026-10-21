import type { DedupeMatch, FallbackReason } from '../src/domain/types.ts';
import type { BudgetBand, Intent, LeadExtraction, Urgency } from '../src/extraction/schema.ts';
import type { AnthropicBehavior } from '../src/mocks/anthropic-mock.ts';
import type { HubSpotMock } from '../src/mocks/hubspot-mock.ts';
import type { MockSlackUser } from '../src/mocks/slack-mock.ts';

/*
 * 25 synthetic inbound messages for Northwind Managed IT, a fictional IT
 * services company in Cape Town. Every person, company, email address and
 * phone number here is invented: email domains are subdomains of
 * example.com and phone numbers use the unassigned +27 00 range.
 *
 * `ai` is the canned answer the Claude mock gives for that message. The
 * mock does not generate anything; these answers exist so the real
 * extraction, validation, routing and fallback code can be exercised.
 */

export type DemoInbound =
  | { kind: 'form'; payload: Record<string, string> }
  | { kind: 'email'; file: string }
  | { kind: 'slack'; channel: string; channelName: string; ts: string; author: string; sharedBy: string; text: string };

export type ExpectedOutcome = 'drafted' | 'merged' | 'needs_review' | 'spam' | 'support' | 'duplicate' | 'dead_lettered';

export interface DemoScenario {
  id: string;
  label: string;
  inbound: DemoInbound;
  /** A phrase unique to this message, used by the Claude mock to pick the canned answer. */
  fingerprint: string | null;
  ai: AnthropicBehavior | null;
  /** HubSpot answers this many requests with 429 before this lead is processed. */
  hubspotStormBefore?: number;
  expect: {
    outcome: ExpectedOutcome;
    fallback?: FallbackReason;
    priority?: boolean;
    dedupe?: DedupeMatch;
    /** Expected final status after the dead letter replay. */
    afterReplay?: 'drafted';
  };
}

type Field = [string | null, number];

const extraction = (x: {
  name: Field;
  company: Field;
  email: Field;
  phone: Field;
  need: Field;
  budget: [BudgetBand, number];
  urgency: [Urgency, number];
  intent: [Intent, number];
  summary: string;
}): AnthropicBehavior => ({
  kind: 'extraction',
  extraction: {
    name: { value: x.name[0], confidence: x.name[1] },
    company: { value: x.company[0], confidence: x.company[1] },
    email: { value: x.email[0], confidence: x.email[1] },
    phone: { value: x.phone[0], confidence: x.phone[1] },
    need: { value: x.need[0], confidence: x.need[1] },
    budgetBand: { value: x.budget[0], confidence: x.budget[1] },
    urgency: { value: x.urgency[0], confidence: x.urgency[1] },
    intent: { value: x.intent[0], confidence: x.intent[1] },
    summary: x.summary,
  } satisfies LeadExtraction,
});

const NONE: Field = [null, 0];

export const SALES_TEAM: MockSlackUser[] = [
  { id: 'U0AMAHLE', name: 'Amahle Ndlovu (sales lead)', email: 'amahle.ndlovu@northwind-it.example.com' },
  { id: 'U0DANIEL', name: 'Daniel Fourie (account executive)', email: 'daniel.fourie@northwind-it.example.com' },
];

export const TEAM_ID = 'T0NORTHWIND';

/** Records that already exist in the CRM before the demo starts. */
export const seedCrm = (hubspot: HubSpotMock): void => {
  hubspot.addOwner({ id: '7001', email: 'amahle.ndlovu@northwind-it.example.com', firstName: 'Amahle', lastName: 'Ndlovu' });
  hubspot.addOwner({ id: '7002', email: 'daniel.fourie@northwind-it.example.com', firstName: 'Daniel', lastName: 'Fourie' });
  const ruth = hubspot.seedContact({ email: 'ruth.jacobs@seapoint-physio.example.com', firstname: 'Ruth', lastname: 'Jacobs', company: 'Sea Point Physio' });
  const physio = hubspot.seedCompany({ name: 'Sea Point Physio', domain: 'seapoint-physio.example.com' });
  hubspot.seedDeal(
    { dealname: 'Sea Point Physio: laptop refresh', dealstage: 'closedwon', pipeline: 'default', createdate: '2025-03-14T09:00:00.000Z' },
    { contactId: ruth.id, companyId: physio.id },
  );
};

const KESTREL_FORM: Record<string, string> = {
  submissionId: 'wf_10001',
  name: 'Thandi Mokoena',
  email: 'thandi.mokoena@kestrel-freight.example.com',
  company: 'Kestrel Freight',
  phone: '+27 00 000 0001',
  website: 'https://kestrel-freight.example.com',
  subject: 'Managed IT partner',
  message:
    'We run 45 staff across two depots in Epping and Montague Gardens. Our IT person leaves at the end of November and we need a managed IT partner for the helpdesk, laptops and backups. Budget is around R40 000 per month. Can we meet in the next two weeks?',
  page: '/contact',
};

const WINELANDS_SLACK: DemoInbound = {
  kind: 'slack',
  channel: 'C0SALESLEADS',
  channelName: 'sales-leads',
  ts: '1760947200.000100',
  author: 'U0DANIEL',
  sharedBy: 'U0DANIEL',
  text: 'Lead from the Stellenbosch agri expo: Johan Botha, IT manager at Winelands Agri Co-op (johan.botha@winelands-agri.example.com, +27 00 000 0020). 120 users over 3 sites, wants managed IT plus backups, budget around R60k a month. Wants a proposal by Friday.',
};

export const SCENARIOS: DemoScenario[] = [
  {
    id: 'F01',
    label: 'Kestrel Freight, clean form lead',
    inbound: { kind: 'form', payload: KESTREL_FORM },
    fingerprint: 'two depots in Epping and Montague Gardens',
    ai: extraction({
      name: ['Thandi Mokoena', 0.98],
      company: ['Kestrel Freight', 0.97],
      email: ['thandi.mokoena@kestrel-freight.example.com', 0.99],
      phone: ['+27 00 000 0001', 0.95],
      need: ['Managed IT for 45 staff across two depots: helpdesk, laptops and backups.', 0.9],
      budget: ['250k_to_1m', 0.85],
      urgency: ['medium', 0.75],
      intent: ['sales_lead', 0.97],
      summary: 'Kestrel Freight (45 staff, 2 depots) needs a managed IT partner by end November, about R40k a month.',
    }),
    expect: { outcome: 'drafted', dedupe: 'none' },
  },
  {
    id: 'F02',
    label: 'Same form submission delivered again',
    inbound: { kind: 'form', payload: KESTREL_FORM },
    fingerprint: null,
    ai: null,
    expect: { outcome: 'duplicate' },
  },
  {
    id: 'E01',
    label: 'Noordhoek Brewing, email lead',
    inbound: { kind: 'email', file: 'e01-noordhoek-brewing.eml' },
    fingerprint: 'opening a second taproom',
    ai: extraction({
      name: ['Pieter van Wyk', 0.97],
      company: ['Noordhoek Brewing', 0.95],
      email: ['pieter@noordhoek-brewing.example.com', 0.99],
      phone: ['+27 00 000 0002', 0.95],
      need: ['Network, Wi-Fi, a separate card machine network and cameras for a new taproom.', 0.9],
      budget: ['50k_to_250k', 0.85],
      urgency: ['high', 0.9],
      intent: ['sales_lead', 0.96],
      summary: 'Noordhoek Brewing opens a second taproom in two weeks and needs network, Wi-Fi and cameras, about R90k.',
    }),
    expect: { outcome: 'drafted', dedupe: 'none' },
  },
  {
    id: 'F03',
    label: 'Silvertree Dental Group, form lead',
    inbound: {
      kind: 'form',
      payload: {
        submissionId: 'wf_10003',
        name: 'Dr Anika Pillay',
        email: 'anika.pillay@silvertree-dental.example.com',
        company: 'Silvertree Dental Group',
        phone: '+27 00 000 0003',
        message:
          'We have three dental practices and 28 users on old shared mailboxes. We want to move everyone to Microsoft 365 with proper security before the end of Q1 next year. Our budget for the project is R150 000.',
      },
    },
    fingerprint: 'three dental practices and 28 users',
    ai: extraction({
      name: ['Dr Anika Pillay', 0.97],
      company: ['Silvertree Dental Group', 0.98],
      email: ['anika.pillay@silvertree-dental.example.com', 0.99],
      phone: ['+27 00 000 0003', 0.95],
      need: ['Move 28 users across three practices to Microsoft 365 with proper security.', 0.92],
      budget: ['50k_to_250k', 0.9],
      urgency: ['medium', 0.75],
      intent: ['sales_lead', 0.97],
      summary: 'Silvertree Dental Group wants 28 users moved to Microsoft 365 before the end of Q1, R150k budget.',
    }),
    expect: { outcome: 'drafted', dedupe: 'none' },
  },
  {
    id: 'F04',
    label: 'Atlantic Cold Chain, very high value',
    inbound: {
      kind: 'form',
      payload: {
        submissionId: 'wf_10004',
        name: 'Naledi Khumalo',
        email: 'naledi.khumalo@atlantic-coldchain.example.com',
        company: 'Atlantic Cold Chain',
        phone: '+27 00 000 0004',
        subject: 'Managed security before our insurance renewal',
        message:
          'I am the CIO of Atlantic Cold Chain. We have 600 staff across four cold storage sites. Our cyber insurer wants 24/7 monitoring, endpoint protection and tested backups in place before renewal in three weeks. We have approved R2.4 million per year for managed security. Please send your proposal this week.',
      },
    },
    fingerprint: '600 staff across four cold storage sites',
    ai: extraction({
      name: ['Naledi Khumalo', 0.98],
      company: ['Atlantic Cold Chain', 0.98],
      email: ['naledi.khumalo@atlantic-coldchain.example.com', 0.99],
      phone: ['+27 00 000 0004', 0.95],
      need: ['24/7 security monitoring, endpoint protection and tested backups for 600 staff.', 0.93],
      budget: ['over_1m', 0.95],
      urgency: ['high', 0.95],
      intent: ['sales_lead', 0.98],
      summary: 'Atlantic Cold Chain (600 staff) needs managed security before an insurance renewal in 3 weeks, R2.4m a year approved.',
    }),
    expect: { outcome: 'drafted', priority: true, dedupe: 'none' },
  },
  {
    id: 'F05',
    label: 'Junk test submission',
    inbound: { kind: 'form', payload: { name: 'asdf', email: 'asdf@asdf', message: 'test test 123' } },
    fingerprint: 'test test 123',
    ai: extraction({
      name: ['asdf', 0.3],
      company: NONE,
      email: ['asdf@asdf', 0.4],
      phone: NONE,
      need: NONE,
      budget: ['unknown', 0.9],
      urgency: ['unknown', 0.9],
      intent: ['spam', 0.95],
      summary: 'Test or junk submission with no real request.',
    }),
    expect: { outcome: 'spam' },
  },
  {
    id: 'S01',
    label: 'Winelands Agri Co-op, Slack shortcut',
    inbound: WINELANDS_SLACK,
    fingerprint: 'Stellenbosch agri expo',
    ai: extraction({
      name: ['Johan Botha', 0.95],
      company: ['Winelands Agri Co-op', 0.96],
      email: ['johan.botha@winelands-agri.example.com', 0.97],
      phone: ['+27 00 000 0020', 0.93],
      need: ['Managed IT and backups for 120 users across 3 sites.', 0.9],
      budget: ['250k_to_1m', 0.8],
      urgency: ['high', 0.85],
      intent: ['sales_lead', 0.95],
      summary: 'Winelands Agri Co-op (120 users, 3 sites) wants managed IT and backups, about R60k a month, proposal by Friday.',
    }),
    expect: { outcome: 'drafted', priority: true, dedupe: 'none' },
  },
  {
    id: 'F06',
    label: 'SEO spam',
    inbound: {
      kind: 'form',
      payload: {
        name: 'Digital Rocket SEO',
        email: 'outreach@seo-rocket.example.com',
        message: 'Hi, I noticed your website is not on page 1 of Google. We offer guaranteed backlinks and SEO packages from $199 a month. Reply YES for a free audit.',
      },
    },
    fingerprint: 'guaranteed backlinks and SEO packages',
    ai: extraction({
      name: NONE,
      company: ['Digital Rocket SEO', 0.8],
      email: ['outreach@seo-rocket.example.com', 0.95],
      phone: NONE,
      need: NONE,
      budget: ['unknown', 0.9],
      urgency: ['unknown', 0.9],
      intent: ['spam', 0.98],
      summary: 'Unsolicited SEO and backlink sales pitch.',
    }),
    expect: { outcome: 'spam' },
  },
  {
    id: 'F07',
    label: 'Kestrel colleague, same company',
    inbound: {
      kind: 'form',
      payload: {
        submissionId: 'wf_10007',
        name: 'Sipho Dlamini',
        email: 'sipho.dlamini@kestrel-freight.example.com',
        company: 'Kestrel Freight',
        message:
          'Thandi from our office already contacted you about managed IT. I run finance and would like backup and disaster recovery for our accounting server included in the same proposal.',
      },
    },
    fingerprint: 'Thandi from our office already contacted you',
    ai: extraction({
      name: ['Sipho Dlamini', 0.98],
      company: ['Kestrel Freight', 0.97],
      email: ['sipho.dlamini@kestrel-freight.example.com', 0.99],
      phone: NONE,
      need: ['Add backup and disaster recovery for the accounting server to the existing proposal.', 0.9],
      budget: ['unknown', 0.8],
      urgency: ['unknown', 0.6],
      intent: ['sales_lead', 0.93],
      summary: 'Kestrel Freight finance wants backup and DR for the accounting server added to the same proposal.',
    }),
    expect: { outcome: 'merged', dedupe: 'company_domain' },
  },
  {
    id: 'E02',
    label: 'Silvertree follow-up, same person',
    inbound: { kind: 'email', file: 'e02-silvertree-followup.eml' },
    fingerprint: 'Following up on the form I sent this morning',
    ai: extraction({
      name: ['Dr Anika Pillay', 0.95],
      company: ['Silvertree Dental Group', 0.8],
      email: ['anika.pillay@silvertree-dental.example.com', 0.99],
      phone: NONE,
      need: ['Add a network linking the three practices to the Microsoft 365 quote.', 0.9],
      budget: ['unknown', 0.7],
      urgency: ['unknown', 0.6],
      intent: ['sales_lead', 0.9],
      summary: 'Silvertree Dental follow-up: add a network linking all three practices to the same quote.',
    }),
    expect: { outcome: 'merged', dedupe: 'contact_email' },
  },
  {
    id: 'F08',
    label: 'Bo-Kaap Coffee, Claude times out',
    inbound: {
      kind: 'form',
      payload: {
        submissionId: 'wf_10008',
        name: 'Ayesha Davids',
        email: 'ayesha@bokaap-coffee.example.com',
        company: 'Bo-Kaap Coffee Roasters',
        phone: '+27 00 000 0008',
        message:
          'We roast coffee and run an online shop with 18 staff. We need Microsoft 365, laptops managed properly and better security before our busy December season. We were thinking about R6 500 a month.',
      },
    },
    fingerprint: 'We roast coffee and run an online shop',
    ai: { kind: 'hang' },
    expect: { outcome: 'needs_review', fallback: 'timeout' },
  },
  {
    id: 'E03',
    label: 'Malformed email, broken From and MIME',
    inbound: { kind: 'email', file: 'e03-malformed.eml' },
    fingerprint: 'moving 12 people into a new office in Woodstock',
    // The canned answer "fixes" lerato[at]example.com into an address that is not in the message, as a model might.
    ai: extraction({
      name: ['Lerato Nkosi', 0.95],
      company: NONE,
      email: ['lerato@example.com', 0.6],
      phone: ['000 000 0007', 0.9],
      need: ['Network, Wi-Fi and printer setup for a 12 person office move, then ongoing support.', 0.9],
      budget: ['unknown', 0.8],
      urgency: ['medium', 0.7],
      intent: ['sales_lead', 0.92],
      summary: 'Lerato Nkosi is moving 12 people into a new Woodstock office next month and needs network, Wi-Fi and printers.',
    }),
    expect: { outcome: 'needs_review', fallback: 'ungrounded' },
  },
  {
    id: 'F09',
    label: 'Tablebay Couriers, Claude 529 twice',
    inbound: {
      kind: 'form',
      payload: {
        submissionId: 'wf_10009',
        name: 'Kagiso Molefe',
        email: 'kagiso@tablebay-couriers.example.com',
        company: 'Tablebay Couriers',
        phone: '+27 00 000 0009',
        message:
          'Our 25 drivers use tablets for proof of delivery and the office has 6 PCs. We need someone to manage the devices, fix problems quickly and keep everything patched. What would that cost per month?',
      },
    },
    fingerprint: 'Our 25 drivers use tablets',
    ai: { kind: 'http_error', status: 529, errorType: 'overloaded_error', message: 'Overloaded (mock)' },
    expect: { outcome: 'needs_review', fallback: 'api_error' },
  },
  {
    id: 'E04',
    label: 'Phishing email',
    inbound: { kind: 'email', file: 'e04-phishing.eml' },
    fingerprint: 'Your mailbox has reached 98% of its quota',
    ai: extraction({
      name: NONE,
      company: NONE,
      email: ['security-alert@mailbox-verify.example.com', 0.9],
      phone: NONE,
      need: NONE,
      budget: ['unknown', 0.95],
      urgency: ['unknown', 0.9],
      intent: ['spam', 0.98],
      summary: 'Phishing email asking for a mailbox password.',
    }),
    expect: { outcome: 'spam' },
  },
  {
    id: 'F10',
    label: 'Home laptop repair, Claude unsure',
    inbound: { kind: 'form', payload: { name: 'Sam', phone: '000 000 0010', message: 'hi do you fix home laptops? mine wont switch on since the weekend' } },
    fingerprint: 'do you fix home laptops',
    ai: extraction({
      name: ['Sam', 0.7],
      company: NONE,
      email: NONE,
      phone: ['000 000 0010', 0.85],
      need: ['Repair of a personal laptop that will not switch on.', 0.85],
      budget: ['unknown', 0.9],
      urgency: ['unknown', 0.5],
      intent: ['sales_lead', 0.55],
      summary: 'A consumer asking for a home laptop repair, not a business client.',
    }),
    expect: { outcome: 'needs_review', fallback: 'low_confidence' },
  },
  {
    id: 'F11',
    label: 'Sea Point Physio, already in HubSpot',
    inbound: {
      kind: 'form',
      payload: {
        submissionId: 'wf_10011',
        name: 'Ruth Jacobs',
        email: 'ruth.jacobs@seapoint-physio.example.com',
        company: 'Sea Point Physio',
        phone: '+27 00 000 0011',
        message:
          'You helped us with laptops last year. We are opening a second clinic and need 6 more users on Microsoft 365 and a shared booking computer. Budget about R35 000.',
      },
    },
    fingerprint: 'You helped us with laptops last year',
    ai: extraction({
      name: ['Ruth Jacobs', 0.98],
      company: ['Sea Point Physio', 0.98],
      email: ['ruth.jacobs@seapoint-physio.example.com', 0.99],
      phone: ['+27 00 000 0011', 0.95],
      need: ['Microsoft 365 for 6 more users and a shared booking computer for a second clinic.', 0.92],
      budget: ['under_50k', 0.85],
      urgency: ['unknown', 0.5],
      intent: ['sales_lead', 0.95],
      summary: 'Returning client Sea Point Physio needs 6 more Microsoft 365 users for a second clinic, about R35k.',
    }),
    expect: { outcome: 'drafted', dedupe: 'contact_email' },
  },
  {
    id: 'E05',
    label: 'Prompt injection attempt in spam',
    inbound: { kind: 'email', file: 'e05-prompt-injection.eml' },
    fingerprint: 'crypto payment rails',
    ai: extraction({
      name: NONE,
      company: NONE,
      email: ['deals@crypto-boost.example.com', 0.9],
      phone: NONE,
      need: NONE,
      budget: ['unknown', 0.9],
      urgency: ['unknown', 0.9],
      intent: ['spam', 0.96],
      summary: 'Crypto and backlink marketing pitch that tries to inject instructions.',
    }),
    expect: { outcome: 'spam' },
  },
  {
    id: 'F12',
    label: 'Claremont Accounting, support request',
    inbound: {
      kind: 'form',
      payload: {
        submissionId: 'wf_10012',
        name: 'Megan Adams',
        email: 'megan.adams@claremont-accounting.example.com',
        company: 'Claremont Accounting',
        message: 'Our printer at the Claremont office is offline again and two people cannot log in to the VPN this morning. Our support ticket is NW-4411.',
      },
    },
    fingerprint: 'printer at the Claremont office is offline again',
    ai: extraction({
      name: ['Megan Adams', 0.97],
      company: ['Claremont Accounting', 0.97],
      email: ['megan.adams@claremont-accounting.example.com', 0.99],
      phone: NONE,
      need: ['Printer offline and two users cannot log in to the VPN (ticket NW-4411).', 0.92],
      budget: ['unknown', 0.9],
      urgency: ['high', 0.8],
      intent: ['support', 0.95],
      summary: 'Existing client Claremont Accounting: printer offline and VPN logins failing, ticket NW-4411.',
    }),
    expect: { outcome: 'support' },
  },
  {
    id: 'E06',
    label: 'Observatory Bike Co, invalid AI output',
    inbound: { kind: 'email', file: 'e06-observatory-bikes.eml' },
    fingerprint: 'We are a bike shop and workshop with 9 staff',
    ai: { kind: 'invalid_json', text: '{"name": {"value": "Riaan Smit", "confidence": 0.97}, "company": {"value": "Observatory Bike Co", "confi' },
    expect: { outcome: 'needs_review', fallback: 'invalid_output' },
  },
  {
    id: 'E07',
    label: 'Noordhoek email delivered twice',
    inbound: { kind: 'email', file: 'e01-noordhoek-brewing.eml' },
    fingerprint: null,
    ai: null,
    expect: { outcome: 'duplicate' },
  },
  {
    id: 'S02',
    label: 'Same Slack message captured again',
    inbound: { ...WINELANDS_SLACK, sharedBy: 'U0AMAHLE' },
    fingerprint: null,
    ai: null,
    expect: { outcome: 'duplicate' },
  },
  {
    id: 'F13',
    label: 'Muizenberg Surf, HubSpot 429 storm',
    inbound: {
      kind: 'form',
      payload: {
        submissionId: 'wf_10013',
        name: 'Zanele Mthembu',
        email: 'zanele@muizenberg-surf.example.com',
        company: 'Muizenberg Surf School',
        phone: '+27 00 000 0013',
        message:
          'We are a surf school with 8 staff. We need Microsoft 365, Wi-Fi in the clubhouse and two booking tablets set up and supported. Around R3 000 a month would work for us.',
      },
    },
    fingerprint: 'surf school with 8 staff',
    ai: extraction({
      name: ['Zanele Mthembu', 0.98],
      company: ['Muizenberg Surf School', 0.98],
      email: ['zanele@muizenberg-surf.example.com', 0.99],
      phone: ['+27 00 000 0013', 0.95],
      need: ['Microsoft 365, clubhouse Wi-Fi and two booking tablets, set up and supported.', 0.9],
      budget: ['under_50k', 0.85],
      urgency: ['unknown', 0.5],
      intent: ['sales_lead', 0.95],
      summary: 'Muizenberg Surf School (8 staff) wants Microsoft 365, Wi-Fi and booking tablets, about R3k a month.',
    }),
    hubspotStormBefore: 12,
    expect: { outcome: 'dead_lettered', afterReplay: 'drafted' },
  },
  {
    id: 'F14',
    label: 'Stellenbosch Language Lab, 429s',
    inbound: {
      kind: 'form',
      payload: {
        submissionId: 'wf_10014',
        name: 'Farah Isaacs',
        email: 'farah.isaacs@stellies-lang.example.com',
        company: 'Stellenbosch Language Lab',
        phone: '+27 00 000 0015',
        message: 'Our old file server is dying. We want our 30 users moved to SharePoint and OneDrive, with training for the team. We have R120 000 for the project.',
      },
    },
    fingerprint: 'Our old file server is dying',
    ai: extraction({
      name: ['Farah Isaacs', 0.98],
      company: ['Stellenbosch Language Lab', 0.98],
      email: ['farah.isaacs@stellies-lang.example.com', 0.99],
      phone: ['+27 00 000 0015', 0.95],
      need: ['Move 30 users from a failing file server to SharePoint and OneDrive, with training.', 0.92],
      budget: ['50k_to_250k', 0.9],
      urgency: ['medium', 0.6],
      intent: ['sales_lead', 0.96],
      summary: 'Stellenbosch Language Lab wants 30 users moved off a failing file server to SharePoint, R120k.',
    }),
    expect: { outcome: 'dead_lettered', afterReplay: 'drafted' },
  },
  {
    id: 'E08',
    label: 'Durbanville Vets, end of the storm',
    inbound: { kind: 'email', file: 'e08-durbanville-vets.eml' },
    fingerprint: 'X-ray machines share one flat network',
    ai: extraction({
      name: ['Dr Tumi Sithole', 0.97],
      company: ['Durbanville Animal Hospital', 0.97],
      email: ['tumi.sithole@durbanville-vets.example.com', 0.99],
      phone: ['+27 00 000 0014', 0.95],
      need: ['Network upgrade, offsite backups and monitoring for an animal hospital.', 0.92],
      budget: ['250k_to_1m', 0.9],
      urgency: ['medium', 0.6],
      intent: ['sales_lead', 0.96],
      summary: 'Durbanville Animal Hospital wants a network upgrade, offsite backups and monitoring, R250k this year.',
    }),
    expect: { outcome: 'drafted', dedupe: 'none' },
  },
  {
    id: 'F15',
    label: 'Paarl Print Works, after the storm',
    inbound: {
      kind: 'form',
      payload: {
        submissionId: 'wf_10015',
        name: 'Lindiwe Zulu',
        email: 'lindiwe.zulu@paarl-print.example.com',
        company: 'Paarl Print Works',
        phone: '+27 00 000 0016',
        message: 'We have 22 staff and had a ransomware scare last month. We want managed IT with security awareness training and proper backups. Budget is R18 000 per month.',
      },
    },
    fingerprint: 'ransomware scare last month',
    ai: extraction({
      name: ['Lindiwe Zulu', 0.98],
      company: ['Paarl Print Works', 0.98],
      email: ['lindiwe.zulu@paarl-print.example.com', 0.99],
      phone: ['+27 00 000 0016', 0.95],
      need: ['Managed IT with security awareness training and proper backups for 22 staff.', 0.92],
      budget: ['50k_to_250k', 0.85],
      urgency: ['high', 0.8],
      intent: ['sales_lead', 0.97],
      summary: 'Paarl Print Works (22 staff) had a ransomware scare and wants managed IT, training and backups, R18k a month.',
    }),
    expect: { outcome: 'drafted', dedupe: 'none' },
  },
];

/** Slack button clicks the demo replays through Bolt after the leads are in. */
export interface DemoClick {
  scenarioId: string;
  action: 'approve' | 'assign' | 'notAFit';
  user: string;
  expectOk: boolean;
}

export const CLICKS: DemoClick[] = [
  { scenarioId: 'F01', action: 'approve', user: 'U0AMAHLE', expectOk: true },
  { scenarioId: 'F01', action: 'approve', user: 'U0DANIEL', expectOk: false },
  { scenarioId: 'F04', action: 'approve', user: 'U0AMAHLE', expectOk: true },
  { scenarioId: 'E01', action: 'approve', user: 'U0DANIEL', expectOk: true },
  { scenarioId: 'S01', action: 'approve', user: 'U0DANIEL', expectOk: true },
  { scenarioId: 'F03', action: 'assign', user: 'U0DANIEL', expectOk: true },
  { scenarioId: 'F08', action: 'approve', user: 'U0AMAHLE', expectOk: true },
  { scenarioId: 'F10', action: 'notAFit', user: 'U0DANIEL', expectOk: true },
];
