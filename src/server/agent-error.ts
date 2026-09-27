import { PROVIDER_ERROR_CODES } from '../agent/provider-errors';
import { DomainError } from '../domain/errors';

const safeCodes = new Set<string>([...PROVIDER_ERROR_CODES, 'AGENT_EXECUTION_FAILED',
  'AGENT_EVENT_PERSISTENCE_FAILED', 'AGENT_WORKER_INTERRUPTED', 'AGENT_ABORTED', 'AGENT_TIMEOUT', 'AGENT_TOOL_ARGUMENTS']);

/** Exact allowlist, not prefix matching. Error.message/cause/stack never leave here. */
export function publicAgentErrorCode(error: unknown): string {
  if (error instanceof DomainError && error.code === 'STALE_VERSION') return 'STALE_VERSION';
  return error instanceof Error && safeCodes.has(error.message) ? error.message : 'AGENT_INTERRUPTED';
}
