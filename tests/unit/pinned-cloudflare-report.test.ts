import { constants } from 'node:fs';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { EvaluationLockLease } from '../../evals/live-evaluation-lock';

const state = vi.hoisted(() => ({ mode: '', reads: 0, closed: 0, locks: 0, kind: 'first', opened: [] as string[],
  flags: [] as number[], claim: Buffer.from('{}'), report: Buffer.from('{}'), chunkSize: 2_000_000,
  bytesRead: 0, requested: [] as number[], readPaths: [] as string[] }));
vi.mock('../../evals/live-evaluation-lock', () => ({ assertEvaluationLock: async () => {
  state.locks++;
  if (state.mode === 'lost-lease' && state.locks > 1) throw new Error('private');
} }));
vi.mock('node:crypto', () => ({ createHash: () => ({ update: () => ({ digest: () => state.kind === 'first'
  ? 'a4871418af3515b4b8a0b4370c53a3cc1836eb1566dcb9a99e71ead14e829cb2'
  : state.kind === 'second' ? '491ffcaccdb30045113dcbc78e511d25e56e6e79faa82cbf0bd705df51e0786b'
    : state.kind === 'patch' ? '3cd0ada7274e15b4c1813b884c0e0a8a7d1ebc277b3f1c0337c00abf5269248d'
      : state.kind === 'revision' && state.mode !== 'wrong-hash' ? '1f3713e89e71eb0e918f7e7a7c155133f6c4d92f6bce198d361f3d7761562cc9'
        : 'bdd12aea5bff6267a47b09ca0f3bd889faa442cc5cb8e703198ff5e16b709713' }) }) }));
vi.mock('node:fs/promises', () => {
  const bytesFor = (path: string) => path.endsWith('.claim') ? state.claim : state.report;
  const stat = (path: string, current = false) => ({
    isDirectory: () => path.endsWith('.artifacts'), isFile: () => !path.endsWith('.artifacts'),
    dev: 1n, ino: current && state.reads > 0 && state.mode === 'replaced' ? 2n : 1n,
    mode: path.endsWith('.artifacts') ? 0o40700n : 0o100600n, uid: 500n, gid: 500n, nlink: 1n,
    size: state.mode === 'grown' && state.reads > 0 ? 3n : BigInt(bytesFor(path).length),
    mtimeNs: state.mode === 'mtime' && state.reads > 0 ? 2n : 1n,
    ctimeNs: state.mode === 'ctime' && state.reads > 0 ? 2n : 1n,
  });
  return {
    realpath: async (path: string) => path,
    lstat: async (path: string, options?: { bigint: boolean }) => {
      if (path.endsWith('.lock') && !(state.mode === 'new-lock' && state.reads > 0)) {
        throw Object.assign(new Error('absent'), { code: 'ENOENT' });
      }
      if (!path.endsWith('.lock')) expect(options?.bigint).toBe(true);
      return stat(path, true);
    },
    open: async (path: string, flags: number) => { state.opened.push(path); state.flags.push(flags); return ({
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
beforeEach(() => Object.assign(state, { mode: '', reads: 0, closed: 0, locks: 0, kind: 'first', opened: [],
  flags: [], claim: Buffer.from('{}'), report: Buffer.from('{}'), chunkSize: 2_000_000,
  bytesRead: 0, requested: [], readPaths: [] }));
afterEach(() => expect(state.closed).toBe(state.opened.length));
const lease = {} as EvaluationLockLease;
test.each(['first', 'second', 'patch', 'quality', 'revision'] as const)('shared reader accepts fixed %s report under owned lease', async kind => {
  state.kind = kind;
  await expect(readPinnedCloudflareReport(kind, lease)).resolves.toEqual({});
  expect(state.closed).toBe(3);
  expect(state.flags).toEqual([constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK]);
  expect(state.locks).toBe(3);
});
test('revision pins its own claim/report and refuses a quality digest', async () => {
  state.kind = 'revision';
  await expect(readPinnedCloudflareReport('revision', lease)).resolves.toEqual({});
  expect(state.opened.slice(1).map(path => path.split('/').at(-1))).toEqual(['cloudflare-revision.claim', 'cloudflare-revision.json']);
  state.mode = 'wrong-hash';
  await expect(readPinnedCloudflareReport('revision', lease)).rejects.toThrow(/^PINNED_CLOUDFLARE_REPORT_INVALID$/);
});
test('review uses the same bounded mechanism without claiming historical hash provenance', async () => {
  state.kind = 'revision';
  state.mode = 'wrong-hash';
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
test.each(['second', 'patch', 'quality', 'revision'] as const)('successor %s cannot use legacy no-lease mode', async kind => {
  await expect(readPinnedCloudflareReport(kind)).rejects.toThrow('PINNED_CLOUDFLARE_REPORT_INVALID');
  expect(state.reads).toBe(0);
});
test.each(['replaced', 'grown', 'mtime', 'ctime', 'truncated', 'lost-lease', 'new-lock'])(
  'fails closed on mid-read change: %s', async mode => {
    state.mode = mode;
    await expect(readPinnedCloudflareReport('first', mode === 'new-lock' ? undefined : lease))
      .rejects.toThrow('PINNED_CLOUDFLARE_REPORT_INVALID');
    expect(state.closed).toBe(2);
  });
