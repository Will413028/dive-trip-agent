import { constants, type Stats } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

/** Source boundary, not a full hermetic runtime: node_modules/container binaries
 * are represented by package/lock/config inputs, not hashed installed bytes.
 * No environment, credentials, artifacts, docs, build outputs or arbitrary roots.
 */
const roots = ['src', 'evals', 'migrations', 'tests/support', 'tests/integration'] as const;
const fixed = ['package.json', 'pnpm-lock.yaml', 'tsconfig.json', 'tsconfig.worker.json', 'vitest.config.ts', 'compose.test.yml', 'data/catalog.json'] as const;
const sourceFile = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|json|sql)$/;
const maxFile = 2_000_000, maxTotal = 32_000_000, maxEntries = 2048;
function fail(): never { throw new Error('EVAL_SOURCE_INVALID'); }
const identity = (s: Stats) => ({ dev: s.dev, ino: s.ino, size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs });

export async function readCloudflareSourceManifest() {
  try {
    const root = resolve('.');
    if (await realpath(root) !== root) fail();
    const scan = async () => {
      const files: { path: string; identity: ReturnType<typeof identity> }[] = [];
      const directories: { path: string; identity: ReturnType<typeof identity> }[] = [];
      let bytes = 0, entries = 0;
      const visit = async (path: string, requiredFile = false) => {
        if (++entries > maxEntries) fail();
        const stat = await lstat(join(root, path));
        if (stat.isSymbolicLink()) fail();
        if (stat.isDirectory() && !requiredFile) {
          directories.push({ path, identity: identity(stat) });
          for (const name of (await readdir(join(root, path))).sort()) {
            if (name.startsWith('.') || name === 'node_modules') continue;
            await visit(`${path}/${name}`);
          }
        } else if (stat.isFile()) {
          if (!requiredFile && !sourceFile.test(path)) return;
          if (stat.size > maxFile || (bytes += stat.size) > maxTotal) fail();
          files.push({ path, identity: identity(stat) });
        } else fail();
      };
      for (const path of roots) {
        if (!(await lstat(join(root, path))).isDirectory()) fail();
        await visit(path);
      }
      for (const path of fixed) await visit(path, true);
      files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
      return { files, directories };
    };
    const before = await scan();
    const files: { path: string; sha256: string }[] = [];
    for (const entry of before.files) {
      const path = join(root, entry.path);
      if (await realpath(path) !== path) fail();
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || !isDeepStrictEqual(identity(stat), entry.identity) || await realpath(path) !== path) fail();
        const bytes = Buffer.alloc(stat.size + 1);
        let length = 0;
        while (length < bytes.length) {
          const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
          if (!bytesRead) break;
          length += bytesRead;
        }
        if (length !== stat.size || !isDeepStrictEqual(identity(await handle.stat()), entry.identity)) fail();
        files.push({ path: entry.path, sha256: createHash('sha256').update(bytes.subarray(0, length)).digest('hex') });
      } finally { await handle.close(); }
    }
    if (!isDeepStrictEqual(before, await scan())) fail();
    return { sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex'), files };
  } catch { return fail(); }
}
