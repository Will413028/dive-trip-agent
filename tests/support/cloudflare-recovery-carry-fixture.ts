import { REVISION_REPORT_SHA256 } from '../../evals/cloudflare-artifacts';
import type { CloudflareUsageEvidence } from '../../evals/usage-evidence';
import { qualityCarryFixture, syntheticId, type QualityAudit, type QualityEvent } from './cloudflare-quality-carry-fixture';

/** Synthetic legacy evidence only; no artifact, filesystem or database reads.
 * Expected token totals and per-call costs are independent fixture arithmetic. */
export function recoveryCarryFixture() {
  const template = qualityCarryFixture().snapshot.usage[0];
  const prior = { sourceSha256: REVISION_REPORT_SHA256(), historyConsistent: true, dispatchAuthorized: false,
    accountingComplete: false, evaluationGatePassed: false, historicalUnknownReceipts: 2,
    invocations: 39, modelCalls: 56, chargedMicros: 396708, observedTokens: 259078,
    totalTokens: null, remainingInvocationCeiling: 61, remainingReferenceMicros: 2603292 };
  const cases = ['unknown-cost', 'no-date'];
  const runs = cases.map((caseId, i) => ({ id: syntheticId(600 + i), status: 'succeeded',
    proposal_id: null as string | null, interrupt_id: null as string | null, decision: null as boolean | null,
    trip_id: syntheticId(610 + i), owner_id: syntheticId(620 + i), current_version: 1,
    snapshot: { label: `synthetic-${caseId}`, requirements: { divers: i + 1 }, entries: [] as unknown[] } }));
  const tokens = [
    [{ promptTokens: 4000, outputTokens: 500, totalTokens: 4500 },
      { promptTokens: 3574, outputTokens: 1177, totalTokens: 4751 }], // 550 + 711 = 1261
    [{ promptTokens: 3643, outputTokens: 501, totalTokens: 4144 }], // 515
  ];
  const usage: CloudflareUsageEvidence[] = runs.map((run, i) => {
    const invocation = { ...structuredClone(template.invocations[0]), id: syntheticId(630 + i),
      reservation_id: syntheticId(640 + i), run_id: run.id, logical_run_id: run.id,
      kind: 'start' as const, max_cost_micros: '183505', charged_cost_micros: i === 0 ? '1261' : '515',
      actual_cost_micros: i === 0 ? '1261' : '515' };
    return { schemaVersion: 2, runId: run.id, binding: structuredClone(template.binding), invocations: [invocation],
      calls: tokens[i].map((value, j) => ({ ...structuredClone(template.calls[0]), run_id: run.id,
        invocation_id: invocation.id, call_id: `recovery-${i}-${j}`, usage: value })) };
  });
  const events: QualityEvent[] = runs.flatMap((run, i) => Array.from({ length: i === 0 ? 9 : 5 }, (_, j) => ({
    run_id: run.id, sequence: j + 1,
    event: j === 0 || j === (i === 0 ? 8 : 4)
      ? { type: j === 0 ? 'RUN_STARTED' : 'RUN_FINISHED', threadId: run.trip_id, runId: syntheticId(650 + i) }
      : { type: 'CUSTOM', name: 'synthetic-event', value: `recovery-${i}-${j}` },
  })));
  const attempts = runs.map((run, i) => ({ round: 1, caseId: cases[i], outcome: 'completed',
    evidence: { caseId: cases[i], runId: run.id, before: structuredClone(run.snapshot), beforeDecision: structuredClone(run.snapshot),
      after: structuredClone(run.snapshot), beforeVersion: 1, beforeDecisionVersion: 1, afterVersion: 1,
      terminal: 'clarification', runStatus: 'succeeded', decision: 'none', proposalId: null as string | null,
      decisionRunId: null as string | null, decisionProposalId: null as string | null, model: template.binding.model,
      usageRunId: run.id, usageComplete: true, modelCalls: i === 0 ? 2 : 1, costMicros: i === 0 ? 1261 : 515, textReview: 'pending' },
    events: structuredClone(events.filter(e => e.run_id === run.id).map(e => e.event)) }));
  const audits: QualityAudit[] = runs.map((run, i) => {
    const { id, status, proposal_id, interrupt_id, decision } = run;
    return { kind: 'durable-audit', round: 1, caseId: cases[i], runs: [{ id, status, proposal_id, interrupt_id, decision }],
      events: structuredClone(events.filter(e => e.run_id === id)), privateUsage: [structuredClone(usage[i])],
      chargedMicros: i === 0 ? 1261 : 1776, privateUsageComplete: true, quiescent: true };
  });
  const allCases = ['ambiguous', 'non-diver', 'locked-budget', 'free-afternoon', 'more-people',
    'unknown-cost', 'no-date', 'source-injection', 'lookup-timeout', 'impossible'];
  const skips = [1, 2, 3].flatMap(round => allCases.filter(caseId => round !== 1 || !cases.includes(caseId))
    .map(caseId => ({ round, caseId, outcome: 'skipped', reason: 'PREFLIGHT_TEXT_REVIEW_STOP' })));
  const records: (typeof attempts[number] | QualityAudit | typeof skips[number])[] = [attempts[0], audits[0], attempts[1], audits[1], ...skips];
  const report = { model: template.binding.model, accountId: template.binding.accountId,
    transport: 'real-cloudflare-via-http-handler', budgetMicros: 3000000, maxModelCalls: 210, maxInvocations: 60, prior: structuredClone(prior),
    stopped: 'PREFLIGHT_TEXT_REVIEW_STOP', textReview: 'pending', evaluationGatePassed: false, accountingComplete: false,
    historicalUnknownReceipts: 2, dispatchAuthorized: false, invocations: 2, modelCalls: 3, chargedMicros: 1776,
    totalTokens: 13395, cumulativeInvocations: 41, cumulativeModelCalls: 59, cumulativeChargedMicros: 398484, cumulativeTokens: null, records };
  return { prior, report, snapshot: { counts: { runs: 2, trips: 2, invocations: 2, calls: 3, reservations: 2, proposals: 0 }, runs, events, usage } };
}

export type RecoveryCarryFixture = ReturnType<typeof recoveryCarryFixture>;
export const recoveryAudits = (f: RecoveryCarryFixture) => f.report.records.filter((r): r is QualityAudit => 'kind' in r && r.kind === 'durable-audit');
export const recoveryAttempts = (f: RecoveryCarryFixture) => f.report.records.filter(r => 'evidence' in r);
