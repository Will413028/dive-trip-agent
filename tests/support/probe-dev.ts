import { fork, execFileSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

// Dedicated synthetic database only. Does not start Docker or load .env files.
const port = execFileSync('docker', ['port', 'dive-trip-adk-spike', '5432'], { encoding: 'utf8' }).trim().split(':').at(-1);
let child: ChildProcess | undefined;
let vite: Awaited<ReturnType<typeof createServer>> | undefined;
let stopping = false;
async function close() {
  stopping = true;
  await vite?.close();
  const worker = child;
  if (!worker || worker.exitCode !== null || worker.signalCode !== null) return;
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => { worker.kill('SIGKILL'); }, 2000);
    worker.once('exit', () => { clearTimeout(timer); resolve(); });
    worker.kill();
  });
}
process.once('SIGINT', () => { void close(); });
process.once('SIGTERM', () => { void close(); });
try {
  child = fork(new URL('./adk-spike-worker.ts', import.meta.url), [
    `postgresql://postgres@127.0.0.1:${port}/dive_trip_adk_spike`,
  ], { env: { PATH: process.env.PATH, NODE_ENV: 'test', OTEL_SDK_DISABLED: 'true' }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  const worker = child;
  process.send?.({ backendPid: worker.pid });
  const backendPort = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => { worker.kill(); reject(new Error('Backend startup timeout')); }, 20_000);
    worker.once('error', error => { clearTimeout(timer); reject(error); });
    worker.once('exit', () => { clearTimeout(timer); reject(new Error('Backend exited')); });
    worker.once('message', (message: { port: number }) => { clearTimeout(timer); resolve(message.port); });
  });
  if (stopping) throw new Error('Startup cancelled');
  vite = await createServer({ configFile: false, envDir: false,
    root: fileURLToPath(new URL('../probe-ui/', import.meta.url)),
    server: { host: '127.0.0.1', port: 4317, strictPort: true,
      proxy: Object.fromEntries(['/agent', '/session'].map(path => [path, {
        target: `http://127.0.0.1:${backendPort}`, changeOrigin: true,
      }])) },
  });
  if (stopping) await close();
  else {
    await vite.listen();
    if (stopping) await close();
    else vite.printUrls();
  }
} catch (error) {
  const cancelled = stopping;
  await close();
  if (!cancelled) throw error;
}
