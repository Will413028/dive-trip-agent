import cases from './cases.json' with { type: 'json' };
import { CLOUDFLARE_MODEL } from '../src/agent/cloudflare-wire.ts';
import { gradeEvidenceV2 } from './evidence.ts';
import type { CampaignSlot, FiniteCampaignPorts, runFiniteCloudflareCampaign } from './cloudflare-campaign.ts';
import { runReviewedCloudflareCampaign } from './cloudflare-reviewed-campaign.ts';

type Report = Parameters<typeof runFiniteCloudflareCampaign>[1];
const first = ['unknown-cost', 'no-date'];
const slot = (round: number, caseId: string): CampaignSlot => ({ round, caseId,
  maxDispatches: cases.find(spec => spec.id === caseId)?.terminal === 'proposal' ? 2 : 1 });

/** Scheduling shared by separately authorized two-included-case policies.
 * Callers still validate their own pinned prior and construct a fresh report.
 * No authorization, history, credential or filesystem policy is inferred here. */
export async function runIncludedCloudflareCampaign<R extends Report>(
  ports: FiniteCampaignPorts<R> & { reviewPreflight(report: R): Promise<boolean> }, report: R,
): Promise<R> {
  const preflight = first.map(caseId => slot(1, caseId));
  const remaining = [1, 2, 3].flatMap(round => cases.filter(spec => round !== 1 || !first.includes(spec.id))
    .map(spec => slot(round, spec.id)));
  const all = [...preflight, ...remaining];
  if (all.length !== 30 || new Set(all.map(s => `${s.round}:${s.caseId}`)).size !== 30
    || all.reduce((sum, s) => sum + s.maxDispatches!, 0) !== 39) throw new Error('EVAL_INVALID_SCHEDULE');
  // Recompute from collector evidence, never trust its supplied grade. Apply to
  // all 30 slots, not only the two preflight cases; preserve the actual failed
  // task and its durable accounting before recording the remaining skips.
  const guarded = { ...ports, checkResult: (result: Awaited<ReturnType<typeof ports.execute>>) =>
    gradeEvidenceV2(result.evidence, CLOUDFLARE_MODEL).reasons.every(reason => reason === 'TEXT_REVIEW_REQUIRED') };
  return runReviewedCloudflareCampaign(guarded, report, preflight, remaining, 39);
}
