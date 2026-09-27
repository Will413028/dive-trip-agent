import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { writeAtomicCheckpoint, writeImmutableCheckpoint } from '../../evals/checkpoint';

test('immutable preflight and review evidence cannot be overwritten or claimed twice', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dive-eval-immutable-'));
  const path = join(directory, 'preflight.json');
  try {
    const results = await Promise.allSettled([
      writeImmutableCheckpoint(path, '{"source":"first"}'),
      writeImmutableCheckpoint(path, '{"source":"second"}'),
    ]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const original = await readFile(path, 'utf8');
    expect(['first', 'second']).toContain(JSON.parse(original).source);
    await expect(writeImmutableCheckpoint(path, '{}')).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(path, 'utf8')).toBe(original);
    expect((await stat(path)).mode & 0o077).toBe(0);
    expect(await readdir(directory)).toEqual(['preflight.json']);
  } finally { await rm(directory, { recursive: true }); }
});

test('atomic checkpoint retains last evidence after partial-write or rename failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dive-eval-checkpoint-'));
  const path = join(directory, 'report.json');
  try {
    await writeAtomicCheckpoint(path, '{"privateUsageComplete":false}');
    await expect(writeAtomicCheckpoint(path, '{"privateUsageComplete":true}', {
      write: async handle => { await handle.writeFile('partial'); throw new Error('SIMULATED_DISK_FULL'); },
    })).rejects.toThrow('SIMULATED_DISK_FULL');
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ privateUsageComplete: false });
    await expect(writeAtomicCheckpoint(path, '{}', { replace: async () => { throw new Error('SIMULATED_RENAME_FAILURE'); } }))
      .rejects.toThrow('SIMULATED_RENAME_FAILURE');
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ privateUsageComplete: false });
    expect(await readdir(directory)).toEqual(['report.json']);
    await writeAtomicCheckpoint(path, '{"stopped":"EVIDENCE_EXPORT_STOP"}');
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ stopped: 'EVIDENCE_EXPORT_STOP' });
    expect((await stat(path)).mode & 0o077).toBe(0);
  } finally { await rm(directory, { recursive: true }); }
});
