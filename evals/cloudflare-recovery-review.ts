import { z } from 'zod';
import { reviewSchema } from './cloudflare-review-schema.ts';

const identity = z.strictObject({ round: z.literal(1), caseId: z.enum(['unknown-cost', 'no-date']), runId: z.uuid() });
export const recoveryReviewIdentitiesSchema = z.tuple([
  identity.extend({ caseId: z.literal('unknown-cost') }),
  identity.extend({ caseId: z.literal('no-date') }),
]).refine(rows => rows[0].runId !== rows[1].runId);
export type RecoveryReviewCases = z.infer<typeof recoveryReviewIdentitiesSchema>;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const recoveryReviewSchema = z.strictObject({ sourceSha256: digest,
  cases: z.tuple([
    reviewSchema.extend({ round: z.literal(1), caseId: z.literal('unknown-cost') }),
    reviewSchema.extend({ round: z.literal(1), caseId: z.literal('no-date') }),
  ]),
});

/** Pure binding for the future immutable two-case review receipt. No IO,
 * automatic prose judgment, dispatch permission or change to historical flags. */
export function recoveryReviewPasses(input: unknown,
  expectedInput: { sourceSha256: string; cases: RecoveryReviewCases }) {
  const expected = z.strictObject({ sourceSha256: digest, cases: recoveryReviewIdentitiesSchema }).parse(expectedInput);
  const review = recoveryReviewSchema.parse(input);
  return review.sourceSha256 === expected.sourceSha256 && review.cases.every((row, index) =>
    row.sourceSha256 === expected.sourceSha256 && row.runId === expected.cases[index].runId
    && row.textReview === 'passed' && row.findings.length === 0);
}
