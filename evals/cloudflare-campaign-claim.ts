import { historyIdentity } from './cloudflare-history-profile.ts';
import { lstat, open, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assertEvaluationLock, type EvaluationLockLease } from './live-evaluation-lock.ts';
import { writeAtomicCheckpoint } from './checkpoint.ts';

const requiredFiles = ['cloudflare-evaluation-1', 'cloudflare-evaluation-2',
  'cloudflare-patch-verification', 'cloudflare-quality'].flatMap(stem => [`${stem}.claim`, `${stem}.json`]);
const priorFiles = () => new Set([...requiredFiles,
  'cloudflare-evaluation-1-review.json', 'cloudflare-patch-verification-review.json',
  'cloudflare-quality-review.json', 'cloudflare-quality-diagnostic.json',
  'cloudflare-quality-preflight.json', 'cloudflare-quality-preflight-review.json',
  'cloudflare-quality-preflight-receipt.json',
  `cloudflare-quality-${historyIdentity('replay_quality_1')}.replay.json`,
  `cloudflare-quality-${historyIdentity('replay_quality_2')}.replay.json`]);

const recoveryRequired = [...requiredFiles, 'cloudflare-revision.claim', 'cloudflare-revision.json'];
const recoveryPrior = () => new Set([...priorFiles(), ...recoveryRequired,
  'cloudflare-revision-review.json', 'cloudflare-revision-preflight.json',
  'cloudflare-revision-preflight-review.json', 'cloudflare-revision-preflight-receipt.json',
  `cloudflare-revision-${historyIdentity('replay_revision_3')}.replay.json`]);
const groundedRequired = [...recoveryRequired, 'cloudflare-recovery.claim', 'cloudflare-recovery.json'];
const groundedPrior = () => new Set([...recoveryPrior(), ...groundedRequired,
  'cloudflare-recovery-review.json', 'cloudflare-recovery-preflight.json',
  'cloudflare-recovery-preflight-review.json', 'cloudflare-recovery-preflight-receipt.json',
  `cloudflare-recovery-${historyIdentity('replay_recovery_4')}.replay.json`,
  `cloudflare-recovery-${historyIdentity('replay_recovery_5')}.replay.json`]);
const nonthinkingRequired = [...groundedRequired, 'cloudflare-grounded.claim', 'cloudflare-grounded.json'];
const nonthinkingPrior = () => new Set([...groundedPrior(), ...nonthinkingRequired,
  'cloudflare-grounded-review.json',
  `cloudflare-grounded-${historyIdentity('grounded_carry_runId_1')}.replay.json`]);
const diagnosticRequired = [...nonthinkingRequired, 'cloudflare-nonthinking.claim', 'cloudflare-nonthinking.json'];
const diagnosticPrior = () => new Set([...nonthinkingPrior(), ...diagnosticRequired,
  'cloudflare-nonthinking-review.json',
  `cloudflare-nonthinking-${historyIdentity('nonthinking_carry_runId_1')}.replay.json`]);
const probeRequired = [...diagnosticRequired, 'cloudflare-diagnostic.claim', 'cloudflare-diagnostic.json'];
const probePrior = () => new Set([...diagnosticPrior(), ...probeRequired]);
const policies = () => ({
  revision: { required: requiredFiles, prior: priorFiles(),
    campaign: /^cloudflare-(evaluation|patch|quality|revision).*\.(claim|json)$/,
    scope: 'non-diver-preflight-plus-30-once' },
  recovery: { required: recoveryRequired, prior: recoveryPrior(),
    campaign: /^cloudflare-(evaluation|patch|quality|revision|recovery)/,
    scope: 'two-included-preflights-plus-28-once' },
  grounded: { required: groundedRequired, prior: groundedPrior(),
    campaign: /^cloudflare-(evaluation|patch|quality|revision|recovery|grounded)/,
    scope: 'grounded-two-included-plus-28-210-calls-39-invocations-once' },
  nonthinking: { required: nonthinkingRequired, prior: nonthinkingPrior(),
    campaign: /^cloudflare-(evaluation|patch|quality|revision|recovery|grounded|nonthinking)/,
    scope: 'nonthinking-unknown-cost-once-7-calls-1-start' },
  diagnostic: { required: diagnosticRequired, prior: diagnosticPrior(),
    campaign: /^cloudflare-(evaluation|patch|quality|revision|recovery|grounded|nonthinking|diagnostic)/,
    scope: 'diagnostic-two-included-plus-28-210-calls-39-invocations-once' },
  probe: { required: probeRequired, prior: probePrior(),
    campaign: /^cloudflare-(evaluation|patch|quality|revision|recovery|grounded|nonthinking|diagnostic|probe)/,
    scope: 'probe-unknown-cost-once-7-calls-1-invocation-free-only' },
} as const);

/** Permanent one-shot claim with closed campaign policies, consumed even on preflight failure.
 * This checks artifact inventory only; the reader separately pins old reports.
 * Uses the shared lease's trusted-local-directory/cooperative-writer boundary.
 */
export async function claimCloudflareCampaign(lease: EvaluationLockLease, kind: keyof ReturnType<typeof policies>) {
  if (!Object.hasOwn(policies(), kind)) throw new Error('EVAL_INVALID_CLAIM_SCOPE');
  const policy = policies()[kind];
  function fail(): never { throw new Error(`EVAL_CLOUDFLARE_${kind.toUpperCase()}_ALREADY_CLAIMED`); }
  await assertEvaluationLock(lease);
  const dir = resolve('.artifacts');
  const names = await readdir(dir);
  if (policy.required.some(name => !names.includes(name))
    || names.some(name => policy.campaign.test(name) && !policy.prior.has(name))) fail();
  for (const name of names.filter(name => policy.prior.has(name))) {
    if (!(await lstat(resolve(dir, name))).isFile()) fail();
  }
  await assertEvaluationLock(lease);
  const claim = await open(resolve(dir, `cloudflare-${kind}.claim`), 'wx', 0o600);
  try { await claim.sync(); } finally { await claim.close(); }
  const path = resolve(dir, `cloudflare-${kind}.json`);
  const checkpoint = async (report: unknown) => {
    await assertEvaluationLock(lease);
    // Atomic replacement must not silently replace a symlink or special file.
    try { if (!(await lstat(path)).isFile()) fail(); }
    catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    await assertEvaluationLock(lease);
    await writeAtomicCheckpoint(path, JSON.stringify(report, null, 2));
  };
  await checkpoint({ stopped: 'PREFLIGHT_PENDING', scope: policy.scope,
    textReview: 'pending', evaluationGatePassed: false, accountingComplete: false, cumulativeTokens: null, records: [] });
  return checkpoint;
}
