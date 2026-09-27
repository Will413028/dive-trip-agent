import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from 'vitest';
import { localIngress } from '../support/local-ingress';

async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}
test('loopback ingress overwrites forged proof, strips forwarding headers and never echoes token', async () => {
  let seen: Record<string, unknown> | undefined;
  const token = 'a'.repeat(64);
  const upstream = createServer((req, res) => {
    seen = req.headers;
    res.setHeader('x-dive-local-ingress', token);
    res.setHeader('Content-Type', 'text/event-stream'); res.end('data: synthetic\n\n');
  });
  const upstreamPort = await listen(upstream);
  const proxy = localIngress(token, upstreamPort, 0);
  const port = await listen(proxy);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/test`, { headers: {
      'x-dive-local-ingress': 'forged', 'x-dive-local-peer': '8.8.8.8', 'x-forwarded-for': '8.8.8.8', forwarded: 'for=8.8.8.8' } });
    expect(await response.text()).toBe('data: synthetic\n\n');
    expect(response.headers.get('x-dive-local-ingress')).toBeNull();
    expect(seen).toMatchObject({ 'x-dive-local-ingress': token, 'x-dive-local-peer': '127.0.0.1' });
    expect(seen).not.toHaveProperty('x-forwarded-for'); expect(seen).not.toHaveProperty('forwarded');
    const denied = await new Promise<number | undefined>((resolve, reject) => {
      const req = httpRequest({ hostname: '127.0.0.1', port, path: '/', headers: { host: 'evil.example' } }, res => {
        res.resume(); res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', reject); req.end();
    });
    expect(denied).toBe(403);
  } finally { await close(proxy); await close(upstream); }
});
