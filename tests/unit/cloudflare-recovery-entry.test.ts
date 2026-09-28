vi.mock('../../evals/cloudflare-history-profile', async original => ({
  ...await original<typeof import('../../evals/cloudflare-history-profile')>(),
  withPrivateCloudflareHistory: async (work: () => Promise<unknown>) => work(),
  assertPrivateCloudflareHistory: async () => {},
}));
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { RecoveryCampaignReport } from '../../evals/cloudflare-recovery-campaign';
import type { EvaluationLockLease } from '../../evals/live-evaluation-lock';
import type { ReplayBundle } from '../../evals/replay-bundle';
import type { PythonEvaluationOptions as CloudflareCampaignPortsOptions } from '../../evals/python-evaluation';
import cases from '../../evals/cases.json';
import { evaluationInput } from '../../evals/fixtures';
import { recoveryPrior, recoveryResult } from '../support/cloudflare-recovery-fixture';
import { recoveryReviewSchema } from '../../evals/cloudflare-recovery-review';

type SchedulerPorts = Parameters<typeof import('../../evals/cloudflare-recovery-campaign').runCloudflareRecoveryCampaign>[0];
type ReviewWait = typeof import('../../evals/cloudflare-recovery-review-wait').awaitCloudflareRecoveryReview;
type SourceManifest = { sha256: string; files: { path: string; sha256: string }[] };
const m = vi.hoisted(() => ({
  order: [] as string[], pools: [] as { end: ReturnType<typeof vi.fn> }[],
  inDatabase: false, databaseFailure: undefined as unknown,
  options: undefined as CloudflareCampaignPortsOptions | undefined, lease: {} as EvaluationLockLease,
  pool: vi.fn(), carry: vi.fn(), claim: vi.fn(), save: vi.fn(), lock: vi.fn(), assertLock: vi.fn(),
  database: vi.fn(), databaseUrl: vi.fn(), ports: vi.fn(), credential: vi.fn(),
  review: vi.fn<ReviewWait>(), immutable: vi.fn(), atomic: vi.fn(),
  sourceManifest: vi.fn<() => Promise<SourceManifest>>(),
  scheduler: vi.fn<(ports: SchedulerPorts) => Promise<RecoveryCampaignReport>>(),
  execute: vi.fn(), capture: vi.fn(), delay: vi.fn(),
}));

// Replace every IO adapter; the shared entry helper itself stays real.
vi.mock('pg', () => ({ Pool: m.pool }));
vi.mock('node:timers/promises', () => ({ setTimeout: m.delay }));
vi.mock('../../evals/cloudflare-source', () => ({ readCloudflareSourceManifest: m.sourceManifest }));
vi.mock('../../evals/cloudflare-carry-forward', () => ({ CARRY_SCHEMA: () => 'first_mock' }));
vi.mock('../../evals/cloudflare-carry-forward-2', () => ({ SECOND_CARRY_SCHEMA: () => 'second_mock' }));
vi.mock('../../evals/cloudflare-quality-carry', () => ({ QUALITY_CARRY_SCHEMA: () => 'quality_mock' }));
vi.mock('../../evals/cloudflare-revision-carry', () => ({ readCloudflareRevisionCarry: m.carry, REVISION_CARRY_SCHEMA: () => 'revision_mock' }));
vi.mock('../../evals/cloudflare-recovery-claim', () => ({ claimCloudflareRecoveryCampaign: m.claim }));
vi.mock('../../evals/live-evaluation-lock', () => ({ withEvaluationLock: m.lock, assertEvaluationLock: m.assertLock }));
vi.mock('../support/database', () => ({ testDatabaseUrl: m.databaseUrl }));
vi.mock('../../evals/python-evaluation', () => ({ withPythonEvaluation: m.database }));
vi.mock('../../src/server/local-credential', () => ({ loadLocalCredential: m.credential }));
vi.mock('../../evals/cloudflare-recovery-review-wait', () => ({ awaitCloudflareRecoveryReview: m.review }));
vi.mock('../../evals/checkpoint', () => ({ writeAtomicCheckpoint: m.atomic, writeImmutableCheckpoint: m.immutable }));
vi.mock('../../evals/cloudflare-recovery-campaign', () => ({ runCloudflareRecoveryCampaign: m.scheduler }));

import { RECOVERY_AUTHORIZATION, runCloudflareRecoveryEntry } from '../../evals/cloudflare-recovery-entry';

const accountId = '1fd574e905257afa3cfd7db80cf70b23';
const runIds = ['30110afd-0f5b-4d53-8c71-6742d1e2ea9d', '4039b404-2e2f-4615-9fa9-2d24931edf36'];
const identities = [
  { round: 1, caseId: 'unknown-cost', runId: runIds[0] },
  { round: 1, caseId: 'no-date', runId: runIds[1] },
];
const prior = { sourceSha256: 'a'.repeat(64), historyConsistent: true, dispatchAuthorized: false,
  accountingComplete: false, evaluationGatePassed: false, historicalUnknownReceipts: 2,
  invocations: 39, modelCalls: 56, chargedMicros: 396708, observedTokens: 259078, totalTokens: null,
  remainingInvocationCeiling: 61, remainingReferenceMicros: 2603292 };
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const sourceManifest: SourceManifest = { sha256: hash('synthetic recovery source'),
  files: [{ path: 'src/agent/confirmation.ts', sha256: hash('synthetic confirmation') }] };
// Deliberately minimal callback fixtures, NOT mechanical or model quality evidence.
const report = (stopped: string | null = null, records: unknown[] = identities.flatMap(identity => [
  { round: identity.round, caseId: identity.caseId, evidence: { caseId: identity.caseId, runId: identity.runId } },
  { kind: 'durable-audit', round: identity.round, caseId: identity.caseId },
])) => ({ prior, stopped, records, textReview: 'pending', evaluationGatePassed: false,
  accountingComplete: false, historicalUnknownReceipts: 2, dispatchAuthorized: false,
} as unknown as RecoveryCampaignReport);

beforeEach(() => {
  vi.resetAllMocks();
  m.order.length = 0; m.pools.length = 0;
  m.inDatabase = false; m.databaseFailure = undefined; m.options = undefined;
  vi.stubEnv('DIVE_TRIP_CLOUDFLARE_RECOVERY_AUTHORIZATION', RECOVERY_AUTHORIZATION);
  vi.stubEnv('DIVE_TRIP_CLOUDFLARE_ACCOUNT_ID', accountId);
  vi.stubEnv('DIVE_TRIP_CLOUDFLARE_REVISION_AUTHORIZATION', 'non-diver-preflight-plus-30-once-cloudflare-free-tier-confirmed');
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
    m.order.push(m.inDatabase ? 'history:inside' : 'history:prior'); return structuredClone(prior);
  });
  m.sourceManifest.mockImplementation(async () => { m.order.push('source'); return structuredClone(sourceManifest); });
  m.assertLock.mockImplementation(async (lease: EvaluationLockLease) => {
    expect(lease).toBe(m.lease); m.order.push('lease');
  });
  m.database.mockImplementation(async (options: CloudflareCampaignPortsOptions, work: (ports: ReturnType<typeof m.ports>) => Promise<void>) => {
    expect(options.databasePort).toBe(15432);
    m.inDatabase = true; m.order.push('db:enter');
    try { await work(m.ports(options)); }
    catch (error) { m.databaseFailure = error; throw error; }
    finally { m.inDatabase = false; m.order.push('db:exit'); }
  });
  m.ports.mockImplementation((options: CloudflareCampaignPortsOptions) => {
    expect(m.inDatabase).toBe(true); expect(m.credential).not.toHaveBeenCalled();
    m.options = options; m.order.push('ports'); return { execute: m.execute, capture: m.capture };
  });
  m.execute.mockImplementation(async (caseId: string, gate: (signal: AbortSignal) => Promise<void>) => {
    expect(m.inDatabase).toBe(true); m.order.push(`execute:${caseId}`);
    await gate(new AbortController().signal);
    await m.options!.loadCredential();
    return { evidence: { runId: runIds[caseId === 'no-date' ? 1 : 0] } };
  });
  m.credential.mockImplementation(async () => {
    expect(m.inDatabase).toBe(true); m.order.push('loader'); return 'synthetic-unit-only';
  });
  m.capture.mockResolvedValue({ privateUsageComplete: true });
  m.immutable.mockImplementation(async (file: string) => {
    expect(m.inDatabase).toBe(true); m.order.push(`write:${file}`);
  });
  m.review.mockImplementation(async (source, cases, lease, record) => {
    expect(m.inDatabase).toBe(true); expect(lease).toBe(m.lease); expect(cases).toEqual(identities);
    m.order.push('review');
    await record(recoveryReviewSchema.parse({ sourceSha256: hash(source), cases: cases.map(identity => ({ ...identity,
      sourceSha256: hash(source), textReview: 'passed', reviewers: ['primary', 'independent'], findings: [],
    })) }), true);
    return true;
  });
  m.scheduler.mockImplementation(drivePreflights);
});

afterEach(() => {
  try { expect(fetch).not.toHaveBeenCalled(); }
  finally { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); }
});

// Model just the callback boundary and the scheduler's receipt checkpoint barrier.
// Actual thirty-slot scheduling and deterministic grades have separate suites.
async function drivePreflights(ports: SchedulerPorts, candidate = report()) {
  expect(ports.prior).toEqual(prior); expect(ports.accountId).toBe(accountId);
  m.order.push('scheduler');
  await ports.checkpoint(report(null, []));
  for (const { caseId } of identities) {
    await ports.execute(caseId, ports.checkDispatch);
    await ports.capture();
  }
  let passed = false;
  try { passed = (await ports.reviewPreflight(candidate)) === true; }
  catch { m.order.push('review:failed'); }
  const result = { ...candidate, stopped: passed ? null : 'PREFLIGHT_TEXT_REVIEW_STOP' };
  await ports.checkpoint(result);
  if (passed) m.order.push('batch:28-marker');
  return result;
}

function expectPoolsClosed() {
  expect(m.pool).toHaveBeenCalledTimes(5);
  for (const pool of m.pools) expect(pool.end).toHaveBeenCalledTimes(1);
  expect(m.order.slice(-6)).toEqual(['end', 'end', 'end', 'end', 'end', 'unlock']);
}
function expectRetained() {
  expect(m.databaseFailure).toBeInstanceOf(Error);
  expect(m.database).toHaveBeenCalledWith(expect.objectContaining({ databasePort: 15432 }), expect.any(Function));
  expectPoolsClosed();
}
function expectNoIo() {
  expect(m.order).toEqual([]);
  for (const mock of [m.lock, m.claim, m.pool, m.carry, m.databaseUrl, m.database, m.ports, m.scheduler,
    m.credential, m.assertLock, m.review, m.immutable, m.atomic, m.sourceManifest, m.save, m.delay]) {
    expect(mock).not.toHaveBeenCalled();
  }
}

describe('Cloudflare recovery entry — fully mocked wiring unit', () => {
  test.each([undefined, '', 'non-diver-preflight-plus-30-once-cloudflare-free-tier-confirmed',
    'budget-preflight-plus-30-once-cloudflare-free-tier-confirmed'])('rejects %s before IO despite old flags', async value => {
    expect(RECOVERY_AUTHORIZATION).toBe('two-included-preflights-plus-28-once-cloudflare-free-tier-confirmed');
    vi.stubEnv('DIVE_TRIP_CLOUDFLARE_RECOVERY_AUTHORIZATION', value);
    await expect(runCloudflareRecoveryEntry()).rejects.toThrow('EVAL_AUTHORIZATION_REQUIRED');
    expectNoIo();
  });

  test('rejects a different valid account before IO', async () => {
    vi.stubEnv('DIVE_TRIP_CLOUDFLARE_ACCOUNT_ID', 'b'.repeat(32));
    await expect(runCloudflareRecoveryEntry()).rejects.toThrow('EVAL_INVALID_HISTORY');
    expectNoIo();
  });

  test('binds five pools, two identities, immutable snapshot and receipt before the later-case marker', async () => {
    await runCloudflareRecoveryEntry();
    for (const mock of [m.lock, m.claim, m.databaseUrl, m.database, m.ports, m.scheduler, m.review]) expect(mock).toHaveBeenCalledTimes(1);
    expect(m.carry).toHaveBeenCalledTimes(4); expect(m.sourceManifest).toHaveBeenCalledTimes(4);
    expect(m.execute.mock.calls.map(([id]) => id)).toEqual(['unknown-cost', 'no-date']);
    expect(m.capture).toHaveBeenCalledTimes(2); expect(m.credential.mock.calls).toEqual([['cloudflare'], ['cloudflare']]);
    expect(m.pool.mock.calls.map(([options]) => options.options)).toEqual([
      '-c search_path=workbench_live', '-c search_path=first_mock', '-c search_path=second_mock',
      '-c search_path=quality_mock', '-c search_path=revision_mock',
    ]);
    for (const [options] of m.pool.mock.calls) {
      expect(options).not.toHaveProperty('connectionString');
      expect(options).toMatchObject({ host: '127.0.0.1', port: 15432, database: 'dive_trip_test',
        user: 'postgres', password: 'offline-placeholder-not-a-credential', ssl: false, max: 1 });
    }
    expect(m.ports).toHaveBeenCalledWith(expect.objectContaining({ accountId, priorChargedMicros: prior.chargedMicros }));
    const [sourceFile, source] = m.immutable.mock.calls[0] as [string, string];
    const [receiptFile, bytes] = m.immutable.mock.calls[1] as [string, string];
    expect(sourceFile).toBe('.artifacts/cloudflare-recovery-preflight.json');
    expect(receiptFile).toBe('.artifacts/cloudflare-recovery-preflight-receipt.json');
    expect(m.review).toHaveBeenCalledWith(source, identities, m.lease, expect.any(Function));
    const receipt = JSON.parse(bytes);
    expect(receipt).toMatchObject({ sourceFile: 'cloudflare-recovery-preflight.json', sourceSha256: hash(source),
      cases: identities, passed: true, review: { sourceSha256: hash(source), cases: identities } });
    expect(Number.isNaN(Date.parse(receipt.recordedAt))).toBe(false);
    expect(m.save.mock.calls.at(-1)![0]).toMatchObject({ preflightReviewReceipt: {
      file: 'cloudflare-recovery-preflight-receipt.json', sha256: hash(bytes),
    } });
    expect(m.order).toEqual([
      'lock', 'claim', ...Array<string>(5).fill('pool'), 'history:prior', 'source', 'db:enter', 'ports', 'scheduler', 'save',
      'execute:unknown-cost', 'history:inside', 'source', 'lease', 'lease', 'loader',
      'execute:no-date', 'history:inside', 'source', 'lease', 'lease', 'loader', 'lease',
      `write:${sourceFile}`, 'review', 'lease', `write:${receiptFile}`, 'save', 'batch:28-marker',
      'history:inside', 'source', 'lease', 'db:exit', ...Array<string>(5).fill('end'), 'unlock',
    ]);
    expect(m.atomic).not.toHaveBeenCalled(); expectPoolsClosed();
  });

  test('preserves source manifest, unknown carry and exact two-attempt data in snapshots and checkpoints', async () => {
    await runCloudflareRecoveryEntry();
    const snapshot = JSON.parse(m.immutable.mock.calls[0][1]);
    expect(snapshot.records).toEqual(report().records);
    for (const saved of [...m.save.mock.calls.map(([value]) => value), snapshot]) {
      expect(saved).toMatchObject({ prior, sourceFingerprint: sourceManifest.sha256, sourceManifest,
        accountingComplete: false, historicalUnknownReceipts: 2, dispatchAuthorized: false, evaluationGatePassed: false });
      expect(Number.isNaN(Date.parse(saved.startedAt))).toBe(false);
    }
  });

  test.each(['empty', 'single-case', 'malformed', 'reused-run', 'wrong-round', 'wrong-case', 'extra-evidence'])(
    'rejects %s identities without creating a snapshot or calling review', async kind => {
      let records = structuredClone(report().records) as { round: number; caseId: string; evidence?: { caseId: string; runId: string } }[];
      if (kind === 'empty') records = [];
      if (kind === 'single-case') records = records.slice(0, 2);
      if (kind === 'malformed') records[0].evidence!.runId = 'not-a-uuid';
      if (kind === 'reused-run') records[2].evidence!.runId = runIds[0];
      if (kind === 'wrong-round') records[2].round = 2;
      if (kind === 'wrong-case') records[2].caseId = 'non-diver';
      if (kind === 'extra-evidence') records.push(structuredClone(records[0]));
      m.scheduler.mockImplementation(ports => drivePreflights(ports, report(null, records)));
      await expect(runCloudflareRecoveryEntry()).rejects.toThrow('EVAL_CLOUDFLARE_CAMPAIGN_STOPPED');
      expect(m.immutable).not.toHaveBeenCalled(); expect(m.review).not.toHaveBeenCalled();
      expect(m.order).not.toContain('batch:28-marker'); expectRetained();
    });

  test.each(['false', 'refuse', 'malformed-review', 'snapshot-write', 'receipt-write', 'checkpoint'])(
    '%s failure retains DB and prevents later dispatch', async kind => {
      if (kind === 'false') m.review.mockResolvedValue(false);
      if (kind === 'refuse') m.review.mockImplementation(async (source, cases, _lease, record) => {
        await record(recoveryReviewSchema.parse({ sourceSha256: hash(source), cases: cases.map(identity => ({ ...identity,
          sourceSha256: hash(source), textReview: 'failed', reviewers: ['primary', 'independent'], findings: ['synthetic refusal'],
        })) }), false);
        return false;
      });
      if (kind === 'malformed-review') m.review.mockRejectedValue(new Error('SYNTHETIC_MALFORMED_REVIEW'));
      if (kind === 'snapshot-write' || kind === 'receipt-write') m.immutable.mockImplementation(async (file: string) => {
        if (file.endsWith(kind === 'snapshot-write' ? '-preflight.json' : '-receipt.json')) throw new Error('SYNTHETIC_WRITE_FAILURE');
      });
      if (kind === 'checkpoint') m.save.mockImplementation(async (saved) => {
        if (saved.preflightReviewReceipt) throw new Error('SYNTHETIC_CHECKPOINT_FAILURE');
      });
      await expect(runCloudflareRecoveryEntry()).rejects.toThrow(kind === 'checkpoint'
        ? 'SYNTHETIC_CHECKPOINT_FAILURE' : 'EVAL_CLOUDFLARE_CAMPAIGN_STOPPED');
      expect(m.order).not.toContain('batch:28-marker'); expect(m.execute).toHaveBeenCalledTimes(2);
      if (kind === 'snapshot-write') expect(m.review).not.toHaveBeenCalled();
      if (kind === 'refuse') expect(JSON.parse(m.immutable.mock.calls[1][1])).toMatchObject({ passed: false,
        review: { cases: [{ findings: ['synthetic refusal'] }, { findings: ['synthetic refusal'] }] } });
      if (kind === 'receipt-write') expect(m.save.mock.calls.at(-1)![0].preflightReviewReceipt).toBeUndefined();
      expectRetained();
    });

  test.each(['history', 'source', 'lease', 'execute'])('dispatch %s failure stops before review and retains DB', async kind => {
    if (kind === 'history') m.carry.mockResolvedValueOnce(structuredClone(prior)).mockResolvedValue({ ...prior, observedTokens: 1 });
    if (kind === 'source') m.sourceManifest.mockResolvedValueOnce(structuredClone(sourceManifest))
      .mockResolvedValue({ ...sourceManifest, files: [{ path: 'changed.ts', sha256: hash('changed') }] });
    if (kind === 'lease') m.assertLock.mockRejectedValue(new Error('EVAL_LOCK_NOT_OWNED'));
    if (kind === 'execute') m.execute.mockRejectedValue(new Error('SYNTHETIC_DISPATCH_FAILURE'));
    await expect(runCloudflareRecoveryEntry()).rejects.toThrow(kind === 'history' ? 'EVAL_HISTORY_CHANGED'
      : kind === 'source' ? 'EVAL_SOURCE_CHANGED' : kind === 'lease' ? 'EVAL_LOCK_NOT_OWNED' : 'SYNTHETIC_DISPATCH_FAILURE');
    expect(m.credential).not.toHaveBeenCalled(); expect(m.review).not.toHaveBeenCalled();
    expect(m.execute).toHaveBeenCalledTimes(1); expectRetained();
  });

  test.each(['history', 'source', 'lease'])('final %s failure writes stopped checkpoint within retained DB', async kind => {
    if (kind === 'history') m.carry.mockResolvedValueOnce(prior).mockResolvedValueOnce(prior).mockResolvedValueOnce(prior)
      .mockResolvedValue({ ...prior, observedTokens: 1 });
    if (kind === 'source') m.sourceManifest.mockResolvedValueOnce(sourceManifest).mockResolvedValueOnce(sourceManifest)
      .mockResolvedValueOnce(sourceManifest).mockResolvedValue({ ...sourceManifest, sha256: hash('final changed') });
    if (kind === 'lease') m.assertLock.mockImplementation(async () => {
      if (m.order.includes('batch:28-marker')) throw new Error('EVAL_LOCK_NOT_OWNED');
    });
    await expect(runCloudflareRecoveryEntry()).rejects.toThrow('EVAL_HISTORY_CHANGED');
    expect(m.save.mock.calls.at(-1)![0]).toMatchObject({ stopped: 'HISTORY_OR_SOURCE_CHANGED_STOP',
      sourceFingerprint: sourceManifest.sha256, sourceManifest });
    expectRetained();
  });

  test.each(['prior', 'source'])('initial %s failure closes all five pools before DB or credentials', async kind => {
    (kind === 'prior' ? m.carry : m.sourceManifest).mockRejectedValue(new Error('SYNTHETIC_PRIOR_FAILURE'));
    await expect(runCloudflareRecoveryEntry()).rejects.toThrow('SYNTHETIC_PRIOR_FAILURE');
    expect(m.database).not.toHaveBeenCalled(); expect(m.credential).not.toHaveBeenCalled();
    expect(m.claim).toHaveBeenCalledTimes(1); expectPoolsClosed();
  });

  test('aborted dispatch still audits history, source and lease before rejecting without loading', async () => {
    m.execute.mockImplementation(async (_caseId: string, gate: (signal: AbortSignal) => Promise<void>) => {
      const controller = new AbortController(); controller.abort(new Error('SYNTHETIC_ABORT'));
      await gate(controller.signal);
      await m.options!.loadCredential();
    });
    await expect(runCloudflareRecoveryEntry()).rejects.toThrow('SYNTHETIC_ABORT');
    expect(m.carry).toHaveBeenCalledTimes(2); expect(m.sourceManifest).toHaveBeenCalledTimes(2);
    expect(m.assertLock).toHaveBeenCalledWith(m.lease); expect(m.credential).not.toHaveBeenCalled(); expectRetained();
  });

  test.each([false, true])('saves first two available replays and at most first resume (early resume: %s), without resending', async earlyResume => {
    const bundles = Array.from({ length: 5 }, (_, index) => ({
      caseId: `synthetic-${index}`, afterStart: { runs: { runs: [{ id: `run-${index}` }] } },
      startEvents: [{ type: 'synthetic-start', content: `verbatim ${index}` }],
      resumeEvents: index >= 3 || (earlyResume && index === 0) ? [{ type: 'synthetic-resume' }] : [],
    } as unknown as ReplayBundle));
    // These are collector-output projections only; replay schema validation is separate.
    m.execute.mockImplementation(async (caseId: string, gate: (signal: AbortSignal) => Promise<void>) => {
      await gate(new AbortController().signal);
      await m.options!.loadCredential();
      m.options!.captureReplay!(bundles[Number(caseId)]);
      return {};
    });
    m.scheduler.mockImplementation(async ports => {
      for (let index = 0; index < bundles.length; index++) {
        await ports.execute(String(index), ports.checkDispatch);
        await ports.capture();
      }
      await ports.checkpoint(report());
      return report();
    });
    await runCloudflareRecoveryEntry();
    const selected = earlyResume ? [0, 1] : [0, 1, 3];
    expect(m.atomic).toHaveBeenCalledTimes(selected.length);
    const saved = m.save.mock.calls.at(-1)![0];
    expect(saved.replays).toEqual(selected.map(index => {
      const file = `cloudflare-recovery-run-${index}.replay.json`;
      const bytes = JSON.stringify(bundles[index], null, 2);
      expect(m.atomic).toHaveBeenCalledWith(`.artifacts/${file}`, bytes);
      return { file, sha256: hash(bytes), runId: `run-${index}`, recordedResume: bundles[index].resumeEvents.length > 0 };
    }));
    expect(m.execute.mock.calls.map(([id]) => id)).toEqual(['0', '1', '2', '3', '4']);
    expect(m.capture).toHaveBeenCalledTimes(5); expect(m.credential).toHaveBeenCalledTimes(5);
    expect(m.carry).toHaveBeenCalledTimes(7); expectPoolsClosed();
  });

  test('does not export incomplete private usage or reuse a previous execution replay', async () => {
    const bundle = { afterStart: { runs: { runs: [{ id: runIds[0] }] } }, resumeEvents: [] } as unknown as ReplayBundle;
    m.execute.mockImplementationOnce(async () => { m.options!.captureReplay!(bundle); return {}; })
      .mockResolvedValue({});
    m.capture.mockResolvedValueOnce({ privateUsageComplete: false }).mockResolvedValue({ privateUsageComplete: true });
    await runCloudflareRecoveryEntry();
    expect(m.atomic).not.toHaveBeenCalled();
    expect(m.save.mock.calls.at(-1)![0].replays).toEqual([]);
    expect(m.execute).toHaveBeenCalledTimes(2); expectPoolsClosed();
  });

  test.each(['save', 'replay-write', 'capture', 'loader'])('%s exception retains DB without retry', async kind => {
    if (kind === 'save') m.save.mockRejectedValue(new Error('SYNTHETIC_IO_FAILURE'));
    if (kind === 'capture') m.capture.mockRejectedValue(new Error('SYNTHETIC_IO_FAILURE'));
    if (kind === 'loader') m.credential.mockRejectedValue(new Error('SYNTHETIC_IO_FAILURE'));
    if (kind === 'replay-write') {
      m.execute.mockImplementation(async (_caseId: string, gate: (signal: AbortSignal) => Promise<void>) => {
        await gate(new AbortController().signal);
        m.options!.captureReplay!({ afterStart: { runs: { runs: [{ id: runIds[0] }] } }, resumeEvents: [] } as unknown as ReplayBundle);
        return {};
      });
      m.atomic.mockRejectedValue(new Error('SYNTHETIC_IO_FAILURE'));
    }
    await expect(runCloudflareRecoveryEntry()).rejects.toThrow('SYNTHETIC_IO_FAILURE');
    expect(m.execute).toHaveBeenCalledTimes(kind === 'save' ? 0 : 1);
    expect(m.review).not.toHaveBeenCalled(); expect(m.claim).toHaveBeenCalledTimes(1); expectRetained();
  });

  test('real scheduler completes 30 synthetic cases through entry, with dual-run receipt checkpoint before case three', async () => {
    const { runCloudflareRecoveryCampaign } = await vi.importActual<typeof import('../../evals/cloudflare-recovery-campaign')>(
      '../../evals/cloudflare-recovery-campaign');
    m.scheduler.mockImplementationOnce(runCloudflareRecoveryCampaign);
    m.carry.mockImplementation(async (...args: unknown[]) => {
      expect(args).toEqual([...m.pools, m.lease]); return structuredClone(recoveryPrior);
    });
    let time = 100_000, attempts = 0, dispatches = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => time);
    m.delay.mockImplementation(async (ms: number, _value: undefined, options: { signal?: AbortSignal }) => {
      expect(options.signal?.aborted).toBe(false); time += ms;
    });
    m.save.mockImplementation(async saved => {
      expect(m.inDatabase).toBe(true);
      m.order.push(saved.preflightReviewReceipt ? 'receipt:checkpointed' : 'save');
    });
    m.execute.mockImplementation(async (caseId: string, gate: (signal: AbortSignal) => Promise<void>) => {
      const attempt = ++attempts;
      m.order.push(`attempt:${attempt}`);
      if (attempt >= 3) {
        expect(m.review).toHaveBeenCalledTimes(1);
        expect(m.immutable).toHaveBeenCalledTimes(2);
        const bytes = m.immutable.mock.calls[1][1] as string;
        expect(m.save.mock.calls.at(-1)![0]).toMatchObject({ preflightReviewReceipt: {
          file: 'cloudflare-recovery-preflight-receipt.json', sha256: hash(bytes),
        } });
      }
      const proposal = evaluationInput(caseId).terminal === 'proposal';
      for (let index = 0; index < (proposal ? 2 : 1); index++) {
        await gate(new AbortController().signal);
        dispatches++;
        expect(m.save.mock.calls.at(-1)![0].invocations).toBe(dispatches);
        await m.options!.loadCredential();
        time += 4000;
      }
      const runId = runIds[attempt - 1] ?? `5039b404-2e2f-4615-9fa9-${String(attempt).padStart(12, '0')}`;
      return recoveryResult(caseId, attempt, { runId, usageRunId: runId, decisionRunId: proposal ? runId : null });
    });
    m.capture.mockImplementation(async () => ({ chargedMicros: attempts * 100, modelCalls: attempts * 2,
      totalTokens: attempts * 1000, privateUsageComplete: true, usageKnown: true, record: { synthetic: true } }));
    await runCloudflareRecoveryEntry();
    const first = ['unknown-cost', 'no-date'];
    const schedule = [...first.map(caseId => ({ round: 1, caseId })),
      ...[1, 2, 3].flatMap(round => cases.filter(c => round !== 1 || !first.includes(c.id))
        .map(c => ({ round, caseId: c.id })))];
    expect(m.execute.mock.calls.map(([id]) => id)).toEqual(schedule.map(slot => slot.caseId));
    expect(m.execute).toHaveBeenCalledTimes(30); expect(m.capture).toHaveBeenCalledTimes(30);
    expect(dispatches).toBe(39); expect(m.credential).toHaveBeenCalledTimes(39);
    expect(m.carry).toHaveBeenCalledTimes(41); expect(m.sourceManifest).toHaveBeenCalledTimes(41);
    const saved = m.save.mock.calls.at(-1)![0];
    expect(saved).toMatchObject({ prior: recoveryPrior, stopped: null, maxModelCalls: 210, maxInvocations: 60,
      invocations: 39, modelCalls: 60, chargedMicros: 3000, totalTokens: 30000,
      cumulativeInvocations: 78, cumulativeModelCalls: 116, cumulativeChargedMicros: 399708,
      cumulativeTokens: null, historicalUnknownReceipts: 2, accountingComplete: false,
      dispatchAuthorized: false, evaluationGatePassed: false, textReview: 'pending' });
    expect(saved.records.filter((row: { outcome?: string }) => row.outcome === 'completed')
      .map(({ round, caseId }: { round: number; caseId: string }) => ({ round, caseId }))).toEqual(schedule);
    const snapshot = JSON.parse(m.immutable.mock.calls[0][1]);
    expect(snapshot.records.filter((row: { evidence?: unknown }) => row.evidence)
      .map((row: { round: number; caseId: string; evidence: { runId: string } }) => ({
        round: row.round, caseId: row.caseId, runId: row.evidence.runId,
      }))).toEqual(identities);
    expect(m.order.indexOf('receipt:checkpointed')).toBeLessThan(m.order.indexOf('attempt:3'));
    expect(m.databaseFailure).toBeUndefined(); expectPoolsClosed();
  });
});
