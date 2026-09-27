import { beforeEach, expect, test, vi } from 'vitest';
import { constants } from 'node:fs';
import type { Pool } from 'pg';
import { fixture as firstFixture } from '../support/cloudflare-carry-fixture';
import type { EvaluationLockLease } from '../../evals/live-evaluation-lock';

const state = vi.hoisted(() => ({ bytes: Buffer.alloc(0), prior: {} as unknown, mode: '',
  locks: 0, historyReads: 0, reads: 0, closes: 0, opened: [] as { path: string; flags: number }[] }));
vi.mock('../../evals/cloudflare-carry-forward', async original => ({
  ...await original<typeof import('../../evals/cloudflare-carry-forward')>(),
  readCloudflareCarryForward: vi.fn(async () => {
    state.historyReads++;
    if (state.mode === 'old-history-changed' && state.historyReads === 2) throw new Error('private history detail');
    return structuredClone(state.prior);
  }),
}));
vi.mock('../../evals/live-evaluation-lock', () => ({ assertEvaluationLock: vi.fn(async () => {
  state.locks++;
  if (state.mode === 'no-lease' || (state.mode === 'lost-lease' && state.locks === 8)) throw new Error('private lock detail');
}) }));
vi.mock('node:crypto', async original => ({ ...await original<typeof import('node:crypto')>(),
  createHash: () => ({ update: () => ({ digest: () => state.mode === 'wrong-hash' ? '0'.repeat(64)
    : '491ffcaccdb30045113dcbc78e511d25e56e6e79faa82cbf0bd705df51e0786b' }) }) }));
vi.mock('node:fs/promises', () => {
  const stat = (path: string) => ({ isDirectory: () => path.endsWith('.artifacts'),
    isFile: () => !path.endsWith('.artifacts') && state.mode !== 'special-file', dev: 1n,
    ino: state.mode === 'directory-swap' && state.opened.length > 1 ? 2n : 1n,
    mode: path.endsWith('.artifacts') ? 0o40700n : 0o100600n, uid: 500n, gid: 500n, nlink: 1n,
    size: BigInt(state.mode === 'oversized' ? 2_000_001 : path.endsWith('.claim') ? 0 : state.bytes.length),
    mtimeNs: 1n, ctimeNs: 1n });
  return { realpath: vi.fn(async (path: string) => state.mode === 'symlink-dir' ? `${path}-other` : path),
    lstat: vi.fn(async (path: string) => stat(path)),
    open: vi.fn(async (path: string, flags: number) => {
      state.opened.push({ path, flags });
      if (path.endsWith('.claim') && ['missing-claim', 'symlink-file'].includes(state.mode)) throw new Error('private path');
      return { stat: async () => stat(path), close: async () => { state.closes++; },
        read: async (buffer: Buffer, offset: number, length: number, position: number) => {
          state.reads++;
          const bytesRead = path.endsWith('.claim') ? 0 : Math.min(length, state.bytes.length - position);
          state.bytes.copy(buffer, offset, position, position + bytesRead);
          return { bytesRead };
        } };
    }) };
});
import { CARRY_REPORT_SHA256, compareCloudflareCarryForward } from '../../evals/cloudflare-carry-forward';
import { SECOND_CARRY_REPORT_SHA256, SECOND_CARRY_SCHEMA,
  compareCloudflareSecondCarryForward, readCloudflareSecondCarryForward } from '../../evals/cloudflare-carry-forward-2';

function fixture() {
  const old = firstFixture();
  const prior = { ...compareCloudflareCarryForward(old.report, old.baseline, old.snapshot), sourceSha256: CARRY_REPORT_SHA256() };
  const runId = 'cd18d166-fc0a-4f05-8ecc-751ed9577ae6';
  const run = { id: runId, status: 'failed', proposal_id: null, interrupt_id: null, decision: null };
  const usage = structuredClone(old.snapshot.usage[0]);
  usage.runId = runId;
  Object.assign(usage.invocations[0], { run_id: runId, logical_run_id: runId, charged_cost_micros: '681', actual_cost_micros: '681' });
  Object.assign(usage.calls[0], { run_id: runId, usage: { promptTokens: 4208, outputTokens: 866, totalTokens: 5074 } });
  const events = [ { run_id: runId, sequence: 1, event: { type: 'RUN_STARTED' } },
    { run_id: runId, sequence: 2, event: { type: 'RUN_ERROR' } } ];
  const audit = { kind: 'durable-audit', caseId: 'locked-budget', round: 1, chargedMicros: 681,
    runs: [run], events, privateUsage: [usage], privateUsageComplete: true, quiescent: true };
  const report = { model: usage.binding.model, accountId: usage.binding.accountId, prior: structuredClone(prior),
    stopped: 'FAILED_RUN_STOP', textReview: 'pending', evaluationGatePassed: false, accountingComplete: false,
    dispatchAuthorized: false, historicalUnknownReceipts: 1, chargedMicros: 681, invocations: 1, modelCalls: 1,
    totalTokens: 5074, cumulativeChargedMicros: 188948, cumulativeInvocations: 9, cumulativeModelCalls: 12,
    cumulativeTokens: null, records: [audit, ...Array(8).fill(null)] };
  const snapshot = { counts: { runs: 1, trips: 1, invocations: 1, calls: 1, reservations: 1, proposals: 0 },
    runs: [{ ...run, trip_id: 'ab07e87b-5a3f-4172-8624-7ffee813910e', owner_id: 'd73d8d06-7154-4962-89e4-c14d25b9e317', current_version: 1 }],
    events: structuredClone(events), usage: [structuredClone(usage)] };
  return { report, prior, snapshot };
}
beforeEach(() => {
  const f = fixture();
  Object.assign(state, { bytes: Buffer.from(JSON.stringify(f.report)), prior: f.prior, mode: '', locks: 0,
    historyReads: 0, reads: 0, closes: 0, opened: [] });
});
const expected = { historyConsistent: true, dispatchAuthorized: false, accountingComplete: false,
  evaluationGatePassed: false, historicalUnknownReceipts: 1, invocations: 9, modelCalls: 12,
  chargedMicros: 188948, observedTokens: 51739, totalTokens: null,
  remainingInvocationCeiling: 91, remainingReferenceMicros: 2811052 };
test('pure comparison preserves unknown history, has exact summary and never mutates inputs', () => {
  const f = fixture(), before = structuredClone(f);
  expect(compareCloudflareSecondCarryForward(f.report, f.prior, f.snapshot)).toEqual(expected);
  expect(f).toEqual(before);
});
test.each(Object.keys(fixture().prior))('rejects changed old carry field: %s, even when report agrees', key => {
  const f = fixture();
  Object.assign(f.prior, { [key]: 'tampered' }); Object.assign(f.report.prior, { [key]: 'tampered' });
  expect(() => compareCloudflareSecondCarryForward(f.report, f.prior, f.snapshot)).toThrow('CLOUDFLARE_SECOND_CARRY_FORWARD_INVALID');
});
test.each(Object.keys(fixture().snapshot.counts))('rejects full inventory change: %s', key => {
  const f = fixture(); Object.assign(f.snapshot.counts, { [key]: 2 });
  expect(() => compareCloudflareSecondCarryForward(f.report, f.prior, f.snapshot)).toThrow('CLOUDFLARE_SECOND_CARRY_FORWARD_INVALID');
});
const mutations: [string, (f: ReturnType<typeof fixture>) => void][] = [
  ['owner', f => { f.snapshot.runs[0].owner_id = 'a1109568-64ae-4719-8ad6-bbcb033c828a'; }],
  ['trip', f => { f.snapshot.runs[0].trip_id = f.snapshot.runs[0].owner_id; }],
  ['version', f => { f.snapshot.runs[0].current_version = 2; }],
  ['run status', f => { f.snapshot.runs[0].status = 'succeeded'; }],
  ['extra event', f => { f.snapshot.events.push(f.snapshot.events[0]); }],
  ['changed event', f => { f.snapshot.events[1].event.type = 'RUN_FINISHED'; }],
  ['foreign event', f => { f.snapshot.events[1].run_id = f.snapshot.runs[0].owner_id; }],
  ['extra call', f => { f.snapshot.usage[0].calls.push(f.snapshot.usage[0].calls[0]); }],
  ['extra invocation', f => { f.snapshot.usage[0].invocations.push(f.snapshot.usage[0].invocations[0]); }],
  ['foreign call', f => { f.snapshot.usage[0].calls[0].invocation_id = f.snapshot.runs[0].owner_id; }],
  ['provider', f => { f.snapshot.usage[0].binding.provider = 'gemini'; }],
  ['account', f => { f.snapshot.usage[0].invocations[0].account_id = 'a'.repeat(32); }],
  ['model', f => { f.snapshot.usage[0].invocations[0].model = 'other'; }],
  ['reservation binding', f => { f.snapshot.usage[0].invocations[0].logical_run_id = f.snapshot.runs[0].owner_id; }],
  ['unknown cost', f => { f.snapshot.usage[0].invocations[0].actual_cost_micros = null; }],
  ['charge', f => { f.snapshot.usage[0].invocations[0].charged_cost_micros = '682'; }],
  ['usage', f => { f.snapshot.usage[0].calls[0].usage.totalTokens++; }],
  ['usage timestamp', f => { f.snapshot.usage[0].calls[0].started_at = '2026-09-26T06:00:00.000Z'; }],
  ['report audit', f => { f.report.records[0].privateUsageComplete = false; }],
  ['report total', f => { f.report.cumulativeChargedMicros++; }],
  ['report gate', f => { f.report.evaluationGatePassed = true; }],
];
test.each(mutations)('rejects second-history tamper: %s', (_, mutate) => {
  const f = fixture(); mutate(f);
  expect(() => compareCloudflareSecondCarryForward(f.report, f.prior, f.snapshot)).toThrow('CLOUDFLARE_SECOND_CARRY_FORWARD_INVALID');
});

function poolFor() {
  let snapshots = 0;
  const release = vi.fn();
  const query = vi.fn(async (q: { text: string; query_timeout: number }) => {
    if (state.mode === 'query-failure') throw new Error('private query');
    if (q.text.startsWith('BEGIN')) snapshots++;
    const f = fixture().snapshot;
    if (state.mode === 'owner-swapped-together') f.runs[0].owner_id = 'a1109568-64ae-4719-8ad6-bbcb033c828a';
    if (snapshots === 2 && state.mode === 'inventory-change') f.counts.calls++;
    if (snapshots === 2 && state.mode === 'usage-change') f.usage[0].calls[0].usage.totalTokens++;
    if (q.text.includes('current_database')) return { rows: [{ database: 'dive_trip_test',
      schema: state.mode === 'wrong-schema' ? 'public' : SECOND_CARRY_SCHEMA() }] };
    if (q.text.includes('count(*)')) return { rows: [f.counts] };
    if (q.text.includes('FROM agent_runs')) return { rows: f.runs };
    if (q.text.includes('FROM agent_run_events')) return { rows: f.events };
    if (q.text.includes('FROM agent_invocations')) return { rows: f.usage[0].invocations.map(i => ({ ...i,
      reservation_owner_id: state.mode === 'foreign-owner' ? i.id : f.runs[0].owner_id })) };
    if (q.text.includes('FROM model_calls')) return { rows: state.mode === 'extra-row' ? [...f.usage[0].calls, ...f.usage[0].calls] : f.usage[0].calls };
    return { rows: [] };
  });
  const connect = vi.fn(async () => ({ query, release }));
  const pool = { options: { host: '127.0.0.1', port: 1, database: 'dive_trip_test', user: 'postgres', ssl: false,
    password: 'offline-placeholder-not-a-credential', connectionTimeoutMillis: 1000, statement_timeout: 1000 },
    connect } as unknown as Pool;
  return { pool, query, release, connect };
}
const lease = {} as EvaluationLockLease;
test('IO uses fixed bounded readonly snapshots and rechecks both histories and owned lease', async () => {
  const workbench = poolFor(), first = poolFor(), second = poolFor();
  expect(await readCloudflareSecondCarryForward(workbench.pool, first.pool, second.pool, lease))
    .toEqual({ ...expected, sourceSha256: SECOND_CARRY_REPORT_SHA256() });
  expect(state.historyReads).toBe(2); expect(state.locks).toBe(8);
  expect(second.query.mock.calls.filter(([q]) => q.text.startsWith('BEGIN'))).toHaveLength(2);
  expect(second.query.mock.calls.every(([q]) => q.query_timeout === 2000 && !/\b(UPDATE|INSERT|DELETE|DROP)\b/.test(q.text))).toBe(true);
  expect(second.release).toHaveBeenCalledTimes(2); expect(second.release).toHaveBeenCalledWith(true);
  expect(state.opened.every(o => (o.flags & constants.O_NOFOLLOW) !== 0)).toBe(true);
  expect(state.opened.filter(o => !o.path.endsWith('.artifacts')).every(o => (o.flags & constants.O_NONBLOCK) !== 0)).toBe(true);
});
test.each(['inventory-change', 'usage-change', 'query-failure', 'wrong-schema', 'foreign-owner', 'owner-swapped-together', 'extra-row',
  'old-history-changed', 'lost-lease', 'no-lease', 'missing-claim', 'special-file', 'oversized', 'symlink-dir',
  'symlink-file', 'directory-swap', 'wrong-hash'])( 'IO fails closed with sanitized error: %s', async mode => {
  state.mode = mode;
  const w = poolFor(), f = poolFor(), s = poolFor();
  await expect(readCloudflareSecondCarryForward(w.pool, f.pool, s.pool, lease)).rejects.toThrow(/^CLOUDFLARE_SECOND_CARRY_FORWARD_INVALID$/);
  expect(s.release.mock.calls.length).toBe(s.connect.mock.calls.length);
});
test.each([{ host: 'remote.invalid' }, { database: 'production' }, { user: undefined }, { ssl: undefined },
  { password: undefined }, { connectionString: 'postgresql://localhost/test' }, { port: 0 },
  { connectionTimeoutMillis: 0 }, { statement_timeout: 0 }])('all three pools require explicit bounded offline fields: %j', async override => {
  for (const index of [0, 1, 2]) {
    const pools = [poolFor(), poolFor(), poolFor()]; Object.assign(pools[index].pool.options, override);
    await expect(readCloudflareSecondCarryForward(pools[0].pool, pools[1].pool, pools[2].pool, lease))
      .rejects.toThrow('CLOUDFLARE_SECOND_CARRY_FORWARD_INVALID');
    expect(pools.every(p => p.query.mock.calls.length === 0)).toBe(true);
  }
});
