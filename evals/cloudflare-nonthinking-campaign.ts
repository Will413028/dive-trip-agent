import { historyIdentity } from './cloudflare-history-profile.ts';
import { z } from 'zod';
import { CLOUDFLARE_MODEL } from '../src/agent/cloudflare-wire.ts';
import { maximumProviderModelCost } from '../src/server/model-cost.ts';
import { CAMPAIGN_BUDGET_MICROS, CAMPAIGN_INVOCATION_LIMIT } from './campaign-policy.ts';
import type { CloudflareCampaignReport, FiniteCampaignPorts } from './cloudflare-campaign.ts';
import { runReviewedCloudflareCampaign } from './cloudflare-reviewed-campaign.ts';
import { groundedCarrySchema } from './cloudflare-grounded-carry-schema.ts';
import { gradeEvidenceV2 } from './evidence.ts';

export type NonthinkingCampaignReport = Omit<CloudflareCampaignReport, 'prior' | 'maxModelCalls' | 'cumulativeTokens'> & {
  prior: z.infer<ReturnType<typeof groundedCarrySchema>>; maxModelCalls: 7; maxInvocations: 1; cumulativeTokens: null;
  accountingComplete: false; historicalUnknownReceipts: 3; dispatchAuthorized: false;
};
type Ports = FiniteCampaignPorts<NonthinkingCampaignReport> & {
  accountId: string; prior: z.infer<ReturnType<typeof groundedCarrySchema>>;
  checkDispatch(signal: AbortSignal): Promise<void>;
  reviewPreflight(report: NonthinkingCampaignReport): Promise<boolean>;
};

/** One new grant, one read-only case, no continuation slots or automatic retry.
 * The shared review barrier validates this final case before DB cleanup; it does
 * not authorize another case, alter historical grades or imply the 30-case gate. */
export async function runCloudflareNonthinkingCampaign(ports: Ports): Promise<NonthinkingCampaignReport> {
  const prior = groundedCarrySchema().parse(ports.prior);
  if (ports.accountId !== historyIdentity('accountId_1') || typeof ports.checkDispatch !== 'function'
    || typeof ports.reviewPreflight !== 'function' || prior.invocations + 1 > CAMPAIGN_INVOCATION_LIMIT
    || prior.chargedMicros + maximumProviderModelCost('cloudflare') > CAMPAIGN_BUDGET_MICROS) throw new Error('EVAL_INVALID_HISTORY');
  const report: NonthinkingCampaignReport = {
    schemaVersion: 2, model: CLOUDFLARE_MODEL, accountId: ports.accountId, transport: 'real-cloudflare-via-http-handler',
    budgetMicros: CAMPAIGN_BUDGET_MICROS, maxModelCalls: 7, maxInvocations: 1, prior,
    chargedMicros: 0, invocations: 0, modelCalls: 0, totalTokens: 0,
    cumulativeChargedMicros: prior.chargedMicros, cumulativeInvocations: prior.invocations,
    cumulativeModelCalls: prior.modelCalls, cumulativeTokens: null, accountingComplete: false,
    historicalUnknownReceipts: 3, dispatchAuthorized: false, stopped: null,
    textReview: 'pending', evaluationGatePassed: false, records: [],
  };
  return runReviewedCloudflareCampaign({ ...ports, checkPreflight: saved => {
    const attempts = saved.records.filter((row): row is { evidence: unknown } =>
      !!row && typeof row === 'object' && 'evidence' in row);
    return attempts.length === 1 && gradeEvidenceV2(attempts[0].evidence, CLOUDFLARE_MODEL).reasons
      .every(reason => reason === 'TEXT_REVIEW_REQUIRED');
  } }, report, [{ round: 1, caseId: 'unknown-cost', maxDispatches: 1 }], [], 1);
}
