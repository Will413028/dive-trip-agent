import { historyIdentity } from './cloudflare-history-profile.ts';
import { isDeepStrictEqual } from 'node:util';
import type { Pool } from 'pg';
import { z } from 'zod';
import { readPinnedCloudflareReport, PATCH_REPORT_SHA256 } from './pinned-cloudflare-report.ts';
import { SECOND_REPORT_SHA256 } from './cloudflare-artifacts.ts';
import { readCloudflareSecondCarryForward } from './cloudflare-carry-forward-2.ts';
import { assertEvaluationLock, type EvaluationLockLease } from './live-evaluation-lock.ts';
import { usageEvidenceSchema } from './usage-evidence.ts';
import { CLOUDFLARE_MODEL } from '../src/agent/cloudflare-wire.ts';

const runId = () => (historyIdentity('patch_carry_runId_1'));
const accountId = () => (historyIdentity('accountId_1'));
const priorSchema = () => (z.strictObject({ sourceSha256: z.literal(SECOND_REPORT_SHA256()), historyConsistent: z.literal(true),
  dispatchAuthorized: z.literal(false), accountingComplete: z.literal(false), evaluationGatePassed: z.literal(false),
  historicalUnknownReceipts: z.literal(1), invocations: z.literal(9), modelCalls: z.literal(12), chargedMicros: z.literal(188948),
  observedTokens: z.literal(51739), totalTokens: z.null(), remainingInvocationCeiling: z.literal(91), remainingReferenceMicros: z.literal(2811052) }));
const reportSchema = () => (z.object({ model: z.literal(CLOUDFLARE_MODEL), accountId: z.literal(accountId()),
  prior: z.unknown(), stopped: z.null(), textReview: z.literal('pending'), evaluationGatePassed: z.literal(false),
  accountingComplete: z.literal(false), historicalUnknownReceipts: z.literal(1), dispatchAuthorized: z.literal(false),
  invocations: z.literal(1), modelCalls: z.literal(2), chargedMicros: z.literal(1119), totalTokens: z.literal(9453),
  cumulativeInvocations: z.literal(10), cumulativeModelCalls: z.literal(14),
  cumulativeChargedMicros: z.literal(190067), cumulativeTokens: z.null(), records: z.array(z.unknown()).length(2) }));
const auditSchema = () => (z.object({ kind: z.literal('durable-audit'), caseId: z.literal('locked-budget'), round: z.literal(1),
  chargedMicros: z.literal(1119), privateUsageComplete: z.literal(true), quiescent: z.literal(true),
  runs: z.array(z.strictObject({ id: z.literal(runId()), status: z.literal('succeeded'),
    proposal_id: z.null(), interrupt_id: z.null(), decision: z.null() })).length(1),
  privateUsage: z.array(usageEvidenceSchema).length(1) }));

/** Pure export consistency only, not provenance or dispatch authorization.
 * The successful patch DB was cleaned; IO callers pin the export and establish
 * the older retained history before passing its carry into this comparison. */
export function compareCloudflarePatchCarry(reportInput: unknown, priorInput: unknown) {
  try {
    const prior = priorSchema().parse(priorInput);
    const report = reportSchema().parse(reportInput);
    if (!isDeepStrictEqual(report.prior, prior)) throw new Error();
    const audits = report.records.filter(r => r && typeof r === 'object' && 'kind' in r && r.kind === 'durable-audit');
    if (audits.length !== 1) throw new Error();
    const usage = auditSchema().parse(audits[0]).privateUsage[0];
    if (usage.schemaVersion !== 2 || usage.runId !== runId() || usage.binding.accountId !== accountId()
      || usage.invocations.length !== 1 || usage.calls.length !== 2) throw new Error();
    const receipt = usage.invocations[0];
    if (receipt.id !== historyIdentity('patch_carry_receipt_1') || receipt.status !== 'settled'
      || receipt.reservation_status !== 'settled' || receipt.actual_cost_micros !== '1119'
      || receipt.charged_cost_micros !== '1119' || usage.calls.some(c => c.status !== 'completed' || !c.usage)
      || usage.calls.reduce((sum, c) => sum + c.usage!.totalTokens, 0) !== 9453) throw new Error();
    return { historyConsistent: true as const, dispatchAuthorized: false as const, accountingComplete: false as const,
      evaluationGatePassed: false as const, historicalUnknownReceipts: 1 as const,
      invocations: 10, modelCalls: 14, chargedMicros: 190067, observedTokens: 61192, totalTokens: null,
      remainingInvocationCeiling: 90, remainingReferenceMicros: 2809933 };
  } catch { throw new Error('CLOUDFLARE_PATCH_CARRY_INVALID'); }
}

/** Compatibility wrapper: rechecks older histories and the pinned export twice. */
export async function readCloudflarePatchCarry(workbench: Pool, first: Pool, second: Pool, lease: EvaluationLockLease) {
  try {
    await assertEvaluationLock(lease);
    const prior = await readCloudflareSecondCarryForward(workbench, first, second, lease);
    const report = await readPinnedCloudflareReport('patch', lease);
    compareCloudflarePatchCarry(report, prior);
    if (!isDeepStrictEqual(prior, await readCloudflareSecondCarryForward(workbench, first, second, lease))
      || !isDeepStrictEqual(report, await readPinnedCloudflareReport('patch', lease))) throw new Error();
    await assertEvaluationLock(lease);
    return { ...compareCloudflarePatchCarry(report, prior), sourceSha256: PATCH_REPORT_SHA256() };
  } catch { throw new Error('CLOUDFLARE_PATCH_CARRY_INVALID'); }
}
