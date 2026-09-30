import { createHash } from 'node:crypto';
import { expect, test, vi } from 'vitest';
import { runCloudflareProbe4Campaign } from '../../evals/cloudflare-probe-4-campaign.ts';
import { recoveryAccount, recoveryResult } from '../support/cloudflare-recovery-fixture.ts';

const digest = createHash('sha256').update('synthetic first probe report').digest('hex');
const prior = () => ({ sourceSha256: digest, historyConsistent: true as const,
  dispatchAuthorized: false as const, accountingComplete: false as const,
  evaluationGatePassed: false as const, historicalUnknownReceipts: 6 as const,
  invocations: 48 as const, modelCalls: 72 as const, chargedMicros: 1133641 as const,
  observedTokens: 291929 as const, totalTokens: null,
  remainingInvocationCeiling: 52 as const, remainingReferenceMicros: 1866359 as const });

function harness(usageKnown = true) {
  let now = 0;
  const ports: Parameters<typeof runCloudflareProbe4Campaign>[0] = {
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
  const report = await runCloudflareProbe4Campaign(ports);
  expect(report).toMatchObject({ stopped: null, diagnosticComplete: true, maxInvocations: 1,
    maxModelCalls: 7, invocations: 1, cumulativeInvocations: 49, modelCalls: 2,
    cumulativeModelCalls: 74, historicalUnknownReceipts: 6,
    evaluationGatePassed: false, accountingComplete: false, dispatchAuthorized: false });
  expect(ports.execute).toHaveBeenCalledExactlyOnceWith('unknown-cost', expect.any(Function));
  expect(ports.checkDispatch).toHaveBeenCalledOnce();
});

test('a new unknown stops and conservatively charges the single case', async () => {
  const ports = harness(false);
  const report = await runCloudflareProbe4Campaign(ports);
  expect(report).toMatchObject({ stopped: 'UNKNOWN_USAGE_STOP', diagnosticComplete: false,
    invocations: 1, cumulativeInvocations: 49, totalTokens: null,
    cumulativeTokens: null, evaluationGatePassed: false });
  expect(ports.execute).toHaveBeenCalledOnce();
});

test('tampered prior history denies dispatch', async () => {
  const ports = harness();
  Object.assign(ports.prior, { modelCalls: 67 });
  await expect(runCloudflareProbe4Campaign(ports)).rejects.toThrow();
  expect(ports.execute).not.toHaveBeenCalled();
  expect(ports.checkpoint).not.toHaveBeenCalled();
});
