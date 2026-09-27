import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { EvaluationLockLease } from '../../evals/live-evaluation-lock';
const state = vi.hoisted(() => ({ exists: false, failedStat: false, leaseLost: false, reads: 0, checks: 0,
  paths: [] as string[], kinds: [] as string[], review: {} as unknown, readDelay: 0, readMissing: false }));
vi.mock('node:fs/promises', () => ({ lstat: async (path: string) => {
  state.paths.push(path);
  if (state.failedStat) throw new Error('PRIVATE_IO');
  if (!state.exists) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  return {};
} }));
vi.mock('../../evals/live-evaluation-lock', () => ({ assertEvaluationLock: async () => {
  state.checks++; if (state.leaseLost) throw new Error('EVAL_LOCK_NOT_OWNED');
} }));
vi.mock('../../evals/pinned-cloudflare-report', () => ({ readCloudflarePreflightReview: async (_lease: unknown, kind: string) => {
  state.kinds.push(kind);
  if (state.readMissing) throw Object.assign(new Error('missing at read'), { code: 'ENOENT' });
  if (state.readDelay) vi.setSystemTime(Date.now() + state.readDelay);
  state.reads++; return state.review;
} }));
// Bounded time advances deterministically; no real sleeps or filesystem writes.
vi.mock('node:timers/promises', () => ({ setTimeout: async (ms: number) => { vi.setSystemTime(Date.now() + ms); } }));
import { awaitCloudflarePreflightReview } from '../../evals/cloudflare-preflight-review';
import { awaitCloudflareRecoveryReview } from '../../evals/cloudflare-recovery-review-wait';
import type { RecoveryReviewCases } from '../../evals/cloudflare-recovery-review';
const report = '{"synthetic":true}';
const runId = '4d420bb9-704b-4463-8f94-398065919454';
const lease = {} as EvaluationLockLease;
const recordReview = vi.fn(async () => {});
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  recordReview.mockClear();
  Object.assign(state, { exists: false, failedStat: false, leaseLost: false, reads: 0, checks: 0, paths: [], kinds: [], readDelay: 0, readMissing: false,
    review: { sourceSha256: createHash('sha256').update(report).digest('hex'), runId,
      textReview: 'passed', reviewers: ['primary', 'independent'], findings: [] } });
});
afterEach(() => vi.useRealTimers());
test('absence waits at most 180 seconds and never reads a missing review', async () => {
  expect(await awaitCloudflarePreflightReview(report, runId, lease, recordReview)).toBe(false);
  expect(Date.now()).toBe(180000); expect(state.reads).toBe(0); expect(state.checks).toBe(180);
});
test('exact checkpoint review succeeds once without model or timer retry', async () => {
  state.exists = true;
  expect(await awaitCloudflarePreflightReview(report, runId, lease, recordReview)).toBe(true);
  expect(state.reads).toBe(1); expect(Date.now()).toBe(0);
  expect(recordReview).toHaveBeenCalledExactlyOnceWith(state.review, true);
});
test.each(['stat', 'lease', 'malformed'] as const)('non-absence %s failure does not poll or retry', async mode => {
  state.exists = true; state.failedStat = mode === 'stat'; state.leaseLost = mode === 'lease';
  if (mode === 'malformed') state.review = {};
  await expect(awaitCloudflarePreflightReview(report, runId, lease, recordReview)).rejects.toThrow();
  expect(Date.now()).toBe(0); expect(state.checks).toBe(1);
});
test('receipt persistence failure cannot pass the preflight gate', async () => {
  state.exists = true;
  await expect(awaitCloudflarePreflightReview(report, runId, lease, async () => { throw new Error('EXPORT_FAILED'); }))
    .rejects.toThrow('EXPORT_FAILED');
  expect(state.reads).toBe(1);
});
test.each(['revision', 'nonthinking'] as const)('%s review reads only its scope and preserves the exact receipt', async kind => {
  state.exists = true;
  expect(await awaitCloudflarePreflightReview(report, runId, lease, recordReview, kind)).toBe(true);
  expect(state.paths).toEqual([resolve(`.artifacts/cloudflare-${kind}-preflight-review.json`)]);
  expect(state.kinds).toEqual([kind]);
  expect(recordReview).toHaveBeenCalledExactlyOnceWith(state.review, true);
});
test.each(['hash', 'run', 'negative'] as const)('revision rejects stale or negative %s review without polling', async mode => {
  state.exists = true;
  Object.assign(state.review as object, mode === 'hash' ? { sourceSha256: 'b'.repeat(64) }
    : mode === 'run' ? { runId: '30110afd-0f5b-4d53-8c71-6742d1e2ea9d' } : { textReview: 'failed' });
  expect(await awaitCloudflarePreflightReview(report, runId, lease, recordReview, 'revision')).toBe(false);
  expect(state.reads).toBe(1); expect(Date.now()).toBe(0);
  expect(recordReview).toHaveBeenCalledExactlyOnceWith(state.review, false);
});
test('unknown review scope rejects before filesystem or lease IO', async () => {
  await expect(awaitCloudflarePreflightReview(report, runId, lease, recordReview, '../elsewhere' as 'revision'))
    .rejects.toThrow('EVAL_INVALID_REVIEW_SCOPE');
  expect(state.paths).toEqual([]); expect(state.checks).toBe(0);
});

const cases: RecoveryReviewCases = [
  { round: 1, caseId: 'unknown-cost', runId },
  { round: 1, caseId: 'no-date', runId: '30110afd-0f5b-4d53-8c71-6742d1e2ea9d' },
];
function recoveryFixture() {
  const sourceSha256 = createHash('sha256').update(report).digest('hex');
  return { sourceSha256, cases: cases.map(row => ({ ...row, sourceSha256,
    textReview: 'passed', reviewers: ['primary', 'independent'], findings: [] as string[] })) };
}
test.each(['grounded', 'diagnostic'] as const)('%s review uses only its new claim scope and preserves both review bindings', async kind => {
  state.exists = true; state.review = recoveryFixture();
  expect(await awaitCloudflareRecoveryReview(report, cases, lease, recordReview, kind)).toBe(true);
  expect(state.kinds).toEqual([kind]);
  expect(state.paths).toEqual([resolve(`.artifacts/cloudflare-${kind}-preflight-review.json`)]);
  expect(recordReview).toHaveBeenCalledExactlyOnceWith(state.review, true);
});
test('recovery absence is bounded to 180 seconds', async () => {
  expect(await awaitCloudflareRecoveryReview(report, cases, lease, recordReview)).toBe(false);
  expect(Date.now()).toBe(180000); expect(state.reads).toBe(0); expect(recordReview).not.toHaveBeenCalled();
});
test('recovery saves an independent deep clone before releasing both cases', async () => {
  state.exists = true; state.review = recoveryFixture();
  const original = structuredClone(state.review);
  let release!: () => void;
  const saved = new Promise<void>(resolve => { release = resolve; });
  const record = vi.fn(async review => {
    expect(review).toEqual(original); expect(review).not.toBe(state.review);
    review.cases[0].findings.push('receipt writer mutation');
    expect(state.review).toEqual(original);
    await saved;
  });
  let settled = false;
  const result = awaitCloudflareRecoveryReview(report, cases, lease, record).then(value => { settled = true; return value; });
  await vi.waitFor(() => expect(record).toHaveBeenCalledOnce());
  expect(settled).toBe(false); release();
  expect(await result).toBe(true);
  expect(state.kinds).toEqual(['recovery']);
  expect(state.paths).toEqual([resolve('.artifacts/cloudflare-recovery-preflight-review.json')]);
});
test.each(['outer hash', 'inner hash', 'run', 'negative', 'finding'])('recovery rejects %s and saves exact rejection without retry', mode => {
  state.exists = true;
  const review = recoveryFixture(); state.review = review;
  if (mode === 'outer hash') review.sourceSha256 = 'b'.repeat(64);
  if (mode === 'inner hash') review.cases[1].sourceSha256 = 'b'.repeat(64);
  if (mode === 'run') review.cases[1].runId = runId;
  if (mode === 'negative') review.cases[1].textReview = 'failed';
  if (mode === 'finding') review.cases[0].findings.push('price');
  return awaitCloudflareRecoveryReview(report, cases, lease, recordReview).then(passed => {
    expect(passed).toBe(false); expect(state.reads).toBe(1); expect(Date.now()).toBe(0);
    expect(recordReview).toHaveBeenCalledExactlyOnceWith(review, false);
  });
});
test.each(['stat', 'lease', 'malformed', 'storage'])('recovery %s failure stops immediately', async mode => {
  state.exists = true; state.review = mode === 'malformed' ? {} : recoveryFixture();
  state.failedStat = mode === 'stat'; state.leaseLost = mode === 'lease';
  const record = vi.fn(async () => { throw new Error('STORAGE'); });
  await expect(awaitCloudflareRecoveryReview(report, cases, lease, record)).rejects.toThrow();
  expect(Date.now()).toBe(0); expect(state.reads).toBeLessThanOrEqual(1);
  expect(record).toHaveBeenCalledTimes(mode === 'storage' ? 1 : 0);
});
test('recovery validates expected identities before IO', async () => {
  await expect(awaitCloudflareRecoveryReview(report, [cases[0], { ...cases[1], runId }], lease, recordReview)).rejects.toThrow();
  expect(state.checks).toBe(0);
});
test('a recovery read completed at the deadline cannot release the gate', async () => {
  state.exists = true; state.review = recoveryFixture(); state.readDelay = 180000;
  expect(await awaitCloudflareRecoveryReview(report, cases, lease, recordReview)).toBe(false);
  expect(recordReview).not.toHaveBeenCalled(); expect(state.reads).toBe(1);
});
test('disappearance after existence check does not restart polling', async () => {
  state.exists = true; state.readMissing = true;
  await expect(awaitCloudflareRecoveryReview(report, cases, lease, recordReview)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(Date.now()).toBe(0); expect(state.kinds).toEqual(['recovery']);
  expect(recordReview).not.toHaveBeenCalled();
});
