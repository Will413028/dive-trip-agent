import { expect, test, vi } from 'vitest';
import { runCloudflareNonthinkingCampaign, type NonthinkingCampaignReport } from '../../evals/cloudflare-nonthinking-campaign';
import { nonthinkingPrior } from '../support/cloudflare-nonthinking-fixture';
import { recoveryAccount, recoveryResult } from '../support/cloudflare-recovery-fixture';

function harness() {
  let now = 0;
  const saved: NonthinkingCampaignReport[] = [];
  const ports: Parameters<typeof runCloudflareNonthinkingCampaign>[0] = {
    accountId: recoveryAccount, prior: nonthinkingPrior(), now: () => now,
    pause: vi.fn(async ms => { now += ms; }), checkDispatch: vi.fn(async signal => { signal.throwIfAborted(); }),
    checkpoint: vi.fn(async report => { saved.push(report); }), reviewPreflight: vi.fn(async () => true),
    execute: vi.fn(async (id, dispatch) => { await dispatch(new AbortController().signal); return recoveryResult(id, 1); }),
    capture: vi.fn(async () => ({ chargedMicros: 100, modelCalls: 2, totalTokens: 1000,
      usageKnown: true, privateUsageComplete: true, record: { synthetic: true } })),
  };
  return { ports, saved };
}

test('exactly one unknown-cost start; review completion never dispatches another case', async () => {
  const { ports, saved } = harness();
  const report = await runCloudflareNonthinkingCampaign(ports);
  expect(ports.execute).toHaveBeenCalledExactlyOnceWith('unknown-cost', expect.any(Function));
  expect(ports.checkDispatch).toHaveBeenCalledOnce(); expect(ports.reviewPreflight).toHaveBeenCalledOnce();
  expect(report).toMatchObject({ schemaVersion: 2, stopped: null, maxModelCalls: 7, maxInvocations: 1,
    invocations: 1, cumulativeInvocations: 43, modelCalls: 2, cumulativeModelCalls: 62,
    chargedMicros: 100, cumulativeChargedMicros: 582089, totalTokens: 1000, cumulativeTokens: null,
    historicalUnknownReceipts: 3, textReview: 'pending', evaluationGatePassed: false, accountingComplete: false,
    dispatchAuthorized: false, prior: nonthinkingPrior() });
  expect(report.records).toHaveLength(2);
  expect(saved.every(r => r.invocations <= 1 && r.cumulativeInvocations <= 43)).toBe(true);
  expect(saved.at(-1)).toEqual(report);
});

test('a second dispatch is stopped before dispatch accounting or history/loader gate', async () => {
  const { ports } = harness();
  vi.mocked(ports.execute).mockImplementation(async (id, dispatch) => {
    await dispatch(new AbortController().signal); await dispatch(new AbortController().signal);
    return recoveryResult(id, 1);
  });
  const report = await runCloudflareNonthinkingCampaign(ports);
  expect(report).toMatchObject({ stopped: 'EVAL_INVOCATION_STOP', invocations: 1, cumulativeInvocations: 43 });
  expect(ports.checkDispatch).toHaveBeenCalledOnce(); expect(ports.reviewPreflight).not.toHaveBeenCalled();
});

test.each([7, 8])('model-call count %i is bounded independently of a passing response', async count => {
  const { ports } = harness();
  vi.mocked(ports.execute).mockImplementation(async (id, dispatch) => {
    await dispatch(new AbortController().signal); return recoveryResult(id, 1, { modelCalls: count });
  });
  vi.mocked(ports.capture).mockResolvedValue({ chargedMicros: 100, modelCalls: count, totalTokens: 1000,
    usageKnown: true, privateUsageComplete: true, record: { synthetic: true } });
  if (count === 8) await expect(runCloudflareNonthinkingCampaign(ports)).rejects.toThrow('EVAL_PRIVATE_USAGE_EXPORT_FAILED');
  else expect(await runCloudflareNonthinkingCampaign(ports)).toMatchObject({ modelCalls: 7, cumulativeModelCalls: 67, stopped: null });
  expect(ports.execute).toHaveBeenCalledOnce();
  expect(ports.reviewPreflight).toHaveBeenCalledTimes(count === 7 ? 1 : 0);
});

test.each(['failed', 'unknown', 'goal', 'history', 'review'] as const)('%s failure cannot cause retry or erase history', async mode => {
  const { ports } = harness();
  if (mode === 'failed' || mode === 'goal') vi.mocked(ports.execute).mockImplementation(async (id, dispatch) => {
    await dispatch(new AbortController().signal);
    return recoveryResult(id, 1, mode === 'failed' ? { runStatus: 'failed' } : { afterVersion: 2 });
  });
  if (mode === 'unknown') vi.mocked(ports.capture).mockResolvedValue({ chargedMicros: 183505, modelCalls: 2,
    totalTokens: null, usageKnown: false, privateUsageComplete: true, record: { synthetic: true } });
  if (mode === 'history') vi.mocked(ports.checkDispatch).mockRejectedValue(new Error('EVAL_HISTORY_CHANGED'));
  if (mode === 'review') vi.mocked(ports.reviewPreflight).mockResolvedValue(false);
  // A denied pre-dispatch gate has not made any calls.
  if (mode === 'history') vi.mocked(ports.capture).mockResolvedValue({ chargedMicros: 0, modelCalls: 0,
    totalTokens: 0, usageKnown: true, privateUsageComplete: true, record: { synthetic: true } });
  const report = await runCloudflareNonthinkingCampaign(ports);
  expect(report.stopped).not.toBeNull();
  expect(report).toMatchObject({ prior: nonthinkingPrior(), cumulativeTokens: null, historicalUnknownReceipts: 3,
    dispatchAuthorized: false, evaluationGatePassed: false });
  expect(ports.execute).toHaveBeenCalledOnce();
  expect(ports.reviewPreflight).toHaveBeenCalledTimes(mode === 'review' ? 1 : 0);
  if (mode === 'unknown') expect(report).toMatchObject({ stopped: 'UNKNOWN_USAGE_STOP', cumulativeChargedMicros: 765494 });
});

test.each([['invocations', 41], ['modelCalls', 59], ['chargedMicros', 0], ['totalTokens', 0],
  ['historicalUnknownReceipts', 2], ['sourceSha256', '0'.repeat(64)], ['dispatchAuthorized', true]])(
  'prior %s cannot be reset or replaced', async (key, value) => {
    const { ports } = harness(); Object.assign(ports.prior, { [key]: value });
    await expect(runCloudflareNonthinkingCampaign(ports)).rejects.toThrow();
    expect(ports.checkpoint).not.toHaveBeenCalled(); expect(ports.execute).not.toHaveBeenCalled();
  });
