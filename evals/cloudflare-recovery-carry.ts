import { historyIdentity } from './cloudflare-history-profile.ts';
import { isDeepStrictEqual } from 'node:util';
import type { Pool } from 'pg';
import { z } from 'zod';
import { recoveryCarrySchema } from './cloudflare-recovery-carry-schema.ts';
import { revisionCarrySchema } from './cloudflare-revision-carry-schema.ts';
import { readPinnedCloudflareReport, RECOVERY_REPORT_SHA256 } from './pinned-cloudflare-report.ts';
import { captureCloudflareCampaignInventory } from './cloudflare-quality-carry.ts';
import { captureCloudflareRevisionHistory, compareCloudflareRevisionHistory } from './cloudflare-revision-carry.ts';
import { assertEvaluationLock, type EvaluationLockLease } from './live-evaluation-lock.ts';
import { usageEvidenceSchema } from './usage-evidence.ts';
import { CLOUDFLARE_MODEL } from '../src/agent/cloudflare-wire.ts';
import { referenceProviderCost } from '../src/server/model-cost.ts';
import { assertCloudflareAuditPools } from '../tests/support/cloudflare-audit-database.ts';

export { CLOUDFLARE_RECOVERY_RETAINED_SCHEMA as RECOVERY_CARRY_SCHEMA } from '../tests/support/cloudflare-audit-database.ts';
export { recoveryCarrySchema } from './cloudflare-recovery-carry-schema.ts';

const accountId = () => (historyIdentity('accountId_1'));
const stopped = 'PREFLIGHT_TEXT_REVIEW_STOP';
function fail(): never { throw new Error('CLOUDFLARE_RECOVERY_CARRY_INVALID'); }
// Closed historical identities/order, independent of changes to future case manifests.
const completed = [
  { caseId: 'unknown-cost', calls: 2, events: 9, tokens: 9251, cost: 1261 },
  { caseId: 'no-date', calls: 1, events: 5, tokens: 4144, cost: 515 },
] as const;
const cases = ['ambiguous', 'non-diver', 'locked-budget', 'free-afternoon', 'more-people',
  'unknown-cost', 'no-date', 'source-injection', 'lookup-timeout', 'impossible'];
const skipped = [1, 2, 3].flatMap(round => cases.filter(caseId => round !== 1
  || !completed.some(c => c.caseId === caseId)).map(caseId => ({ round, caseId, outcome: 'skipped', reason: stopped })));
const snapshotValue = z.record(z.string(), z.unknown());
const runSchema = z.object({ id: z.uuid(), status: z.literal('succeeded'), proposal_id: z.null(), interrupt_id: z.null(), decision: z.null() });
const eventSchema = z.object({ run_id: z.uuid(), sequence: z.number().int().positive(), event: z.record(z.string(), z.unknown()) });
const auditSchema = z.object({ kind: z.literal('durable-audit'), round: z.literal(1), caseId: z.string(),
  runs: z.array(runSchema).length(1), events: z.array(eventSchema).max(9), privateUsage: z.array(usageEvidenceSchema).length(1),
  chargedMicros: z.number().int().nonnegative(), privateUsageComplete: z.literal(true), quiescent: z.literal(true) });
const attemptSchema = z.object({ schemaVersion: z.literal(1).optional(), round: z.literal(1), caseId: z.string(), outcome: z.literal('completed'),
  evidence: z.object({ caseId: z.string(), runId: z.uuid(), before: snapshotValue, beforeDecision: snapshotValue, after: snapshotValue,
    beforeVersion: z.literal(1), beforeDecisionVersion: z.literal(1), afterVersion: z.literal(1), terminal: z.literal('clarification'),
    runStatus: z.literal('succeeded'), decision: z.literal('none'), proposalId: z.null(), decisionRunId: z.null(), decisionProposalId: z.null(),
    model: z.literal(CLOUDFLARE_MODEL), usageRunId: z.uuid(), usageComplete: z.literal(true), modelCalls: z.number().int().positive(),
    costMicros: z.number().int().nonnegative(), textReview: z.literal('pending') }),
  events: z.array(z.record(z.string(), z.unknown())).max(9) });
const skipSchema = z.strictObject({ round: z.number().int(), caseId: z.string(), outcome: z.literal('skipped'), reason: z.literal(stopped) });
const reportSchema = () => (z.object({ schemaVersion: z.literal(1).optional(), model: z.literal(CLOUDFLARE_MODEL), accountId: z.literal(accountId()),
  transport: z.literal('real-cloudflare-via-http-handler'), budgetMicros: z.literal(3000000), maxModelCalls: z.literal(210), maxInvocations: z.literal(60),
  prior: revisionCarrySchema(), stopped: z.literal(stopped), textReview: z.literal('pending'), evaluationGatePassed: z.literal(false),
  accountingComplete: z.literal(false), historicalUnknownReceipts: z.literal(2), dispatchAuthorized: z.literal(false),
  invocations: z.literal(2), modelCalls: z.literal(3), chargedMicros: z.literal(1776), totalTokens: z.literal(13395),
  cumulativeInvocations: z.literal(41), cumulativeModelCalls: z.literal(59), cumulativeChargedMicros: z.literal(398484),
  cumulativeTokens: z.null(), records: z.array(z.record(z.string(), z.unknown())).length(32) }));
const snapshotSchema = z.object({ counts: z.strictObject({ runs: z.literal(2), trips: z.literal(2), invocations: z.literal(2),
  calls: z.literal(3), reservations: z.literal(2), proposals: z.literal(0) }),
  runs: z.array(runSchema.extend({ trip_id: z.uuid(), owner_id: z.uuid(), current_version: z.literal(1), snapshot: snapshotValue })).length(2),
  events: z.array(eventSchema).length(14), usage: z.array(usageEvidenceSchema).length(2) });

/** Legacy consistency only, never regrading or rewriting old unknown receipts.
 * Report hash and the independent owner tuple baseline are checked by IO. */
export function compareCloudflareRecoveryCarry(reportInput: unknown, priorInput: unknown, snapshotInput: unknown) {
  try {
    const report = reportSchema().parse(reportInput), prior = revisionCarrySchema().parse(priorInput), snapshot = snapshotSchema.parse(snapshotInput);
    if (!isDeepStrictEqual(report.prior, prior)
      || !isDeepStrictEqual(report.records.slice(4).map(row => skipSchema.parse(row)), skipped)
      || new Set(snapshot.runs.map(r => r.id)).size !== 2 || new Set(snapshot.runs.map(r => r.trip_id)).size !== 2
      || new Set(snapshot.usage.map(u => u.runId)).size !== 2
      || snapshot.events.some(e => !snapshot.runs.some(r => r.id === e.run_id))) fail();
    let cost = 0, tokens = 0, calls = 0;
    const runs = new Set<string>(), receipts = new Set<string>(), reservations = new Set<string>();
    for (const [index, expected] of completed.entries()) {
      const attemptRow = report.records[index * 2], auditRow = report.records[index * 2 + 1];
      if ('kind' in attemptRow || 'evidence' in auditRow || 'outcome' in auditRow) fail();
      const attempt = attemptSchema.parse(attemptRow), audit = auditSchema.parse(auditRow), evidence = attempt.evidence;
      const run = snapshot.runs.find(row => row.id === evidence.runId);
      const usage = snapshot.usage.find(row => row.runId === evidence.runId);
      if (!run || !usage || usage.schemaVersion !== 2 || usage.binding.accountId !== accountId() || runs.has(run.id)
        || attempt.caseId !== expected.caseId || audit.caseId !== expected.caseId || evidence.caseId !== expected.caseId
        || evidence.usageRunId !== run.id || evidence.modelCalls !== expected.calls || evidence.costMicros !== expected.cost
        || !isDeepStrictEqual(evidence.before, evidence.beforeDecision) || !isDeepStrictEqual(evidence.before, evidence.after)
        || !isDeepStrictEqual(run.snapshot, evidence.after) || !isDeepStrictEqual(runSchema.parse(run), audit.runs[0])
        || !isDeepStrictEqual([usage], audit.privateUsage)) fail();
      runs.add(run.id);
      const events = snapshot.events.filter(row => row.run_id === run.id);
      if (events.length !== expected.events || !isDeepStrictEqual(events, audit.events)
        || !isDeepStrictEqual(attempt.events, events.map(e => e.event)) || events.some((e, i) => e.sequence !== i + 1)
        || events[0].event.type !== 'RUN_STARTED' || events[0].event.threadId !== run.trip_id
        || events.at(-1)!.event.type !== 'RUN_FINISHED' || events.at(-1)!.event.threadId !== run.trip_id
        || events.at(-1)!.event.runId !== events[0].event.runId) fail();
      if (usage.invocations.length !== 1 || usage.calls.length !== expected.calls) fail();
      const receipt = usage.invocations[0];
      if (receipts.has(receipt.id) || reservations.has(receipt.reservation_id) || receipt.kind !== 'start'
        || receipt.status !== 'settled' || receipt.reservation_status !== 'settled' || receipt.actual_cost_micros === null
        || receipt.actual_cost_micros !== receipt.charged_cost_micros
        || Number(receipt.actual_cost_micros) > Number(receipt.max_cost_micros)) fail();
      receipts.add(receipt.id); reservations.add(receipt.reservation_id);
      let runCost = 0, runTokens = 0;
      for (const call of usage.calls) {
        const value = referenceProviderCost('cloudflare', call.usage, call.provider_evidence ?? undefined);
        if (call.status !== 'completed' || !call.usage || value === null) fail();
        runCost += value; runTokens += call.usage.totalTokens;
      }
      if (runCost !== expected.cost || runTokens !== expected.tokens || runCost !== Number(receipt.actual_cost_micros)) fail();
      cost += runCost; tokens += runTokens; calls += usage.calls.length;
      if (audit.chargedMicros !== cost) fail(); // Historical collector checkpoints are cumulative.
    }
    if (cost !== report.chargedMicros || tokens !== report.totalTokens || calls !== report.modelCalls || receipts.size !== report.invocations) fail();
    return { historyConsistent: true as const, dispatchAuthorized: false as const, accountingComplete: false as const,
      evaluationGatePassed: false as const, historicalUnknownReceipts: 2 as const, invocations: 41, modelCalls: 59,
      chargedMicros: 398484, observedTokens: 272473, totalTokens: null, remainingInvocationCeiling: 59, remainingReferenceMicros: 2601516 };
  } catch { return fail(); }
}

/** One capture preserves every selected raw row through the outer equality gate. */
export async function captureCloudflareRecoveryHistory(workbench: Pool, first: Pool, second: Pool, quality: Pool,
  revision: Pool, recovery: Pool, lease: EvaluationLockLease) {
  assertCloudflareAuditPools([workbench, first, second, quality, revision, recovery]);
  const history = await captureCloudflareRevisionHistory(workbench, first, second, quality, revision, lease);
  const report = await readPinnedCloudflareReport('recovery', lease);
  const inventory = await captureCloudflareCampaignInventory('recovery', recovery);
  await assertEvaluationLock(lease);
  return { history, report, inventory };
}

/** Pure comparison for successors; never calls the two-pass IO reader. */
export function compareCloudflareRecoveryHistory(value: Awaited<ReturnType<typeof captureCloudflareRecoveryHistory>>) {
  return recoveryCarrySchema().parse({ ...compareCloudflareRecoveryCarry(
    value.report, compareCloudflareRevisionHistory(value.history), value.inventory.snapshot), sourceSha256: RECOVERY_REPORT_SHA256() });
}

/** Two complete linear captures through all six readonly scopes, not recursive
 * two-pass readers. Equality detects drift; it is not a cross-pool atomic snapshot. */
export async function readCloudflareRecoveryCarry(workbench: Pool, first: Pool, second: Pool, quality: Pool, revision: Pool, recovery: Pool, lease: EvaluationLockLease) {
  try {
    const capture = () => captureCloudflareRecoveryHistory(workbench, first, second, quality, revision, recovery, lease);
    const before = await capture();
    compareCloudflareRecoveryHistory(before);
    const after = await capture();
    if (!isDeepStrictEqual(before, after)) fail();
    const result = compareCloudflareRecoveryHistory(after);
    await assertEvaluationLock(lease);
    return result;
  } catch { return fail(); }
}
