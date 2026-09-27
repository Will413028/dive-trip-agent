import { expect, test, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, realpath, symlink, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { readCloudflareSourceManifest } from '../../evals/cloudflare-source';
const race = vi.hoisted(() => ({ visit: undefined as ((path: string) => Promise<void>) | undefined }));
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, readdir: async (...args: Parameters<typeof actual.readdir>) => {
    await race.visit?.(String(args[0]));
    return actual.readdir(...args);
  } };
});

async function temporary(work: (root: string) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'source-manifest-')));
  for (const dir of ['src', 'evals', 'migrations', 'tests/support', 'tests/integration']) {
    await mkdir(join(root, dir), { recursive: true });
    await writeFile(join(root, dir, 'sample.ts'), 'synthetic source');
  }
  await mkdir(join(root, 'data'));
  for (const file of ['package.json', 'pnpm-lock.yaml', 'tsconfig.json', 'tsconfig.worker.json', 'vitest.config.ts', 'compose.test.yml', 'data/catalog.json']) {
    await writeFile(join(root, file), 'synthetic config');
  }
  const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root);
  try { await work(root); }
  finally { cwd.mockRestore(); await rm(root, { recursive: true, force: true }); }
}

test('manifest is sorted, deterministic and hashes path/content pairs including SQL', () => temporary(async root => {
  await writeFile(join(root, 'migrations', '001.sql'), 'SELECT 1');
  const manifest = await readCloudflareSourceManifest();
  expect(manifest.files.map(f => f.path)).toEqual(manifest.files.map(f => f.path).sort());
  expect(manifest.files).toContainEqual({ path: 'migrations/001.sql', sha256: createHash('sha256').update('SELECT 1').digest('hex') });
  expect(manifest.sha256).toBe(createHash('sha256').update(JSON.stringify(manifest.files)).digest('hex'));
  expect(await readCloudflareSourceManifest()).toEqual(manifest);
}));
test.each(['add', 'remove', 'edit', 'rename', 'config', 'worker-config', 'catalog'] as const)('%s source changes the manifest', mode => temporary(async root => {
  const before = await readCloudflareSourceManifest();
  const path = join(root, 'src', 'sample.ts');
  if (mode === 'add') await writeFile(join(root, 'src', 'new.ts'), 'new');
  if (mode === 'remove') await rm(path);
  if (mode === 'edit') await writeFile(path, 'changed');
  if (mode === 'rename') await rename(path, join(root, 'src', 'renamed.ts'));
  if (mode === 'config') await writeFile(join(root, 'pnpm-lock.yaml'), 'new lock');
  if (mode === 'worker-config') await writeFile(join(root, 'tsconfig.worker.json'), 'new worker config');
  if (mode === 'catalog') await writeFile(join(root, 'data/catalog.json'), '{"changed":"synthetic catalog"}');
  expect((await readCloudflareSourceManifest()).sha256).not.toBe(before.sha256);
}));
test('credentials, artifacts, builds, docs and installed packages are outside the source set', () => temporary(async root => {
  const before = await readCloudflareSourceManifest();
  for (const dir of ['.artifacts', '.next', 'secrets', 'docs', 'node_modules', 'src/node_modules', 'src/.private']) {
    await mkdir(join(root, dir), { recursive: true });
    await writeFile(join(root, dir, 'excluded.json'), 'synthetic excluded marker');
  }
  await writeFile(join(root, '.env.local'), 'synthetic excluded marker');
  await writeFile(join(root, 'src', '.env.local'), 'synthetic excluded marker');
  await writeFile(join(root, 'src', 'notes.md'), 'documentation');
  expect(await readCloudflareSourceManifest()).toEqual(before);
}));
test.each(['file', 'directory', 'required'] as const)('rejects %s symlinks without hashing targets', mode => temporary(async root => {
  await writeFile(join(root, 'outside'), 'synthetic sentinel');
  if (mode === 'file') await symlink(join(root, 'outside'), join(root, 'src', 'linked.ts'));
  if (mode === 'directory') await symlink(join(root, 'evals'), join(root, 'src', 'linked'));
  if (mode === 'required') {
    await rm(join(root, 'package.json'));
    await symlink(join(root, 'outside'), join(root, 'package.json'));
  }
  await expect(readCloudflareSourceManifest()).rejects.toThrow(/^EVAL_SOURCE_INVALID$/);
}));
test.each(['source', 'config', 'worker-config'] as const)('rejects missing %s roots or inputs', mode => temporary(async root => {
  if (mode === 'source') await rename(join(root, 'src'), join(root, 'src-old'));
  else if (mode === 'worker-config') await rm(join(root, 'tsconfig.worker.json'));
  else await rm(join(root, 'compose.test.yml'));
  await expect(readCloudflareSourceManifest()).rejects.toThrow(/^EVAL_SOURCE_INVALID$/);
}));
test('rejects oversized inputs before reading their contents', () => temporary(async root => {
  await writeFile(join(root, 'src', 'oversized.ts'), Buffer.alloc(2_000_001));
  await expect(readCloudflareSourceManifest()).rejects.toThrow(/^EVAL_SOURCE_INVALID$/);
}));
test('rejects source mutation between the two inventory scans', () => temporary(async root => {
  let scans = 0;
  race.visit = async path => {
    if (path === join(root, 'src') && ++scans === 2) {
      await writeFile(join(root, 'src', 'sample.ts'), 'changed during capture');
    }
  };
  try { await expect(readCloudflareSourceManifest()).rejects.toThrow(/^EVAL_SOURCE_INVALID$/); }
  finally { race.visit = undefined; }
}));
test('rejects an excessive source inventory', () => temporary(async root => {
  for (let offset = 0; offset < 2040; offset += 40) {
    await Promise.all(Array.from({ length: 40 }, (_, n) => writeFile(join(root, 'src', `many-${offset + n}.ts`), '')));
  }
  await expect(readCloudflareSourceManifest()).rejects.toThrow(/^EVAL_SOURCE_INVALID$/);
}));
test('rejects an aggregate over 32 MB even if every file is below 2 MB', () => temporary(async root => {
  for (let n = 0; n < 17; n++) await writeFile(join(root, 'src', `large-${n}.ts`), Buffer.alloc(1_999_999));
  await expect(readCloudflareSourceManifest()).rejects.toThrow(/^EVAL_SOURCE_INVALID$/);
}));
