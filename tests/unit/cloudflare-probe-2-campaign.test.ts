import { createHash } from 'node:crypto';
import { expect, test, vi } from 'vitest';
import { runCloudflareProbe2Campaign } from '../../evals/cloudflare-probe-2-campaign.ts';
import { recoveryAccount, recoveryResult } from '../support/cloudflare-recovery-fixture.ts';

const digest = createHash('sha256').update('synthetic first probe report').digest('hex');
const prior = () => ({ sourceSha256: digest, historyConsistent: true as const,
  dispatchAuthorized: false as const, accountingComplete: false as const,
  evaluationGatePassed: false as const, historicalUnknownReceipts: 5 as const,
  invocations: 45 as const, modelCalls: 67 as const, chargedMicros: 949683 as const,
  observedTokens: 285297 as const, totalTokens: null,
  remainingInvocationCeiling: 55 as const, remainingReferenceMicros: 2050317 as const });

function harness(usageKnown = true) {
  let now = 0;
  const ports: Parameters<typeof runCloudflareProbe2Campaign>[0] = {
    accountId: recoveryAccount, prior: prior(), now: () => now,
    pause: vi.fn(async ms => { now += ms; }),
    checkDispatch: vi.fn(async signal => { signal.throwIfAborted(); }),
    checkpoint: vi.fn(async () => {}),
    execute: vi.fn(async (caseId, dispatch) => {
      await dispatch(new AbortController().signal);
      return recoveryResult(caseId, 1, usageKnown ? {} : { usageComplete: false, costMicros: null });
    }),
    capture: vi.fn(async () => ({ chargedMicros: usageKnown ? 100 : 183505,
      modelCalls: 2, totalTokens: usageKnown ? 1000 : null,
      privateUsageComplete: true, usageKnown, record: { synthetic: true } })),
  };
  return ports;
}

test('new Free-only scope sends one case and does not claim the quality gate', async () => {
  const ports = harness();
  const report = await runCloudflareProbe2Campaign(ports);
  expect(report).toMatchObject({ stopped: null, diagnosticComplete: true, maxInvocations: 1,
    maxModelCalls: 7, invocations: 1, cumulativeInvocations: 46, modelCalls: 2,
    cumulativeModelCalls: 69, historicalUnknownReceipts: 5,
    evaluationGatePassed: false, accountingComplete: false, dispatchAuthorized: false });
  expect(ports.execute).toHaveBeenCalledExactlyOnceWith('unknown-cost', expect.any(Function));
  expect(ports.checkDispatch).toHaveBeenCalledOnce();
});

test('a new unknown stops and conservatively charges the single case', async () => {
  const ports = harness(false);
  const report = await runCloudflareProbe2Campaign(ports);
  expect(report).toMatchObject({ stopped: 'UNKNOWN_USAGE_STOP', diagnosticComplete: false,
    invocations: 1, cumulativeInvocations: 46, totalTokens: null,
    cumulativeTokens: null, evaluationGatePassed: false });
  expect(ports.execute).toHaveBeenCalledOnce();
});

test('tampered prior history denies dispatch', async () => {
  const ports = harness();
  Object.assign(ports.prior, { modelCalls: 66 });
  await expect(runCloudflareProbe2Campaign(ports)).rejects.toThrow();
  expect(ports.execute).not.toHaveBeenCalled();
  expect(ports.checkpoint).not.toHaveBeenCalled();
});
