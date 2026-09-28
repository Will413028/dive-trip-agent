import { beforeEach, expect, test, vi } from 'vitest';
import { retentionArgs, runRetention } from '../../scripts/expire-data';
import { makePool, withDatabasePool } from '../../src/server/db';
import { expireData, retentionPreview } from '../../src/server/retention';
import { testDatabaseUrl } from '../support/database';

vi.mock('../../src/server/db.ts', () => ({
  makePool: vi.fn(() => { throw new Error('UNEXPECTED_DATABASE_POOL'); }),
  withDatabasePool: vi.fn(() => { throw new Error('UNEXPECTED_DATABASE_SCOPE'); }),
}));
vi.mock('../../src/server/retention.ts', () => ({
  expireData: vi.fn(() => { throw new Error('UNEXPECTED_RETENTION_APPLY'); }),
  retentionPreview: vi.fn(() => { throw new Error('UNEXPECTED_RETENTION_PREVIEW'); }),
}));
vi.mock('../support/database.ts', () => ({
  testDatabaseUrl: vi.fn(() => { throw new Error('UNEXPECTED_DATABASE_DISCOVERY'); }),
}));
beforeEach(() => vi.clearAllMocks());

test.each([['--apply'], ['--apply', '--watch']])('legacy demo writes are retired: %j', async (...flags) => {
  await expect(runRetention(['--schema=workbench_demo', ...flags])).rejects.toThrow('LEGACY_RETENTION_RETIRED');
  for (const port of [testDatabaseUrl, makePool, withDatabasePool, expireData, retentionPreview]) {
    expect(port).not.toHaveBeenCalled();
  }
});

test('retention defaults to dry-run, requires one exact local schema, watch requires apply', () => {
  expect(retentionArgs(['--schema=workbench_demo'])).toEqual({ schema: 'workbench_demo', apply: false, watch: false });
  expect(retentionArgs(['--schema=workbench_live'])).toEqual({ schema: 'workbench_live', apply: false, watch: false });
  expect(retentionArgs(['--schema=workbench_demo', '--apply'])).toEqual({ schema: 'workbench_demo', apply: true, watch: false });
  expect(retentionArgs(['--schema=workbench_demo', '--apply', '--watch'])).toEqual({ schema: 'workbench_demo', apply: true, watch: true });
  for (const args of [[], ['--schema=public'], ['--schema=workbench_demo', '--watch'],
    ['--schema=test_1234567890abcdef1234567890abcdef', '--apply'], ['--schema=workbench_live', '--watch'],
    ['--schema=workbench_demo', '--schema=workbench_live'], ['--schema=workbench_demo', '--apply', '--apply'],
    ['--schema=workbench_demo', '--url=postgres://other'], ['--schema=workbench_demo', '--now=2099-01-01']]) {
    expect(() => retentionArgs(args)).toThrow('INVALID_RETENTION_ARGUMENTS');
  }
});

const liveApplyCases = [
  { mode: 'one-shot', args: ['--schema=workbench_live', '--apply'] },
  { mode: 'watch', args: ['--schema=workbench_live', '--apply', '--watch'] },
  { mode: 'reordered watch', args: ['--watch', '--apply', '--schema=workbench_live'] },
];

test.each(liveApplyCases)('retention rejects live $mode before execution', ({ args }) => {
  expect(() => retentionArgs(args)).toThrow('WORKBENCH_LIVE_READ_ONLY');
});

test.each(liveApplyCases)('live $mode never discovers or touches a database', async ({ args }) => {
  await expect(runRetention(args)).rejects.toThrow('WORKBENCH_LIVE_READ_ONLY');
  for (const port of [testDatabaseUrl, makePool, withDatabasePool, expireData, retentionPreview]) {
    expect(port).not.toHaveBeenCalled();
  }
});
