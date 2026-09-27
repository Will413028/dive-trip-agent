import { afterEach, expect, test, vi } from 'vitest';
import { parseWorkbenchOptions } from '../support/workbench-options';
import { offlineNextEnvironment } from '../support/next-environment';

vi.mock('node:fs/promises', () => ({ readdir: vi.fn(async () => []) }));
afterEach(() => vi.unstubAllEnvs());

test('default launcher remains fixture and ignores provider environment', () => {
  expect(parseWorkbenchOptions([])).toEqual({ e2e: false, production: false });
  expect(parseWorkbenchOptions(['--production'])).toEqual({ e2e: false, production: true });
  expect(parseWorkbenchOptions(['--e2e', '--production'])).toEqual({ e2e: true, production: true });
});
test('alternate loopback port is fixed and cannot override e2e or select arbitrary ports', () => {
  expect(parseWorkbenchOptions(['--port=4418'])).toEqual({ e2e: false, production: false, port: 4418 });
  for (const port of ['0', '4320', '4319', '80', '4418x', '04418']) {
    expect(() => parseWorkbenchOptions([`--port=${port}`])).toThrow('INVALID_WORKBENCH_PORT');
  }
  expect(() => parseWorkbenchOptions(['--e2e', '--port=4418'])).toThrow('INVALID_WORKBENCH_PORT');
  expect(() => parseWorkbenchOptions(['--port=4418', '--port=4318'])).toThrow('INVALID_WORKBENCH_OPTIONS');
});

test.each(['--live-free', '--live-openrouter-free', '--live-cloudflare-free',
  '--free-tier-confirmed', '--openrouter-model', '--cloudflare-account-id'])(
  'retired option %s always rejects live workbench use', flag => {
    for (const args of [[flag], [`${flag}=`], [`${flag}=synthetic`],
      ['--production', flag], ['--e2e', flag], [flag, flag], ['--port=0', flag]]) {
      expect(() => parseWorkbenchOptions(args)).toThrow('WORKBENCH_LIVE_READ_ONLY');
    }
  });

test('offline launcher rejects unknown, duplicate and incomplete options', () => {
  for (const args of [['--model=other'], ['--provider=cloudflare'], ['--account-id=other'],
    ['--port'], ['--port='], ['--e2e', '--e2e'], ['--production', '--production'], ['--production=true']]) {
    expect(() => parseWorkbenchOptions(args)).toThrow('INVALID_WORKBENCH_OPTIONS');
  }
});
test('launcher environment excludes inherited Cloudflare credentials and configuration', async () => {
  vi.stubEnv('CLOUDFLARE_API_TOKEN', 'synthetic-inherited-token');
  vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'b'.repeat(32));
  vi.stubEnv('DIVE_LOCAL_PROVIDER', 'cloudflare');
  const env = await offlineNextEnvironment();
  expect(env).not.toHaveProperty('CLOUDFLARE_API_TOKEN');
  expect(env).not.toHaveProperty('CLOUDFLARE_ACCOUNT_ID');
  expect(env).not.toHaveProperty('DIVE_LOCAL_PROVIDER');
  expect(parseWorkbenchOptions([])).toEqual({ e2e: false, production: false });
});
