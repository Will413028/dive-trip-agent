/** Public classifications only. Never include upstream text, URLs or credentials. */
export const PROVIDER_ERROR_CODES = Object.freeze(['AGENT_PROVIDER_CONFIG', 'AGENT_PROVIDER_TIMEOUT',
  'AGENT_PROVIDER_RATE_LIMIT', 'AGENT_PROVIDER_REFUSAL', 'AGENT_PROVIDER_INVALID_RESPONSE', 'AGENT_PROVIDER_ERROR',
  'AGENT_PROVIDER_AUTH', 'AGENT_PROVIDER_PERMISSION', 'AGENT_PROVIDER_BAD_REQUEST', 'AGENT_PROVIDER_NOT_FOUND',
  'AGENT_PROVIDER_BILLING', 'AGENT_PROVIDER_UNAVAILABLE', 'AGENT_PROVIDER_NETWORK', 'AGENT_PROVIDER_TLS',
] as const);
export type ProviderErrorCode = typeof PROVIDER_ERROR_CODES[number];
export class AgentProviderError extends Error {
  readonly code: ProviderErrorCode;
  constructor(code: ProviderErrorCode) { super(code); this.code = code; this.name = 'AgentProviderError'; }
}
