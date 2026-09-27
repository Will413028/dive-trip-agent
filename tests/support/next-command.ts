import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { offlineNextEnvironment } from './next-environment.ts';

const command = process.argv[2];
if (command !== 'build' && command !== 'typegen') throw new Error('UNSUPPORTED_OFFLINE_COMMAND');
const child = spawn(process.execPath, [fileURLToPath(import.meta.resolve('next/dist/bin/next')), command, ...(command === 'build' ? ['--webpack'] : [])], {
  env: await offlineNextEnvironment(), stdio: 'inherit',
});
process.once('SIGINT', () => child.kill('SIGINT'));
process.once('SIGTERM', () => child.kill('SIGTERM'));
child.once('error', () => { process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
