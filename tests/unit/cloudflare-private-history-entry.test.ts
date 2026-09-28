import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const boundary = vi.hoisted(() => ({
  profile: vi.fn(), check: vi.fn(), identity: vi.fn(), lock: vi.fn(),
  credential: vi.fn(), database: vi.fn(), databaseUrl: vi.fn(), pool: vi.fn(),
}));
vi.mock('../../evals/cloudflare-history-profile', () => ({
  withPrivateCloudflareHistory: boundary.profile, assertPrivateCloudflareHistory: boundary.check,
  historyIdentity: boundary.identity,
}));
vi.mock('../../evals/live-evaluation-lock', () => ({
  withEvaluationLock: boundary.lock, assertEvaluationLock: vi.fn(),
}));
vi.mock('../../src/server/local-credential', () => ({ loadLocalCredential: boundary.credential }));
vi.mock('../support/database', () => ({ testDatabaseUrl: boundary.databaseUrl }));
vi.mock('../../evals/python-evaluation', () => ({ withPythonEvaluation: boundary.database }));
vi.mock('pg', () => ({ Pool: boundary.pool }));

import { runCloudflareDiagnosticEntry, DIAGNOSTIC_AUTHORIZATION } from '../../evals/cloudflare-diagnostic-entry';
import { runCloudflareNonthinkingEntry, NONTHINKING_AUTHORIZATION } from '../../evals/cloudflare-nonthinking-entry';
import { runCloudflareGroundedEntry, GROUNDED_AUTHORIZATION } from '../../evals/cloudflare-grounded-entry';
import { runCloudflareRecoveryEntry, RECOVERY_AUTHORIZATION } from '../../evals/cloudflare-recovery-entry';
import { runCloudflareRevisionEntry, REVISION_AUTHORIZATION } from '../../evals/cloudflare-revision-entry';

const entries = [
  ['DIAGNOSTIC', DIAGNOSTIC_AUTHORIZATION, runCloudflareDiagnosticEntry],
  ['NONTHINKING', NONTHINKING_AUTHORIZATION, runCloudflareNonthinkingEntry],
  ['GROUNDED', GROUNDED_AUTHORIZATION, runCloudflareGroundedEntry],
  ['RECOVERY', RECOVERY_AUTHORIZATION, runCloudflareRecoveryEntry],
  ['REVISION', REVISION_AUTHORIZATION, runCloudflareRevisionEntry],
] as const;

beforeEach(() => {
  vi.resetAllMocks();
  for (const [kind] of entries) vi.stubEnv(`DIVE_TRIP_CLOUDFLARE_${kind}_AUTHORIZATION`, undefined);
  boundary.profile.mockRejectedValue(new Error('EVAL_PRIVATE_HISTORY_INVALID'));
});
afterEach(() => vi.unstubAllEnvs());

function expectNoSideEffects() {
  for (const mock of [boundary.lock, boundary.credential, boundary.database, boundary.databaseUrl, boundary.pool]) {
    expect(mock).not.toHaveBeenCalled();
  }
}

test.each(entries)('%s refuses before opening the private profile without its own authorization', async (_kind, _grant, run) => {
  await expect(run()).rejects.toThrow(/^EVAL_AUTHORIZATION_REQUIRED$/);
  expect(boundary.profile).not.toHaveBeenCalled();
  expect(boundary.identity).not.toHaveBeenCalled();
  expectNoSideEffects();
});

test.each(entries)('%s missing/invalid profile refuses before claim, DB, account or credential work', async (kind, grant, run) => {
  vi.stubEnv(`DIVE_TRIP_CLOUDFLARE_${kind}_AUTHORIZATION`, grant);
  await expect(run()).rejects.toThrow(/^EVAL_PRIVATE_HISTORY_INVALID$/);
  expect(boundary.profile).toHaveBeenCalledOnce();
  // Resolving the schema list before entering the profile would cache fixture IDs.
  expect(boundary.identity).not.toHaveBeenCalled();
  expectNoSideEffects();
});
