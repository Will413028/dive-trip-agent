vi.mock('../../evals/cloudflare-history-profile', async original => ({
  ...await original<typeof import('../../evals/cloudflare-history-profile')>(),
  withPrivateCloudflareHistory: async (work: () => Promise<unknown>) => work(),
  assertPrivateCloudflareHistory: async () => {},
}));
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { EvaluationLockLease } from '../../evals/live-evaluation-lock.ts';
import type { PythonEvaluationOptions } from '../../evals/python-evaluation.ts';
import { recoveryAccount, recoveryResult } from '../support/cloudflare-recovery-fixture.ts';

const m = vi.hoisted(() => ({ lease: {} as EvaluationLockLease, pools: [] as { end: ReturnType<typeof vi.fn> }[],
  options: undefined as PythonEvaluationOptions | undefined, dispatched: false, retained: false,
  pool: vi.fn(), lock: vi.fn(), assertLock: vi.fn(), claim: vi.fn(), save: vi.fn(), carry: vi.fn(),
  source: vi.fn(), database: vi.fn(), databaseUrl: vi.fn(), credential: vi.fn(), execute: vi.fn(),
  capture: vi.fn(), immutable: vi.fn(), atomic: vi.fn(), delay: vi.fn() }));
vi.mock('pg', () => ({ Pool: m.pool }));
vi.mock('node:timers/promises', () => ({ setTimeout: m.delay }));
vi.mock('../../evals/cloudflare-source', () => ({ readCloudflareSourceManifest: m.source }));
vi.mock('../../evals/cloudflare-carry-forward', () => ({ CARRY_SCHEMA: () => 'first_mock' }));
vi.mock('../../evals/cloudflare-carry-forward-2', () => ({ SECOND_CARRY_SCHEMA: () => 'second_mock' }));
vi.mock('../../evals/cloudflare-quality-carry', () => ({ QUALITY_CARRY_SCHEMA: () => 'quality_mock' }));
vi.mock('../../evals/cloudflare-revision-carry', () => ({ REVISION_CARRY_SCHEMA: () => 'revision_mock' }));
vi.mock('../../evals/cloudflare-recovery-carry', () => ({ RECOVERY_CARRY_SCHEMA: () => 'recovery_mock' }));
vi.mock('../../evals/cloudflare-grounded-carry', () => ({ GROUNDED_CARRY_SCHEMA: () => 'grounded_mock' }));
vi.mock('../../evals/cloudflare-nonthinking-carry', () => ({ NONTHINKING_CARRY_SCHEMA: () => 'nonthinking_mock' }));
vi.mock('../../evals/cloudflare-python-diagnostic-carry', async original => ({
  ...await original<typeof import('../../evals/cloudflare-python-diagnostic-carry')>(),
  readCloudflarePythonDiagnosticCarry: m.carry,
}));
vi.mock('../../evals/cloudflare-python-probe-carry', async original => ({
  ...await original<typeof import('../../evals/cloudflare-python-probe-carry')>(),
  readCloudflarePythonProbeCarry: m.carry,
}));
vi.mock('../../evals/cloudflare-python-probe-2-carry', async original => ({
  ...await original<typeof import('../../evals/cloudflare-python-probe-2-carry')>(),
  readCloudflarePythonProbe2Carry: m.carry,
}));
vi.mock('../../evals/cloudflare-python-quality-carry', async original => ({
  ...await original<typeof import('../../evals/cloudflare-python-quality-carry')>(),
  readCloudflarePythonQualityCarry: m.carry,
}));
vi.mock('../../evals/cloudflare-python-probe-4-carry', async original => ({
  ...await original<typeof import('../../evals/cloudflare-python-probe-4-carry')>(),
  readCloudflarePythonProbe4Carry: m.carry,
}));
vi.mock('../../evals/cloudflare-campaign-claim', () => ({ claimCloudflareCampaign: m.claim }));
vi.mock('../../evals/live-evaluation-lock', () => ({ withEvaluationLock: m.lock, assertEvaluationLock: m.assertLock }));
vi.mock('../support/database', () => ({ testDatabaseUrl: m.databaseUrl }));
vi.mock('../../evals/python-evaluation', () => ({ withPythonEvaluation: m.database }));
vi.mock('../../src/server/local-credential', () => ({ loadLocalCredential: m.credential }));
vi.mock('../../evals/checkpoint', () => ({ writeImmutableCheckpoint: m.immutable, writeAtomicCheckpoint: m.atomic }));
import { PROBE_AUTHORIZATION, runCloudflareProbeEntry } from '../../evals/cloudflare-probe-entry.ts';
import { PROBE_2_AUTHORIZATION, runCloudflareProbe2Entry } from '../../evals/cloudflare-probe-2-entry.ts';

import { PROBE_3_AUTHORIZATION, runCloudflareProbe3Entry } from '../../evals/cloudflare-probe-3-entry.ts';

import { PROBE_5_AUTHORIZATION, runCloudflareProbe5Entry } from '../../evals/cloudflare-probe-5-entry.ts';
import { PROBE_4_AUTHORIZATION, runCloudflareProbe4Entry } from '../../evals/cloudflare-probe-4-entry.ts';

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const prior = () => ({ sourceSha256: hash('synthetic stopped Python report'), historyConsistent: true,
  dispatchAuthorized: false, accountingComplete: false, evaluationGatePassed: false,
  historicalUnknownReceipts: 5, invocations: 44, modelCalls: 63, chargedMicros: 948999,
  observedTokens: 279171, totalTokens: null, remainingInvocationCeiling: 56,
  remainingReferenceMicros: 2051001 });
const probe2Prior = () => ({ sourceSha256: hash('synthetic stopped first probe report'), historyConsistent: true,
  dispatchAuthorized: false, accountingComplete: false, evaluationGatePassed: false,
  historicalUnknownReceipts: 5, invocations: 45, modelCalls: 67, chargedMicros: 949683,
  observedTokens: 285297, totalTokens: null, remainingInvocationCeiling: 55,
  remainingReferenceMicros: 2050317 });
const source = { sha256: hash('synthetic probe source'), files: [{ path: 'backend/src/worker.py', sha256: hash('worker') }] };

beforeEach(() => {
  vi.resetAllMocks(); m.pools.length = 0; m.options = undefined; m.dispatched = false; m.retained = false;
  vi.stubEnv('DIVE_TRIP_CLOUDFLARE_PROBE_AUTHORIZATION', PROBE_AUTHORIZATION);
  vi.stubEnv('DIVE_TRIP_CLOUDFLARE_ACCOUNT_ID', recoveryAccount);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('NETWORK_FORBIDDEN'); }));
  m.lock.mockImplementation(async work => work(m.lease));
  m.claim.mockImplementation(async (lease, kind) => { expect(lease).toBe(m.lease); expect(kind).toBe('probe'); return m.save; });
  m.pool.mockImplementation(function () { const pool = { end: vi.fn(async () => {}) }; m.pools.push(pool); return pool; });
  m.databaseUrl.mockReturnValue('postgresql://postgres@127.0.0.1:15432/dive_trip_test');
  m.carry.mockImplementation(async (pools, lease) => { expect(pools).toEqual(m.pools); expect(lease).toBe(m.lease); return prior(); });
  m.source.mockImplementation(async () => structuredClone(source));
  m.database.mockImplementation(async (options, work) => {
    m.options = options;
    try { await work({ execute: m.execute, capture: m.capture }); m.retained = options.retention === 'retain'; }
    catch (error) { m.retained = true; throw error; }
  });
  m.execute.mockImplementation(async (caseId, beforeDispatch) => {
    await beforeDispatch(new AbortController().signal); m.dispatched = true;
    await m.options!.loadCredential();
    return recoveryResult(caseId, 1);
  });
  m.credential.mockResolvedValue('synthetic-unit-only');
  m.capture.mockImplementation(async () => ({ chargedMicros: 100, modelCalls: 2,
    totalTokens: 1000, privateUsageComplete: true, usageKnown: true, record: { synthetic: true } }));
});
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

test.each([undefined, '', 'diagnostic-two-included-plus-28-210-calls-39-invocations-once-cloudflare-free-tier-confirmed'])(
  'missing or consumed authorization %s cannot touch history, claim, DB or credential', async grant => {
  vi.stubEnv('DIVE_TRIP_CLOUDFLARE_PROBE_AUTHORIZATION', grant);
  await expect(runCloudflareProbeEntry()).rejects.toThrow('EVAL_AUTHORIZATION_REQUIRED');
  for (const fn of [m.lock, m.claim, m.pool, m.carry, m.database, m.credential, m.source]) expect(fn).not.toHaveBeenCalled();
});

test('one technical case checks history before dispatch and cleanup, then retains evidence', async () => {
  await expect(runCloudflareProbeEntry()).resolves.toBeUndefined();
  expect(m.claim).toHaveBeenCalledExactlyOnceWith(m.lease, 'probe');
  expect(m.pools).toHaveLength(8);
  expect(m.options).toMatchObject({ accountId: recoveryAccount, priorChargedMicros: 948999,
    liveCampaign: 'cloudflare-probe-one-case', retention: 'retain' });
  expect(m.execute).toHaveBeenCalledExactlyOnceWith('unknown-cost', expect.any(Function));
  expect(m.credential).toHaveBeenCalledExactlyOnceWith('cloudflare');
  expect(m.carry).toHaveBeenCalledTimes(3); expect(m.source).toHaveBeenCalledTimes(3);
  expect(m.retained).toBe(true);
  expect(m.immutable).not.toHaveBeenCalled();
  expect(m.save.mock.calls.at(-1)![0]).toMatchObject({ stopped: null, diagnosticComplete: true,
    invocations: 1, maxInvocations: 1, maxModelCalls: 7, evaluationGatePassed: false });
});

test.each(['claim', 'history', 'source', 'lease'])('%s denial precedes credential loading', async failure => {
  if (failure === 'claim') m.claim.mockRejectedValue(new Error('EVAL_ALREADY_CLAIMED'));
  if (failure === 'history') m.carry.mockResolvedValueOnce(prior()).mockRejectedValue(new Error('EVAL_HISTORY_CHANGED'));
  if (failure === 'source') m.source.mockResolvedValueOnce(source).mockResolvedValue({ ...source, sha256: hash('changed') });
  if (failure === 'lease') m.assertLock.mockRejectedValue(new Error('EVAL_LOCK_NOT_OWNED'));
  await expect(runCloudflareProbeEntry()).rejects.toThrow();
  expect(m.credential).not.toHaveBeenCalled();
  expect(m.pools.every(p => p.end.mock.calls.length === 1)).toBe(true);
});

test('new technical entry requires its own grant and claim before loading credentials', async () => {
  await expect(runCloudflareProbe2Entry()).rejects.toThrow('EVAL_AUTHORIZATION_REQUIRED');
  expect(m.claim).not.toHaveBeenCalled();
  vi.stubEnv('DIVE_TRIP_CLOUDFLARE_PROBE_2_AUTHORIZATION', PROBE_2_AUTHORIZATION);
  m.claim.mockImplementation(async (lease, kind) => { expect(lease).toBe(m.lease); expect(kind).toBe('probe2'); return m.save; });
  m.carry.mockImplementation(async (pools, lease) => {
    expect(pools).toEqual(m.pools); expect(lease).toBe(m.lease); return probe2Prior();
  });
  await expect(runCloudflareProbe2Entry()).resolves.toBeUndefined();
  expect(m.claim).toHaveBeenCalledExactlyOnceWith(m.lease, 'probe2');
  expect(m.pools).toHaveLength(8);
  expect(m.options).toMatchObject({ accountId: recoveryAccount, priorChargedMicros: 949683,
    liveCampaign: 'cloudflare-probe-2-one-case', retention: 'retain' });
  expect(m.execute).toHaveBeenCalledExactlyOnceWith('unknown-cost', expect.any(Function));
  expect(m.credential).toHaveBeenCalledExactlyOnceWith('cloudflare');
  expect(m.carry).toHaveBeenCalledTimes(3);
  expect(m.source).toHaveBeenCalledTimes(3);
  expect(m.save.mock.calls.at(-1)![0]).toMatchObject({ stopped: null,
    diagnosticComplete: true, invocations: 1, maxInvocations: 1, maxModelCalls: 7,
    evaluationGatePassed: false });
});

test('new technical entry requires its own grant and claim before loading credentials', async () => {
  await expect(runCloudflareProbe3Entry()).rejects.toThrow('EVAL_AUTHORIZATION_REQUIRED');
  expect(m.claim).not.toHaveBeenCalled();
  vi.stubEnv('DIVE_TRIP_CLOUDFLARE_PROBE_3_AUTHORIZATION', PROBE_3_AUTHORIZATION);
  m.claim.mockImplementation(async (lease, kind) => { expect(lease).toBe(m.lease); expect(kind).toBe('probe3'); return m.save; });
  m.carry.mockImplementation(async (pools, lease) => {
    expect(pools).toEqual(m.pools); expect(lease).toBe(m.lease); return { ...probe2Prior(), invocations: 46, modelCalls: 68, chargedMicros: 949848,
      observedTokens: 286610, remainingInvocationCeiling: 54, remainingReferenceMicros: 2050152 };
  });
  await expect(runCloudflareProbe3Entry()).resolves.toBeUndefined();
  expect(m.claim).toHaveBeenCalledExactlyOnceWith(m.lease, 'probe3');
  expect(m.pools).toHaveLength(8);
  expect(m.options).toMatchObject({ accountId: recoveryAccount, priorChargedMicros: 949848,
    liveCampaign: 'cloudflare-probe-3-one-case', retention: 'retain' });
  expect(m.execute).toHaveBeenCalledExactlyOnceWith('unknown-cost', expect.any(Function));
  expect(m.credential).toHaveBeenCalledExactlyOnceWith('cloudflare');
  expect(m.carry).toHaveBeenCalledTimes(3);
  expect(m.source).toHaveBeenCalledTimes(3);
  expect(m.save.mock.calls.at(-1)![0]).toMatchObject({ stopped: null,
    diagnosticComplete: true, invocations: 1, maxInvocations: 1, maxModelCalls: 7,
    evaluationGatePassed: false });
});


test.each(['claim', 'history', 'source', 'lease'])('third probe %s denial cannot load credentials', async failure => {
  vi.stubEnv('DIVE_TRIP_CLOUDFLARE_PROBE_3_AUTHORIZATION', PROBE_3_AUTHORIZATION);
  m.claim.mockResolvedValue(m.save);
  const history = { ...probe2Prior(), invocations: 46, modelCalls: 68, chargedMicros: 949848,
    observedTokens: 286610, remainingInvocationCeiling: 54, remainingReferenceMicros: 2050152 };
  m.carry.mockResolvedValue(history);
  if (failure === 'claim') m.claim.mockRejectedValue(new Error('EVAL_ALREADY_CLAIMED'));
  if (failure === 'history') m.carry.mockResolvedValueOnce(history).mockRejectedValue(new Error('EVAL_HISTORY_CHANGED'));
  if (failure === 'source') m.source.mockResolvedValueOnce(source).mockResolvedValue({ ...source, sha256: hash('changed') });
  if (failure === 'lease') m.assertLock.mockRejectedValue(new Error('EVAL_LOCK_NOT_OWNED'));
  await expect(runCloudflareProbe3Entry()).rejects.toThrow();
  expect(m.credential).not.toHaveBeenCalled();
});

test('new technical entry requires its own grant and claim before loading credentials', async () => {
  await expect(runCloudflareProbe4Entry()).rejects.toThrow('EVAL_AUTHORIZATION_REQUIRED');
  expect(m.claim).not.toHaveBeenCalled();
  vi.stubEnv('DIVE_TRIP_CLOUDFLARE_PROBE_4_AUTHORIZATION', PROBE_4_AUTHORIZATION);
  m.claim.mockImplementation(async (lease, kind) => { expect(lease).toBe(m.lease); expect(kind).toBe('probe4'); return m.save; });
  m.carry.mockImplementation(async (pools, lease) => {
    expect(pools).toEqual(m.pools); expect(lease).toBe(m.lease); return { ...probe2Prior(), invocations: 48, modelCalls: 72, chargedMicros: 1133641, historicalUnknownReceipts: 6,
      observedTokens: 291929, remainingInvocationCeiling: 52, remainingReferenceMicros: 1866359 };
  });
  await expect(runCloudflareProbe4Entry()).resolves.toBeUndefined();
  expect(m.claim).toHaveBeenCalledExactlyOnceWith(m.lease, 'probe4');
  expect(m.pools).toHaveLength(8);
  expect(m.options).toMatchObject({ accountId: recoveryAccount, priorChargedMicros: 1133641,
    liveCampaign: 'cloudflare-probe-4-one-case', retention: 'retain' });
  expect(m.execute).toHaveBeenCalledExactlyOnceWith('unknown-cost', expect.any(Function));
  expect(m.credential).toHaveBeenCalledExactlyOnceWith('cloudflare');
  expect(m.carry).toHaveBeenCalledTimes(3);
  expect(m.source).toHaveBeenCalledTimes(3);
  expect(m.save.mock.calls.at(-1)![0]).toMatchObject({ stopped: null,
    diagnosticComplete: true, invocations: 1, maxInvocations: 1, maxModelCalls: 7,
    evaluationGatePassed: false });
});


test.each(['claim', 'history', 'source', 'lease'])('fourth probe %s denial cannot load credentials', async failure => {
  vi.stubEnv('DIVE_TRIP_CLOUDFLARE_PROBE_4_AUTHORIZATION', PROBE_4_AUTHORIZATION);
  m.claim.mockResolvedValue(m.save);
  const history = { ...probe2Prior(), invocations: 48, modelCalls: 72, chargedMicros: 1133641, historicalUnknownReceipts: 6,
    observedTokens: 291929, remainingInvocationCeiling: 52, remainingReferenceMicros: 1866359 };
  m.carry.mockResolvedValue(history);
  if (failure === 'claim') m.claim.mockRejectedValue(new Error('EVAL_ALREADY_CLAIMED'));
  if (failure === 'history') m.carry.mockResolvedValueOnce(history).mockRejectedValue(new Error('EVAL_HISTORY_CHANGED'));
  if (failure === 'source') m.source.mockResolvedValueOnce(source).mockResolvedValue({ ...source, sha256: hash('changed') });
  if (failure === 'lease') m.assertLock.mockRejectedValue(new Error('EVAL_LOCK_NOT_OWNED'));
  await expect(runCloudflareProbe4Entry()).rejects.toThrow();
  expect(m.credential).not.toHaveBeenCalled();
});

test.each([undefined, '', PROBE_3_AUTHORIZATION])('fourth probe rejects missing or consumed grant %s', async grant => {
  vi.stubEnv('DIVE_TRIP_CLOUDFLARE_PROBE_4_AUTHORIZATION',grant);
  await expect(runCloudflareProbe4Entry()).rejects.toThrow('EVAL_AUTHORIZATION_REQUIRED');
  for(const fn of [m.lock,m.claim,m.pool,m.carry,m.database,m.credential])expect(fn).not.toHaveBeenCalled();
});

test('fifth technical entry requires its own grant and claim before loading credentials', async () => {
  await expect(runCloudflareProbe5Entry()).rejects.toThrow('EVAL_AUTHORIZATION_REQUIRED');
  expect(m.claim).not.toHaveBeenCalled();
  vi.stubEnv('DIVE_TRIP_CLOUDFLARE_PROBE_5_AUTHORIZATION', PROBE_5_AUTHORIZATION);
  m.claim.mockImplementation(async (lease, kind) => { expect(lease).toBe(m.lease); expect(kind).toBe('probe5'); return m.save; });
  m.carry.mockImplementation(async (pools, lease) => {
    expect(pools).toEqual(m.pools); expect(lease).toBe(m.lease); return { ...probe2Prior(), invocations: 49, modelCalls: 74, chargedMicros: 1317146, historicalUnknownReceipts: 7,
      observedTokens: 294637, remainingInvocationCeiling: 51, remainingReferenceMicros: 1682854 };
  });
  await expect(runCloudflareProbe5Entry()).resolves.toBeUndefined();
  expect(m.claim).toHaveBeenCalledExactlyOnceWith(m.lease, 'probe5');
  expect(m.pools).toHaveLength(8);
  expect(m.options).toMatchObject({ accountId: recoveryAccount, priorChargedMicros: 1317146,
    liveCampaign: 'cloudflare-probe-5-one-case', retention: 'retain' });
  expect(m.execute).toHaveBeenCalledExactlyOnceWith('unknown-cost', expect.any(Function));
  expect(m.credential).toHaveBeenCalledExactlyOnceWith('cloudflare');
  expect(m.carry).toHaveBeenCalledTimes(3);
  expect(m.source).toHaveBeenCalledTimes(3);
  expect(m.save.mock.calls.at(-1)![0]).toMatchObject({ stopped: null,
    diagnosticComplete: true, invocations: 1, maxInvocations: 1, maxModelCalls: 7,
    evaluationGatePassed: false });
});


test.each(['claim', 'history', 'source', 'lease'])('fifth probe %s denial cannot load credentials', async failure => {
  vi.stubEnv('DIVE_TRIP_CLOUDFLARE_PROBE_5_AUTHORIZATION', PROBE_5_AUTHORIZATION);
  m.claim.mockResolvedValue(m.save);
  const history = { ...probe2Prior(), invocations: 49, modelCalls: 74, chargedMicros: 1317146, historicalUnknownReceipts: 7,
    observedTokens: 294637, remainingInvocationCeiling: 51, remainingReferenceMicros: 1682854 };
  m.carry.mockResolvedValue(history);
  if (failure === 'claim') m.claim.mockRejectedValue(new Error('EVAL_ALREADY_CLAIMED'));
  if (failure === 'history') m.carry.mockResolvedValueOnce(history).mockRejectedValue(new Error('EVAL_HISTORY_CHANGED'));
  if (failure === 'source') m.source.mockResolvedValueOnce(source).mockResolvedValue({ ...source, sha256: hash('changed') });
  if (failure === 'lease') m.assertLock.mockRejectedValue(new Error('EVAL_LOCK_NOT_OWNED'));
  await expect(runCloudflareProbe5Entry()).rejects.toThrow();
  expect(m.credential).not.toHaveBeenCalled();
});

test.each([undefined, '', PROBE_4_AUTHORIZATION])('fifth probe rejects missing or consumed grant %s', async grant => {
  vi.stubEnv('DIVE_TRIP_CLOUDFLARE_PROBE_5_AUTHORIZATION',grant);
  await expect(runCloudflareProbe5Entry()).rejects.toThrow('EVAL_AUTHORIZATION_REQUIRED');
  for(const fn of [m.lock,m.claim,m.pool,m.carry,m.database,m.credential])expect(fn).not.toHaveBeenCalled();
});
