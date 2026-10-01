import { mkdtempSync, writeFileSync, chmodSync, symlinkSync, linkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hostedProxy, hostedShare } from '../../src/server/backend';
import * as hosted from '../../src/server/hosted';
import { proxy } from '../../src/proxy';

vi.mock('node:crypto', async (original) => {
  const actual = await original<typeof import('node:crypto')>();
  return { ...actual, timingSafeEqual: process.env.DIVE_TEST_INGRESS_MUTATION === '1'
    ? () => true : actual.timingSafeEqual };
});

const key = 'cd'.repeat(32);
const config = { origin: 'https://demo.example.test', key };
const now = 1790812800000;
const ingress = { stamp: '1790812800', nonce: 'ab'.repeat(16), client: '2001:db8::1' };
const body = new TextEncoder().encode('{"message":"你好"}');
const target = '/api/trips?tag=%E6%B5%B7&x=a%2Bb';
const envelope = (method = 'POST', path = target, bytes = body) => new Headers({
  'x-dive-time': ingress.stamp, 'x-dive-nonce': ingress.nonce, 'x-dive-client': ingress.client,
  'x-dive-signature': hosted.ingressSignature(key, method, path, ingress, bytes),
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });

describe('hosted configuration', () => {
  const environment = { DIVE_HOSTED_FIXTURE: '1', APP_ORIGIN: config.origin, DIVE_BACKEND_ORIGIN: hosted.HOSTED_BACKEND };
  it('keeps local configuration separate and loads only the fixed secret after validation', () => {
    const read = vi.fn(() => key);
    expect(hosted.hostedConfig({}, read)).toBeNull();
    expect(read).not.toHaveBeenCalled();
    expect(hosted.hostedConfig(environment, read)).toEqual(config);
    expect(read).toHaveBeenCalledExactlyOnceWith('/run/secrets/dive_trip_ingress');
  });
  it.each(['GEMINI_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'OPENROUTER_API_KEY',
    'OPENAI_API_KEY', 'CLOUDFLARE_API_TOKEN', 'DIVE_LOCAL_LIVE', 'DIVE_TRIP_CLOUDFLARE_TOKEN',
    'PGHOST', 'DATABASE_URL', 'COMPOSE_PROJECT_NAME'])('rejects %s before secret access', (name) => {
    const read = vi.fn();
    expect(() => hosted.hostedConfig({ ...environment, [name]: 'synthetic' }, read)).toThrow('HOSTED_GENERATION');
    expect(read).not.toHaveBeenCalled();
  });
  it.each(['http://demo.example.test', 'https://127.0.0.1', 'https://demo.example.test:443',
    'https://demo.example.test/', 'https://user@demo.example.test', 'https://DEMO.example.test'])('rejects origin %s', (origin) => {
    const read = vi.fn();
    expect(() => hosted.hostedConfig({ ...environment, APP_ORIGIN: origin }, read)).toThrow();
    expect(read).not.toHaveBeenCalled();
  });
  it.each(['https://attacker.test', 'http://127.0.0.1:4320', 'http://api:4320/'])('rejects upstream %s', (upstream) => {
    const read = vi.fn();
    expect(() => hosted.hostedConfig({ ...environment, DIVE_BACKEND_ORIGIN: upstream }, read)).toThrow('HOSTED_FIXED_BACKEND');
    expect(read).not.toHaveBeenCalled();
  });
  it('rejects invalid mode rather than falling back to local', () => {
    expect(() => hosted.hostedConfig({ DIVE_HOSTED_FIXTURE: '0' }, vi.fn())).toThrow('HOSTED_MODE_INVALID');
  });
  it('rejects unsafe, linked and oversized synthetic secret files', () => {
    const root = mkdtempSync(join(tmpdir(), 'dive-hosted-key-'));
    const path = join(root, 'key');
    try {
      writeFileSync(path, key, { mode: 0o600 });
      expect(hosted.readIngressKey(path)).toBe(key);
      chmodSync(path, 0o644);
      expect(() => hosted.readIngressKey(path)).toThrow('HOSTED_SECRET_FILE_INVALID');
      chmodSync(path, 0o4600);
      expect(() => hosted.readIngressKey(path)).toThrow('HOSTED_SECRET_FILE_INVALID');
      chmodSync(path, 0o600);
      symlinkSync(path, join(root, 'symlink'));
      expect(() => hosted.readIngressKey(join(root, 'symlink'))).toThrow();
      linkSync(path, join(root, 'hardlink'));
      expect(() => hosted.readIngressKey(path)).toThrow('HOSTED_SECRET_FILE_INVALID');
      rmSync(join(root, 'hardlink'));
      writeFileSync(path, key + '\n');
      expect(() => hosted.readIngressKey(path)).toThrow('HOSTED_SECRET_FILE_INVALID');
      writeFileSync(path, Buffer.alloc(64, 0xe1));
      expect(() => hosted.readIngressKey(path)).toThrow('HOSTED_SECRET_FILE_INVALID');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('signed ingress and forwarding', () => {
  it('matches the independently generated Python UTF-8/query/IPv6 signature vector', () => {
    expect(hosted.ingressSignature(key, 'POST', target, ingress, body))
      .toBe('4fedfb3f8f159b60842eab9ae56fa8bb17200ba2ac74fdad4f312efc52510c16');
    expect(hosted.verifyIngress(config, 'POST', target, envelope(), body, now)).toEqual(ingress);
  });
  it.each(['method', 'path', 'query', 'body', 'client', 'nonce', 'stamp', 'mac'])('rejects tampered %s', (field) => {
    const headers = envelope();
    let path = target; let bytes = body; let method = 'POST';
    if (field === 'method') method = 'DELETE';
    if (field === 'path') path = '/api/other';
    if (field === 'query') path += '&changed=1';
    if (field === 'body') bytes = new TextEncoder().encode('{}');
    if (field === 'client') headers.set('x-dive-client', '192.0.2.1');
    if (field === 'nonce') headers.set('x-dive-nonce', 'ff'.repeat(16));
    if (field === 'stamp') headers.set('x-dive-time', String(Number(ingress.stamp) + 1));
    if (field === 'mac') headers.set('x-dive-signature', 'ff'.repeat(32));
    expect(() => hosted.verifyIngress(config, method, path, headers, bytes, now)).toThrow('INGRESS_INVALID');
  });
  it.each(['2001:0db8::1', '192.168.001.1', '192.0.2.1, 192.0.2.2', 'not-an-ip'])('rejects noncanonical client %s', (client) => {
    const headers = envelope(); headers.set('x-dive-client', client);
    expect(() => hosted.verifyIngress(config, 'POST', target, headers, body, now)).toThrow('INGRESS_INVALID');
  });
  it('rejects expired/future and duplicate header values', () => {
    expect(() => hosted.verifyIngress(config, 'POST', target, envelope(), body, now + 31000)).toThrow();
    expect(() => hosted.verifyIngress(config, 'POST', target, envelope(), body, now - 31000)).toThrow();
    const headers = envelope(); headers.append('x-dive-nonce', ingress.nonce);
    expect(() => hosted.verifyIngress(config, 'POST', target, headers, body, now)).toThrow();
  });
  it('uses fixed API, original nonce/deadline, preserved CSRF Origin and cookie; strips peer authority', async () => {
    vi.setSystemTime(now);
    const fetcher = vi.fn().mockResolvedValue(new Response('event', { headers: {
      'Content-Type': 'text/event-stream', 'Set-Cookie': 'synthetic=1; Secure; HttpOnly', 'X-Private-Accounting': 'hidden',
    } })); vi.stubGlobal('fetch', fetcher);
    const headers = envelope(); headers.set('origin', 'https://attacker.test');
    headers.set('cookie', 'synthetic=old'); headers.set('authorization', 'synthetic');
    headers.set('x-forwarded-for', '192.0.2.2'); headers.set('x-dive-target', '//attacker.test');
    const response = await hostedProxy(new Request(`http://internal${target}`, { method: 'POST', headers, body }), config);
    expect(response.status).toBe(200);
    const [url, options] = fetcher.mock.calls[0];
    expect(url).toBe(hosted.HOSTED_BACKEND + target);
    expect(options.headers.get('origin')).toBe('https://attacker.test');
    expect(options.headers.get('cookie')).toBe('synthetic=old');
    for (const name of ['authorization', 'x-forwarded-for', 'x-dive-target']) expect(options.headers.has(name)).toBe(false);
    expect(hosted.verifyIngress(config, 'POST', target, options.headers, options.body, now)).toEqual(ingress);
    expect(options.redirect).toBe('error'); expect(options.cache).toBe('no-store');
    expect(response.headers.getSetCookie()).toEqual(['synthetic=1; Secure; HttpOnly']);
    expect(response.headers.has('x-private-accounting')).toBe(false);
  });
  it('re-signs SSR share for the actual API path without changing nonce, timestamp or including cookies', async () => {
    vi.setSystemTime(now);
    const token = 'aa'.repeat(32); const original = `/share/${token}?_rsc=synthetic`;
    const headers = envelope('GET', original, new Uint8Array());
    headers.set('x-dive-target', original); headers.set('cookie', 'synthetic=secret');
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 404 })); vi.stubGlobal('fetch', fetcher);
    expect(await hostedShare(config, token, headers)).toBeNull();
    const [url, options] = fetcher.mock.calls[0]; const api = `/api/shares/${token}`;
    expect(url).toBe(hosted.HOSTED_BACKEND + api);
    expect(options.headers.has('cookie')).toBe(false);
    expect(hosted.verifyIngress(config, 'GET', api, options.headers, new Uint8Array(), now)).toEqual(ingress);
    expect(options.headers.get('x-dive-signature')).not.toBe(headers.get('x-dive-signature'));
    headers.set('x-dive-target', `/share/${'bb'.repeat(32)}`);
    await expect(hostedShare(config, token, headers)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('rejects slow bodies within ten seconds even when cancellation never settles', async () => {
    vi.useFakeTimers();
    const request = new Request('http://internal/api/session', { method: 'POST',
      body: new ReadableStream({ cancel: () => new Promise(() => undefined) }), duplex: 'half',
    } as RequestInit);
    const result = hosted.ingressBody(request);
    const assertion = expect(result).rejects.toMatchObject({ status: 408, message: 'BODY_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(10001); await assertion;
  });
  it('rejects oversized bodies and rechecks freshness after waiting for a body', async () => {
    vi.setSystemTime(now);
    const oversized = new Request(`http://internal${target}`, { method: 'POST', headers: envelope(), body: 'x'.repeat(32769) });
    expect((await hostedProxy(oversized, config)).status).toBe(413);
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const stream = new ReadableStream({ pull(controller) {
      vi.setSystemTime(now + 31000); controller.enqueue(body); controller.close();
    } });
    const delayed = new Request(`http://internal${target}`, { method: 'POST', headers: envelope(), body: stream, duplex: 'half' } as RequestInit);
    const result = hostedProxy(delayed, config);
    expect(Date.now()).toBe(now);
    expect((await result).status).toBe(403);
    expect(Date.now()).toBe(now + 31000);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('guards Next root and share rendering and replaces caller-supplied SSR target', async () => {
    vi.setSystemTime(now); vi.spyOn(hosted, 'hostedConfig').mockReturnValue(config);
    const headers = envelope('GET', '/', new Uint8Array()); headers.set('x-dive-target', '//attacker.test');
    headers.set('x-forwarded-for', '192.0.2.2');
    const response = await proxy(new NextRequest('http://internal/', { headers }));
    expect(response.headers.get('x-middleware-next')).toBe('1');
    expect(response.headers.get('x-middleware-request-x-dive-target')).toBe('/');
    expect(response.headers.has('x-middleware-request-x-forwarded-for')).toBe(false);
    expect((await proxy(new NextRequest('http://internal/'))).status).toBe(403);
    expect((await proxy(new NextRequest('http://internal/share/invalid', { headers }))).status).toBe(403);
  });
  it('retains response cancellation and propagates browser abort', async () => {
    vi.setSystemTime(now);
    const cancel = vi.fn(); let upstreamSignal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
      upstreamSignal = options.signal;
      return new Response(new ReadableStream({ cancel }));
    }));
    const abort = new AbortController();
    const response = await hostedProxy(new Request(`http://internal${target}`, {
      method: 'POST', headers: envelope(), body, signal: abort.signal,
    }), config);
    abort.abort(); expect(upstreamSignal?.aborted).toBe(true);
    await response.body!.cancel(); expect(cancel).toHaveBeenCalledOnce();
  });
});
