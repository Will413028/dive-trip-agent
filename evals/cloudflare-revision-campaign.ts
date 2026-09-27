import { historyIdentity } from './cloudflare-history-profile.ts';
import { z } from 'zod';
import cases from './cases.json' with { type: 'json' };
import { CLOUDFLARE_MODEL } from '../src/agent/cloudflare-wire.ts';
import { maximumProviderModelCost } from '../src/server/model-cost.ts';
import { CAMPAIGN_BUDGET_MICROS, CAMPAIGN_INVOCATION_LIMIT } from './campaign-policy.ts';
import type { CloudflareCampaignReport, FiniteCampaignPorts } from './cloudflare-campaign.ts';
import { runReviewedCloudflareCampaign } from './cloudflare-reviewed-campaign.ts';
import { gradeEvidenceV2 } from './evidence.ts';
import { QUALITY_REPORT_SHA256 } from './cloudflare-artifacts.ts';
import type { readCloudflareQualityCarry } from './cloudflare-quality-carry.ts';

const carrySchema = () => (z.strictObject({ sourceSha256: z.literal(QUALITY_REPORT_SHA256()),
  historyConsistent: z.literal(true), dispatchAuthorized: z.literal(false), accountingComplete: z.literal(false),
  evaluationGatePassed: z.literal(false), historicalUnknownReceipts: z.literal(1),
  invocations: z.literal(26), modelCalls: z.literal(38), chargedMicros: z.literal(204816),
  observedTokens: z.literal(183791), totalTokens: z.null(),
  remainingInvocationCeiling: z.literal(74), remainingReferenceMicros: z.literal(2795184),
}));
export type RevisionCampaignReport = Omit<CloudflareCampaignReport, 'prior' | 'maxModelCalls' | 'cumulativeTokens'> & {
  prior: z.infer<ReturnType<typeof carrySchema>>; maxModelCalls: 217; maxInvocations: 62; cumulativeTokens: null;
  accountingComplete: false; historicalUnknownReceipts: 1; dispatchAuthorized: false;
};
type Ports = FiniteCampaignPorts<RevisionCampaignReport> & {
  accountId: string; prior: Awaited<ReturnType<typeof readCloudflareQualityCarry>>;
  checkDispatch(signal: AbortSignal): Promise<void>;
  reviewPreflight(report: RevisionCampaignReport): Promise<boolean>;
};

/** Scope approved for preparation: non-diver then 10×3, at most 217 calls.
 * Injected trusted ports are NOT permission to send; the separate entry must
 * establish a new grant, permanent claim and hash-bound review. */
export async function runCloudflareRevisionCampaign(ports: Ports): Promise<RevisionCampaignReport> {
  const prior = carrySchema().parse(ports.prior);
  if (ports.accountId !== historyIdentity('accountId_1') || typeof ports.checkDispatch !== 'function'
    || typeof ports.reviewPreflight !== 'function' || prior.invocations + 62 > CAMPAIGN_INVOCATION_LIMIT
    || prior.chargedMicros + maximumProviderModelCost('cloudflare') > CAMPAIGN_BUDGET_MICROS) throw new Error('EVAL_INVALID_HISTORY');
  const report: RevisionCampaignReport = {
    schemaVersion: 2, model: CLOUDFLARE_MODEL, accountId: ports.accountId, transport: 'real-cloudflare-via-http-handler',
    budgetMicros: CAMPAIGN_BUDGET_MICROS, maxModelCalls: 217, maxInvocations: 62, prior,
    chargedMicros: 0, invocations: 0, modelCalls: 0, totalTokens: 0,
    cumulativeChargedMicros: prior.chargedMicros, cumulativeInvocations: prior.invocations,
    cumulativeModelCalls: prior.modelCalls, cumulativeTokens: null, accountingComplete: false,
    historicalUnknownReceipts: 1, dispatchAuthorized: false, stopped: null,
    textReview: 'pending', evaluationGatePassed: false, records: [],
  };
  const guarded = { ...ports, checkPreflight: (saved: RevisionCampaignReport) => {
    const attempts = saved.records.filter((row): row is { evidence: unknown } =>
      !!row && typeof row === 'object' && 'evidence' in row);
    // Preserve the attempt in the report even when its requested change missed.
    return attempts.length === 1 && gradeEvidenceV2(attempts[0].evidence, CLOUDFLARE_MODEL)
      .reasons.every(reason => reason === 'TEXT_REVIEW_REQUIRED');
  } };
  return runReviewedCloudflareCampaign(guarded, report, 'non-diver',
    [1, 2, 3].flatMap(round => cases.map(spec => ({ round, caseId: spec.id }))), 62);
}
