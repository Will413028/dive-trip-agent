import { GROUNDED_REPORT_SHA256 } from '../../evals/cloudflare-artifacts';
import type { CloudflareUsageEvidence } from '../../evals/usage-evidence';
import { recoveryCarryFixture } from './cloudflare-recovery-carry-fixture';
import { syntheticId, type QualityEvent } from './cloudflare-quality-carry-fixture';

/** Synthetic payloads, not a copy/read of a private artifact. Only the closed
 * historical run/trip identities and accounting facts match the audit contract. */
export function nonthinkingCarryFixture() {
  const prior = { sourceSha256: GROUNDED_REPORT_SHA256(), historyConsistent: true, dispatchAuthorized: false,
    accountingComplete: false, evaluationGatePassed: false, historicalUnknownReceipts: 3,
    invocations: 42, modelCalls: 60, chargedMicros: 581989, observedTokens: 277874,
    totalTokens: null, remainingInvocationCeiling: 58, remainingReferenceMicros: 2418011 };
  const template = recoveryCarryFixture().snapshot.usage[0];
  const run = { id: '1c18c417-145e-45ef-8e4a-64931326498f', status: 'failed',
    proposal_id: null as string | null, interrupt_id: null as string | null, decision: null as boolean | null,
    trip_id: '6c119e67-05b6-49f6-88b1-de5530d8504f', owner_id: syntheticId(800), current_version: 1,
    snapshot: { requirements: { divers: 1 }, entries: [], label: 'synthetic-nonthinking-unknown-cost' } };
  const receipt = { ...structuredClone(template.invocations[0]), id: syntheticId(801), reservation_id: syntheticId(802),
    run_id: run.id, logical_run_id: run.id, max_cost_micros: '183505', charged_cost_micros: '183505', actual_cost_micros: null };
  const usage: CloudflareUsageEvidence = { schemaVersion: 2, runId: run.id, binding: structuredClone(template.binding),
    invocations: [receipt], calls: [{ ...structuredClone(template.calls[0]), invocation_id: receipt.id, run_id: run.id,
      call_id: 'synthetic-nonthinking-call', usage: null,
      provider_evidence: { provider: 'cloudflare', returnedModel: null, priceBasis: 'cloudflare-gemma4-26b-2026-09-26' } }] };
  const captured = [
    { type: 'RUN_STARTED', threadId: run.trip_id, runId: syntheticId(803) },
    { type: 'CUSTOM', name: 'dive_trip.answer.v1', value: { schemaVersion: 1, templateVersion: 1,
      answerId: `ans_${'a'.repeat(64)}`, runId: run.id, evidenceRefs: [],
      body: { kind: 'failure', reason: 'invalid-answer', committed: null } } },
    { type: 'RUN_ERROR', code: 'AGENT_PROVIDER_ERROR', message: 'synthetic controlled failure' },
  ];
  const events: QualityEvent[] = captured.map((event, index) => ({ run_id: run.id, sequence: index + 1, event }));
  const attempt = { schemaVersion: 2, round: 1, caseId: 'unknown-cost', outcome: 'failed',
    evidence: { caseId: 'unknown-cost', inputDigest: 'd'.repeat(64), runId: run.id,
      before: structuredClone(run.snapshot), beforeDecision: structuredClone(run.snapshot), after: structuredClone(run.snapshot),
      beforeVersion: 1, beforeDecisionVersion: 1, afterVersion: 1, terminal: 'clarification', runStatus: 'failed',
      decision: 'none', proposalId: null as string | null, decisionRunId: null as string | null, decisionProposalId: null as string | null,
      model: usage.binding.model, usageRunId: run.id, usageComplete: false, modelCalls: 1,
      toolCount: null as number | null, visibleToolCount: 0, costMicros: null as number | null, latencyMs: 100,
      textReview: 'pending', faultObserved: null },
    events: structuredClone(captured), grade: { pass: false,
      reasons: ['RUN_NOT_SUCCEEDED', 'USAGE_EVIDENCE_MISSING', 'TOOL_USAGE_EVIDENCE_MISSING', 'TEXT_REVIEW_REQUIRED', 'ANSWER_INCOMPLETE'],
      safetyFailures: ['TOOL_USAGE_EVIDENCE_MISSING'] } };
  const { id, status, proposal_id, interrupt_id, decision } = run;
  const audit = { kind: 'durable-audit', round: 1, caseId: 'unknown-cost', runs: [{ id, status, proposal_id, interrupt_id, decision }],
    events: structuredClone(events), privateUsage: [structuredClone(usage)], chargedMicros: 183505, privateUsageComplete: true, quiescent: true };
  const report = { schemaVersion: 2, model: usage.binding.model, accountId: usage.binding.accountId,
    transport: 'real-cloudflare-via-http-handler', budgetMicros: 3000000, maxModelCalls: 7, maxInvocations: 1,
    prior: structuredClone(prior), invocations: 1, modelCalls: 1, chargedMicros: 183505, totalTokens: null,
    cumulativeInvocations: 43, cumulativeModelCalls: 61, cumulativeChargedMicros: 765494, cumulativeTokens: null,
    accountingComplete: false, historicalUnknownReceipts: 3, dispatchAuthorized: false,
    stopped: 'UNKNOWN_USAGE_STOP', textReview: 'pending', evaluationGatePassed: false, records: [attempt, audit] };
  return { prior, report, attempt, audit, snapshot: {
    counts: { runs: 1, trips: 1, invocations: 1, calls: 1, reservations: 1, proposals: 0 }, runs: [run], events, usage: [usage] } };
}

export type NonthinkingCarryFixture = ReturnType<typeof nonthinkingCarryFixture>;
