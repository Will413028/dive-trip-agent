import { z } from 'zod';
import { historyIdentity } from './cloudflare-history-profile.ts';
import { pythonProbe4CarrySchema } from './cloudflare-python-probe-4-carry.ts';
import { CAMPAIGN_BUDGET_MICROS, CAMPAIGN_INVOCATION_LIMIT } from './campaign-policy.ts';
import { maximumProviderModelCost } from '../src/server/model-cost.ts';
import { CLOUDFLARE_MODEL } from '../src/agent/cloudflare-wire.ts';
import { runFiniteCloudflareCampaign, type CloudflareCampaignReport,
  type FiniteCampaignPorts } from './cloudflare-campaign.ts';

export type CloudflareProbe5Report = Omit<CloudflareCampaignReport,
  'prior' | 'maxModelCalls' | 'cumulativeTokens'> & {
    prior: z.infer<ReturnType<typeof pythonProbe4CarrySchema>>;
    maxModelCalls: 7; maxInvocations: 1; cumulativeTokens: null;
    accountingComplete: false; historicalUnknownReceipts: 7; dispatchAuthorized: false;
    diagnosticComplete: boolean;
  };
type Ports = FiniteCampaignPorts<CloudflareProbe5Report> & {
  accountId: string; prior: z.infer<ReturnType<typeof pythonProbe4CarrySchema>>;
  checkDispatch(signal: AbortSignal): Promise<void>;
};

/** A new one-shot technical run; no outcome here clears either prior stop or
 * satisfies the independent thirty-case quality gate. */
export async function runCloudflareProbe5Campaign(ports: Ports): Promise<CloudflareProbe5Report> {
  const prior = pythonProbe4CarrySchema().parse(ports.prior);
  if (ports.accountId !== historyIdentity('accountId_1') || typeof ports.checkDispatch !== 'function'
    || prior.invocations + 1 > CAMPAIGN_INVOCATION_LIMIT
    || prior.chargedMicros + maximumProviderModelCost('cloudflare') > CAMPAIGN_BUDGET_MICROS) {
    throw new Error('EVAL_INVALID_HISTORY');
  }
  const report: CloudflareProbe5Report = {
    schemaVersion: 2, model: CLOUDFLARE_MODEL, accountId: ports.accountId,
    transport: 'real-cloudflare-via-http-handler', budgetMicros: CAMPAIGN_BUDGET_MICROS,
    maxModelCalls: 7, maxInvocations: 1, prior, chargedMicros: 0, invocations: 0,
    modelCalls: 0, totalTokens: 0, cumulativeChargedMicros: prior.chargedMicros,
    cumulativeInvocations: prior.invocations, cumulativeModelCalls: prior.modelCalls,
    cumulativeTokens: null, accountingComplete: false, historicalUnknownReceipts: 7,
    dispatchAuthorized: false, diagnosticComplete: false, stopped: null, textReview: 'pending',
    evaluationGatePassed: false, records: [],
  };
  await runFiniteCloudflareCampaign(ports, report, {
    slots: [{ round: 1, caseId: 'unknown-cost', maxDispatches: 1 }], maxInvocations: 1,
  });
  if (!report.stopped) {
    report.diagnosticComplete = true;
    await ports.checkpoint(structuredClone(report));
  }
  return report;
}
