import type { PublicTrip } from '../contracts/generated';
import { HOSTED_BACKEND, hostedFailure, ingressBody, ingressEnvelope, requestTarget, signedHeaders, verifyIngress,
  type HostedConfig } from './hosted';

const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };

function origin(value: string): string {
  if (!/^http:\/\/127\.0\.0\.1:[0-9]{1,5}$/.test(value)) throw new Error('INVALID_BACKEND_ORIGIN');
  const parsed = new URL(value);
  if (!parsed.port || Number(parsed.port) < 1 || Number(parsed.port) > 65535) throw new Error('INVALID_BACKEND_ORIGIN');
  return value;
}

async function boundedBody(request: Request): Promise<Uint8Array | undefined> {
  if (!request.body) return undefined;
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > 32768) {
        await reader.cancel();
        throw new Error('BODY_TOO_LARGE');
      }
      parts.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { body.set(part, offset); offset += part.length; }
  return body;
}

async function forwardBackend(
  request: Request, base: string, forwarded: Headers, body: Uint8Array | undefined,
): Promise<Response> {
  const target = new URL(request.url);
  const upstream = await fetch(`${base}${target.pathname}${target.search}`, {
    method: request.method, headers: forwarded,
    body: request.method === 'GET' ? undefined : body as BodyInit,
    signal: AbortSignal.any([request.signal, AbortSignal.timeout(65000)]),
    cache: 'no-store', redirect: 'error',
  });
  const responseHeaders = new Headers(headers);
  for (const name of ['content-type', 'x-robots-tag', 'retry-after']) {
    const value = upstream.headers.get(name);
    if (value !== null) responseHeaders.set(name, value);
  }
  for (const cookie of upstream.headers.getSetCookie()) responseHeaders.append('set-cookie', cookie);
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}

function clientHeaders(request: Request): Headers {
  const forwarded = new Headers();
  for (const name of ['origin', 'content-type', 'cookie', 'accept']) {
    const value = request.headers.get(name);
    if (value !== null) forwarded.set(name, value);
  }
  return forwarded;
}

export async function hostedProxy(request: Request, config: HostedConfig): Promise<Response> {
  try {
    const target = requestTarget(request);
    if (!new URL(request.url).pathname.startsWith('/api/') || !['GET', 'POST', 'DELETE'].includes(request.method)) {
      return Response.json({ error: 'NOT_FOUND' }, { status: 404, headers });
    }
    ingressEnvelope(request.headers);
    const body = await ingressBody(request);
    const ingress = verifyIngress(config, request.method, target, request.headers, body);
    const forwarded = clientHeaders(request);
    for (const [name, value] of signedHeaders(config, request.method, target, ingress, body)) forwarded.set(name, value);
    return await forwardBackend(request, HOSTED_BACKEND, forwarded, body);
  } catch (error) { return hostedFailure(error); }
}

export async function proxyBackend(request: Request, backendOrigin: string): Promise<Response> {
  try {
    const base = origin(backendOrigin);
    const target = new URL(request.url);
    if (!target.pathname.startsWith('/api/') || !['GET', 'POST', 'DELETE'].includes(request.method)) {
      return Response.json({ error: 'NOT_FOUND' }, { status: 404, headers });
    }
    return await forwardBackend(request, base, clientHeaders(request),
      request.method === 'GET' ? undefined : await boundedBody(request));
  } catch (error) {
    const tooLarge = error instanceof Error && error.message === 'BODY_TOO_LARGE';
    return Response.json({ error: tooLarge ? 'BODY_TOO_LARGE' : 'SERVICE_UNAVAILABLE' }, {
      status: tooLarge ? 400 : 503, headers,
    });
  }
}

export async function hostedShare(config: HostedConfig, token: string, incoming: Headers): Promise<PublicTrip | null> {
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const original = incoming.get('x-dive-target') ?? '';
  if (original.split('?')[0] !== `/share/${token}`) throw new Error('SHARE_INGRESS_REQUIRED');
  const body = new Uint8Array();
  const ingress = verifyIngress(config, 'GET', original, incoming, body);
  const target = `/api/shares/${token}`;
  const response = await fetch(`${HOSTED_BACKEND}${target}`, {
    headers: signedHeaders(config, 'GET', target, ingress, body),
    cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(5000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error('SHARE_UNAVAILABLE');
  return response.json() as Promise<PublicTrip>;
}

export async function backendShare(backendOrigin: string, token: string): Promise<PublicTrip | null> {
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const response = await fetch(`${origin(backendOrigin)}/api/shares/${token}`, {
    cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(5000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error('SHARE_UNAVAILABLE');
  return response.json() as Promise<PublicTrip>;
}
