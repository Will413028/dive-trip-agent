import { expect, test, vi } from 'vitest';
import { runCloudflareGroundedCampaign, type GroundedCampaignReport } from '../../evals/cloudflare-grounded-campaign';
import { createCloudflareCampaignPorts } from '../support/cloudflare-campaign-ports';
import { groundedPrior } from '../support/cloudflare-grounded-fixture';
import { recoveryAccount } from '../support/cloudflare-recovery-fixture';
import { withDatabase } from '../support/database';
import { database } from '../../src/server/db';
import { usageEvidenceSchema } from '../../evals/usage-evidence';

const placeholder = 'offline-placeholder-not-a-credential';
test('grounded two-case gate uses native ADK/current answers and stops before the other 28 on negative review',
  () => withDatabase(async () => {
    const prior = groundedPrior();
    const loadCredential = vi.fn(async () => placeholder);
    const adapter = createCloudflareCampaignPorts({ accountId: 'a'.repeat(32), priorChargedMicros: prior.chargedMicros,
      offlineScenario: 'clarify', loadCredential });
    const execute = vi.fn(adapter.execute), capture = vi.fn(adapter.capture);
    const checkDispatch = vi.fn(async (signal: AbortSignal) => { signal.throwIfAborted(); });
    const reviewPreflight = vi.fn(async (report: GroundedCampaignReport) => {
      expect(report.records.filter(row => (row as { outcome?: string }).outcome === 'completed')).toHaveLength(2);
      expect(report).toMatchObject({ invocations: 2, maxInvocations: 39, cumulativeInvocations: 43, modelCalls: 2 });
      return false;
    });
    const report = await runCloudflareGroundedCampaign({ accountId: recoveryAccount, prior, execute, capture,
      checkDispatch, reviewPreflight, checkpoint: async () => {}, now: Date.now, pause: async () => {} });
    expect(execute.mock.calls.map(([caseId]) => caseId)).toEqual(['unknown-cost', 'no-date']);
    expect(checkDispatch).toHaveBeenCalledTimes(2); expect(loadCredential).toHaveBeenCalledTimes(2);
    expect(reviewPreflight).toHaveBeenCalledOnce();
    for (const result of execute.mock.results) {
      const collected: Awaited<ReturnType<typeof adapter.execute>> = await result.value;
      expect(collected).toMatchObject({ schemaVersion: 2, evidence: { runStatus: 'succeeded', decision: 'none',
        beforeVersion: 1, afterVersion: 1, usageComplete: true, textReview: 'pending' } });
      expect(collected.events.some(e => e.type === 'CUSTOM')).toBe(true);
      expect(collected.events.some(e => e.type.startsWith('TEXT_MESSAGE_'))).toBe(false);
      expect(collected.grade).toMatchObject({ pass: false, reasons: ['TEXT_REVIEW_REQUIRED'] });
    }
    for (const result of capture.mock.results) {
      const captured = await result.value;
      expect(captured).toMatchObject({ usageKnown: true, privateUsageComplete: true });
      expect(usageEvidenceSchema.parse(captured.record.privateUsage[0]).invocations.map(r => r.kind)).toEqual(['start']);
    }
    expect(report).toMatchObject({ stopped: 'PREFLIGHT_TEXT_REVIEW_STOP', invocations: 2, cumulativeInvocations: 43,
      modelCalls: 2, cumulativeModelCalls: 61, historicalUnknownReceipts: 2, cumulativeTokens: null,
      textReview: 'pending', evaluationGatePassed: false });
    expect(report.records.filter(r => (r as { outcome?: string }).outcome === 'skipped')).toHaveLength(28);
    expect((await database().query('SELECT current_version FROM trips')).rows).toEqual([{ current_version: 1 }, { current_version: 1 }]);
  }), 45_000);

test.each(['invalid-tool-arguments', 'rate-limit'] as const)('grounded %s stops at one start without review or retry',
  scenario => withDatabase(async () => {
    const prior = groundedPrior(), loadCredential = vi.fn(async () => placeholder);
    const adapter = createCloudflareCampaignPorts({ accountId: 'a'.repeat(32), priorChargedMicros: prior.chargedMicros,
      offlineScenario: scenario, loadCredential });
    const execute = vi.fn(adapter.execute), reviewPreflight = vi.fn(async () => true);
    const report = await runCloudflareGroundedCampaign({ accountId: recoveryAccount, prior,
      ...adapter, execute, reviewPreflight, checkDispatch: async signal => { signal.throwIfAborted(); },
      checkpoint: async () => {}, now: Date.now, pause: async () => {} });
    expect(execute).toHaveBeenCalledOnce(); expect(loadCredential).toHaveBeenCalledOnce();
    expect(reviewPreflight).not.toHaveBeenCalled();
    expect(report).toMatchObject({ stopped: scenario === 'rate-limit' ? 'UNKNOWN_USAGE_STOP' : 'FAILED_RUN_STOP',
      invocations: 1, cumulativeInvocations: 42, modelCalls: 1, evaluationGatePassed: false });
    expect(report.records.filter(r => (r as { outcome?: string }).outcome === 'skipped')).toHaveLength(29);
  }), 45_000);

test('synthetic adapter cannot also claim the grounded live capability', () => {
  const loadCredential = vi.fn(async () => placeholder);
  expect(() => createCloudflareCampaignPorts({ accountId: 'a'.repeat(32), priorChargedMicros: 398484,
    offlineScenario: 'clarify', liveCampaign: 'cloudflare-grounded-30-cases', loadCredential })).toThrow('EVAL_INVALID_CAMPAIGN_CONTEXT');
  expect(loadCredential).not.toHaveBeenCalled();
});
