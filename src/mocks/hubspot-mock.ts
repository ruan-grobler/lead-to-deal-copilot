import { randomUUID } from 'node:crypto';
import { http, HttpResponse, type HttpHandler } from 'msw';

/**
 * An in-memory stand-in for the HubSpot CRM API, served through msw so the
 * real @hubspot/api-client code runs unchanged. It covers the endpoints this
 * project calls, with HubSpot's response shapes, the 409 duplicate contact
 * rule and injectable 429 storms.
 */

const BASE = 'https://api.hubapi.com';

export interface MockCrmObject {
  id: string;
  properties: Record<string, string | null>;
  createdAt: string;
  updatedAt: string;
}

export type MockObjectType = 'contacts' | 'companies' | 'deals' | 'notes';

interface Association {
  aType: MockObjectType;
  aId: string;
  bType: MockObjectType;
  bId: string;
  typeId: number;
}

export interface MockOwner {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
}

export interface HubSpotMockRequest {
  method: string;
  path: string;
  status: number;
}

export interface HubSpotMock {
  handlers: HttpHandler[];
  objects: Record<MockObjectType, Map<string, MockCrmObject>>;
  requests: HubSpotMockRequest[];
  /** The next `count` requests get HTTP 429 with HubSpot's rate limit body. */
  startRateLimitStorm: (count: number) => void;
  /** The next `count` requests fail with `status`. */
  failNext: (count: number, status: number) => void;
  /** The next `count` requests whose path starts with `pathPrefix` fail with `status`. */
  failPath: (method: string, pathPrefix: string, status: number, count: number) => void;
  seedContact: (properties: Record<string, string>) => MockCrmObject;
  seedCompany: (properties: Record<string, string>) => MockCrmObject;
  seedDeal: (properties: Record<string, string>, links: { contactId?: string; companyId?: string }) => MockCrmObject;
  addOwner: (owner: MockOwner) => void;
  associationsOf: (type: MockObjectType, id: string, toType: MockObjectType) => string[];
  served: (status: number) => number;
  reset: () => void;
}

const OBJECT_TYPES: Record<string, MockObjectType> = {
  contact: 'contacts',
  contacts: 'contacts',
  company: 'companies',
  companies: 'companies',
  deal: 'deals',
  deals: 'deals',
  note: 'notes',
  notes: 'notes',
};

/** HubSpot association type id to the object type on the other side. */
const ASSOCIATION_TARGET: Record<number, MockObjectType> = {
  1: 'companies',
  279: 'companies',
  3: 'contacts',
  4: 'deals',
  5: 'companies',
  6: 'deals',
  341: 'companies',
  342: 'deals',
  190: 'companies',
  202: 'contacts',
  214: 'deals',
};

const ID_START: Record<MockObjectType, number> = { contacts: 1001, companies: 2001, deals: 3001, notes: 4001 };

const CLOSED_STAGES = new Set(['closedwon', 'closedlost']);

const hubspotError = (status: number, message: string, category: string, extra: Record<string, unknown> = {}): Response =>
  HttpResponse.json({ status: 'error', message, correlationId: randomUUID(), category, ...extra }, { status });

const toObjectType = (value: string | readonly string[] | undefined): MockObjectType | null =>
  typeof value === 'string' ? (OBJECT_TYPES[value] ?? null) : null;

const param = (value: string | readonly string[] | undefined): string => (typeof value === 'string' ? value : '');

export const createHubSpotMock = (options: { now?: () => Date } = {}): HubSpotMock => {
  const now = options.now ?? ((): Date => new Date());
  const objects: Record<MockObjectType, Map<string, MockCrmObject>> = {
    contacts: new Map(),
    companies: new Map(),
    deals: new Map(),
    notes: new Map(),
  };
  const nextId: Record<MockObjectType, number> = { ...ID_START };
  let associations: Association[] = [];
  const owners: MockOwner[] = [];
  const requests: HubSpotMockRequest[] = [];
  const pendingFailures: number[] = [];
  let pathFailures: { method: string; prefix: string; status: number; remaining: number }[] = [];

  const stamp = (): string => now().toISOString();

  const create = (type: MockObjectType, properties: Record<string, string | null>): MockCrmObject => {
    const id = String(nextId[type]);
    nextId[type] += 1;
    const at = stamp();
    const createdAt = properties.createdate ?? at;
    const object: MockCrmObject = { id, properties: { ...properties, hs_object_id: id, createdate: createdAt, lastmodifieddate: at }, createdAt, updatedAt: at };
    if (type === 'deals') {
      object.properties.hs_is_closed = CLOSED_STAGES.has(properties.dealstage ?? '') ? 'true' : 'false';
    }
    objects[type].set(id, object);
    return object;
  };

  const associate = (aType: MockObjectType, aId: string, bType: MockObjectType, bId: string, typeId: number): void => {
    const exists = associations.some(
      (link) => (link.aType === aType && link.aId === aId && link.bType === bType && link.bId === bId) || (link.aType === bType && link.aId === bId && link.bType === aType && link.bId === aId),
    );
    if (!exists) {
      associations.push({ aType, aId, bType, bId, typeId });
    }
  };

  const associationsOf = (type: MockObjectType, id: string, toType: MockObjectType): string[] =>
    associations.flatMap((link) => {
      if (link.aType === type && link.aId === id && link.bType === toType) {
        return [link.bId];
      }
      if (link.bType === type && link.bId === id && link.aType === toType) {
        return [link.aId];
      }
      return [];
    });

  const shape = (object: MockCrmObject, requested?: unknown): Record<string, unknown> => {
    const wanted = Array.isArray(requested) ? requested.filter((item): item is string => typeof item === 'string') : null;
    const properties = wanted
      ? Object.fromEntries([...new Set([...wanted, 'hs_object_id', 'createdate', 'lastmodifieddate'])].map((key) => [key, object.properties[key] ?? null]))
      : object.properties;
    return { id: object.id, properties, createdAt: object.createdAt, updatedAt: object.updatedAt, archived: false };
  };

  /** Runs injected failures and auth checks before any handler logic. */
  const guard = (request: Request): Response | null => {
    const path = new URL(request.url).pathname;
    const targeted = pathFailures.find((entry) => entry.remaining > 0 && entry.method === request.method && path.startsWith(entry.prefix));
    if (targeted) {
      targeted.remaining -= 1;
      return hubspotError(targeted.status, 'Injected failure (mock).', 'INTERNAL_ERROR');
    }
    const failure = pendingFailures.shift();
    if (failure === 429) {
      return hubspotError(429, 'You have reached your secondly limit.', 'RATE_LIMITS', { errorType: 'RATE_LIMIT', policyName: 'SECONDLY' });
    }
    if (failure !== undefined) {
      return hubspotError(failure, 'Internal error, please retry.', 'INTERNAL_ERROR');
    }
    if (!(request.headers.get('authorization') ?? '').startsWith('Bearer ')) {
      return hubspotError(401, 'Authentication credentials not found.', 'INVALID_AUTHENTICATION');
    }
    return null;
  };

  const record = (request: Request, response: Response): Response => {
    requests.push({ method: request.method, path: new URL(request.url).pathname, status: response.status });
    return response;
  };

  const readJson = async (request: Request): Promise<Record<string, unknown>> => {
    const body: unknown = await request.json().catch(() => ({}));
    return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  };

  const inlineAssociations = (fromType: MockObjectType, fromId: string, list: unknown): void => {
    if (!Array.isArray(list)) {
      return;
    }
    for (const entry of list as { to?: { id?: string }; types?: { associationTypeId?: number }[] }[]) {
      const toId = entry.to?.id;
      const typeId = entry.types?.[0]?.associationTypeId;
      const toType = typeId === undefined ? undefined : ASSOCIATION_TARGET[typeId];
      if (toId && toType && typeId !== undefined) {
        associate(fromType, fromId, toType, toId, typeId);
      }
    }
  };

  const handlers: HttpHandler[] = [
    http.post(`${BASE}/crm/v3/objects/:type/search`, async ({ request, params }) => {
      const failed = guard(request);
      if (failed) {
        return record(request, failed);
      }
      const type = toObjectType(params.type);
      if (!type) {
        return record(request, hubspotError(400, 'Unknown object type', 'VALIDATION_ERROR'));
      }
      const body = await readJson(request);
      const groups = Array.isArray(body.filterGroups) ? (body.filterGroups as { filters?: { propertyName?: string; operator?: string; value?: string }[] }[]) : [];
      const matches = [...objects[type].values()].filter((object) =>
        groups.length === 0
          ? true
          : groups.some((group) =>
              (group.filters ?? []).every((filter) => {
                if (filter.operator !== 'EQ' || !filter.propertyName) {
                  return false;
                }
                const actual = object.properties[filter.propertyName];
                return typeof actual === 'string' && actual.toLowerCase() === (filter.value ?? '').toLowerCase();
              }),
            ),
      );
      const limit = typeof body.limit === 'number' ? body.limit : 10;
      return record(request, HttpResponse.json({ total: matches.length, results: matches.slice(0, limit).map((object) => shape(object, body.properties)) }));
    }),

    http.post(`${BASE}/crm/v3/objects/deals/batch/read`, async ({ request }) => {
      const failed = guard(request);
      if (failed) {
        return record(request, failed);
      }
      const body = await readJson(request);
      const inputs = Array.isArray(body.inputs) ? (body.inputs as { id?: string }[]) : [];
      const results = inputs.map((input) => objects.deals.get(String(input.id))).filter((deal): deal is MockCrmObject => deal !== undefined);
      const at = stamp();
      return record(request, HttpResponse.json({ status: 'COMPLETE', results: results.map((deal) => shape(deal, body.properties)), startedAt: at, completedAt: at }));
    }),

    http.post(`${BASE}/crm/v3/objects/:type`, async ({ request, params }) => {
      const failed = guard(request);
      if (failed) {
        return record(request, failed);
      }
      const type = toObjectType(params.type);
      if (!type) {
        return record(request, hubspotError(400, 'Unknown object type', 'VALIDATION_ERROR'));
      }
      const body = await readJson(request);
      const properties = (typeof body.properties === 'object' && body.properties !== null ? body.properties : {}) as Record<string, string>;
      if (type === 'contacts' && properties.email) {
        const email = properties.email.toLowerCase();
        const existing = [...objects.contacts.values()].find((contact) => contact.properties.email?.toLowerCase() === email);
        if (existing) {
          return record(request, hubspotError(409, `Contact already exists. Existing ID: ${existing.id}`, 'CONFLICT'));
        }
      }
      if (type === 'notes' && !properties.hs_timestamp) {
        return record(request, hubspotError(400, 'Property hs_timestamp is required', 'VALIDATION_ERROR'));
      }
      const created = create(type, properties);
      inlineAssociations(type, created.id, body.associations);
      return record(request, HttpResponse.json(shape(created), { status: 201 }));
    }),

    http.patch(`${BASE}/crm/v3/objects/:type/:id`, async ({ request, params }) => {
      const failed = guard(request);
      if (failed) {
        return record(request, failed);
      }
      const type = toObjectType(params.type);
      const object = type ? objects[type].get(param(params.id)) : undefined;
      if (!type || !object) {
        return record(request, hubspotError(404, 'Object not found', 'OBJECT_NOT_FOUND'));
      }
      const body = await readJson(request);
      const properties = (typeof body.properties === 'object' && body.properties !== null ? body.properties : {}) as Record<string, string>;
      object.properties = { ...object.properties, ...properties, lastmodifieddate: stamp() };
      object.updatedAt = stamp();
      if (type === 'deals') {
        object.properties.hs_is_closed = CLOSED_STAGES.has(object.properties.dealstage ?? '') ? 'true' : 'false';
      }
      return record(request, HttpResponse.json(shape(object)));
    }),

    http.put(`${BASE}/crm/v4/objects/:fromType/:fromId/associations/default/:toType/:toId`, ({ request, params }) => {
      const failed = guard(request);
      if (failed) {
        return record(request, failed);
      }
      const fromType = toObjectType(params.fromType);
      const toType = toObjectType(params.toType);
      const fromId = param(params.fromId);
      const toId = param(params.toId);
      if (!fromType || !toType || !objects[fromType].has(fromId) || !objects[toType].has(toId)) {
        return record(request, hubspotError(404, 'Object not found', 'OBJECT_NOT_FOUND'));
      }
      const typeId = fromType === 'contacts' && toType === 'companies' ? 279 : fromType === 'deals' && toType === 'contacts' ? 3 : 0;
      associate(fromType, fromId, toType, toId, typeId);
      const at = stamp();
      return record(
        request,
        HttpResponse.json({
          status: 'COMPLETE',
          results: [{ from: { id: fromId }, to: { id: toId }, associationSpec: { associationCategory: 'HUBSPOT_DEFINED', associationTypeId: typeId } }],
          startedAt: at,
          completedAt: at,
        }),
      );
    }),

    http.get(`${BASE}/crm/v4/objects/:type/:id/associations/:toType`, ({ request, params }) => {
      const failed = guard(request);
      if (failed) {
        return record(request, failed);
      }
      const type = toObjectType(params.type);
      const toType = toObjectType(params.toType);
      if (!type || !toType) {
        return record(request, hubspotError(400, 'Unknown object type', 'VALIDATION_ERROR'));
      }
      const results = associationsOf(type, param(params.id), toType).map((toObjectId) => ({
        toObjectId: Number(toObjectId),
        associationTypes: [{ category: 'HUBSPOT_DEFINED', typeId: 0, label: null }],
      }));
      return record(request, HttpResponse.json({ results }));
    }),

    http.get(`${BASE}/crm/v3/owners/`, ({ request }) => {
      const failed = guard(request);
      if (failed) {
        return record(request, failed);
      }
      const email = new URL(request.url).searchParams.get('email')?.toLowerCase();
      const at = stamp();
      const results = owners
        .filter((owner) => !email || owner.email.toLowerCase() === email)
        .map((owner) => ({ ...owner, type: 'PERSON', archived: false, createdAt: at, updatedAt: at }));
      return record(request, HttpResponse.json({ results }));
    }),
  ];

  return {
    handlers,
    objects,
    requests,
    startRateLimitStorm: (count) => {
      for (let index = 0; index < count; index += 1) {
        pendingFailures.push(429);
      }
    },
    failNext: (count, status) => {
      for (let index = 0; index < count; index += 1) {
        pendingFailures.push(status);
      }
    },
    failPath: (method, pathPrefix, status, count) => {
      pathFailures.push({ method: method.toUpperCase(), prefix: pathPrefix, status, remaining: count });
    },
    seedContact: (properties) => create('contacts', properties),
    seedCompany: (properties) => create('companies', properties),
    seedDeal: (properties, links) => {
      const deal = create('deals', properties);
      if (links.contactId) {
        associate('deals', deal.id, 'contacts', links.contactId, 3);
      }
      if (links.companyId) {
        associate('deals', deal.id, 'companies', links.companyId, 5);
      }
      return deal;
    },
    addOwner: (owner) => {
      owners.push(owner);
    },
    associationsOf,
    served: (status) => requests.filter((entry) => entry.status === status).length,
    reset: () => {
      for (const type of Object.keys(objects) as MockObjectType[]) {
        objects[type].clear();
        nextId[type] = ID_START[type];
      }
      associations = [];
      owners.length = 0;
      requests.length = 0;
      pendingFailures.length = 0;
      pathFailures = [];
    },
  };
};
