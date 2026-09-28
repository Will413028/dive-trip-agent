import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e', timeout: 30_000, fullyParallel: false, workers: 1,
  use: { baseURL: 'http://127.0.0.1:4319', trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 } } },
  ],
  webServer: {
    command: `uv run --frozen --no-sync --project backend python -m dive_trip.bootstrap.dev --e2e${process.env.E2E_PRODUCTION === '1' ? ' --production' : ''}`, url: 'http://127.0.0.1:4319',
    reuseExistingServer: false, timeout: 90_000,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
  },
});
