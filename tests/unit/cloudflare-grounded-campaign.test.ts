import { expect, test, vi } from 'vitest';
import cases from '../../evals/cases.json';
import { runCloudflareGroundedCampaign, type GroundedCampaignReport } from '../../evals/cloudflare-grounded-campaign';
import { recoveryAccount, recoveryResult } from '../support/cloudflare-recovery-fixture';
import { groundedPrior } from '../support/cloudflare-grounded-fixture';

type Ports = Parameters<typeof runCloudflareGroundedCampaign>[0];
function harness(extra?: (caseId: string, attempt: number) => number) {
  let now = 0, attempts = 0;
  const checkpoints: GroundedCampaignReport[] = [];
  const ports: Ports = {
    accountId: recoveryAccount, prior: groundedPrior(), now: () => now,
    pause: vi.fn(async ms => { now += ms; }), checkDispatch: vi.fn(async signal => { signal.throwIfAborted(); }),
    checkpoint: vi.fn(async r => { checkpoints.push(r); }), reviewPreflight: vi.fn(async () => true),
    execute: vi.fn(async (caseId, dispatch) => {
      attempts++;
      const count = extra?.(caseId, attempts) ?? (cases.find(c => c.id === caseId)!.terminal === 'proposal' ? 2 : 1);
      for (let i = 0; i < count; i++) await dispatch(new AbortController().signal);
      return recoveryResult(caseId, attempts);
    }),
    capture: vi.fn(async () => ({ chargedMicros: attempts * 100, modelCalls: attempts * 2, totalTokens: attempts * 1000,
      privateUsageComplete: true, usageKnown: true, record: { synthetic: true } })),
  };
  return { ports, checkpoints };
}

test('all thirty slots fit exactly 39 dispatches and preserve history, pending review and zero authority flags', async () => {
  const h = harness();
  vi.mocked(h.ports.reviewPreflight).mockImplementation(async report => {
    expect(report.invocations).toBe(2);
    expect(vi.mocked(h.ports.execute).mock.calls.map(([id]) => id)).toEqual(['unknown-cost', 'no-date']);
    expect(h.checkpoints.at(-1)).toEqual(report);
    return true;
  });
  const report = await runCloudflareGroundedCampaign(h.ports);
  expect(report).toMatchObject({ schemaVersion: 2, stopped: null, maxModelCalls: 210, maxInvocations: 39,
    invocations: 39, cumulativeInvocations: 80, modelCalls: 60, cumulativeModelCalls: 119,
    cumulativeChargedMicros: 401484, cumulativeTokens: null, historicalUnknownReceipts: 2,
    textReview: 'pending', accountingComplete: false, dispatchAuthorized: false, evaluationGatePassed: false });
  expect(h.ports.execute).toHaveBeenCalledTimes(30);
  expect(h.ports.checkDispatch).toHaveBeenCalledTimes(39);
  expect(h.ports.reviewPreflight).toHaveBeenCalledOnce();
  expect(h.checkpoints.every(r => r.invocations <= 39 && r.cumulativeInvocations <= 80)).toBe(true);
  const attempts = report.records.filter((r): r is { round: number; caseId: string } => !!r && typeof r === 'object' && 'evidence' in r);
  expect(new Set(attempts.map(r => `${r.round}:${r.caseId}`)).size).toBe(30);
});

test.each(['unknown-cost', 'no-date', 'ambiguous', 'source-injection', 'locked-budget', 'lookup-timeout', 'impossible'])(
  'blocks an unexpected second dispatch for read-only %s before accounting or request', async target => {
    const h = harness(id => id === target ? 2 : cases.find(c => c.id === id)!.terminal === 'proposal' ? 2 : 1);
    const report = await runCloudflareGroundedCampaign(h.ports);
    expect(report.stopped).toBe('EVAL_INVOCATION_STOP');
    const called = vi.mocked(h.ports.execute).mock.calls.map(([id]) => id);
    expect(called.at(-1)).toBe(target);
    expect(report.invocations).toBe(called.reduce((n, id) => n + (cases.find(c => c.id === id)!.terminal === 'proposal' ? 2 : 1), 0));
    expect(report.records.filter(r => (r as { outcome?: string }).outcome === 'skipped')).toHaveLength(30 - called.length);
  });

test.each(['non-diver', 'free-afternoon', 'more-people'])('blocks a third dispatch for proposal %s', async target => {
  const h = harness(id => id === target ? 3 : cases.find(c => c.id === id)!.terminal === 'proposal' ? 2 : 1);
  const report = await runCloudflareGroundedCampaign(h.ports);
  expect(report.stopped).toBe('EVAL_INVOCATION_STOP');
  expect(vi.mocked(h.ports.execute).mock.calls.at(-1)?.[0]).toBe(target);
});

test.each([false, 'truthy', null])('non-true dual review %s prevents all remaining 28', async decision => {
  const h = harness(); vi.mocked(h.ports.reviewPreflight).mockResolvedValue(decision as boolean);
  const report = await runCloudflareGroundedCampaign(h.ports);
  expect(report.stopped).toBe('PREFLIGHT_TEXT_REVIEW_STOP');
  expect(report.invocations).toBe(2);
  expect(h.ports.execute).toHaveBeenCalledTimes(2);
  expect(report.records.filter(r => (r as { outcome?: string }).outcome === 'skipped')).toHaveLength(28);
});

test.each([['invocations', 39], ['chargedMicros', 0], ['totalTokens', 0], ['historicalUnknownReceipts', 0],
  ['sourceSha256', '0'.repeat(64)], ['dispatchAuthorized', true]])('rejects changed prior %s before all IO', async (key, value) => {
  const h = harness(); Object.assign(h.ports.prior, { [key]: value });
  await expect(runCloudflareGroundedCampaign(h.ports)).rejects.toThrow();
  expect(h.ports.checkpoint).not.toHaveBeenCalled(); expect(h.ports.execute).not.toHaveBeenCalled();
});

test('a failed first preflight stops without reviewing or attempting case two', async () => {
  const h = harness();
  vi.mocked(h.ports.execute).mockImplementationOnce(async (id, dispatch) => {
    await dispatch(new AbortController().signal);
    return recoveryResult(id, 1, { runStatus: 'failed' });
  });
  vi.mocked(h.ports.capture).mockResolvedValue({ chargedMicros: 100, modelCalls: 2, totalTokens: 1000,
    privateUsageComplete: true, usageKnown: true, record: { synthetic: true } });
  const report = await runCloudflareGroundedCampaign(h.ports);
  expect(report.stopped).toBe('FAILED_RUN_STOP');
  expect(h.ports.execute).toHaveBeenCalledOnce(); expect(h.ports.reviewPreflight).not.toHaveBeenCalled();
  expect(report.records.filter(r => (r as { outcome?: string }).outcome === 'skipped')).toHaveLength(29);
});

test('all slots at the per-run maximum total exactly 210 model calls, without extra review calls', async () => {
  const h = harness();
  vi.mocked(h.ports.execute).mockImplementation(async (id, dispatch) => {
    for (let i = 0; i < (cases.find(c => c.id === id)!.terminal === 'proposal' ? 2 : 1); i++) {
      await dispatch(new AbortController().signal);
    }
    return recoveryResult(id, vi.mocked(h.ports.execute).mock.calls.length, { modelCalls: 7 });
  });
  vi.mocked(h.ports.capture).mockImplementation(async () => {
    const attempts = vi.mocked(h.ports.execute).mock.calls.length;
    return { chargedMicros: attempts * 100, modelCalls: attempts * 7, totalTokens: attempts * 1000,
      privateUsageComplete: true, usageKnown: true, record: { synthetic: true } };
  });
  const report = await runCloudflareGroundedCampaign(h.ports);
  expect(report).toMatchObject({ stopped: null, modelCalls: 210, cumulativeModelCalls: 269, invocations: 39 });
  expect(h.ports.execute).toHaveBeenCalledTimes(30);
});

test('a new unknown stops immediately without erasing the two historical unknown receipts', async () => {
  const h = harness();
  vi.mocked(h.ports.capture).mockResolvedValue({ chargedMicros: 100, modelCalls: 2, totalTokens: null,
    privateUsageComplete: true, usageKnown: false, record: { synthetic: true } });
  const report = await runCloudflareGroundedCampaign(h.ports);
  expect(report).toMatchObject({ stopped: 'UNKNOWN_USAGE_STOP', invocations: 1, totalTokens: null,
    cumulativeTokens: null, historicalUnknownReceipts: 2, accountingComplete: false });
  expect(h.ports.execute).toHaveBeenCalledOnce();
  expect(h.ports.reviewPreflight).not.toHaveBeenCalled();
});
