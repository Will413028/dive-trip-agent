import { open, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assertEvaluationLock, type EvaluationLockLease } from './live-evaluation-lock.ts';
import { writeAtomicCheckpoint } from './checkpoint.ts';

const previousFiles = new Set(['cloudflare-evaluation-1.claim', 'cloudflare-evaluation-1.json',
  'cloudflare-evaluation-1-review.json', 'cloudflare-evaluation-2.claim', 'cloudflare-evaluation-2.json']);

/** Permanent one-shot claim, including failed preflight. No retry/cleanup API. */
export async function claimPatchCloudflareCampaign(lease: EvaluationLockLease) {
  await assertEvaluationLock(lease);
  const dir = resolve('.artifacts');
  const names = await readdir(dir);
  if (['cloudflare-evaluation-1.claim', 'cloudflare-evaluation-1.json',
    'cloudflare-evaluation-2.claim', 'cloudflare-evaluation-2.json'].some(name => !names.includes(name))
    || names.some(name => /^cloudflare-(evaluation|patch-verification).*\.(claim|json)$/.test(name) && !previousFiles.has(name))) {
    throw new Error('EVAL_CLOUDFLARE_PATCH_ALREADY_CLAIMED');
  }
  await assertEvaluationLock(lease);
  const claim = await open(resolve(dir, 'cloudflare-patch-verification.claim'), 'wx', 0o600);
  try { await claim.sync(); } finally { await claim.close(); }
  const checkpoint = async (report: unknown) => {
    await assertEvaluationLock(lease);
    await writeAtomicCheckpoint(resolve(dir, 'cloudflare-patch-verification.json'), JSON.stringify(report, null, 2));
  };
  await checkpoint({ stopped: 'PREFLIGHT_PENDING', scope: 'locked-budget-once', textReview: 'pending',
    evaluationGatePassed: false, accountingComplete: false, cumulativeTokens: null, records: [] });
  return checkpoint;
}
