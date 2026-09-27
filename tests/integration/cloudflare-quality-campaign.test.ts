import { expect, test, vi } from 'vitest';
import { runCloudflareQualityCampaign } from '../../evals/cloudflare-quality-campaign';
import { createCloudflareCampaignPorts } from '../support/cloudflare-campaign-ports';
import { withDatabase } from '../support/database';
import { database } from '../../src/server/db';
import { evaluationInput } from '../../evals/fixtures';

// Synthetic historical projection for protocol tests, never a live admission grant.
const prior = {
  sourceSha256: '3cd0ada7274e15b4c1813b884c0e0a8a7d1ebc277b3f1c0337c00abf5269248d',
  historyConsistent: true, dispatchAuthorized: false, accountingComplete: false, evaluationGatePassed: false,
  historicalUnknownReceipts: 1, invocations: 10, modelCalls: 14, chargedMicros: 190067,
  observedTokens: 61192, totalTokens: null, remainingInvocationCeiling: 90, remainingReferenceMicros: 2809933,
} as const;
test.each(['clarify', 'invalid-tool-arguments', 'rate-limit'] as const)(
  'quality preflight stop through real HTTP/ADK with synthetic %s, never retries', scenario => withDatabase(async () => {
    const accountId = '1fd574e905257afa3cfd7db80cf70b23';
    const loadCredential = vi.fn(async () => 'offline-placeholder-not-a-credential');
    // The fetch-only test bootstrap permits only its synthetic account. The
    // scheduler policy identity is tested separately; this is not provenance.
    const ports = createCloudflareCampaignPorts({ accountId: 'a'.repeat(32), priorChargedMicros: prior.chargedMicros,
      offlineScenario: scenario, loadCredential });
    const gate = vi.fn(async (signal: AbortSignal) => { signal.throwIfAborted(); });
    const execute = vi.fn(ports.execute), capture = vi.fn(ports.capture);
    const report = await runCloudflareQualityCampaign({ accountId, prior, execute, capture, reviewPreflight: async () => false,
      now: Date.now, pause: async () => {}, checkpoint: async () => {}, checkDispatch: gate });
    expect(execute.mock.calls.map(([id]) => id)).toEqual(['locked-budget']);
    expect(gate).toHaveBeenCalledTimes(1); expect(loadCredential).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(report).toMatchObject({ invocations: 1, modelCalls: 1, cumulativeInvocations: 11,
      cumulativeModelCalls: 15, cumulativeTokens: null, accountingComplete: false, evaluationGatePassed: false,
      stopped: scenario === 'clarify' ? 'PREFLIGHT_TEXT_REVIEW_STOP' : scenario === 'rate-limit' ? 'UNKNOWN_USAGE_STOP' : 'FAILED_RUN_STOP' });
    expect((await database().query('SELECT count(*)::int AS count FROM proposals')).rows[0].count).toBe(0);
    expect((await database().query('SELECT current_version FROM trips')).rows[0].current_version).toBe(1);
    expect((await database().query('SELECT snapshot FROM trip_versions')).rows[0].snapshot).toEqual(evaluationInput('locked-budget').before);
    const audit = report.records.find(r => r && typeof r === 'object' && 'kind' in r && r.kind === 'durable-audit');
    expect(audit).toMatchObject({ privateUsageComplete: true, quiescent: true });
    expect(report.totalTokens).toBe(scenario === 'rate-limit' ? null : 28);
    expect(report.cumulativeChargedMicros).toBe(prior.chargedMicros + report.chargedMicros);
  }), 45_000);
