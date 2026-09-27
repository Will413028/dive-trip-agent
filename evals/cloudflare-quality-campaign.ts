import { historyIdentity } from './cloudflare-history-profile.ts';
import { z } from 'zod';
import cases from './cases.json' with { type: 'json' };
import { CLOUDFLARE_MODEL } from '../src/agent/cloudflare-wire.ts';
import { maximumProviderModelCost } from '../src/server/model-cost.ts';
import { CAMPAIGN_BUDGET_MICROS, CAMPAIGN_INVOCATION_LIMIT } from './campaign-policy.ts';
import { type CloudflareCampaignReport, type FiniteCampaignPorts } from './cloudflare-campaign.ts';
import { runReviewedCloudflareCampaign } from './cloudflare-reviewed-campaign.ts';
import type { readCloudflarePatchCarry } from './cloudflare-patch-carry.ts';
import { PATCH_REPORT_SHA256 } from './cloudflare-artifacts.ts';

export const QUALITY_AUTHORIZATION = 'budget-preflight-plus-30-once-cloudflare-free-tier-confirmed';
const accountId = () => (historyIdentity('accountId_1'));
const carrySchema = () => (z.strictObject({
  sourceSha256: z.literal(PATCH_REPORT_SHA256()),
  historyConsistent: z.literal(true), dispatchAuthorized: z.literal(false), accountingComplete: z.literal(false),
  evaluationGatePassed: z.literal(false), historicalUnknownReceipts: z.literal(1),
  invocations: z.literal(10), modelCalls: z.literal(14), chargedMicros: z.literal(190067),
  observedTokens: z.literal(61192), totalTokens: z.null(),
  remainingInvocationCeiling: z.literal(90), remainingReferenceMicros: z.literal(2809933),
}));
type Carry = Awaited<ReturnType<typeof readCloudflarePatchCarry>>;
export type QualityCampaignReport = Omit<CloudflareCampaignReport, 'prior' | 'maxModelCalls' | 'cumulativeTokens'> & {
  prior: Carry; maxModelCalls: 217; maxInvocations: 62; cumulativeTokens: null;
  accountingComplete: false; historicalUnknownReceipts: 1; dispatchAuthorized: false;
};
type Ports = FiniteCampaignPorts<QualityCampaignReport> & {
  accountId: string; prior: Carry;
  /** Called only after preflight capture/checkpoint; no later dispatch until an
   * independent hash-bound prose review passes. Does not authorize a retry. */
  reviewPreflight(report: QualityCampaignReport): Promise<boolean>;
};

export async function runCloudflareQualityCampaign(ports: Ports): Promise<QualityCampaignReport> {
  const prior = carrySchema().parse(ports.prior);
  if (ports.accountId !== accountId() || prior.invocations + 62 > CAMPAIGN_INVOCATION_LIMIT
    || prior.chargedMicros + maximumProviderModelCost('cloudflare') > CAMPAIGN_BUDGET_MICROS) throw new Error('EVAL_INVALID_HISTORY');
  const report: QualityCampaignReport = {
    schemaVersion: 2, model: CLOUDFLARE_MODEL, accountId: accountId(), transport: 'real-cloudflare-via-http-handler',
    budgetMicros: CAMPAIGN_BUDGET_MICROS, maxModelCalls: 217, maxInvocations: 62, prior,
    chargedMicros: 0, invocations: 0, modelCalls: 0, totalTokens: 0,
    cumulativeChargedMicros: prior.chargedMicros, cumulativeInvocations: prior.invocations,
    cumulativeModelCalls: prior.modelCalls, cumulativeTokens: null, accountingComplete: false,
    historicalUnknownReceipts: 1, dispatchAuthorized: false, stopped: null,
    textReview: 'pending', evaluationGatePassed: false, records: [],
  };
  return runReviewedCloudflareCampaign(ports, report, 'locked-budget',
    [1, 2, 3].flatMap(round => cases.map(spec => ({ round, caseId: spec.id }))), 62);
}
