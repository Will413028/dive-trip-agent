import type { BaseLlm } from '@google/adk';
import { CLOUDFLARE_MODEL, cloudflareAccountSchema, matchesCloudflareModel, cloudflareEvidence, cloudflareRequest, cloudflareResponse, type CloudflareEvidence } from './cloudflare-wire.ts';
import { error } from './bounded-json-transport.ts';
import { UnaryRestModel } from './unary-rest-model.ts';
import { cloudflareInvalidResponse } from './provider-diagnostic.ts';

type Options = {
  apiKey: string; accountId: string; model: string; deadlineMs: number;
  onCallStart(callId: string): Promise<void> | void;
  onEvidence(evidence: CloudflareEvidence, callId: string): Promise<void> | void;
};

export function createCloudflareProvider(options: Options): BaseLlm {
  if (!options || options.model !== CLOUDFLARE_MODEL || !cloudflareAccountSchema.safeParse(options.accountId).success || typeof options.apiKey !== 'string'
    || !options.apiKey.trim() || /[\r\n]/.test(options.apiKey) || options.apiKey.length > 1024
    || !Number.isSafeInteger(options.deadlineMs) || options.deadlineMs <= 0
    || typeof options.onCallStart !== 'function' || typeof options.onEvidence !== 'function') throw error('AGENT_PROVIDER_CONFIG');
  return new UnaryRestModel({ ...options, provider: 'cloudflare',
    endpoint: `https://api.cloudflare.com/client/v4/accounts/${options.accountId}/ai/run/${CLOUDFLARE_MODEL}`,
    request: input => cloudflareRequest(input, options.model), evidence: raw => cloudflareEvidence(raw, options.model),
    validateEvidence: evidence => {
      if (!evidence.usage) throw cloudflareInvalidResponse('evidence', 'usage-invalid');
      if (!matchesCloudflareModel(evidence.returnedModel)) throw cloudflareInvalidResponse('evidence', 'model-mismatch');
    }, response: cloudflareResponse,
  });
}
