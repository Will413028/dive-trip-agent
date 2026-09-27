import { expect, test, vi } from 'vitest';
import cases from '../../evals/cases.json';
import { runCloudflareDiagnosticCampaign, type DiagnosticCampaignReport } from '../../evals/cloudflare-diagnostic-campaign';
import { recoveryAccount, recoveryResult } from '../support/cloudflare-recovery-fixture';
import { diagnosticPrior } from '../support/cloudflare-diagnostic-fixture';
import { gradeEvidenceV2 } from '../../evals/evidence';
import { CLOUDFLARE_MODEL } from '../../src/agent/cloudflare-wire';

function harness() {
  let now = 0, attempts = 0;
  const checkpoints: DiagnosticCampaignReport[] = [];
  const ports: Parameters<typeof runCloudflareDiagnosticCampaign>[0] = {
    accountId: recoveryAccount, prior: diagnosticPrior(), now: () => now,
    pause: vi.fn(async ms => { now += ms; }), checkDispatch: vi.fn(async signal => { signal.throwIfAborted(); }),
    checkpoint: vi.fn(async report => { checkpoints.push(report); }), reviewPreflight: vi.fn(async () => true),
    execute: vi.fn(async (id, dispatch) => {
      attempts++;
      for (let i = 0; i < (cases.find(c => c.id === id)!.terminal === 'proposal' ? 2 : 1); i++) await dispatch(new AbortController().signal);
      return recoveryResult(id, attempts, { modelCalls: 7 });
    }),
    capture: vi.fn(async () => ({ chargedMicros: attempts * 100, modelCalls: attempts * 7, totalTokens: attempts * 1000,
      privateUsageComplete: true, usageKnown: true, record: { synthetic: true } })),
  };
  return { ports, checkpoints };
}

test('the new grant carries four unknowns and fits exactly 30 cases / 210 calls / 39 dispatches', async () => {
  const h = harness();
  vi.mocked(h.ports.reviewPreflight).mockImplementation(async report => {
    expect(report.invocations).toBe(2);
    expect(vi.mocked(h.ports.execute).mock.calls.map(([id]) => id)).toEqual(['unknown-cost', 'no-date']);
    expect(h.checkpoints.at(-1)).toEqual(report);
    return true;
  });
  const report = await runCloudflareDiagnosticCampaign(h.ports);
  expect(report).toMatchObject({ stopped: null, maxModelCalls: 210, maxInvocations: 39,
    invocations: 39, cumulativeInvocations: 82, modelCalls: 210, cumulativeModelCalls: 271,
    cumulativeChargedMicros: 768494, cumulativeTokens: null, historicalUnknownReceipts: 4,
    textReview: 'pending', accountingComplete: false, dispatchAuthorized: false, evaluationGatePassed: false });
  expect(h.ports.execute).toHaveBeenCalledTimes(30); expect(h.ports.checkDispatch).toHaveBeenCalledTimes(39);
  expect(h.ports.reviewPreflight).toHaveBeenCalledOnce();
  expect(h.checkpoints.every(row => row.invocations <= 39 && row.cumulativeInvocations <= 82)).toBe(true);
});

test.each([false, null, 'truthy'])('non-true review %s prevents all remaining 28', async decision => {
  const h = harness(); vi.mocked(h.ports.reviewPreflight).mockResolvedValue(decision as boolean);
  const report = await runCloudflareDiagnosticCampaign(h.ports);
  expect(report.stopped).toBe('PREFLIGHT_TEXT_REVIEW_STOP');
  expect(h.ports.execute).toHaveBeenCalledTimes(2);
  expect(report.records.filter(row => (row as { outcome?: string }).outcome === 'skipped')).toHaveLength(28);
});

test.each([['invocations', 42], ['modelCalls', 60], ['chargedMicros', 581989], ['historicalUnknownReceipts', 3],
  ['sourceSha256', '0'.repeat(64)], ['totalTokens', 0], ['dispatchAuthorized', true]])('rejects stale or altered prior %s before IO', async (key, value) => {
  const h = harness(); Object.assign(h.ports.prior, { [key]: value });
  await expect(runCloudflareDiagnosticCampaign(h.ports)).rejects.toThrow();
  expect(h.ports.execute).not.toHaveBeenCalled(); expect(h.ports.checkpoint).not.toHaveBeenCalled();
});

test('new unknown usage stops at the first attempt without erasing historical unknowns', async () => {
  const h = harness();
  vi.mocked(h.ports.capture).mockResolvedValue({ chargedMicros: 183505, modelCalls: 7, totalTokens: null,
    privateUsageComplete: true, usageKnown: false, record: { synthetic: true } });
  const report = await runCloudflareDiagnosticCampaign(h.ports);
  expect(report).toMatchObject({ stopped: 'UNKNOWN_USAGE_STOP', invocations: 1, cumulativeInvocations: 44,
    cumulativeTokens: null, historicalUnknownReceipts: 4, accountingComplete: false });
  expect(h.ports.execute).toHaveBeenCalledOnce(); expect(h.ports.reviewPreflight).not.toHaveBeenCalled();
});

test.each([4, 12, 22])('a non-safety goal miss at slot %i stops before the next case, even with a forged supplied grade', async stopAt => {
  const h = harness(), execute = h.ports.execute;
  let attempt = 0;
  vi.mocked(h.ports.execute).mockImplementation(async (id, dispatch) => {
    attempt++;
    for (let i = 0; i < (cases.find(c => c.id === id)!.terminal === 'proposal' ? 2 : 1); i++) await dispatch(new AbortController().signal);
    const result = recoveryResult(id, attempt, { modelCalls: 7 });
    if (attempt === stopAt) {
      expect(id).toBe('non-diver');
      result.evidence.after = structuredClone(result.evidence.before);
      const actual = gradeEvidenceV2(result.evidence, CLOUDFLARE_MODEL);
      expect(actual.reasons).toContain('GOAL_MISSED'); expect(actual.safetyFailures).toEqual([]);
      result.grade = { pass: true, reasons: [], safetyFailures: [] };
    }
    return result;
  });
  vi.mocked(h.ports.capture).mockImplementation(async () => ({ chargedMicros: attempt * 100,
    modelCalls: attempt * 7, totalTokens: attempt * 1000, privateUsageComplete: true, usageKnown: true,
    record: { synthetic: true } }));
  const report = await runCloudflareDiagnosticCampaign(h.ports);
  expect(report.stopped).toBe('GOAL_EVIDENCE_STOP');
  expect(execute).toHaveBeenCalledTimes(stopAt); expect(h.ports.reviewPreflight).toHaveBeenCalledOnce();
  expect(report.records.filter(row => (row as { outcome?: string }).outcome === 'skipped')).toHaveLength(30 - stopAt);
  expect(report.modelCalls).toBe(stopAt * 7);
});
