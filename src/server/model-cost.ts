import type { ProviderUsage } from '../agent/provider';
import type { AgentProviderKind, ProviderAccountingEvidence } from '../agent/provider-contract';
import { CLOUDFLARE_PRICE_BASIS, matchesCloudflareModel } from '../agent/cloudflare-wire.ts';

/** Reference-price risk accounting only; neither billing nor paid authorization.
 * Verified 2026-09-22 against https://ai.google.dev/gemini-api/docs/pricing#gemini-3.1-flash-lite
 * and https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-lite.
 * Standard text: USD .25/M input, 1.50/M output including thoughts.
 */
export const MODEL_PRICE_BASIS = 'gemini-3.1-flash-lite-standard-text-2026-09-22';
const MAX_INPUT_TOKENS = 1_048_576;
const MAX_OUTPUT_TOKENS = 2_048;
const MAX_CALLS = 7;
const tokenCount = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;

function cost(prompt: number, output: number): number | null {
  const micros = (BigInt(prompt) + BigInt(output) * 6n + 3n) / 4n;
  return micros <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(micros) : null;
}

/** Ceiling per call avoids floating-point under-reservation. Byte limits are
 * deliberately NOT used as token counts. Zero remaining calls permits no work. */
export function maximumModelCost(remainingCalls = MAX_CALLS): number {
  if (!Number.isInteger(remainingCalls) || remainingCalls < 0 || remainingCalls > MAX_CALLS) {
    throw new Error('INVALID_MODEL_CALL_BUDGET');
  }
  return cost(MAX_INPUT_TOKENS, MAX_OUTPUT_TOKENS)! * remainingCalls;
}

/** Unknown/invalid usage never becomes zero. Treat every non-prompt token as
 * output at the higher rate, including thoughts and tool-use overhead. Cached
 * prompt tokens receive no discount. Do not cap observed overruns at the bound. */
export function referenceModelCost(usage: ProviderUsage | null): number | null {
  if (!usage || !tokenCount(usage.promptTokens) || !tokenCount(usage.outputTokens)
    || !tokenCount(usage.totalTokens)
    || (usage.cachedTokens !== undefined && (!tokenCount(usage.cachedTokens) || usage.cachedTokens > usage.promptTokens))
    || (usage.thoughtTokens !== undefined && !tokenCount(usage.thoughtTokens))) return null;
  if (BigInt(usage.totalTokens) < BigInt(usage.promptTokens) + BigInt(usage.outputTokens) + BigInt(usage.thoughtTokens ?? 0)) return null;
  return cost(usage.promptTokens, usage.totalTokens - usage.promptTokens);
}

/** Provider-specific accounting. OpenRouter is intentionally free-only here:
 * a non-zero or missing reported cost is unknown and cannot be settled as zero.
 * This formula is independent from Gemini's reference-price calculation. */
export function referenceProviderCost(provider: AgentProviderKind, usage: ProviderUsage | null,
  evidence?: ProviderAccountingEvidence): number | null {
  if (provider === 'gemini') return referenceModelCost(usage);
  if (provider === 'cloudflare') {
    if (!usage || evidence?.provider !== 'cloudflare' || evidence.priceBasis !== CLOUDFLARE_PRICE_BASIS
      || !matchesCloudflareModel(evidence.returnedModel)
      || !tokenCount(usage.promptTokens) || !tokenCount(usage.outputTokens) || !tokenCount(usage.totalTokens)
      || usage.totalTokens !== usage.promptTokens + usage.outputTokens
      || (usage.cachedTokens !== undefined && (!tokenCount(usage.cachedTokens) || usage.cachedTokens > usage.promptTokens))
      || (usage.thoughtTokens !== undefined && (!tokenCount(usage.thoughtTokens) || usage.thoughtTokens > usage.outputTokens))) return null;
    // USD .10/M input, .30/M output; reasoning already INCLUDED in output.
    // Ceiling in microdollars, no cached-input discount. Not an actual bill.
    const micros = (BigInt(usage.promptTokens) + 3n * BigInt(usage.outputTokens) + 9n) / 10n;
    return micros <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(micros) : null;
  }
  if (!usage || !evidence || evidence.provider !== 'openrouter'
    || evidence.reportedCostMicros !== 0 || !evidence.generationId || !evidence.returnedModel) return null;
  return 0;
}

/** Conservative reservation ceiling for a free OpenRouter invocation. A
 * reservation is positive because the quota ledger cannot represent zero;
 * successful evidence settles it to zero, while any non-zero report fails. */
export function maximumProviderModelCost(provider: AgentProviderKind, remainingCalls = MAX_CALLS): number {
  if (provider === 'gemini') return maximumModelCost(remainingCalls);
  if (!Number.isInteger(remainingCalls) || remainingCalls < 0 || remainingCalls > MAX_CALLS) {
    throw new Error('INVALID_MODEL_CALL_BUDGET');
  }
  if (provider === 'cloudflare') return Math.ceil((256_000 + MAX_OUTPUT_TOKENS * 3) / 10) * remainingCalls;
  return remainingCalls;
}
