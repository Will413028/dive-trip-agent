import { historyIdentity } from './cloudflare-history-profile.ts';
import { z } from 'zod';
import { CLOUDFLARE_MODEL } from '../src/agent/cloudflare-wire.ts';
import { maximumProviderModelCost } from '../src/server/model-cost.ts';
import { CAMPAIGN_BUDGET_MICROS, CAMPAIGN_INVOCATION_LIMIT } from './campaign-policy.ts';
import type { CloudflareCampaignReport, FiniteCampaignPorts } from './cloudflare-campaign.ts';
import { runIncludedCloudflareCampaign } from './cloudflare-included-campaign.ts';
import { nonthinkingCarrySchema } from './cloudflare-nonthinking-carry-schema.ts';

export type DiagnosticCampaignReport = Omit<CloudflareCampaignReport, 'prior' | 'cumulativeTokens'> & {
  prior: z.infer<ReturnType<typeof nonthinkingCarrySchema>>; maxInvocations: 39; cumulativeTokens: null;
  accountingComplete: false; historicalUnknownReceipts: 4; dispatchAuthorized: false;
};
type Ports = FiniteCampaignPorts<DiagnosticCampaignReport> & {
  accountId: string; prior: z.infer<ReturnType<typeof nonthinkingCarrySchema>>;
  checkDispatch(signal: AbortSignal): Promise<void>;
  reviewPreflight(report: DiagnosticCampaignReport): Promise<boolean>;
};

/** New bounded grant after transport diagnostics; none of the eight consumed
 * grants or unknown receipts is reopened. The shared scheduler never retries. */
export async function runCloudflareDiagnosticCampaign(ports: Ports): Promise<DiagnosticCampaignReport> {
  const prior = nonthinkingCarrySchema().parse(ports.prior);
  if (ports.accountId !== historyIdentity('accountId_1') || typeof ports.checkDispatch !== 'function'
    || typeof ports.reviewPreflight !== 'function' || prior.invocations + 39 > CAMPAIGN_INVOCATION_LIMIT
    || prior.chargedMicros + maximumProviderModelCost('cloudflare') > CAMPAIGN_BUDGET_MICROS) throw new Error('EVAL_INVALID_HISTORY');
  const report: DiagnosticCampaignReport = {
    schemaVersion: 2, model: CLOUDFLARE_MODEL, accountId: ports.accountId, transport: 'real-cloudflare-via-http-handler',
    budgetMicros: CAMPAIGN_BUDGET_MICROS, maxModelCalls: 210, maxInvocations: 39, prior,
    chargedMicros: 0, invocations: 0, modelCalls: 0, totalTokens: 0,
    cumulativeChargedMicros: prior.chargedMicros, cumulativeInvocations: prior.invocations,
    cumulativeModelCalls: prior.modelCalls, cumulativeTokens: null, accountingComplete: false,
    historicalUnknownReceipts: 4, dispatchAuthorized: false, stopped: null,
    textReview: 'pending', evaluationGatePassed: false, records: [],
  };
  return runIncludedCloudflareCampaign(ports, report);
}
