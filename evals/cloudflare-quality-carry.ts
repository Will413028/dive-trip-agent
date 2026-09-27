import { historyIdentity } from './cloudflare-history-profile.ts';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Pool } from 'pg';
import { z } from 'zod';
import { readPinnedCloudflareReport, FIRST_REPORT_SHA256, SECOND_REPORT_SHA256, PATCH_REPORT_SHA256, QUALITY_REPORT_SHA256 } from './pinned-cloudflare-report.ts';
import { compareCloudflarePatchCarry } from './cloudflare-patch-carry.ts';
import { captureCloudflareFirstInventory, compareCloudflareCarryForward } from './cloudflare-carry-forward.ts';
import { captureCloudflareSecondInventory, compareCloudflareSecondCarryForward } from './cloudflare-carry-forward-2.ts';
import { captureCloudflareCampaignBaseline } from './cloudflare-campaign-history.ts';
import { assertEvaluationLock, type EvaluationLockLease } from './live-evaluation-lock.ts';
import { usageEvidenceSchema } from './usage-evidence.ts';
import { CLOUDFLARE_MODEL } from '../src/agent/cloudflare-wire.ts';
import { referenceProviderCost } from '../src/server/model-cost.ts';
import { assertCloudflareAuditPool, assertCloudflareAuditPools, withCloudflareQualityAuditDatabase, withCloudflareRevisionAuditDatabase, withCloudflareRecoveryAuditDatabase, withCloudflareGroundedAuditDatabase, withCloudflareNonthinkingAuditDatabase } from '../tests/support/cloudflare-audit-database.ts';

export { CLOUDFLARE_QUALITY_RETAINED_SCHEMA as QUALITY_CARRY_SCHEMA } from '../tests/support/cloudflare-audit-database.ts';
const accountId = () => (historyIdentity('accountId_1'));
// Read-only 2026-09-26 audit: sorted [run,trip,owner] tuples. Owners were not
// exported by the collector; cross-row agreement alone is not provenance.
const bindingsSha256 = () => (historyIdentity('quality_carry_bindingsSha256_1'));
function fail(): never { throw new Error('CLOUDFLARE_QUALITY_CARRY_INVALID'); }
const priorSchema = () => (z.strictObject({ sourceSha256: z.literal(PATCH_REPORT_SHA256()), historyConsistent: z.literal(true),
  dispatchAuthorized: z.literal(false), accountingComplete: z.literal(false), evaluationGatePassed: z.literal(false),
  historicalUnknownReceipts: z.literal(1), invocations: z.literal(10), modelCalls: z.literal(14), chargedMicros: z.literal(190067),
  observedTokens: z.literal(61192), totalTokens: z.null(), remainingInvocationCeiling: z.literal(90), remainingReferenceMicros: z.literal(2809933) }));
const runSchema = z.object({ id: z.uuid(), status: z.enum(['succeeded', 'failed']), proposal_id: z.uuid().nullable(),
  interrupt_id: z.string().nullable(), decision: z.boolean().nullable() });
const eventSchema = z.object({ run_id: z.uuid(), sequence: z.number().int().positive(), event: z.record(z.string(), z.unknown()) });
const auditSchema = z.object({ kind: z.literal('durable-audit'), round: z.number().int(), caseId: z.string(),
  runs: z.array(runSchema).length(1), events: z.array(eventSchema).max(112), privateUsage: z.array(usageEvidenceSchema).length(1),
  chargedMicros: z.number().int().nonnegative(), privateUsageComplete: z.literal(true), quiescent: z.literal(true) });
const attemptSchema = z.object({ round: z.number().int(), caseId: z.string(), evidence: z.object({ runId: z.uuid(),
  afterVersion: z.number().int().positive(), after: z.record(z.string(), z.unknown()) }) });
const reportSchema = () => (z.object({ model: z.literal(CLOUDFLARE_MODEL), accountId: z.literal(accountId()), prior: priorSchema(),
  stopped: z.literal('FAILED_RUN_STOP'), textReview: z.literal('pending'), evaluationGatePassed: z.literal(false),
  accountingComplete: z.literal(false), historicalUnknownReceipts: z.literal(1), dispatchAuthorized: z.literal(false),
  invocations: z.literal(16), modelCalls: z.literal(24), chargedMicros: z.literal(14749), totalTokens: z.literal(122599),
  cumulativeInvocations: z.literal(26), cumulativeModelCalls: z.literal(38), cumulativeChargedMicros: z.literal(204816),
  cumulativeTokens: z.null(), records: z.array(z.unknown()).length(44) }));
const snapshotSchema = z.object({ counts: z.strictObject({ runs: z.literal(13), trips: z.literal(13), invocations: z.literal(16),
  calls: z.literal(24), reservations: z.literal(16), proposals: z.literal(3) }),
  runs: z.array(runSchema.extend({ trip_id: z.uuid(), owner_id: z.uuid(), current_version: z.number().int().positive(), snapshot: z.record(z.string(), z.unknown()) })).length(13),
  events: z.array(eventSchema).length(112), usage: z.array(usageEvidenceSchema).length(13) });

/** Pure consistency only; the IO wrapper pins report and owner provenance. */
export function compareCloudflareQualityCarry(reportInput: unknown, priorInput: unknown, snapshotInput: unknown) {
  try {
    const report = reportSchema().parse(reportInput), prior = priorSchema().parse(priorInput), snapshot = snapshotSchema.parse(snapshotInput);
    if (!isDeepStrictEqual(report.prior, prior)) fail();
    const rows = report.records.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object');
    const audits = rows.filter(row => row.kind === 'durable-audit').map(row => auditSchema.parse(row));
    const attempts = rows.filter(row => row.evidence !== undefined).map(row => attemptSchema.parse(row));
    if (audits.length !== 13 || attempts.length !== 13 || new Set(audits.map(a => a.runs[0].id)).size !== 13
      || new Set(attempts.map(a => a.evidence.runId)).size !== 13 || new Set(snapshot.runs.map(r => r.id)).size !== 13
      || new Set(snapshot.runs.map(r => r.trip_id)).size !== 13 || new Set(snapshot.usage.map(u => u.runId)).size !== 13
      || audits.reduce((sum, audit) => sum + audit.events.length, 0) !== 112
      || snapshot.events.some(e => !snapshot.runs.some(r => r.id === e.run_id))) fail();
    let cost = 0, tokens = 0, invocations = 0, calls = 0;
    const receipts = new Set<string>(), reservationIds = new Set<string>();
    for (const audit of audits) {
      const run = snapshot.runs.find(row => row.id === audit.runs[0].id);
      const attempt = attempts.find(row => row.evidence.runId === run?.id);
      const usage = snapshot.usage.find(row => row.runId === run?.id);
      if (!run || !attempt || !usage || usage.schemaVersion !== 2 || usage.binding.accountId !== accountId()
        || attempt.round !== audit.round || attempt.caseId !== audit.caseId
        || run.current_version !== attempt.evidence.afterVersion || !isDeepStrictEqual(run.snapshot, attempt.evidence.after)
        || !isDeepStrictEqual(runSchema.parse(run), audit.runs[0]) || !isDeepStrictEqual([usage], audit.privateUsage)) fail();
      const events = snapshot.events.filter(row => row.run_id === run.id);
      if (!isDeepStrictEqual(events, audit.events) || events.some((e, i) => e.sequence !== i + 1)
        || events[0]?.event.type !== 'RUN_STARTED' || events[0].event.threadId !== run.trip_id) fail();
      for (const receipt of usage.invocations) {
        if (receipts.has(receipt.id) || reservationIds.has(receipt.reservation_id) || receipt.status !== 'settled'
          || receipt.reservation_status !== 'settled' || receipt.actual_cost_micros === null
          || receipt.actual_cost_micros !== receipt.charged_cost_micros) fail();
        receipts.add(receipt.id); reservationIds.add(receipt.reservation_id);
        const invocationCalls = usage.calls.filter(call => call.invocation_id === receipt.id);
        if (!invocationCalls.length) fail();
        let calculated = 0;
        for (const call of invocationCalls) {
          const value = referenceProviderCost('cloudflare', call.usage, call.provider_evidence ?? undefined);
          if (call.status !== 'completed' || !call.usage || value === null) fail();
          calculated += value; tokens += call.usage.totalTokens;
        }
        if (calculated !== Number(receipt.actual_cost_micros)) fail();
        cost += calculated;
      }
      invocations += usage.invocations.length; calls += usage.calls.length;
      if (audit.chargedMicros !== cost) fail(); // Collector checkpoints are cumulative, not per-case.
    }
    if (cost !== 14749 || tokens !== 122599 || invocations !== 16 || calls !== 24) fail();
    return { historyConsistent: true as const, dispatchAuthorized: false as const, accountingComplete: false as const,
      evaluationGatePassed: false as const, historicalUnknownReceipts: 1 as const, invocations: 26, modelCalls: 38,
      chargedMicros: 204816, observedTokens: 183791, totalTokens: null, remainingInvocationCeiling: 74,
      remainingReferenceMicros: 2795184 };
  } catch { return fail(); }
}

// Closed forensic scopes: callers cannot override schemas, counts, limits or pins.
const inventoryScopes = () => ({
  quality: { runs: 13, events: 112, invocations: 16, calls: 24, bindingsSha256: bindingsSha256(),
    read: withCloudflareQualityAuditDatabase, error: 'CLOUDFLARE_QUALITY_CARRY_INVALID' },
  revision: { runs: 9, events: 86, invocations: 13, calls: 18,
    // Local readonly audit baseline, not owner provenance exported by the report.
    bindingsSha256: historyIdentity('quality_carry_inventoryScopes_1'),
    read: withCloudflareRevisionAuditDatabase, error: 'CLOUDFLARE_REVISION_CARRY_INVALID' },
  recovery: { runs: 2, events: 14, invocations: 2, calls: 3,
    // Local readonly audit baseline, not owner provenance exported by the report.
    bindingsSha256: historyIdentity('quality_carry_inventoryScopes_2'),
    read: withCloudflareRecoveryAuditDatabase, error: 'CLOUDFLARE_RECOVERY_CARRY_INVALID' },
  grounded: { runs: 1, events: 3, invocations: 1, calls: 1,
    // Owned-lease readonly audit on 2026-09-27; sorted [run,trip,owner].
    bindingsSha256: historyIdentity('quality_carry_inventoryScopes_3'),
    read: withCloudflareGroundedAuditDatabase, error: 'CLOUDFLARE_GROUNDED_CARRY_INVALID' },
  nonthinking: { runs: 1, events: 3, invocations: 1, calls: 1,
    // Fixed-scope readonly audit on 2026-09-27; sorted [run,trip,owner].
    bindingsSha256: historyIdentity('quality_carry_inventoryScopes_4'),
    read: withCloudflareNonthinkingAuditDatabase, error: 'CLOUDFLARE_NONTHINKING_CARRY_INVALID' },
} as const);

/** Single capture retains unprojected SQL rows as well as comparison evidence. */
export async function captureCloudflareCampaignInventory(kind: keyof ReturnType<typeof inventoryScopes>, pool: Pool) {
  if (!Object.hasOwn(inventoryScopes(), kind)) throw new Error('CLOUDFLARE_AUDIT_DATABASE_FAILED');
  const scope = inventoryScopes()[kind];
  const invalid = (): never => { throw new Error(scope.error); };
  assertCloudflareAuditPool(pool);
  return scope.read(pool, async query => {
    const counts = (await query(`SELECT (SELECT count(*)::int FROM agent_runs) AS runs,
      (SELECT count(*)::int FROM trips) AS trips,(SELECT count(*)::int FROM agent_invocations) AS invocations,
      (SELECT count(*)::int FROM model_calls) AS calls,(SELECT count(*)::int FROM quota_reservations) AS reservations,
      (SELECT count(*)::int FROM proposals) AS proposals`)).rows[0];
    const runs = (await query(`SELECT r.id,r.status,r.proposal_id,r.interrupt_id,r.decision,r.trip_id,t.owner_id,t.current_version,v.snapshot
      FROM agent_runs r LEFT JOIN trips t ON t.id=r.trip_id LEFT JOIN trip_versions v ON v.trip_id=t.id AND v.version=t.current_version
      ORDER BY r.id LIMIT ${scope.runs + 1}`)).rows;
    if (createHash('sha256').update(JSON.stringify(runs.map(r => [r.id, r.trip_id, r.owner_id]))).digest('hex') !== scope.bindingsSha256) invalid();
    const events = (await query(`SELECT run_id,sequence,event FROM agent_run_events ORDER BY run_id,sequence LIMIT ${scope.events + 1}`)).rows;
    const invocations = (await query(`SELECT i.id,i.run_id,i.reservation_id,i.kind,i.provider,i.model,i.account_id,i.status,
      i.max_cost_micros,q.logical_run_id,q.status AS reservation_status,q.owner_id AS reservation_owner_id,
      q.charged_cost_micros,q.actual_cost_micros,i.created_at,i.expires_at
      FROM agent_invocations i LEFT JOIN quota_reservations q ON q.id=i.reservation_id ORDER BY i.created_at,i.id LIMIT ${scope.invocations + 1}`)).rows;
    const calls = (await query(`SELECT invocation_id,run_id,call_id,status,usage,provider_evidence,started_at,completed_at
      FROM model_calls ORDER BY started_at,call_id LIMIT ${scope.calls + 1}`)).rows;
    if (invocations.length !== scope.invocations || calls.length !== scope.calls || invocations.some(i =>
      !runs.some(r => r.id === i.run_id && r.owner_id === i.reservation_owner_id))
      || calls.some(c => !invocations.some(i => i.id === c.invocation_id && i.run_id === c.run_id))) invalid();
    const usage = runs.map(run => usageEvidenceSchema.parse({ schemaVersion: 2, runId: run.id,
      binding: { provider: 'cloudflare', model: CLOUDFLARE_MODEL, accountId: accountId() },
      invocations: invocations.filter(i => i.run_id === run.id), calls: calls.filter(c => c.run_id === run.id) }));
    return { snapshot: { counts, runs, events, usage }, raw: { counts, runs, events, invocations, calls } };
  });
}

export async function captureCloudflareQualityInventory(quality: Pool) {
  return captureCloudflareCampaignInventory('quality', quality);
}

/** One linear capture through quality, retaining raw rows for the outer equality
 * gate. The smoke baseline keeps its independently bounded forensic reader. */
export async function captureCloudflareQualityHistory(workbench: Pool, first: Pool, second: Pool, quality: Pool, lease: EvaluationLockLease) {
  assertCloudflareAuditPools([workbench, first, second, quality]);
  await assertEvaluationLock(lease);
  const { baseline, raw: baselineInventory } = await captureCloudflareCampaignBaseline(workbench, accountId());
  const firstReport = await readPinnedCloudflareReport('first', lease);
  const firstInventory = await captureCloudflareFirstInventory(first);
  const secondReport = await readPinnedCloudflareReport('second', lease);
  const secondInventory = await captureCloudflareSecondInventory(second);
  const patchReport = await readPinnedCloudflareReport('patch', lease);
  const qualityReport = await readPinnedCloudflareReport('quality', lease);
  const qualityInventory = await captureCloudflareQualityInventory(quality);
  await assertEvaluationLock(lease);
  return { baseline, baselineInventory, firstReport, firstInventory, secondReport, secondInventory, patchReport, qualityReport, qualityInventory };
}

/** Pure staged comparison: no recursive IO wrappers, no extra captures. */
export function compareCloudflareQualityHistory(value: Awaited<ReturnType<typeof captureCloudflareQualityHistory>>) {
  const firstCarry = { ...compareCloudflareCarryForward(value.firstReport, value.baseline, value.firstInventory.snapshot),
    sourceSha256: FIRST_REPORT_SHA256() };
  const secondCarry = { ...compareCloudflareSecondCarryForward(value.secondReport, firstCarry, value.secondInventory.snapshot),
    sourceSha256: SECOND_REPORT_SHA256() };
  const patchCarry = { ...compareCloudflarePatchCarry(value.patchReport, secondCarry), sourceSha256: PATCH_REPORT_SHA256() };
  return { ...compareCloudflareQualityCarry(value.qualityReport, patchCarry, value.qualityInventory.snapshot),
    sourceSha256: QUALITY_REPORT_SHA256() };
}

/** Two linear passes; compare complete raw evidence, not aggregate summaries. */
export async function readCloudflareQualityCarry(workbench: Pool, first: Pool, second: Pool, quality: Pool, lease: EvaluationLockLease) {
  try {
    const capture = () => captureCloudflareQualityHistory(workbench, first, second, quality, lease);
    const before = await capture();
    compareCloudflareQualityHistory(before);
    const after = await capture();
    if (!isDeepStrictEqual(before, after)) fail();
    const result = compareCloudflareQualityHistory(after);
    await assertEvaluationLock(lease);
    return result;
  } catch { return fail(); }
}
