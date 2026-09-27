import { expect, test, vi } from 'vitest';
import { runCloudflareNonthinkingCampaign } from '../../evals/cloudflare-nonthinking-campaign';
import { createCloudflareCampaignPorts } from '../support/cloudflare-campaign-ports';
import { nonthinkingPrior } from '../support/cloudflare-nonthinking-fixture';
import { recoveryAccount } from '../support/cloudflare-recovery-fixture';
import { withDatabase } from '../support/database';
import { database } from '../../src/server/db';
import { usageEvidenceSchema } from '../../evals/usage-evidence';

test.each(['clarify', 'invalid-tool-arguments', 'rate-limit', 'missing-usage'] as const)(
  'non-thinking single-case %s uses native ADK, one start and no retry/continuation', scenario => withDatabase(async () => {
    const prior = nonthinkingPrior();
    const loadCredential = vi.fn(async () => 'offline-placeholder-not-a-credential');
    const ports = createCloudflareCampaignPorts({ accountId: 'a'.repeat(32), priorChargedMicros: prior.chargedMicros,
      offlineScenario: scenario, loadCredential });
    const execute = vi.fn(ports.execute), capture = vi.fn(ports.capture);
    // Synthetic answer is NOT reviewed as task success; a negative review is retained.
    const reviewPreflight = vi.fn(async () => false);
    const report = await runCloudflareNonthinkingCampaign({ ...ports, execute, capture, reviewPreflight,
      accountId: recoveryAccount, prior, checkDispatch: async signal => { signal.throwIfAborted(); },
      checkpoint: async () => {}, now: Date.now, pause: async () => {} });
    expect(execute).toHaveBeenCalledExactlyOnceWith('unknown-cost', expect.any(Function));
    expect(loadCredential).toHaveBeenCalledOnce(); expect(capture).toHaveBeenCalledOnce();
    expect(reviewPreflight).toHaveBeenCalledTimes(scenario === 'clarify' ? 1 : 0);
    const captured = await capture.mock.results[0].value;
    expect(usageEvidenceSchema.parse(captured.record.privateUsage[0]).invocations.map(i => i.kind)).toEqual(['start']);
    expect(report).toMatchObject({ invocations: 1, cumulativeInvocations: 43, modelCalls: 1, cumulativeModelCalls: 61,
      maxModelCalls: 7, maxInvocations: 1, historicalUnknownReceipts: 3, cumulativeTokens: null, evaluationGatePassed: false,
      stopped: scenario === 'clarify' ? 'PREFLIGHT_TEXT_REVIEW_STOP'
        : scenario === 'invalid-tool-arguments' ? 'FAILED_RUN_STOP' : 'UNKNOWN_USAGE_STOP' });
    expect(report.records).toHaveLength(2);
    expect((await database().query('SELECT current_version FROM trips')).rows).toEqual([{ current_version: 1 }]);
    expect((await database().query('SELECT count(*)::int AS count FROM proposals')).rows).toEqual([{ count: 0 }]);
  }), 45_000);

test('synthetic adapter rejects the new live capability before credential loading', () => {
  const loadCredential = vi.fn(async () => 'offline-placeholder-not-a-credential');
  expect(() => createCloudflareCampaignPorts({ accountId: 'a'.repeat(32), priorChargedMicros: 581989,
    offlineScenario: 'clarify', liveCampaign: 'cloudflare-nonthinking-one-case', loadCredential })).toThrow('EVAL_INVALID_CAMPAIGN_CONTEXT');
  expect(loadCredential).not.toHaveBeenCalled();
});
