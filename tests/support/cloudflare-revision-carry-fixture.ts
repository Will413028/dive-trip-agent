import { QUALITY_REPORT_SHA256 } from '../../evals/cloudflare-artifacts';
import type { CloudflareUsageEvidence } from '../../evals/usage-evidence';
import { qualityCarryFixture, syntheticId, type QualityAudit, type QualityAttempt } from './cloudflare-quality-carry-fixture';

/** Synthetic evidence only: no filesystem or real artifacts. Only the unknown
 * identity is fixed by the historical contract, not copied from a live payload. */
export function revisionCarryFixture() {
  const template = qualityCarryFixture();
  const prior = { sourceSha256: QUALITY_REPORT_SHA256(), historyConsistent: true, dispatchAuthorized: false,
    accountingComplete: false, evaluationGatePassed: false, historicalUnknownReceipts: 1,
    invocations: 26, modelCalls: 38, chargedMicros: 204816, observedTokens: 183791,
    totalTokens: null, remainingInvocationCeiling: 74, remainingReferenceMicros: 2795184 };
  const runs = template.snapshot.runs.slice(0, 9);
  Object.assign(runs[3], { proposal_id: syntheticId(103), interrupt_id: 'synthetic-interrupt-3', decision: true, current_version: 2 });
  Object.assign(runs[8], { id: '33bf833b-e2c9-4f3c-8dea-d016ca87678c', status: 'failed' });
  const callsPerRun = [3, 3, 3, 3, 2, 1, 1, 1, 1];
  const usage: CloudflareUsageEvidence[] = runs.map((run, i) => {
    const invocationId = (j: number) => i === 8 ? '37005f83-b2f9-4c29-883f-a704c3e9a140' : syntheticId(400 + i * 2 + j);
    const calls = Array.from({ length: callsPerRun[i] }, (_, j) => ({ ...structuredClone(template.snapshot.usage[0].calls[0]),
      run_id: run.id, invocation_id: invocationId(i < 4 && j === 2 ? 1 : 0), call_id: `revision-${i}-${j}`,
      // 16 * 480 + 707 = 8387 known micros; all 18 calls observe 75287 tokens.
      usage: i === 8 ? { promptTokens: 5000, outputTokens: 397, totalTokens: 5397 }
        : i === 7 ? { promptTokens: 5300, outputTokens: 590, totalTokens: 5890 }
          : { promptTokens: 3600, outputTokens: 400, totalTokens: 4000 } }));
    const invocations = Array.from({ length: i < 4 ? 2 : 1 }, (_, j) => {
      const id = invocationId(j), amount = String(calls.filter(c => c.invocation_id === id).length * (i === 7 ? 707 : 480));
      return { ...structuredClone(template.snapshot.usage[0].invocations[0]), id, run_id: run.id, logical_run_id: run.id,
        reservation_id: i === 8 ? '23b8edaf-9159-44a1-8355-b7002bd1ce49' : syntheticId(500 + i * 2 + j),
        kind: j === 0 ? 'start' as const : 'resume' as const, max_cost_micros: '183505',
        charged_cost_micros: i === 8 ? '183505' : amount, actual_cost_micros: i === 8 ? null : amount };
    });
    return { schemaVersion: 2, runId: run.id, binding: structuredClone(template.snapshot.usage[0].binding), invocations, calls };
  });
  const events = runs.flatMap((run, i) => Array.from({ length: i === 8 ? 14 : 9 }, (_, j) => ({
    run_id: run.id, sequence: j + 1, event: j === 0 ? { type: 'RUN_STARTED', threadId: run.trip_id, runId: run.id }
      : { type: j === (i === 8 ? 13 : 8) ? (i === 8 ? 'RUN_ERROR' : 'RUN_FINISHED') : 'CUSTOM', value: `revision-${i}-${j}` },
  })));
  let charged = 0;
  type Skip = { round: number; caseId: string; outcome: string; reason: string };
  const records: (QualityAttempt | QualityAudit | Skip)[] = runs.flatMap((run, i) => {
    charged += usage[i].invocations.reduce((sum, receipt) => sum + Number(receipt.charged_cost_micros), 0);
    const { id, status, proposal_id, interrupt_id, decision } = run, round = i === 0 ? 0 : 1, caseId = `revision-case-${i}`;
    return [
      { kind: 'attempt' as const, round, caseId, evidence: { runId: id, afterVersion: run.current_version, after: structuredClone(run.snapshot) } },
      { kind: 'durable-audit' as const, round, caseId, runs: [{ id, status, proposal_id, interrupt_id, decision }],
        events: structuredClone(events.filter(e => e.run_id === id)), privateUsage: [structuredClone(usage[i])],
        chargedMicros: charged, privateUsageComplete: true, quiescent: true },
    ];
  });
  records.push(...Array.from({ length: 22 }, (_, i) => ({ round: i < 2 ? 1 : i < 12 ? 2 : 3,
    caseId: `revision-skip-${i}`, outcome: 'skipped', reason: 'UNKNOWN_USAGE_STOP' })));
  const report = { model: usage[0].binding.model, accountId: usage[0].binding.accountId, prior: structuredClone(prior),
    stopped: 'UNKNOWN_USAGE_STOP', textReview: 'pending', evaluationGatePassed: false, accountingComplete: false,
    historicalUnknownReceipts: 1, dispatchAuthorized: false, invocations: 13, modelCalls: 18, chargedMicros: 191892,
    totalTokens: null, cumulativeInvocations: 39, cumulativeModelCalls: 56, cumulativeChargedMicros: 396708, cumulativeTokens: null, records };
  return { prior, report, snapshot: { counts: { runs: 9, trips: 9, invocations: 13, calls: 18, reservations: 13, proposals: 4 }, runs, events, usage } };
}

export type RevisionCarryFixture = ReturnType<typeof revisionCarryFixture>;
export const revisionAudits = (f: RevisionCarryFixture) => f.report.records.filter((r): r is QualityAudit => 'kind' in r && r.kind === 'durable-audit');
export const revisionAttempts = (f: RevisionCarryFixture) => f.report.records.filter((r): r is QualityAttempt => 'kind' in r && r.kind === 'attempt');
