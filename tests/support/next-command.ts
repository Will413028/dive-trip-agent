import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { offlineNextEnvironment } from './next-environment.ts';

const command = process.argv[2];
if (command !== 'build' && command !== 'hosted-build' && command !== 'typegen') throw new Error('UNSUPPORTED_OFFLINE_COMMAND');
const environment = await offlineNextEnvironment();
if (command === 'hosted-build') {
  delete environment.GEMINI_ENABLED;
  environment.DIVE_HOSTED_FIXTURE = '1';
  environment.APP_ORIGIN = 'https://hosted-fixture.invalid';
  environment.DIVE_BACKEND_ORIGIN = 'http://api:4320';
}
const build = command !== 'typegen';
const child = spawn(process.execPath, [fileURLToPath(import.meta.resolve('next/dist/bin/next')), build ? 'build' : 'typegen', ...(build ? ['--webpack'] : [])], {
  env: environment, stdio: 'inherit',
});
process.once('SIGINT', () => child.kill('SIGINT'));
process.once('SIGTERM', () => child.kill('SIGTERM'));
child.once('error', () => { process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
