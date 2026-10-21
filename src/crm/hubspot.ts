import { AssociationTypes, Client } from '@hubspot/api-client';
import * as companiesApi from '@hubspot/api-client/lib/codegen/crm/companies/index.js';
import * as contactsApi from '@hubspot/api-client/lib/codegen/crm/contacts/index.js';
import * as dealsApi from '@hubspot/api-client/lib/codegen/crm/deals/index.js';
import * as notesApi from '@hubspot/api-client/lib/codegen/crm/objects/notes/index.js';
import { OperationFailedError } from '../reliability/errors.ts';
import type { RetryRunner } from '../reliability/retry.ts';

export interface CrmRecord {
  id: string;
  properties: Record<string, string | null>;
}

export type CrmProperties = Record<string, string>;

export interface CrmGateway {
  findContactByEmail: (email: string) => Promise<CrmRecord | null>;
  createContact: (properties: CrmProperties) => Promise<CrmRecord>;
  updateContact: (contactId: string, properties: CrmProperties) => Promise<void>;
  findCompanyByDomain: (domain: string) => Promise<CrmRecord | null>;
  createCompany: (properties: CrmProperties) => Promise<CrmRecord>;
  associateContactToCompany: (contactId: string, companyId: string) => Promise<void>;
  /** Open deals associated with a contact or company, created on or after `createdAfter`. */
  findOpenDeals: (objectType: 'contacts' | 'companies', objectId: string, createdAfter: Date) => Promise<CrmRecord[]>;
  createDeal: (input: { properties: CrmProperties; contactId: string | null; companyId: string | null }) => Promise<CrmRecord>;
  associateDealToContact: (dealId: string, contactId: string) => Promise<void>;
  updateDeal: (dealId: string, properties: CrmProperties) => Promise<void>;
  createNote: (input: { body: string; timestamp: Date; contactId: string | null; companyId: string | null; dealId: string | null }) => Promise<CrmRecord>;
  findOwnerIdByEmail: (email: string) => Promise<string | null>;
}

export const CONTACT_PROPERTIES = ['email', 'firstname', 'lastname', 'phone', 'company'];
const COMPANY_PROPERTIES = ['name', 'domain'];
const DEAL_PROPERTIES = ['dealname', 'dealstage', 'pipeline', 'createdate', 'hs_is_closed'];

const toRecord = (object: { id: string; properties: Record<string, string | null> }): CrmRecord => ({
  id: object.id,
  properties: { ...object.properties },
});

/**
 * HubSpot answers 409 "Contact already exists. Existing ID: 123" when a
 * contact exists but the search index has not caught up yet. That ID is the
 * contact we wanted, so creation becomes a lookup instead of a failure.
 */
export const conflictExistingId = (error: unknown): string | null => {
  const cause = error instanceof OperationFailedError ? error.cause : error;
  if (error instanceof OperationFailedError && error.info.status !== 409) {
    return null;
  }
  const haystack = cause instanceof Error ? cause.message : JSON.stringify(cause);
  return /Existing ID:\s*(\d+)/i.exec(haystack)?.[1] ?? null;
};

export const createHubSpotClient = (accessToken: string, minTimeMs: number): Client =>
  new Client({
    accessToken,
    // Our retry runner owns retries, so the SDK's own retry decorator stays off.
    numberOfApiCallRetries: 0,
    ...(minTimeMs > 0 ? { limiterOptions: { minTime: minTimeMs, maxConcurrent: 3, id: 'lead-to-deal-copilot' } } : {}),
  });

const dealAssociation = (toId: string, typeId: number): dealsApi.PublicAssociationsForObject => ({
  to: { id: toId },
  types: [{ associationCategory: dealsApi.AssociationSpecAssociationCategoryEnum.HubspotDefined, associationTypeId: typeId }],
});

const noteAssociation = (toId: string, typeId: number): notesApi.PublicAssociationsForObject => ({
  to: { id: toId },
  types: [{ associationCategory: notesApi.AssociationSpecAssociationCategoryEnum.HubspotDefined, associationTypeId: typeId }],
});

/** Every call goes through the shared retry runner: backoff with jitter on 429 and 5xx. */
export const createHubSpotGateway = (client: Client, retry: RetryRunner): CrmGateway => ({
  findContactByEmail: async (email) => {
    const response = await retry.run('hubspot.contacts.search', async () =>
      client.crm.contacts.searchApi.doSearch({
        filterGroups: [{ filters: [{ propertyName: 'email', operator: contactsApi.FilterOperatorEnum.Eq, value: email }] }],
        properties: CONTACT_PROPERTIES,
        limit: 1,
      }),
    );
    const first = response.results[0];
    return first ? toRecord(first) : null;
  },

  createContact: async (properties) => {
    try {
      const created = await retry.run('hubspot.contacts.create', async () => client.crm.contacts.basicApi.create({ properties, associations: [] }));
      return toRecord(created);
    } catch (error) {
      const existingId = conflictExistingId(error);
      if (existingId) {
        return { id: existingId, properties: {} };
      }
      throw error;
    }
  },

  updateContact: async (contactId, properties) => {
    await retry.run('hubspot.contacts.update', async () => client.crm.contacts.basicApi.update(contactId, { properties }));
  },

  findCompanyByDomain: async (domain) => {
    const response = await retry.run('hubspot.companies.search', async () =>
      client.crm.companies.searchApi.doSearch({
        filterGroups: [{ filters: [{ propertyName: 'domain', operator: companiesApi.FilterOperatorEnum.Eq, value: domain }] }],
        properties: COMPANY_PROPERTIES,
        limit: 1,
      }),
    );
    const first = response.results[0];
    return first ? toRecord(first) : null;
  },

  createCompany: async (properties) => {
    const created = await retry.run('hubspot.companies.create', async () => client.crm.companies.basicApi.create({ properties, associations: [] }));
    return toRecord(created);
  },

  associateContactToCompany: async (contactId, companyId) => {
    await retry.run('hubspot.associations.contact_company', async () =>
      client.crm.associations.v4.basicApi.createDefault('contacts', contactId, 'companies', companyId),
    );
  },

  findOpenDeals: async (objectType, objectId, createdAfter) => {
    const page = await retry.run('hubspot.associations.list', async () =>
      client.crm.associations.v4.basicApi.getPage(objectType, objectId, 'deals', undefined, 100),
    );
    // Typed as string, but HubSpot sends the id as a JSON number.
    const ids = [...new Set(page.results.map((result) => String(result.toObjectId as string | number)))];
    if (ids.length === 0) {
      return [];
    }
    const batch = await retry.run('hubspot.deals.read', async () =>
      client.crm.deals.batchApi.read({ inputs: ids.map((id) => ({ id })), properties: DEAL_PROPERTIES, propertiesWithHistory: [] }),
    );
    return batch.results
      .map(toRecord)
      .filter((deal) => deal.properties.hs_is_closed !== 'true')
      .filter((deal) => {
        const created = Date.parse(deal.properties.createdate ?? '');
        return Number.isNaN(created) || created >= createdAfter.getTime();
      })
      .sort((a, b) => Date.parse(b.properties.createdate ?? '') - Date.parse(a.properties.createdate ?? ''));
  },

  createDeal: async ({ properties, contactId, companyId }) => {
    const associations = [
      ...(contactId ? [dealAssociation(contactId, AssociationTypes.dealToContact)] : []),
      ...(companyId ? [dealAssociation(companyId, AssociationTypes.primaryDealToCompany)] : []),
    ];
    const created = await retry.run('hubspot.deals.create', async () => client.crm.deals.basicApi.create({ properties, associations }));
    return toRecord(created);
  },

  associateDealToContact: async (dealId, contactId) => {
    await retry.run('hubspot.associations.deal_contact', async () =>
      client.crm.associations.v4.basicApi.createDefault('deals', dealId, 'contacts', contactId),
    );
  },

  updateDeal: async (dealId, properties) => {
    await retry.run('hubspot.deals.update', async () => client.crm.deals.basicApi.update(dealId, { properties }));
  },

  createNote: async ({ body, timestamp, contactId, companyId, dealId }) => {
    const associations = [
      ...(contactId ? [noteAssociation(contactId, AssociationTypes.noteToContact)] : []),
      ...(companyId ? [noteAssociation(companyId, AssociationTypes.noteToCompany)] : []),
      ...(dealId ? [noteAssociation(dealId, AssociationTypes.noteToDeal)] : []),
    ];
    const created = await retry.run('hubspot.notes.create', async () =>
      client.crm.objects.notes.basicApi.create({
        properties: { hs_note_body: body, hs_timestamp: timestamp.toISOString() },
        associations,
      }),
    );
    return toRecord(created);
  },

  findOwnerIdByEmail: async (email) => {
    const page = await retry.run('hubspot.owners.lookup', async () => client.crm.owners.ownersApi.getPage(email, undefined, 1));
    return page.results[0]?.id ?? null;
  },
});

export const hubSpotDealUrl = (appUrl: string, portalId: string | null, dealId: string): string | null =>
  portalId ? `${appUrl}/contacts/${portalId}/record/0-3/${dealId}` : null;
