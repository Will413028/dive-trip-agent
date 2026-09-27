import { defineConfig, devices } from '@playwright/test';

// Explicit opt-in only. Uses a pre-existing production build; never builds,
// migrates, starts a model provider or shares the normal E2E DB launcher.
export default defineConfig({
  testDir: './tests/e2e', testMatch: 'evidence-replay.spec.ts',
  metadata: { evidenceReplay: true }, workers: 1, fullyParallel: false,
  retries: 0, timeout: 60_000, outputDir: 'test-results/evidence-replay',
  use: { baseURL: 'http://127.0.0.1:4330', serviceWorkers: 'block',
    trace: 'off', video: { mode: 'on', size: { width: 1280, height: 900 } } },
  projects: [{ name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } } }],
  webServer: { command: 'node tests/support/evidence-replay-server.ts',
    url: 'http://127.0.0.1:4330/__replay_health', reuseExistingServer: false,
    timeout: 30_000, gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 } },
});
