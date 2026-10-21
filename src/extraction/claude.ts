import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { InboundLead } from '../domain/types.ts';
import { describeError, OperationFailedError } from '../reliability/errors.ts';
import type { RetryRunner } from '../reliability/retry.ts';
import { renderLeadForModel, SYSTEM_PROMPT } from './prompt.ts';
import { LeadExtractionSchema, type LeadExtraction } from './schema.ts';

export type AiFailureReason = 'timeout' | 'api_error' | 'invalid_output' | 'refusal';

export type AiOutcome =
  | { ok: true; extraction: LeadExtraction; latencyMs: number; model: string }
  | { ok: false; reason: AiFailureReason; detail: string; latencyMs: number };

export interface AiExtractor {
  extract: (lead: InboundLead) => Promise<AiOutcome>;
}

export interface ClaudeExtractorDeps {
  client: Anthropic;
  model: string;
  timeoutMs: number;
  retry: RetryRunner;
}

const OUTPUT_FORMAT = betaZodOutputFormat(LeadExtractionSchema);

const classifyFailure = (error: unknown): AiFailureReason => {
  const cause = error instanceof OperationFailedError ? error.cause : error;
  if (cause instanceof Anthropic.APIConnectionTimeoutError) {
    return 'timeout';
  }
  if (cause instanceof Anthropic.APIError) {
    return 'api_error';
  }
  if (cause instanceof SyntaxError || (cause instanceof Anthropic.AnthropicError && cause.message.includes('structured output'))) {
    return 'invalid_output';
  }
  return 'api_error';
};

/**
 * Claude with structured outputs. The zod schema becomes the JSON schema the
 * API enforces, and the SDK validates the reply against it again. Every
 * failure comes back as a typed reason, never as a thrown error, so the
 * caller can fall back to rules and send the lead to human review.
 */
export const createClaudeExtractor = (deps: ClaudeExtractorDeps): AiExtractor => ({
  extract: async (lead) => {
    const started = performance.now();
    const elapsed = (): number => Math.round(performance.now() - started);
    try {
      const message = await deps.retry.run('claude.extract', async () =>
        deps.client.beta.messages.parse(
          {
            model: deps.model,
            max_tokens: 4096,
            // Server side fallback: if a safety classifier declines, the API retries on its recommended fallback model.
            betas: ['server-side-fallback-2026-07-01'],
            fallbacks: 'default',
            output_config: { effort: 'low', format: OUTPUT_FORMAT },
            system: SYSTEM_PROMPT,
            messages: [{ role: 'user', content: renderLeadForModel(lead) }],
          },
          { timeout: deps.timeoutMs, maxRetries: 0 },
        ),
      );
      if (message.stop_reason === 'refusal') {
        return { ok: false, reason: 'refusal', detail: 'Model declined the request', latencyMs: elapsed() };
      }
      if (message.stop_reason === 'max_tokens' || message.parsed_output === null) {
        return { ok: false, reason: 'invalid_output', detail: `No complete structured output (stop_reason ${String(message.stop_reason)})`, latencyMs: elapsed() };
      }
      return { ok: true, extraction: message.parsed_output, latencyMs: elapsed(), model: message.model };
    } catch (error) {
      return { ok: false, reason: classifyFailure(error), detail: describeError(error), latencyMs: elapsed() };
    }
  },
});
