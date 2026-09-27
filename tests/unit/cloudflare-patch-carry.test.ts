import { beforeEach, expect, test, vi } from 'vitest';
import type { Pool } from 'pg';
import type { EvaluationLockLease } from '../../evals/live-evaluation-lock';
import { fixture } from '../support/cloudflare-carry-fixture';
const state = vi.hoisted(() => ({ report: {} as unknown, historyReads: 0, reads: 0, locks: 0, mode: '' }));
const prior = { sourceSha256: '491ffcaccdb30045113dcbc78e511d25e56e6e79faa82cbf0bd705df51e0786b',
  historyConsistent: true, dispatchAuthorized: false, accountingComplete: false, evaluationGatePassed: false,
  historicalUnknownReceipts: 1, invocations: 9, modelCalls: 12, chargedMicros: 188948, observedTokens: 51739,
  totalTokens: null, remainingInvocationCeiling: 91, remainingReferenceMicros: 2811052 };
vi.mock('../../evals/cloudflare-carry-forward-2', () => ({ readCloudflareSecondCarryForward: async () => {
  state.historyReads++;
  if (state.mode === 'old-history' && state.historyReads === 2) throw new Error('private');
  return structuredClone(prior);
} }));
vi.mock('../../evals/live-evaluation-lock', () => ({ assertEvaluationLock: async () => {
  state.locks++; if (state.mode === 'lease') throw new Error('private');
} }));
vi.mock('../../evals/pinned-cloudflare-report', () => ({
  PATCH_REPORT_SHA256: () => '3cd0ada7274e15b4c1813b884c0e0a8a7d1ebc277b3f1c0337c00abf5269248d',
  readPinnedCloudflareReport: async (kind: string) => {
    expect(kind).toBe('patch'); state.reads++;
    if (state.mode === 'hash' || (state.mode === 'export-changed' && state.reads === 2)) throw new Error('private');
    return structuredClone(state.report);
  },
}));
import { readCloudflarePatchCarry } from '../../evals/cloudflare-patch-carry';

function reportFixture() {
  const usage = structuredClone(fixture().snapshot.usage[0]);
  const runId = '4d420bb9-704b-4463-8f94-398065919454', invocationId = '30110afd-0f5b-4d53-8c71-6742d1e2ea9d';
  usage.runId = runId;
  Object.assign(usage.invocations[0], { id: invocationId, run_id: runId, logical_run_id: runId,
    actual_cost_micros: '1119', charged_cost_micros: '1119' });
  Object.assign(usage.calls[0], { invocation_id: invocationId, run_id: runId,
    usage: { promptTokens: 4226, outputTokens: 781, totalTokens: 5007 } });
  usage.calls.push({ ...structuredClone(usage.calls[0]), call_id: 'second-call',
    usage: { promptTokens: 4363, outputTokens: 83, totalTokens: 4446 } });
  return { model: usage.binding.model, accountId: usage.binding.accountId, prior: structuredClone(prior),
    stopped: null, textReview: 'pending', evaluationGatePassed: false, accountingComplete: false,
    historicalUnknownReceipts: 1, dispatchAuthorized: false, invocations: 1, modelCalls: 2,
    chargedMicros: 1119, totalTokens: 9453, cumulativeInvocations: 10, cumulativeModelCalls: 14,
    cumulativeChargedMicros: 190067, cumulativeTokens: null, records: [null, { kind: 'durable-audit',
      caseId: 'locked-budget', round: 1, chargedMicros: 1119, privateUsageComplete: true, quiescent: true,
      runs: [{ id: runId, status: 'succeeded', proposal_id: null, interrupt_id: null, decision: null }],
      privateUsage: [usage] }] };
}
beforeEach(() => Object.assign(state, { report: reportFixture(), historyReads: 0, reads: 0, locks: 0, mode: '' }));
const read = () => readCloudflarePatchCarry({} as Pool, {} as Pool, {} as Pool, {} as EvaluationLockLease);
test('adds the immutable successful export without claiming its cleaned DB was re-audited', async () => {
  expect(await read()).toMatchObject({ historyConsistent: true, invocations: 10, modelCalls: 14,
    chargedMicros: 190067, observedTokens: 61192, totalTokens: null, accountingComplete: false,
    evaluationGatePassed: false, dispatchAuthorized: false, historicalUnknownReceipts: 1 });
  expect(state.historyReads).toBe(2); expect(state.reads).toBe(2);
});
test.each(['old-history', 'hash', 'export-changed', 'lease'])('rejects %s with sanitized error', async mode => {
  state.mode = mode; await expect(read()).rejects.toThrow('CLOUDFLARE_PATCH_CARRY_INVALID');
});
test.each(['prior', 'cost', 'tokens', 'call-binding', 'unknown', 'extra-call', 'run', 'gate'])(
  'rejects export contract change: %s', async mode => {
    const r = reportFixture(), audit = r.records[1]!;
    if (mode === 'prior') r.prior.invocations++;
    if (mode === 'cost') r.cumulativeChargedMicros--;
    if (mode === 'tokens') audit.privateUsage[0].calls[0].usage!.totalTokens++;
    if (mode === 'call-binding') audit.privateUsage[0].calls[0].invocation_id = 'foreign';
    if (mode === 'unknown') audit.privateUsage[0].invocations[0].actual_cost_micros = null;
    if (mode === 'extra-call') audit.privateUsage[0].calls.push(audit.privateUsage[0].calls[0]);
    if (mode === 'run') audit.runs[0].id = 'foreign';
    if (mode === 'gate') r.evaluationGatePassed = true;
    state.report = r; await expect(read()).rejects.toThrow('CLOUDFLARE_PATCH_CARRY_INVALID');
  });
