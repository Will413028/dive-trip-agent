import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';

function killBackend(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

test('stopping launcher before backend ready also reaps the backend', { timeout: 15_000 }, async () => {
  const launcher = fork(new URL('./support/probe-dev.ts', import.meta.url), [], {
    env: { PATH: process.env.PATH, NODE_ENV: 'test', OTEL_SDK_DISABLED: 'true' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let backendPid: number | undefined;
  let output = '';
  launcher.stderr?.on('data', chunk => { output += chunk; });
  launcher.stdout?.on('data', chunk => { output += chunk; });
  const exit = new Promise<number | null>(resolve => launcher.once('exit', resolve));
  const watchdog = setTimeout(() => { launcher.kill('SIGKILL'); }, 10_000);
  try {
    await new Promise<void>((resolve, reject) => {
      launcher.once('error', reject);
      launcher.once('exit', () => reject(new Error(`Launcher exited before ready: ${output}`)));
      launcher.once('message', (message: { backendPid: number }) => {
        backendPid = message.backendPid;
        launcher.kill('SIGTERM');
        resolve();
      });
    });
    assert.equal(await exit, 0, output);
    assert(backendPid);
    assert.throws(() => process.kill(backendPid!, 0), { code: 'ESRCH' });
    assert(!output.includes('Local:'), 'Frontend must not start after cancellation');
  } finally {
    clearTimeout(watchdog);
    if (launcher.exitCode === null && launcher.signalCode === null) launcher.kill('SIGKILL');
    if (backendPid !== undefined) killBackend(backendPid);
    await exit;
  }
});
