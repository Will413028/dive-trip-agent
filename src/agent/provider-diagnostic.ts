import { z } from 'zod';
import { AgentProviderError } from './provider-errors.ts';

const diagnostic = z.strictObject({ code: z.literal('AGENT_PROVIDER_INVALID_RESPONSE'),
  provider: z.literal('cloudflare'),
  stage: z.enum(['evidence', 'response']),
  reason: z.enum(['usage-invalid', 'model-mismatch', 'length', 'content_filter', 'other-response']),
});

const restProvider = z.enum(['cloudflare', 'openrouter']);
const restStage = z.enum(['request', 'call-start', 'fetch', 'body-read', 'body-json', 'evidence', 'response', 'evidence-save']);
const restDetail = z.union([
  z.strictObject({ stage: restStage }),
  z.strictObject({ stage: z.literal('http'), httpStatus: z.number().int().min(0).max(599) }),
]);
const restDiagnostic = z.union(restDetail.options.map(shape => shape.extend({
  code: z.literal('AGENT_PROVIDER_ERROR'), provider: restProvider,
})));
const privateDiagnostic = z.union([diagnostic, restDiagnostic]);
export type RestProvider = z.infer<typeof restProvider>;
export type RestFailureStage = z.infer<typeof restStage>;

/** Location, not an inferred upstream cause or retry permission. Only local
 * stage literals and the numeric HTTP status enter private native ADK storage.
 * No caught error, request/response data, headers, URL or credential is accepted. */
export function restProviderFailure(provider: RestProvider, detail: z.infer<typeof restDetail>): AgentProviderError {
  const error = new AgentProviderError('AGENT_PROVIDER_ERROR');
  error.message = JSON.stringify(restDiagnostic.parse({ ...detail, code: error.code, provider }));
  return error;
}

/** Private ADK error metadata. Only locally selected enums, never upstream text. */
export function cloudflareInvalidResponse(stage: 'evidence' | 'response',
  reason: z.infer<typeof diagnostic>['reason']): AgentProviderError {
  const error = new AgentProviderError('AGENT_PROVIDER_INVALID_RESPONSE');
  error.message = JSON.stringify(diagnostic.parse({ code: error.code, provider: 'cloudflare', stage, reason }));
  return error;
}

/** Decode private ADK metadata to the unchanged public classification. */
export function providerDiagnosticErrorCode(message: string | undefined): 'AGENT_PROVIDER_INVALID_RESPONSE' | 'AGENT_PROVIDER_ERROR' | undefined {
  if (!message || message.length > 512) return undefined;
  try {
    const parsed = privateDiagnostic.safeParse(JSON.parse(message));
    return parsed.success ? parsed.data.code : undefined;
  }
  catch { return undefined; }
}
