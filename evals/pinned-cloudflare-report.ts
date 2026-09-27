import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { assertEvaluationLock, type EvaluationLockLease } from './live-evaluation-lock.ts';
import { withBoundedArtifactDirectory } from './bounded-artifact-file.ts';

import { FIRST_REPORT_SHA256, SECOND_REPORT_SHA256, PATCH_REPORT_SHA256, QUALITY_REPORT_SHA256, REVISION_REPORT_SHA256, RECOVERY_REPORT_SHA256, GROUNDED_REPORT_SHA256, NONTHINKING_REPORT_SHA256, CLOUDFLARE_PREFLIGHT_FILES } from './cloudflare-artifacts.ts';
export { FIRST_REPORT_SHA256, SECOND_REPORT_SHA256, PATCH_REPORT_SHA256, QUALITY_REPORT_SHA256, REVISION_REPORT_SHA256, RECOVERY_REPORT_SHA256, GROUNDED_REPORT_SHA256, NONTHINKING_REPORT_SHA256 } from './cloudflare-artifacts.ts';
const reports = () => ({
  first: { stem: 'cloudflare-evaluation-1', sha256: FIRST_REPORT_SHA256() },
  second: { stem: 'cloudflare-evaluation-2', sha256: SECOND_REPORT_SHA256() },
  patch: { stem: 'cloudflare-patch-verification', sha256: PATCH_REPORT_SHA256() },
  quality: { stem: 'cloudflare-quality', sha256: QUALITY_REPORT_SHA256() },
  revision: { stem: 'cloudflare-revision', sha256: REVISION_REPORT_SHA256() },
  recovery: { stem: 'cloudflare-recovery', sha256: RECOVERY_REPORT_SHA256() },
  grounded: { stem: 'cloudflare-grounded', sha256: GROUNDED_REPORT_SHA256() },
  nonthinking: { stem: 'cloudflare-nonthinking', sha256: NONTHINKING_REPORT_SHA256() },
} as const);

function fail(): never { throw new Error('PINNED_CLOUDFLARE_REPORT_INVALID'); }

/** Fixed historical artifacts only; reading establishes neither accounting nor
 * dispatch permission. Domain schemas and DB comparisons belong to the callers.
 * Only the original offline reader permits absence of an owned lease. */
export async function readPinnedCloudflareReport(kind: keyof ReturnType<typeof reports>, lease?: EvaluationLockLease): Promise<unknown> {
  if (!Object.hasOwn(reports(), kind) || (kind !== 'first' && !lease)) fail();
  const { stem, sha256 } = reports()[kind];
  return readReportFiles(`${stem}.claim`, `${stem}.json`, sha256, lease);
}

/** A fresh local reviewer response is not a historical pinned report. The caller
 * must validate its exact source hash/run and decision before using it. It shares
 * only the bounded filesystem mechanism, never historical provenance policy. */
export async function readCloudflarePreflightReview(lease: EvaluationLockLease,
  kind: keyof typeof CLOUDFLARE_PREFLIGHT_FILES = 'quality'): Promise<unknown> {
  if (!lease || !Object.hasOwn(CLOUDFLARE_PREFLIGHT_FILES, kind)) fail();
  const files = CLOUDFLARE_PREFLIGHT_FILES[kind];
  return readReportFiles(files.claim, files.review, undefined, lease);
}

async function readReportFiles(claimName: string, reportName: string, sha256: string | undefined,
  lease?: EvaluationLockLease): Promise<unknown> {
  try {
    const dir = resolve('.artifacts');
    const checkLease = async () => {
      if (lease) await assertEvaluationLock(lease);
      else {
        const { lstat } = await import('node:fs/promises');
        try { await lstat(join(dir, 'live-evaluation.lock')); fail(); }
        catch (error) {
          if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
        }
      }
    };
    await checkLease();
    return await withBoundedArtifactDirectory([dir], async directory => {
      for (const name of [claimName, reportName]) {
        const { bytes } = await directory.read(name, { minBytes: 0, maxBytes: 2_000_000 });
        await checkLease();
        if (name === claimName) continue;
        if (sha256 !== undefined && createHash('sha256').update(bytes).digest('hex') !== sha256) fail();
        return JSON.parse(bytes.toString('utf8'));
      }
      return fail();
    });
  } catch { return fail(); }
}
