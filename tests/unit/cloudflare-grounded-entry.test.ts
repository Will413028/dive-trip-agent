vi.mock('../../evals/cloudflare-history-profile', async original => ({
  ...await original<typeof import('../../evals/cloudflare-history-profile')>(),
  withPrivateCloudflareHistory: async (work: () => Promise<unknown>) => work(),
  assertPrivateCloudflareHistory: async () => {},
}));
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { EvaluationLockLease } from '../../evals/live-evaluation-lock';
import type { PythonEvaluationOptions as CloudflareCampaignPortsOptions } from '../../evals/python-evaluation';
import { groundedPrior } from '../support/cloudflare-grounded-fixture';
import { diagnosticPrior } from '../support/cloudflare-diagnostic-fixture';
import { recoveryAccount, recoveryResult } from '../support/cloudflare-recovery-fixture';
import cases from '../../evals/cases.json';

const m = vi.hoisted(() => ({ pools: [] as { end: ReturnType<typeof vi.fn> }[], lease: {} as EvaluationLockLease,
  options: undefined as CloudflareCampaignPortsOptions | undefined, attempts: 0, inDatabase: false,
  databaseFailure: undefined as unknown, order: [] as string[], pool: vi.fn(), lock: vi.fn(), assertLock: vi.fn(),
  claim: vi.fn(), save: vi.fn(), carry: vi.fn(), source: vi.fn(), database: vi.fn(), databaseUrl: vi.fn(),
  ports: vi.fn(), credential: vi.fn(), execute: vi.fn(), capture: vi.fn(), immutable: vi.fn(), atomic: vi.fn(),
  review: vi.fn(), delay: vi.fn() }));
vi.mock('pg', () => ({ Pool: m.pool }));
vi.mock('node:timers/promises', () => ({ setTimeout: m.delay }));
vi.mock('../../evals/cloudflare-source', () => ({ readCloudflareSourceManifest: m.source }));
vi.mock('../../evals/cloudflare-carry-forward', () => ({ CARRY_SCHEMA: () => 'first_mock' }));
vi.mock('../../evals/cloudflare-carry-forward-2', () => ({ SECOND_CARRY_SCHEMA: () => 'second_mock' }));
vi.mock('../../evals/cloudflare-quality-carry', () => ({ QUALITY_CARRY_SCHEMA: () => 'quality_mock' }));
vi.mock('../../evals/cloudflare-revision-carry', () => ({ REVISION_CARRY_SCHEMA: () => 'revision_mock' }));
vi.mock('../../evals/cloudflare-recovery-carry', () => ({ RECOVERY_CARRY_SCHEMA: () => 'recovery_mock', readCloudflareRecoveryCarry: m.carry }));
vi.mock('../../evals/cloudflare-grounded-carry', () => ({ GROUNDED_CARRY_SCHEMA: () => 'grounded_mock' }));
vi.mock('../../evals/cloudflare-nonthinking-carry', () => ({ NONTHINKING_CARRY_SCHEMA: () => 'nonthinking_mock', readCloudflareNonthinkingCarry: m.carry }));
vi.mock('../../evals/cloudflare-campaign-claim', () => ({ claimCloudflareCampaign: m.claim }));
vi.mock('../../evals/live-evaluation-lock', () => ({ withEvaluationLock: m.lock, assertEvaluationLock: m.assertLock }));
vi.mock('../support/database', () => ({ testDatabaseUrl: m.databaseUrl }));
vi.mock('../../evals/python-evaluation', () => ({ withPythonEvaluation: m.database }));
vi.mock('../../src/server/local-credential', () => ({ loadLocalCredential: m.credential }));
vi.mock('../../evals/cloudflare-recovery-review-wait', () => ({ awaitCloudflareRecoveryReview: m.review }));
vi.mock('../../evals/checkpoint', () => ({ writeImmutableCheckpoint: m.immutable, writeAtomicCheckpoint: m.atomic }));
import { GROUNDED_AUTHORIZATION, runCloudflareGroundedEntry } from '../../evals/cloudflare-grounded-entry';
import { DIAGNOSTIC_AUTHORIZATION, runCloudflareDiagnosticEntry } from '../../evals/cloudflare-diagnostic-entry';

describe.each([
  { kind: 'grounded', authorizationEnv: 'DIVE_TRIP_CLOUDFLARE_GROUNDED_AUTHORIZATION', authorization: GROUNDED_AUTHORIZATION,
    run: runCloudflareGroundedEntry, prior: groundedPrior, additionalSchemas: [] as string[] },
  { kind: 'diagnostic', authorizationEnv: 'DIVE_TRIP_CLOUDFLARE_DIAGNOSTIC_AUTHORIZATION', authorization: DIAGNOSTIC_AUTHORIZATION,
    run: runCloudflareDiagnosticEntry, prior: diagnosticPrior, additionalSchemas: ['grounded_mock', 'nonthinking_mock'] },
])('$kind two-included-case lifecycle', current => {
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const source = { sha256: hash('synthetic grounded source'), files: [{ path: 'evals/cases.json', sha256: hash('synthetic cases') }] };
beforeEach(() => {
  vi.resetAllMocks(); m.pools.length = 0; m.order.length = 0; m.attempts = 0; m.inDatabase = false;
  m.databaseFailure = undefined; m.options = undefined;
  vi.stubEnv(current.authorizationEnv, current.authorization);
  vi.stubEnv('DIVE_TRIP_CLOUDFLARE_ACCOUNT_ID', recoveryAccount);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('NETWORK_FORBIDDEN'); }));
  m.lock.mockImplementation(async work => work(m.lease));
  m.claim.mockImplementation(async (lease, scope) => {
    expect(lease).toBe(m.lease); expect(scope).toBe(current.kind); m.order.push('claim'); return m.save;
  });
  m.pool.mockImplementation(function () {
    const pool = { end: vi.fn(async () => {}) }; m.pools.push(pool); return pool;
  });
  m.databaseUrl.mockReturnValue('postgresql://postgres@127.0.0.1:15432/dive_trip_test');
  m.carry.mockImplementation(async (...args) => {
    expect(args).toEqual([...m.pools, m.lease]); m.order.push('carry'); return current.prior();
  });
  m.source.mockImplementation(async () => structuredClone(source));
  m.database.mockImplementation(async (options, work) => {
    expect(options.databasePort).toBe(15432); m.inDatabase = true;
    try { await work(m.ports(options)); } catch (error) { m.databaseFailure = error; throw error; }
    finally { m.inDatabase = false; }
  });
  m.ports.mockImplementation(options => {
    expect(m.inDatabase).toBe(true); m.options = options;
    return { execute: m.execute, capture: m.capture };
  });
  m.execute.mockImplementation(async (caseId, beforeDispatch) => {
    const attempt = ++m.attempts;
    const proposal = cases.find(c => c.id === caseId)!.terminal === 'proposal';
    await beforeDispatch(new AbortController().signal);
    await m.options!.loadCredential();
    if (proposal) await beforeDispatch(new AbortController().signal);
    const runId = `11111111-1111-4111-8111-${String(attempt).padStart(12, '0')}`;
    return recoveryResult(caseId, attempt, { runId, usageRunId: runId, decisionRunId: proposal ? runId : null });
  });
  m.credential.mockImplementation(async () => { m.order.push('loader'); return 'synthetic-unit-only'; });
  m.capture.mockImplementation(async () => ({ chargedMicros: m.attempts * 100, modelCalls: m.attempts * 2,
    totalTokens: m.attempts * 1000, privateUsageComplete: true, usageKnown: true, record: { synthetic: true } }));
  m.immutable.mockImplementation(async path => { m.order.push(path); });
  m.review.mockImplementation(async (serialized, identities, lease, record, kind) => {
    expect(lease).toBe(m.lease); expect(kind).toBe(current.kind); expect(m.attempts).toBe(2);
    expect(identities.map((r: { caseId: string }) => r.caseId)).toEqual(['unknown-cost', 'no-date']);
    const sourceSha256 = hash(serialized);
    await record({ sourceSha256, cases: identities.map((row: object) => ({ ...row, sourceSha256,
      textReview: 'passed', reviewers: ['primary', 'independent'], findings: [] })) }, true);
    m.order.push('review-passed'); return true;
  });
});
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

test.each([undefined, '', 'two-included-preflights-plus-28-once-cloudflare-free-tier-confirmed',
  'non-diver-preflight-plus-30-once-cloudflare-free-tier-confirmed',
  ...(current.kind === 'diagnostic' ? [GROUNDED_AUTHORIZATION, 'nonthinking-unknown-cost-once-7-calls-1-start-cloudflare-free-tier-confirmed'] : [])])('old or missing grant %s fails before any IO', async grant => {
  vi.stubEnv(current.authorizationEnv, grant);
  vi.stubEnv('DIVE_TRIP_CLOUDFLARE_RECOVERY_AUTHORIZATION', 'two-included-preflights-plus-28-once-cloudflare-free-tier-confirmed');
  await expect(current.run()).rejects.toThrow('EVAL_AUTHORIZATION_REQUIRED');
  for (const fn of [m.lock,m.claim,m.pool,m.carry,m.ports,m.credential,m.database,m.source]) expect(fn).not.toHaveBeenCalled();
});

test('real finite scheduler, new scope and receipt barrier run 30 slots with 39 HTTP dispatches', async () => {
  await current.run();
  expect(m.claim).toHaveBeenCalledExactlyOnceWith(m.lease, current.kind);
  expect(m.pool.mock.calls.map(([options]) => options.options)).toEqual(['workbench_live','first_mock','second_mock',
    'quality_mock','revision_mock','recovery_mock', ...current.additionalSchemas].map(s => `-c search_path=${s}`));
  for (const [options] of m.pool.mock.calls) expect(options).not.toHaveProperty('connectionString');
  expect(m.options).toMatchObject({ accountId: recoveryAccount, priorChargedMicros: current.prior().chargedMicros,
    liveCampaign: `cloudflare-${current.kind}-30-cases` });
  expect(m.execute).toHaveBeenCalledTimes(30); expect(m.credential).toHaveBeenCalledTimes(30);
  expect(m.carry).toHaveBeenCalledTimes(41); expect(m.source).toHaveBeenCalledTimes(41);
  expect(m.pools.every(pool => pool.end.mock.calls.length === 1)).toBe(true);
  const [file, serialized] = m.immutable.mock.calls[0];
  const [receiptFile, receiptBytes] = m.immutable.mock.calls[1];
  expect(file).toBe(`.artifacts/cloudflare-${current.kind}-preflight.json`);
  expect(receiptFile).toBe(`.artifacts/cloudflare-${current.kind}-preflight-receipt.json`);
  const checkpoint = JSON.parse(serialized), receipt = JSON.parse(receiptBytes);
  expect(checkpoint).toMatchObject({ schemaVersion: 2, invocations: 2, sourceManifest: source, prior: current.prior() });
  expect(receipt).toMatchObject({ passed: true, sourceSha256: hash(serialized), sourceFile: `cloudflare-${current.kind}-preflight.json` });
  expect(m.save.mock.calls.at(-1)![0]).toMatchObject({ stopped: null, invocations: 39, cumulativeInvocations: current.prior().invocations + 39,
    maxModelCalls: 210, maxInvocations: 39, evaluationGatePassed: false, textReview: 'pending',
    preflightReviewReceipt: { file: `cloudflare-${current.kind}-preflight-receipt.json`, sha256: hash(receiptBytes) } });
  expect(m.order.indexOf(receiptFile)).toBeLessThan(m.order.indexOf('review-passed'));
});

test('negative dual review retains the isolated DB and skips all later requests', async () => {
  m.review.mockResolvedValue(false);
  await expect(current.run()).rejects.toThrow('EVAL_CLOUDFLARE_CAMPAIGN_STOPPED');
  expect(m.execute).toHaveBeenCalledTimes(2); expect(m.credential).toHaveBeenCalledTimes(2);
  expect(m.databaseFailure).toBeInstanceOf(Error);
  expect(m.save.mock.calls.at(-1)![0]).toMatchObject({ stopped: 'PREFLIGHT_TEXT_REVIEW_STOP', invocations: 2 });
  expect(m.save.mock.calls.at(-1)![0].records.filter((r: { outcome?: string }) => r.outcome === 'skipped')).toHaveLength(28);
});

test.each(['history','source','lease'])('changed %s blocks before the first loader', async kind => {
  if (kind === 'history') m.carry.mockResolvedValueOnce(current.prior()).mockResolvedValue({ ...current.prior(), observedTokens: 1 });
  if (kind === 'source') m.source.mockResolvedValueOnce(source).mockResolvedValue({ ...source, sha256: '0'.repeat(64) });
  if (kind === 'lease') m.assertLock.mockRejectedValue(new Error('EVAL_LOCK_NOT_OWNED'));
  await expect(current.run()).rejects.toThrow();
  expect(m.credential).not.toHaveBeenCalled(); expect(m.review).not.toHaveBeenCalled();
  expect(m.pools.every(pool => pool.end.mock.calls.length === 1)).toBe(true);
});
});
