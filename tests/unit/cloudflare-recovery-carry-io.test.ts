import { beforeEach, expect, test, vi } from 'vitest';
import type { Pool } from 'pg';
import type { EvaluationLockLease } from '../../evals/live-evaluation-lock';
import { qualityCarryFixture } from '../support/cloudflare-quality-carry-fixture';
import { fixture as firstFixture } from '../support/cloudflare-carry-fixture';
import { historyFixture } from '../support/cloudflare-history-carry-fixture';
import { revisionCarryFixture } from '../support/cloudflare-revision-carry-fixture';
import { recoveryCarryFixture, type RecoveryCarryFixture } from '../support/cloudflare-recovery-carry-fixture';
import { readCloudflareRecoveryCarry, RECOVERY_CARRY_SCHEMA } from '../../evals/cloudflare-recovery-carry';

const state = vi.hoisted(() => ({ mode: '', historyReads: 0, reportReads: 0, dbReads: 0, locks: 0,
  reports: {} as Record<string, unknown>, reads: {} as Record<string, number>, captures: {} as Record<string, number>,
  order: [] as string[], fixture: undefined as RecoveryCarryFixture | undefined }));
vi.mock('../../evals/cloudflare-campaign-history', () => ({ captureCloudflareCampaignBaseline: async () => {
  state.historyReads++; state.order.push('baseline');
  if (state.mode === 'history' && state.historyReads === 2) throw new Error('private');
  const baseline = structuredClone(firstFixture().baseline);
  if (state.mode === 'raw-baseline' && state.historyReads === 2) Object.assign(baseline, { ignored: true });
  return { baseline, raw: { invocations: [], calls: [{ call_id:
    state.mode === 'raw-workbench-call-id' && state.historyReads === 2 ? 'changed-call-id' : 'same-call-id' }] } };
} }));
vi.mock('../../evals/cloudflare-carry-forward', async original => ({
  ...await original<typeof import('../../evals/cloudflare-carry-forward')>(),
  readCloudflareCarryForward: vi.fn(() => { throw new Error('nested first wrapper'); }),
}));
vi.mock('../../evals/cloudflare-carry-forward-2', async original => ({
  ...await original<typeof import('../../evals/cloudflare-carry-forward-2')>(),
  readCloudflareSecondCarryForward: vi.fn(() => { throw new Error('nested second wrapper'); }),
}));
vi.mock('../../evals/cloudflare-patch-carry', async original => ({
  ...await original<typeof import('../../evals/cloudflare-patch-carry')>(),
  readCloudflarePatchCarry: vi.fn(() => { throw new Error('nested patch wrapper'); }),
}));
vi.mock('../../evals/cloudflare-quality-carry', async original => ({
  ...await original<typeof import('../../evals/cloudflare-quality-carry')>(),
  readCloudflareQualityCarry: vi.fn(() => { throw new Error('nested quality wrapper'); }),
}));
vi.mock('../../evals/cloudflare-revision-carry', async original => ({
  ...await original<typeof import('../../evals/cloudflare-revision-carry')>(),
  readCloudflareRevisionCarry: vi.fn(() => { throw new Error('nested revision wrapper'); }),
}));
vi.mock('../../evals/pinned-cloudflare-report', async original => ({
  ...await original<typeof import('../../evals/pinned-cloudflare-report')>(),
  readPinnedCloudflareReport: async (kind: string) => {
    state.reportReads++; state.reads[kind] = (state.reads[kind] ?? 0) + 1;
    state.order.push(`report:${kind}`);
    if (state.mode === 'report-hash' || (state.mode === 'report-change' && state.reads[kind] === 2)) throw new Error('private');
    const report = structuredClone(state.reports[kind]);
    if (state.mode === `raw-report-${kind}` && state.reads[kind] === 2) Object.assign(report as object, { ignoredMetadata: 'changed' });
    return report;
  },
}));
vi.mock('../../evals/live-evaluation-lock', () => ({ assertEvaluationLock: async (lease: EvaluationLockLease) => {
  state.locks++;
  if (!lease || state.mode === 'lease' || (state.mode === 'lost-lease' && state.locks === 5)
    || (state.mode === 'final-lease' && state.locks === 9)) throw new Error('private');
} }));
// Synthetic tuples are not historical provenance: test the exact pin/refusal
// behavior here and reconcile actual tuples separately using readonly SQL.
vi.mock('node:crypto', () => ({ createHash: () => ({ update: (input: string) => ({ digest: () => {
  const size = JSON.parse(input).length;
  if (state.mode === 'owner-pin' || (state.mode === 'recovery-owner-pin' && size === 2)) return '0'.repeat(64);
  return size === 2 ? 'c0e2fdb79bdda369d33dee832163676aa98ca6a9db22e652066b876926881266'
    : size === 9 ? '633862f23cb3dc4cce0eec4b0ef4c56c1a2917f1fb8b6728d7b5302f2ad6ea3f'
      : '61b5a16e88ad1ae8268a148d6e445a385ea0f00b626ad2e8158576eb57e0ecd1';
} }) }) }));
import { captureCloudflareCampaignInventory, readCloudflareQualityCarry, QUALITY_CARRY_SCHEMA } from '../../evals/cloudflare-quality-carry';
import { readCloudflareRevisionCarry, REVISION_CARRY_SCHEMA } from '../../evals/cloudflare-revision-carry';
import { readCloudflareCarryForward, CARRY_SCHEMA } from '../../evals/cloudflare-carry-forward';
import { readCloudflareSecondCarryForward, SECOND_CARRY_SCHEMA } from '../../evals/cloudflare-carry-forward-2';
import { readCloudflarePatchCarry } from '../../evals/cloudflare-patch-carry';

beforeEach(() => {
  const f = historyFixture(), quality = qualityCarryFixture(), revision = revisionCarryFixture(), recovery = recoveryCarryFixture();
  Object.assign(state, { mode: '', historyReads: 0, reportReads: 0, dbReads: 0, locks: 0, fixture: recovery,
    reads: {}, captures: { first: 0, second: 0, quality: 0, revision: 0, recovery: 0 }, order: [],
    reports: { first: f.first.report, second: f.second.report, patch: f.patch, quality: quality.report,
      revision: revision.report, recovery: recovery.report } });
  vi.clearAllMocks();
});
function setup() {
  const options = { host: '127.0.0.1', port: 1234, database: 'dive_trip_test', user: 'postgres',
    password: 'offline-placeholder-not-a-credential', ssl: false, connectionTimeoutMillis: 2000, statement_timeout: 2000 };
  const release = vi.fn();
  const history = historyFixture();
  const sources = { first: history.first, second: history.second, quality: qualityCarryFixture(), revision: revisionCarryFixture(), recovery: state.fixture! };
  const schemas = { first: CARRY_SCHEMA(), second: SECOND_CARRY_SCHEMA(), quality: QUALITY_CARRY_SCHEMA(),
    revision: REVISION_CARRY_SCHEMA(), recovery: RECOVERY_CARRY_SCHEMA() };
  const poolFor = (kind: keyof typeof sources) => {
    const query = vi.fn(async (config: { text: string; query_timeout: number }) => {
      expect(config.query_timeout).toBe(2000);
      const sql = config.text, f = structuredClone(sources[kind]);
      if (sql.startsWith('BEGIN')) { state.captures[kind]++; state.order.push(`db:${kind}`); }
      if (kind === 'recovery' && state.mode === 'query-failure' && sql.includes('FROM model_calls')) throw new Error('private');
      if (sql.includes('current_database()')) return { rows: [{ database: state.mode === 'wrong-db' ? 'other' : 'dive_trip_test',
        schema: state.mode === 'schema' || (state.mode === 'recovery-schema' && kind === 'recovery') ? 'workbench_live' : schemas[kind] }] };
      if (sql.includes('AS runs')) { state.dbReads++; return { rows: [{ ...f.snapshot.counts,
        ...(state.mode === 'extra-usage' ? { calls: 4 } : {}) }] }; }
      if (sql.includes('SELECT r.id')) {
        if (state.mode === 'db-change' && state.captures[kind] === 2) f.snapshot.runs[0].current_version++;
        return { rows: f.snapshot.runs };
      }
      if (sql.includes('FROM agent_run_events')) return { rows: f.snapshot.events };
      if (sql.includes('FROM agent_invocations i')) return { rows: f.snapshot.usage.flatMap(u => u.invocations.map(i => ({ ...i,
        reservation_owner_id: state.mode === 'receipt-owner' ? 'wrong' : f.snapshot.runs.find(r => r.id === u.runId)!.owner_id }))) };
      if (sql.includes('FROM model_calls ORDER')) return { rows: f.snapshot.usage.flatMap(u => u.calls.map(c => ({ ...c,
        ...(state.mode === 'call-run' ? { run_id: 'wrong' } : {}),
        // Normalizes to the SAME evidence. The outer gate must keep raw rows.
        ...(state.mode === `raw-db-${kind}` && state.captures[kind] === 2 ? { started_at: new Date(c.started_at) } : {}),
      }))) };
      expect(sql).toMatch(/^(BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY|SET LOCAL statement_timeout)/);
      return { rows: [] };
    });
    const connect = vi.fn(async () => ({ query, release }));
    return { pool: { options: { ...options }, connect } as unknown as Pool, query, connect };
  };
  const adapters = [poolFor('first'), poolFor('first'), poolFor('second'), poolFor('quality'), poolFor('revision'), poolFor('recovery')];
  const pools = adapters.map(a => a.pool);
  const read = () => readCloudflareRecoveryCarry(pools[0], pools[1], pools[2], pools[3], pools[4], pools[5], {} as EvaluationLockLease);
  return { read, pools, query: adapters[5].query, release, connect: adapters[5].connect, adapters };
}

test('exactly two linear captures reconcile six reports and six pools without granting authority', async () => {
  const s = setup();
  expect(await s.read()).toMatchObject({ invocations: 41, modelCalls: 59, chargedMicros: 398484,
    observedTokens: 272473, totalTokens: null, historicalUnknownReceipts: 2,
    remainingInvocationCeiling: 59, remainingReferenceMicros: 2601516,
    dispatchAuthorized: false, accountingComplete: false, evaluationGatePassed: false });
  expect(state.historyReads).toBe(2); expect(state.reportReads).toBe(12); expect(state.dbReads).toBe(10);
  expect(state.reads).toEqual({ first: 2, second: 2, patch: 2, quality: 2, revision: 2, recovery: 2 });
  expect(state.captures).toEqual({ first: 2, second: 2, quality: 2, revision: 2, recovery: 2 });
  const pass = ['baseline', 'report:first', 'db:first', 'report:second', 'db:second', 'report:patch',
    'report:quality', 'db:quality', 'report:revision', 'db:revision', 'report:recovery', 'db:recovery'];
  expect(state.order).toEqual([...pass, ...pass]);
  expect(state.locks).toBe(9);
  for (const wrapper of [readCloudflareCarryForward, readCloudflareSecondCarryForward,
    readCloudflarePatchCarry, readCloudflareQualityCarry, readCloudflareRevisionCarry]) expect(wrapper).not.toHaveBeenCalled();
  expect(s.release).toHaveBeenCalledTimes(10); expect(s.release).toHaveBeenCalledWith(true);
  for (const [needle, limit] of [['SELECT r.id', 3], ['FROM agent_run_events', 15], ['FROM agent_invocations i', 3], ['FROM model_calls ORDER', 4]] as const) {
    const queries = s.query.mock.calls.filter(([q]) => q.text.includes(needle));
    expect(queries).toHaveLength(2);
    expect(queries.every(([q]) => q.text.endsWith(`LIMIT ${limit}`))).toBe(true);
  }
  expect(s.query.mock.calls.every(([q]) => /^(SELECT |BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY$|SET LOCAL statement_timeout = '2000ms'$)/.test(q.text))).toBe(true);
});

test.each(['history', 'report-hash', 'report-change', 'lease', 'lost-lease', 'final-lease', 'owner-pin', 'recovery-owner-pin',
  'schema', 'recovery-schema', 'wrong-db', 'query-failure', 'raw-baseline', 'raw-workbench-call-id', 'db-change', 'extra-usage', 'receipt-owner', 'call-run',
  'raw-db-first', 'raw-db-second', 'raw-db-quality', 'raw-db-revision', 'raw-db-recovery',
  'raw-report-first', 'raw-report-second', 'raw-report-patch', 'raw-report-quality', 'raw-report-revision', 'raw-report-recovery'])(
  'fails closed and sanitizes %s', async mode => {
    state.mode = mode;
    await expect(setup().read()).rejects.toThrow(/^CLOUDFLARE_RECOVERY_CARRY_INVALID$/);
    if (mode.startsWith('raw-')) {
      expect(state.historyReads).toBe(2);
      expect(state.reads).toEqual({ first: 2, second: 2, patch: 2, quality: 2, revision: 2, recovery: 2 });
      expect(state.captures).toEqual({ first: 2, second: 2, quality: 2, revision: 2, recovery: 2 });
      expect(state.locks).toBe(8);
    }
  });

test.each([0, 1, 2, 3, 4, 5])('validates pool %i before any IO', async index => {
  for (const overrides of [{ port: 1235 }, { password: undefined }, { connectionString: 'postgres://synthetic' },
    { host: 'localhost' }, { database: 'other' }, { user: 'other' }, { ssl: true },
    { connectionTimeoutMillis: 0 }, { statement_timeout: 0 }]) {
    const s = setup(); Object.assign(s.pools[index].options, overrides);
    await expect(s.read()).rejects.toThrow(/^CLOUDFLARE_RECOVERY_CARRY_INVALID$/);
    expect(state.historyReads).toBe(0);
    s.adapters.forEach(a => expect(a.connect).not.toHaveBeenCalled());
  }
});

test('all six pools must be distinct before any IO', async () => {
  for (let left = 0; left < 6; left++) for (let right = left + 1; right < 6; right++) {
    const s = setup(); s.pools[right] = s.pools[left];
    await expect(s.read()).rejects.toThrow(/^CLOUDFLARE_RECOVERY_CARRY_INVALID$/);
    expect(state.historyReads).toBe(0);
    s.adapters.forEach(a => expect(a.connect).not.toHaveBeenCalled());
  }
});

test('closed inventory descriptor refuses arbitrary schemas/counts before connection', async () => {
  const s = setup();
  for (const kind of ['workbench_live', RECOVERY_CARRY_SCHEMA(), '__proto__', { runs: 2 }]) {
    await expect(captureCloudflareCampaignInventory(kind as 'recovery', s.pools[5])).rejects.toThrow();
  }
  expect(s.connect).not.toHaveBeenCalled();
});

test('recovery query failure destroys the readonly transaction client', async () => {
  state.mode = 'query-failure'; const s = setup();
  await expect(s.read()).rejects.toThrow(/^CLOUDFLARE_RECOVERY_CARRY_INVALID$/);
  expect(s.release).toHaveBeenCalledTimes(5);
  expect(s.release).toHaveBeenLastCalledWith(true);
});

test.each(['first', 'second', 'patch', 'quality', 'revision', 'recovery'])('invalid %s stops before a second capture', async kind => {
  Object.assign(state.reports[kind] as object, { cumulativeChargedMicros: -1 });
  await expect(setup().read()).rejects.toThrow(/^CLOUDFLARE_RECOVERY_CARRY_INVALID$/);
  expect(state.historyReads).toBe(1);
});

test('late recovery connection is destroyed after the bounded acquisition deadline', async () => {
  vi.useFakeTimers();
  try {
    const s = setup();
    let resolve!: (value: { query: typeof s.query; release: typeof s.release }) => void;
    s.connect.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const read = captureCloudflareCampaignInventory('recovery', s.pools[5]);
    const result = expect(read).rejects.toThrow(/^CLOUDFLARE_AUDIT_DATABASE_FAILED$/);
    await vi.advanceTimersByTimeAsync(2000); await result;
    resolve({ query: s.query, release: s.release });
    await vi.advanceTimersByTimeAsync(0);
    expect(s.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(s.query).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});
