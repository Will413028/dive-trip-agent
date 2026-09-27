import type { LlmRequest } from '@google/adk';
import { z } from 'zod';
import { chatCompletionRequest } from './chat-completion-wire.ts';

export const freeModelSchema = z.string().max(160).regex(/^[a-z0-9-]+\/[a-z0-9._-]+:free$/);
const identifier = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_.:-]+$/);
const count = z.number().int().min(0).max(1_000_000_000);
const usageSchema = z.object({ prompt_tokens: count, completion_tokens: count, total_tokens: count,
  cost: z.number().finite().nonnegative(), is_byok: z.boolean().optional(),
  prompt_tokens_details: z.object({ cached_tokens: count.optional() }).optional(),
  completion_tokens_details: z.object({ reasoning_tokens: count.optional() }).optional(),
}).refine(u => u.total_tokens === u.prompt_tokens + u.completion_tokens
  && (u.prompt_tokens_details?.cached_tokens ?? 0) <= u.prompt_tokens
  && (u.completion_tokens_details?.reasoning_tokens ?? 0) <= u.completion_tokens
  && u.is_byok !== true);

export type OpenRouterEvidence = {
  provider: 'openrouter'; requestedModel: string; returnedModel: string | null;
  generationId: string | null;
  usage: { promptTokens: number; outputTokens: number; totalTokens: number;
    cachedTokens?: number; thoughtTokens?: number; cost: number } | null;
};
/** OpenRouter-specific routing policy; never sent to another provider. */
export function openRouterRequest(input: LlmRequest, model: string) {
  freeModelSchema.parse(model);
  return { model, ...chatCompletionRequest(input), stream: false, max_tokens: 2048,
    provider: { allow_fallbacks: false, require_parameters: true, data_collection: 'deny',
      max_price: { prompt: 0, completion: 0, request: 0, image: 0 } },
  };
}

export function openRouterEvidence(value: unknown, model: string): OpenRouterEvidence {
  const raw = z.object({ id: identifier.optional(), model: z.string().max(160).regex(/^[a-z0-9-]+\/[a-z0-9._-]+(?::free)?$/).optional(), usage: z.unknown() }).safeParse(value);
  const u = raw.success ? usageSchema.safeParse(raw.data.usage) : null;
  return { provider: 'openrouter', requestedModel: model, returnedModel: raw.success ? raw.data.model ?? null : null,
    generationId: raw.success ? raw.data.id ?? null : null,
    usage: u?.success ? { promptTokens: u.data.prompt_tokens, outputTokens: u.data.completion_tokens,
      totalTokens: u.data.total_tokens, cost: u.data.cost,
      ...(u.data.prompt_tokens_details?.cached_tokens === undefined ? {} : { cachedTokens: u.data.prompt_tokens_details.cached_tokens }),
      ...(u.data.completion_tokens_details?.reasoning_tokens === undefined ? {} : { thoughtTokens: u.data.completion_tokens_details.reasoning_tokens }),
    } : null };
}

export { chatCompletionResponse as openRouterResponse } from './chat-completion-wire.ts';
