import { describe, expect, test, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rename, rm, realpath, symlink, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEvaluationLock, type EvaluationLockLease } from '../../evals/live-evaluation-lock';
import { claimCloudflareRevisionCampaign } from '../../evals/cloudflare-revision-claim';
import { claimCloudflareRecoveryCampaign } from '../../evals/cloudflare-recovery-claim';
import { claimCloudflareCampaign } from '../../evals/cloudflare-campaign-claim';
import * as checkpoints from '../../evals/checkpoint';
import * as lock from '../../evals/live-evaluation-lock';

describe.each(['revision', 'recovery', 'grounded', 'nonthinking', 'diagnostic', 'probe', 'probe2', 'probe3', 'pythonQuality', 'probe4', 'probe5', 'probe6', 'probe7'] as const)('%s one-shot claim', kind => {
const diagnosticRunId = '77777777-7777-4777-8777-777777777777';
const diagnosticReplay = `cloudflare-diagnostic-${diagnosticRunId}.replay.json`;
const probeRunId = '88888888-8888-4888-8888-888888888888';
const probeReplay = `cloudflare-probe-${probeRunId}.replay.json`;
const probe3Replay = `cloudflare-probe-3-${probeRunId}.replay.json`;
const probe6Replay = `cloudflare-probe-6-${probeRunId}.replay.json`;
const probe5Replay = `cloudflare-probe-5-${probeRunId}.replay.json`;
const probe4Replay = `cloudflare-probe-4-${probeRunId}.replay.json`;
const qualityReplay = `cloudflare-python-quality-${probeRunId}.replay.json`;
const probe2Replay = `cloudflare-probe-2-${probeRunId}.replay.json`;
const historyContent = (name: string) => (kind === 'probe' || kind === 'probe2' || kind === 'probe3' || (kind === 'pythonQuality' || (kind === 'probe4' || (kind === 'probe5' || (kind === 'probe6' || kind === 'probe7'))))) && name === 'cloudflare-diagnostic.json'
  ? JSON.stringify({ replays: [{ file: diagnosticReplay, runId: diagnosticRunId,
    sha256: 'a'.repeat(64), recordedResume: false }] })
  : (kind === 'probe2' || kind === 'probe3' || (kind === 'pythonQuality' || (kind === 'probe4' || (kind === 'probe5' || (kind === 'probe6' || kind === 'probe7'))))) && name === 'cloudflare-probe.json'
    ? JSON.stringify({ replays: [{ file: probeReplay, runId: probeRunId,
      sha256: 'b'.repeat(64), recordedResume: false }] })
    : (kind === 'probe3' || (kind === 'pythonQuality' || (kind === 'probe4' || (kind === 'probe5' || (kind === 'probe6' || kind === 'probe7'))))) && name === 'cloudflare-probe-2.json'
      ? JSON.stringify({ replays: [{ file: probe2Replay, runId: probeRunId, sha256: 'c'.repeat(64), recordedResume: false }] }) : (kind === 'pythonQuality' || (kind === 'probe4' || (kind === 'probe5' || (kind === 'probe6' || kind === 'probe7')))) && name === 'cloudflare-probe-3.json'
        ? JSON.stringify({ replays: [{ file: probe3Replay, runId: probeRunId, sha256: 'd'.repeat(64), recordedResume: false }] }) : (kind === 'probe4' || (kind === 'probe5' || (kind === 'probe6' || kind === 'probe7'))) && name === 'cloudflare-python-quality.json'
          ? JSON.stringify({replays:[{file:qualityReplay,runId:probeRunId,sha256:'e'.repeat(64),recordedResume:false}]}) : (kind === 'probe5' || (kind === 'probe6' || kind === 'probe7')) && name === 'cloudflare-probe-4.json'
            ? JSON.stringify({replays:[{file:probe4Replay,runId:probeRunId,sha256:'f'.repeat(64),recordedResume:false}]}) : (kind === 'probe6' || kind === 'probe7') && name === 'cloudflare-probe-5.json' ? JSON.stringify({replays:[{file:probe5Replay,runId:probeRunId,sha256:'a'.repeat(64),recordedResume:false}]}) : kind === 'probe7' && name === 'cloudflare-probe-6.json' ? JSON.stringify({replays:[{file:probe6Replay,runId:probeRunId,sha256:'b'.repeat(64),recordedResume:false}]}) : `history:${name}`;
const claimCampaign = kind === 'revision' ? claimCloudflareRevisionCampaign : kind === 'recovery'
  ? claimCloudflareRecoveryCampaign : (lease: EvaluationLockLease) => claimCloudflareCampaign(lease, kind);
const required = ['cloudflare-evaluation-1', 'cloudflare-evaluation-2',
  'cloudflare-patch-verification', 'cloudflare-quality', ...(kind !== 'revision' ? ['cloudflare-revision'] : []),
  ...(['grounded', 'nonthinking', 'diagnostic', 'probe', 'probe2', 'probe3', 'pythonQuality', 'probe4', 'probe5', 'probe6', 'probe7'].includes(kind) ? ['cloudflare-recovery'] : []),
  ...(['nonthinking', 'diagnostic', 'probe', 'probe2', 'probe3', 'pythonQuality', 'probe4', 'probe5', 'probe6', 'probe7'].includes(kind) ? ['cloudflare-grounded'] : []),
  ...(['diagnostic', 'probe', 'probe2', 'probe3', 'pythonQuality', 'probe4', 'probe5', 'probe6', 'probe7'].includes(kind) ? ['cloudflare-nonthinking'] : []),
  ...(['probe', 'probe2', 'probe3', 'pythonQuality', 'probe4', 'probe5', 'probe6', 'probe7'].includes(kind) ? ['cloudflare-diagnostic'] : []),
  ...(['probe2', 'probe3', 'pythonQuality', 'probe4', 'probe5', 'probe6', 'probe7'].includes(kind) ? ['cloudflare-probe'] : []),
  ...((kind === 'probe3' || (kind === 'pythonQuality' || (kind === 'probe4' || (kind === 'probe5' || (kind === 'probe6' || kind === 'probe7'))))) ? ['cloudflare-probe-2'] : []), ...((kind === 'pythonQuality' || (kind === 'probe4' || (kind === 'probe5' || (kind === 'probe6' || kind === 'probe7')))) ? ['cloudflare-probe-3'] : []), ...((kind === 'probe4' || (kind === 'probe5' || (kind === 'probe6' || kind === 'probe7'))) ? ['cloudflare-python-quality'] : []), ...((kind === 'probe5' || (kind === 'probe6' || kind === 'probe7')) ? ['cloudflare-probe-4'] : [])]
  .flatMap(stem => [`${stem}.claim`, `${stem}.json`])
  .concat(['probe', 'probe2', 'probe3', 'pythonQuality', 'probe4', 'probe5', 'probe6', 'probe7'].includes(kind) ? [diagnosticReplay] : [], ['probe2', 'probe3', 'pythonQuality', 'probe4', 'probe5', 'probe6', 'probe7'].includes(kind) ? [probeReplay] : [], (kind === 'probe3' || (kind === 'pythonQuality' || (kind === 'probe4' || (kind === 'probe5' || (kind === 'probe6' || kind === 'probe7'))))) ? [probe2Replay] : [], (kind === 'pythonQuality' || (kind === 'probe4' || (kind === 'probe5' || (kind === 'probe6' || kind === 'probe7')))) ? [probe3Replay] : [], (kind === 'probe4' || (kind === 'probe5' || (kind === 'probe6' || kind === 'probe7'))) ? [qualityReplay, 'cloudflare-python-quality-history.json'] : [], (kind === 'probe5' || (kind === 'probe6' || kind === 'probe7')) ? [probe4Replay, 'cloudflare-python-probe-history.json', 'cloudflare-python-probe-2-history.json', 'cloudflare-python-probe-3-history.json', 'cloudflare-python-probe-4-history.json'] : []);
if ((kind === 'probe6' || kind === 'probe7')) required.push('cloudflare-probe-5.claim', 'cloudflare-probe-5.json', 'cloudflare-python-probe-5-history.json', probe5Replay);
if (kind === 'probe7') required.push('cloudflare-probe-6.claim', 'cloudflare-probe-6.json', 'cloudflare-python-probe-6-history.json', probe6Replay);
const sidecars = ['cloudflare-evaluation-1-review.json', 'cloudflare-patch-verification-review.json',
  'cloudflare-quality-review.json', 'cloudflare-quality-diagnostic.json', 'cloudflare-quality-preflight.json',
  'cloudflare-quality-preflight-review.json', 'cloudflare-quality-preflight-receipt.json',
  'cloudflare-quality-67b5f450-80c4-403d-8a57-0280642258e1.replay.json',
  'cloudflare-quality-f5b9481e-fb06-4e12-8db0-639d6bef019b.replay.json'];
if (kind !== 'revision') sidecars.push('cloudflare-revision-review.json', 'cloudflare-revision-preflight.json',
  'cloudflare-revision-preflight-review.json', 'cloudflare-revision-preflight-receipt.json',
  'cloudflare-revision-101855df-90b1-4479-8db6-99d57b319170.replay.json');
if (['grounded', 'nonthinking', 'diagnostic', 'probe', 'probe2', 'probe3', 'pythonQuality', 'probe4', 'probe5', 'probe6', 'probe7'].includes(kind)) sidecars.push('cloudflare-recovery-review.json', 'cloudflare-recovery-preflight.json',
  'cloudflare-recovery-preflight-review.json', 'cloudflare-recovery-preflight-receipt.json',
  'cloudflare-recovery-50a70ddd-f054-4f55-8362-9dbc43decc9a.replay.json',
  'cloudflare-recovery-b9be947b-f0b4-4160-84ca-1829e74c9ba8.replay.json');
if (['nonthinking', 'diagnostic', 'probe', 'probe2', 'probe3', 'pythonQuality', 'probe4', 'probe5', 'probe6', 'probe7'].includes(kind)) sidecars.push('cloudflare-grounded-review.json',
  'cloudflare-grounded-53a2acc8-127e-4c4b-8e6f-9fc42db07532.replay.json');
if (kind === 'diagnostic' || kind === 'probe' || kind === 'probe2' || kind === 'probe3' || (kind === 'pythonQuality' || (kind === 'probe4' || (kind === 'probe5' || (kind === 'probe6' || kind === 'probe7'))))) sidecars.push('cloudflare-nonthinking-review.json',
  'cloudflare-nonthinking-1c18c417-145e-45ef-8e4a-64931326498f.replay.json');
const stem = kind === 'probe7' ? 'cloudflare-probe-7' : kind === 'probe6' ? 'cloudflare-probe-6' : kind === 'probe5' ? 'cloudflare-probe-5' : kind === 'probe4' ? 'cloudflare-probe-4' : kind === 'probe2' ? 'cloudflare-probe-2' : kind === 'probe3' ? 'cloudflare-probe-3' : kind === 'pythonQuality' ? 'cloudflare-python-quality' : `cloudflare-${kind}`;
const claimName = `${stem}.claim`, reportName = `${stem}.json`;
const denied = `EVAL_CLOUDFLARE_${kind.toUpperCase()}_ALREADY_CLAIMED`;
// Inventory tests cover every policy name. File-type rejection uses the same
// loop: sample a required claim/report and an optional review/replay per policy.
const historyFileTypes = [required[0], required.at(-1)!, sidecars[0], sidecars.at(-1)!];

async function temporary(work: (dir: string) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'revision-claim-')));
  const dir = join(root, '.artifacts');
  await mkdir(dir);
  const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root);
  try {
    for (const name of required) await writeFile(join(dir, name), historyContent(name));
    await work(dir);
  } finally { cwd.mockRestore(); vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); }
}

test('claims once with private modes and fixed pending scope; preflight failure retains claim and history', () => temporary(async dir => {
  for (const name of sidecars) await writeFile(join(dir, name), `history:${name}`);
  await expect(withEvaluationLock(async lease => {
    const checkpoint = await claimCampaign(lease);
    expect(JSON.parse(await readFile(join(dir, reportName), 'utf8'))).toEqual({
      stopped: 'PREFLIGHT_PENDING', scope: kind === 'revision' ? 'non-diver-preflight-plus-30-once'
        : kind === 'recovery' ? 'two-included-preflights-plus-28-once'
          : kind === 'grounded' ? 'grounded-two-included-plus-28-210-calls-39-invocations-once'
            : kind === 'nonthinking' ? 'nonthinking-unknown-cost-once-7-calls-1-start'
              : kind === 'diagnostic' ? 'diagnostic-two-included-plus-28-210-calls-39-invocations-once'
                : kind === 'probe' ? 'probe-unknown-cost-once-7-calls-1-invocation-free-only'
                  : kind === 'probe2' ? 'probe-2-unknown-cost-once-7-calls-1-invocation-free-only'
                    : kind === 'probe3' ? 'probe-3-unknown-cost-once-7-calls-1-invocation-free-only' : kind === 'probe7' ? 'probe-7-unknown-cost-once-7-calls-1-invocation-free-only' : kind === 'probe6' ? 'probe-6-unknown-cost-once-7-calls-1-invocation-free-only' : kind === 'probe5' ? 'probe-5-unknown-cost-once-7-calls-1-invocation-free-only' : kind === 'probe4' ? 'probe-4-unknown-cost-once-7-calls-1-invocation-free-only' : 'python-quality-two-included-plus-28-210-calls-39-invocations-once-free-only', textReview: 'pending',
      evaluationGatePassed: false, accountingComplete: false, cumulativeTokens: null, records: [],
    });
    for (const name of [claimName, reportName]) expect((await lstat(join(dir, name))).mode & 0o777).toBe(0o600);
    await checkpoint({ stopped: 'PREFLIGHT_GOAL_STOP', cumulativeTokens: null });
    throw new Error('PREFLIGHT_FAILED');
  })).rejects.toThrow('PREFLIGHT_FAILED');
  await expect(withEvaluationLock(claimCampaign)).rejects.toThrow(denied);
  expect(await readFile(join(dir, claimName), 'utf8')).toBe('');
  expect(JSON.parse(await readFile(join(dir, reportName), 'utf8')).stopped).toBe('PREFLIGHT_GOAL_STOP');
  for (const name of [...required, ...sidecars]) expect(await readFile(join(dir, name), 'utf8')).toBe(historyContent(name));
  expect(await readdir(dir)).not.toContain('live-evaluation.lock');
}));

test.each(required)('missing history %s blocks before claim', name => temporary(async dir => {
  await rm(join(dir, name));
  await expect(withEvaluationLock(claimCampaign)).rejects.toThrow(denied);
  expect(await readdir(dir)).not.toContain(claimName);
  expect(await readdir(dir)).not.toContain(reportName);
}));

test.each([claimName, reportName, 'cloudflare-evaluation-3.claim', 'cloudflare-evaluation-2-review.json',
  'cloudflare-patch-future.json', 'cloudflare-patch-verification-2.claim', 'cloudflare-quality-2.claim',
  'cloudflare-quality-future.json', 'cloudflare-quality-00000000-0000-4000-8000-000000000000.replay.json',
  'cloudflare-quality-67b5f450-80c4-403d-8a57-0280642258e1.replay.claim',
  `${stem}-preflight.json`, 'cloudflare-revision-2.claim',
  ...(kind === 'recovery' ? ['cloudflare-recovery-preflight-review.json', 'cloudflare-recovery-2.claim',
    'cloudflare-revision-unknown.replay.json', 'cloudflare-recovery.partial', 'cloudflare-evaluation-3.tmp'] : []),
  ...(kind === 'grounded' ? ['cloudflare-grounded-preflight-review.json', 'cloudflare-grounded-2.claim',
    'cloudflare-recovery-unknown.replay.json', 'cloudflare-grounded.partial', 'cloudflare-evaluation-3.tmp'] : []),
  ...(kind === 'nonthinking' ? ['cloudflare-nonthinking-preflight-review.json', 'cloudflare-nonthinking-2.claim',
    'cloudflare-grounded-preflight.json', 'cloudflare-grounded-unknown.replay.json', 'cloudflare-nonthinking.partial'] : []),
  ...(kind === 'diagnostic' ? ['cloudflare-diagnostic-preflight-review.json', 'cloudflare-diagnostic-2.claim',
    'cloudflare-nonthinking-preflight.json', 'cloudflare-nonthinking-unknown.replay.json', 'cloudflare-diagnostic.partial'] : []),
  ...(kind === 'probe' ? ['cloudflare-probe-preflight-review.json', 'cloudflare-probe-2.claim',
    'cloudflare-diagnostic-preflight.json', 'cloudflare-diagnostic-unknown.replay.json', 'cloudflare-probe.partial'] : []),
  ...(kind === 'probe2' ? ['cloudflare-probe-2-preflight-review.json', 'cloudflare-probe-3.claim',
    'cloudflare-probe-unknown.replay.json', 'cloudflare-diagnostic-unknown.replay.json', 'cloudflare-probe-2.partial'] : []),
  ...((kind === 'probe5' || (kind === 'probe6' || kind === 'probe7')) ? ['cloudflare-python-probe-9-history.json', 'cloudflare-python-probe-history-extra.json'] : []),
  ...(kind === 'probe3' ? ['cloudflare-probe-3-preflight-review.json', 'cloudflare-probe-4.claim',
    'cloudflare-probe-2-unknown.replay.json', 'cloudflare-probe-3.partial'] : [])])(
  'preexisting or unknown %s blocks and remains untouched', name => temporary(async dir => {
    await writeFile(join(dir, name), 'foreign');
    await expect(withEvaluationLock(claimCampaign)).rejects.toThrow(denied);
    expect(await readFile(join(dir, name), 'utf8')).toBe('foreign');
    if (name !== claimName) expect(await readdir(dir)).not.toContain(claimName);
    if (name !== reportName) expect(await readdir(dir)).not.toContain(reportName);
  }));

test.each([...historyFileTypes, claimName, reportName])('symlink %s blocks without touching target', name => temporary(async dir => {
  const target = join(dir, 'sentinel');
  await writeFile(target, 'untouched');
  if (required.includes(name)) await rm(join(dir, name));
  await symlink(target, join(dir, name));
  await expect(withEvaluationLock(claimCampaign)).rejects.toThrow(denied);
  expect(await readFile(target, 'utf8')).toBe('untouched');
  expect((await lstat(join(dir, name))).isSymbolicLink()).toBe(true);
  if (name !== claimName) expect(await readdir(dir)).not.toContain(claimName);
}));

test('forged and expired leases cannot claim or checkpoint', () => temporary(async dir => {
  await expect(claimCampaign({} as EvaluationLockLease)).rejects.toThrow('EVAL_LOCK_NOT_OWNED');
  expect(await readdir(dir)).not.toContain(claimName);
  let saved: EvaluationLockLease | undefined;
  const checkpoint = await withEvaluationLock(async lease => {
    saved = lease;
    return claimCampaign(lease);
  });
  const original = await readFile(join(dir, reportName), 'utf8');
  await expect(claimCampaign(saved!)).rejects.toThrow('EVAL_LOCK_NOT_OWNED');
  await expect(checkpoint({ stopped: null })).rejects.toThrow('EVAL_LOCK_NOT_OWNED');
  expect(await readFile(join(dir, reportName), 'utf8')).toBe(original);
}));

test.each([false, true])('lease loss blocks writes (already claimed: %s) and preserves foreign lock', claimed => temporary(async dir => {
  await expect(withEvaluationLock(async lease => {
    const checkpoint = claimed ? await claimCampaign(lease) : undefined;
    const before = claimed ? await readFile(join(dir, reportName), 'utf8') : undefined;
    await rename(join(dir, 'live-evaluation.lock'), join(dir, 'original.lock'));
    await writeFile(join(dir, 'live-evaluation.lock'), 'foreign');
    await expect(claimCampaign(lease)).rejects.toThrow('EVAL_LOCK_NOT_OWNED');
    if (checkpoint) {
      await expect(checkpoint({ stopped: null })).rejects.toThrow('EVAL_LOCK_NOT_OWNED');
      expect(await readFile(join(dir, reportName), 'utf8')).toBe(before);
    }
  })).rejects.toThrow('EVAL_LOCK_NOT_OWNED');
  expect(await readFile(join(dir, 'live-evaluation.lock'), 'utf8')).toBe('foreign');
  expect((await readdir(dir)).includes(claimName)).toBe(claimed);
}));

test.each([false, true])('checkpoint write failure retains claim (initial report exists: %s)', existing => temporary(async dir => {
  await withEvaluationLock(async lease => {
    const checkpoint = existing ? await claimCampaign(lease) : undefined;
    const before = existing ? await readFile(join(dir, reportName), 'utf8') : undefined;
    vi.spyOn(checkpoints, 'writeAtomicCheckpoint').mockRejectedValueOnce(new Error('SYNTHETIC_WRITE_FAILURE'));
    await expect(checkpoint ? checkpoint({ stopped: null }) : claimCampaign(lease))
      .rejects.toThrow('SYNTHETIC_WRITE_FAILURE');
    expect(await readFile(join(dir, claimName), 'utf8')).toBe('');
    if (existing) expect(await readFile(join(dir, reportName), 'utf8')).toBe(before);
    else expect(await readdir(dir)).not.toContain(reportName);
  });
  await expect(withEvaluationLock(claimCampaign)).rejects.toThrow(denied);
}));

test('checkpoint refuses a replaced report symlink, leaving target and claim intact', () => temporary(async dir => {
  await withEvaluationLock(async lease => {
    const checkpoint = await claimCampaign(lease);
    await rename(join(dir, reportName), join(dir, 'saved-report'));
    const target = join(dir, 'sentinel');
    await writeFile(target, 'untouched');
    await symlink(target, join(dir, reportName));
    await expect(checkpoint({ stopped: null })).rejects.toThrow(denied);
    expect(await readFile(target, 'utf8')).toBe('untouched');
    expect((await lstat(join(dir, reportName))).isSymbolicLink()).toBe(true);
    expect(await readFile(join(dir, claimName), 'utf8')).toBe('');
  });
}));

test('exclusive creation preserves a claim appearing after inventory scan', () => temporary(async dir => {
  await withEvaluationLock(async lease => {
    const assertOwned = lock.assertEvaluationLock;
    let checks = 0;
    vi.spyOn(lock, 'assertEvaluationLock').mockImplementation(async current => {
      await assertOwned(current);
      if (++checks === 2) await writeFile(join(dir, claimName), 'competing claim');
    });
    await expect(claimCampaign(lease)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(join(dir, claimName), 'utf8')).toBe('competing claim');
    expect(await readdir(dir)).not.toContain(reportName);
  });
}));

test('lease is rechecked after inventory scan before consuming claim', () => temporary(async dir => {
  await expect(withEvaluationLock(async lease => {
    const assertOwned = lock.assertEvaluationLock;
    let checks = 0;
    vi.spyOn(lock, 'assertEvaluationLock').mockImplementation(async current => {
      if (++checks === 2) {
        await rename(join(dir, 'live-evaluation.lock'), join(dir, 'original.lock'));
        await writeFile(join(dir, 'live-evaluation.lock'), 'foreign');
      }
      await assertOwned(current);
    });
    await expect(claimCampaign(lease)).rejects.toThrow('EVAL_LOCK_NOT_OWNED');
    expect(await readdir(dir)).not.toContain(claimName);
    expect(await readdir(dir)).not.toContain(reportName);
  })).rejects.toThrow('EVAL_LOCK_NOT_OWNED');
  expect(await readFile(join(dir, 'live-evaluation.lock'), 'utf8')).toBe('foreign');
}));

test('symlink artifact directory is refused before claim creation', () => temporary(async dir => {
  await rename(dir, `${dir}-original`);
  await symlink(`${dir}-original`, dir);
  await expect(withEvaluationLock(claimCampaign)).rejects.toThrow('EVAL_LOCK_NOT_OWNED');
  expect(await readdir(`${dir}-original`)).toEqual([...required].sort());
}));

test.each(historyFileTypes)('directory/special history %s is refused', name => temporary(async dir => {
  if (required.includes(name)) await rm(join(dir, name));
  await mkdir(join(dir, name));
  await expect(withEvaluationLock(claimCampaign)).rejects.toThrow(denied);
  expect(await readdir(dir)).not.toContain(claimName);
}));
});
