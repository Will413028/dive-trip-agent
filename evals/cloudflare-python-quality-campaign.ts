import { historyIdentity } from './cloudflare-history-profile.ts';
import { z } from 'zod';
import { CLOUDFLARE_MODEL } from '../src/agent/cloudflare-wire.ts';
import { maximumProviderModelCost } from '../src/server/model-cost.ts';
import { CAMPAIGN_BUDGET_MICROS, CAMPAIGN_INVOCATION_LIMIT } from './campaign-policy.ts';
import type { CloudflareCampaignReport, FiniteCampaignPorts } from './cloudflare-campaign.ts';
import { runIncludedCloudflareCampaign } from './cloudflare-included-campaign.ts';
import { pythonProbe3CarrySchema } from './cloudflare-python-probe-3-carry.ts';

export type PythonQualityCampaignReport = Omit<CloudflareCampaignReport, 'prior' | 'cumulativeTokens'> & {
  prior: z.infer<ReturnType<typeof pythonProbe3CarrySchema>>; maxInvocations: 39; cumulativeTokens: null;
  accountingComplete: false; historicalUnknownReceipts: 5; dispatchAuthorized: false;
};
type Ports = FiniteCampaignPorts<PythonQualityCampaignReport> & {
  accountId: string; prior: z.infer<ReturnType<typeof pythonProbe3CarrySchema>>;
  checkDispatch(signal: AbortSignal): Promise<void>;
  reviewPreflight(report: PythonQualityCampaignReport): Promise<boolean>;
};

/** New bounded grant after transport diagnostics; none of the twelve consumed
 * grants or unknown receipts is reopened. The shared scheduler never retries. */
export async function runCloudflarePythonQualityCampaign(ports: Ports): Promise<PythonQualityCampaignReport> {
  const prior = pythonProbe3CarrySchema().parse(ports.prior);
  if (ports.accountId !== historyIdentity('accountId_1') || typeof ports.checkDispatch !== 'function'
    || typeof ports.reviewPreflight !== 'function' || prior.invocations + 39 > CAMPAIGN_INVOCATION_LIMIT
    || prior.chargedMicros + maximumProviderModelCost('cloudflare') > CAMPAIGN_BUDGET_MICROS) throw new Error('EVAL_INVALID_HISTORY');
  const report: PythonQualityCampaignReport = {
    schemaVersion: 2, model: CLOUDFLARE_MODEL, accountId: ports.accountId, transport: 'real-cloudflare-via-http-handler',
    budgetMicros: CAMPAIGN_BUDGET_MICROS, maxModelCalls: 210, maxInvocations: 39, prior,
    chargedMicros: 0, invocations: 0, modelCalls: 0, totalTokens: 0,
    cumulativeChargedMicros: prior.chargedMicros, cumulativeInvocations: prior.invocations,
    cumulativeModelCalls: prior.modelCalls, cumulativeTokens: null, accountingComplete: false,
    historicalUnknownReceipts: 5, dispatchAuthorized: false, stopped: null,
    textReview: 'pending', evaluationGatePassed: false, records: [],
  };
  return runIncludedCloudflareCampaign(ports, report);
}
