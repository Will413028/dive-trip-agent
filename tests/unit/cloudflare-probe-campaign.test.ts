import { createHash } from 'node:crypto';
import { expect, test, vi } from 'vitest';
import { runCloudflareProbeCampaign } from '../../evals/cloudflare-probe-campaign.ts';
import { recoveryAccount, recoveryResult } from '../support/cloudflare-recovery-fixture.ts';

const digest = createHash('sha256').update('synthetic Python diagnostic report').digest('hex');
const prior = () => ({ sourceSha256: digest, historyConsistent: true as const,
  dispatchAuthorized: false as const, accountingComplete: false as const,
  evaluationGatePassed: false as const, historicalUnknownReceipts: 5 as const,
  invocations: 44 as const, modelCalls: 63 as const, chargedMicros: 948999 as const,
  observedTokens: 279171 as const, totalTokens: null,
  remainingInvocationCeiling: 56 as const, remainingReferenceMicros: 2051001 as const });

function harness(usageKnown = true) {
  let now = 0;
  const checkpoints: unknown[] = [];
  const ports: Parameters<typeof runCloudflareProbeCampaign>[0] = {
    accountId: recoveryAccount, prior: prior(), now: () => now,
    pause: vi.fn(async ms => { now += ms; }),
    checkDispatch: vi.fn(async signal => { signal.throwIfAborted(); }),
    checkpoint: vi.fn(async report => { checkpoints.push(structuredClone(report)); }),
    execute: vi.fn(async (caseId, dispatch) => {
      await dispatch(new AbortController().signal);
      return recoveryResult(caseId, 1, usageKnown ? {} : { usageComplete: false, costMicros: null });
    }),
    capture: vi.fn(async () => ({ chargedMicros: usageKnown ? 100 : 183505,
      modelCalls: 2, totalTokens: usageKnown ? 1000 : null,
      privateUsageComplete: true, usageKnown, record: { synthetic: true } })),
  };
  return { ports, checkpoints };
}

test('one Free-only diagnostic start retains success evidence without claiming quality', async () => {
  const h = harness();
  const report = await runCloudflareProbeCampaign(h.ports);
  expect(report).toMatchObject({ stopped: null, diagnosticComplete: true, maxInvocations: 1,
    maxModelCalls: 7, invocations: 1, cumulativeInvocations: 45, modelCalls: 2,
    cumulativeModelCalls: 65, historicalUnknownReceipts: 5,
    evaluationGatePassed: false, accountingComplete: false, dispatchAuthorized: false });
  expect(h.ports.execute).toHaveBeenCalledExactlyOnceWith('unknown-cost', expect.any(Function));
  expect(h.ports.checkDispatch).toHaveBeenCalledOnce();
  expect(h.checkpoints.at(-1)).toEqual(report);
});

test('a new unknown stops the single case and preserves conservative accounting', async () => {
  const h = harness(false);
  const report = await runCloudflareProbeCampaign(h.ports);
  expect(report).toMatchObject({ stopped: 'UNKNOWN_USAGE_STOP', diagnosticComplete: false, invocations: 1,
    cumulativeInvocations: 45, modelCalls: 2, totalTokens: null,
    cumulativeTokens: null, historicalUnknownReceipts: 5, evaluationGatePassed: false });
  expect(h.ports.execute).toHaveBeenCalledOnce();
});

test.each(['invocations', 'modelCalls', 'chargedMicros', 'historicalUnknownReceipts',
  'dispatchAuthorized', 'totalTokens'] as const)('altered prior %s stops before a checkpoint or dispatch', async key => {
  const h = harness();
  Object.assign(h.ports.prior, { [key]: key === 'dispatchAuthorized' ? true : key === 'totalTokens' ? 0 : 0 });
  await expect(runCloudflareProbeCampaign(h.ports)).rejects.toThrow();
  expect(h.ports.execute).not.toHaveBeenCalled();
  expect(h.ports.checkpoint).not.toHaveBeenCalled();
});
