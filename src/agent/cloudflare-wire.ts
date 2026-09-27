import type { LlmRequest, LlmResponse } from '@google/adk';
import { z } from 'zod';
import { chatCompletionRequest, chatCompletionResponse } from './chat-completion-wire.ts';
import { AgentProviderError } from './provider-errors.ts';
import { cloudflareInvalidResponse } from './provider-diagnostic.ts';

export const CLOUDFLARE_MODEL = '@cf/google/gemma-4-26b-a4b-it';
export const CLOUDFLARE_PRICE_BASIS = 'cloudflare-gemma4-26b-2026-09-26';
export const cloudflareAccountSchema = z.string().length(32).regex(/^[a-f0-9]{32}$/);
export const matchesCloudflareModel = (value: unknown): boolean =>
  value === CLOUDFLARE_MODEL || value === `${CLOUDFLARE_MODEL}-external`;
const count = z.number().int().min(0).max(1_000_000_000);
const usageSchema = z.object({ prompt_tokens: count, completion_tokens: count, total_tokens: count,
  prompt_tokens_details: z.object({ cached_tokens: count.optional() }).optional(),
  completion_tokens_details: z.object({ reasoning_tokens: count.optional() }).optional(),
}).refine(u => u.total_tokens === u.prompt_tokens + u.completion_tokens
  && (u.prompt_tokens_details?.cached_tokens ?? 0) <= u.prompt_tokens
  && (u.completion_tokens_details?.reasoning_tokens ?? 0) <= u.completion_tokens);
export type CloudflareEvidence = {
  provider: 'cloudflare'; requestedModel: string; returnedModel: string | null; generationId: string | null;
  usage: { promptTokens: number; outputTokens: number; totalTokens: number;
    cachedTokens?: number; thoughtTokens?: number } | null;
};

function resultOf(value: unknown): unknown {
  const envelope = z.object({ success: z.literal(true), result: z.unknown(),
    errors: z.array(z.unknown()).max(0).optional() }).safeParse(value);
  return envelope.success ? envelope.data.result : null;
}

export function cloudflareRequest(input: LlmRequest, model: string) {
  if (model !== CLOUDFLARE_MODEL) throw new AgentProviderError('AGENT_PROVIDER_CONFIG');
  // Account-scoped REST model path chooses the model. No Gateway, paid fallback,
  // OpenRouter routing fields, caller base URL, or caller retry policy.
  // Pin Gemma's documented non-thinking mode for the bounded tool/AnswerPlan
  // protocol. This is generation policy, not proof of zero reasoning usage.
  return { ...chatCompletionRequest(input), stream: false, max_completion_tokens: 2048,
    chat_template_kwargs: { enable_thinking: false } };
}

export function cloudflareEvidence(value: unknown, model: string): CloudflareEvidence {
  const raw = z.object({ id: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_.:-]+$/).optional(),
    model: z.string().max(160).regex(/^@cf\/[a-z0-9-]+\/[a-z0-9._-]+$/).optional(),
    usage: z.unknown().optional() }).safeParse(resultOf(value));
  const usage = raw.success ? usageSchema.safeParse(raw.data.usage) : null;
  return { provider: 'cloudflare', requestedModel: model, returnedModel: raw.success ? raw.data.model ?? null : null,
    generationId: raw.success ? raw.data.id ?? null : null,
    usage: usage?.success ? { promptTokens: usage.data.prompt_tokens, outputTokens: usage.data.completion_tokens,
      totalTokens: usage.data.total_tokens,
      ...(usage.data.prompt_tokens_details?.cached_tokens === undefined ? {} : { cachedTokens: usage.data.prompt_tokens_details.cached_tokens }),
      ...(usage.data.completion_tokens_details?.reasoning_tokens === undefined ? {} : { thoughtTokens: usage.data.completion_tokens_details.reasoning_tokens }),
    } : null };
}

export function cloudflareResponse(value: unknown): LlmResponse {
  const result = resultOf(value);
  try { return chatCompletionResponse(result); }
  catch (error) {
    if (!(error instanceof AgentProviderError) || error.code !== 'AGENT_PROVIDER_INVALID_RESPONSE') throw error;
    const reason = z.object({ choices: z.array(z.object({
      finish_reason: z.enum(['length', 'content_filter']),
    })).length(1) }).safeParse(result);
    throw cloudflareInvalidResponse('response', reason.success ? reason.data.choices[0]!.finish_reason : 'other-response');
  }
}
