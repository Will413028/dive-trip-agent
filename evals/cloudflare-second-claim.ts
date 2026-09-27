import { open, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assertEvaluationLock, type EvaluationLockLease } from './live-evaluation-lock.ts';
import { writeAtomicCheckpoint } from './checkpoint.ts';

const previousFiles = new Set(['cloudflare-evaluation-1.claim', 'cloudflare-evaluation-1.json',
  'cloudflare-evaluation-1-review.json']);

/** Called only inside the separately authorized entry. Claim is consumed even
 * if history/preflight fails; no cleanup/retry API is provided. */
export async function claimSecondCloudflareCampaign(lease: EvaluationLockLease) {
  await assertEvaluationLock(lease);
  const dir = resolve('.artifacts');
  const names = await readdir(dir);
  if (!names.includes('cloudflare-evaluation-1.claim') || !names.includes('cloudflare-evaluation-1.json')
    || names.some(name => /^cloudflare-evaluation-.*\.(claim|json)$/.test(name) && !previousFiles.has(name))) {
    throw new Error('EVAL_CLOUDFLARE_SECOND_ALREADY_CLAIMED');
  }
  await assertEvaluationLock(lease);
  const claim = await open(resolve(dir, 'cloudflare-evaluation-2.claim'), 'wx', 0o600);
  try { await claim.sync(); } finally { await claim.close(); }
  const checkpoint = async (report: unknown) => {
    await assertEvaluationLock(lease);
    await writeAtomicCheckpoint(resolve(dir, 'cloudflare-evaluation-2.json'), JSON.stringify(report, null, 2));
  };
  await checkpoint({ stopped: 'PREFLIGHT_PENDING', batch: 2, textReview: 'pending',
    evaluationGatePassed: false, accountingComplete: false, cumulativeTokens: null, records: [] });
  return checkpoint;
}
