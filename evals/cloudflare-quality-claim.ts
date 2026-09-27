import { open, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assertEvaluationLock, type EvaluationLockLease } from './live-evaluation-lock.ts';
import { writeAtomicCheckpoint } from './checkpoint.ts';

const priorFiles = new Set(['cloudflare-evaluation-1.claim', 'cloudflare-evaluation-1.json',
  'cloudflare-evaluation-1-review.json', 'cloudflare-evaluation-2.claim', 'cloudflare-evaluation-2.json',
  'cloudflare-patch-verification.claim', 'cloudflare-patch-verification.json', 'cloudflare-patch-verification-review.json']);

/** New one-shot 1+30 authorization; consumes claim even if preflight fails. */
export async function claimCloudflareQualityCampaign(lease: EvaluationLockLease) {
  await assertEvaluationLock(lease);
  const dir = resolve('.artifacts');
  const names = await readdir(dir);
  if (['cloudflare-evaluation-1.claim', 'cloudflare-evaluation-1.json',
    'cloudflare-evaluation-2.claim', 'cloudflare-evaluation-2.json',
    'cloudflare-patch-verification.claim', 'cloudflare-patch-verification.json'].some(name => !names.includes(name))
    || names.some(name => /^cloudflare-(evaluation|patch-verification|quality).*\.(claim|json)$/.test(name) && !priorFiles.has(name))) {
    throw new Error('EVAL_CLOUDFLARE_QUALITY_ALREADY_CLAIMED');
  }
  await assertEvaluationLock(lease);
  const claim = await open(resolve(dir, 'cloudflare-quality.claim'), 'wx', 0o600);
  try { await claim.sync(); } finally { await claim.close(); }
  const checkpoint = async (report: unknown) => {
    await assertEvaluationLock(lease);
    await writeAtomicCheckpoint(resolve(dir, 'cloudflare-quality.json'), JSON.stringify(report, null, 2));
  };
  await checkpoint({ stopped: 'PREFLIGHT_PENDING', scope: 'budget-preflight-plus-30-once',
    textReview: 'pending', evaluationGatePassed: false, accountingComplete: false, cumulativeTokens: null, records: [] });
  return checkpoint;
}
