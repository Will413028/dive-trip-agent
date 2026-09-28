import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { DELETE, GET, POST } from '../../src/app/api/[...segments]/route';
import { proxyBackend } from '../../src/server/backend';

vi.mock('../../src/server/backend', () => ({ proxyBackend: vi.fn(async () => Response.json({ ok: true })) }));

const origin = 'http://127.0.0.1:4418';
const handlers = [GET, POST, DELETE];
const request = () => new Request('http://127.0.0.1:4320/api/agent-mode', {
  headers: { 'x-dive-local-ingress': 'a'.repeat(64), 'x-dive-local-peer': '127.0.0.1' },
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('APP_ORIGIN', origin);
  vi.stubEnv('DIVE_BACKEND_ORIGIN', 'http://127.0.0.1:4320');
  vi.stubEnv('DIVE_LOCAL_LIVE', undefined);
  vi.stubEnv('DIVE_LOCAL_PROVIDER', 'cloudflare');
  vi.stubEnv('DIVE_LOCAL_INGRESS_TOKEN', 'a'.repeat(64));
  vi.stubEnv('DIVE_LOCAL_IP_KEY', 'b'.repeat(64));
  vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'a'.repeat(32));
});
afterEach(() => vi.unstubAllEnvs());

test.each([{ method: 'GET', run: GET }, { method: 'POST', run: POST }, { method: 'DELETE', run: DELETE }])(
  '$method selects Python backend despite retired provider configuration and ingress headers', async ({ run }) => {
    const input = request();
    expect((await run(input)).status).toBe(200);
    expect(proxyBackend).toHaveBeenCalledExactlyOnceWith(input, 'http://127.0.0.1:4320');
  });

test.each(['free-tier-confirmed', 'true', 'false', ''])(
  'explicit retired activation %j rejects before reaching product HTTP', async activation => {
    vi.stubEnv('DIVE_LOCAL_LIVE', activation);
    for (const run of handlers) {
      const response = await run(request());
      expect(response.status).toBe(503);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual({ error: 'SERVICE_UNAVAILABLE' });
    }
    expect(proxyBackend).not.toHaveBeenCalled();
  });

test('missing configured origin rejects before reaching product HTTP', async () => {
  vi.stubEnv('APP_ORIGIN', undefined);
  expect((await GET(request())).status).toBe(503);
  expect(proxyBackend).not.toHaveBeenCalled();
});

test('missing backend refuses instead of invoking the legacy product runtime', async () => {
  vi.stubEnv('DIVE_BACKEND_ORIGIN', undefined);
  expect((await GET(request())).status).toBe(503);
  expect(proxyBackend).not.toHaveBeenCalled();
});
