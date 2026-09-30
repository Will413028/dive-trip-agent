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
  probe2: { required: probe2Required, prior: probe2Prior(),
    campaign: /^cloudflare-(evaluation|patch|quality|revision|recovery|grounded|nonthinking|diagnostic|probe)/,
    scope: 'probe-2-unknown-cost-once-7-calls-1-invocation-free-only' },
  probe3: { required: probe3Required, prior: probe3Prior(),
    campaign: /^cloudflare-(evaluation|patch|quality|revision|recovery|grounded|nonthinking|diagnostic|probe)/,
    scope: 'probe-3-unknown-cost-once-7-calls-1-invocation-free-only' },
  pythonQuality: { required: pythonQualityRequired, prior: pythonQualityPrior(),
    campaign: /^cloudflare-(evaluation|patch|quality|revision|recovery|grounded|nonthinking|diagnostic|probe|python-quality)/,
    scope: 'python-quality-two-included-plus-28-210-calls-39-invocations-once-free-only' },
  probe4: { required: probe4Required, prior: probe4Prior(),
    campaign: /^cloudflare-(evaluation|patch|quality|revision|recovery|grounded|nonthinking|diagnostic|probe|python-quality)/,
    scope: 'probe-4-unknown-cost-once-7-calls-1-invocation-free-only' },
  probe5: { required: probe5Required, prior: probe5Prior(),
    campaign: /^cloudflare-(evaluation|patch|quality|revision|recovery|grounded|nonthinking|diagnostic|probe|python-quality|python-probe)/,
    scope: 'probe-5-unknown-cost-once-7-calls-1-invocation-free-only' },
  probe6: { required: probe6Required, prior: probe6Prior(),
    campaign: /^cloudflare-(evaluation|patch|quality|revision|recovery|grounded|nonthinking|diagnostic|probe|python-quality|python-probe)/,
    scope: 'probe-6-unknown-cost-once-7-calls-1-invocation-free-only' },
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
  const stem = kind === 'probe6' ? 'cloudflare-probe-6' : kind === 'probe5' ? 'cloudflare-probe-5' : kind === 'probe4' ? 'cloudflare-probe-4' : kind === 'probe2' ? 'cloudflare-probe-2' : kind === 'probe3' ? 'cloudflare-probe-3' : kind === 'pythonQuality' ? 'cloudflare-python-quality' : `cloudflare-${kind}`;
  let probeReplay: string | undefined;
  if ((kind === 'probe' || kind === 'probe2' || kind === 'probe3' || (kind === 'pythonQuality' || (kind === 'probe4' || (kind === 'probe5' || kind === 'probe6')))) && policy.required.every(name => names.includes(name))) {
    try {
      probeReplay = await withBoundedArtifactDirectory([resolve('.'), dir], async directory => {
        const report = await directory.read('cloudflare-diagnostic.json', { minBytes: 1, maxBytes: 2_000_000 });
        return diagnosticReplayFromReport(JSON.parse(report.bytes.toString('utf8'))).file;
      });
      policy.prior.add(probeReplay);
    } catch { fail(); }
  }
  let priorProbeReplay: string | undefined;
  if ((kind === 'probe2' || kind === 'probe3' || (kind === 'pythonQuality' || (kind === 'probe4' || (kind === 'probe5' || kind === 'probe6')))) && policy.required.every(name => names.includes(name))) {
    try {
      priorProbeReplay = await withBoundedArtifactDirectory([resolve('.'), dir], async directory => {
        const report = await directory.read('cloudflare-probe.json', { minBytes: 1, maxBytes: 2_000_000 });
        return probeReplayFromReport(JSON.parse(report.bytes.toString('utf8'))).file;
      });
      policy.prior.add(priorProbeReplay);
    } catch { fail(); }
  }
  let secondProbeReplay: string | undefined;
  if ((kind === 'probe3' || (kind === 'pythonQuality' || (kind === 'probe4' || (kind === 'probe5' || kind === 'probe6')))) && policy.required.every(name => names.includes(name))) {
    try {
      secondProbeReplay = await withBoundedArtifactDirectory([resolve('.'), dir], async directory => {
        const report = await directory.read('cloudflare-probe-2.json', { minBytes: 1, maxBytes: 2_000_000 });
        return probeReplayFromReport(JSON.parse(report.bytes.toString('utf8')), 'cloudflare-probe-2').file;
      });
      policy.prior.add(secondProbeReplay);
    } catch { fail(); }
  }
  let thirdProbeReplay: string | undefined;
  if ((kind === 'pythonQuality' || (kind === 'probe4' || (kind === 'probe5' || kind === 'probe6'))) && policy.required.every(name => names.includes(name))) {
    try {
      thirdProbeReplay = await withBoundedArtifactDirectory([resolve('.'), dir], async directory => {
        const report = await directory.read('cloudflare-probe-3.json', { minBytes: 1, maxBytes: 2_000_000 });
        return probeReplayFromReport(JSON.parse(report.bytes.toString('utf8')), 'cloudflare-probe-3').file;
      });
      policy.prior.add(thirdProbeReplay);
    } catch { fail(); }
  }
  let qualityReplay: string | undefined;
  if ((kind === 'probe4' || (kind === 'probe5' || kind === 'probe6')) && policy.required.every(name => names.includes(name))) {
    try {
      qualityReplay = await withBoundedArtifactDirectory([resolve('.'), dir], async directory => {
        const report = await directory.read('cloudflare-python-quality.json', { minBytes: 1, maxBytes: 2_000_000 });
        return probeReplayFromReport(JSON.parse(report.bytes.toString('utf8')), 'cloudflare-python-quality').file;
      });
      policy.prior.add(qualityReplay);
    } catch { fail(); }
  }
  let fourthProbeReplay: string | undefined;
  if ((kind === 'probe5' || kind === 'probe6') && policy.required.every(name => names.includes(name))) {
    try {
      fourthProbeReplay = await withBoundedArtifactDirectory([resolve('.'), dir], async directory => {
        const report = await directory.read('cloudflare-probe-4.json', { minBytes: 1, maxBytes: 2_000_000 });
        return probeReplayFromReport(JSON.parse(report.bytes.toString('utf8')), 'cloudflare-probe-4').file;
      });
      policy.prior.add(fourthProbeReplay);
    } catch { fail(); }
  }
  let fifthProbeReplay: string | undefined;
  if (kind === 'probe6' && policy.required.every(name => names.includes(name))) {
    try {
      fifthProbeReplay = await withBoundedArtifactDirectory([resolve('.'), dir], async directory => {
        const report = await directory.read('cloudflare-probe-5.json', { minBytes: 1, maxBytes: 2_000_000 });
        return probeReplayFromReport(JSON.parse(report.bytes.toString('utf8')), 'cloudflare-probe-5').file;
      });
      policy.prior.add(fifthProbeReplay);
    } catch { fail(); }
  }
  if (policy.required.some(name => !names.includes(name))
    || ((kind === 'probe' || kind === 'probe2' || kind === 'probe3' || (kind === 'pythonQuality' || (kind === 'probe4' || (kind === 'probe5' || kind === 'probe6')))) && (!probeReplay || !names.includes(probeReplay)))
    || ((kind === 'probe2' || kind === 'probe3' || (kind === 'pythonQuality' || (kind === 'probe4' || (kind === 'probe5' || kind === 'probe6')))) && (!priorProbeReplay || !names.includes(priorProbeReplay)))
    || ((kind === 'probe3' || (kind === 'pythonQuality' || (kind === 'probe4' || (kind === 'probe5' || kind === 'probe6')))) && (!secondProbeReplay || !names.includes(secondProbeReplay)))
    || ((kind === 'pythonQuality' || (kind === 'probe4' || (kind === 'probe5' || kind === 'probe6'))) && (!thirdProbeReplay || !names.includes(thirdProbeReplay)))
    || ((kind === 'probe4' || (kind === 'probe5' || kind === 'probe6')) && (!qualityReplay || !names.includes(qualityReplay)))
    || ((kind === 'probe5' || kind === 'probe6') && (!fourthProbeReplay || !names.includes(fourthProbeReplay)))
    || (kind === 'probe6' && (!fifthProbeReplay || !names.includes(fifthProbeReplay)))
    || names.some(name => policy.campaign.test(name) && !policy.prior.has(name))) fail();
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
