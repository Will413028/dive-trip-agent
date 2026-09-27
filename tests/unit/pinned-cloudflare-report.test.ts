import { constants } from 'node:fs';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { EvaluationLockLease } from '../../evals/live-evaluation-lock';

const state = vi.hoisted(() => ({ mode: '', reads: 0, closed: 0, locks: 0, sha256: '', opened: [] as string[],
  flags: [] as number[], claim: Buffer.from('{}'), report: Buffer.from('{}'), chunkSize: 2_000_000,
  bytesRead: 0, requested: [] as number[], readPaths: [] as string[] }));
vi.mock('../../evals/live-evaluation-lock', () => ({ assertEvaluationLock: async () => {
  state.locks++;
  if (state.mode === 'lease' || (state.mode === 'lost-lease' && state.locks > 1)) throw new Error('private');
} }));
vi.mock('node:crypto', () => ({ createHash: () => ({ update: () => ({ digest: () => state.sha256 }) }) }));
vi.mock('node:fs/promises', () => {
  const bytesFor = (path: string) => state.mode === 'invalid-json' ? Buffer.from('!}')
    : path.endsWith('.claim') ? state.claim : state.report;
  const stat = (path: string, current = false) => ({
    isDirectory: () => path.endsWith('.artifacts'), isFile: () => !path.endsWith('.artifacts') && state.mode !== 'special',
    dev: 1n, ino: current && state.reads > 0 && state.mode === 'replaced' ? 2n : 1n,
    mode: path.endsWith('.artifacts') ? 0o40700n : 0o100600n, uid: 500n, gid: 500n, nlink: 1n,
    size: state.mode === 'grown' && state.reads > 0 ? 3n : BigInt(bytesFor(path).length),
    mtimeNs: state.mode === 'mtime' && state.reads > 0 ? 2n : 1n,
    ctimeNs: state.mode === 'ctime' && state.reads > 0 ? 2n : 1n,
  });
  return {
    realpath: async (path: string) => state.mode === 'directory-symlink' ? `${path}-other` : path,
    lstat: async (path: string, options?: { bigint: boolean }) => {
      if (path.endsWith('.lock') && !(state.mode === 'new-lock' && state.reads > 0)) {
        throw Object.assign(new Error('absent'), { code: 'ENOENT' });
      }
      if (!path.endsWith('.lock')) expect(options?.bigint).toBe(true);
      return stat(path, true);
    },
    open: async (path: string, flags: number) => {
      if (state.mode === 'missing-claim' && path.endsWith('.claim')) throw Object.assign(new Error('private'), { code: 'ENOENT' });
      state.opened.push(path); state.flags.push(flags); return ({
      stat: async (options: { bigint: boolean }) => { expect(options.bigint).toBe(true); return stat(path); },
      close: async () => { state.closed++; },
      read: async (buffer: Buffer, offset: number, length: number, position: number) => {
        state.reads++;
        state.readPaths.push(path);
        state.requested.push(length);
        const bytes = bytesFor(path);
        const end = state.mode === 'truncated' ? 1 : bytes.length;
        const bytesRead = Math.max(0, Math.min(length, state.chunkSize, end - position));
        bytes.copy(buffer, offset, position, position + bytesRead);
        state.bytesRead += bytesRead;
        return { bytesRead };
      } }); },
  };
});
import { readPinnedCloudflareReport, readCloudflarePreflightReview } from '../../evals/pinned-cloudflare-report';
// Independent public regression pins: the shared IO matrix below is not repeated per profile.
const reports = [
  ['first', 'cloudflare-evaluation-1', 'a4871418af3515b4b8a0b4370c53a3cc1836eb1566dcb9a99e71ead14e829cb2'],
  ['second', 'cloudflare-evaluation-2', '491ffcaccdb30045113dcbc78e511d25e56e6e79faa82cbf0bd705df51e0786b'],
  ['patch', 'cloudflare-patch-verification', '3cd0ada7274e15b4c1813b884c0e0a8a7d1ebc277b3f1c0337c00abf5269248d'],
  ['quality', 'cloudflare-quality', 'bdd12aea5bff6267a47b09ca0f3bd889faa442cc5cb8e703198ff5e16b709713'],
  ['revision', 'cloudflare-revision', '1f3713e89e71eb0e918f7e7a7c155133f6c4d92f6bce198d361f3d7761562cc9'],
  ['recovery', 'cloudflare-recovery', '9d5b67923121efbd04f8c2d4f84f89dae38449aacdca1f7db8ef32d48de4f5fe'],
  ['grounded', 'cloudflare-grounded', 'b7be130c2d2046b8a27c8d30c222d63eafe4c25bd42a03eab60745804f53d3bc'],
  ['nonthinking', 'cloudflare-nonthinking', 'c4aa1d5e258701fd43b82cb84fde1c7bb0b86af52c28a9fc1798374f8084e51b'],
] as const;
beforeEach(() => Object.assign(state, { mode: '', reads: 0, closed: 0, locks: 0, sha256: reports[0][2], opened: [],
  flags: [], claim: Buffer.from('{}'), report: Buffer.from('{}'), chunkSize: 2_000_000,
  bytesRead: 0, requested: [], readPaths: [] }));
afterEach(() => expect(state.closed).toBe(state.opened.length));
const lease = {} as EvaluationLockLease;
test.each(reports)('%s pins its claim, report and digest under an owned lease', async (kind, stem, sha256) => {
  state.sha256 = sha256;
  await expect(readPinnedCloudflareReport(kind, lease)).resolves.toEqual({});
  expect(state.opened.slice(1).map(path => path.split('/').at(-1))).toEqual([`${stem}.claim`, `${stem}.json`]);
  expect(state.closed).toBe(3);
  expect(state.flags).toEqual([constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK]);
  expect(state.locks).toBe(3);
  state.sha256 = reports.find(([otherKind]) => otherKind !== kind)![2];
  await expect(readPinnedCloudflareReport(kind, lease)).rejects.toThrow(/^PINNED_CLOUDFLARE_REPORT_INVALID$/);
});
test('review uses the same bounded mechanism without claiming historical hash provenance', async () => {
  state.sha256 = '0'.repeat(64);
  await expect(readCloudflarePreflightReview(lease)).resolves.toEqual({});
  expect(state.closed).toBe(3);
});
test.each(['revision', 'recovery'] as const)('%s review requires its own claim and exact closed filename', async kind => {
  await expect(readCloudflarePreflightReview(lease, kind)).resolves.toEqual({});
  expect(state.opened.slice(1).map(path => path.split('/').at(-1)))
    .toEqual([`cloudflare-${kind}.claim`, `cloudflare-${kind}-preflight-review.json`]);
});
test('review cannot select an arbitrary path or omit its lease', async () => {
  await expect(readCloudflarePreflightReview(lease, '../other' as 'revision')).rejects.toThrow();
  await expect(readCloudflarePreflightReview(undefined as unknown as EvaluationLockLease, 'revision')).rejects.toThrow();
  expect(state.opened).toEqual([]);
});
test('legacy offline mode requires no lease and no lock', async () => {
  await expect(readPinnedCloudflareReport('first')).resolves.toEqual({});
});
test('an empty permanent claim is accepted and is never parsed as report JSON', async () => {
  state.claim = Buffer.alloc(0);
  await expect(readPinnedCloudflareReport('first', lease)).resolves.toEqual({});
  expect(state.readPaths.every(path => path.endsWith('.json'))).toBe(true);
  expect(state.closed).toBe(3);
  expect(state.locks).toBe(3);
});
test('the exact 2 MB report limit supports partial reads without reading an extra byte', async () => {
  state.claim = Buffer.alloc(0);
  state.report = Buffer.from('{}'.padEnd(2_000_000, ' '));
  state.chunkSize = 32768;
  await expect(readPinnedCloudflareReport('first', lease)).resolves.toEqual({});
  expect(state.bytesRead).toBe(2_000_000);
  expect(state.requested[0]).toBe(2_000_000);
  expect(state.requested.every(length => length > 0 && length <= 2_000_000)).toBe(true);
});
test.each(['claim', 'report'] as const)('%s exceeding 2 MB fails before its payload read', async kind => {
  state[kind] = Buffer.alloc(2_000_001, ' ');
  await expect(readPinnedCloudflareReport('first', lease)).rejects.toThrow(/^PINNED_CLOUDFLARE_REPORT_INVALID$/);
  expect(state.readPaths.some(path => path.endsWith(kind === 'claim' ? '.claim' : '.json'))).toBe(false);
});
test.each(reports.filter(([kind]) => kind !== 'first'))('successor %s cannot use legacy no-lease mode', async kind => {
  await expect(readPinnedCloudflareReport(kind)).rejects.toThrow(/^PINNED_CLOUDFLARE_REPORT_INVALID$/);
  expect(state.opened).toEqual([]);
});
test.each(['replaced', 'grown', 'mtime', 'ctime', 'truncated', 'lost-lease', 'new-lock',
  'lease', 'special', 'directory-symlink', 'missing-claim', 'invalid-json'])(
  'shared reader fails closed on %s', async mode => {
    state.mode = mode;
    await expect(readPinnedCloudflareReport('first', mode === 'new-lock' ? undefined : lease))
      .rejects.toThrow(/^PINNED_CLOUDFLARE_REPORT_INVALID$/);
  });
