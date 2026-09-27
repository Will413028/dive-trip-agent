import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import { assertFixtureCi } from '../../scripts/assert-fixture-ci';

const fixtureEnvironmentNames = ['CI', 'PATH', 'NEXT_TELEMETRY_DISABLED', 'PLAYWRIGHT_SKIP_BROWSER_GC',
  'COMPOSE_PROJECT_NAME', 'E2E_PRODUCTION', 'GITHUB_RUN_ID'];
const externalEnvironmentNames = [
  'DATABASE_URL', 'GEMINI_API_KEY', 'GEMINI_ENABLED', 'GEMINI_MODEL', 'GOOGLE_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_GENAI_USE_VERTEXAI', 'OPENROUTER_API_KEY', 'OPENROUTER_MODEL',
  'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_MODEL',
  'DIVE_LOCAL_LIVE', 'DIVE_LOCAL_INGRESS_TOKEN', 'DIVE_LOCAL_IP_KEY', 'DIVE_LOCAL_PROVIDER',
  'DIVE_TRIP_CLOUDFLARE_ACCOUNT_ID', 'DIVE_TRIP_CLOUDFLARE_SMOKE', 'DIVE_TRIP_LIVE_BROWSER',
  'DIVE_TRIP_LIVE_SMOKE_AUTHORIZATION', 'DIVE_TRIP_LIVE_EVAL_AUTHORIZATION',
  'DIVE_TRIP_CLOUDFLARE_EVAL_AUTHORIZATION', 'DIVE_TRIP_CLOUDFLARE_SECOND_EVAL_AUTHORIZATION',
  'DIVE_TRIP_CLOUDFLARE_PATCH_EVAL_AUTHORIZATION', 'DIVE_TRIP_CLOUDFLARE_QUALITY_AUTHORIZATION',
  'DIVE_TRIP_CLOUDFLARE_REVISION_AUTHORIZATION', 'DIVE_TRIP_CLOUDFLARE_RECOVERY_AUTHORIZATION',
  'DIVE_TRIP_CLOUDFLARE_GROUNDED_AUTHORIZATION', 'DIVE_TRIP_CLOUDFLARE_NONTHINKING_AUTHORIZATION',
  'DIVE_TRIP_CLOUDFLARE_DIAGNOSTIC_AUTHORIZATION',
];

test('fixture metadata permits only the exact env template and ordinary CI settings', () => {
  expect(() => assertFixtureCi(['package.json', '.env.example', '.github'], fixtureEnvironmentNames)).not.toThrow();
});

test.each([
  '.env', '.env.local', '.env.test', '.env.test.local', '.env.production', '.env.production.local',
  '.env.cloudflare.local', '.env.openrouter.local', '.env.future-provider', '.env.example.bak',
])('rejects env filename %s without reading it', name => {
  expect(() => assertFixtureCi(['.env.example', name], [])).toThrow('CI_ENV_FILES_FORBIDDEN');
});

test.each(externalEnvironmentNames)('rejects inherited provider/live configuration %s', name => {
  expect(() => assertFixtureCi([], [...fixtureEnvironmentNames, name])).toThrow('CI_EXTERNAL_CREDENTIALS_FORBIDDEN');
});

test.each([
  'DIVE_TRIP_FUTURE_AUTHORIZATION', 'DIVE_TRIP_FUTURE_SMOKE', 'CLOUDFLARE_FUTURE_SETTING',
])('new namespace member %s cannot bypass the boundary', name => {
  expect(() => assertFixtureCi([], [name])).toThrow('CI_EXTERNAL_CREDENTIALS_FORBIDDEN');
});

test('enumerating names never reads credential values', () => {
  const environment = Object.defineProperty({}, 'OPENROUTER_API_KEY', {
    enumerable: true, get() { throw new Error('ENVIRONMENT_VALUE_READ'); },
  });
  expect(() => assertFixtureCi([], Object.keys(environment))).toThrow('CI_EXTERNAL_CREDENTIALS_FORBIDDEN');
});

test('workflow invokes the standalone guard before install and omits forbidden env placeholders', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const guard = workflow.indexOf('node scripts/assert-fixture-ci.ts');
  const install = workflow.indexOf('pnpm install --frozen-lockfile');
  expect(guard).toBeGreaterThanOrEqual(0);
  expect(install).toBeGreaterThan(guard);
  const names = [...workflow.matchAll(/^ {6}([A-Z][A-Z0-9_]*):/gm)].map(match => match[1]);
  expect(names).toContain('CI');
  expect(names).toContain('COMPOSE_PROJECT_NAME');
  expect(() => assertFixtureCi([], names)).not.toThrow();
});

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function directory() {
  const path = mkdtempSync(join(tmpdir(), 'dive-fixture-ci-'));
  directories.push(path);
  return path;
}

function runGuard(cwd: string, env: Record<string, string> = {}) {
  // No inherited environment, dependency install, application launcher or DB.
  return spawnSync(process.execPath, [fileURLToPath(new URL('../../scripts/assert-fixture-ci.ts', import.meta.url))],
    { cwd, env: { ...env, NODE_ENV: 'test' }, encoding: 'utf8', timeout: 2000 });
}

test('native Node CLI runs with no installed dependencies in its working directory', () => {
  const result = runGuard(directory());
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stdout).toBe('');
  expect(result.stderr).toBe('');
});

test('native CLI rejects a provider env filename using directory entries alone', () => {
  const cwd = directory();
  // A directory is enough to trigger the name guard; there is no payload to read.
  mkdirSync(join(cwd, '.env.cloudflare.local'));
  const result = runGuard(cwd);
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toBe('CI_FIXTURE_BOUNDARY_FAILED\n');
});

test.each([
  { name: 'GEMINI_API_KEY', value: 'synthetic-not-a-credential' },
  { name: 'OPENROUTER_API_KEY', value: 'synthetic-not-a-credential' },
  { name: 'CLOUDFLARE_API_TOKEN', value: 'synthetic-not-a-credential' },
  { name: 'DIVE_TRIP_CLOUDFLARE_DIAGNOSTIC_AUTHORIZATION', value: 'synthetic-not-a-grant' },
  { name: 'DIVE_TRIP_CLOUDFLARE_DIAGNOSTIC_AUTHORIZATION', value: '' },
])('native CLI rejects $name without printing its value', ({ name, value }) => {
  const result = runGuard(directory(), { [name]: value });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toBe('CI_FIXTURE_BOUNDARY_FAILED\n');
});
