vi.mock('../../evals/cloudflare-history-profile', async original => ({
  ...await original<typeof import('../../evals/cloudflare-history-profile')>(),
  withPrivateCloudflareHistory: async (work: () => Promise<unknown>) => work(),
  assertPrivateCloudflareHistory: async () => {},
}));
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { EvaluationLockLease } from '../../evals/live-evaluation-lock';
import type { PythonEvaluationOptions as CloudflareCampaignPortsOptions } from '../../evals/python-evaluation';
import { nonthinkingPrior } from '../support/cloudflare-nonthinking-fixture';
import { recoveryAccount, recoveryResult } from '../support/cloudflare-recovery-fixture';

const m = vi.hoisted(() => ({ pools: [] as { end: ReturnType<typeof vi.fn> }[], lease: {} as EvaluationLockLease,
  options: undefined as CloudflareCampaignPortsOptions | undefined, inDatabase: false, failed: false, dispatched: false,
  pool: vi.fn(), lock: vi.fn(), assertLock: vi.fn(), claim: vi.fn(), save: vi.fn(), carry: vi.fn(), source: vi.fn(),
  database: vi.fn(), databaseUrl: vi.fn(), ports: vi.fn(), credential: vi.fn(), execute: vi.fn(), capture: vi.fn(),
  immutable: vi.fn(), atomic: vi.fn(), review: vi.fn(), delay: vi.fn() }));
vi.mock('pg', () => ({ Pool: m.pool }));
vi.mock('node:timers/promises', () => ({ setTimeout: m.delay }));
vi.mock('../../evals/cloudflare-source', () => ({ readCloudflareSourceManifest: m.source }));
vi.mock('../../evals/cloudflare-carry-forward', () => ({ CARRY_SCHEMA: () => 'first_mock' }));
vi.mock('../../evals/cloudflare-carry-forward-2', () => ({ SECOND_CARRY_SCHEMA: () => 'second_mock' }));
vi.mock('../../evals/cloudflare-quality-carry', () => ({ QUALITY_CARRY_SCHEMA: () => 'quality_mock' }));
vi.mock('../../evals/cloudflare-revision-carry', () => ({ REVISION_CARRY_SCHEMA: () => 'revision_mock' }));
vi.mock('../../evals/cloudflare-recovery-carry', () => ({ RECOVERY_CARRY_SCHEMA: () => 'recovery_mock' }));
vi.mock('../../evals/cloudflare-grounded-carry', () => ({ GROUNDED_CARRY_SCHEMA: () => 'grounded_mock', readCloudflareGroundedCarry: m.carry }));
vi.mock('../../evals/cloudflare-campaign-claim', () => ({ claimCloudflareCampaign: m.claim }));
vi.mock('../../evals/live-evaluation-lock', () => ({ withEvaluationLock: m.lock, assertEvaluationLock: m.assertLock }));
vi.mock('../support/database', () => ({ testDatabaseUrl: m.databaseUrl }));
vi.mock('../../evals/python-evaluation', () => ({ withPythonEvaluation: m.database }));
vi.mock('../../src/server/local-credential', () => ({ loadLocalCredential: m.credential }));
vi.mock('../../evals/cloudflare-preflight-review', () => ({ awaitCloudflarePreflightReview: m.review }));
vi.mock('../../evals/checkpoint', () => ({ writeImmutableCheckpoint: m.immutable, writeAtomicCheckpoint: m.atomic }));
import { NONTHINKING_AUTHORIZATION, runCloudflareNonthinkingEntry } from '../../evals/cloudflare-nonthinking-entry';

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const source = { sha256: hash('synthetic nonthinking source'), files: [{ path: 'evals/cases.json', sha256: hash('synthetic cases') }] };
beforeEach(() => {
  vi.resetAllMocks(); m.pools.length = 0; m.inDatabase = false; m.failed = false; m.dispatched = false; m.options = undefined;
  vi.stubEnv('DIVE_TRIP_CLOUDFLARE_NONTHINKING_AUTHORIZATION', NONTHINKING_AUTHORIZATION);
  vi.stubEnv('DIVE_TRIP_CLOUDFLARE_ACCOUNT_ID', recoveryAccount);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('NETWORK_FORBIDDEN'); }));
  m.lock.mockImplementation(async work => work(m.lease));
  m.claim.mockImplementation(async (lease, kind) => {
    expect(lease).toBe(m.lease); expect(kind).toBe('nonthinking'); return m.save;
  });
  m.pool.mockImplementation(function () { const pool = { end: vi.fn(async () => {}) }; m.pools.push(pool); return pool; });
  m.databaseUrl.mockReturnValue('postgresql://postgres@127.0.0.1:15432/dive_trip_test');
  m.carry.mockImplementation(async (...args) => { expect(args).toEqual([...m.pools, m.lease]); return nonthinkingPrior(); });
  m.source.mockImplementation(async () => structuredClone(source));
  m.database.mockImplementation(async (options, work) => {
    expect(options.databasePort).toBe(15432); m.inDatabase = true;
    try { await work(m.ports(options)); } catch (error) { m.failed = true; throw error; } finally { m.inDatabase = false; }
  });
  m.ports.mockImplementation(options => { expect(m.inDatabase).toBe(true); m.options = options; return { execute: m.execute, capture: m.capture }; });
  m.execute.mockImplementation(async (id, beforeDispatch) => {
    await beforeDispatch(new AbortController().signal); m.dispatched = true;
    await m.options!.loadCredential();
    const runId = '11111111-1111-4111-8111-111111111111';
    return recoveryResult(id, 1, { runId, usageRunId: runId });
  });
  m.credential.mockResolvedValue('synthetic-unit-only');
  m.capture.mockImplementation(async () => ({ chargedMicros: m.dispatched ? 100 : 0, modelCalls: m.dispatched ? 2 : 0,
    totalTokens: m.dispatched ? 1000 : 0, privateUsageComplete: true, usageKnown: true, record: { synthetic: true } }));
  m.review.mockImplementation(async (serialized, runId, lease, record, kind) => {
    expect(m.inDatabase).toBe(true); expect(lease).toBe(m.lease); expect(kind).toBe('nonthinking');
    expect(m.execute).toHaveBeenCalledOnce();
    await record({ sourceSha256: hash(serialized), runId, textReview: 'passed', reviewers: ['primary', 'independent'], findings: [] }, true);
    return true;
  });
});
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

test.each([undefined, '', 'grounded-two-included-plus-28-210-calls-39-invocations-once-cloudflare-free-tier-confirmed',
  'two-included-preflights-plus-28-once-cloudflare-free-tier-confirmed'])('missing/old grant %s cannot claim, read history or load credentials', async grant => {
  vi.stubEnv('DIVE_TRIP_CLOUDFLARE_NONTHINKING_AUTHORIZATION', grant);
  vi.stubEnv('DIVE_TRIP_CLOUDFLARE_GROUNDED_AUTHORIZATION', 'grounded-two-included-plus-28-210-calls-39-invocations-once-cloudflare-free-tier-confirmed');
  await expect(runCloudflareNonthinkingEntry()).rejects.toThrow('EVAL_AUTHORIZATION_REQUIRED');
  for (const fn of [m.lock,m.claim,m.pool,m.carry,m.ports,m.credential,m.database,m.source]) expect(fn).not.toHaveBeenCalled();
});

test('one fixed start, seven history scopes, lazy loader and a hash-bound receipt before cleanup', async () => {
  await runCloudflareNonthinkingEntry();
  expect(m.claim).toHaveBeenCalledExactlyOnceWith(m.lease, 'nonthinking');
  expect(m.pool.mock.calls.map(([p]) => p.options)).toEqual(['workbench_live', 'first_mock', 'second_mock', 'quality_mock',
    'revision_mock', 'recovery_mock', 'grounded_mock'].map(s => `-c search_path=${s}`));
  for (const [options] of m.pool.mock.calls) expect(options).not.toHaveProperty('connectionString');
  expect(m.options).toMatchObject({ accountId: recoveryAccount, priorChargedMicros: 581989, liveCampaign: 'cloudflare-nonthinking-one-case' });
  expect(m.execute).toHaveBeenCalledExactlyOnceWith('unknown-cost', expect.any(Function));
  expect(m.credential).toHaveBeenCalledExactlyOnceWith('cloudflare');
  expect(m.carry).toHaveBeenCalledTimes(3); expect(m.source).toHaveBeenCalledTimes(3);
  expect(m.pools.every(p => p.end.mock.calls.length === 1)).toBe(true);
  expect(m.immutable).toHaveBeenCalledTimes(2);
  const [preflight, serialized] = m.immutable.mock.calls[0], [receipt, bytes] = m.immutable.mock.calls[1];
  expect(preflight).toBe('.artifacts/cloudflare-nonthinking-preflight.json');
  expect(receipt).toBe('.artifacts/cloudflare-nonthinking-preflight-receipt.json');
  expect(JSON.parse(serialized)).toMatchObject({ schemaVersion: 2, invocations: 1, sourceManifest: source, prior: nonthinkingPrior() });
  expect(JSON.parse(bytes)).toMatchObject({ passed: true, sourceSha256: hash(serialized), sourceFile: 'cloudflare-nonthinking-preflight.json' });
  expect(m.save.mock.calls.at(-1)![0]).toMatchObject({ stopped: null, invocations: 1, cumulativeInvocations: 43,
    maxModelCalls: 7, maxInvocations: 1, evaluationGatePassed: false, textReview: 'pending',
    preflightReviewReceipt: { file: 'cloudflare-nonthinking-preflight-receipt.json', sha256: hash(bytes) } });
});

test.each(['claim', 'history', 'source', 'lease'])('%s denial occurs before the loader', async failure => {
  if (failure === 'claim') m.claim.mockRejectedValue(new Error('EVAL_ALREADY_CLAIMED'));
  if (failure === 'history') m.carry.mockResolvedValueOnce(nonthinkingPrior()).mockRejectedValue(new Error('EVAL_HISTORY_CHANGED'));
  if (failure === 'source') m.source.mockResolvedValueOnce(source).mockResolvedValue({ ...source, sha256: '0'.repeat(64) });
  if (failure === 'lease') m.assertLock.mockRejectedValue(new Error('EVAL_LOCK_NOT_OWNED'));
  await expect(runCloudflareNonthinkingEntry()).rejects.toThrow();
  expect(m.credential).not.toHaveBeenCalled(); expect(m.review).not.toHaveBeenCalled();
  expect(m.pools.every(p => p.end.mock.calls.length === 1)).toBe(true);
});

test.each(['negative-review', 'unknown', 'final-history'])('%s retains the failed DB without another request', async failure => {
  if (failure === 'negative-review') m.review.mockResolvedValue(false);
  if (failure === 'unknown') m.capture.mockResolvedValue({ chargedMicros: 183505, modelCalls: 2,
    totalTokens: null, privateUsageComplete: true, usageKnown: false, record: { synthetic: true } });
  if (failure === 'final-history') m.carry.mockResolvedValueOnce(nonthinkingPrior()).mockResolvedValueOnce(nonthinkingPrior())
    .mockRejectedValue(new Error('HISTORY_DRIFT'));
  await expect(runCloudflareNonthinkingEntry()).rejects.toThrow();
  expect(m.execute).toHaveBeenCalledOnce(); expect(m.credential).toHaveBeenCalledOnce(); expect(m.failed).toBe(true);
  expect(m.pools.every(p => p.end.mock.calls.length === 1)).toBe(true);
  expect(m.save.mock.calls.at(-1)![0]).toMatchObject({ invocations: 1,
    stopped: failure === 'negative-review' ? 'PREFLIGHT_TEXT_REVIEW_STOP'
      : failure === 'unknown' ? 'UNKNOWN_USAGE_STOP' : 'HISTORY_OR_SOURCE_CHANGED_STOP' });
});
