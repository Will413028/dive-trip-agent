import { constants } from 'node:fs';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { EvaluationLockLease } from '../../evals/live-evaluation-lock';
import { GROUNDED_REPORT_SHA256, NONTHINKING_REPORT_SHA256 } from '../../evals/cloudflare-artifacts';

const state = vi.hoisted(() => ({ mode: '', sha256: '', reads: 0, closed: 0, locks: 0, opened: [] as { path: string; flags: number }[] }));
vi.mock('../../evals/live-evaluation-lock', () => ({ assertEvaluationLock: async () => {
  state.locks++;
  if (state.mode === 'lease' || (state.mode === 'lost-lease' && state.locks > 1)) throw new Error('private');
} }));
vi.mock('node:crypto', () => ({ createHash: () => ({ update: () => ({ digest: () => state.mode === 'wrong-hash'
  ? '1f3713e89e71eb0e918f7e7a7c155133f6c4d92f6bce198d361f3d7761562cc9'
  : state.sha256 }) }) }));
vi.mock('node:fs/promises', () => {
  const stat = (path: string, current = false) => ({
    isDirectory: () => path.endsWith('.artifacts'), isFile: () => !path.endsWith('.artifacts') && state.mode !== 'special',
    dev: 1n, ino: current && state.reads > 0 && state.mode === 'replaced' ? 2n : 1n,
    mode: path.endsWith('.artifacts') ? 0o40700n : 0o100600n, uid: 500n, gid: 500n, nlink: 1n,
    size: state.mode === 'oversized' ? 2000001n : state.mode === 'grown' && state.reads > 0 ? 3n : 2n,
    mtimeNs: state.mode === 'mtime' && state.reads > 0 ? 2n : 1n,
    ctimeNs: state.mode === 'ctime' && state.reads > 0 ? 2n : 1n,
  });
  return {
    realpath: async (path: string) => state.mode === 'directory-symlink' ? `${path}-other` : path,
    lstat: async (path: string, options: { bigint: boolean }) => {
      expect(options.bigint).toBe(true); return stat(path, true);
    },
    open: async (path: string, flags: number) => {
      if (state.mode === 'missing-claim' && path.endsWith('.claim')) throw Object.assign(new Error('private'), { code: 'ENOENT' });
      state.opened.push({ path, flags });
      return { stat: async (options: { bigint: boolean }) => { expect(options.bigint).toBe(true); return stat(path); },
        close: async () => { state.closed++; },
        read: async (buffer: Buffer, offset: number, length: number, position: number) => {
          state.reads++;
          const bytes = Buffer.from(state.mode === 'invalid-json' ? '!}' : '{}');
          const end = state.mode === 'truncated' ? 1 : bytes.length;
          const bytesRead = Math.max(0, Math.min(length, end - position));
          bytes.copy(buffer, offset, position, position + bytesRead);
          return { bytesRead };
        } };
    },
  };
});
import { readPinnedCloudflareReport } from '../../evals/pinned-cloudflare-report';
beforeEach(() => Object.assign(state, { mode: '', reads: 0, closed: 0, locks: 0, opened: [] }));
const lease = {} as EvaluationLockLease;

describe.each([['grounded', GROUNDED_REPORT_SHA256()], ['nonthinking', NONTHINKING_REPORT_SHA256()]] as const)('%s pinned history', (kind, sha256) => {
  beforeEach(() => { state.sha256 = sha256; });

  test('uses its own fixed claim/report/hash with the shared bounded readonly reader', async () => {
    await expect(readPinnedCloudflareReport(kind, lease)).resolves.toEqual({});
    expect(state.opened.slice(1).map(f => f.path.split('/').at(-1))).toEqual([`cloudflare-${kind}.claim`, `cloudflare-${kind}.json`]);
    expect(state.opened[0].flags).toBe(constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    expect(state.opened.slice(1).every(f => f.flags === (constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK))).toBe(true);
    expect(state.closed).toBe(3);
  });

  test('cannot use the original no-lease offline exception', async () => {
    await expect(readPinnedCloudflareReport(kind)).rejects.toThrow(/^PINNED_CLOUDFLARE_REPORT_INVALID$/);
    expect(state.opened).toEqual([]);
  });

  test.each(['wrong-hash', 'lease', 'lost-lease', 'replaced', 'grown', 'mtime', 'ctime', 'truncated',
    'oversized', 'special', 'directory-symlink', 'missing-claim', 'invalid-json'])('fails closed on %s', async mode => {
    state.mode = mode;
    await expect(readPinnedCloudflareReport(kind, lease)).rejects.toThrow(/^PINNED_CLOUDFLARE_REPORT_INVALID$/);
    expect(state.closed).toBe(state.opened.length);
  });
});
