import { z } from 'zod';
import { runReviewedCloudflareEntry } from './cloudflare-reviewed-entry';
import { runCloudflareNonthinkingCampaign } from './cloudflare-nonthinking-campaign';
import { CARRY_SCHEMA } from './cloudflare-carry-forward';
import { SECOND_CARRY_SCHEMA } from './cloudflare-carry-forward-2';
import { QUALITY_CARRY_SCHEMA } from './cloudflare-quality-carry';
import { REVISION_CARRY_SCHEMA } from './cloudflare-revision-carry';
import { RECOVERY_CARRY_SCHEMA } from './cloudflare-recovery-carry';
import { readCloudflareGroundedCarry, GROUNDED_CARRY_SCHEMA } from './cloudflare-grounded-carry';
import { claimCloudflareCampaign } from './cloudflare-campaign-claim';
import { awaitCloudflarePreflightReview } from './cloudflare-preflight-review';

export const NONTHINKING_AUTHORIZATION = 'nonthinking-unknown-cost-once-7-calls-1-start-cloudflare-free-tier-confirmed';
const attempt = z.object({ schemaVersion: z.literal(2), round: z.literal(1), caseId: z.literal('unknown-cost'),
  evidence: z.object({ runId: z.uuid() }) });

/** Separate claim from the consumed grounded campaign; no old grant can enter. */
export async function runCloudflareNonthinkingEntry() {
  return runReviewedCloudflareEntry({ stem: 'cloudflare-nonthinking', liveCampaign: 'cloudflare-nonthinking-one-case',
    authorizationEnv: 'DIVE_TRIP_CLOUDFLARE_NONTHINKING_AUTHORIZATION', authorization: NONTHINKING_AUTHORIZATION,
    schemas: () => ['workbench_live', CARRY_SCHEMA(), SECOND_CARRY_SCHEMA(), QUALITY_CARRY_SCHEMA(), REVISION_CARRY_SCHEMA(),
      RECOVERY_CARRY_SCHEMA(), GROUNDED_CARRY_SCHEMA()], initialReplays: 1,
    claim: lease => claimCloudflareCampaign(lease, 'nonthinking'),
    readCarry: (pools, lease) => readCloudflareGroundedCarry(pools[0], pools[1], pools[2], pools[3], pools[4], pools[5], pools[6], lease),
    runCampaign: runCloudflareNonthinkingCampaign,
    reviewBinding: report => {
      const [first] = z.tuple([attempt]).parse(report.records.filter(row =>
        !!row && typeof row === 'object' && 'evidence' in row));
      return { runId: first.evidence.runId };
    },
    waitReview: (serialized, binding, lease, record) =>
      awaitCloudflarePreflightReview(serialized, binding.runId, lease, record, 'nonthinking'),
  });
}
