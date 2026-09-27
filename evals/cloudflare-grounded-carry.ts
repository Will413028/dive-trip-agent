import { historyIdentity } from './cloudflare-history-profile.ts';
import { isDeepStrictEqual } from 'node:util';
import type { Pool } from 'pg';
import { z } from 'zod';
import { groundedCarrySchema } from './cloudflare-grounded-carry-schema.ts';
import { recoveryCarrySchema } from './cloudflare-recovery-carry-schema.ts';
import { readPinnedCloudflareReport, GROUNDED_REPORT_SHA256 } from './pinned-cloudflare-report.ts';
import { captureCloudflareCampaignInventory } from './cloudflare-quality-carry.ts';
import { captureCloudflareRecoveryHistory, compareCloudflareRecoveryHistory } from './cloudflare-recovery-carry.ts';
import { assertEvaluationLock, type EvaluationLockLease } from './live-evaluation-lock.ts';
import { usageEvidenceSchema } from './usage-evidence.ts';
import { CLOUDFLARE_MODEL } from '../src/agent/cloudflare-wire.ts';
import { assertCloudflareAuditPools } from '../tests/support/cloudflare-audit-database.ts';
import { assertStoppedV2Evidence } from './stopped-v2-evidence.ts';

export { CLOUDFLARE_GROUNDED_RETAINED_SCHEMA as GROUNDED_CARRY_SCHEMA } from '../tests/support/cloudflare-audit-database.ts';
export { groundedCarrySchema } from './cloudflare-grounded-carry-schema.ts';

const accountId = () => (historyIdentity('accountId_1'));
const runId = () => (historyIdentity('grounded_carry_runId_1'));
const tripId = () => (historyIdentity('grounded_carry_tripId_1'));
const stopped = 'UNKNOWN_USAGE_STOP';
function fail(): never { throw new Error('CLOUDFLARE_GROUNDED_CARRY_INVALID'); }

// Historical order is closed here, independent of all current/future manifests.
const cases = ['ambiguous', 'non-diver', 'locked-budget', 'free-afternoon', 'more-people',
  'unknown-cost', 'no-date', 'source-injection', 'lookup-timeout', 'impossible'];
const skipped = [{ round: 1, caseId: 'no-date', outcome: 'skipped', reason: stopped },
  ...[1, 2, 3].flatMap(round => cases.filter(caseId => round !== 1 || !['unknown-cost', 'no-date'].includes(caseId))
    .map(caseId => ({ round, caseId, outcome: 'skipped', reason: stopped })))];
const snapshotValue = z.record(z.string(), z.unknown());
const runSchema = () => (z.object({ id: z.literal(runId()), status: z.literal('failed'), proposal_id: z.null(), interrupt_id: z.null(), decision: z.null() }));
const eventSchema = () => (z.object({ run_id: z.literal(runId()), sequence: z.number().int().positive(), event: z.record(z.string(), z.unknown()) }));
const failureEventsSchema = () => (z.tuple([
  z.strictObject({ type: z.literal('RUN_STARTED'), threadId: z.literal(tripId()), runId: z.uuid() }),
  z.strictObject({ type: z.literal('CUSTOM'), name: z.literal('dive_trip.answer.v1'), value: z.strictObject({
    schemaVersion: z.literal(1), templateVersion: z.literal(1), answerId: z.string().regex(/^ans_[a-f0-9]{64}$/),
    runId: z.literal(runId()), evidenceRefs: z.array(z.never()).length(0),
    body: z.strictObject({ kind: z.literal('failure'), reason: z.literal('invalid-answer'), committed: z.null() }),
  }) }),
  z.strictObject({ type: z.literal('RUN_ERROR'), code: z.literal('AGENT_PROVIDER_INVALID_RESPONSE'), message: z.string().min(1).max(512) }),
]));
const attemptSchema = () => (z.object({ schemaVersion: z.literal(2), round: z.literal(1), caseId: z.literal('unknown-cost'), outcome: z.literal('failed'),
  evidence: z.object({ caseId: z.literal('unknown-cost'), inputDigest: z.string().regex(/^[a-f0-9]{64}$/), runId: z.literal(runId()),
    before: snapshotValue, beforeDecision: snapshotValue, after: snapshotValue,
    beforeVersion: z.literal(1), beforeDecisionVersion: z.literal(1), afterVersion: z.literal(1), terminal: z.literal('clarification'),
    runStatus: z.literal('failed'), decision: z.literal('none'), proposalId: z.null(), decisionRunId: z.null(), decisionProposalId: z.null(),
    model: z.literal(CLOUDFLARE_MODEL), usageRunId: z.literal(runId()), usageComplete: z.literal(false), modelCalls: z.literal(1),
    toolCount: z.null(), visibleToolCount: z.literal(0), costMicros: z.null(), latencyMs: z.number().nonnegative(),
    textReview: z.literal('pending'), faultObserved: z.null() }),
  events: failureEventsSchema(),
  // Preserve the recorded v2 failure, without running today's grader or compiler.
  grade: z.strictObject({ pass: z.literal(false), reasons: z.tuple([z.literal('RUN_NOT_SUCCEEDED'), z.literal('USAGE_EVIDENCE_MISSING'),
    z.literal('TOOL_USAGE_EVIDENCE_MISSING'), z.literal('TEXT_REVIEW_REQUIRED'), z.literal('ANSWER_INCOMPLETE')]),
    safetyFailures: z.tuple([z.literal('TOOL_USAGE_EVIDENCE_MISSING')]) }) }));
const auditSchema = () => (z.object({ kind: z.literal('durable-audit'), round: z.literal(1), caseId: z.literal('unknown-cost'),
  runs: z.array(runSchema()).length(1), events: z.array(eventSchema()).length(3), privateUsage: z.array(usageEvidenceSchema).length(1),
  chargedMicros: z.literal(183505), privateUsageComplete: z.literal(true), quiescent: z.literal(true) }));
const skipSchema = z.strictObject({ round: z.number().int(), caseId: z.string(), outcome: z.literal('skipped'), reason: z.literal(stopped) });
const reportSchema = () => (z.object({ schemaVersion: z.literal(2), model: z.literal(CLOUDFLARE_MODEL), accountId: z.literal(accountId()),
  transport: z.literal('real-cloudflare-via-http-handler'), budgetMicros: z.literal(3000000), maxModelCalls: z.literal(210), maxInvocations: z.literal(39),
  prior: recoveryCarrySchema(), stopped: z.literal(stopped), textReview: z.literal('pending'), evaluationGatePassed: z.literal(false),
  accountingComplete: z.literal(false), historicalUnknownReceipts: z.literal(2), dispatchAuthorized: z.literal(false),
  invocations: z.literal(1), modelCalls: z.literal(1), chargedMicros: z.literal(183505), totalTokens: z.null(),
  cumulativeInvocations: z.literal(42), cumulativeModelCalls: z.literal(60), cumulativeChargedMicros: z.literal(581989),
  cumulativeTokens: z.null(), records: z.array(z.record(z.string(), z.unknown())).length(31) }));
const snapshotSchema = () => (z.object({ counts: z.strictObject({ runs: z.literal(1), trips: z.literal(1), invocations: z.literal(1),
  calls: z.literal(1), reservations: z.literal(1), proposals: z.literal(0) }),
  runs: z.array(runSchema().extend({ trip_id: z.literal(tripId()), owner_id: z.uuid(), current_version: z.literal(1), snapshot: snapshotValue })).length(1),
  events: z.array(eventSchema()).length(3), usage: z.array(usageEvidenceSchema).length(1) }));

/** Pure stopped-history consistency. IO independently pins bytes, schema and
 * owner provenance. Observed usage never settles this failed unknown receipt. */
export function compareCloudflareGroundedCarry(reportInput: unknown, priorInput: unknown, snapshotInput: unknown) {
  try {
    const report = reportSchema().parse(reportInput), prior = recoveryCarrySchema().parse(priorInput), snapshot = snapshotSchema().parse(snapshotInput);
    if (!isDeepStrictEqual(report.prior, prior)
      || !isDeepStrictEqual(report.records.slice(2).map(row => skipSchema.parse(row)), skipped)) fail();
    const [attemptRow, auditRow] = report.records;
    if ('kind' in attemptRow || 'evidence' in auditRow || 'outcome' in auditRow) fail();
    const attempt = attemptSchema().parse(attemptRow), audit = auditSchema().parse(auditRow);
    const { receipt, call } = assertStoppedV2Evidence(attempt, audit, snapshot, accountId());
    if (receipt.max_cost_micros !== '183505'
      || !isDeepStrictEqual(call.usage, { promptTokens: 3353, outputTokens: 2048, totalTokens: 5401, cachedTokens: 0 })) fail();
    return { historyConsistent: true as const, dispatchAuthorized: false as const, accountingComplete: false as const,
      evaluationGatePassed: false as const, historicalUnknownReceipts: 3 as const, invocations: 42, modelCalls: 60,
      chargedMicros: 581989, observedTokens: 277874, totalTokens: null, remainingInvocationCeiling: 58, remainingReferenceMicros: 2418011 };
  } catch { return fail(); }
}

/** One capture preserves every selected raw row for a successor's equality gate. */
export async function captureCloudflareGroundedHistory(workbench: Pool, first: Pool, second: Pool, quality: Pool,
  revision: Pool, recovery: Pool, grounded: Pool, lease: EvaluationLockLease) {
  assertCloudflareAuditPools([workbench, first, second, quality, revision, recovery, grounded]);
  const history = await captureCloudflareRecoveryHistory(workbench, first, second, quality, revision, recovery, lease);
  const report = await readPinnedCloudflareReport('grounded', lease);
  const inventory = await captureCloudflareCampaignInventory('grounded', grounded);
  await assertEvaluationLock(lease);
  return { history, report, inventory };
}

/** Pure comparison for successors; never calls the two-pass IO reader. */
export function compareCloudflareGroundedHistory(value: Awaited<ReturnType<typeof captureCloudflareGroundedHistory>>) {
  return groundedCarrySchema().parse({ ...compareCloudflareGroundedCarry(
    value.report, compareCloudflareRecoveryHistory(value.history), value.inventory.snapshot), sourceSha256: GROUNDED_REPORT_SHA256() });
}

/** Exactly two linear captures through all seven readonly scopes. The complete
 * raw rows participate in equality; this is not a cross-pool atomic snapshot. */
export async function readCloudflareGroundedCarry(workbench: Pool, first: Pool, second: Pool, quality: Pool,
  revision: Pool, recovery: Pool, grounded: Pool, lease: EvaluationLockLease) {
  try {
    const capture = () => captureCloudflareGroundedHistory(workbench, first, second, quality, revision, recovery, grounded, lease);
    const before = await capture();
    compareCloudflareGroundedHistory(before);
    const after = await capture();
    if (!isDeepStrictEqual(before, after)) fail();
    const result = compareCloudflareGroundedHistory(after);
    await assertEvaluationLock(lease);
    return result;
  } catch { return fail(); }
}
