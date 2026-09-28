import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { makePool } from '../../src/server/db';
import { migrate } from '../../src/server/migrate';
import { testDatabaseUrl } from '../support/database';
import { offlineNextEnvironment } from '../support/next-environment';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
vi.mock('../../src/server/db.ts', () => ({ makePool: vi.fn() }));
vi.mock('../../src/server/migrate.ts', () => ({ migrate: vi.fn() }));
vi.mock('../support/database.ts', () => ({ testDatabaseUrl: vi.fn() }));
vi.mock('../support/next-environment.ts', () => ({ offlineNextEnvironment: vi.fn() }));

const originalArgv = process.argv;
beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); });
afterEach(() => { process.argv = originalArgv; });

test.each([
  [],
  ['--production'],
  ['--e2e'],
  ['--production', '--live-free', '--free-tier-confirmed'],
  ['--production', '--live-openrouter-free', '--free-tier-confirmed', '--openrouter-model=example/synthetic:free'],
  ['--production', '--live-cloudflare-free', '--free-tier-confirmed', `--cloudflare-account-id=${'a'.repeat(32)}`],
])('retired live launcher rejects before any startup side effect: %j', async (...args) => {
  process.argv = [process.execPath, 'workbench-dev.ts', ...args];
  await expect(import('../support/workbench-dev')).rejects.toThrow('WORKBENCH_RUNTIME_RETIRED');
  for (const port of [spawn, makePool, migrate, testDatabaseUrl, offlineNextEnvironment]) {
    expect(port).not.toHaveBeenCalled();
  }
});
