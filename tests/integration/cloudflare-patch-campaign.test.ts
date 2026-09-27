import { expect, test, vi } from 'vitest';
import { runCloudflarePatchCampaign } from '../../evals/cloudflare-patch-campaign';
import { createCloudflareCampaignPorts } from '../support/cloudflare-campaign-ports';
import { withDatabase } from '../support/database';
import { database } from '../../src/server/db';
import { evaluationInput } from '../../evals/fixtures';

// Synthetic historical projection for protocol tests, never a live admission grant.
const prior = {
  sourceSha256: '491ffcaccdb30045113dcbc78e511d25e56e6e79faa82cbf0bd705df51e0786b',
  historyConsistent: true, dispatchAuthorized: false, accountingComplete: false, evaluationGatePassed: false,
  historicalUnknownReceipts: 1, invocations: 9, modelCalls: 12, chargedMicros: 188948,
  observedTokens: 51739, totalTokens: null, remainingInvocationCeiling: 91, remainingReferenceMicros: 2811052,
} as const;
test.each(['clarify', 'invalid-tool-arguments', 'rate-limit'] as const)(
  'one-case scheduler through real HTTP/ADK with synthetic %s, never retries', scenario => withDatabase(async () => {
    const accountId = '1fd574e905257afa3cfd7db80cf70b23';
    const loadCredential = vi.fn(async () => 'offline-placeholder-not-a-credential');
    // The fetch-only test bootstrap permits only its synthetic account. The
    // scheduler policy identity is tested separately; this is not provenance.
    const ports = createCloudflareCampaignPorts({ accountId: 'a'.repeat(32), priorChargedMicros: prior.chargedMicros,
      offlineScenario: scenario, loadCredential });
    const gate = vi.fn(async (signal: AbortSignal) => { signal.throwIfAborted(); });
    const execute = vi.fn(ports.execute), capture = vi.fn(ports.capture);
    const report = await runCloudflarePatchCampaign({ accountId, prior, execute, capture,
      now: Date.now, pause: async () => {}, checkpoint: async () => {}, checkDispatch: gate });
    expect(execute.mock.calls.map(([id]) => id)).toEqual(['locked-budget']);
    expect(gate).toHaveBeenCalledTimes(1); expect(loadCredential).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(report).toMatchObject({ invocations: 1, modelCalls: 1, cumulativeInvocations: 10,
      cumulativeModelCalls: 13, cumulativeTokens: null, accountingComplete: false, evaluationGatePassed: false,
      stopped: scenario === 'clarify' ? null : scenario === 'rate-limit' ? 'UNKNOWN_USAGE_STOP' : 'FAILED_RUN_STOP' });
    expect((await database().query('SELECT count(*)::int AS count FROM proposals')).rows[0].count).toBe(0);
    expect((await database().query('SELECT current_version FROM trips')).rows[0].current_version).toBe(1);
    expect((await database().query('SELECT snapshot FROM trip_versions')).rows[0].snapshot).toEqual(evaluationInput('locked-budget').before);
    const audit = report.records.find(r => r && typeof r === 'object' && 'kind' in r && r.kind === 'durable-audit');
    expect(audit).toMatchObject({ privateUsageComplete: true, quiescent: true });
    expect(report.totalTokens).toBe(scenario === 'rate-limit' ? null : 28);
    expect(report.cumulativeChargedMicros).toBe(prior.chargedMicros + report.chargedMicros);
  }), 45_000);
