import { afterEach, expect, test, vi } from 'vitest';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadLiveCredential, parseLiveCredential } from '../support/live-credential';
import { loadLocalCredential, parseLocalCredential } from '../../src/server/local-credential';

// Every filesystem open is mocked: these tests cannot read local credentials.
vi.mock('node:fs/promises', () => ({ open: vi.fn() }));
afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs(); });

function mockFile(source = 'CLOUDFLARE_API_TOKEN=synthetic-cloudflare-token',
  options: { mode?: number; size?: number; regular?: boolean } = {}) {
  const file = { stat: vi.fn(async () => ({ isFile: () => options.regular ?? true,
    mode: options.mode ?? 0o600, size: options.size ?? source.length })),
  readFile: vi.fn(async () => source), close: vi.fn(async () => undefined) };
  vi.mocked(open).mockResolvedValue(file as unknown as Awaited<ReturnType<typeof open>>);
  return file;
}

test('live loader denies before reading any file without explicit authorization', async () => {
  await expect(loadLiveCredential(false)).rejects.toThrow('LIVE_AUTHORIZATION_REQUIRED');
});
test('credential parsing accepts opaque keys, ignores model/enabled fields and does not evaluate shell', () => {
  expect(parseLiveCredential('GEMINI_API_KEY="synthetic-key"\nGEMINI_MODEL=ignored\nGEMINI_ENABLED=true')).toBe('synthetic-key');
  expect(parseLiveCredential('GEMINI_API_KEY=\'$(echo synthetic)\'')).toBe('$(echo synthetic)');
});
test('invalid credential errors contain no source data', () => {
  for (const source of ['', 'GEMINI_API_KEY=" "', 'GEMINI_API_KEY="synthetic\nsecret"',
    `GEMINI_API_KEY=${'x'.repeat(4097)}`]) expect(() => parseLiveCredential(source)).toThrow(/^LIVE_CREDENTIAL_INVALID$/);
});

test('Cloudflare reads only its dedicated nofollow file and selects only its token', async () => {
  vi.stubEnv('CLOUDFLARE_API_TOKEN', 'synthetic-inherited-token');
  const file = mockFile('GEMINI_API_KEY=synthetic-gemini\nOPENROUTER_API_KEY=synthetic-openrouter\nCLOUDFLARE_API_TOKEN=synthetic-cloudflare-token');
  expect(await loadLocalCredential('cloudflare')).toBe('synthetic-cloudflare-token');
  expect(open).toHaveBeenCalledExactlyOnceWith(resolve(process.cwd(), '.env.cloudflare.local'), constants.O_RDONLY | constants.O_NOFOLLOW);
  expect(file.readFile).toHaveBeenCalledExactlyOnceWith('utf8');
  expect(file.close).toHaveBeenCalledTimes(1);
});

test.each(['gemini', 'openrouter'] as const)('existing %s credentials retain their file and variable', async provider => {
  mockFile('GEMINI_API_KEY=synthetic-gemini\nOPENROUTER_API_KEY=synthetic-openrouter\nCLOUDFLARE_API_TOKEN=synthetic-cloudflare');
  expect(await loadLocalCredential(provider)).toBe(`synthetic-${provider}`);
  expect(open).toHaveBeenCalledExactlyOnceWith(resolve(process.cwd(), '.env.local'), constants.O_RDONLY | constants.O_NOFOLLOW);
});

test.each([{ mode: 0o644 }, { mode: 0o610 }, { size: 65537 }, { regular: false }])(
  'Cloudflare rejects unsafe file metadata without reading contents: %j', async options => {
    const file = mockFile(undefined, options);
    await expect(loadLocalCredential('cloudflare')).rejects.toThrow(/^LIVE_CREDENTIAL_UNAVAILABLE$/);
    expect(file.readFile).not.toHaveBeenCalled();
    expect(file.close).toHaveBeenCalledTimes(1);
  });

test('Cloudflare does not fall back to env or other files on failed open or missing token', async () => {
  vi.stubEnv('CLOUDFLARE_API_TOKEN', 'synthetic-inherited-token');
  vi.mocked(open).mockRejectedValueOnce(new Error('synthetic-open-failure'));
  await expect(loadLocalCredential('cloudflare')).rejects.toThrow(/^LIVE_CREDENTIAL_UNAVAILABLE$/);
  expect(open).toHaveBeenCalledTimes(1);
  const file = mockFile('GEMINI_API_KEY=synthetic-gemini\nOPENROUTER_API_KEY=synthetic-openrouter');
  await expect(loadLocalCredential('cloudflare')).rejects.toThrow(/^LIVE_CREDENTIAL_UNAVAILABLE$/);
  expect(open).toHaveBeenCalledTimes(2);
  expect(file.close).toHaveBeenCalledTimes(1);
  for (const [path] of vi.mocked(open).mock.calls) expect(path).toBe(resolve(process.cwd(), '.env.cloudflare.local'));
});

test('Cloudflare closes the file on read failure and sanitizes errors', async () => {
  const file = mockFile(); file.readFile.mockRejectedValueOnce(new Error('synthetic-private-error'));
  await expect(loadLocalCredential('cloudflare')).rejects.toThrow(/^LIVE_CREDENTIAL_UNAVAILABLE$/);
  expect(file.close).toHaveBeenCalledTimes(1);
});

test('Cloudflare token parsing enforces existing size, whitespace and control rules', () => {
  expect(parseLocalCredential('CLOUDFLARE_API_TOKEN=synthetic-token', 'CLOUDFLARE_API_TOKEN')).toBe('synthetic-token');
  for (const value of ['', ' ', ' synthetic ', 'synthetic\nvalue', 'synthetic\0value', 'x'.repeat(4097)]) {
    expect(() => parseLocalCredential(`CLOUDFLARE_API_TOKEN="${value}"`, 'CLOUDFLARE_API_TOKEN')).toThrow(/^LIVE_CREDENTIAL_UNAVAILABLE$/);
  }
});
