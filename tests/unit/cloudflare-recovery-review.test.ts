import { expect, test } from 'vitest';
import { recoveryReviewPasses } from '../../evals/cloudflare-recovery-review';

const sourceSha256 = 'a'.repeat(64);
const expected = { sourceSha256, cases: [
  { round: 1, caseId: 'unknown-cost', runId: '11111111-1111-4111-8111-111111111111' },
  { round: 1, caseId: 'no-date', runId: '22222222-2222-4222-8222-222222222222' },
] } as const;
function fixture() {
  return { sourceSha256, cases: expected.cases.map(row => ({ ...row, sourceSha256,
    textReview: 'passed', reviewers: ['primary', 'independent'], findings: [] as string[],
  })) };
}
const binding = () => ({ sourceSha256, cases: structuredClone([...expected.cases]) as [
  typeof expected.cases[0], typeof expected.cases[1],
] });

test('both distinct run-bound reviews must pass the exact shared checkpoint', () => {
  expect(recoveryReviewPasses(fixture(), binding())).toBe(true);
});
test.each([0, 1])('case %i failed, finding, wrong run or wrong hash cannot release the batch', index => {
  for (const patch of [{ textReview: 'failed' }, { findings: ['unsupported price claim'] },
    { runId: '33333333-3333-4333-8333-333333333333' }, { sourceSha256: 'b'.repeat(64) }]) {
    const review = fixture(); Object.assign(review.cases[index], patch);
    expect(recoveryReviewPasses(review, binding())).toBe(false);
  }
});
test('stale outer checkpoint rejects even when both inner records match', () => {
  expect(recoveryReviewPasses({ ...fixture(), sourceSha256: 'b'.repeat(64) }, binding())).toBe(false);
});
test.each([0, 1])('case %i must identify both actual reviewers and exact case/round', index => {
  for (const patch of [{ reviewers: ['primary'] }, { reviewers: ['primary', 'primary'] },
    { caseId: index === 0 ? 'no-date' : 'unknown-cost' }, { round: 0 }, { textReview: 'pending' }]) {
    const review = fixture(); Object.assign(review.cases[index], patch);
    expect(() => recoveryReviewPasses(review, binding())).toThrow();
  }
});
test('missing, duplicate, reordered or extra case reviews are rejected', () => {
  const review = fixture();
  for (const rows of [review.cases.slice(0, 1), [...review.cases, review.cases[0]],
    [review.cases[1], review.cases[0]], [review.cases[0], review.cases[0]]]) {
    expect(() => recoveryReviewPasses({ ...review, cases: rows }, binding())).toThrow();
  }
});
test('expected identities themselves must not reuse a single run', () => {
  const bound = binding();
  const reused = { ...bound, cases: [bound.cases[0], { ...bound.cases[1], runId: bound.cases[0].runId }] };
  expect(() => recoveryReviewPasses(fixture(), reused as Parameters<typeof recoveryReviewPasses>[1])).toThrow();
});
