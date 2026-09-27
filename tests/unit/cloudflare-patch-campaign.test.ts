import { expect, test, vi } from 'vitest';
import { runCloudflarePatchCampaign, type PatchCampaignReport } from '../../evals/cloudflare-patch-campaign';
import { evaluationInput } from '../../evals/fixtures';
import { gradeEvidenceV2 as gradeEvidence, type RunEvidenceV2 as RunEvidence } from '../../evals/evidence';
import { CLOUDFLARE_MODEL } from '../../src/agent/cloudflare-wire';

vi.mock('../../evals/cloudflare-carry-forward-2', () => { throw new Error('NO_HISTORY_IO'); });
type Ports = Parameters<typeof runCloudflarePatchCampaign>[0];
const prior = {
  sourceSha256: '491ffcaccdb30045113dcbc78e511d25e56e6e79faa82cbf0bd705df51e0786b',
  historyConsistent: true, dispatchAuthorized: false, accountingComplete: false, evaluationGatePassed: false,
  historicalUnknownReceipts: 1, invocations: 9, modelCalls: 12, chargedMicros: 188948,
  observedTokens: 51739, totalTokens: null, remainingInvocationCeiling: 91, remainingReferenceMicros: 2811052,
} as const;
function harness(patch: Partial<RunEvidence> = {}) {
  const input = evaluationInput('locked-budget');
  const evidence: RunEvidence = {
    caseId: 'locked-budget', inputDigest: input.digest, runId: 'synthetic', usageRunId: 'synthetic',
    before: input.before, beforeDecision: structuredClone(input.before), after: structuredClone(input.before),
    beforeVersion: 1, beforeDecisionVersion: 1, afterVersion: 1, terminal: 'blocked', runStatus: 'succeeded',
    decision: 'none', proposalId: null, decisionRunId: null, decisionProposalId: null,
    model: CLOUDFLARE_MODEL, usageComplete: true, modelCalls: 2, toolCount: 1, visibleToolCount: 0, costMicros: 100,
    latencyMs: 1000, textReview: 'pending', faultObserved: null, ...patch,
  };
  let time = 0;
  const snapshots: PatchCampaignReport[] = [];
  const ports = {
    accountId: '1fd574e905257afa3cfd7db80cf70b23', prior: { ...prior }, now: () => time,
    pause: vi.fn(async (ms: number) => { time += ms; }),
    checkpoint: vi.fn(async (report: PatchCampaignReport) => { snapshots.push(report); }),
    execute: vi.fn(async (_id: string, dispatch: Parameters<Ports['execute']>[1]) => {
      await dispatch(new AbortController().signal);
      expect(snapshots.at(-1)?.invocations).toBe(1);
      return { schemaVersion: 2 as const, evidence, events: [], grade: gradeEvidence(evidence, CLOUDFLARE_MODEL) };
    }),
    capture: vi.fn(async () => ({ chargedMicros: 100, modelCalls: evidence.modelCalls,
      totalTokens: 1000 as number | null, usageKnown: true, privateUsageComplete: true, record: {} })),
  } satisfies Ports;
  return { ports, snapshots };
}
test('one fixed case, seven-call ceiling, prior carry and durable dispatch; no aggregate quality promotion', async () => {
  const h = harness({ modelCalls: 7 });
  const r = await runCloudflarePatchCampaign(h.ports);
  expect(h.ports.execute.mock.calls.map(([id]) => id)).toEqual(['locked-budget']);
  expect(h.ports.pause.mock.calls).toEqual([[15000, expect.any(AbortSignal)]]);
  expect(h.snapshots.every(saved => saved.schemaVersion === 2)).toBe(true);
  expect(r).toMatchObject({ schemaVersion: 2, stopped: null, maxModelCalls: 7, maxInvocations: 2, modelCalls: 7,
    cumulativeModelCalls: 19, cumulativeInvocations: 10, cumulativeChargedMicros: 189048,
    cumulativeTokens: null, accountingComplete: false, historicalUnknownReceipts: 1,
    dispatchAuthorized: false, evaluationGatePassed: false, textReview: 'pending' });
});
test.each(Object.keys(prior))('changed history %s blocks before any ports', async key => {
  const h = harness(); Object.assign(h.ports.prior, { [key]: 'invalid' });
  await expect(runCloudflarePatchCampaign(h.ports)).rejects.toThrow('EVAL_INVALID_HISTORY');
  expect(h.ports.execute).not.toHaveBeenCalled(); expect(h.ports.checkpoint).not.toHaveBeenCalled();
});
test.each([
  [{ runStatus: 'failed' }, 'FAILED_RUN_STOP'], [{ usageComplete: false }, 'UNKNOWN_USAGE_STOP'],
  [{ latencyMs: 60000 }, 'DEADLINE_STOP'], [{ caseId: 'non-diver' }, 'EVAL_EVIDENCE_STOP'],
] satisfies [Partial<RunEvidence>, string][])('stops without retry for %j', async (patch, stopped) => {
  const h = harness(patch);
  expect(await runCloudflarePatchCampaign(h.ports)).toMatchObject({ stopped });
  expect(h.ports.execute).toHaveBeenCalledTimes(1); expect(h.ports.capture).toHaveBeenCalledTimes(1);
});
test('eight calls fails capture and keeps failure checkpoint', async () => {
  const h = harness({ modelCalls: 8 });
  await expect(runCloudflarePatchCampaign(h.ports)).rejects.toThrow('EVAL_PRIVATE_USAGE_EXPORT_FAILED');
  expect(h.snapshots.at(-1)?.stopped).toBe('EVIDENCE_EXPORT_STOP');
  expect(h.ports.execute).toHaveBeenCalledTimes(1);
});
test('history gate denial prevents dispatch and does not retry', async () => {
  const h = harness();
  h.ports.capture.mockResolvedValue({ chargedMicros: 0, modelCalls: 0, totalTokens: 0,
    usageKnown: true, privateUsageComplete: true, record: {} });
  const r = await runCloudflarePatchCampaign({ ...h.ports, checkDispatch: async () => { throw new Error('EVAL_HISTORY_CHANGED'); } });
  expect(r).toMatchObject({ stopped: 'EVAL_HISTORY_CHANGED', invocations: 0 });
  expect(h.ports.execute).toHaveBeenCalledTimes(1);
});
