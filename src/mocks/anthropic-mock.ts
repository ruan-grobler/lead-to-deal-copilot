import { delay, http, HttpResponse, type HttpHandler } from 'msw';
import type { LeadExtraction } from '../extraction/schema.ts';

/**
 * A stand-in for the Claude Messages API. It never generates anything: each
 * scenario supplies a canned answer (or a failure to simulate), so the real
 * SDK, structured output parsing and fallback code run against known input.
 */

export type AnthropicBehavior =
  | { kind: 'extraction'; extraction: LeadExtraction }
  | { kind: 'http_error'; status: number; errorType: string; message: string }
  | { kind: 'hang' }
  | { kind: 'invalid_json'; text: string }
  | { kind: 'refusal' };

export interface AnthropicCall {
  model: string;
  betas: string[];
  effort: string | null;
  hasSchema: boolean;
  userText: string;
}

export interface AnthropicMock {
  handlers: HttpHandler[];
  calls: AnthropicCall[];
}

const userTextOf = (body: Record<string, unknown>): string => {
  const messages = Array.isArray(body.messages) ? (body.messages as { content?: unknown }[]) : [];
  return messages
    .map((message) => {
      if (typeof message.content === 'string') {
        return message.content;
      }
      if (Array.isArray(message.content)) {
        return (message.content as { text?: string }[]).map((part) => part.text ?? '').join('\n');
      }
      return '';
    })
    .join('\n');
};

let messageCounter = 0;

const messageBody = (model: string, content: unknown[], stopReason: string, extra: Record<string, unknown> = {}): Record<string, unknown> => {
  messageCounter += 1;
  return {
    id: `msg_mock_${String(messageCounter).padStart(4, '0')}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 900, output_tokens: 180 },
    ...extra,
  };
};

export const createAnthropicMock = (respond: (userText: string, call: AnthropicCall) => AnthropicBehavior): AnthropicMock => {
  const calls: AnthropicCall[] = [];
  const handlers: HttpHandler[] = [
    http.post('https://api.anthropic.com/v1/messages', async ({ request }) => {
      const parsed: unknown = await request.json();
      const body = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
      const outputConfig = (body.output_config ?? {}) as { effort?: string; format?: unknown };
      const call: AnthropicCall = {
        model: typeof body.model === 'string' ? body.model : '',
        betas: (request.headers.get('anthropic-beta') ?? '').split(',').map((beta) => beta.trim()).filter(Boolean),
        effort: outputConfig.effort ?? null,
        hasSchema: outputConfig.format !== undefined,
        userText: userTextOf(body),
      };
      calls.push(call);
      const behavior = respond(call.userText, call);
      switch (behavior.kind) {
        case 'extraction':
          return HttpResponse.json(
            messageBody(call.model, [{ type: 'thinking', thinking: '', signature: 'mock' }, { type: 'text', text: JSON.stringify(behavior.extraction) }], 'end_turn'),
          );
        case 'invalid_json':
          return HttpResponse.json(messageBody(call.model, [{ type: 'text', text: behavior.text }], 'end_turn'));
        case 'refusal':
          return HttpResponse.json(
            messageBody(call.model, [], 'refusal', { stop_details: { type: 'refusal', category: null, explanation: 'Declined by a safety classifier (mock).' } }),
          );
        case 'http_error':
          return HttpResponse.json({ type: 'error', error: { type: behavior.errorType, message: behavior.message } }, { status: behavior.status });
        case 'hang':
          await delay('infinite');
          return HttpResponse.json({});
      }
    }),
  ];
  return { handlers, calls };
};
