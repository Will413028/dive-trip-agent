import { createServer, request as httpRequest } from 'node:http';
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';

/** Stable private salt across local restarts; never the Gemini key. */
export async function localIpKey(): Promise<string> {
  const path = resolve(process.cwd(), '.local-ingress-key');
  try {
    const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(randomBytes(32)); } finally { await file.close(); }
  } catch (error) {
    // eslint-disable-next-line preserve-caught-error -- Do not retain private filesystem diagnostics in credential errors.
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error('LOCAL_INGRESS_KEY_UNAVAILABLE');
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size !== 32 || (stat.mode & 0o077) !== 0) throw new Error('LOCAL_INGRESS_KEY_UNAVAILABLE');
    return (await file.readFile()).toString('hex');
  } finally { await file.close(); }
}

/** Fixed-target streaming proxy. No forwarded header is a source of authority.
 * Upstream token is overwritten, never forwarded back, logged or browser-visible. */
export function localIngress(token: string, upstreamPort: number, publicPort = 4318) {
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('LOCAL_INGRESS_CONFIG');
  return createServer({ maxHeaderSize: 16_384, requestTimeout: 70_000, headersTimeout: 10_000 }, (req, res) => {
    const reject = (status: number) => { res.writeHead(status, { 'Cache-Control': 'no-store' }); res.end(); };
    if (req.socket.remoteAddress !== '127.0.0.1' || req.headers.host !== `127.0.0.1:${publicPort || req.socket.localPort}`
      || !req.url?.startsWith('/') || req.url.startsWith('//') || req.headers.upgrade) return reject(403);
    const headers = { ...req.headers };
    for (const name of Object.keys(headers)) {
      if (name.startsWith('x-forwarded-') || name.startsWith('x-dive-') || ['forwarded', 'x-real-ip', 'connection', 'proxy-authorization', 'proxy-connection'].includes(name)) delete headers[name];
    }
    headers.host = `127.0.0.1:${upstreamPort}`;
    headers['x-dive-local-ingress'] = token;
    headers['x-dive-local-peer'] = req.socket.remoteAddress;
    const upstream = httpRequest({ hostname: '127.0.0.1', port: upstreamPort, path: req.url,
      method: req.method, headers, timeout: 65_000 }, incoming => {
      const responseHeaders = { ...incoming.headers };
      for (const name of Object.keys(responseHeaders)) if (name.startsWith('x-dive-')) delete responseHeaders[name];
      res.writeHead(incoming.statusCode ?? 502, responseHeaders);
      incoming.on('error', () => res.destroy());
      incoming.pipe(res);
    });
    upstream.on('timeout', () => upstream.destroy());
    upstream.on('error', () => { if (!res.headersSent) reject(502); else res.destroy(); });
    req.on('aborted', () => upstream.destroy());
    res.on('close', () => { if (!res.writableFinished) upstream.destroy(); });
    req.pipe(upstream);
  });
}
