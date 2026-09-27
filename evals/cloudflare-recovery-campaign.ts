import { historyIdentity } from './cloudflare-history-profile.ts';
import { z } from 'zod';
import cases from './cases.json' with { type: 'json' };
import { CLOUDFLARE_MODEL } from '../src/agent/cloudflare-wire.ts';
import { maximumProviderModelCost } from '../src/server/model-cost.ts';
import { CAMPAIGN_BUDGET_MICROS, CAMPAIGN_INVOCATION_LIMIT } from './campaign-policy.ts';
import type { CloudflareCampaignReport, FiniteCampaignPorts } from './cloudflare-campaign.ts';
import { runReviewedCloudflareCampaign } from './cloudflare-reviewed-campaign.ts';
import { revisionCarrySchema } from './cloudflare-revision-carry-schema.ts';
import { gradeEvidenceV2 } from './evidence.ts';

export type RecoveryCampaignReport = Omit<CloudflareCampaignReport, 'prior' | 'cumulativeTokens'> & {
  prior: z.infer<ReturnType<typeof revisionCarrySchema>>; maxInvocations: 60; cumulativeTokens: null;
  accountingComplete: false; historicalUnknownReceipts: 2; dispatchAuthorized: false;
};
type Ports = FiniteCampaignPorts<RecoveryCampaignReport> & {
  accountId: string; prior: z.infer<ReturnType<typeof revisionCarrySchema>>;
  checkDispatch(signal: AbortSignal): Promise<void>;
  /** Adapter must bind BOTH cases to primary + independent prose review. */
  reviewPreflight(report: RecoveryCampaignReport): Promise<boolean>;
};

/** Offline preparation only: no grant, credential loader or live entry.
 * Two reviewed cases are part of the thirty-slot denominator, never round zero.
 * Injected ports do not provide authorization to send model requests. */
export async function runCloudflareRecoveryCampaign(ports: Ports): Promise<RecoveryCampaignReport> {
  const prior = revisionCarrySchema().parse(ports.prior);
  if (ports.accountId !== historyIdentity('accountId_1') || typeof ports.checkDispatch !== 'function'
    || typeof ports.reviewPreflight !== 'function' || prior.invocations + 60 > CAMPAIGN_INVOCATION_LIMIT
    || prior.chargedMicros + maximumProviderModelCost('cloudflare') > CAMPAIGN_BUDGET_MICROS) throw new Error('EVAL_INVALID_HISTORY');
  const first = ['unknown-cost', 'no-date'];
  const report: RecoveryCampaignReport = {
    schemaVersion: 2, model: CLOUDFLARE_MODEL, accountId: ports.accountId, transport: 'real-cloudflare-via-http-handler',
    budgetMicros: CAMPAIGN_BUDGET_MICROS, maxModelCalls: 210, maxInvocations: 60, prior,
    chargedMicros: 0, invocations: 0, modelCalls: 0, totalTokens: 0,
    cumulativeChargedMicros: prior.chargedMicros, cumulativeInvocations: prior.invocations,
    cumulativeModelCalls: prior.modelCalls, cumulativeTokens: null, accountingComplete: false,
    historicalUnknownReceipts: 2, dispatchAuthorized: false, stopped: null,
    textReview: 'pending', evaluationGatePassed: false, records: [],
  };
  const guarded = { ...ports, checkPreflight: (saved: RecoveryCampaignReport) => {
    const attempts = saved.records.filter((row): row is { evidence: unknown } =>
      !!row && typeof row === 'object' && 'evidence' in row);
    return attempts.length > 0 && attempts.length <= 2 && attempts.every(row =>
      gradeEvidenceV2(row.evidence, CLOUDFLARE_MODEL).reasons.every(reason => reason === 'TEXT_REVIEW_REQUIRED'));
  } };
  return runReviewedCloudflareCampaign(guarded, report,
    first.map(caseId => ({ round: 1, caseId })),
    [1, 2, 3].flatMap(round => cases.filter(spec => round !== 1 || !first.includes(spec.id))
      .map(spec => ({ round, caseId: spec.id }))), 60);
}
