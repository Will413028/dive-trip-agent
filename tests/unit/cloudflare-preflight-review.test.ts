import { expect, test } from 'vitest';
import { preflightReviewPasses } from '../../evals/cloudflare-preflight-review';
const expected = { sourceSha256: 'a'.repeat(64), runId: '4d420bb9-704b-4463-8f94-398065919454' };
const review = { ...expected, textReview: 'passed', reviewers: ['primary', 'independent'], findings: [] };
test('accepts only an explicit independent and primary passing review of this exact checkpoint', () => {
  expect(preflightReviewPasses(review, expected)).toBe(true);
});
test.each([
  { sourceSha256: 'b'.repeat(64) }, { runId: '30110afd-0f5b-4d53-8c71-6742d1e2ea9d' },
  { textReview: 'failed' }, { findings: ['infeasible activity-removal advice'] },
])('does not authorize the batch for %j', patch => {
  expect(preflightReviewPasses({ ...review, ...patch }, expected)).toBe(false);
});
test.each([{ reviewers: ['primary'] }, { textReview: 'pending' }, { dispatchAuthorized: true }])('rejects malformed review %j', patch => {
  expect(() => preflightReviewPasses({ ...review, ...patch }, expected)).toThrow();
});
