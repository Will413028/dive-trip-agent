vi.mock('../../evals/cloudflare-history-profile', async original => ({
  ...await original<typeof import('../../evals/cloudflare-history-profile')>(),
  withPrivateCloudflareHistory: async (work: () => Promise<unknown>) => work(),
  assertPrivateCloudflareHistory: async () => {},
}));
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { RevisionCampaignReport } from '../../evals/cloudflare-revision-campaign';
import type { CloudflareCampaignPortsOptions } from '../support/cloudflare-campaign-ports';
import type { EvaluationLockLease } from '../../evals/live-evaluation-lock';

type SchedulerPorts = Parameters<typeof import('../../evals/cloudflare-revision-campaign').runCloudflareRevisionCampaign>[0];
type ReviewWait = typeof import('../../evals/cloudflare-preflight-review').awaitCloudflarePreflightReview;
type SourceManifest = { sha256: string; files: { path: string; sha256: string }[] };

const m = vi.hoisted(() => ({
  order: [] as string[], pools: [] as { end: ReturnType<typeof vi.fn> }[],
  inDatabase: false, databaseFailure: undefined as unknown,
  options: undefined as CloudflareCampaignPortsOptions | undefined,
  lease: {} as EvaluationLockLease,
  pool: vi.fn(), carry: vi.fn(), claim: vi.fn(), save: vi.fn(), lock: vi.fn(), assertLock: vi.fn(),
  database: vi.fn(), databaseUrl: vi.fn(), ports: vi.fn(), credential: vi.fn(),
  review: vi.fn<ReviewWait>(), pinnedReview: vi.fn(), immutable: vi.fn(), atomic: vi.fn(),
  sourceManifest: vi.fn<() => Promise<SourceManifest>>(),
  scheduler: vi.fn<(ports: SchedulerPorts) => Promise<RevisionCampaignReport>>(),
  execute: vi.fn(), capture: vi.fn(), delay: vi.fn(),
}));

// Complete module replacements: importing the entry must not load real IO adapters.
vi.mock('pg', () => ({ Pool: m.pool }));
vi.mock('../../evals/cloudflare-source', () => ({ readCloudflareSourceManifest: m.sourceManifest }));
vi.mock('node:timers/promises', () => ({ setTimeout: m.delay }));
vi.mock('../../evals/cloudflare-quality-carry', () => ({ readCloudflareQualityCarry: m.carry, QUALITY_CARRY_SCHEMA: () => 'quality_mock' }));
vi.mock('../../evals/cloudflare-carry-forward', () => ({ CARRY_SCHEMA: () => 'first_mock' }));
vi.mock('../../evals/cloudflare-carry-forward-2', () => ({ SECOND_CARRY_SCHEMA: () => 'second_mock' }));
vi.mock('../../evals/cloudflare-revision-claim', () => ({ claimCloudflareRevisionCampaign: m.claim }));
vi.mock('../../evals/live-evaluation-lock', () => ({ withEvaluationLock: m.lock, assertEvaluationLock: m.assertLock }));
vi.mock('../support/database', () => ({ withDatabase: m.database, testDatabaseUrl: m.databaseUrl }));
vi.mock('../support/cloudflare-campaign-ports', () => ({ createCloudflareCampaignPorts: m.ports }));
vi.mock('../../src/server/local-credential', () => ({ loadLocalCredential: m.credential }));
vi.mock('../../evals/cloudflare-preflight-review', () => ({ awaitCloudflarePreflightReview: m.review }));
vi.mock('../../evals/pinned-cloudflare-report', () => ({ readCloudflarePreflightReview: m.pinnedReview }));
vi.mock('../../evals/checkpoint', () => ({ writeAtomicCheckpoint: m.atomic, writeImmutableCheckpoint: m.immutable }));
vi.mock('../../evals/cloudflare-revision-campaign', () => ({ runCloudflareRevisionCampaign: m.scheduler }));

import { REVISION_AUTHORIZATION, runCloudflareRevisionEntry } from '../../evals/cloudflare-revision-entry';

const accountId = '1fd574e905257afa3cfd7db80cf70b23';
const runId = '30110afd-0f5b-4d53-8c71-6742d1e2ea9d';
const prior = { sourceSha256: 'a'.repeat(64), historyConsistent: true, dispatchAuthorized: false,
  accountingComplete: false, evaluationGatePassed: false, historicalUnknownReceipts: 1,
  invocations: 26, modelCalls: 38, chargedMicros: 204816, observedTokens: 183791, totalTokens: null,
  remainingInvocationCeiling: 74, remainingReferenceMicros: 2795184 };
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
// Synthetic helper output; root discovery and hashing are tested by the helper suite.
const sourceManifest: SourceManifest = { sha256: hash('synthetic source manifest'),
  files: [{ path: 'src/agent/confirmation.ts', sha256: hash('synthetic confirmation') },
    { path: 'package.json', sha256: hash('synthetic package') }] };
// Intentionally minimal wiring fixture: mechanical evidence belongs to scheduler tests.
const report = (stopped: string | null = null) => ({ prior, stopped,
  records: [{ evidence: { runId } }], textReview: 'pending', evaluationGatePassed: false,
} as unknown as RevisionCampaignReport);

beforeEach(() => {
  vi.resetAllMocks();
  m.order.length = 0; m.pools.length = 0;
  m.inDatabase = false; m.databaseFailure = undefined; m.options = undefined;
  vi.stubEnv('DIVE_TRIP_CLOUDFLARE_REVISION_AUTHORIZATION', REVISION_AUTHORIZATION);
  vi.stubEnv('DIVE_TRIP_CLOUDFLARE_ACCOUNT_ID', accountId);
  vi.stubEnv('DIVE_TRIP_CLOUDFLARE_QUALITY_AUTHORIZATION', 'budget-preflight-plus-30-once-cloudflare-free-tier-confirmed');
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('NETWORK_FORBIDDEN'); }));
  m.lock.mockImplementation(async (work: (lease: EvaluationLockLease) => Promise<void>) => {
    m.order.push('lock');
    try { return await work(m.lease); } finally { m.order.push('unlock'); }
  });
  m.claim.mockImplementation(async (lease: EvaluationLockLease) => {
    expect(lease).toBe(m.lease); m.order.push('claim'); return m.save;
  });
  m.save.mockImplementation(async () => { expect(m.inDatabase).toBe(true); m.order.push('save'); });
  m.databaseUrl.mockReturnValue('postgresql://postgres@127.0.0.1:15432/dive_trip_test');
  m.pool.mockImplementation(function () {
    m.order.push('pool');
    const pool = { end: vi.fn(async () => { expect(m.inDatabase).toBe(false); m.order.push('end'); }) };
    m.pools.push(pool); return pool;
  });
  m.carry.mockImplementation(async (...args: unknown[]) => {
    expect(args).toEqual([...m.pools, m.lease]);
    m.order.push(m.inDatabase ? 'history:inside' : 'history:prior');
    return structuredClone(prior);
  });
  m.sourceManifest.mockImplementation(async () => structuredClone(sourceManifest));
  m.assertLock.mockImplementation(async (lease: EvaluationLockLease) => {
    expect(lease).toBe(m.lease); m.order.push('lease');
  });
  m.database.mockImplementation(async (work: () => Promise<void>, options: { retainOnFailure?: boolean }) => {
    expect(options).toEqual({ retainOnFailure: true });
    m.inDatabase = true; m.order.push('db:enter');
    try { await work(); }
    catch (error) { expect(m.inDatabase).toBe(true); m.databaseFailure = error; throw error; }
    finally { m.inDatabase = false; m.order.push('db:exit'); }
  });
  m.ports.mockImplementation((options: CloudflareCampaignPortsOptions) => {
    expect(m.inDatabase).toBe(true); expect(m.credential).not.toHaveBeenCalled();
    m.options = options; m.order.push('ports');
    return { execute: m.execute, capture: m.capture };
  });
  m.execute.mockImplementation(async (caseId: string, beforeDispatch: (signal: AbortSignal) => Promise<void>) => {
    expect(m.inDatabase).toBe(true); m.order.push(`execute:${caseId}`);
    await beforeDispatch(new AbortController().signal);
    await m.options!.loadCredential();
    return { runId };
  });
  m.credential.mockImplementation(async () => {
    expect(m.inDatabase).toBe(true); m.order.push('loader'); return 'synthetic-unit-only';
  });
  m.capture.mockResolvedValue({ privateUsageComplete: true });
  m.immutable.mockImplementation(async (file: string) => {
    expect(m.inDatabase).toBe(true); m.order.push(`write:${file}`);
  });
  m.review.mockImplementation(async (source, id, lease, record, kind) => {
    expect(m.inDatabase).toBe(true); expect(lease).toBe(m.lease); expect(kind).toBe('revision');
    m.order.push('review');
    await record({ sourceSha256: hash(source), runId: id, textReview: 'passed',
      reviewers: ['primary', 'independent'], findings: [] }, true);
    return true;
  });
  m.scheduler.mockImplementation(drivePreflight);
});

afterEach(() => {
  try { expect(fetch).not.toHaveBeenCalled(); }
  finally { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); }
});

// Callback-driven wiring unit, NOT a 31-case scheduler/quality acceptance test.
// A single batch marker proves the adapter returns permission only after receipt IO.
async function drivePreflight(ports: SchedulerPorts) {
  expect(ports.prior).toEqual(prior); expect(ports.accountId).toBe(accountId);
  m.order.push('scheduler');
  await ports.checkpoint(report());
  await ports.execute('non-diver', ports.checkDispatch);
  await ports.capture();
  let passed = false;
  try { passed = await ports.reviewPreflight(report()); }
  catch { m.order.push('review:failed'); }
  const result = report(passed ? null : 'PREFLIGHT_TEXT_REVIEW_STOP');
  await ports.checkpoint(result);
  if (passed) m.order.push('batch:30-marker');
  return result;
}

function expectPoolsClosed() {
  expect(m.pool).toHaveBeenCalledTimes(4);
  for (const pool of m.pools) expect(pool.end).toHaveBeenCalledTimes(1);
  expect(m.order.slice(-5)).toEqual(['end', 'end', 'end', 'end', 'unlock']);
}

describe('Cloudflare revision entry — fully mocked wiring unit', () => {
  test.each([undefined, '', 'first-30-cases-cloudflare-free-tier-confirmed'])('rejects authorization %s before any IO; old quality flag is insufficient', async authorization => {
    vi.stubEnv('DIVE_TRIP_CLOUDFLARE_REVISION_AUTHORIZATION', authorization);
    await expect(runCloudflareRevisionEntry()).rejects.toThrow('EVAL_AUTHORIZATION_REQUIRED');
    expectNoIo();
  });

  test('rejects another valid account before any IO', async () => {
    vi.stubEnv('DIVE_TRIP_CLOUDFLARE_ACCOUNT_ID', 'b'.repeat(32));
    await expect(runCloudflareRevisionEntry()).rejects.toThrow('EVAL_INVALID_HISTORY');
    expectNoIo();
  });

  test('prepares once, binds latest prior and dispatch lease, lazily loads, persists bound revision review, then audits inside DB lifetime', async () => {
    await runCloudflareRevisionEntry();
    for (const mock of [m.lock, m.claim, m.databaseUrl, m.database, m.ports, m.scheduler, m.execute, m.capture, m.credential, m.review]) {
      expect(mock).toHaveBeenCalledTimes(1);
    }
    expect(m.carry).toHaveBeenCalledTimes(3);
    expect(m.pool.mock.calls.map(([options]) => options.options)).toEqual([
      '-c search_path=workbench_live', '-c search_path=first_mock',
      '-c search_path=second_mock', '-c search_path=quality_mock',
    ]);
    for (const [options] of m.pool.mock.calls) {
      expect(options).not.toHaveProperty('connectionString');
      expect(options).toMatchObject({ host: '127.0.0.1', port: 15432, database: 'dive_trip_test',
        user: 'postgres', password: 'offline-placeholder-not-a-credential', ssl: false, max: 1 });
    }
    expect(m.ports).toHaveBeenCalledWith(expect.objectContaining({ accountId, priorChargedMicros: prior.chargedMicros }));
    expect(m.credential).toHaveBeenCalledWith('cloudflare');
    expect(m.order).toEqual([
      'lock', 'claim', 'pool', 'pool', 'pool', 'pool', 'history:prior', 'db:enter', 'ports', 'scheduler',
      'save', 'execute:non-diver', 'history:inside', 'lease', 'lease', 'loader', 'lease',
      'write:.artifacts/cloudflare-revision-preflight.json', 'review', 'lease',
      'write:.artifacts/cloudflare-revision-preflight-receipt.json', 'save', 'batch:30-marker',
      'history:inside', 'lease', 'db:exit', 'end', 'end', 'end', 'end', 'unlock',
    ]);
    const [sourceFile, source] = m.immutable.mock.calls[0] as [string, string];
    const [receiptFile, receiptBytes] = m.immutable.mock.calls[1] as [string, string];
    expect(sourceFile).toBe('.artifacts/cloudflare-revision-preflight.json');
    expect(m.review).toHaveBeenCalledWith(source, runId, m.lease, expect.any(Function), 'revision');
    expect(JSON.parse(receiptBytes)).toMatchObject({ sourceFile: 'cloudflare-revision-preflight.json',
      sourceSha256: hash(source), runId, passed: true, review: { sourceSha256: hash(source), runId } });
    expect(receiptFile).toBe('.artifacts/cloudflare-revision-preflight-receipt.json');
    expect(m.save.mock.calls.at(-1)![0]).toMatchObject({ preflightReviewReceipt: {
      file: 'cloudflare-revision-preflight-receipt.json', sha256: hash(receiptBytes),
    } });
    expect(m.atomic).not.toHaveBeenCalled(); expect(m.pinnedReview).not.toHaveBeenCalled();
    expectPoolsClosed();
  });

  test('persists the helper manifest and its hash in every checkpoint and immutable preflight', async () => {
    await runCloudflareRevisionEntry();
    expect(m.sourceManifest.mock.calls).toEqual([[], [], []]);
    expect(m.save).toHaveBeenCalledTimes(2);
    for (const [saved] of m.save.mock.calls) {
      expect(saved.sourceFingerprint).toBe(sourceManifest.sha256);
      expect(saved.sourceManifest).toEqual(sourceManifest);
    }
    const preflight = JSON.parse(m.immutable.mock.calls[0][1]);
    expect(preflight.sourceFingerprint).toBe(sourceManifest.sha256);
    expect(preflight.sourceManifest).toEqual(sourceManifest);
  });

  test.each(['history', 'source', 'lease'])('%s change at dispatch rejects before lazy loader', async kind => {
    if (kind === 'history') m.carry.mockResolvedValueOnce(structuredClone(prior)).mockResolvedValue({ ...prior, observedTokens: 1 });
    if (kind === 'source') {
      // Same aggregate hash deliberately proves files are compared as well.
      m.sourceManifest.mockResolvedValueOnce(structuredClone(sourceManifest))
        .mockResolvedValue({ ...structuredClone(sourceManifest),
          files: [{ path: 'src/agent/confirmation.ts', sha256: hash('changed synthetic source') }] });
    }
    if (kind === 'lease') m.assertLock.mockRejectedValue(new Error('EVAL_LOCK_NOT_OWNED'));
    await expect(runCloudflareRevisionEntry()).rejects.toThrow(kind === 'history' ? 'EVAL_HISTORY_CHANGED'
      : kind === 'source' ? 'EVAL_SOURCE_CHANGED' : 'EVAL_LOCK_NOT_OWNED');
    expect(m.credential).not.toHaveBeenCalled(); expect(m.review).not.toHaveBeenCalled();
    expect(m.order).not.toContain('batch:30-marker'); expectPoolsClosed();
  });

  test.each(['negative', 'receipt-write'])('%s review stops without batch and throws inside retained DB lifetime', async kind => {
    if (kind === 'negative') m.review.mockImplementation(async (source, id, _lease, record) => {
      await record({ sourceSha256: hash(source), runId: id, textReview: 'failed',
        reviewers: ['primary', 'independent'], findings: ['synthetic refusal'] }, false);
      return false;
    });
    else m.immutable.mockImplementation(async (file: string) => {
      if (file.endsWith('-receipt.json')) throw new Error('SYNTHETIC_RECEIPT_WRITE_FAILURE');
    });
    await expect(runCloudflareRevisionEntry()).rejects.toThrow('EVAL_CLOUDFLARE_CAMPAIGN_STOPPED');
    expect(m.databaseFailure).toEqual(new Error('EVAL_CLOUDFLARE_CAMPAIGN_STOPPED'));
    expect(m.order).not.toContain('batch:30-marker');
    expect(m.execute).toHaveBeenCalledTimes(1);
    expect(m.carry).toHaveBeenCalledTimes(3);
    const saved = m.save.mock.calls.at(-1)![0];
    expect(saved.stopped).toBe('PREFLIGHT_TEXT_REVIEW_STOP');
    if (kind === 'negative') expect(JSON.parse(m.immutable.mock.calls[1][1])).toMatchObject({ passed: false });
    else expect(saved.preflightReviewReceipt).toBeUndefined();
    expectPoolsClosed();
  });

  test.each(['history', 'source'])('final %s failure checkpoints stop and throws before DB lifetime ends', async kind => {
    if (kind === 'history') m.carry.mockResolvedValueOnce(structuredClone(prior)).mockResolvedValueOnce(structuredClone(prior))
      .mockImplementationOnce(async () => {
        expect(m.inDatabase).toBe(true); return { ...prior, observedTokens: 1 };
      });
    else {
      m.sourceManifest.mockResolvedValueOnce(structuredClone(sourceManifest))
        .mockResolvedValueOnce(structuredClone(sourceManifest))
        .mockImplementationOnce(async () => {
          expect(m.inDatabase).toBe(true);
          return { ...structuredClone(sourceManifest), sha256: hash('source changed after review') };
        });
    }
    await expect(runCloudflareRevisionEntry()).rejects.toThrow('EVAL_HISTORY_CHANGED');
    expect(m.save.mock.calls.at(-1)![0]).toMatchObject({ stopped: 'HISTORY_OR_SOURCE_CHANGED_STOP',
      sourceFingerprint: sourceManifest.sha256, sourceManifest });
    expect(m.databaseFailure).toEqual(new Error('EVAL_HISTORY_CHANGED'));
    expectPoolsClosed();
  });

  test('prior failure closes all four pools without entering DB or loading credential', async () => {
    m.carry.mockRejectedValue(new Error('SYNTHETIC_INVALID_PRIOR'));
    await expect(runCloudflareRevisionEntry()).rejects.toThrow('SYNTHETIC_INVALID_PRIOR');
    expect(m.database).not.toHaveBeenCalled(); expect(m.credential).not.toHaveBeenCalled();
    expectPoolsClosed();
  });
});

function expectNoIo() {
  expect(m.order).toEqual([]);
  for (const mock of [m.lock, m.claim, m.pool, m.carry, m.databaseUrl, m.database, m.ports, m.scheduler,
    m.credential, m.assertLock, m.review, m.pinnedReview, m.immutable, m.atomic, m.sourceManifest, m.save, m.delay]) {
    expect(mock).not.toHaveBeenCalled();
  }
  expect(fetch).not.toHaveBeenCalled();
}
