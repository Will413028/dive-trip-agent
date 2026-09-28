import { afterEach, describe, expect, it, vi } from 'vitest';
import { backendShare, proxyBackend } from '../../src/server/backend';

afterEach(() => vi.unstubAllGlobals());

describe('Python backend proxy', () => {
  it('preserves client Origin and cookie without accepting provider or peer authority', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ ok: true }, {
      headers: { 'Set-Cookie': 'dive_trip_session=synthetic; HttpOnly', 'X-Private-Accounting': 'hidden' },
    }));
    vi.stubGlobal('fetch', fetcher);
    const request = new Request('http://internal/api/session', {
      method: 'POST', headers: { Origin: 'https://attacker.invalid', 'Content-Type': 'application/json',
        Cookie: 'dive_trip_session=old', Authorization: 'synthetic', 'X-Forwarded-For': '1.2.3.4' }, body: '{}',
    });
    const response = await proxyBackend(request, 'http://127.0.0.1:4320');
    const [url, options] = fetcher.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:4320/api/session');
    expect(options.headers.get('origin')).toBe('https://attacker.invalid');
    expect(options.headers.get('cookie')).toBe('dive_trip_session=old');
    expect(options.headers.has('authorization')).toBe(false);
    expect(options.headers.has('x-forwarded-for')).toBe(false);
    expect(response.headers.getSetCookie()).toEqual(['dive_trip_session=synthetic; HttpOnly']);
    expect(response.headers.has('x-private-accounting')).toBe(false);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('bounds request bytes and refuses an untrusted backend URL before forwarding', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const oversized = new Request('http://internal/api/trips', { method: 'POST', body: 'x'.repeat(32769) });
    expect((await proxyBackend(oversized, 'http://127.0.0.1:4320')).status).toBe(400);
    expect((await proxyBackend(new Request('http://internal/api/catalog'), 'https://other.invalid')).status).toBe(503);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('propagates request abort and response cancellation to the upstream stream', async () => {
    const cancelled = vi.fn();
    const upstream = new ReadableStream({ cancel: cancelled });
    let observedSignal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
      observedSignal = options.signal;
      return new Response(upstream, { headers: { 'Content-Type': 'text/event-stream' } });
    }));
    const abort = new AbortController();
    const response = await proxyBackend(new Request('http://internal/api/trips/id/agent', {
      method: 'POST', body: '{}', signal: abort.signal,
    }), 'http://127.0.0.1:4320');
    abort.abort();
    expect(observedSignal?.aborted).toBe(true);
    await response.body!.cancel();
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it('reads public shares without cookies and preserves not-found', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    vi.stubGlobal('fetch', fetcher);
    expect(await backendShare('http://127.0.0.1:4320', 'a'.repeat(64))).toBeNull();
    expect(fetcher.mock.calls[0][1]).not.toHaveProperty('headers');
    expect(await backendShare('http://127.0.0.1:4320', '../bad')).toBeNull();
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
