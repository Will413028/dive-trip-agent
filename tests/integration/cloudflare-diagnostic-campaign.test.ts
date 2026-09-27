import { expect, test, vi } from 'vitest';
import { runCloudflareDiagnosticCampaign, type DiagnosticCampaignReport } from '../../evals/cloudflare-diagnostic-campaign';
import { createCloudflareCampaignPorts } from '../support/cloudflare-campaign-ports';
import { diagnosticPrior } from '../support/cloudflare-diagnostic-fixture';
import { recoveryAccount } from '../support/cloudflare-recovery-fixture';
import { withDatabase } from '../support/database';
import { database } from '../../src/server/db';

const placeholder = 'offline-placeholder-not-a-credential';
test('diagnostic dual-case barrier uses native ADK/current answers and preserves four historical unknowns',
  () => withDatabase(async () => {
    const prior = diagnosticPrior(), loadCredential = vi.fn(async () => placeholder);
    const adapter = createCloudflareCampaignPorts({ accountId: 'a'.repeat(32), priorChargedMicros: prior.chargedMicros,
      offlineScenario: 'clarify', loadCredential });
    const execute = vi.fn(adapter.execute), capture = vi.fn(adapter.capture);
    const reviewPreflight = vi.fn(async (report: DiagnosticCampaignReport) => {
      expect(report.records.filter(row => (row as { outcome?: string }).outcome === 'completed')).toHaveLength(2);
      expect(report).toMatchObject({ invocations: 2, cumulativeInvocations: 45, modelCalls: 2 });
      return false;
    });
    const report = await runCloudflareDiagnosticCampaign({ accountId: recoveryAccount, prior, execute, capture,
      reviewPreflight, checkDispatch: async signal => { signal.throwIfAborted(); },
      checkpoint: async () => {}, now: Date.now, pause: async () => {} });
    expect(execute.mock.calls.map(([id]) => id)).toEqual(['unknown-cost', 'no-date']);
    expect(loadCredential).toHaveBeenCalledTimes(2); expect(reviewPreflight).toHaveBeenCalledOnce();
    for (const result of execute.mock.results) {
      const collected: Awaited<ReturnType<typeof adapter.execute>> = await result.value;
      expect(collected).toMatchObject({ schemaVersion: 2, evidence: { runStatus: 'succeeded', decision: 'none',
        beforeVersion: 1, afterVersion: 1, usageComplete: true, textReview: 'pending' } });
      expect(collected.events.some(event => event.type === 'CUSTOM')).toBe(true);
      expect(collected.events.some(event => event.type.startsWith('TEXT_MESSAGE_'))).toBe(false);
      expect(collected.grade).toMatchObject({ pass: false, reasons: ['TEXT_REVIEW_REQUIRED'] });
    }
    expect(report).toMatchObject({ stopped: 'PREFLIGHT_TEXT_REVIEW_STOP', invocations: 2, cumulativeInvocations: 45,
      cumulativeModelCalls: 63, historicalUnknownReceipts: 4, cumulativeTokens: null, accountingComplete: false,
      textReview: 'pending', evaluationGatePassed: false });
    expect(report.records.filter(row => (row as { outcome?: string }).outcome === 'skipped')).toHaveLength(28);
    expect((await database().query('SELECT current_version FROM trips')).rows).toEqual([{ current_version: 1 }, { current_version: 1 }]);
  }), 45_000);

test.each(['invalid-tool-arguments', 'rate-limit', 'invalid-json'] as const)(
  'diagnostic %s stops after one start without review, retry or losing history', scenario => withDatabase(async () => {
    const prior = diagnosticPrior(), loadCredential = vi.fn(async () => placeholder);
    const adapter = createCloudflareCampaignPorts({ accountId: 'a'.repeat(32), priorChargedMicros: prior.chargedMicros,
      offlineScenario: scenario, loadCredential });
    const execute = vi.fn(adapter.execute), reviewPreflight = vi.fn(async () => true);
    const report = await runCloudflareDiagnosticCampaign({ accountId: recoveryAccount, prior, ...adapter, execute, reviewPreflight,
      checkDispatch: async signal => { signal.throwIfAborted(); }, checkpoint: async () => {}, now: Date.now, pause: async () => {} });
    expect(execute).toHaveBeenCalledOnce(); expect(loadCredential).toHaveBeenCalledOnce(); expect(reviewPreflight).not.toHaveBeenCalled();
    expect(report).toMatchObject({ stopped: scenario === 'invalid-tool-arguments' ? 'FAILED_RUN_STOP' : 'UNKNOWN_USAGE_STOP',
      invocations: 1, cumulativeInvocations: 44, modelCalls: 1, historicalUnknownReceipts: 4, evaluationGatePassed: false });
    expect(report.records.filter(row => (row as { outcome?: string }).outcome === 'skipped')).toHaveLength(29);
  }), 45_000);

test('synthetic adapter cannot acquire the diagnostic live capability', () => {
  const loadCredential = vi.fn(async () => placeholder);
  expect(() => createCloudflareCampaignPorts({ accountId: 'a'.repeat(32), priorChargedMicros: 765494,
    offlineScenario: 'clarify', liveCampaign: 'cloudflare-diagnostic-30-cases', loadCredential })).toThrow('EVAL_INVALID_CAMPAIGN_CONTEXT');
  expect(loadCredential).not.toHaveBeenCalled();
});
