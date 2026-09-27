import { expect, test, vi } from 'vitest';
import { offlineScenarioSchema, type OfflineScenario } from '../../src/agent/offline-scenario';
import { validateRuntimeConfig, type AgentRuntimeConfig } from '../../src/agent/runtime';
import { validateAgentContext, type AgentServerContext } from '../../src/server/agent-policy';

const syntheticKey = 'offline-placeholder-not-a-credential';
function inputs(scenario: OfflineScenario) {
  const loadCredential = vi.fn(async () => syntheticKey);
  const runtime: AgentRuntimeConfig = {
    databaseUrl: 'postgres://postgres@127.0.0.1:5432/dive_trip_test', schema: 'test_adk',
    provider: { kind: 'openrouter', model: 'example/synthetic:free', deadlineMs: 1, previousModelCalls: 0 },
    generation: { apiKey: syntheticKey }, offlineScenario: scenario,
  };
  const context: Exclude<AgentServerContext, { provider: 'fixture' }> = {
    provider: 'openrouter', model: 'example/synthetic:free', verifiedPeerAddress: '127.0.0.1',
    hashingKey: new Uint8Array(32), loadCredential, offlineScenario: scenario,
    quota: { enabled: true, priceBasis: 'synthetic', dailyBudgetMicros: 1, reservationTtlMs: 60_000 },
  };
  return { runtime, context, loadCredential };
}

test('the synthetic scenario vocabulary is closed', () => {
  expect(offlineScenarioSchema.options).toEqual([
    'clarify', 'proposal', 'rate-limit', 'missing-usage', 'hang', 'invalid-tool-arguments', 'invalid-json',
  ]);
});
test.each(offlineScenarioSchema.options)('%s is accepted independently at server and runtime boundaries', scenario => {
  const { runtime, context, loadCredential } = inputs(scenario);
  expect(() => validateAgentContext(context)).not.toThrow();
  expect(() => validateRuntimeConfig(runtime)).not.toThrow();
  expect(() => validateRuntimeConfig({ ...runtime, generation: { apiKey: 'different-synthetic-value' } }))
    .toThrow('AGENT_OFFLINE_CONFIG');
  expect(() => validateAgentContext({ ...context, liveLocal: true })).toThrow('AGENT_POLICY_DISABLED');
  expect(loadCredential).not.toHaveBeenCalled();
});
test.each(['../worker.ts', 'live', 'invalid-json ', '', null, undefined, { scenario: 'invalid-json' }])(
  'invalid scenario %j cannot open an offline dispatch boundary', value => {
    const { runtime, context, loadCredential } = inputs(value as OfflineScenario);
    expect(offlineScenarioSchema.safeParse(value).success).toBe(false);
    expect(() => validateAgentContext(context)).toThrow('AGENT_POLICY_DISABLED');
    expect(() => validateRuntimeConfig(runtime)).toThrow('AGENT_OFFLINE_CONFIG');
    expect(loadCredential).not.toHaveBeenCalled();
  },
);
