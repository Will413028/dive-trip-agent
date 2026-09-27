import { historyIdentity } from './cloudflare-history-profile.ts';
import { readPinnedCloudflareReport, FIRST_REPORT_SHA256 } from './pinned-cloudflare-report.ts';
import { isDeepStrictEqual } from 'node:util';
import type { Pool } from 'pg';
import { z } from 'zod';
import { usageEvidenceSchema } from './usage-evidence.ts';
import { readCloudflareCampaignBaseline } from './cloudflare-campaign-history.ts';
import { CLOUDFLARE_MODEL } from '../src/agent/cloudflare-wire.ts';
import { withCloudflareRetainedAuditDatabase, CLOUDFLARE_RETAINED_SCHEMA, assertCloudflareAuditPool } from '../tests/support/cloudflare-audit-database.ts';
import { assertEvaluationLock, type EvaluationLockLease } from './live-evaluation-lock.ts';

export const CARRY_REPORT_SHA256 = () => (FIRST_REPORT_SHA256)();
export const CARRY_SCHEMA = () => (CLOUDFLARE_RETAINED_SCHEMA)();
const account = () => (historyIdentity('accountId_1'));
const runIds = () => ([historyIdentity('carry_forward_runIds_1'), historyIdentity('carry_forward_runIds_2')]);
const tripIds = () => ([historyIdentity('carry_forward_tripIds_1'), historyIdentity('carry_forward_tripIds_2')]);
// Owner anchors captured in the explicit read-only carry-forward review.
const ownerIds = () => ([historyIdentity('carry_forward_ownerIds_1'), historyIdentity('carry_forward_ownerIds_2')]);
const unknownReceipt = () => (historyIdentity('carry_forward_unknownReceipt_1'));
function fail(): never { throw new Error('CLOUDFLARE_CARRY_FORWARD_INVALID'); }
const priorSchema = z.strictObject({ chargedMicros: z.literal(3976), invocations: z.literal(6),
  modelCalls: z.literal(9), totalTokens: z.literal(36403) });
const historySchema = z.array(z.strictObject({ name: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) })).length(4);
const runSchema = z.strictObject({ id: z.uuid(), status: z.enum(['succeeded', 'failed']),
  proposal_id: z.null(), interrupt_id: z.null(), decision: z.null() });
const eventSchema = z.strictObject({ run_id: z.uuid(), sequence: z.number().int().positive(), event: z.record(z.string(), z.unknown()) });
const auditSchema = z.object({ kind: z.literal('durable-audit'), runs: z.array(runSchema).length(1),
  events: z.array(eventSchema).min(1).max(100), privateUsage: z.array(usageEvidenceSchema).length(1),
  privateUsageComplete: z.literal(true), quiescent: z.literal(true) });
const reportSchema = () => (z.object({ model: z.literal(CLOUDFLARE_MODEL), accountId: z.literal(account()), prior: priorSchema,
  history: historySchema, stopped: z.literal('UNKNOWN_USAGE_STOP'), totalTokens: z.null(), cumulativeTokens: z.null(),
  textReview: z.literal('pending'), evaluationGatePassed: z.literal(false), records: z.array(z.unknown()).length(32),
  chargedMicros: z.literal(184291), modelCalls: z.literal(2), cumulativeChargedMicros: z.literal(188267),
  cumulativeInvocations: z.literal(8), cumulativeModelCalls: z.literal(11) }));
const snapshotSchema = z.strictObject({
  counts: z.strictObject({ runs: z.literal(2), trips: z.literal(2), invocations: z.literal(2), calls: z.literal(2), reservations: z.literal(2) }),
  runs: z.array(runSchema.extend({ trip_id: z.uuid(), owner_id: z.uuid(), current_version: z.literal(1) })).length(2),
  events: z.array(eventSchema).min(2).max(200), usage: z.array(usageEvidenceSchema).length(2),
});

/** Pure comparison, NOT authorization. The IO entry below owns hash provenance.
 * Tests may use synthetic projections; consumers must never use this as a live grant. */
export function compareCloudflareCarryForward(reportInput: unknown, baselineInput: unknown, snapshotInput: unknown) {
  try {
    const report = reportSchema().parse(reportInput), snapshot = snapshotSchema.parse(snapshotInput);
    const baseline = priorSchema.extend({ history: historySchema }).parse(baselineInput);
    const { history, ...prior } = baseline;
    if (!isDeepStrictEqual(prior, report.prior) || !isDeepStrictEqual(history, report.history)) fail();
    const audits = report.records.filter(r => r && typeof r === 'object' && 'kind' in r && r.kind === 'durable-audit').map(r => auditSchema.parse(r));
    if (audits.length !== 2 || new Set(snapshot.runs.map(r => r.id)).size !== 2
      || new Set(snapshot.usage.map(u => u.runId)).size !== 2) fail();
    let tokens = 0, charged = 0, unknown = 0;
    for (const [index, id] of runIds().entries()) {
      const saved = audits.find(a => a.runs[0].id === id), row = snapshot.runs.find(r => r.id === id);
      const evidence = snapshot.usage.find(u => u.runId === id);
      if (!saved || !row || !evidence || evidence.schemaVersion !== 2
        || evidence.binding.accountId !== account() || evidence.binding.model !== CLOUDFLARE_MODEL
        || row.status !== (index === 0 ? 'succeeded' : 'failed')
        || row.trip_id !== tripIds()[index] || row.owner_id !== ownerIds()[index]) fail();
      const { trip_id, owner_id, current_version, ...run } = row;
      void trip_id; void owner_id; void current_version;
      if (!isDeepStrictEqual(saved.runs[0], run) || !isDeepStrictEqual(saved.privateUsage[0], evidence)
        || !isDeepStrictEqual(saved.events, snapshot.events.filter(e => e.run_id === id))) fail();
      if (evidence.invocations.length !== 1 || evidence.calls.length !== 1) fail();
      const receipt = evidence.invocations[0], call = evidence.calls[0];
      if (receipt.status !== 'settled' || receipt.reservation_status !== 'settled' || call.status !== 'completed' || !call.usage) fail();
      if (receipt.actual_cost_micros === null) {
        if (index !== 1 || receipt.reservation_id !== unknownReceipt() || receipt.charged_cost_micros !== '183505') fail();
        unknown++;
      } else if (index !== 0 || receipt.actual_cost_micros !== '786' || receipt.charged_cost_micros !== '786') fail();
      tokens += call.usage.totalTokens; charged += Number(receipt.charged_cost_micros);
    }
    if (snapshot.events.some(e => !runIds().includes(e.run_id)) || unknown !== 1 || tokens !== 10262 || charged !== 184291) fail();
    return { historyConsistent: true as const, dispatchAuthorized: false as const, accountingComplete: false as const,
      evaluationGatePassed: false as const, historicalUnknownReceipts: 1, invocations: 8, modelCalls: 11,
      chargedMicros: 188267, observedTokens: 46665, totalTokens: null,
      remainingInvocationCeiling: 92, remainingReferenceMicros: 2811733 };
  } catch { return fail(); }
}

async function readPinnedReport(lease?: EvaluationLockLease) {
  return reportSchema().parse(await readPinnedCloudflareReport("first", lease));
}

/** One capture, not a carry authorization. Keep raw rows for across-capture equality. */
export async function captureCloudflareFirstInventory(retained: Pool) {
    assertCloudflareAuditPool(retained);
    return withCloudflareRetainedAuditDatabase(retained, async query => {
        const counts = (await query(`SELECT (SELECT count(*)::int FROM agent_runs) AS runs,
          (SELECT count(*)::int FROM trips) AS trips,(SELECT count(*)::int FROM agent_invocations) AS invocations,
          (SELECT count(*)::int FROM model_calls) AS calls,(SELECT count(*)::int FROM quota_reservations) AS reservations`)).rows[0];
        const runs = (await query(`SELECT r.id,r.status,r.proposal_id,r.interrupt_id,r.decision,r.trip_id,
          t.owner_id,t.current_version FROM agent_runs r LEFT JOIN trips t ON t.id=r.trip_id ORDER BY r.created_at,r.id LIMIT 3`)).rows;
        const events = (await query('SELECT run_id,sequence,event FROM agent_run_events ORDER BY run_id,sequence LIMIT 201')).rows;
        const invocations = (await query(`SELECT i.id,i.run_id,i.reservation_id,i.kind,i.provider,i.model,i.account_id,i.status,
          i.max_cost_micros,q.logical_run_id,q.status AS reservation_status,q.owner_id AS reservation_owner_id,
          q.charged_cost_micros,q.actual_cost_micros,i.created_at,i.expires_at
          FROM agent_invocations i LEFT JOIN quota_reservations q ON q.id=i.reservation_id ORDER BY i.id LIMIT 3`)).rows;
        const calls = (await query(`SELECT invocation_id,run_id,call_id,status,usage,provider_evidence,started_at,completed_at
          FROM model_calls ORDER BY started_at,call_id LIMIT 3`)).rows;
        if (invocations.length !== 2 || calls.length !== 2
          || invocations.some(i => !runs.some(r => r.id === i.run_id && r.owner_id === i.reservation_owner_id))
          || calls.some(c => !invocations.some(i => i.id === c.invocation_id && i.run_id === c.run_id))) fail();
        const usage = runs.map(row => usageEvidenceSchema.parse({ schemaVersion: 2, runId: row.id,
          binding: { provider: 'cloudflare', model: CLOUDFLARE_MODEL, accountId: account() },
          invocations: invocations.filter(i => i.run_id === row.id), calls: calls.filter(c => c.run_id === row.id) }));
        return { snapshot: { counts, runs, events, usage }, raw: { counts, runs, events, invocations, calls } };
    });
}

/** Read-only evidence review. Optional lease preserves offline lock refusal;
 * legacy callers may supply the same explicit pool for both fixed schemas. */
export async function readCloudflareCarryForward(workbench: Pool, retained: Pool, lease?: EvaluationLockLease) {
  try {
    [workbench, retained].forEach(assertCloudflareAuditPool);
    const report = await readPinnedReport(lease);
    const baseline = await readCloudflareCampaignBaseline(workbench, account());
    const before = await captureCloudflareFirstInventory(retained);
    compareCloudflareCarryForward(report, baseline, before.snapshot);
    if (!isDeepStrictEqual(baseline, await readCloudflareCampaignBaseline(workbench, account()))) fail();
    await readPinnedReport(lease);
    // Final inventory AND all usage share one repeatable-read snapshot. Nothing
    // here asserts continued quiescence after that snapshot or a dispatch grant.
    const after = await captureCloudflareFirstInventory(retained);
    if (!isDeepStrictEqual(before, after)) fail();
    if (lease) await assertEvaluationLock(lease);
    return { ...compareCloudflareCarryForward(report, baseline, after.snapshot), sourceSha256: CARRY_REPORT_SHA256() };
  } catch { return fail(); }
}
