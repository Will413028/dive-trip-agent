import { afterEach, expect, test, vi } from 'vitest';
import { parseWorkbenchOptions } from '../support/workbench-options';
import { offlineNextEnvironment } from '../support/next-environment';

vi.mock('node:fs/promises', () => ({ readdir: vi.fn(async () => []) }));
afterEach(() => vi.unstubAllEnvs());

test('default launcher remains fixture and ignores provider environment', () => {
  expect(parseWorkbenchOptions([])).toEqual({ e2e: false, production: false });
});
test('alternate loopback port is fixed and cannot override e2e or select arbitrary ports', () => {
  expect(parseWorkbenchOptions(['--port=4418'])).toEqual({ e2e: false, production: false, port: 4418 });
  for (const port of ['0', '4320', '4319', '80', '4418x', '04418']) {
    expect(() => parseWorkbenchOptions([`--port=${port}`])).toThrow('INVALID_WORKBENCH_PORT');
  }
  expect(() => parseWorkbenchOptions(['--e2e', '--port=4418'])).toThrow('INVALID_WORKBENCH_PORT');
  expect(() => parseWorkbenchOptions(['--port=4418', '--port=4318'])).toThrow('INVALID_WORKBENCH_OPTIONS');
});

test('Gemini live still requires production and explicit free-tier confirmation', () => {
  expect(() => parseWorkbenchOptions(['--live-free'])).toThrow('LIVE_LOCAL_REQUIRES_PRODUCTION_AND_FREE_CONFIRMATION');
  expect(parseWorkbenchOptions(['--production', '--live-free', '--free-tier-confirmed']))
    .toEqual({ e2e: false, production: true, liveProvider: 'gemini' });
});

test('OpenRouter live requires a server-selected free model', () => {
  expect(() => parseWorkbenchOptions(['--production', '--live-openrouter-free', '--free-tier-confirmed']))
    .toThrow('OPENROUTER_MODEL_REQUIRED');
  expect(parseWorkbenchOptions(['--production', '--live-openrouter-free', '--openrouter-model=example/synthetic:free', '--free-tier-confirmed']))
    .toEqual({ e2e: false, production: true, liveProvider: 'openrouter', openRouterModel: 'example/synthetic:free' });
});

test('launcher rejects provider ambiguity, invalid free model and e2e live mode', () => {
  expect(() => parseWorkbenchOptions(['--production', '--live-free', '--live-openrouter-free', '--free-tier-confirmed']))
    .toThrow('LIVE_LOCAL_PROVIDER_CONFLICT');
  expect(() => parseWorkbenchOptions(['--production', '--live-openrouter-free', '--openrouter-model=example/paid', '--free-tier-confirmed']))
    .toThrow('OPENROUTER_MODEL_REQUIRED');
  expect(() => parseWorkbenchOptions(['--e2e', '--production', '--live-openrouter-free', '--openrouter-model=example/synthetic:free', '--free-tier-confirmed']))
    .toThrow('LIVE_LOCAL_REQUIRES_PRODUCTION_AND_FREE_CONFIRMATION');
  expect(() => parseWorkbenchOptions(['--production', '--live-free', '--openrouter-model=example/synthetic:free', '--free-tier-confirmed']))
    .toThrow('OPENROUTER_MODEL_NOT_ALLOWED');
});

const cloudflareArgs = ['--production', '--live-cloudflare-free', '--free-tier-confirmed', `--cloudflare-account-id=${'a'.repeat(32)}`];
test('Cloudflare requires explicit production, confirmation and a lowercase account ID', () => {
  expect(parseWorkbenchOptions(cloudflareArgs)).toEqual({ e2e: false, production: true, liveProvider: 'cloudflare', cloudflareAccountId: 'a'.repeat(32) });
  for (const flag of ['--production', '--free-tier-confirmed']) {
    expect(() => parseWorkbenchOptions(cloudflareArgs.filter(value => value !== flag)))
      .toThrow('LIVE_LOCAL_REQUIRES_PRODUCTION_AND_FREE_CONFIRMATION');
  }
  expect(() => parseWorkbenchOptions([...cloudflareArgs, '--e2e'])).toThrow('LIVE_LOCAL_REQUIRES_PRODUCTION_AND_FREE_CONFIRMATION');
  expect(() => parseWorkbenchOptions(cloudflareArgs.slice(0, -1))).toThrow('CLOUDFLARE_ACCOUNT_ID_REQUIRED');
  for (const id of ['a'.repeat(31), 'a'.repeat(33), 'A'.repeat(32), 'g'.repeat(32), ` ${'a'.repeat(32)}`, `${'a'.repeat(32)}\n`]) {
    expect(() => parseWorkbenchOptions([...cloudflareArgs.slice(0, -1), `--cloudflare-account-id=${id}`])).toThrow('CLOUDFLARE_ACCOUNT_ID_REQUIRED');
  }
});
test('Cloudflare rejects conflicting provider, model and account ID switches', () => {
  for (const flag of ['--live-free', '--live-openrouter-free']) {
    expect(() => parseWorkbenchOptions([...cloudflareArgs, flag])).toThrow('LIVE_LOCAL_PROVIDER_CONFLICT');
  }
  expect(() => parseWorkbenchOptions([...cloudflareArgs, '--openrouter-model=example/synthetic:free'])).toThrow('OPENROUTER_MODEL_NOT_ALLOWED');
  for (const flag of ['--model=other', '--cloudflare-model=@cf/google/gemma-4-26b-a4b-it', '--provider=cloudflare',
    '--account-id=other', `--cloudflare-account-id=${'b'.repeat(32)}`, cloudflareArgs[3], '--live-cloudflare-free']) {
    expect(() => parseWorkbenchOptions([...cloudflareArgs, flag])).toThrow('INVALID_WORKBENCH_OPTIONS');
  }
  for (const flag of ['--cloudflare-account-id', '--cloudflare-account-id=']) {
    expect(() => parseWorkbenchOptions([...cloudflareArgs.slice(0, -1), flag])).toThrow('INVALID_WORKBENCH_OPTIONS');
  }
  for (const args of [[], ['--production', '--live-free', '--free-tier-confirmed'],
    ['--production', '--live-openrouter-free', '--free-tier-confirmed', '--openrouter-model=example/synthetic:free']]) {
    expect(() => parseWorkbenchOptions([...args, cloudflareArgs[3]])).toThrow('CLOUDFLARE_ACCOUNT_ID_NOT_ALLOWED');
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
  expect(() => parseWorkbenchOptions(cloudflareArgs.slice(0, -1))).toThrow('CLOUDFLARE_ACCOUNT_ID_REQUIRED');
});
