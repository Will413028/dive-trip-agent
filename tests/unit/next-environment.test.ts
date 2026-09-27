import { expect, test, vi } from 'vitest';
import { readdir } from 'node:fs/promises';
import { offlineNextEnvironment } from '../support/next-environment';

vi.mock('node:fs/promises', () => ({ readdir: vi.fn() }));

test('離線Next只傳必要環境變數，test mode不載入.env.local', async () => {
  vi.mocked(readdir).mockResolvedValue(['.env.local', '.env.example'] as never);
  const env = await offlineNextEnvironment();
  expect(Object.keys(env).sort()).toEqual(['GEMINI_ENABLED', 'NEXT_TELEMETRY_DISABLED', 'NODE_ENV', 'PATH', 'PLAYWRIGHT_SKIP_BROWSER_GC']);
  expect(env.NODE_ENV).toBe('test');
  expect(env.GEMINI_ENABLED).toBe('false');
});

test.each(['.env', '.env.test', '.env.test.local'])('只靠檔名就阻止載入%s，不讀內容', async name => {
  vi.mocked(readdir).mockResolvedValue([name] as never);
  await expect(offlineNextEnvironment()).rejects.toThrow('OFFLINE_NEXT_REQUIRES_NO_TEST_ENV_FILES');
});
