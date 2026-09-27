import { runReviewedCloudflareEntry } from './cloudflare-reviewed-entry';
import { runCloudflareRevisionCampaign } from './cloudflare-revision-campaign';
import { CARRY_SCHEMA } from './cloudflare-carry-forward';
import { SECOND_CARRY_SCHEMA } from './cloudflare-carry-forward-2';
import { claimCloudflareRevisionCampaign } from './cloudflare-revision-claim';
import { readCloudflareQualityCarry, QUALITY_CARRY_SCHEMA } from './cloudflare-quality-carry';
import { awaitCloudflarePreflightReview } from './cloudflare-preflight-review';

export const REVISION_AUTHORIZATION = 'non-diver-preflight-plus-30-once-cloudflare-free-tier-confirmed';

/** Historical policy preserved; its consumed permanent claim is never reset. */
export async function runCloudflareRevisionEntry() {
  return runReviewedCloudflareEntry({ stem: 'cloudflare-revision',
    authorizationEnv: 'DIVE_TRIP_CLOUDFLARE_REVISION_AUTHORIZATION', authorization: REVISION_AUTHORIZATION,
    schemas: () => ['workbench_live', CARRY_SCHEMA(), SECOND_CARRY_SCHEMA(), QUALITY_CARRY_SCHEMA()], initialReplays: 1,
    claim: claimCloudflareRevisionCampaign,
    readCarry: (pools, lease) => readCloudflareQualityCarry(pools[0], pools[1], pools[2], pools[3], lease),
    runCampaign: runCloudflareRevisionCampaign,
    reviewBinding: report => {
      const first = report.records.find((r): r is { evidence: { runId: string } } =>
        !!r && typeof r === 'object' && 'evidence' in r);
      if (!first) throw new Error('EVAL_INVALID_REVIEW_SCOPE');
      return { runId: first.evidence.runId };
    },
    waitReview: (serialized, binding, lease, record) =>
      awaitCloudflarePreflightReview(serialized, binding.runId, lease, record, 'revision'),
  });
}
