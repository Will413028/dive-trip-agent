import { historyIdentity } from './cloudflare-history-profile.ts';
import { lstat, open, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assertEvaluationLock, type EvaluationLockLease } from './live-evaluation-lock.ts';
import { writeAtomicCheckpoint } from './checkpoint.ts';
import { withBoundedArtifactDirectory } from './bounded-artifact-file.ts';
import { diagnosticReplayFromReport } from './cloudflare-diagnostic-replay.ts';
import { probeReplayFromReport } from './cloudflare-probe-replay.ts';

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
const probe2Required = [...probeRequired, 'cloudflare-probe.claim', 'cloudflare-probe.json'];
const probe2Prior = () => new Set([...probePrior(), ...probe2Required]);
const probe3Required = [...probe2Required, 'cloudflare-probe-2.claim', 'cloudflare-probe-2.json'];
const probe3Prior = () => new Set([...probe2Prior(), ...probe3Required]);
const pythonQualityRequired = [...probe3Required, 'cloudflare-probe-3.claim', 'cloudflare-probe-3.json'];
const pythonQualityPrior = () => new Set([...probe3Prior(), ...pythonQualityRequired]);
const probe4Required = [...pythonQualityRequired, 'cloudflare-python-quality.claim', 'cloudflare-python-quality.json', 'cloudflare-python-quality-history.json'];
const probe4Prior = () => new Set([...pythonQualityPrior(), ...probe4Required]);
const probe5Required = [...probe4Required,
  'cloudflare-python-probe-history.json', 'cloudflare-python-probe-2-history.json',
  'cloudflare-python-probe-3-history.json', 'cloudflare-probe-4.claim', 'cloudflare-probe-4.json', 'cloudflare-python-probe-4-history.json'];
const probe5Prior = () => new Set([...probe4Prior(), ...probe5Required]);
const probe6Required = [...probe5Required, 'cloudflare-probe-5.claim', 'cloudflare-probe-5.json', 'cloudflare-python-probe-5-history.json'];
const probe6Prior = () => new Set([...probe5Prior(), ...probe6Required]);
const probe7Required = [...probe6Required, 'cloudflare-probe-6.claim', 'cloudflare-probe-6.json', 'cloudflare-python-probe-6-history.json'];
const probe7Prior = () => new Set([...probe6Prior(), ...probe7Required]);
const probe8Required = [...probe7Required, 'cloudflare-probe-7.claim', 'cloudflare-probe-7.json', 'cloudflare-python-probe-7-history.json'];
const probe8Prior = () => new Set([...probe7Prior(), ...probe8Required]);
const priorReplayStems = ['cloudflare-diagnostic', 'cloudflare-probe',
  'cloudflare-probe-2', 'cloudflare-probe-3', 'cloudflare-python-quality',
  'cloudflare-probe-4', 'cloudflare-probe-5', 'cloudflare-probe-6', 'cloudflare-probe-7'] as const;

function describe<const P extends { stem: string; required: readonly string[];
  prior: Set<string>; campaign: RegExp; scope: string }>(policy: P) {
  return { ...policy, replayReports: priorReplayStems.filter(stem =>
    policy.required.includes(`${stem}.json`)) };
}

const policies = () => ({
  revision: describe({ stem: 'cloudflare-revision', required: requiredFiles, prior: priorFiles(),
    campaign: /^cloudflare-(evaluation|patch|quality|revision).*\.(claim|json)$/,
    scope: 'non-diver-preflight-plus-30-once' }),
  recovery: describe({ stem: 'cloudflare-recovery', required: recoveryRequired, prior: recoveryPrior(),
    campaign: /^cloudflare-(evaluation|patch|quality|revision|recovery)/,
    scope: 'two-included-preflights-plus-28-once' }),
  grounded: describe({ stem: 'cloudflare-grounded', required: groundedRequired, prior: groundedPrior(),
    campaign: /^cloudflare-(evaluation|patch|quality|revision|recovery|grounded)/,
    scope: 'grounded-two-included-plus-28-210-calls-39-invocations-once' }),
  nonthinking: describe({ stem: 'cloudflare-nonthinking', required: nonthinkingRequired, prior: nonthinkingPrior(),
    campaign: /^cloudflare-(evaluation|patch|quality|revision|recovery|grounded|nonthinking)/,
    scope: 'nonthinking-unknown-cost-once-7-calls-1-start' }),
  diagnostic: describe({ stem: 'cloudflare-diagnostic', required: diagnosticRequired, prior: diagnosticPrior(),
    campaign: /^cloudflare-(evaluation|patch|quality|revision|recovery|grounded|nonthinking|diagnostic)/,
    scope: 'diagnostic-two-included-plus-28-210-calls-39-invocations-once' }),
  probe: describe({ stem: 'cloudflare-probe', required: probeRequired, prior: probePrior(),
    campaign: /^cloudflare-(evaluation|patch|quality|revision|recovery|grounded|nonthinking|diagnostic|probe)/,
    scope: 'probe-unknown-cost-once-7-calls-1-invocation-free-only' }),
  probe2: describe({ stem: 'cloudflare-probe-2', required: probe2Required, prior: probe2Prior(),
    campaign: /^cloudflare-(evaluation|patch|quality|revision|recovery|grounded|nonthinking|diagnostic|probe)/,
    scope: 'probe-2-unknown-cost-once-7-calls-1-invocation-free-only' }),
  probe3: describe({ stem: 'cloudflare-probe-3', required: probe3Required, prior: probe3Prior(),
    campaign: /^cloudflare-(evaluation|patch|quality|revision|recovery|grounded|nonthinking|diagnostic|probe)/,
    scope: 'probe-3-unknown-cost-once-7-calls-1-invocation-free-only' }),
  pythonQuality: describe({ stem: 'cloudflare-python-quality', required: pythonQualityRequired, prior: pythonQualityPrior(),
    campaign: /^cloudflare-(evaluation|patch|quality|revision|recovery|grounded|nonthinking|diagnostic|probe|python-quality)/,
    scope: 'python-quality-two-included-plus-28-210-calls-39-invocations-once-free-only' }),
  probe4: describe({ stem: 'cloudflare-probe-4', required: probe4Required, prior: probe4Prior(),
    campaign: /^cloudflare-(evaluation|patch|quality|revision|recovery|grounded|nonthinking|diagnostic|probe|python-quality)/,
    scope: 'probe-4-unknown-cost-once-7-calls-1-invocation-free-only' }),
  probe5: describe({ stem: 'cloudflare-probe-5', required: probe5Required, prior: probe5Prior(),
    campaign: /^cloudflare-(evaluation|patch|quality|revision|recovery|grounded|nonthinking|diagnostic|probe|python-quality|python-probe)/,
    scope: 'probe-5-unknown-cost-once-7-calls-1-invocation-free-only' }),
  probe6: describe({ stem: 'cloudflare-probe-6', required: probe6Required, prior: probe6Prior(),
    campaign: /^cloudflare-(evaluation|patch|quality|revision|recovery|grounded|nonthinking|diagnostic|probe|python-quality|python-probe)/,
    scope: 'probe-6-unknown-cost-once-7-calls-1-invocation-free-only' }),
  probe7: describe({ stem: 'cloudflare-probe-7', required: probe7Required, prior: probe7Prior(),
    campaign: /^cloudflare-(evaluation|patch|quality|revision|recovery|grounded|nonthinking|diagnostic|probe|python-quality|python-probe)/,
    scope: 'probe-7-unknown-cost-once-7-calls-1-invocation-free-only' }),
  probe8: describe({ stem: 'cloudflare-probe-8', required: probe8Required, prior: probe8Prior(),
    campaign: /^cloudflare-(evaluation|patch|quality|revision|recovery|grounded|nonthinking|diagnostic|probe|python-quality|python-probe)/,
    scope: 'probe-8-unknown-cost-once-7-calls-1-invocation-free-only' }),
} as const);

/** Permanent one-shot claim with closed campaign policies, consumed even on preflight failure.
 * This checks artifact inventory only; the reader separately pins old reports.
 * Uses the shared lease's trusted-local-directory/cooperative-writer boundary.
 */
export async function claimCloudflareCampaign(lease: EvaluationLockLease, kind: keyof ReturnType<typeof policies>) {
  const fixedPolicies = policies();
  if (!Object.hasOwn(fixedPolicies, kind)) throw new Error('EVAL_INVALID_CLAIM_SCOPE');
  const policy = fixedPolicies[kind];
  function fail(): never { throw new Error(`EVAL_CLOUDFLARE_${kind.toUpperCase()}_ALREADY_CLAIMED`); }
  await assertEvaluationLock(lease);
  const dir = resolve('.artifacts');
  const names = await readdir(dir);
  const stem = policy.stem;
  if (policy.required.some(name => !names.includes(name))) fail();
  for (const replayStem of policy.replayReports) {
    try {
      const replay = await withBoundedArtifactDirectory([resolve('.'), dir], async directory => {
        const report = await directory.read(`${replayStem}.json`, { minBytes: 1, maxBytes: 2_000_000 });
        const value: unknown = JSON.parse(report.bytes.toString('utf8'));
        return replayStem === 'cloudflare-diagnostic'
          ? diagnosticReplayFromReport(value).file : probeReplayFromReport(value, replayStem).file;
      });
      if (!names.includes(replay)) fail();
      policy.prior.add(replay);
    } catch { fail(); }
  }
  if (names.some(name => policy.campaign.test(name) && !policy.prior.has(name))) fail();
  for (const name of names.filter(name => policy.prior.has(name))) {
    if (!(await lstat(resolve(dir, name))).isFile()) fail();
  }
  await assertEvaluationLock(lease);
  const claim = await open(resolve(dir, `${stem}.claim`), 'wx', 0o600);
  try { await claim.sync(); } finally { await claim.close(); }
  const path = resolve(dir, `${stem}.json`);
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
