import { z } from 'zod';
import { runReviewedCloudflareEntry } from './cloudflare-reviewed-entry';
import { runCloudflareRecoveryCampaign } from './cloudflare-recovery-campaign';
import { CARRY_SCHEMA } from './cloudflare-carry-forward';
import { SECOND_CARRY_SCHEMA } from './cloudflare-carry-forward-2';
import { QUALITY_CARRY_SCHEMA } from './cloudflare-quality-carry';
import { readCloudflareRevisionCarry, REVISION_CARRY_SCHEMA } from './cloudflare-revision-carry';
import { claimCloudflareRecoveryCampaign } from './cloudflare-recovery-claim';
import { awaitCloudflareRecoveryReview } from './cloudflare-recovery-review-wait';
import { recoveryReviewIdentitiesSchema } from './cloudflare-recovery-review';

export const RECOVERY_AUTHORIZATION = 'two-included-preflights-plus-28-once-cloudflare-free-tier-confirmed';
const attempt = z.object({ round: z.literal(1), caseId: z.string(), evidence: z.object({ runId: z.uuid() }) });
const attempts = z.tuple([attempt.extend({ caseId: z.literal('unknown-cost') }),
  attempt.extend({ caseId: z.literal('no-date') })]).refine(rows => rows[0].evidence.runId !== rows[1].evidence.runId);

/** New one-shot scope. Preparation/old opt-ins do not authorize this entry. */
export async function runCloudflareRecoveryEntry() {
  return runReviewedCloudflareEntry({ stem: 'cloudflare-recovery',
    authorizationEnv: 'DIVE_TRIP_CLOUDFLARE_RECOVERY_AUTHORIZATION', authorization: RECOVERY_AUTHORIZATION,
    schemas: () => ['workbench_live', CARRY_SCHEMA(), SECOND_CARRY_SCHEMA(), QUALITY_CARRY_SCHEMA(), REVISION_CARRY_SCHEMA()], initialReplays: 2,
    claim: claimCloudflareRecoveryCampaign,
    readCarry: (pools, lease) => readCloudflareRevisionCarry(pools[0], pools[1], pools[2], pools[3], pools[4], lease),
    runCampaign: runCloudflareRecoveryCampaign,
    reviewBinding: report => {
      const [first, second] = attempts.parse(report.records.filter(row =>
        !!row && typeof row === 'object' && 'evidence' in row));
      return { cases: recoveryReviewIdentitiesSchema.parse([
        { round: first.round, caseId: first.caseId, runId: first.evidence.runId },
        { round: second.round, caseId: second.caseId, runId: second.evidence.runId },
      ]) };
    },
    waitReview: (serialized, binding, lease, record) =>
      awaitCloudflareRecoveryReview(serialized, binding.cases, lease, record),
  });
}
