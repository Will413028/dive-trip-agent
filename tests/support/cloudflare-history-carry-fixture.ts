import { fixture as firstFixture } from './cloudflare-carry-fixture';
import { FIRST_REPORT_SHA256, SECOND_REPORT_SHA256 } from '../../evals/cloudflare-artifacts';
import { compareCloudflareCarryForward } from '../../evals/cloudflare-carry-forward';
import { compareCloudflareSecondCarryForward } from '../../evals/cloudflare-carry-forward-2';

export function historyFixture() {
  const first = firstFixture();
  const firstPrior = { ...compareCloudflareCarryForward(first.report, first.baseline, first.snapshot), sourceSha256: FIRST_REPORT_SHA256() };
  const runId = 'cd18d166-fc0a-4f05-8ecc-751ed9577ae6';
  const run = { id: runId, status: 'failed', proposal_id: null, interrupt_id: null, decision: null };
  const usage = structuredClone(first.snapshot.usage[0]);
  usage.runId = runId;
  Object.assign(usage.invocations[0], { run_id: runId, logical_run_id: runId, charged_cost_micros: '681', actual_cost_micros: '681' });
  Object.assign(usage.calls[0], { run_id: runId, usage: { promptTokens: 4208, outputTokens: 866, totalTokens: 5074 } });
  const events = [{ run_id: runId, sequence: 1, event: { type: 'RUN_STARTED' } },
    { run_id: runId, sequence: 2, event: { type: 'RUN_ERROR' } }];
  const audit = { kind: 'durable-audit', caseId: 'locked-budget', round: 1, chargedMicros: 681,
    runs: [run], events, privateUsage: [usage], privateUsageComplete: true, quiescent: true };
  const report = { model: usage.binding.model, accountId: usage.binding.accountId, prior: firstPrior,
    stopped: 'FAILED_RUN_STOP', textReview: 'pending', evaluationGatePassed: false, accountingComplete: false,
    dispatchAuthorized: false, historicalUnknownReceipts: 1, chargedMicros: 681, invocations: 1, modelCalls: 1,
    totalTokens: 5074, cumulativeChargedMicros: 188948, cumulativeInvocations: 9, cumulativeModelCalls: 12,
    cumulativeTokens: null, records: [audit, ...Array(8).fill(null)] };
  const snapshot = { counts: { runs: 1, trips: 1, invocations: 1, calls: 1, reservations: 1, proposals: 0 },
    runs: [{ ...run, trip_id: 'ab07e87b-5a3f-4172-8624-7ffee813910e', owner_id: 'd73d8d06-7154-4962-89e4-c14d25b9e317', current_version: 1 }],
    events: structuredClone(events), usage: [structuredClone(usage)] };
  const prior = { ...compareCloudflareSecondCarryForward(report, firstPrior, snapshot), sourceSha256: SECOND_REPORT_SHA256() };
  const patchUsage = structuredClone(first.snapshot.usage[0]);
  const patchRun = '4d420bb9-704b-4463-8f94-398065919454', invocationId = '30110afd-0f5b-4d53-8c71-6742d1e2ea9d';
  patchUsage.runId = patchRun;
  Object.assign(patchUsage.invocations[0], { id: invocationId, run_id: patchRun, logical_run_id: patchRun,
    charged_cost_micros: '1119', actual_cost_micros: '1119' });
  Object.assign(patchUsage.calls[0], { invocation_id: invocationId, run_id: patchRun,
    usage: { promptTokens: 4226, outputTokens: 781, totalTokens: 5007 } });
  patchUsage.calls.push({ ...structuredClone(patchUsage.calls[0]), call_id: 'patch-second',
    usage: { promptTokens: 4363, outputTokens: 83, totalTokens: 4446 } });
  const patch = { ...report, prior, stopped: null, chargedMicros: 1119, modelCalls: 2, totalTokens: 9453,
    cumulativeChargedMicros: 190067, cumulativeInvocations: 10, cumulativeModelCalls: 14,
    records: [null, { ...audit, chargedMicros: 1119, runs: [{ ...run, id: patchRun, status: 'succeeded' }], privateUsage: [patchUsage] }] };
  return { first, second: { report, snapshot }, patch, prior };
}
