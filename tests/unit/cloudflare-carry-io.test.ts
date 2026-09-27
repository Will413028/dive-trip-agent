import { beforeEach, expect, test, vi } from 'vitest';
import type { Pool } from 'pg';
import { fixture } from '../support/cloudflare-carry-fixture';

// Synthetic IO orchestration: hash is stubbed only in this file. Real hash/file
// rejection is covered separately; no private artifact is needed by unit tests.
const state = vi.hoisted(() => ({ bytes: Buffer.alloc(0), baseline: {} as unknown,
  mode: '', payloadOpened: false, reads: 0, payloadReads: 0, closes: 0, lockChecks: 0, held: false }));
vi.mock('../../evals/live-evaluation-lock', () => ({ assertEvaluationLock: vi.fn(async () => {
  state.lockChecks++;
  if (!state.held || (state.mode === 'lost-lease' && state.lockChecks > 6)) throw new Error('EVAL_LOCK_NOT_OWNED');
}) }));
vi.mock('node:crypto', async original => ({ ...await original<typeof import('node:crypto')>(),
  createHash: () => ({ update: () => ({ digest: () => 'a4871418af3515b4b8a0b4370c53a3cc1836eb1566dcb9a99e71ead14e829cb2' }) }) }));
vi.mock('../../evals/cloudflare-campaign-history', () => ({ readCloudflareCampaignBaseline: vi.fn(async () => structuredClone(state.baseline)) }));
vi.mock('node:fs/promises', () => ({
  realpath: vi.fn(async (path: string) => path),
  lstat: vi.fn(async (path: string) => {
    if (path.endsWith('.lock') && !state.held) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return { isDirectory: () => path.endsWith('.artifacts'), isFile: () => !path.endsWith('.artifacts'),
      dev: 1n, ino: state.mode === 'directory-swap' && state.payloadOpened ? 2n : 1n,
      mode: path.endsWith('.artifacts') ? 0o40700n : 0o100600n, uid: 500n, gid: 500n, nlink: 1n,
      size: BigInt(path.endsWith('.claim') ? 0 : state.bytes.length), mtimeNs: 1n, ctimeNs: 1n };
  }),
  open: vi.fn(async (path: string) => {
    if (path.endsWith('.claim') && state.mode === 'missing-claim') throw new Error('synthetic private path');
    if (path.endsWith('.json')) state.payloadOpened = true;
    return { stat: async () => ({ isDirectory: () => path.endsWith('.artifacts'),
      isFile: () => !path.endsWith('.artifacts'), dev: 1n, ino: 1n,
      mode: path.endsWith('.artifacts') ? 0o40700n : 0o100600n, uid: 500n, gid: 500n, nlink: 1n,
      size: BigInt(path.endsWith('.claim') ? 0 : state.bytes.length), mtimeNs: 1n, ctimeNs: 1n }),
      read: async (buffer: Buffer, offset: number, length: number, position: number) => {
        state.reads++; if (path.endsWith('.json')) state.payloadReads++;
        const bytesRead = path.endsWith('.claim') ? 0 : Math.min(length, state.bytes.length - position);
        state.bytes.copy(buffer, offset, position, position + bytesRead); return { bytesRead };
      }, close: async () => { state.closes++; } };
  }),
}));
import { readCloudflareCarryForward, CARRY_SCHEMA } from '../../evals/cloudflare-carry-forward';
import type { EvaluationLockLease } from '../../evals/live-evaluation-lock';

beforeEach(() => {
  const f = fixture(); Object.assign(state, { bytes: Buffer.from(JSON.stringify(f.report)), baseline: f.baseline,
    mode: '', payloadOpened: false, reads: 0, payloadReads: 0, closes: 0, lockChecks: 0, held: false });
});

function poolFor(mode = '') {
  let snapshot = 0;
  const release = vi.fn();
  const query = vi.fn(async (q: { text: string; query_timeout: number }) => {
    if (mode === 'query-failure') throw new Error('private database detail');
    if (q.text.startsWith('BEGIN')) snapshot++;
    const f = fixture().snapshot;
    if (snapshot === 2 && mode === 'inventory-change') f.counts.calls++;
    if (snapshot === 2 && mode === 'usage-change') f.usage[1].invocations[0].charged_cost_micros = '100';
    if (q.text.includes('current_database')) return { rows: [{ database: 'dive_trip_test', schema: CARRY_SCHEMA() }] };
    if (q.text.includes('count(*)')) return { rows: [f.counts] };
    if (q.text.includes('FROM agent_runs')) return { rows: f.runs };
    if (q.text.includes('FROM agent_run_events')) return { rows: f.events };
    if (q.text.includes('FROM agent_invocations')) return { rows: f.usage.flatMap((u, i) =>
      u.invocations.map(v => ({ ...v, reservation_owner_id: f.runs[i].owner_id }))) };
    if (q.text.includes('FROM model_calls')) {
      const rows = f.usage.flatMap(u => u.calls);
      if (snapshot === 2 && mode === 'extra-row') rows.push({ ...rows[0], call_id: 'extra' });
      if (snapshot === 2 && mode === 'foreign-row') rows[0].run_id = rows[1].run_id;
      return { rows };
    }
    return { rows: [] };
  });
  const pool = { options: { host: '127.0.0.1', port: 1, database: 'dive_trip_test', user: 'postgres', ssl: false,
    password: 'offline-placeholder-not-a-credential', connectionTimeoutMillis: 1000, statement_timeout: 1000 },
    connect: vi.fn(async () => ({ query, release })) } as unknown as Pool;
  return { pool, query, release };
}

test('IO joins full inventory and usage in each same bounded read-only snapshot', async () => {
  const p = poolFor();
  expect(await readCloudflareCarryForward(p.pool, p.pool)).toMatchObject({ historyConsistent: true,
    dispatchAuthorized: false, accountingComplete: false, totalTokens: null });
  expect(p.query.mock.calls.filter(([q]) => q.text.startsWith('BEGIN'))).toHaveLength(2);
  expect(p.query.mock.calls.every(([q]) => q.query_timeout === 2000 && !/\b(UPDATE|INSERT|DELETE|DROP)\b/.test(q.text))).toBe(true);
  expect(p.release).toHaveBeenCalledTimes(2);
  expect(p.release).toHaveBeenCalledWith(true);
});

test('owned lease is revalidated at both file reads and after final inventory', async () => {
  state.held = true; const p = poolFor();
  const result = await readCloudflareCarryForward(p.pool, p.pool, {} as EvaluationLockLease);
  expect(result.dispatchAuthorized).toBe(false);
  expect(state.lockChecks).toBe(7);
});

test('lost lease after final inventory refuses the checked summary', async () => {
  state.held = true; state.mode = 'lost-lease'; const p = poolFor();
  await expect(readCloudflareCarryForward(p.pool, p.pool, {} as EvaluationLockLease)).rejects.toThrow('CLOUDFLARE_CARRY_FORWARD_INVALID');
  expect(state.lockChecks).toBe(7);
  expect(p.query.mock.calls.filter(([q]) => q.text.startsWith('BEGIN'))).toHaveLength(2);
});

test('read-only caller still refuses the same existing lock without a lease', async () => {
  state.held = true; const p = poolFor();
  await expect(readCloudflareCarryForward(p.pool, p.pool)).rejects.toThrow('CLOUDFLARE_CARRY_FORWARD_INVALID');
  expect(state.lockChecks).toBe(0);
  expect(p.pool.connect).not.toHaveBeenCalled();
});

test.each(['inventory-change', 'usage-change', 'query-failure', 'extra-row', 'foreign-row'])(
  'IO rejects %s with only sanitized error and always destroys clients', async mode => {
    const p = poolFor(mode);
    await expect(readCloudflareCarryForward(p.pool, p.pool)).rejects.toThrow(/^CLOUDFLARE_CARRY_FORWARD_INVALID$/);
    expect(p.release).toHaveBeenCalledWith(true);
  });

test.each(['missing-claim', 'directory-swap'])(
  'valid synthetic report cannot mask %s rejection before payload read', async mode => {
    state.mode = mode; const p = poolFor();
    await expect(readCloudflareCarryForward(p.pool, p.pool)).rejects.toThrow(/^CLOUDFLARE_CARRY_FORWARD_INVALID$/);
    expect(p.pool.connect).not.toHaveBeenCalled();
    expect(state.payloadReads).toBe(0);
    expect(state.closes).toBeGreaterThan(0);
  });
