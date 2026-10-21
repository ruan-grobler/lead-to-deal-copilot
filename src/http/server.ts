import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Clock } from '../clock.ts';
import type { Repository } from '../db/repository.ts';
import type { InboundLead } from '../domain/types.ts';
import type { Logger } from '../logger.ts';
import type { Metrics } from '../metrics.ts';
import type { LeadProcessor } from '../pipeline/processor.ts';
import { describeError } from '../reliability/errors.ts';
import type { JobQueue } from '../reliability/job-queue.ts';
import { parseEmailToLead } from '../sources/email.ts';
import { FormSubmissionSchema, formSubmissionToLead } from '../sources/form.ts';
import { SIGNATURE_HEADER, verifySignature } from './signature.ts';

export interface HttpServerDeps {
  processor: LeadProcessor;
  queue: JobQueue;
  repo: Repository;
  logger: Logger;
  metrics: Metrics;
  clock: Clock;
  maxBodyBytes: number;
  formSecret: string | null;
  emailSecret: string | null;
  mode: 'mock' | 'live';
  startedAt: Date;
}

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const readBody = async (request: IncomingMessage, limit: number): Promise<Buffer> => {
  const declared = Number(request.headers['content-length'] ?? '0');
  if (declared > limit) {
    throw new HttpError(413, `Body larger than ${String(limit)} bytes`);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > limit) {
      throw new HttpError(413, `Body larger than ${String(limit)} bytes`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
};

const sendJson = (response: ServerResponse, status: number, body: unknown): void => {
  const payload = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) });
  response.end(payload);
};

const contentType = (request: IncomingMessage): string => (request.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ?? '';

const parseJson = (body: Buffer): unknown => {
  try {
    return JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    throw new HttpError(400, 'Body is not valid JSON');
  }
};

const header = (request: IncomingMessage, name: string): string | undefined => {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

/**
 * Webhooks persist first, answer 202, then process on the queue. The sender
 * never waits on Claude or HubSpot, and a replayed delivery answers 200 with
 * the existing lead instead of creating a second one.
 */
export const createHttpServer = (deps: HttpServerDeps): Server => {
  const accept = (lead: InboundLead): { status: number; body: Record<string, unknown> } => {
    const outcome = deps.processor.ingest(lead);
    if (outcome.duplicate) {
      return { status: 200, body: { status: 'duplicate', leadId: outcome.leadId, leadStatus: outcome.status } };
    }
    deps.queue.push(async () => {
      await deps.processor.process(outcome.leadId);
    });
    return { status: 202, body: { status: 'accepted', leadId: outcome.leadId } };
  };

  const checkSignature = (secret: string | null, body: Buffer, request: IncomingMessage): void => {
    if (secret && !verifySignature(secret, body, header(request, SIGNATURE_HEADER))) {
      throw new HttpError(401, 'Missing or invalid signature');
    }
  };

  const handleForm = async (request: IncomingMessage): Promise<{ status: number; body: Record<string, unknown> }> => {
    if (contentType(request) !== 'application/json') {
      throw new HttpError(415, 'Use Content-Type: application/json');
    }
    const body = await readBody(request, deps.maxBodyBytes);
    checkSignature(deps.formSecret, body, request);
    const parsed = FormSubmissionSchema.safeParse(parseJson(body));
    if (!parsed.success) {
      throw new HttpError(400, parsed.error.issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`).join('; '));
    }
    return accept(formSubmissionToLead(parsed.data, deps.clock.now()));
  };

  const handleEmail = async (request: IncomingMessage): Promise<{ status: number; body: Record<string, unknown> }> => {
    const type = contentType(request);
    const body = await readBody(request, deps.maxBodyBytes);
    checkSignature(deps.emailSecret, body, request);
    let raw: string;
    if (type === 'message/rfc822' || type === 'text/plain') {
      raw = body.toString('utf8');
    } else if (type === 'application/json') {
      const json = parseJson(body);
      const candidate = typeof json === 'object' && json !== null ? (json as Record<string, unknown>).raw : undefined;
      if (typeof candidate !== 'string' || candidate.length === 0) {
        throw new HttpError(400, 'JSON body needs a "raw" field with the full RFC 822 message');
      }
      raw = candidate;
    } else {
      throw new HttpError(415, 'Use Content-Type: message/rfc822, or application/json with a "raw" field');
    }
    if (raw.trim().length === 0) {
      throw new HttpError(400, 'Empty message');
    }
    return accept(await parseEmailToLead(raw, deps.clock.now()));
  };

  const health = (): { status: number; body: Record<string, unknown> } => {
    const dbOk = ((): boolean => {
      try {
        return deps.repo.ping();
      } catch {
        return false;
      }
    })();
    return {
      status: dbOk ? 200 : 503,
      body: {
        status: dbOk ? 'ok' : 'degraded',
        mode: deps.mode,
        database: dbOk ? 'ok' : 'unavailable',
        queue: { waiting: deps.queue.size(), running: deps.queue.running() },
        deadLettersPending: dbOk ? deps.repo.countPendingDeadLetters() : null,
        uptimeSeconds: Math.round((deps.clock.now().getTime() - deps.startedAt.getTime()) / 1000),
      },
    };
  };

  return createServer((request, response) => {
    const requestId = randomUUID();
    const started = performance.now();
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    const route = `${request.method ?? 'GET'} ${path}`;

    const run = async (): Promise<{ status: number; body: Record<string, unknown> }> => {
      switch (route) {
        case 'GET /health':
          return health();
        case 'POST /webhooks/form':
          return handleForm(request);
        case 'POST /webhooks/email':
          return handleEmail(request);
        default:
          if (path === '/health' || path === '/webhooks/form' || path === '/webhooks/email') {
            throw new HttpError(405, 'Method not allowed');
          }
          throw new HttpError(404, 'Not found');
      }
    };

    void run()
      .then(({ status, body }) => {
        sendJson(response, status, body);
        deps.metrics.inc(`http.${String(status)}`);
        deps.logger.info('http.request', { requestId, route, status, ms: Math.round(performance.now() - started) });
      })
      .catch((error: unknown) => {
        const status = error instanceof HttpError ? error.status : 500;
        const message = error instanceof HttpError ? error.message : 'Internal error';
        sendJson(response, status, { status: 'error', error: message, requestId });
        deps.metrics.inc(`http.${String(status)}`);
        const log = status >= 500 ? deps.logger.error : deps.logger.warn;
        log('http.request', { requestId, route, status, error: describeError(error), ms: Math.round(performance.now() - started) });
      });
  });
};
