import { createHash } from 'node:crypto';
import type { z } from 'zod';
import type { EvaluationLockLease } from './live-evaluation-lock.ts';
import { awaitCloudflareReview } from './cloudflare-review-wait.ts';
import { recoveryReviewSchema, recoveryReviewIdentitiesSchema, recoveryReviewPasses,
  type RecoveryReviewCases } from './cloudflare-recovery-review.ts';

/** Bind both cases to one immutable checkpoint; prose decisions come from reviewers. */
export async function awaitCloudflareRecoveryReview(serializedReport: string,
  cases: RecoveryReviewCases, lease: EvaluationLockLease,
  recordReview: (review: z.infer<typeof recoveryReviewSchema>, passed: boolean) => Promise<void>,
  kind: 'recovery' | 'grounded' | 'diagnostic' = 'recovery'): Promise<boolean> {
  const expected = { sourceSha256: createHash('sha256').update(serializedReport).digest('hex'),
    cases: recoveryReviewIdentitiesSchema.parse(cases) };
  return awaitCloudflareReview(lease, kind, async input => {
    const review = recoveryReviewSchema.parse(input);
    const passed = recoveryReviewPasses(review, expected);
    await recordReview(structuredClone(review), passed);
    return passed;
  });
}
