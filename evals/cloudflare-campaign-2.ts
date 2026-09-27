import { historyIdentity } from './cloudflare-history-profile.ts';
import { z } from 'zod';
import { CLOUDFLARE_MODEL } from '../src/agent/cloudflare-wire.ts';
import { maximumProviderModelCost } from '../src/server/model-cost.ts';
import { CAMPAIGN_BUDGET_MICROS, CAMPAIGN_INVOCATION_LIMIT } from './campaign-policy.ts';
import { runFiniteCloudflareCampaign, type CloudflareCampaignReport, type FiniteCampaignPorts } from './cloudflare-campaign.ts';
import type { readCloudflareCarryForward } from './cloudflare-carry-forward.ts';

export const CLOUDFLARE_SECOND_CAMPAIGN_AUTHORIZATION = 'second-8-unattempted-cases-cloudflare-free-tier-confirmed';
const caseIds = ['locked-budget', 'free-afternoon', 'more-people', 'unknown-cost',
  'no-date', 'source-injection', 'lookup-timeout', 'impossible'] as const;
const accountId = () => (historyIdentity('accountId_1'));
// Pin the historical contract without importing the carry reader's IO at runtime.
const carrySchema = () => (z.object({
  sourceSha256: z.literal(historyIdentity('artifacts_FIRST_REPORT_SHA256_1')),
  historyConsistent: z.literal(true), dispatchAuthorized: z.literal(false), accountingComplete: z.literal(false),
  evaluationGatePassed: z.literal(false), historicalUnknownReceipts: z.literal(1),
  invocations: z.literal(8), modelCalls: z.literal(11), chargedMicros: z.literal(188267),
  observedTokens: z.literal(46665), totalTokens: z.null(),
  remainingInvocationCeiling: z.literal(92), remainingReferenceMicros: z.literal(2811733),
}));
type CarryForward = Awaited<ReturnType<typeof readCloudflareCarryForward>>;
export type SecondCampaignReport = Omit<CloudflareCampaignReport, 'prior' | 'maxModelCalls' | 'cumulativeTokens'> & {
  prior: CarryForward; maxModelCalls: 56; maxInvocations: 16;
  cumulativeTokens: null; accountingComplete: false; historicalUnknownReceipts: 1;
  dispatchAuthorized: false;
};
type SecondCampaignPorts = FiniteCampaignPorts<SecondCampaignReport> & { accountId: string; prior: CarryForward };

/** Pure finite scheduler, NOT authorization. The live caller must obtain fresh
 * readCloudflareCarryForward evidence under its exclusive lock and perform real
 * admission before every dispatch. A fabricated summary cannot grant permission.
 * totalTokens is NEW batch accounting; cumulativeTokens stays null forever here.
 * prior.observedTokens is historical observation, never a complete token total. */
export async function runCloudflareSecondCampaign(ports: SecondCampaignPorts): Promise<SecondCampaignReport> {
  const parsed = carrySchema().safeParse(ports.prior);
  if (ports.accountId !== accountId() || !parsed.success) throw new Error('EVAL_INVALID_HISTORY');
  const prior = parsed.data;
  if (prior.chargedMicros + maximumProviderModelCost('cloudflare') > CAMPAIGN_BUDGET_MICROS) {
    throw new Error('EVAL_CUMULATIVE_BUDGET_STOP');
  }
  if (prior.invocations + 16 > CAMPAIGN_INVOCATION_LIMIT) throw new Error('EVAL_CUMULATIVE_INVOCATION_STOP');
  const report: SecondCampaignReport = {
    schemaVersion: 2, model: CLOUDFLARE_MODEL, accountId: accountId(), transport: 'real-cloudflare-via-http-handler',
    budgetMicros: CAMPAIGN_BUDGET_MICROS, maxModelCalls: 56, maxInvocations: 16, prior,
    chargedMicros: 0, invocations: 0, modelCalls: 0, totalTokens: 0,
    cumulativeChargedMicros: prior.chargedMicros, cumulativeInvocations: prior.invocations,
    cumulativeModelCalls: prior.modelCalls, cumulativeTokens: null,
    accountingComplete: false, historicalUnknownReceipts: 1, dispatchAuthorized: false,
    stopped: null, textReview: 'pending', evaluationGatePassed: false, records: [],
  };
  return runFiniteCloudflareCampaign(ports, report, {
    slots: caseIds.map(caseId => ({ round: 1, caseId })), maxInvocations: 16,
  });
}
