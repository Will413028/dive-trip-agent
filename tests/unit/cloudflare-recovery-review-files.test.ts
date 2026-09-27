import { describe, expect, test, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { withEvaluationLock } from '../../evals/live-evaluation-lock';
import { awaitCloudflareRecoveryReview } from '../../evals/cloudflare-recovery-review-wait';
import type { RecoveryReviewCases } from '../../evals/cloudflare-recovery-review';

const report = '{"synthetic":true}';
const sourceSha256 = createHash('sha256').update(report).digest('hex');
const cases: RecoveryReviewCases = [
  { round: 1, caseId: 'unknown-cost', runId: '11111111-1111-4111-8111-111111111111' },
  { round: 1, caseId: 'no-date', runId: '22222222-2222-4222-8222-222222222222' },
];
const payload = { sourceSha256, cases: cases.map(row => ({ ...row, sourceSha256,
  textReview: 'passed', reviewers: ['primary', 'independent'], findings: [] })) };

describe.each(['recovery', 'grounded', 'diagnostic'] as const)('%s included-case review', kind => {
test.each(['valid', 'missing claim', 'claim symlink', 'review symlink', 'claim directory', 'review directory',
  'oversize', 'malformed JSON'])('recovery bounded reader: %s', async mode => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'recovery-review-')));
  const dir = join(root, '.artifacts'); await mkdir(dir);
  const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root);
  try {
    const claim = join(dir, `cloudflare-${kind}.claim`);
    const review = join(dir, `cloudflare-${kind}-preflight-review.json`);
    const sentinel = join(dir, 'sentinel'); await writeFile(sentinel, JSON.stringify(payload));
    if (mode === 'claim symlink') await symlink(sentinel, claim);
    else if (mode === 'claim directory') await mkdir(claim);
    else if (mode !== 'missing claim') await writeFile(claim, '');
    if (mode === 'review symlink') await symlink(sentinel, review);
    else if (mode === 'review directory') await mkdir(review);
    else await writeFile(review, mode === 'oversize' ? ' '.repeat(2_000_001)
      : mode === 'malformed JSON' ? '{' : JSON.stringify(payload));
    const record = vi.fn(async () => {});
    const result = withEvaluationLock(lease => awaitCloudflareRecoveryReview(report, cases, lease, record, kind));
    if (mode === 'valid') {
      await expect(result).resolves.toBe(true);
      expect(record).toHaveBeenCalledExactlyOnceWith(payload, true);
    } else {
      await expect(result).rejects.toThrow('PINNED_CLOUDFLARE_REPORT_INVALID');
      expect(record).not.toHaveBeenCalled();
    }
  } finally { cwd.mockRestore(); await rm(root, { recursive: true, force: true }); }
});
});
