import { expect, test, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rename, rm, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEvaluationLock, assertEvaluationLock, type EvaluationLockLease } from '../../evals/live-evaluation-lock';
import { claimSecondCloudflareCampaign } from '../../evals/cloudflare-second-claim';
import { claimPatchCloudflareCampaign } from '../../evals/cloudflare-patch-claim';
import { claimCloudflareQualityCampaign } from '../../evals/cloudflare-quality-claim';

async function temporary(work: (dir: string) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'evaluation-lock-')));
  const dir = join(root, '.artifacts');
  await mkdir(dir);
  const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root);
  try { await work(dir); }
  finally { cwd.mockRestore(); await rm(root, { recursive: true, force: true }); }
}

test('lease works only while held; concurrent acquisition fails without deleting owner lock', () => temporary(async dir => {
  let saved: EvaluationLockLease | undefined;
  await withEvaluationLock(async lease => {
    saved = lease; await assertEvaluationLock(lease);
    await expect(withEvaluationLock(async () => { throw new Error('UNEXPECTED'); })).rejects.toMatchObject({ code: 'EEXIST' });
    await assertEvaluationLock(lease);
    expect(await readdir(dir)).toEqual(['live-evaluation.lock']);
  });
  expect(await readdir(dir)).toEqual([]);
  await expect(assertEvaluationLock(saved!)).rejects.toThrow('EVAL_LOCK_NOT_OWNED');
  await expect(assertEvaluationLock({} as EvaluationLockLease)).rejects.toThrow('EVAL_LOCK_NOT_OWNED');
}));

test('callback error releases only owned lock', () => temporary(async dir => {
  await expect(withEvaluationLock(async () => { throw new Error('SYNTHETIC'); })).rejects.toThrow('SYNTHETIC');
  expect(await readdir(dir)).toEqual([]);
}));

test.each(['file', 'symlink'])('existing %s lock is never removed or opened as evidence', mode => temporary(async dir => {
  const target = join(dir, 'sentinel'); await writeFile(target, 'untouched');
  if (mode === 'file') await writeFile(join(dir, 'live-evaluation.lock'), 'foreign');
  else await symlink(target, join(dir, 'live-evaluation.lock'));
  await expect(withEvaluationLock(async () => undefined)).rejects.toMatchObject({ code: 'EEXIST' });
  expect(await readFile(target, 'utf8')).toBe('untouched');
  expect((await readdir(dir)).includes('live-evaluation.lock')).toBe(true);
}));

test('lost lock identity refuses dispatch/checkpoint and leaves replacement alone', () => temporary(async dir => {
  await expect(withEvaluationLock(async lease => {
    await rename(join(dir, 'live-evaluation.lock'), join(dir, 'original.lock'));
    await writeFile(join(dir, 'live-evaluation.lock'), 'foreign');
    await expect(assertEvaluationLock(lease)).rejects.toThrow('EVAL_LOCK_NOT_OWNED');
    await expect(claimSecondCloudflareCampaign(lease)).rejects.toThrow('EVAL_LOCK_NOT_OWNED');
  })).rejects.toThrow('EVAL_LOCK_NOT_OWNED');
  expect(await readFile(join(dir, 'live-evaluation.lock'), 'utf8')).toBe('foreign');
}));

test('directory replacement invalidates held lease and preserves foreign lock', () => temporary(async dir => {
  await expect(withEvaluationLock(async lease => {
    await rename(dir, `${dir}-original`);
    await mkdir(dir); await writeFile(join(dir, 'live-evaluation.lock'), 'replacement');
    await expect(assertEvaluationLock(lease)).rejects.toThrow('EVAL_LOCK_NOT_OWNED');
  })).rejects.toThrow('EVAL_LOCK_NOT_OWNED');
  expect(await readFile(join(dir, 'live-evaluation.lock'), 'utf8')).toBe('replacement');
  expect((await readdir(`${dir}-original`)).includes('live-evaluation.lock')).toBe(true);
}));

async function previous(dir: string) {
  await writeFile(join(dir, 'cloudflare-evaluation-1.claim'), 'old claim');
  await writeFile(join(dir, 'cloudflare-evaluation-1.json'), 'old report');
}

test('quality claim consumes its grant even before dispatch, preserves three histories and refuses reuse', () => temporary(async dir => {
  await previous(dir);
  for (const stem of ['cloudflare-evaluation-2', 'cloudflare-patch-verification']) {
    await writeFile(join(dir, `${stem}.claim`), 'old claim');
    await writeFile(join(dir, `${stem}.json`), 'old report');
  }
  const checkpoint = await withEvaluationLock(claimCloudflareQualityCampaign);
  await expect(checkpoint({ stopped: null })).rejects.toThrow('EVAL_LOCK_NOT_OWNED');
  await expect(withEvaluationLock(claimCloudflareQualityCampaign)).rejects.toThrow('EVAL_CLOUDFLARE_QUALITY_ALREADY_CLAIMED');
  expect(await readFile(join(dir, 'cloudflare-patch-verification.json'), 'utf8')).toBe('old report');
  expect(JSON.parse(await readFile(join(dir, 'cloudflare-quality.json'), 'utf8'))).toMatchObject({ stopped: 'PREFLIGHT_PENDING' });
}));
test.each(['cloudflare-quality-preflight-review.json', 'cloudflare-quality.json', 'cloudflare-quality.claim', 'cloudflare-evaluation-3.claim'])(
  'quality grant refuses preexisting %s', name => temporary(async dir => {
    await previous(dir);
    for (const stem of ['cloudflare-evaluation-2', 'cloudflare-patch-verification']) {
      await writeFile(join(dir, `${stem}.claim`), 'old'); await writeFile(join(dir, `${stem}.json`), 'old');
    }
    await writeFile(join(dir, name), 'foreign');
    await expect(withEvaluationLock(claimCloudflareQualityCampaign)).rejects.toThrow('EVAL_CLOUDFLARE_QUALITY_ALREADY_CLAIMED');
    expect(await readFile(join(dir, name), 'utf8')).toBe('foreign');
  }));

test('patch claim consumes one grant, preserves both old reports and denies expired checkpoint', () => temporary(async dir => {
  await previous(dir);
  await writeFile(join(dir, 'cloudflare-evaluation-2.claim'), 'second claim');
  await writeFile(join(dir, 'cloudflare-evaluation-2.json'), 'second report');
  const checkpoint = await withEvaluationLock(claimPatchCloudflareCampaign);
  expect(JSON.parse(await readFile(join(dir, 'cloudflare-patch-verification.json'), 'utf8')).stopped).toBe('PREFLIGHT_PENDING');
  await expect(checkpoint({ stopped: null })).rejects.toThrow('EVAL_LOCK_NOT_OWNED');
  await expect(withEvaluationLock(claimPatchCloudflareCampaign)).rejects.toThrow('EVAL_CLOUDFLARE_PATCH_ALREADY_CLAIMED');
  expect(await readFile(join(dir, 'cloudflare-evaluation-1.json'), 'utf8')).toBe('old report');
  expect(await readFile(join(dir, 'cloudflare-evaluation-2.json'), 'utf8')).toBe('second report');
}));
test('patch grant cannot create a claim with missing history or forged lease', () => temporary(async dir => {
  await expect(claimPatchCloudflareCampaign({} as EvaluationLockLease)).rejects.toThrow('EVAL_LOCK_NOT_OWNED');
  await expect(withEvaluationLock(claimPatchCloudflareCampaign)).rejects.toThrow('EVAL_CLOUDFLARE_PATCH_ALREADY_CLAIMED');
  expect(await readdir(dir)).toEqual([]);
}));

test('second claim persists on failure and prevents another attempt; old bytes are unchanged', () => temporary(async dir => {
  await previous(dir);
  await expect(withEvaluationLock(async lease => {
    const checkpoint = await claimSecondCloudflareCampaign(lease);
    expect(JSON.parse(await readFile(join(dir, 'cloudflare-evaluation-2.json'), 'utf8')).stopped).toBe('PREFLIGHT_PENDING');
    await checkpoint({ stopped: 'UNKNOWN_USAGE_STOP', cumulativeTokens: null });
    throw new Error('STOP');
  })).rejects.toThrow('STOP');
  await expect(withEvaluationLock(claimSecondCloudflareCampaign)).rejects.toThrow('EVAL_CLOUDFLARE_SECOND_ALREADY_CLAIMED');
  expect(await readFile(join(dir, 'cloudflare-evaluation-1.claim'), 'utf8')).toBe('old claim');
  expect(await readFile(join(dir, 'cloudflare-evaluation-1.json'), 'utf8')).toBe('old report');
  expect(JSON.parse(await readFile(join(dir, 'cloudflare-evaluation-2.json'), 'utf8')).stopped).toBe('UNKNOWN_USAGE_STOP');
  expect((await readdir(dir)).includes('live-evaluation.lock')).toBe(false);
}));

test.each(['cloudflare-evaluation-2.json', 'cloudflare-evaluation-2.claim', 'cloudflare-evaluation-3.claim'])(
  'preexisting %s refuses claim/checkpoint', name => temporary(async dir => {
    await previous(dir); await writeFile(join(dir, name), 'foreign');
    await expect(withEvaluationLock(claimSecondCloudflareCampaign)).rejects.toThrow('EVAL_CLOUDFLARE_SECOND_ALREADY_CLAIMED');
    expect(await readFile(join(dir, name), 'utf8')).toBe('foreign');
  }));

test('missing first history and forged lease cannot create a second claim', () => temporary(async dir => {
  await expect(claimSecondCloudflareCampaign({} as EvaluationLockLease)).rejects.toThrow('EVAL_LOCK_NOT_OWNED');
  await expect(withEvaluationLock(claimSecondCloudflareCampaign)).rejects.toThrow('EVAL_CLOUDFLARE_SECOND_ALREADY_CLAIMED');
  expect(await readdir(dir)).toEqual([]);
}));

test('returned checkpoint cannot be used after lease expires', () => temporary(async dir => {
  await previous(dir);
  const checkpoint = await withEvaluationLock(claimSecondCloudflareCampaign);
  await expect(checkpoint({ stopped: null })).rejects.toThrow('EVAL_LOCK_NOT_OWNED');
  expect(JSON.parse(await readFile(join(dir, 'cloudflare-evaluation-2.json'), 'utf8')).stopped).toBe('PREFLIGHT_PENDING');
}));
