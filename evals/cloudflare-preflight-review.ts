import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { EvaluationLockLease } from './live-evaluation-lock.ts';
import { awaitCloudflareReview } from './cloudflare-review-wait.ts';
import { reviewSchema } from './cloudflare-review-schema.ts';
export { reviewSchema } from './cloudflare-review-schema.ts';

export function preflightReviewPasses(input: unknown, expected: { sourceSha256: string; runId: string }) {
  const review = reviewSchema.parse(input);
  return review.sourceSha256 === expected.sourceSha256 && review.runId === expected.runId
    && review.textReview === 'passed' && review.findings.length === 0;
}

/** Wait for an agent/operator's bounded local prose review, never for a model.
 * Only absence is polled. Malformed/negative/stale evidence stops immediately. */
export async function awaitCloudflarePreflightReview(serializedReport: string, runId: string, lease: EvaluationLockLease,
  recordReview: (review: z.infer<typeof reviewSchema>, passed: boolean) => Promise<void>,
  kind: 'quality' | 'revision' | 'nonthinking' = 'quality') {
  if (kind !== 'quality' && kind !== 'revision' && kind !== 'nonthinking') throw new Error('EVAL_INVALID_REVIEW_SCOPE');
  const sourceSha256 = createHash('sha256').update(serializedReport).digest('hex');
  return awaitCloudflareReview(lease, kind, async input => {
    const review = reviewSchema.parse(input);
    const passed = preflightReviewPasses(review, { sourceSha256, runId });
    // Preserve the exact accepted/rejected payload before returning the gate
    // decision. Never re-read a mutable reviewer file for its audit receipt.
    await recordReview(structuredClone(review), passed);
    return passed;
  });
}
