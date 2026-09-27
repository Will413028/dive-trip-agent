import type { BaseLlm } from '@google/adk';
import { freeModelSchema, openRouterEvidence, openRouterRequest, openRouterResponse, type OpenRouterEvidence } from './openrouter-wire.ts';
import { error } from './bounded-json-transport.ts';
import { UnaryRestModel } from './unary-rest-model.ts';

type Options = {
  apiKey: string; model: string; deadlineMs: number;
  onCallStart(callId: string): Promise<void> | void;
  onEvidence(evidence: OpenRouterEvidence, callId: string): Promise<void> | void;
};

export function createOpenRouterProvider(options: Options): BaseLlm {
  if (!options || !freeModelSchema.safeParse(options.model).success || typeof options.apiKey !== 'string'
    || !options.apiKey.trim() || /[\r\n]/.test(options.apiKey) || options.apiKey.length > 1024
    || !Number.isSafeInteger(options.deadlineMs) || options.deadlineMs <= 0
    || typeof options.onCallStart !== 'function' || typeof options.onEvidence !== 'function') throw error('AGENT_PROVIDER_CONFIG');
  return new UnaryRestModel({ ...options, provider: 'openrouter', endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    request: input => openRouterRequest(input, options.model), evidence: raw => openRouterEvidence(raw, options.model),
    validateEvidence: evidence => {
      if (!evidence.generationId || !evidence.returnedModel || !evidence.usage) throw error('AGENT_PROVIDER_INVALID_RESPONSE');
      if (evidence.usage.cost !== 0) throw error('AGENT_PROVIDER_BILLING');
      if (![options.model, options.model.slice(0, -5)].includes(evidence.returnedModel)) throw error('AGENT_PROVIDER_INVALID_RESPONSE');
    }, response: openRouterResponse,
  });
}
