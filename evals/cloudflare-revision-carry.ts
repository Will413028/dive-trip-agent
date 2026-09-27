import { historyIdentity } from './cloudflare-history-profile.ts';
import { isDeepStrictEqual } from 'node:util';
import type { Pool } from 'pg';
import { z } from 'zod';
import { revisionCarrySchema } from './cloudflare-revision-carry-schema.ts';
import { readPinnedCloudflareReport, QUALITY_REPORT_SHA256, REVISION_REPORT_SHA256 } from './pinned-cloudflare-report.ts';
import { captureCloudflareCampaignInventory, captureCloudflareQualityHistory, compareCloudflareQualityHistory } from './cloudflare-quality-carry.ts';
import { assertEvaluationLock, type EvaluationLockLease } from './live-evaluation-lock.ts';
import { usageEvidenceSchema } from './usage-evidence.ts';
import { CLOUDFLARE_MODEL } from '../src/agent/cloudflare-wire.ts';
import { referenceProviderCost } from '../src/server/model-cost.ts';
import { assertCloudflareAuditPools } from '../tests/support/cloudflare-audit-database.ts';

export { CLOUDFLARE_REVISION_RETAINED_SCHEMA as REVISION_CARRY_SCHEMA } from '../tests/support/cloudflare-audit-database.ts';
const accountId = () => (historyIdentity('accountId_1'));
const unknown = () => ({ run: historyIdentity('revision_carry_unknown_1'), invocation: historyIdentity('revision_carry_unknown_2'),
  reservation: historyIdentity('revision_carry_unknown_3') } as const);
function fail(): never { throw new Error('CLOUDFLARE_REVISION_CARRY_INVALID'); }

export { revisionCarrySchema } from './cloudflare-revision-carry-schema.ts';
const priorSchema = () => (z.strictObject({ sourceSha256: z.literal(QUALITY_REPORT_SHA256()), historyConsistent: z.literal(true),
  dispatchAuthorized: z.literal(false), accountingComplete: z.literal(false), evaluationGatePassed: z.literal(false),
  historicalUnknownReceipts: z.literal(1), invocations: z.literal(26), modelCalls: z.literal(38), chargedMicros: z.literal(204816),
  observedTokens: z.literal(183791), totalTokens: z.null(), remainingInvocationCeiling: z.literal(74), remainingReferenceMicros: z.literal(2795184) }));
const runSchema = z.object({ id: z.uuid(), status: z.enum(['succeeded', 'failed']), proposal_id: z.uuid().nullable(),
  interrupt_id: z.string().nullable(), decision: z.boolean().nullable() });
const eventSchema = z.object({ run_id: z.uuid(), sequence: z.number().int().positive(), event: z.record(z.string(), z.unknown()) });
const auditSchema = z.object({ kind: z.literal('durable-audit'), round: z.number().int(), caseId: z.string(),
  runs: z.array(runSchema).length(1), events: z.array(eventSchema).max(86), privateUsage: z.array(usageEvidenceSchema).length(1),
  chargedMicros: z.number().int().nonnegative(), privateUsageComplete: z.literal(true), quiescent: z.literal(true) });
const attemptSchema = z.object({ round: z.number().int(), caseId: z.string(), evidence: z.object({ runId: z.uuid(),
  afterVersion: z.number().int().positive(), after: z.record(z.string(), z.unknown()) }) });
const skipSchema = z.object({ round: z.number().int(), caseId: z.string(), outcome: z.literal('skipped'), reason: z.literal('UNKNOWN_USAGE_STOP') });
const reportSchema = () => (z.object({ model: z.literal(CLOUDFLARE_MODEL), accountId: z.literal(accountId()), prior: priorSchema(),
  stopped: z.literal('UNKNOWN_USAGE_STOP'), textReview: z.literal('pending'), evaluationGatePassed: z.literal(false),
  accountingComplete: z.literal(false), historicalUnknownReceipts: z.literal(1), dispatchAuthorized: z.literal(false),
  invocations: z.literal(13), modelCalls: z.literal(18), chargedMicros: z.literal(191892), totalTokens: z.null(),
  cumulativeInvocations: z.literal(39), cumulativeModelCalls: z.literal(56), cumulativeChargedMicros: z.literal(396708),
  cumulativeTokens: z.null(), records: z.array(z.unknown()).length(40) }));
const snapshotSchema = z.object({ counts: z.strictObject({ runs: z.literal(9), trips: z.literal(9), invocations: z.literal(13),
  calls: z.literal(18), reservations: z.literal(13), proposals: z.literal(4) }),
  runs: z.array(runSchema.extend({ trip_id: z.uuid(), owner_id: z.uuid(), current_version: z.number().int().positive(), snapshot: z.record(z.string(), z.unknown()) })).length(9),
  events: z.array(eventSchema).length(86), usage: z.array(usageEvidenceSchema).length(9) });

/** Pure consistency only. Hash and local owner baseline are checked by IO. */
export function compareCloudflareRevisionCarry(reportInput: unknown, priorInput: unknown, snapshotInput: unknown) {
  try {
    const report = reportSchema().parse(reportInput), prior = priorSchema().parse(priorInput), snapshot = snapshotSchema.parse(snapshotInput);
    if (!isDeepStrictEqual(report.prior, prior)) fail();
    const rows = report.records.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object');
    const audits = rows.filter(row => row.kind === 'durable-audit').map(row => auditSchema.parse(row));
    const attempts = rows.filter(row => row.evidence !== undefined).map(row => attemptSchema.parse(row));
    const skips = rows.filter(row => row.outcome === 'skipped').map(row => skipSchema.parse(row));
    if (audits.length !== 9 || attempts.length !== 9 || skips.length !== 22
      || rows.some(row => Number(row.kind === 'durable-audit') + Number(row.evidence !== undefined) + Number(row.outcome === 'skipped') !== 1)
      || new Set(audits.map(a => a.runs[0].id)).size !== 9 || new Set(attempts.map(a => a.evidence.runId)).size !== 9
      || new Set(snapshot.runs.map(r => r.id)).size !== 9 || new Set(snapshot.runs.map(r => r.trip_id)).size !== 9
      || new Set(snapshot.usage.map(u => u.runId)).size !== 9 || audits.reduce((sum, a) => sum + a.events.length, 0) !== 86
      || snapshot.events.some(e => !snapshot.runs.some(r => r.id === e.run_id))) fail();
    let charged = 0, known = 0, tokens = 0, invocations = 0, calls = 0, unknowns = 0;
    const receipts = new Set<string>(), reservations = new Set<string>();
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
      if (run.status !== (run.id === unknown().run ? 'failed' : 'succeeded')) fail();
      for (const receipt of usage.invocations) {
        if (receipts.has(receipt.id) || reservations.has(receipt.reservation_id) || receipt.status !== 'settled'
          || receipt.reservation_status !== 'settled') fail();
        receipts.add(receipt.id); reservations.add(receipt.reservation_id);
        const invocationCalls = usage.calls.filter(call => call.invocation_id === receipt.id);
        if (!invocationCalls.length) fail();
        let calculated = 0;
        for (const call of invocationCalls) {
          const value = referenceProviderCost('cloudflare', call.usage, call.provider_evidence ?? undefined);
          if (call.status !== 'completed' || !call.usage || value === null) fail();
          calculated += value; tokens += call.usage.totalTokens;
        }
        if (receipt.id === unknown().invocation) {
          if (run.id !== unknown().run || receipt.reservation_id !== unknown().reservation || receipt.kind !== 'start'
            || receipt.actual_cost_micros !== null || receipt.charged_cost_micros !== '183505' || receipt.max_cost_micros !== '183505') fail();
          unknowns++;
        } else {
          if (run.id === unknown().run || receipt.reservation_id === unknown().reservation || receipt.actual_cost_micros === null
            || receipt.actual_cost_micros !== receipt.charged_cost_micros || calculated !== Number(receipt.actual_cost_micros)) fail();
          known += calculated;
        }
        charged += Number(receipt.charged_cost_micros);
      }
      invocations += usage.invocations.length; calls += usage.calls.length;
      if (audit.chargedMicros !== charged) fail(); // Collector checkpoints are cumulative.
    }
    if (unknowns !== 1 || known !== 8387 || charged !== 191892 || tokens !== 75287 || invocations !== 13 || calls !== 18) fail();
    return { historyConsistent: true as const, dispatchAuthorized: false as const, accountingComplete: false as const,
      evaluationGatePassed: false as const, historicalUnknownReceipts: 2 as const, invocations: 39, modelCalls: 56,
      chargedMicros: 396708, observedTokens: 259078, totalTokens: null, remainingInvocationCeiling: 61, remainingReferenceMicros: 2603292 };
  } catch { return fail(); }
}

/** Closed revision descriptor retains raw rows and its fixed readonly scope. */
export async function captureCloudflareRevisionInventory(revision: Pool) {
  return captureCloudflareCampaignInventory('revision', revision);
}

/** One complete linear capture through revision, retaining unprojected evidence. */
export async function captureCloudflareRevisionHistory(workbench: Pool, first: Pool, second: Pool, quality: Pool, revision: Pool, lease: EvaluationLockLease) {
  assertCloudflareAuditPools([workbench, first, second, quality, revision]);
  const history = await captureCloudflareQualityHistory(workbench, first, second, quality, lease);
  const report = await readPinnedCloudflareReport('revision', lease);
  const inventory = await captureCloudflareRevisionInventory(revision);
  await assertEvaluationLock(lease);
  return { history, report, inventory };
}

/** Pure staged comparison for an outer two-pass reader; no nested IO. */
export function compareCloudflareRevisionHistory(value: Awaited<ReturnType<typeof captureCloudflareRevisionHistory>>) {
  return revisionCarrySchema().parse({ ...compareCloudflareRevisionCarry(
    value.report, compareCloudflareQualityHistory(value.history), value.inventory.snapshot), sourceSha256: REVISION_REPORT_SHA256() });
}

/** Exactly two linear captures through revision; never nest a two-pass reader. */
export async function readCloudflareRevisionCarry(workbench: Pool, first: Pool, second: Pool, quality: Pool, revision: Pool, lease: EvaluationLockLease) {
  try {
    const capture = () => captureCloudflareRevisionHistory(workbench, first, second, quality, revision, lease);
    const before = await capture();
    compareCloudflareRevisionHistory(before);
    const after = await capture();
    if (!isDeepStrictEqual(before, after)) fail();
    const result = compareCloudflareRevisionHistory(after);
    await assertEvaluationLock(lease);
    return result;
  } catch { return fail(); }
}
