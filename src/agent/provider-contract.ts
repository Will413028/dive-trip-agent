import { z } from 'zod';
import { CLOUDFLARE_PRICE_BASIS } from './cloudflare-wire.ts';

export const PROVIDER_KINDS = ['gemini', 'openrouter', 'cloudflare'] as const;
export type AgentProviderKind = typeof PROVIDER_KINDS[number];

export type OpenRouterAccountingEvidence = {
  provider: 'openrouter';
  generationId: string | null;
  returnedModel: string | null;
  /** OpenRouter-reported cost converted by the adapter. null means unknown. */
  reportedCostMicros: number | null;
};

export type CloudflareAccountingEvidence = {
  provider: 'cloudflare';
  returnedModel: string | null;
  /** Reference-price basis only, never a claim about the account's bill. */
  priceBasis: typeof CLOUDFLARE_PRICE_BASIS;
};
export type ProviderAccountingEvidence = OpenRouterAccountingEvidence | CloudflareAccountingEvidence;

export const providerAccountingEvidenceSchema = z.discriminatedUnion('provider', [
  z.strictObject({ provider: z.literal('openrouter'), generationId: z.string().max(128).nullable(),
    returnedModel: z.string().max(160).nullable(), reportedCostMicros: z.number().int().nonnegative().max(1_000_000_000).nullable() }),
  z.strictObject({ provider: z.literal('cloudflare'), returnedModel: z.string().max(160).nullable(),
    priceBasis: z.literal(CLOUDFLARE_PRICE_BASIS) }),
]);
