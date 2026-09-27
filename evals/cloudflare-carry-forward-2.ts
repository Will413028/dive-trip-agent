import { historyIdentity } from './cloudflare-history-profile.ts';
import { readPinnedCloudflareReport, SECOND_REPORT_SHA256 } from './pinned-cloudflare-report.ts';
import { isDeepStrictEqual } from 'node:util';
import type { Pool } from 'pg';
import { z } from 'zod';
import { usageEvidenceSchema } from './usage-evidence.ts';
import { CARRY_REPORT_SHA256, readCloudflareCarryForward } from './cloudflare-carry-forward.ts';
import { CLOUDFLARE_MODEL } from '../src/agent/cloudflare-wire.ts';
import { withCloudflareSecondRetainedAuditDatabase, CLOUDFLARE_SECOND_RETAINED_SCHEMA, assertCloudflareAuditPools, assertCloudflareAuditPool } from '../tests/support/cloudflare-audit-database.ts';
import { assertEvaluationLock, type EvaluationLockLease } from './live-evaluation-lock.ts';

export const SECOND_CARRY_REPORT_SHA256 = () => (SECOND_REPORT_SHA256)();
export const SECOND_CARRY_SCHEMA = () => (CLOUDFLARE_SECOND_RETAINED_SCHEMA)();
const accountId = () => (historyIdentity('accountId_1'));
const runId = () => (historyIdentity('carry_forward_2_runId_1'));
const tripId = () => (historyIdentity('carry_forward_2_tripId_1'));
// Fixed by the retained trip's read-only audit, not its current cross-row agreement.
const ownerId = () => (historyIdentity('carry_forward_2_ownerId_1'));
function fail(): never { throw new Error('CLOUDFLARE_SECOND_CARRY_FORWARD_INVALID'); }
const priorSchema = () => (z.strictObject({ sourceSha256: z.literal(CARRY_REPORT_SHA256()),
  historyConsistent: z.literal(true), dispatchAuthorized: z.literal(false), accountingComplete: z.literal(false),
  evaluationGatePassed: z.literal(false), historicalUnknownReceipts: z.literal(1), invocations: z.literal(8),
  modelCalls: z.literal(11), chargedMicros: z.literal(188267), observedTokens: z.literal(46665), totalTokens: z.null(),
  remainingInvocationCeiling: z.literal(92), remainingReferenceMicros: z.literal(2811733) }));
const runSchema = () => (z.strictObject({ id: z.literal(runId()), status: z.literal('failed'),
  proposal_id: z.null(), interrupt_id: z.null(), decision: z.null() }));
const eventSchema = () => (z.strictObject({ run_id: z.literal(runId()), sequence: z.number().int().positive(),
  event: z.record(z.string(), z.unknown()) }));
const auditSchema = () => (z.object({ kind: z.literal('durable-audit'), round: z.literal(1), caseId: z.literal('locked-budget'),
  chargedMicros: z.literal(681), runs: z.array(runSchema()).length(1), events: z.array(eventSchema()).length(2),
  privateUsage: z.array(usageEvidenceSchema).length(1), privateUsageComplete: z.literal(true), quiescent: z.literal(true) }));
const reportSchema = () => (z.object({ model: z.literal(CLOUDFLARE_MODEL), accountId: z.literal(accountId()), prior: priorSchema(),
  stopped: z.literal('FAILED_RUN_STOP'), textReview: z.literal('pending'), evaluationGatePassed: z.literal(false),
  accountingComplete: z.literal(false), dispatchAuthorized: z.literal(false), historicalUnknownReceipts: z.literal(1),
  chargedMicros: z.literal(681), invocations: z.literal(1), modelCalls: z.literal(1), totalTokens: z.literal(5074),
  cumulativeChargedMicros: z.literal(188948), cumulativeInvocations: z.literal(9), cumulativeModelCalls: z.literal(12),
  cumulativeTokens: z.null(), records: z.array(z.unknown()).length(9) }));
const snapshotSchema = () => (z.strictObject({
  counts: z.strictObject({ runs: z.literal(1), trips: z.literal(1), invocations: z.literal(1), calls: z.literal(1),
    reservations: z.literal(1), proposals: z.literal(0) }),
  runs: z.array(runSchema().extend({ trip_id: z.literal(tripId()), owner_id: z.literal(ownerId()), current_version: z.literal(1) })).length(1),
  events: z.array(eventSchema()).length(2), usage: z.array(usageEvidenceSchema).length(1),
}));

/** Pure comparison of projections, never provenance or permission to dispatch.
 * Only the locked IO reader below establishes both historical report hashes. */
export function compareCloudflareSecondCarryForward(reportInput: unknown, priorInput: unknown, snapshotInput: unknown) {
  try {
    const report = reportSchema().parse(reportInput), prior = priorSchema().parse(priorInput);
    const snapshot = snapshotSchema().parse(snapshotInput);
    if (!isDeepStrictEqual(report.prior, prior)) fail();
    const audits = report.records.filter(r => r && typeof r === 'object' && 'kind' in r && r.kind === 'durable-audit');
    if (audits.length !== 1) fail();
    const audit = auditSchema().parse(audits[0]);
    const { trip_id, owner_id, current_version, ...run } = snapshot.runs[0];
    void trip_id; void owner_id; void current_version;
    if (!isDeepStrictEqual(audit.runs, [run]) || !isDeepStrictEqual(audit.events, snapshot.events)
      || !isDeepStrictEqual(audit.privateUsage, snapshot.usage)) fail();
    const usage = snapshot.usage[0];
    if (usage.schemaVersion !== 2 || usage.runId !== runId() || usage.binding.accountId !== accountId()
      || usage.invocations.length !== 1 || usage.calls.length !== 1) fail();
    const receipt = usage.invocations[0], call = usage.calls[0];
    if (receipt.status !== 'settled' || receipt.reservation_status !== 'settled'
      || receipt.actual_cost_micros !== '681' || receipt.charged_cost_micros !== '681'
      || call.status !== 'completed' || call.usage?.promptTokens !== 4208
      || call.usage.outputTokens !== 866 || call.usage.totalTokens !== 5074) fail();
    return { historyConsistent: true as const, dispatchAuthorized: false as const, accountingComplete: false as const,
      evaluationGatePassed: false as const, historicalUnknownReceipts: 1, invocations: 9, modelCalls: 12,
      chargedMicros: 188948, observedTokens: 51739, totalTokens: null,
      remainingInvocationCeiling: 91, remainingReferenceMicros: 2811052 };
  } catch { return fail(); }
}

async function readPinnedReport(lease: EvaluationLockLease) {
  return reportSchema().parse(await readPinnedCloudflareReport("second", lease));
}

/** One fixed-schema capture; callers own the surrounding historical comparison. */
export async function captureCloudflareSecondInventory(second: Pool) {
    assertCloudflareAuditPool(second);
    return withCloudflareSecondRetainedAuditDatabase(second, async query => {
      const counts = (await query(`SELECT (SELECT count(*)::int FROM agent_runs) AS runs,
        (SELECT count(*)::int FROM trips) AS trips,(SELECT count(*)::int FROM agent_invocations) AS invocations,
        (SELECT count(*)::int FROM model_calls) AS calls,(SELECT count(*)::int FROM quota_reservations) AS reservations,
        (SELECT count(*)::int FROM proposals) AS proposals`)).rows[0];
      const runs = (await query(`SELECT r.id,r.status,r.proposal_id,r.interrupt_id,r.decision,r.trip_id,
        t.owner_id,t.current_version FROM agent_runs r LEFT JOIN trips t ON t.id=r.trip_id ORDER BY r.id LIMIT 2`)).rows;
      const events = (await query('SELECT run_id,sequence,event FROM agent_run_events ORDER BY run_id,sequence LIMIT 3')).rows;
      const invocations = (await query(`SELECT i.id,i.run_id,i.reservation_id,i.kind,i.provider,i.model,i.account_id,i.status,
        i.max_cost_micros,q.logical_run_id,q.status AS reservation_status,q.owner_id AS reservation_owner_id,
        q.charged_cost_micros,q.actual_cost_micros,i.created_at,i.expires_at
        FROM agent_invocations i LEFT JOIN quota_reservations q ON q.id=i.reservation_id ORDER BY i.id LIMIT 2`)).rows;
      const calls = (await query(`SELECT invocation_id,run_id,call_id,status,usage,provider_evidence,started_at,completed_at
        FROM model_calls ORDER BY started_at,call_id LIMIT 2`)).rows;
      if (runs.length !== 1 || invocations.length !== 1 || calls.length !== 1
        || invocations[0].run_id !== runs[0].id || invocations[0].reservation_owner_id !== runs[0].owner_id
        || calls[0].invocation_id !== invocations[0].id || calls[0].run_id !== runs[0].id) fail();
      const usage = [usageEvidenceSchema.parse({ schemaVersion: 2, runId: runs[0].id,
        binding: { provider: 'cloudflare', model: CLOUDFLARE_MODEL, accountId: accountId() }, invocations, calls })];
      return { snapshot: { counts, runs, events, usage }, raw: { counts, runs, events, invocations, calls } };
    });
}

/** Dedicated explicit offline pools, fixed retained schemas, no environment or
 * credential loader. Rechecks both histories under the caller's owned lease. */
export async function readCloudflareSecondCarryForward(workbench: Pool, first: Pool, second: Pool, lease: EvaluationLockLease) {
  try {
    assertCloudflareAuditPools([workbench, first, second]);
    await assertEvaluationLock(lease);
    const report = await readPinnedReport(lease);
    const prior = await readCloudflareCarryForward(workbench, first, lease);
    const before = await captureCloudflareSecondInventory(second);
    compareCloudflareSecondCarryForward(report, prior, before.snapshot);
    if (!isDeepStrictEqual(prior, await readCloudflareCarryForward(workbench, first, lease))) fail();
    await readPinnedReport(lease);
    const after = await captureCloudflareSecondInventory(second);
    if (!isDeepStrictEqual(before, after)) fail();
    await assertEvaluationLock(lease);
    return { ...compareCloudflareSecondCarryForward(report, prior, after.snapshot), sourceSha256: SECOND_CARRY_REPORT_SHA256() };
  } catch { return fail(); }
}
