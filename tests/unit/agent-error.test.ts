import { expect, test } from 'vitest';
import { PROVIDER_ERROR_CODES, AgentProviderError } from '../../src/agent/provider-errors';
import { publicAgentErrorCode } from '../../src/server/agent-error';
import { DomainError } from '../../src/domain/errors';

test('preserve only exact safe classifications, not raw provider diagnostics', () => {
  for (const code of PROVIDER_ERROR_CODES) expect(publicAgentErrorCode(new AgentProviderError(code))).toBe(code);
  expect(publicAgentErrorCode(new DomainError('STALE_VERSION'))).toBe('STALE_VERSION');
  for (const error of [new Error('AGENT_PROVIDER_RATE_LIMIT key=synthetic-sensitive-value'),
    new Error('AGENT_PRIVATE_VALUE'), new Error('https://provider.invalid/?key=synthetic-sensitive-value'),
    { message: 'AGENT_PROVIDER_RATE_LIMIT' }, 'AGENT_PROVIDER_RATE_LIMIT', null]) {
    expect(publicAgentErrorCode(error)).toBe('AGENT_INTERRUPTED');
  }
});
