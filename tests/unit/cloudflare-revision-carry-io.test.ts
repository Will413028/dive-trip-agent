import { beforeEach, expect, test, vi } from 'vitest';
import type { Pool } from 'pg';
import type { EvaluationLockLease } from '../../evals/live-evaluation-lock';
import { qualityCarryFixture } from '../support/cloudflare-quality-carry-fixture';
import { fixture as firstFixture } from '../support/cloudflare-carry-fixture';
import { historyFixture } from '../support/cloudflare-history-carry-fixture';
import { revisionCarryFixture, type RevisionCarryFixture } from '../support/cloudflare-revision-carry-fixture';
import { readCloudflareRevisionCarry, REVISION_CARRY_SCHEMA } from '../../evals/cloudflare-revision-carry';

const state = vi.hoisted(() => ({ mode: '', historyReads: 0, reportReads: 0, dbReads: 0, locks: 0,
  reports: {} as Record<string, unknown>, reads: {} as Record<string, number>, captures: {} as Record<string, number>,
  order: [] as string[],
  fixture: undefined as RevisionCarryFixture | undefined }));
vi.mock('../../evals/cloudflare-campaign-history', () => ({ captureCloudflareCampaignBaseline: async () => {
  state.historyReads++;
  if (state.mode === 'history' && state.historyReads === 2) throw new Error('private');
  const baseline = structuredClone(firstFixture().baseline);
  if (state.mode === 'raw-baseline' && state.historyReads === 2) Object.assign(baseline, { ignored: true });
  return { baseline, raw: { invocations: [], calls: [] } };
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
vi.mock('../../evals/live-evaluation-lock', () => ({ assertEvaluationLock: async () => {
  state.locks++;
  if (state.mode === 'lease' || (state.mode === 'lost-lease' && state.locks === 5)
    || (state.mode === 'final-lease' && state.locks === 7)) throw new Error('private');
} }));
// Synthetic IDs intentionally cannot establish historical provenance. This
// mock tests the IO decision and refusal path; real pinned IO is audited separately.
vi.mock('node:crypto', () => ({ createHash: () => ({ update: (input: string) => ({ digest: () => state.mode === 'owner-pin'
  || (state.mode === 'revision-owner-pin' && JSON.parse(input).length === 9)
  ? '0'.repeat(64) : JSON.parse(input).length === 9
    ? '633862f23cb3dc4cce0eec4b0ef4c56c1a2917f1fb8b6728d7b5302f2ad6ea3f'
    : '61b5a16e88ad1ae8268a148d6e445a385ea0f00b626ad2e8158576eb57e0ecd1' }) }) }));
import { captureCloudflareCampaignInventory, readCloudflareQualityCarry, QUALITY_CARRY_SCHEMA } from '../../evals/cloudflare-quality-carry';
import { readCloudflareCarryForward, CARRY_SCHEMA } from '../../evals/cloudflare-carry-forward';
import { readCloudflareSecondCarryForward, SECOND_CARRY_SCHEMA } from '../../evals/cloudflare-carry-forward-2';
import { readCloudflarePatchCarry } from '../../evals/cloudflare-patch-carry';


beforeEach(() => {
  const f = historyFixture(), quality = qualityCarryFixture(), revision = revisionCarryFixture();
  Object.assign(state, { mode: '', historyReads: 0, reportReads: 0, dbReads: 0, locks: 0, fixture: revision,
    reads: {}, captures: { first: 0, second: 0, quality: 0, revision: 0 }, order: [],
    reports: { first: f.first.report, second: f.second.report, patch: f.patch, quality: quality.report, revision: revision.report } });
  vi.clearAllMocks();
});
function setup() {
  const options = { host: '127.0.0.1', port: 1234, database: 'dive_trip_test', user: 'postgres',
    password: 'offline-placeholder-not-a-credential', ssl: false, connectionTimeoutMillis: 2000, statement_timeout: 2000 };
  const release = vi.fn();
  const history = historyFixture();
  const sources = { first: history.first, second: history.second, quality: qualityCarryFixture(), revision: state.fixture! };
  const schemas = { first: CARRY_SCHEMA(), second: SECOND_CARRY_SCHEMA(), quality: QUALITY_CARRY_SCHEMA(), revision: REVISION_CARRY_SCHEMA() };
  const poolFor = (kind: keyof typeof sources) => {
  const query = vi.fn(async (config: { text: string; query_timeout: number }) => {
    expect(config.query_timeout).toBe(2000);
    const sql = config.text, f = structuredClone(sources[kind]);
    if (sql.startsWith('BEGIN')) { state.captures[kind]++; state.order.push(`db:${kind}`); }
    if (kind === 'revision' && state.mode === 'query-failure' && sql.includes('FROM model_calls')) throw new Error('private');
    if (sql.includes('current_database()')) return { rows: [{ database: state.mode === 'wrong-db' ? 'other' : 'dive_trip_test',
      schema: state.mode === 'schema' || (state.mode === 'revision-schema' && kind === 'revision') ? 'workbench_live' : schemas[kind] }] };
    if (sql.includes('AS runs')) { state.dbReads++; return { rows: [{ ...f.snapshot.counts,
      ...(state.mode === 'extra-usage' ? { calls: 25 } : {}) }] }; }
    if (sql.includes('SELECT r.id')) {
      if (state.mode === 'db-change' && state.captures[kind] === 2) f.snapshot.runs[0].current_version++;
      return { rows: f.snapshot.runs };
    }
    if (sql.includes('FROM agent_run_events')) return { rows: f.snapshot.events };
    if (sql.includes('FROM agent_invocations i')) return { rows: f.snapshot.usage.flatMap(u => u.invocations.map(i => ({ ...i,
      reservation_owner_id: state.mode === 'receipt-owner' ? 'wrong' : f.snapshot.runs.find(r => r.id === u.runId)!.owner_id }))) };
    if (sql.includes('FROM model_calls ORDER')) return { rows: f.snapshot.usage.flatMap(u => u.calls.map(c => ({ ...c,
      ...(state.mode === 'call-run' ? { run_id: 'wrong' } : {}),
      // Same normalized ISO usage and cost; only the raw SQL value changes.
      ...(state.mode === `raw-db-${kind}` && state.captures[kind] === 2 ? { started_at: new Date(c.started_at) } : {}),
    }))) };
    expect(sql).toMatch(/^(BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY|SET LOCAL statement_timeout)/);
    return { rows: [] };
  });
  const connect = vi.fn(async () => ({ query, release }));
  return { pool: { options: { ...options }, connect } as unknown as Pool, query, connect };
  };
  const adapters = [poolFor('first'), poolFor('first'), poolFor('second'), poolFor('quality'), poolFor('revision')];
  const pools = adapters.map(a => a.pool);
  const read = () => readCloudflareRevisionCarry(pools[0], pools[1], pools[2], pools[3], pools[4], {} as EvaluationLockLease);
  return { read, pools, query: adapters[4].query, release, connect: adapters[4].connect, adapters };
}

test('checks both histories, both DB snapshots and lease; never grants dispatch', async () => {
  const s = setup();
  expect(await s.read()).toMatchObject({ invocations: 39, modelCalls: 56, chargedMicros: 396708,
    observedTokens: 259078, totalTokens: null, historicalUnknownReceipts: 2,
    dispatchAuthorized: false, accountingComplete: false, evaluationGatePassed: false });
  expect(state.historyReads).toBe(2); expect(state.reportReads).toBe(10); expect(state.dbReads).toBe(8);
  expect(state.reads).toEqual({ first: 2, second: 2, patch: 2, quality: 2, revision: 2 });
  expect(state.captures).toEqual({ first: 2, second: 2, quality: 2, revision: 2 });
  const pass = ['report:first', 'db:first', 'report:second', 'db:second', 'report:patch', 'report:quality', 'db:quality', 'report:revision', 'db:revision'];
  expect(state.order).toEqual([...pass, ...pass]);
  expect(state.locks).toBe(7);
  expect(readCloudflareCarryForward).not.toHaveBeenCalled();
  expect(readCloudflareSecondCarryForward).not.toHaveBeenCalled();
  expect(readCloudflarePatchCarry).not.toHaveBeenCalled();
  expect(readCloudflareQualityCarry).not.toHaveBeenCalled();
  expect(s.release).toHaveBeenCalledTimes(8); expect(s.release).toHaveBeenCalledWith(true);
  expect(s.query.mock.calls.filter(([q]) => q.text.includes('FROM agent_run_events')).every(([q]) => q.text.endsWith('LIMIT 87'))).toBe(true);
  for (const [needle, limit] of [['SELECT r.id', 10], ['FROM agent_run_events', 87], ['FROM agent_invocations i', 14], ['FROM model_calls ORDER', 19]] as const) {
    const queries = s.query.mock.calls.filter(([q]) => q.text.includes(needle));
    expect(queries).toHaveLength(2);
    expect(queries.every(([q]) => q.text.endsWith(`LIMIT ${limit}`))).toBe(true);
  }
  expect(s.query.mock.calls.every(([q]) => /^(SELECT |BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY$|SET LOCAL statement_timeout = '2000ms'$)/.test(q.text))).toBe(true);
});

test.each(['history', 'report-hash', 'report-change', 'lease', 'lost-lease', 'final-lease', 'owner-pin', 'revision-owner-pin', 'schema', 'revision-schema', 'wrong-db', 'query-failure', 'raw-baseline',
  'db-change', 'extra-usage', 'receipt-owner', 'call-run', 'raw-db-first', 'raw-db-second', 'raw-db-quality', 'raw-db-revision',
  'raw-report-first', 'raw-report-second', 'raw-report-patch', 'raw-report-quality', 'raw-report-revision'])('fails closed and sanitizes %s', async mode => {
  state.mode = mode;
  await expect(setup().read()).rejects.toThrow(/^CLOUDFLARE_REVISION_CARRY_INVALID$/);
  if (mode.startsWith('raw-')) {
    // Both complete passes succeeded: rejection must be the raw equality gate,
    // not a failed connection, parser, accounting total or incomplete capture.
    expect(state.historyReads).toBe(2);
    expect(state.reads).toEqual({ first: 2, second: 2, patch: 2, quality: 2, revision: 2 });
    expect(state.captures).toEqual({ first: 2, second: 2, quality: 2, revision: 2 });
    expect(state.locks).toBe(6);
  }
});

test.each([0, 1, 2, 3, 4])('each pool %i must use explicit synthetic credentials and the common port before any IO', async index => {
  for (const overrides of [{ port: 1235 }, { password: undefined }, { connectionString: 'postgres://synthetic' },
    { host: 'localhost' }, { database: 'other' }, { ssl: true }]) {
    const s = setup(); Object.assign(s.pools[index].options, overrides);
    await expect(s.read()).rejects.toThrow(/^CLOUDFLARE_REVISION_CARRY_INVALID$/);
    expect(state.historyReads).toBe(0);
    s.adapters.forEach(a => expect(a.connect).not.toHaveBeenCalled());
  }
});

test('every pair of pools must be distinct before any IO', async () => {
  for (let left = 0; left < 5; left++) for (let right = left + 1; right < 5; right++) {
    const s = setup(); s.pools[right] = s.pools[left];
    await expect(s.read()).rejects.toThrow(/^CLOUDFLARE_REVISION_CARRY_INVALID$/);
    expect(state.historyReads).toBe(0);
    s.adapters.forEach(a => expect(a.connect).not.toHaveBeenCalled());
  }
});

test('inventory descriptor is closed, never an arbitrary schema or count override', async () => {
  const s = setup();
  for (const kind of ['workbench_live', REVISION_CARRY_SCHEMA(), '__proto__', { runs: 9 }]) {
    await expect(captureCloudflareCampaignInventory(kind as 'revision', s.pools[4])).rejects.toThrow();
  }
  expect(s.connect).not.toHaveBeenCalled();
});

test('revision query failure destroys its readonly transaction client', async () => {
  state.mode = 'query-failure'; const s = setup();
  await expect(s.read()).rejects.toThrow(/^CLOUDFLARE_REVISION_CARRY_INVALID$/);
  expect(s.release).toHaveBeenCalledTimes(4);
  expect(s.release).toHaveBeenLastCalledWith(true);
});

test.each(['first', 'second', 'patch', 'quality', 'revision'])('rejects invalid %s before taking an after pass', async kind => {
  Object.assign(state.reports[kind] as object, { cumulativeChargedMicros: -1 });
  await expect(setup().read()).rejects.toThrow(/^CLOUDFLARE_REVISION_CARRY_INVALID$/);
  expect(state.historyReads).toBe(1);
});

test('invalid pool or aliased endpoint objects stop before history IO or connecting', async () => {
  const s = setup(); s.pools[4].options.password = undefined;
  await expect(s.read()).rejects.toThrow('CLOUDFLARE_REVISION_CARRY_INVALID');
  expect(state.historyReads).toBe(0); expect(s.connect).not.toHaveBeenCalled();
  await expect(readCloudflareRevisionCarry(s.pools[0], s.pools[0], s.pools[0], s.pools[0], s.pools[0], {} as EvaluationLockLease)).rejects.toThrow();
});
