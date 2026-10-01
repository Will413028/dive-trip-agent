import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { isIP } from 'node:net';

export const HOSTED_BACKEND = 'http://api:4320';
export const INGRESS_KEY_FILE = '/run/secrets/dive_trip_ingress';
export type HostedConfig = Readonly<{ origin: string; key: string }>;
export type Ingress = Readonly<{ stamp: string; nonce: string; client: string }>;

export class IngressError extends Error {
  constructor(readonly status: number, code: string) { super(code); }
}

export function readIngressKey(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.uid !== process.getuid?.() || info.nlink !== 1
      || ![0o400, 0o600].includes(info.mode & 0o777) || info.size !== 64) {
      throw new Error('HOSTED_SECRET_FILE_INVALID');
    }
    const bytes = Buffer.alloc(65);
    const count = readSync(fd, bytes, 0, 65, null);
    const value = bytes.subarray(0, count).toString('latin1');
    if (count !== 64 || !/^[a-f0-9]{64}$/.test(value)) throw new Error('HOSTED_SECRET_FILE_INVALID');
    return value;
  } finally { closeSync(fd); }
}

export function hostedConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  readKey: (path: string) => string = readIngressKey,
): HostedConfig | null {
  if (environment.DIVE_HOSTED_FIXTURE === undefined) return null;
  if (environment.DIVE_HOSTED_FIXTURE !== '1') throw new Error('HOSTED_MODE_INVALID');
  for (const name of Object.keys(environment)) {
    if (/^(GEMINI_|GOOGLE_|OPENROUTER_|OPENAI_|CLOUDFLARE_|DIVE_LOCAL_|DIVE_TRIP_CLOUDFLARE_|PG)/.test(name)
      || ['DATABASE_URL', 'COMPOSE_PROJECT_NAME'].includes(name)) {
      throw new Error('HOSTED_GENERATION_OR_AMBIENT_CONFIG_DISABLED');
    }
  }
  const origin = environment.APP_ORIGIN;
  if (!origin || !/^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(origin)
    || /^[0-9.]+$/.test(new URL(origin).hostname)) throw new Error('HOSTED_HTTPS_ORIGIN_REQUIRED');
  if (environment.DIVE_BACKEND_ORIGIN !== HOSTED_BACKEND) throw new Error('HOSTED_FIXED_BACKEND_REQUIRED');
  const key = readKey(INGRESS_KEY_FILE);
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('HOSTED_SECRET_FILE_INVALID');
  return Object.freeze({ origin, key });
}

export function requestTarget(request: Request): string {
  const url = new URL(request.url);
  return url.pathname + url.search;
}

export function ingressSignature(
  key: string, method: string, target: string, ingress: Ingress, body: Uint8Array,
): string {
  const message = ['dive-ingress-v1', method, target, ingress.stamp, ingress.nonce,
    ingress.client, createHash('sha256').update(body).digest('hex')].join('\n');
  return createHmac('sha256', Buffer.from(key, 'hex')).update(message).digest('hex');
}

export function requireFresh(ingress: Ingress, now = Date.now()): void {
  if (Math.abs(now / 1000 - Number(ingress.stamp)) > 30) throw new IngressError(403, 'INGRESS_INVALID');
}

export function ingressEnvelope(headers: Headers, now = Date.now()): Ingress {
  const stamp = headers.get('x-dive-time') ?? '';
  const nonce = headers.get('x-dive-nonce') ?? '';
  const client = headers.get('x-dive-client') ?? '';
  const signed = headers.get('x-dive-signature') ?? '';
  let canonical = '';
  if (isIP(client) === 4) canonical = client;
  else if (isIP(client) === 6) {
    try { canonical = new URL(`http://[${client}]/`).hostname.slice(1, -1); } catch { /* rejected below */ }
  }
  if (!/^[0-9]{10}$/.test(stamp) || !/^[a-f0-9]{32}$/.test(nonce)
    || !/^[a-f0-9]{64}$/.test(signed) || !canonical || canonical !== client) {
    throw new IngressError(403, 'INGRESS_INVALID');
  }
  const ingress = { stamp, nonce, client };
  requireFresh(ingress, now);
  return ingress;
}

export function verifyIngress(
  config: HostedConfig, method: string, target: string, headers: Headers,
  body: Uint8Array, now = Date.now(),
): Ingress {
  const ingress = ingressEnvelope(headers, now);
  const signed = headers.get('x-dive-signature')!;
  if (!target.startsWith('/') || target.startsWith('//') || target.length > 8192
    || /[\r\n]/.test(target)) throw new IngressError(403, 'INGRESS_INVALID');
  const expected = ingressSignature(config.key, method, target, ingress, body);
  if (!timingSafeEqual(Buffer.from(signed, 'hex'), Buffer.from(expected, 'hex'))) {
    throw new IngressError(403, 'INGRESS_INVALID');
  }
  return ingress;
}

export function signedHeaders(
  config: HostedConfig, method: string, target: string, ingress: Ingress, body: Uint8Array,
): Headers {
  requireFresh(ingress);
  return new Headers({ 'x-dive-time': ingress.stamp, 'x-dive-nonce': ingress.nonce,
    'x-dive-client': ingress.client,
    'x-dive-signature': ingressSignature(config.key, method, target, ingress, body) });
}

export async function ingressBody(request: Request): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new IngressError(408, 'BODY_TIMEOUT')), 10000);
  });
  try {
    while (true) {
      const part = await Promise.race([reader.read(), deadline]);
      if (part.done) break;
      size += part.value.length;
      if (size > 32768) throw new IngressError(413, 'BODY_TOO_LARGE');
      parts.push(part.value);
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) { body.set(part, offset); offset += part.length; }
    return body;
  } catch (error) {
    // A tee branch may not resolve cancellation until its sibling is consumed.
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally { clearTimeout(timer); reader.releaseLock(); }
}

export function hostedFailure(error: unknown): Response {
  return Response.json({ error: error instanceof IngressError ? error.message : 'SERVICE_UNAVAILABLE' }, {
    status: error instanceof IngressError ? error.status : 503,
    headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
}
