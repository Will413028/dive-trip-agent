import { randomUUID } from 'node:crypto';
import { expect, test, vi } from 'vitest';
import { ReceiptOnlyModel } from '../../src/agent/receipt-model';
import { validateRuntimeExecution, type AgentExecution, type AgentRuntimeConfig } from '../../src/agent/runtime';
import { makeSnapshot } from '../support/domain-fixtures';

const snapshot = makeSnapshot(), runId = randomUUID();
const input: AgentExecution = { runId, sessionId: runId, ownerId: randomUUID(), tripId: randomUUID(),
  baseVersion: 1, snapshot, catalog: snapshot.entries.map(entry => entry.item),
  input: { kind: 'resume', interruptId: 'native-gate', decision: 'approved', committedResult: { status: 'applied', version: 2 } } };
const config: AgentRuntimeConfig = { databaseUrl: 'postgresql://postgres@127.0.0.1:1/dive_trip_test', schema: 'test_adk',
  provider: { kind: 'gemini', deadlineMs: Date.now() + 60_000, previousModelCalls: 7 } };

test('receipt model has no transport capability even if native ADK attempts generation', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('NETWORK_FORBIDDEN'));
  try {
    const source = new ReceiptOnlyModel();
    expect(() => source.generateContentAsync()).toThrow('AGENT_GENERATION_DISABLED');
    await expect(source.connect()).rejects.toThrow('AGENT_GENERATION_DISABLED');
    expect(fetch).not.toHaveBeenCalled();
  } finally { fetch.mockRestore(); }
});

test('resume keeps provider binding but rejects generation; seven prior calls do not authorize an eighth', () => {
  expect(() => validateRuntimeExecution(input, config)).not.toThrow();
  expect(() => validateRuntimeExecution(input, { ...config, generation: { apiKey: 'offline-placeholder-not-a-credential' },
    offlineScenario: 'proposal' })).toThrow('AGENT_GENERATION_DISABLED');
  expect(() => validateRuntimeExecution({ ...input, input: { kind: 'start', message: '合成規劃' } }, config))
    .toThrow('AGENT_GENERATION_REQUIRED');
  expect(() => validateRuntimeExecution({ ...input, input: { kind: 'start', message: '合成規劃' } }, { ...config,
    generation: { apiKey: 'offline-placeholder-not-a-credential' }, offlineScenario: 'proposal' })).not.toThrow();
});
