import type { Pool } from 'pg';
import { expect, test, vi } from 'vitest';
import { auditCloudflareSmoke, validateCloudflareSmokeAudit, verifyCloudflareSmokeDatabase } from '../support/cloudflare-smoke-audit';
import { withCloudflareAuditDatabase, withCloudflareRetainedAuditDatabase, CLOUDFLARE_RETAINED_SCHEMA,
  withCloudflareQualityAuditDatabase, CLOUDFLARE_QUALITY_RETAINED_SCHEMA, assertCloudflareAuditPools, assertCloudflareAuditPool,
  type CloudflareAuditQuery } from '../support/cloudflare-audit-database';
import { CLOUDFLARE_MODEL, CLOUDFLARE_PRICE_BASIS } from '../../src/agent/cloudflare-wire';

const accountId = 'a'.repeat(32);
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tripId = uuid(1), runId = uuid(2);
type Rows = { invocations: Record<string, unknown>[]; calls: Record<string, unknown>[] };
function fixture(two = false): Rows {
  const invocation = (n: number, kind: string, cost: number) => ({ id: uuid(n), run_id: runId, reservation_id: uuid(n + 10),
    provider: 'cloudflare', model: CLOUDFLARE_MODEL, account_id: accountId, kind, status: 'settled',
    reservation_status: 'settled', logical_run_id: runId, actual_cost_micros: String(cost), charged_cost_micros: String(cost) });
  const call = (n: number, parent: number) => ({ invocation_id: uuid(parent), run_id: runId, call_id: `call-${n}`, status: 'completed',
    usage: { promptTokens: 20, outputTokens: 8, totalTokens: 28 },
    provider_evidence: { provider: 'cloudflare', returnedModel: `${CLOUDFLARE_MODEL}-external`, priceBasis: CLOUDFLARE_PRICE_BASIS } });
  return two ? { invocations: [invocation(3, 'start', 10), invocation(4, 'resume', 5)], calls: [call(1, 3), call(2, 3), call(3, 4)] }
    : { invocations: [invocation(3, 'start', 5)], calls: [call(1, 3)] };
}
function incomplete(rows: unknown) {
  const result = validateCloudflareSmokeAudit(rows, accountId);
  expect(result.complete).toBe(false);
  expect(result.costMicros).toBeNull();
  expect(result.tokens).toBeNull();
  return result;
}

test.each([false, true])('sanitized audit validates each ledger and inclusive output tokens (resume=%s)', two => {
  const result = validateCloudflareSmokeAudit(fixture(two), accountId);
  expect(result.complete).toBe(true);
  expect(result.runId).toBe(runId);
  expect(result.modelCalls).toBe(two ? 3 : 1);
  expect(result.costMicros).toBe(two ? 15 : 5);
  expect(result.tokens).toEqual(two ? { promptTokens: 60, outputTokens: 24, totalTokens: 84 }
    : { promptTokens: 20, outputTokens: 8, totalTokens: 28 });
  expect(result.invocations.every(row => row.bindingValid && row.settled && row.ledgerMatches)).toBe(true);
  expect(result.calls.every(row => row.completed && row.bindingValid && row.costMicros === 5)).toBe(true);
  expect(JSON.stringify(result)).not.toMatch(/call-1|account_id|returnedModel/);
  expect(JSON.stringify(result)).not.toContain(uuid(3));
  expect(JSON.stringify(result)).not.toContain(accountId);
});

test.each([
  ['provider', 'gemini'], ['model', '@cf/other/model'], ['account_id', 'b'.repeat(32)], ['account_id', null],
  ['account_id', `${accountId}\n`], ['status', 'active'], ['reservation_status', 'reserved'],
  ['actual_cost_micros', null], ['actual_cost_micros', '4'], ['charged_cost_micros', '6'],
  ['actual_cost_micros', '9007199254740992'], ['actual_cost_micros', '5\n'], ['logical_run_id', uuid(99)],
] as const)('invocation %s=%s cannot produce complete evidence', (field, value) => {
  const rows = fixture(); rows.invocations[0][field] = value; incomplete(rows);
});

test.each([null, undefined, {}, { promptTokens: 20, outputTokens: 8, totalTokens: 30 },
  { promptTokens: -1, outputTokens: 8, totalTokens: 7 }, { promptTokens: 20, outputTokens: 8.5, totalTokens: 28.5 },
  { promptTokens: 20, outputTokens: 8, totalTokens: 28, thoughtTokens: 2 },
  { promptTokens: 20, outputTokens: 8, totalTokens: 28, cachedTokens: 21 },
  { promptTokens: 20, outputTokens: 8, totalTokens: 28, prompt: 'private-prompt' },
])('missing/malformed usage stays unknown (%j)', usage => {
  const rows = fixture(); rows.calls[0].usage = usage;
  const result = incomplete(rows);
  expect(result.calls[0].costMicros).toBeNull();
  expect(result.calls[0].tokens).toBeNull();
  expect(JSON.stringify(result)).not.toContain('private-prompt');
});

test.each([null, {}, { provider: 'cloudflare', returnedModel: '@cf/other/model', priceBasis: CLOUDFLARE_PRICE_BASIS },
  { provider: 'cloudflare', returnedModel: CLOUDFLARE_MODEL, priceBasis: 'wrong' },
  { provider: 'openrouter', returnedModel: 'example/free', generationId: 'private-key', reportedCostMicros: 0 },
])('missing/foreign evidence stays unknown (%j)', provider_evidence => {
  const rows = fixture(); rows.calls[0].provider_evidence = provider_evidence;
  expect(incomplete(rows).calls[0].costMicros).toBeNull();
});

test('accepts approved model and cached input without discount; known zero is distinct from unknown', () => {
  const rows = fixture();
  rows.calls[0].provider_evidence = { provider: 'cloudflare', returnedModel: CLOUDFLARE_MODEL, priceBasis: CLOUDFLARE_PRICE_BASIS };
  rows.calls[0].usage = { promptTokens: 20, outputTokens: 8, totalTokens: 28, cachedTokens: 20 };
  expect(validateCloudflareSmokeAudit(rows, accountId).costMicros).toBe(5);
  rows.calls[0].usage = { promptTokens: 0, outputTokens: 0, totalTokens: 0 };
  rows.invocations[0].actual_cost_micros = 0; rows.invocations[0].charged_cost_micros = 0;
  expect(validateCloudflareSmokeAudit(rows, accountId)).toMatchObject({ complete: true, costMicros: 0 });
});

test('per-invocation mismatches cannot cancel out in aggregate', () => {
  const rows = fixture(true);
  rows.invocations[0].actual_cost_micros = '5'; rows.invocations[0].charged_cost_micros = '5';
  rows.invocations[1].actual_cost_micros = '10'; rows.invocations[1].charged_cost_micros = '10';
  incomplete(rows);
});

test.each(['empty', 'too-many-invocations', 'too-many-calls', 'duplicate-call', 'foreign-call', 'foreign-run',
  'duplicate-invocation', 'duplicate-reservation', 'second-run', 'no-start', 'unfinished', 'no-child'] as const)(
  'cardinality and relational integrity fail closed: %s', failure => {
    const rows = fixture(true);
    switch (failure) {
      case 'empty': rows.invocations = []; rows.calls = []; break;
      case 'too-many-invocations': rows.invocations.push({ ...rows.invocations[0] }); break;
      case 'too-many-calls': rows.calls = Array.from({ length: 8 }, (_, i) => ({ ...rows.calls[0], call_id: `call-${i}` })); break;
      case 'duplicate-call': rows.calls[1].call_id = rows.calls[0].call_id; break;
      case 'foreign-call': rows.calls[0].invocation_id = uuid(99); break;
      case 'foreign-run': rows.calls[0].run_id = uuid(99); break;
      case 'duplicate-invocation': rows.invocations[1].id = rows.invocations[0].id; break;
      case 'duplicate-reservation': rows.invocations[1].reservation_id = rows.invocations[0].reservation_id; break;
      case 'second-run': rows.invocations[1].run_id = uuid(99); rows.invocations[1].logical_run_id = uuid(99); rows.calls[2].run_id = uuid(99); break;
      case 'no-start': rows.invocations[0].kind = 'resume'; break;
      case 'unfinished': rows.calls[0].status = 'started'; break;
      case 'no-child': rows.calls.pop(); break;
    }
    incomplete(rows);
  });

test('seven calls is accepted but malformed containers and expected account are not', () => {
  const rows = fixture(); rows.calls = Array.from({ length: 7 }, (_, i) => ({ ...rows.calls[0], call_id: `call-${i}` }));
  rows.invocations[0].actual_cost_micros = '35'; rows.invocations[0].charged_cost_micros = '35';
  expect(validateCloudflareSmokeAudit(rows, accountId).complete).toBe(true);
  for (const malformed of [null, {}, { invocations: [null], calls: [null] }, { invocations: [], calls: Array(9).fill({}) }]) incomplete(malformed);
  expect(validateCloudflareSmokeAudit(rows, 'invalid').complete).toBe(false);
});

function mockPool(scope = { database: 'dive_trip_test', schema: 'workbench_live' }) {
  const rows = fixture();
  const query = vi.fn(async (config: { text: string; values?: string[]; query_timeout: number }) => {
    if (config.text.includes('current_database()')) return { rows: [scope] };
    if (config.text.includes('SELECT i.id')) return { rows: rows.invocations };
    if (config.text.includes('SELECT c.invocation_id')) return { rows: rows.calls };
    return { rows: [] };
  });
  const release = vi.fn();
  const client = { query, release };
  const connect = vi.fn(async () => client);
  return { pool: { connect } as unknown as Pool, connect, client, query, release };
}

test('retained audit has its own fixed scope and shares bounded read-only lifecycle', async () => {
  const scoped = mockPool({ database: 'dive_trip_test', schema: CLOUDFLARE_RETAINED_SCHEMA() });
  expect(await withCloudflareRetainedAuditDatabase(scoped.pool, async query => { await query('SELECT 1'); return true; })).toBe(true);
  expect(scoped.query.mock.calls[0][0].text).toContain('READ ONLY');
  expect(scoped.query.mock.calls.every(([q]) => q.query_timeout === 2000)).toBe(true);
  expect(scoped.release).toHaveBeenCalledWith(true);
  await expect(withCloudflareAuditDatabase(scoped.pool, async () => true)).rejects.toThrow('CLOUDFLARE_AUDIT_DATABASE_FAILED');
  await expect(withCloudflareRetainedAuditDatabase(mockPool().pool, async () => true)).rejects.toThrow('CLOUDFLARE_AUDIT_DATABASE_FAILED');
});

test('quality audit uses only its fixed retained schema, bounded read-only queries and discarded connection', async () => {
  const scoped = mockPool({ database: 'dive_trip_test', schema: CLOUDFLARE_QUALITY_RETAINED_SCHEMA() });
  expect(await withCloudflareQualityAuditDatabase(scoped.pool, async query => { await query('SELECT 1'); return true; })).toBe(true);
  expect(scoped.query.mock.calls[0][0].text).toContain('READ ONLY');
  expect(scoped.query.mock.calls.every(([q]) => q.query_timeout === 2000)).toBe(true);
  expect(scoped.release).toHaveBeenCalledWith(true);
  const wrong = mockPool(); const work = vi.fn();
  await expect(withCloudflareQualityAuditDatabase(wrong.pool, work)).rejects.toThrow('CLOUDFLARE_AUDIT_DATABASE_FAILED');
  expect(work).not.toHaveBeenCalled(); expect(wrong.release).toHaveBeenCalledWith(true);
});

test('shared pool admission rejects fallback fields, foreign endpoints and aliased pools before connecting', () => {
  const options = { host: '127.0.0.1', port: 1234, user: 'postgres', database: 'dive_trip_test', ssl: false,
    password: 'offline-placeholder-not-a-credential', connectionTimeoutMillis: 2000, statement_timeout: 2000 };
  const pool = (patch = {}) => ({ options: { ...options, ...patch } }) as unknown as Pool;
  expect(() => assertCloudflareAuditPools([pool(), pool(), pool(), pool()])).not.toThrow();
  expect(() => assertCloudflareAuditPool(pool({ port: 1235 }))).not.toThrow();
  for (const patch of [{ connectionString: '' }, { host: 'example.com' }, { database: 'postgres' }, { user: 'other' },
    { password: undefined }, { ssl: true }, { port: 0 }, { port: 65536 }, { port: 1235 },
    { connectionTimeoutMillis: 0 }, { statement_timeout: 10001 }]) {
    expect(() => assertCloudflareAuditPools([pool(), pool(patch)])).toThrow('CLOUDFLARE_AUDIT_DATABASE_FAILED');
    if (!('port' in patch && patch.port === 1235)) {
      expect(() => assertCloudflareAuditPool(pool(patch))).toThrow('CLOUDFLARE_AUDIT_DATABASE_FAILED');
    }
  }
  const shared = pool(); expect(() => assertCloudflareAuditPools([shared, shared])).toThrow();
  expect(() => assertCloudflareAuditPools([])).toThrow();
});

test('PG audit checks fixed scope then reads bounded explicit projections in one read-only snapshot', async () => {
  const s = mockPool();
  expect((await auditCloudflareSmoke(s.pool, tripId, accountId)).complete).toBe(true);
  const queries = s.query.mock.calls.map(([config]) => config);
  expect(queries[0].text).toBe('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  expect(queries[1].text).toContain('statement_timeout');
  expect(queries[2].text).toContain('current_schema()');
  expect(queries[3].text).toContain('workbench_live.agent_invocations');
  expect(queries[3].text).toContain('LIMIT 3');
  expect(queries[4].text).toContain('workbench_live.model_calls');
  expect(queries[4].text).toContain('LIMIT 8');
  expect(queries[3].values).toEqual([tripId]); expect(queries[4].values).toEqual([tripId]);
  expect(queries.every(q => q.query_timeout === 2000)).toBe(true);
  expect(queries.map(q => q.text).join('\n')).not.toMatch(/SELECT \*|search_path|\b(INSERT|UPDATE|DELETE|DROP)\b/);
  expect(s.release).toHaveBeenCalledExactlyOnceWith(true);
});

test.each([{ database: 'other', schema: 'workbench_live' }, { database: 'dive_trip_test', schema: 'public' }])(
  'wrong database/schema rejects before ledger reads (%j)', async scope => {
    const s = mockPool(scope);
    await expect(auditCloudflareSmoke(s.pool, tripId, accountId)).rejects.toThrow(/^CLOUDFLARE_SMOKE_AUDIT_FAILED$/);
    expect(s.query).toHaveBeenCalledTimes(3);
    expect(s.release).toHaveBeenCalledExactlyOnceWith(true);
  });

test('bad input never connects and database errors are sanitized', async () => {
  const s = mockPool();
  await expect(auditCloudflareSmoke(s.pool, 'bad', accountId)).rejects.toThrow('CLOUDFLARE_SMOKE_AUDIT_INPUT');
  await expect(auditCloudflareSmoke(s.pool, tripId, `${accountId}\n`)).rejects.toThrow('CLOUDFLARE_SMOKE_AUDIT_INPUT');
  expect(s.connect).not.toHaveBeenCalled();
  s.query.mockRejectedValueOnce(new Error('private-password session-token prompt'));
  await expect(auditCloudflareSmoke(s.pool, tripId, accountId)).rejects.toThrow(/^CLOUDFLARE_SMOKE_AUDIT_FAILED$/);
  expect(s.release).toHaveBeenCalledExactlyOnceWith(true);
});

test('database preflight checks fixed identity in a read-only transaction and releases its own connection', async () => {
  const s = mockPool();
  await expect(verifyCloudflareSmokeDatabase(s.pool)).resolves.toBeUndefined();
  expect(s.query).toHaveBeenCalledTimes(3);
  expect(s.release).toHaveBeenCalledExactlyOnceWith(true);
  const wrong = mockPool({ database: 'dive_trip_test', schema: 'public' });
  await expect(verifyCloudflareSmokeDatabase(wrong.pool)).rejects.toThrow(/^CLOUDFLARE_SMOKE_AUDIT_FAILED$/);
  expect(wrong.release).toHaveBeenCalledExactlyOnceWith(true);
});

test.each([0, 1, 2, 3])('shared executor destroys the client on query failure at step %s', async step => {
  const s = mockPool(); const original = s.query.getMockImplementation()!;
  let index = 0;
  s.query.mockImplementation(async config => {
    if (index++ === step) throw new Error('private-database-error');
    return original(config);
  });
  const work = vi.fn(async (query: CloudflareAuditQuery) => {
    await query('SELECT 1');
  });
  await expect(withCloudflareAuditDatabase(s.pool, work)).rejects.toThrow(/^CLOUDFLARE_AUDIT_DATABASE_FAILED$/);
  expect(work).toHaveBeenCalledTimes(step < 3 ? 0 : 1);
  expect(s.release).toHaveBeenCalledExactlyOnceWith(true);
});

test('shared executor propagates result, binds query values and sanitizes callback failure', async () => {
  const s = mockPool();
  expect(await withCloudflareAuditDatabase(s.pool, async query => {
    await query('SELECT $1', ['synthetic']); return 42;
  })).toBe(42);
  expect(s.query.mock.calls[3][0]).toEqual({ text: 'SELECT $1', values: ['synthetic'], query_timeout: 2000 });
  expect(s.release).toHaveBeenCalledExactlyOnceWith(true);
  const failed = mockPool();
  await expect(withCloudflareAuditDatabase(failed.pool, async () => { throw new Error('private-payload'); }))
    .rejects.toThrow(/^CLOUDFLARE_AUDIT_DATABASE_FAILED$/);
  expect(failed.release).toHaveBeenCalledExactlyOnceWith(true);
});

test('pool acquisition is bounded and a late connection is destroyed', async () => {
  vi.useFakeTimers();
  try {
    const s = mockPool();
    let finish!: (client: typeof s.client) => void;
    s.connect.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = expect(auditCloudflareSmoke(s.pool, tripId, accountId)).rejects.toThrow(/^CLOUDFLARE_SMOKE_AUDIT_FAILED$/);
    await vi.advanceTimersByTimeAsync(2000); await pending;
    finish(s.client); await Promise.resolve();
    expect(s.query).not.toHaveBeenCalled();
    expect(s.release).toHaveBeenCalledExactlyOnceWith(true);
  } finally { vi.useRealTimers(); }
});
