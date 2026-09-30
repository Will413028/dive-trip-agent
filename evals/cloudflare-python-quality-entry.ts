import { z } from 'zod';
import { runReviewedCloudflareEntry } from './cloudflare-reviewed-entry';
import { runCloudflarePythonQualityCampaign } from './cloudflare-python-quality-campaign';
import { CARRY_SCHEMA } from './cloudflare-carry-forward';
import { SECOND_CARRY_SCHEMA } from './cloudflare-carry-forward-2';
import { QUALITY_CARRY_SCHEMA } from './cloudflare-quality-carry';
import { REVISION_CARRY_SCHEMA } from './cloudflare-revision-carry';
import { RECOVERY_CARRY_SCHEMA } from './cloudflare-recovery-carry';
import { GROUNDED_CARRY_SCHEMA } from './cloudflare-grounded-carry';
import { NONTHINKING_CARRY_SCHEMA } from './cloudflare-nonthinking-carry';
import { readCloudflarePythonProbe3Carry } from './cloudflare-python-probe-3-carry.ts';
import { claimCloudflareCampaign } from './cloudflare-campaign-claim';
import { awaitCloudflareRecoveryReview } from './cloudflare-recovery-review-wait';
import { recoveryReviewIdentitiesSchema } from './cloudflare-recovery-review';

export const PYTHON_QUALITY_AUTHORIZATION = 'python-quality-two-included-plus-28-210-calls-39-invocations-once-cloudflare-free-tier-confirmed';
const attempt = z.object({ schemaVersion: z.literal(2), round: z.literal(1), caseId: z.string(),
  evidence: z.object({ runId: z.uuid() }) });
const attempts = z.tuple([attempt.extend({ caseId: z.literal('unknown-cost') }),
  attempt.extend({ caseId: z.literal('no-date') })]).refine(rows => rows[0].evidence.runId !== rows[1].evidence.runId);

/** Server-only fixed entry. Prior history is audited before the lazy loader,
 * before every dispatch and before the isolated database can be cleaned. */
export async function runCloudflarePythonQualityEntry() {
  return runReviewedCloudflareEntry({ stem: 'cloudflare-python-quality', liveCampaign: 'cloudflare-python-quality-30-cases',
    authorizationEnv: 'DIVE_TRIP_CLOUDFLARE_PYTHON_QUALITY_AUTHORIZATION', authorization: PYTHON_QUALITY_AUTHORIZATION,
    schemas: () => ['workbench_live', CARRY_SCHEMA(), SECOND_CARRY_SCHEMA(), QUALITY_CARRY_SCHEMA(), REVISION_CARRY_SCHEMA(),
      RECOVERY_CARRY_SCHEMA(), GROUNDED_CARRY_SCHEMA(), NONTHINKING_CARRY_SCHEMA()],
    initialReplays: 2, claim: lease => claimCloudflareCampaign(lease, 'pythonQuality'),
    readCarry: readCloudflarePythonProbe3Carry,
    runCampaign: runCloudflarePythonQualityCampaign,
    reviewBinding: report => {
      const [first, second] = attempts.parse(report.records.filter(row =>
        !!row && typeof row === 'object' && 'evidence' in row));
      return { cases: recoveryReviewIdentitiesSchema.parse([
        { round: first.round, caseId: first.caseId, runId: first.evidence.runId },
        { round: second.round, caseId: second.caseId, runId: second.evidence.runId },
      ]) };
    },
    waitReview: (serialized, binding, lease, record) =>
      awaitCloudflareRecoveryReview(serialized, binding.cases, lease, record, 'pythonQuality'),
  });
}
