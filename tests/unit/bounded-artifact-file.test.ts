import { constants } from 'node:fs';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { withBoundedArtifactDirectory } from '../../evals/bounded-artifact-file.ts';

type Node = {
  kind: 'directory' | 'file'; bytes: Buffer;
  dev: bigint; ino: bigint; mode: bigint; uid: bigint; gid: bigint;
  size: bigint; mtimeNs: bigint; ctimeNs: bigint; nlink: bigint;
};
type Event = { operation: string; path: string };
const state = vi.hoisted(() => ({
  nodes: new Map<string, Node>(), events: [] as Event[],
  opened: [] as { path: string; flags: number; closed: number }[],
  hook: undefined as ((event: Event) => void) | undefined,
  badRead: undefined as number | undefined,
}));
vi.mock('node:fs/promises', () => {
  function event(operation: string, path: string) {
    const entry = { operation, path };
    state.events.push(entry);
    state.hook?.(entry);
  }
  function nodeAt(path: string) {
    const node = state.nodes.get(path);
    if (!node) throw new Error('synthetic missing node');
    return node;
  }
  function stat(node: Node) {
    const snapshot = { ...node };
    return { ...snapshot, isDirectory: () => snapshot.kind === 'directory',
      isFile: () => snapshot.kind === 'file' };
  }
  return {
    realpath: async (path: string) => { event('realpath', path); nodeAt(path); return path; },
    lstat: async (path: string, options: { bigint: boolean }) => {
      event('lstat', path); expect(options.bigint).toBe(true); return stat(nodeAt(path));
    },
    open: async (path: string, flags: number) => {
      event('open', path);
      const node = nodeAt(path), entry = { path, flags, closed: 0 };
      state.opened.push(entry);
      return {
        stat: async (options: { bigint: boolean }) => {
          event('fstat', path); expect(options.bigint).toBe(true); return stat(node);
        },
        read: async (buffer: Buffer, offset: number, length: number, position: number) => {
          event('read', path);
          if (state.badRead !== undefined) return { bytesRead: state.badRead };
          const bytesRead = Math.max(0, Math.min(length, node.bytes.length - position));
          node.bytes.copy(buffer, offset, position, position + bytesRead);
          event('after-read', path);
          return { bytesRead };
        },
        close: async () => { entry.closed++; event('close', path); },
      };
    },
  };
});

const root = '/synthetic-bounded-unit';
const directory = `${root}/artifacts`;
const file = `${directory}/sample.json`;
const bounds = { minBytes: 0, maxBytes: 64 };
const invalid = /^BOUNDED_ARTIFACT_FILE_INVALID$/;
const read = () => withBoundedArtifactDirectory([root, directory], scope => scope.read('sample.json', bounds));

function node(kind: Node['kind'], ino: bigint, bytes = Buffer.alloc(0)): Node {
  return { kind, ino, bytes, dev: 1n, mode: kind === 'directory' ? 0o40700n : 0o100600n,
    uid: 500n, gid: 500n, size: BigInt(bytes.length), mtimeNs: 1n, ctimeNs: 1n, nlink: 1n };
}

function once(operation: string, path: string, mutate: () => void) {
  state.hook = event => {
    if (event.operation === operation && event.path === path) {
      state.hook = undefined;
      mutate();
    }
  };
}

beforeEach(() => {
  Object.assign(state, { nodes: new Map(), events: [], opened: [], hook: undefined, badRead: undefined });
  state.nodes.set(root, node('directory', 1n));
  state.nodes.set(directory, node('directory', 2n));
  state.nodes.set(file, node('file', 3n, Buffer.from('{}')));
});
afterEach(() => expect(state.opened.every(handle => handle.closed === 1)).toBe(true));

test('immutable metadata snapshots can reopen the same file twice after all handles close', async () => {
  const first = await withBoundedArtifactDirectory([root, directory], async scope => ({
    directories: scope.snapshot, file: (await scope.read('sample.json', bounds)).snapshot,
  }));
  expect(Object.isFrozen(first.directories)).toBe(true);
  for (const anchor of first.directories) {
    expect(Object.isFrozen(anchor)).toBe(true);
    expect(Object.isFrozen(anchor.identity)).toBe(true);
    expect(Reflect.set(anchor.identity, 'ino', 100n)).toBe(false);
  }
  expect(Object.isFrozen(first.file)).toBe(true);
  expect(Object.isFrozen(first.file.identity)).toBe(true);
  expect(Reflect.set(first.file.identity, 'size', 0n)).toBe(false);
  for (let i = 0; i < 2; i++) {
    await withBoundedArtifactDirectory([root, directory], async scope => {
      const reopened = await scope.read('sample.json', bounds, first.file);
      expect(reopened.snapshot).toEqual(first.file);
      expect(reopened.bytes.toString()).toBe('{}');
    }, first.directories);
  }
  expect(state.opened).toHaveLength(9);
  expect(state.opened.filter(handle => handle.path === file).every(handle =>
    handle.flags === (constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK))).toBe(true);
});

test.each(['descriptor', 'path'] as const)('file metadata drift on only the %s is rejected before/after reading', async side => {
  // Each field/phase gets a fresh scope; the other observation retains the exact old metadata.
  const fields = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'uid', 'gid', 'nlink'] as const;
  for (const field of fields) for (const phase of ['fstat', 'after-read']) {
    const original = node('file', 3n, Buffer.from('{}'));
    state.nodes.set(file, original);
    once(phase, file, () => {
      state.nodes.set(file, { ...original, [field]: original[field] + (side === 'path' ? 1n : 0n) });
      if (side === 'descriptor') original[field]++;
    });
    await expect(read(), `${side}/${field}/${phase}`).rejects.toThrow(invalid);
    expect(state.opened.every(handle => handle.closed === 1)).toBe(true);
  }
});

test.each(['descriptor', 'path'] as const)('directory identity drift on only the %s is rejected', async side => {
  for (const path of [root, directory]) for (const field of ['dev', 'ino', 'mode', 'uid', 'gid'] as const) {
    const original = node('directory', path === root ? 1n : 2n);
    state.nodes.set(path, original);
    once('after-read', file, () => {
      state.nodes.set(path, { ...original, [field]: original[field] + (side === 'path' ? 1n : 0n) });
      if (side === 'descriptor') original[field]++;
    });
    await expect(read(), `${side}/${path}/${field}`).rejects.toThrow(invalid);
    state.nodes.set(path, node('directory', path === root ? 1n : 2n));
  }
});

test('ordinary sibling changes do not invalidate directory identity snapshots', async () => {
  const snapshot = await withBoundedArtifactDirectory([root, directory], async scope => scope.snapshot);
  for (const path of [root, directory]) {
    const current = state.nodes.get(path)!;
    current.size++; current.mtimeNs++; current.ctimeNs++; current.nlink++;
  }
  await expect(withBoundedArtifactDirectory([root, directory], scope => scope.read('sample.json', bounds), snapshot))
    .resolves.toMatchObject({ bytes: Buffer.from('{}') });
});

test.each(['', '.', '..', '../sample.json', '/sample.json', 'nested/sample.json', 'nested\\sample.json', 'nul\0']) (
  'a scoped read cannot traverse via %j', async name => {
    await expect(withBoundedArtifactDirectory([root, directory], scope => scope.read(name, bounds))).rejects.toThrow(invalid);
    expect(state.events.every(event => event.path === root || event.path === directory)).toBe(true);
  });

test.each([[], [directory, root], [root, `${directory}/nested`], ['relative']].map(paths => ({ paths })))(
  'invalid directory scope $paths rejects before IO', async ({ paths }) => {
    await expect(withBoundedArtifactDirectory(paths, async () => undefined)).rejects.toThrow(invalid);
    expect(state.events).toEqual([]);
  });

test('file snapshots cannot be reused under another name', async () => {
  const first = await read();
  state.nodes.set(`${directory}/other.json`, { ...state.nodes.get(file)! });
  const count = state.events.length;
  await expect(withBoundedArtifactDirectory([root, directory], scope => scope.read('other.json', bounds, first.snapshot)))
    .rejects.toThrow(invalid);
  expect(state.events.slice(count).every(event => event.path !== `${directory}/other.json`)).toBe(true);
});

test('directory snapshots cannot be reused for a different root/chain', async () => {
  const snapshot = await withBoundedArtifactDirectory([root, directory], async scope => scope.snapshot);
  const count = state.events.length;
  await expect(withBoundedArtifactDirectory([directory], async () => undefined, snapshot)).rejects.toThrow(invalid);
  await expect(withBoundedArtifactDirectory(['/other', '/other/artifacts'], async () => undefined, snapshot)).rejects.toThrow(invalid);
  expect(state.events).toHaveLength(count);
});

test('a directory read capability fails closed after its callback returns', async () => {
  const escaped = await withBoundedArtifactDirectory([root, directory], async scope => scope);
  const count = state.events.length;
  await expect(escaped.read('sample.json', bounds)).rejects.toThrow(invalid);
  expect(state.events).toHaveLength(count);
});

test.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 3])(
  'invalid read byte count %s closes every acquired descriptor', async count => {
    state.badRead = count;
    await expect(read()).rejects.toThrow(invalid);
  });

test.each([file, directory, root])('close failure at %s still closes the remaining handles and sanitizes errors', async path => {
  once('close', path, () => { throw Object.assign(new Error('synthetic-private-detail'), { path, cause: 'private' }); });
  let error: unknown;
  try { await read(); } catch (caught) { error = caught; }
  expect(String(error)).toBe('Error: BOUNDED_ARTIFACT_FILE_INVALID');
  expect(Object.keys(error as object)).toEqual([]);
  expect((error as Error).cause).toBeUndefined();
  expect(state.opened).toHaveLength(3);
});
