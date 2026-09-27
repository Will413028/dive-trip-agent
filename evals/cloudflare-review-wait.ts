import { lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { assertEvaluationLock, type EvaluationLockLease } from './live-evaluation-lock.ts';
import { readCloudflarePreflightReview } from './pinned-cloudflare-report.ts';
import { CLOUDFLARE_PREFLIGHT_FILES } from './cloudflare-artifacts.ts';

/** Poll absence only; all read/validation/storage failures propagate immediately.
 * The callback owns schema and binding policy, and saves the receipt before return. */
export async function awaitCloudflareReview(lease: EvaluationLockLease,
  kind: keyof typeof CLOUDFLARE_PREFLIGHT_FILES,
  accept: (input: unknown) => Promise<boolean>): Promise<boolean> {
  if (!Object.hasOwn(CLOUDFLARE_PREFLIGHT_FILES, kind)) throw new Error('EVAL_INVALID_REVIEW_SCOPE');
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    await assertEvaluationLock(lease);
    let exists = false;
    try { await lstat(resolve('.artifacts', CLOUDFLARE_PREFLIGHT_FILES[kind].review)); exists = true; }
    catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    if (Date.now() >= deadline) return false;
    if (exists) {
      const input = await readCloudflarePreflightReview(lease, kind);
      if (Date.now() >= deadline) return false;
      return accept(input);
    }
    await delay(Math.min(1000, deadline - Date.now()));
  }
  return false;
}
