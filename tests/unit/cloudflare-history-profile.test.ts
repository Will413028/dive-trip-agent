import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { PUBLIC_HISTORY } from '../../evals/cloudflare-history-public.ts';

type FakeNode = {
  kind: 'directory' | 'file' | 'symlink' | 'special';
  dev: bigint; ino: bigint; mode: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint;
  nlink: bigint; uid: bigint; gid: bigint; bytes: Buffer;
};
type Event = { operation: string; path: string };
const state = vi.hoisted(() => ({
  pin: '', nodes: new Map<string, FakeNode>(), redirects: new Map<string, string>(),
  events: [] as Event[], opened: [] as { path: string; flags: number; closed: number }[],
  hook: undefined as ((event: Event) => void) | undefined,
  chunkSize: 65536, bytesRead: 0, requested: [] as number[],
}));

// No real fs API is available to the module under test, including sync APIs.
vi.mock('node:fs', async original => ({ constants: (await original<typeof import('node:fs')>()).constants }));
vi.mock('node:fs/promises', () => {
  function event(operation: string, path: string) {
    const entry = { operation, path };
    state.events.push(entry);
    state.hook?.(entry);
  }
  function nodeAt(path: string) {
    const node = state.nodes.get(path);
    if (!node) throw new Error(`synthetic missing path: ${path}`);
    return node;
  }
  function stat(node: FakeNode) {
    const snapshot = { ...node };
    return { ...snapshot, isDirectory: () => snapshot.kind === 'directory',
      isFile: () => snapshot.kind === 'file', isSymbolicLink: () => snapshot.kind === 'symlink' };
  }
  return {
    realpath: async (path: string) => {
      event('realpath', path);
      const node = nodeAt(path);
      return state.redirects.get(path) ?? (node.kind === 'symlink' ? `${path}-target` : path);
    },
    lstat: async (path: string, options: { bigint: boolean }) => {
      event('lstat', path);
      expect(options.bigint).toBe(true);
      return stat(nodeAt(path));
    },
    open: async (path: string, flags: number) => {
      event('open', path);
      const node = nodeAt(path);
      if (node.kind === 'symlink' && flags & constants.O_NOFOLLOW) throw new Error('synthetic ELOOP');
      const entry = { path, flags, closed: 0 };
      state.opened.push(entry);
      return {
        stat: async (options: { bigint: boolean }) => {
          event('fstat', path);
          expect(options.bigint).toBe(true);
          return stat(node);
        },
        read: async (buffer: Buffer, offset: number, length: number, position: number) => {
          event('read', path);
          state.requested.push(length);
          const bytesRead = Math.max(0, Math.min(length, state.chunkSize, node.bytes.length - position));
          node.bytes.copy(buffer, offset, position, position + bytesRead);
          state.bytesRead += bytesRead;
          event('after-read', path);
          return { bytesRead };
        },
        close: async () => { entry.closed++; event('close', path); },
      };
    },
  };
});
vi.mock('../../evals/cloudflare-history-public.ts', async original => ({
  ...await original<typeof import('../../evals/cloudflare-history-public.ts')>(),
  get PRIVATE_HISTORY_SHA256() { return state.pin; },
}));

type HistoryModule = typeof import('../../evals/cloudflare-history-profile.ts');
type Key = keyof typeof PUBLIC_HISTORY;
const root = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const directory = join(root, '.artifacts');
const profile = join(directory, 'cloudflare-history-identities.json');
const keys = Object.keys(PUBLIC_HISTORY) as Key[];
const uuidKey = keys.find(key => PUBLIC_HISTORY[key].includes('-'))!;
const hashKey = keys.find(key => PUBLIC_HISTORY[key].length === 64)!;
const schemaKey = keys.find(key => PUBLIC_HISTORY[key].startsWith('test_'))!;
const accountKey: Key = 'accountId_1';
const errorPattern = /^EVAL_PRIVATE_HISTORY_INVALID$/;
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

// Synthetic bytes for all public keys; the real ignored profile is never read.
const privateIdentities = Object.fromEntries(keys.map(key => {
  const sample = PUBLIC_HISTORY[key], hex = sha(`history-profile-unit-only:${key}`);
  const value = sample.includes('-')
    ? `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
    : sample.startsWith('test_') ? `test_${hex.slice(0, 32)}` : hex.slice(0, sample.length);
  return [key, value];
})) as Record<Key, string>;
const validProfile = () => ({ schemaVersion: 1, identities: { ...privateIdentities } });
let history: HistoryModule;

function fakeNode(kind: FakeNode['kind'], ino: bigint, bytes = Buffer.alloc(0)): FakeNode {
  return { kind, ino, dev: 1n, mode: kind === 'directory' ? 0o40700n : 0o100600n,
    size: BigInt(bytes.length), mtimeNs: 1000n, ctimeNs: 1000n, nlink: 1n, uid: 500n, gid: 500n, bytes };
}

function setBytes(bytes: Buffer, approve = true) {
  const file = state.nodes.get(profile)!;
  file.bytes = bytes;
  file.size = BigInt(bytes.length);
  if (approve) state.pin = sha(bytes);
}

function approve(value: unknown) { setBytes(Buffer.from(JSON.stringify(value))); }

function once(operation: string, path: string, mutate: () => void) {
  state.hook = event => {
    if (event.operation === operation && event.path === path) {
      state.hook = undefined;
      mutate();
    }
  };
}

async function rejectedBeforeWork() {
  const work = vi.fn(async () => 'must not run');
  await expect(history.withPrivateCloudflareHistory(work)).rejects.toThrow(errorPattern);
  expect(work).not.toHaveBeenCalled();
  expect(history.historyIdentity(uuidKey)).toBe(PUBLIC_HISTORY[uuidKey]);
}

beforeEach(async () => {
  vi.stubEnv('CI', undefined);
  vi.stubEnv('GITHUB_ACTIONS', undefined);
  Object.assign(state, { pin: '', nodes: new Map(), redirects: new Map(), events: [], opened: [],
    hook: undefined, chunkSize: 65536, bytesRead: 0, requested: [] });
  state.nodes.set(root, fakeNode('directory', 1n));
  state.nodes.set(directory, fakeNode('directory', 2n));
  state.nodes.set(profile, fakeNode('file', 3n));
  approve(validProfile());
  vi.resetModules();
  history = await import('../../evals/cloudflare-history-profile.ts');
});

afterEach(() => {
  try {
    expect(state.opened.every(handle => handle.closed === 1)).toBe(true);
  } finally {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  }
});

test('import and all default lookups do zero IO, even without any local files', () => {
  expect(state.events).toEqual([]);
  state.nodes.clear();
  for (const key of keys) expect(history.historyIdentity(key)).toBe(PUBLIC_HISTORY[key]);
  expect(state.events).toEqual([]);
});

test('pure imports and CI rejection never import the private filesystem module', async () => {
  const syntheticFs = await import('node:fs/promises');
  const syntheticSyncFs = await import('node:fs');
  const importFs = vi.fn(() => { throw new Error('filesystem module import forbidden'); });
  vi.doMock('node:fs/promises', importFs);
  vi.doMock('node:fs', importFs);
  vi.resetModules();
  try {
    const pure = await import('../../evals/cloudflare-history-profile.ts');
    for (const key of keys) expect(pure.historyIdentity(key)).toBe(PUBLIC_HISTORY[key]);
    await expect(pure.assertPrivateCloudflareHistory()).rejects.toThrow(errorPattern);
    vi.stubEnv('CI', '');
    await expect(pure.withPrivateCloudflareHistory(async () => undefined)).rejects.toThrow(errorPattern);
    expect(importFs).not.toHaveBeenCalled();
    expect(state.events).toEqual([]);
  } finally {
    vi.doMock('node:fs/promises', () => syntheticFs);
    vi.doMock('node:fs', () => syntheticSyncFs);
    vi.resetModules();
  }
});

test.each(['__proto__', 'constructor', '../other', '', null, undefined, 1])(
  'invalid runtime key %s fails without IO', key => {
    expect(() => history.historyIdentity(key as Key)).toThrow(errorPattern);
    expect(state.events).toEqual([]);
  });

test('uses only fixed import-relative paths, bounded partial reads and nofollow handles', async () => {
  const cwd = vi.spyOn(process, 'cwd').mockReturnValue('/synthetic-unrelated-cwd');
  state.chunkSize = 17;
  const answer = await history.withPrivateCloudflareHistory(async () => {
    for (const key of keys) expect(history.historyIdentity(key)).toBe(privateIdentities[key]);
    return { result: 42 };
  });
  expect(answer).toEqual({ result: 42 });
  expect(cwd).not.toHaveBeenCalled();
  expect(state.opened.map(({ path, flags }) => ({ path, flags }))).toEqual([
    { path: root, flags: constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW },
    { path: directory, flags: constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW },
    { path: profile, flags: constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK },
  ]);
  expect(state.events.every(({ path }) => [root, directory, profile].includes(path))).toBe(true);
  expect(state.bytesRead).toBe(state.nodes.get(profile)!.bytes.length);
  expect(state.requested.every(length => length > 0 && length <= 65536)).toBe(true);
  expect(history.historyIdentity(uuidKey)).toBe(PUBLIC_HISTORY[uuidKey]);
});

test('schema and identities are frozen before callback entry', async () => {
  const freeze = vi.spyOn(Object, 'freeze');
  await history.withPrivateCloudflareHistory(async () => {
    const frozen = freeze.mock.calls.map(([value]) => value);
    const parsed = frozen.find(value => typeof value === 'object' && value !== null && 'schemaVersion' in value) as
      { identities: object } | undefined;
    expect(parsed).toBeDefined();
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed!.identities)).toBe(true);
    expect(Reflect.set(parsed!.identities, uuidKey, PUBLIC_HISTORY[uuidKey])).toBe(false);
    expect(history.historyIdentity(uuidKey)).toBe(privateIdentities[uuidKey]);
  });
});

test('private contract does not derive its schema from replaceable public example values', async () => {
  const original = await vi.importActual<typeof import('../../evals/cloudflare-history-public.ts')>('../../evals/cloudflare-history-public.ts');
  vi.doMock('../../evals/cloudflare-history-public.ts', () => ({
    PUBLIC_HISTORY: { ...original.PUBLIC_HISTORY, accountId_1: 'an-editorial-example-not-a-schema' },
    get PRIVATE_HISTORY_SHA256() { return state.pin; },
  }));
  vi.resetModules();
  try {
    const isolated = await import('../../evals/cloudflare-history-profile.ts');
    await isolated.withPrivateCloudflareHistory(async () => {
      expect(isolated.historyIdentity(accountKey)).toBe(privateIdentities[accountKey]);
      await isolated.assertPrivateCloudflareHistory();
    });
  } finally {
    vi.doMock('../../evals/cloudflare-history-public.ts', () => ({
      ...original, get PRIVATE_HISTORY_SHA256() { return state.pin; },
    }));
    vi.resetModules();
  }
});

test.each(['CI', 'GITHUB_ACTIONS'] as const)('%s presence rejects before IO, including false/empty values', async name => {
  for (const value of ['true', 'false', '0', '']) {
    vi.stubEnv(name, value);
    await rejectedBeforeWork();
    expect(state.events).toEqual([]);
    expect(history.historyIdentity(uuidKey)).toBe(PUBLIC_HISTORY[uuidKey]);
  }
});

test('CI appearing during loading rejects before callback', async () => {
  once('after-read', profile, () => vi.stubEnv('CI', ''));
  await rejectedBeforeWork();
});

test('assert requires an active private context before any IO', async () => {
  await expect(history.assertPrivateCloudflareHistory()).rejects.toThrow(errorPattern);
  expect(state.events).toEqual([]);
});

test.each([root, directory, profile])('missing %s fails closed', async path => {
  state.nodes.delete(path);
  await rejectedBeforeWork();
  expect(state.bytesRead).toBe(0);
});

test.each([root, directory, profile])('symlink at %s is rejected before payload IO', async path => {
  state.nodes.get(path)!.kind = 'symlink';
  await rejectedBeforeWork();
  expect(state.bytesRead).toBe(0);
});

test.each([root, directory, profile])('canonical path drift at %s is rejected', async path => {
  state.redirects.set(path, `${path}-redirected`);
  await rejectedBeforeWork();
  expect(state.bytesRead).toBe(0);
});

test.each([root, directory, profile])('inode replacement while opening %s is rejected before reading', async path => {
  once('open', path, () => state.nodes.set(path, { ...state.nodes.get(path)!, ino: 900n }));
  await rejectedBeforeWork();
  expect(state.bytesRead).toBe(0);
});

test.each([root, directory, profile])('symlink swap while opening %s is rejected', async path => {
  once('open', path, () => { state.nodes.get(path)!.kind = 'symlink'; });
  await rejectedBeforeWork();
  expect(state.bytesRead).toBe(0);
});

test.each(['directory', 'special'] as const)('non-regular profile (%s) is rejected without reading', async kind => {
  state.nodes.get(profile)!.kind = kind;
  await rejectedBeforeWork();
  expect(state.bytesRead).toBe(0);
});

test.each([0, 65537])('invalid initial size %s is rejected before reading', async size => {
  state.nodes.get(profile)!.size = BigInt(size);
  await rejectedBeforeWork();
  expect(state.bytesRead).toBe(0);
});

test('exactly 64 KiB is accepted without reading an extra byte', async () => {
  const bytes = Buffer.from(JSON.stringify(validProfile()).padEnd(65536, ' '));
  setBytes(bytes);
  await history.withPrivateCloudflareHistory(async () => undefined);
  expect(state.bytesRead).toBe(65536);
  expect(state.requested).toEqual([65536]);
});

test('short EOF rejects rather than parsing a truncated snapshot', async () => {
  state.nodes.get(profile)!.bytes = state.nodes.get(profile)!.bytes.subarray(0, 5);
  await rejectedBeforeWork();
});

test.each(['dev', 'ino', 'mode', 'size', 'mtimeNs', 'ctimeNs', 'nlink', 'uid', 'gid'] as const)(
  'mid-read file %s changes are rejected', async field => {
    once('after-read', profile, () => { state.nodes.get(profile)![field]++; });
    await rejectedBeforeWork();
  });

test.each([root, directory, profile])('path replacement after reading %s is rejected', async path => {
  once('after-read', profile, () => state.nodes.set(path, { ...state.nodes.get(path)!, ino: 900n }));
  await rejectedBeforeWork();
});

test.each(['dev', 'mode', 'uid', 'gid'] as const)('directory %s drift during reading is rejected', async field => {
  once('after-read', profile, () => { state.nodes.get(directory)![field]++; });
  await rejectedBeforeWork();
});

test.each([root, directory, profile])('symlink replacement after reading %s is rejected', async path => {
  once('after-read', profile, () => { state.nodes.get(path)!.kind = 'symlink'; });
  await rejectedBeforeWork();
});

test('growth during a read never consumes beyond the original bounded size', async () => {
  const size = Number(state.nodes.get(profile)!.size);
  state.chunkSize = 23;
  once('after-read', profile, () => setBytes(Buffer.alloc(100000, 'x'), false));
  await rejectedBeforeWork();
  expect(state.bytesRead).toBeLessThanOrEqual(size);
});

test('exact bytes, including JSON whitespace, must match the approved pin', async () => {
  setBytes(Buffer.concat([state.nodes.get(profile)!.bytes, Buffer.from('\n')]), false);
  await rejectedBeforeWork();
});

test('well-formed identity mutation with unchanged stats still fails the digest', async () => {
  const changed = validProfile();
  changed.identities[uuidKey] = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  setBytes(Buffer.from(JSON.stringify(changed)), false);
  await rejectedBeforeWork();
});

test.each(['', 'a'.repeat(63), 'A'.repeat(64), 'a'.repeat(64) + '\n', 'not-a-pin'])('invalid approved pin %s rejects before IO', async pin => {
  state.pin = pin;
  await rejectedBeforeWork();
  expect(state.events).toEqual([]);
});

const invalidProfiles: [string, () => unknown][] = [
  ['null', () => null], ['array', () => []], ['string', () => 'private payload'],
  ['missing schema', () => ({ identities: privateIdentities })],
  ['missing identities', () => ({ schemaVersion: 1 })],
  ['extra envelope key', () => ({ ...validProfile(), extra: 'private payload' })],
  ['wrong version', () => ({ ...validProfile(), schemaVersion: 2 })],
  ['string version', () => ({ ...validProfile(), schemaVersion: '1' })],
  ['null identities', () => ({ schemaVersion: 1, identities: null })],
  ['array identities', () => ({ schemaVersion: 1, identities: Object.values(privateIdentities) })],
  ['missing key', () => ({ ...validProfile(), identities: { ...privateIdentities, [uuidKey]: undefined } })],
  ['extra key', () => ({ ...validProfile(), identities: { ...privateIdentities, extra: 'private payload' } })],
  ['same count with wrong key', () => ({ ...validProfile(), identities: {
    ...privateIdentities, [uuidKey]: undefined, extra: privateIdentities[uuidKey],
  } })],
  ['prototype key', () => ({ ...validProfile(), identities: { ...privateIdentities, ['__proto__']: {} } })],
  ...([null, 1, false, {}, [], ['private payload']] as unknown[]).map(value => [
    `non-string identity ${JSON.stringify(value)}`,
    () => ({ ...validProfile(), identities: { ...privateIdentities, [uuidKey]: value } }),
  ] as [string, () => unknown]),
  ...([
    [uuidKey, 'bad-uuid'], [uuidKey, 'a'.repeat(32)], [uuidKey, privateIdentities[uuidKey] + '\n'],
    [uuidKey, 'aaaaaaaa-aaaa-0aaa-8aaa-aaaaaaaaaaaa'], [uuidKey, 'aaaaaaaa-aaaa-4aaa-0aaa-aaaaaaaaaaaa'],
    [accountKey, 'a'.repeat(64)], [accountKey, 'g'.repeat(32)],
    [hashKey, 'a'.repeat(32)], [hashKey, 'A'.repeat(64)],
    [schemaKey, 'public'], [schemaKey, 'test_' + 'g'.repeat(32)],
    [schemaKey, 'test_' + 'a'.repeat(32) + '_adk'],
  ] as [Key, string][]).map(([key, value]) => [
    `wrong identity shape ${key}/${value}`,
    () => ({ ...validProfile(), identities: { ...privateIdentities, [key]: value } }),
  ] as [string, () => unknown]),
];

test.each(invalidProfiles)('rejects pinned but invalid profile: %s', async (_name, makeProfile) => {
  approve(makeProfile());
  await rejectedBeforeWork();
});

test.each([Buffer.from('{synthetic-private-invalid-json'), Buffer.from([0xff, 0xfe, 0xfd])])(
  'malformed JSON / UTF-8 is rejected even with an approved digest', async bytes => {
    setBytes(bytes);
    await rejectedBeforeWork();
  });

test('caller path/JSON/env arguments cannot override the fixed profile', async () => {
  vi.stubEnv('DIVE_TRIP_CLOUDFLARE_HISTORY_PATH', '/synthetic-override.json');
  vi.stubEnv('DIVE_TRIP_CLOUDFLARE_HISTORY_JSON', JSON.stringify(validProfile()));
  vi.stubEnv('DIVE_TRIP_CLOUDFLARE_HISTORY_SHA256', state.pin);
  state.nodes.delete(profile);
  const work = vi.fn(async () => undefined);
  const call = history.withPrivateCloudflareHistory as (...args: unknown[]) => Promise<unknown>;
  await expect(call(work, '/synthetic-override.json', validProfile())).rejects.toThrow(errorPattern);
  expect(work).not.toHaveBeenCalled();
  expect(state.events.every(({ path }) => [root, directory, profile].includes(path))).toBe(true);
});

test('private callbacks coexist with public fixture work and reset independently', async () => {
  const started = Promise.withResolvers<void>();
  const releaseA = Promise.withResolvers<void>(), releaseB = Promise.withResolvers<void>();
  let entered = 0;
  const work = (release: Promise<void>) => history.withPrivateCloudflareHistory(async () => {
    expect(history.historyIdentity(uuidKey)).toBe(privateIdentities[uuidKey]);
    if (++entered === 2) started.resolve();
    await release;
    expect(history.historyIdentity(uuidKey)).toBe(privateIdentities[uuidKey]);
    await history.assertPrivateCloudflareHistory();
  });
  const a = work(releaseA.promise), b = work(releaseB.promise);
  await started.promise;
  expect(history.historyIdentity(uuidKey)).toBe(PUBLIC_HISTORY[uuidKey]);
  await expect(history.assertPrivateCloudflareHistory()).rejects.toThrow(errorPattern);
  releaseA.resolve();
  await a;
  expect(history.historyIdentity(uuidKey)).toBe(PUBLIC_HISTORY[uuidKey]);
  releaseB.resolve();
  await b;
  expect(history.historyIdentity(uuidKey)).toBe(PUBLIC_HISTORY[uuidKey]);
});

test('nested callback rejection restores the outer context and preserves the work error', async () => {
  const failure = new Error('synthetic callback failure');
  await history.withPrivateCloudflareHistory(async () => {
    await expect(history.withPrivateCloudflareHistory(async () => { throw failure; })).rejects.toBe(failure);
    expect(history.historyIdentity(uuidKey)).toBe(privateIdentities[uuidKey]);
    await history.assertPrivateCloudflareHistory();
  });
  expect(history.historyIdentity(uuidKey)).toBe(PUBLIC_HISTORY[uuidKey]);
  await expect(history.withPrivateCloudflareHistory(async () => { throw failure; })).rejects.toBe(failure);
  expect(history.historyIdentity(uuidKey)).toBe(PUBLIC_HISTORY[uuidKey]);
});

test.each([false, true])('escaped async descendants fail closed after callback settlement (rejected=%s)', async rejected => {
  const release = Promise.withResolvers<void>();
  const failure = new Error('synthetic work failure');
  let detached!: Promise<void>;
  const work = history.withPrivateCloudflareHistory(async () => {
    detached = release.promise.then(async () => {
      expect(() => history.historyIdentity(uuidKey)).toThrow(errorPattern);
      const count = state.events.length;
      await expect(history.assertPrivateCloudflareHistory()).rejects.toThrow(errorPattern);
      expect(state.events).toHaveLength(count);
    });
    if (rejected) throw failure;
  });
  if (rejected) await expect(work).rejects.toBe(failure);
  else await work;
  release.resolve();
  await detached;
});

test('an in-flight assertion fails if its originating callback ends during the reread', async () => {
  let assertion!: Promise<void>;
  await history.withPrivateCloudflareHistory(async () => {
    assertion = expect(history.assertPrivateCloudflareHistory()).rejects.toThrow(errorPattern);
  });
  await assertion;
  expect(history.historyIdentity(uuidKey)).toBe(PUBLIC_HISTORY[uuidKey]);
});

test('assert reopens and rereads the pinned file on every dispatch check', async () => {
  await history.withPrivateCloudflareHistory(async () => {
    const size = state.bytesRead;
    await history.assertPrivateCloudflareHistory();
    await history.assertPrivateCloudflareHistory();
    expect(state.bytesRead).toBe(size * 3);
    expect(state.opened.filter(handle => handle.path === profile)).toHaveLength(3);
    expect(state.opened.every(handle => handle.closed === 1)).toBe(true);
  });
});

test.each(['CI', 'GITHUB_ACTIONS'] as const)('assert rejects %s before reread IO', async name => {
  await history.withPrivateCloudflareHistory(async () => {
    const count = state.events.length;
    vi.stubEnv(name, '');
    await expect(history.assertPrivateCloudflareHistory()).rejects.toThrow(errorPattern);
    expect(state.events).toHaveLength(count);
  });
});

test.each(['missing', 'content', 'same-bytes-new-inode', 'mtime', 'ctime', 'symlink', 'root', 'directory'])(
  'dispatch reread rejects snapshot mutation: %s', async mutation => {
    await history.withPrivateCloudflareHistory(async () => {
      const node = state.nodes.get(profile)!;
      if (mutation === 'missing') state.nodes.delete(profile);
      if (mutation === 'content') node.bytes[0] = '!'.charCodeAt(0);
      if (mutation === 'same-bytes-new-inode') state.nodes.set(profile, { ...node, ino: 900n });
      if (mutation === 'mtime') node.mtimeNs++;
      if (mutation === 'ctime') node.ctimeNs++;
      if (mutation === 'symlink') node.kind = 'symlink';
      if (mutation === 'root' || mutation === 'directory') state.nodes.get(mutation === 'root' ? root : directory)!.ino++;
      await expect(history.assertPrivateCloudflareHistory()).rejects.toThrow(errorPattern);
      expect(history.historyIdentity(uuidKey)).toBe(privateIdentities[uuidKey]);
    });
  });

test('normal artifact-directory metadata changes do not invalidate a held directory identity', async () => {
  await history.withPrivateCloudflareHistory(async () => {
    state.nodes.get(directory)!.mtimeNs++;
    state.nodes.get(directory)!.size++;
    await history.assertPrivateCloudflareHistory();
  });
});

test.each(['realpath', 'lstat', 'open', 'fstat', 'read', 'close'])(
  'IO failure at %s closes acquired handles and exposes only the fixed error', async operation => {
    const privateError = Object.assign(new Error(`synthetic-private ${profile} ${privateIdentities[uuidKey]}`),
      { path: profile, code: 'SYNTHETIC_PRIVATE', cause: 'synthetic-private-payload' });
    once(operation, profile, () => { throw privateError; });
    let caught: unknown;
    try { await history.withPrivateCloudflareHistory(async () => undefined); }
    catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(Error);
    expect(String(caught)).toBe('Error: EVAL_PRIVATE_HISTORY_INVALID');
    expect((caught as Error).cause).toBeUndefined();
    expect(Object.keys(caught as object)).toEqual([]);
    expect(JSON.stringify(caught)).toBe('{}');
  });
