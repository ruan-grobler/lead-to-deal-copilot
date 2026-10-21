import { setupServer } from 'msw/node';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { conflictExistingId, createHubSpotClient, createHubSpotGateway, hubSpotDealUrl } from '../../src/crm/hubspot.ts';
import { createHubSpotMock } from '../../src/mocks/hubspot-mock.ts';
import { OperationFailedError } from '../../src/reliability/errors.ts';
import { createRetryRunner } from '../../src/reliability/retry.ts';

const hubspot = createHubSpotMock();
const server = setupServer(...hubspot.handlers);

const retry = createRetryRunner({ maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2, maxRetryAfterMs: 50, retryOnTimeout: true });
const crm = createHubSpotGateway(createHubSpotClient('test-hubspot-token', 0), retry);

describe('HubSpot gateway against the mocked CRM API', () => {
  beforeAll(() => {
    server.listen({ onUnhandledRequest: 'error' });
  });
  afterAll(() => {
    server.close();
  });
  beforeEach(() => {
    hubspot.reset();
  });

  it('finds contacts by email and companies by domain through the search API', async () => {
    hubspot.seedContact({ email: 'ruth@seapoint-physio.example.com', firstname: 'Ruth' });
    hubspot.seedCompany({ name: 'Sea Point Physio', domain: 'seapoint-physio.example.com' });
    expect((await crm.findContactByEmail('RUTH@seapoint-physio.example.com'))?.properties.firstname).toBe('Ruth');
    expect(await crm.findContactByEmail('nobody@example.com')).toBeNull();
    expect((await crm.findCompanyByDomain('seapoint-physio.example.com'))?.properties.name).toBe('Sea Point Physio');
    expect(await crm.findCompanyByDomain('other.example.com')).toBeNull();
    expect(hubspot.requests.map((request) => request.path)).toContain('/crm/v3/objects/contacts/search');
  });

  it('creates, updates and associates records, and reads open deals back', async () => {
    const contact = await crm.createContact({ email: 'new@kestrel.example.com', firstname: 'New' });
    await crm.updateContact(contact.id, { phone: '+27000000001' });
    expect(hubspot.objects.contacts.get(contact.id)?.properties.phone).toBe('+27000000001');
    const company = await crm.createCompany({ name: 'Kestrel', domain: 'kestrel.example.com' });
    await crm.associateContactToCompany(contact.id, company.id);
    expect(hubspot.associationsOf('contacts', contact.id, 'companies')).toEqual([company.id]);

    const deal = await crm.createDeal({ properties: { dealname: 'Kestrel: managed IT', dealstage: 'appointmentscheduled', pipeline: 'default' }, contactId: contact.id, companyId: company.id });
    expect(hubspot.associationsOf('deals', deal.id, 'contacts')).toEqual([contact.id]);
    expect(hubspot.associationsOf('companies', company.id, 'deals')).toEqual([deal.id]);

    const open = await crm.findOpenDeals('contacts', contact.id, new Date(0));
    expect(open.map((item) => item.id)).toEqual([deal.id]);
    await crm.updateDeal(deal.id, { dealstage: 'closedlost' });
    expect(await crm.findOpenDeals('contacts', contact.id, new Date(0))).toEqual([]);
    expect(await crm.findOpenDeals('companies', '999', new Date(0))).toEqual([]);

    const second = await crm.createContact({ email: 'second@kestrel.example.com' });
    await crm.associateDealToContact(deal.id, second.id);
    expect(hubspot.associationsOf('deals', deal.id, 'contacts')).toEqual([contact.id, second.id]);

    const note = await crm.createNote({ body: '<p>hello</p>', timestamp: new Date('2026-10-20T07:00:00Z'), contactId: contact.id, companyId: company.id, dealId: deal.id });
    expect(hubspot.objects.notes.get(note.id)?.properties.hs_timestamp).toBe('2026-10-20T07:00:00.000Z');
    expect(hubspot.associationsOf('notes', note.id, 'deals')).toEqual([deal.id]);
  });

  it('ignores open deals created before the merge window', async () => {
    const contact = hubspot.seedContact({ email: 'old@example.com' });
    hubspot.seedDeal({ dealname: 'Old', dealstage: 'appointmentscheduled', createdate: '2025-01-01T00:00:00.000Z' }, { contactId: contact.id });
    expect(await crm.findOpenDeals('contacts', contact.id, new Date('2026-01-01T00:00:00Z'))).toEqual([]);
  });

  it('turns a 409 duplicate contact into the existing id', async () => {
    const existing = hubspot.seedContact({ email: 'dup@example.com' });
    const created = await crm.createContact({ email: 'dup@example.com' });
    expect(created.id).toBe(existing.id);
    expect(hubspot.served(409)).toBe(1);
    expect(conflictExistingId(new Error('nothing here'))).toBeNull();
  });

  it('retries 429 and 5xx with backoff, then succeeds', async () => {
    hubspot.startRateLimitStorm(1);
    hubspot.failNext(1, 502);
    expect(await crm.findContactByEmail('x@example.com')).toBeNull();
    expect(hubspot.served(429)).toBe(1);
    expect(hubspot.served(502)).toBe(1);
    expect(hubspot.served(200)).toBe(1);
  });

  it('gives up after the retry budget and says where it failed', async () => {
    hubspot.startRateLimitStorm(5);
    const error = await crm.findCompanyByDomain('x.example.com').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OperationFailedError);
    expect(error).toMatchObject({ label: 'hubspot.companies.search', attempts: 3, info: { status: 429 } });
  });

  it('does not retry a 404', async () => {
    await expect(crm.updateDeal('404404', { dealstage: 'x' })).rejects.toMatchObject({ attempts: 1, info: { status: 404 } });
  });

  it('rejects calls without a token, like HubSpot does', async () => {
    const anonymous = createHubSpotGateway(createHubSpotClient('', 0), retry);
    await expect(anonymous.findContactByEmail('x@example.com')).rejects.toMatchObject({ info: { status: 401 } });
  });

  it('looks up owners by email', async () => {
    hubspot.addOwner({ id: '7001', email: 'amahle@northwind-it.example.com', firstName: 'Amahle', lastName: 'N' });
    expect(await crm.findOwnerIdByEmail('amahle@northwind-it.example.com')).toBe('7001');
    expect(await crm.findOwnerIdByEmail('nobody@northwind-it.example.com')).toBeNull();
  });

  it('builds deal links only when the portal id is known', () => {
    expect(hubSpotDealUrl('https://app.hubspot.com', '123', '9')).toBe('https://app.hubspot.com/contacts/123/record/0-3/9');
    expect(hubSpotDealUrl('https://app.hubspot.com', null, '9')).toBeNull();
  });
});
