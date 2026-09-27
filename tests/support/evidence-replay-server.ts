import { spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import { fileURLToPath } from 'node:url';
import { offlineNextEnvironment } from './next-environment.ts';

// NODE_ENV=test excludes .env.local; the helper rejects all other auto-loadable
// env filenames and passes no inherited credentials, DB URL or live switches.
const child = spawn(process.execPath, [fileURLToPath(import.meta.resolve('next/dist/bin/next')),
  'start', '-H', '127.0.0.1', '-p', '4331'], {
  env: await offlineNextEnvironment(), stdio: 'inherit',
});
let ready = false;
const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1:4330');
  if (req.method === 'GET' && url.pathname === '/__replay_health') {
    res.writeHead(ready ? 200 : 503); res.end('evidence replay'); return;
  }
  // Defense in depth: even a missed browser interception cannot reach an API.
  if (req.method !== 'GET' || !(/^\/trips\/[a-f0-9-]{36}$/.test(url.pathname) ||
    /^\/_next\/static\/[a-zA-Z0-9_./%~-]+$/.test(url.pathname))) {
    res.writeHead(403); res.end('REPLAY_SERVER_DENIED'); return;
  }
  const upstream = request({ host: '127.0.0.1', port: 4331, path: req.url, method: 'GET',
    headers: { host: '127.0.0.1:4331' }, timeout: 5000 }, response => {
    res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res);
  });
  upstream.on('timeout', () => upstream.destroy());
  upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
  upstream.end();
});
// Probe only the DB-free client workbench shell; no home/demo creation/API.
const probe = setInterval(() => {
  const req = request('http://127.0.0.1:4331/trips/00000000-0000-4000-8000-000000000000',
    { timeout: 1000 }, res => { res.resume(); if (res.statusCode === 200) { ready = true; clearInterval(probe); } });
  req.on('timeout', () => req.destroy()); req.on('error', () => undefined); req.end();
}, 250);
function stop() {
  clearInterval(probe); server.close(); server.closeAllConnections(); child.kill('SIGTERM');
}
server.on('error', () => { process.exitCode = 1; stop(); });
child.on('error', () => { process.exitCode = 1; stop(); });
child.on('exit', code => { if (code) process.exitCode = code; clearInterval(probe); server.close(); server.closeAllConnections(); });
process.once('SIGTERM', stop); process.once('SIGINT', stop);
server.listen(4330, '127.0.0.1');
