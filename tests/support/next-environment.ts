import { readdir } from 'node:fs/promises';

export async function offlineNextEnvironment(): Promise<NodeJS.ProcessEnv> {
  // Official NODE_ENV=test skips .env.local. Refuse any other auto-loadable
  // env file by filename only, without opening it or exposing its contents.
  const files = await readdir(process.cwd());
  const blocked = ['.env', '.env.test', '.env.test.local'].some(name => files.includes(name));
  if (blocked) throw new Error('OFFLINE_NEXT_REQUIRES_NO_TEST_ENV_FILES');
  return {
    PATH: process.env.PATH, NODE_ENV: 'test', NEXT_TELEMETRY_DISABLED: '1',
    GEMINI_ENABLED: 'false', PLAYWRIGHT_SKIP_BROWSER_GC: '1',
  };
}
