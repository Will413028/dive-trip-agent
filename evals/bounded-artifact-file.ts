import type { BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

type DirectoryIdentity = Readonly<Pick<BigIntStats, 'dev' | 'ino' | 'mode' | 'uid' | 'gid'>>;
type FileIdentity = DirectoryIdentity & Readonly<Pick<BigIntStats,
  'size' | 'mtimeNs' | 'ctimeNs' | 'nlink'>>;
export type BoundedArtifactDirectorySnapshot = readonly Readonly<{
  path: string; identity: DirectoryIdentity;
}>[];
export type BoundedArtifactFileSnapshot = Readonly<{ path: string; identity: FileIdentity }>;
type Bounds = Readonly<{ minBytes: number; maxBytes: number }>;
type ArtifactDirectory = Readonly<{
  snapshot: BoundedArtifactDirectorySnapshot;
  read(name: string, bounds: Bounds, expected?: BoundedArtifactFileSnapshot): Promise<Readonly<{
    bytes: Buffer; snapshot: BoundedArtifactFileSnapshot;
  }>>;
}>;

function fail(): never { throw new Error('BOUNDED_ARTIFACT_FILE_INVALID'); }

function directoryIdentity(stat: BigIntStats): DirectoryIdentity {
  // Directory size/timestamps/link count may change when sibling artifacts appear.
  return Object.freeze({ dev: stat.dev, ino: stat.ino, mode: stat.mode, uid: stat.uid, gid: stat.gid });
}

function fileIdentity(stat: BigIntStats): FileIdentity {
  return Object.freeze({ ...directoryIdentity(stat), size: stat.size, mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs, nlink: stat.nlink });
}

function sameDirectory(a: DirectoryIdentity, b: DirectoryIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid && a.gid === b.gid;
}

function sameFile(a: FileIdentity, b: FileIdentity): boolean {
  return sameDirectory(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs
    && a.ctimeNs === b.ctimeNs && a.nlink === b.nlink;
}

/** Hold a canonical parent-to-child directory chain for scoped, bounded reads.
 * Callers own fixed paths, byte limits and all content/authorization policy.
 * Snapshots contain immutable metadata only; no descriptors or payload buffers.
 * Importing this module does not load either filesystem module. */
export async function withBoundedArtifactDirectory<T>(paths: readonly string[],
  work: (directory: ArtifactDirectory) => Promise<T>,
  expected?: BoundedArtifactDirectorySnapshot): Promise<T> {
  try {
    const scope = [...paths];
    if (!scope.length || (expected && expected.length !== scope.length)) fail();
    for (const [index, path] of scope.entries()) {
      if (resolve(path) !== path || (index > 0 && dirname(path) !== scope[index - 1])
        || (expected && expected[index].path !== path)) fail();
    }
    const { constants } = await import('node:fs');
    const { lstat, open, realpath } = await import('node:fs/promises');
    const anchors: { path: string; handle: FileHandle; identity: DirectoryIdentity }[] = [];
    let active = true;
    const checkDirectory = async (anchor: typeof anchors[number]) => {
      if (!active) fail();
      const current = await lstat(anchor.path, { bigint: true });
      const held = await anchor.handle.stat({ bigint: true });
      if (!current.isDirectory() || !held.isDirectory() || !sameDirectory(current, anchor.identity)
        || !sameDirectory(held, anchor.identity) || await realpath(anchor.path) !== anchor.path) fail();
    };
    const checkDirectories = async () => {
      for (const anchor of anchors) await checkDirectory(anchor);
      if (!active) fail();
    };
    try {
      for (const [index, path] of scope.entries()) {
        if (await realpath(path) !== path) fail();
        const before = await lstat(path, { bigint: true });
        if (!before.isDirectory() || (expected && !sameDirectory(before, expected[index].identity))) fail();
        const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        const anchor = { path, handle, identity: directoryIdentity(before) };
        anchors.push(anchor);
        await checkDirectory(anchor);
      }
      const snapshot = Object.freeze(anchors.map(({ path, identity }) => Object.freeze({ path, identity })));
      const directory = scope[scope.length - 1];
      return await work(Object.freeze({
        snapshot,
        async read(name: string, { minBytes, maxBytes }: Bounds, expected?: BoundedArtifactFileSnapshot) {
          if (!active || !name || name === '.' || name === '..' || /[/\\\0]/.test(name)
            || !Number.isSafeInteger(minBytes) || !Number.isSafeInteger(maxBytes)
            || minBytes < 0 || maxBytes < minBytes) fail();
          const path = join(directory, name);
          if (expected && expected.path !== path) fail();
          await checkDirectories();
          const before = await lstat(path, { bigint: true });
          if (!before.isFile() || before.size < BigInt(minBytes) || before.size > BigInt(maxBytes)
            || (expected && !sameFile(before, expected.identity))) fail();
          const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          try {
            // Node has no openat: recheck every held directory before payload IO.
            await checkDirectories();
            const held = await file.stat({ bigint: true });
            const current = await lstat(path, { bigint: true });
            if (!held.isFile() || !current.isFile() || !sameFile(held, before)
              || !sameFile(current, before) || await realpath(path) !== path) fail();
            const bytes = Buffer.alloc(Number(before.size));
            let length = 0;
            while (length < bytes.length) {
              const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
              if (!Number.isInteger(bytesRead) || bytesRead <= 0 || bytesRead > bytes.length - length) fail();
              length += bytesRead;
            }
            const after = await file.stat({ bigint: true });
            const atPath = await lstat(path, { bigint: true });
            if (!after.isFile() || !atPath.isFile() || !sameFile(after, before) || !sameFile(atPath, before)
              || BigInt(length) !== after.size || await realpath(path) !== path) fail();
            await checkDirectories();
            return Object.freeze({ bytes, snapshot: Object.freeze({ path, identity: fileIdentity(after) }) });
          } finally { await file.close(); }
        },
      }));
    } finally {
      active = false;
      let closeFailed = false;
      for (const { handle } of anchors.reverse()) {
        try { await handle.close(); } catch { closeFailed = true; }
      }
      if (closeFailed) fail();
    }
  } catch { return fail(); }
}
