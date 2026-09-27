import { z } from 'zod';
import { runReviewedCloudflareEntry } from './cloudflare-reviewed-entry';
import { runCloudflareGroundedCampaign } from './cloudflare-grounded-campaign';
import { CARRY_SCHEMA } from './cloudflare-carry-forward';
import { SECOND_CARRY_SCHEMA } from './cloudflare-carry-forward-2';
import { QUALITY_CARRY_SCHEMA } from './cloudflare-quality-carry';
import { REVISION_CARRY_SCHEMA } from './cloudflare-revision-carry';
import { readCloudflareRecoveryCarry, RECOVERY_CARRY_SCHEMA } from './cloudflare-recovery-carry';
import { claimCloudflareCampaign } from './cloudflare-campaign-claim';
import { awaitCloudflareRecoveryReview } from './cloudflare-recovery-review-wait';
import { recoveryReviewIdentitiesSchema } from './cloudflare-recovery-review';

export const GROUNDED_AUTHORIZATION = 'grounded-two-included-plus-28-210-calls-39-invocations-once-cloudflare-free-tier-confirmed';
const attempt = z.object({ schemaVersion: z.literal(2), round: z.literal(1), caseId: z.string(),
  evidence: z.object({ runId: z.uuid() }) });
const attempts = z.tuple([attempt.extend({ caseId: z.literal('unknown-cost') }),
  attempt.extend({ caseId: z.literal('no-date') })]).refine(rows => rows[0].evidence.runId !== rows[1].evidence.runId);

/** New one-shot grant only; consumed recovery flags and claims never authorize it. */
export async function runCloudflareGroundedEntry() {
  return runReviewedCloudflareEntry({ stem: 'cloudflare-grounded', liveCampaign: 'cloudflare-grounded-30-cases',
    authorizationEnv: 'DIVE_TRIP_CLOUDFLARE_GROUNDED_AUTHORIZATION', authorization: GROUNDED_AUTHORIZATION,
    schemas: () => ['workbench_live', CARRY_SCHEMA(), SECOND_CARRY_SCHEMA(), QUALITY_CARRY_SCHEMA(), REVISION_CARRY_SCHEMA(), RECOVERY_CARRY_SCHEMA()],
    initialReplays: 2, claim: lease => claimCloudflareCampaign(lease, 'grounded'),
    readCarry: (pools, lease) => readCloudflareRecoveryCarry(pools[0], pools[1], pools[2], pools[3], pools[4], pools[5], lease),
    runCampaign: runCloudflareGroundedCampaign,
    reviewBinding: report => {
      const [first, second] = attempts.parse(report.records.filter(row =>
        !!row && typeof row === 'object' && 'evidence' in row));
      return { cases: recoveryReviewIdentitiesSchema.parse([
        { round: first.round, caseId: first.caseId, runId: first.evidence.runId },
        { round: second.round, caseId: second.caseId, runId: second.evidence.runId },
      ]) };
    },
    waitReview: (serialized, binding, lease, record) =>
      awaitCloudflareRecoveryReview(serialized, binding.cases, lease, record, 'grounded'),
  });
}
