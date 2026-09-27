import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, test } from 'vitest';
import { database } from '../../src/server/db';
import { createSession } from '../../src/server/session';
import { reserveRun, settleRun, type QuotaPolicy, type ReserveRunInput } from '../../src/server/quota';
import { withDatabase } from '../support/database';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const policy: QuotaPolicy = { enabled: true, dailyBudgetMicros: 10_000,
  priceBasis: 'synthetic', reservationTtlMs: 60_000 };
// Dates are injected, but remain inside the real session TTL. Use tomorrow's
// Taipei noon so moving backwards to the midnight boundary is deterministic.
function clock() {
  const date = new Date();
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1, 4));
}
async function input(overrides: Partial<ReserveRunInput> = {}): Promise<ReserveRunInput> {
  return { ownerId: (await createSession()).id, ipKey: hash('synthetic-ip'), requestId: randomUUID(),
    payloadHash: hash('synthetic-payload'), maxCostMicros: 10, now: clock(), ...overrides };
}
async function settle(reservationId: string, actualCostMicros: number | null, now = clock()) {
  // Synthetic test clocks must progress to admission time, just like a server
  // captures a fresh timestamp before calling the trusted usage callback.
  const row = (await database().query<{ reserved_at: Date }>('SELECT reserved_at FROM quota_reservations WHERE id=$1', [reservationId])).rows[0];
  return settleRun({ reservationId, actualCostMicros,
    now: new Date(Math.max(now.getTime(), row?.reserved_at.getTime() ?? now.getTime())) });
}
async function ledger() {
  return (await database().query(`SELECT count(*)::int AS count,
    COALESCE(sum(charged_cost_micros),0)::text AS charged FROM quota_reservations`)).rows[0];
}
async function firstMinuteExpiry(ipKey: string): Promise<Date> {
  const row = (await database().query<{ boundary: Date }>(`
    SELECT min(reserved_at)+interval '1 minute' AS boundary
    FROM quota_reservations WHERE ip_key=$1`, [ipKey])).rows[0];
  return row.boundary;
}

test('default disabled; explicit positive budget and cost basis required; invalid inputs leave no receipt', () => withDatabase(async () => {
  const request = await input();
  await expect(reserveRun(request)).rejects.toMatchObject({ code: 'LIVE_DISABLED' });
  await expect(reserveRun({ ...request, maxCostMicros: 0 })).rejects.toMatchObject({ code: 'LIVE_DISABLED' });
  for (const invalid of [
    { ...policy, dailyBudgetMicros: 0 }, { ...policy, dailyBudgetMicros: Number.MAX_SAFE_INTEGER + 1 },
    { ...policy, priceBasis: undefined }, { ...policy, reservationTtlMs: 0 },
  ]) {
    await expect(reserveRun(request, invalid as QuotaPolicy)).rejects.toMatchObject({ code: 'INVALID_QUOTA_INPUT' });
    await expect(reserveRun({ ...request, maxCostMicros: 0 }, invalid as QuotaPolicy)).rejects.toMatchObject({ code: 'INVALID_QUOTA_INPUT' });
  }
  for (const invalid of [
    { ownerId: 'invalid' }, { ipKey: '127.0.0.1' }, { previousIpKey: '127.0.0.1' }, { payloadHash: 'not-a-digest' },
    { requestId: ' ' }, { requestId: '\0' }, { maxCostMicros: -1 }, { maxCostMicros: 0.5 },
    { maxCostMicros: Number.MAX_SAFE_INTEGER + 1 }, { now: new Date('invalid') },
  ]) await expect(reserveRun({ ...request, ...invalid }, policy)).rejects.toMatchObject({ code: 'INVALID_QUOTA_INPUT' });
  expect(await ledger()).toEqual({ count: 0, charged: '0' });
}));

test.each([0, 10])('UUID owner must exist and be live, including a %i-cost idempotent replay', maxCostMicros => withDatabase(async () => {
  const request = await input({ maxCostMicros });
  await expect(reserveRun({ ...request, ownerId: randomUUID() }, policy)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await reserveRun(request, policy);
  await database().query('UPDATE sessions SET expires_at=clock_timestamp() WHERE id=$1', [request.ownerId]);
  await expect(reserveRun(request, policy)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(reserveRun({ ...request, requestId: randomUUID() }, policy)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  expect((await ledger()).count).toBe(1);
}));

test.each([0, 10])('%i-cost concurrent replay creates once; payload/cost conflict; cross-day and IP rotation never re-debit', maxCostMicros => withDatabase(async () => {
  const request = await input({ maxCostMicros });
  const outcomes = await Promise.all(Array.from({ length: 10 }, () => reserveRun(request, policy)));
  expect(outcomes.filter(r => r.created)).toHaveLength(1);
  expect(new Set(outcomes.map(r => r.reservationId)).size).toBe(1);
  for (const override of [{ payloadHash: hash('changed') }, { maxCostMicros: maxCostMicros === 0 ? 10 : 0 }]) {
    await expect(reserveRun({ ...request, ...override }, policy)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  }
  const nextDay = new Date(request.now.getTime() + 86_400_000);
  const replay = await reserveRun({ ...request, now: nextDay, ipKey: hash('rotated'), previousIpKey: request.ipKey });
  expect(replay).toMatchObject({ reservationId: outcomes[0].reservationId, created: false, status: 'expired', day: outcomes[0].day });
  expect(await ledger()).toEqual({ count: 1, charged: String(maxCostMicros) });
  const other = await input({ requestId: request.requestId, ipKey: hash('other') });
  expect((await reserveRun(other, policy)).created).toBe(true);
}));

test('atomic budget reservation: concurrent losers leave no debit; uses exact integer arithmetic', () => withDatabase(async () => {
  const request = await input({ maxCostMicros: 6 });
  const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => reserveRun({
    ...request, requestId: `budget-${i}`,
  }, { ...policy, enabled: true, dailyBudgetMicros: 10 })));
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter(r => r.status === 'rejected').every(r => r.reason.code === 'QUOTA_BUDGET')).toBe(true);
  expect(await ledger()).toEqual({ count: 1, charged: '6' });
  const large = await input({ ipKey: hash('large'), maxCostMicros: Number.MAX_SAFE_INTEGER - 6 });
  await reserveRun(large, { ...policy, enabled: true, dailyBudgetMicros: Number.MAX_SAFE_INTEGER });
  await expect(reserveRun({ ...large, requestId: 'overflow', maxCostMicros: 1 }, {
    ...policy, enabled: true, dailyBudgetMicros: Number.MAX_SAFE_INTEGER,
  })).rejects.toMatchObject({ code: 'QUOTA_BUDGET' });
}));

test.each([0, 10])('%i-cost global concurrency is three across owners, IPs and Taipei midnight; expiry releases only capacity', maxCostMicros => withDatabase(async () => {
  const noon = clock();
  const midnight = new Date(noon.getTime() + 12 * 3_600_000);
  const before = new Date(midnight.getTime() - 10_000);
  const requests = await Promise.all(Array.from({ length: 8 }, (_, i) => input({ maxCostMicros, ipKey: hash(`ip-${i}`), now: before })));
  const results = await Promise.allSettled(requests.map(r => reserveRun(r, policy)));
  const successes = results.filter(r => r.status === 'fulfilled');
  expect(successes).toHaveLength(3);
  expect(results.filter(r => r.status === 'rejected').every(r => r.reason.code === 'QUOTA_CONCURRENCY')).toBe(true);
  const next = await input({ maxCostMicros, now: midnight, ipKey: hash('next') });
  await expect(reserveRun(next, policy)).rejects.toMatchObject({ code: 'QUOTA_CONCURRENCY' });
  const later = new Date(before.getTime() + 60_000);
  const admitted = await reserveRun({ ...next, now: later }, policy);
  expect(admitted.day).not.toBe(successes[0].value.day);
  expect(await ledger()).toEqual({ count: 4, charged: String(maxCostMicros * 4) });
}));

test('IP rolling minute is not a calendar-minute bucket; settlement does not refund request counts', () => withDatabase(async () => {
  const request = await input();
  const base = new Date(request.now.getTime() + 59_000);
  for (let i = 0; i < 5; i++) {
    const now = new Date(base.getTime() + i * 10_000);
    const r = await reserveRun({ ...request, requestId: `minute-${i}`, now }, policy);
    await settle(r.reservationId, 0, now);
  }
  await expect(reserveRun({ ...request, requestId: 'blocked', now: new Date(base.getTime() + 41_000) }, policy))
    .rejects.toMatchObject({ code: 'QUOTA_IP_MINUTE' });
  await expect(reserveRun({ ...request, maxCostMicros: 0, requestId: 'zero-blocked', now: new Date(base.getTime() + 41_000) }, policy))
    .rejects.toMatchObject({ code: 'QUOTA_IP_MINUTE' });
  const boundary = await firstMinuteExpiry(request.ipKey);
  expect((await reserveRun({ ...request, requestId: 'boundary', now: boundary }, policy)).created).toBe(true);
  // Once the oldest admission leaves the window, exactly one new slot opens;
  // the other four admissions are spaced 10s apart, not millisecond-close.
  await expect(reserveRun({ ...request, requestId: 'still-full', now: boundary }, policy))
    .rejects.toMatchObject({ code: 'QUOTA_IP_MINUTE' });
}));

test('rolling IP minute crosses Taipei midnight although day quotas reset', () => withDatabase(async () => {
  const request = await input();
  const midnight = new Date(request.now.getTime() + 12 * 3_600_000);
  const before = new Date(midnight.getTime() - 10_000);
  for (let i = 0; i < 5; i++) {
    const r = await reserveRun({ ...request, requestId: `old-${i}`, now: before }, policy);
    await settle(r.reservationId, 0, before);
  }
  await expect(reserveRun({ ...request, requestId: 'new', now: midnight }, policy)).rejects.toMatchObject({ code: 'QUOTA_IP_MINUTE' });
}));

test('daily salt rotation merges old and new IP keys for the rolling minute', () => withDatabase(async () => {
  const request = await input({ ipKey: hash('yesterday-salt:same-peer') });
  const midnight = new Date(request.now.getTime() + 12 * 3_600_000);
  const before = new Date(midnight.getTime() - 10_000);
  for (let i = 0; i < 4; i++) {
    const r = await reserveRun({ ...request, requestId: `salt-old-${i}`, now: before }, policy);
    await settle(r.reservationId, 0, before);
  }
  const rotated = { ...request, ipKey: hash('today-salt:same-peer'), previousIpKey: request.ipKey, now: midnight };
  const fifth = await reserveRun({ ...rotated, requestId: 'salt-fifth' }, policy);
  await settle(fifth.reservationId, 0, midnight);
  await expect(reserveRun({ ...rotated, requestId: 'salt-sixth' }, policy)).rejects.toMatchObject({ code: 'QUOTA_IP_MINUTE' });
  await expect(reserveRun({ ...rotated, maxCostMicros: 0, requestId: 'zero-salt-sixth' }, policy)).rejects.toMatchObject({ code: 'QUOTA_IP_MINUTE' });
  const boundary = await reserveRun({ ...rotated, requestId: 'salt-boundary', now: await firstMinuteExpiry(request.ipKey) }, policy);
  expect(boundary.created).toBe(true);
  expect((await database().query('SELECT count(*)::int AS count FROM quota_reservations WHERE ip_key=$1', [rotated.ipKey])).rows[0].count).toBe(2);
  expect(await ledger()).toEqual({ count: 6, charged: '10' });
}));

test('identical current and previous IP keys do not double-count usage', () => withDatabase(async () => {
  const request = await input();
  for (let i = 0; i < 4; i++) {
    const r = await reserveRun({ ...request, requestId: `same-key-${i}` }, policy);
    await settle(r.reservationId, 0);
  }
  const fifth = await reserveRun({ ...request, previousIpKey: request.ipKey, requestId: 'same-key-fifth' }, policy);
  expect(fifth.created).toBe(true);
  await expect(reserveRun({ ...request, previousIpKey: request.ipKey, requestId: 'same-key-sixth' }, policy))
    .rejects.toMatchObject({ code: 'QUOTA_IP_MINUTE' });
}));

test('session 20/day boundary independent of IP, resets at Taipei day', () => withDatabase(async () => {
  const request = await input();
  for (let i = 0; i < 20; i++) {
    const r = await reserveRun({ ...request, requestId: `session-${i}`, ipKey: hash(`session-ip-${i}`) }, policy);
    await settle(r.reservationId, 0);
  }
  await expect(reserveRun({ ...request, requestId: '21', ipKey: hash('21') }, policy)).rejects.toMatchObject({ code: 'QUOTA_SESSION_DAY' });
  await expect(reserveRun({ ...request, maxCostMicros: 0, requestId: 'zero-21', ipKey: hash('21') }, policy)).rejects.toMatchObject({ code: 'QUOTA_SESSION_DAY' });
  const nextDay = new Date(request.now.getTime() + 12 * 3_600_000);
  const r = await reserveRun({ ...request, requestId: 'tomorrow', now: nextDay }, policy);
  expect(r.created).toBe(true);
}), 20_000);

test('IP 100/day spans sessions, 101 rejected; rejected requests do not create ledger rows', () => withDatabase(async () => {
  const requests = await Promise.all(Array.from({ length: 6 }, () => input()));
  for (let i = 0; i < 100; i++) {
    const request = requests[Math.floor(i / 20)];
    const now = new Date(request.now.getTime() + i * 60_000);
    const r = await reserveRun({ ...request, requestId: `daily-${i}`, now }, policy);
    await settle(r.reservationId, 0, now);
  }
  await expect(reserveRun({ ...requests[5], now: new Date(requests[5].now.getTime() + 100 * 60_000) }, policy))
    .rejects.toMatchObject({ code: 'QUOTA_IP_DAY' });
  await expect(reserveRun({ ...requests[5], maxCostMicros: 0, now: new Date(requests[5].now.getTime() + 100 * 60_000) }, policy))
    .rejects.toMatchObject({ code: 'QUOTA_IP_DAY' });
  expect(await ledger()).toEqual({ count: 100, charged: '0' });
}), 30_000);

test('known settlement refunds difference once; null retains bound; overrun records true cost', () => withDatabase(async () => {
  const request = await input();
  const r = await reserveRun(request, policy);
  const settled = await Promise.all(Array.from({ length: 8 }, () => settle(r.reservationId, 3)));
  expect(settled.every(r => r.status === 'settled' && r.chargedCostMicros === 3)).toBe(true);
  await expect(settle(r.reservationId, null)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  const unknown = await reserveRun({ ...request, requestId: 'unknown' }, policy);
  expect(await settle(unknown.reservationId, null)).toMatchObject({ chargedCostMicros: 10, actualCostMicros: null, status: 'settled' });
  expect(await settle(unknown.reservationId, null)).toMatchObject({ chargedCostMicros: 10 });
  const over = await reserveRun({ ...request, requestId: 'over' }, policy);
  expect(await settle(over.reservationId, 20_000)).toMatchObject({ chargedCostMicros: 20_000 });
  await expect(reserveRun({ ...request, requestId: 'blocked' }, policy)).rejects.toMatchObject({ code: 'QUOTA_BUDGET' });
  expect(await ledger()).toEqual({ count: 3, charged: '20013' });
  const before = (await database().query('SELECT * FROM quota_reservations ORDER BY id')).rows;
  const zero = await reserveRun({ ...request, requestId: 'zero-after-overrun', maxCostMicros: 0 }, policy);
  expect(zero).toMatchObject({ created: true, status: 'reserved', maxCostMicros: 0, chargedCostMicros: 0, actualCostMicros: null });
  expect(await settle(zero.reservationId, null)).toMatchObject({ status: 'settled', actualCostMicros: null, chargedCostMicros: 0 });
  await expect(settle(zero.reservationId, 0)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect((await database().query('SELECT * FROM quota_reservations WHERE id<>$1 ORDER BY id', [zero.reservationId])).rows).toEqual(before);
  expect(await ledger()).toEqual({ count: 4, charged: '20013' });
}));

test('expired unknown charge remains on original day; late known settlement after owner expiry is allowed', () => withDatabase(async () => {
  const request = await input();
  const r = await reserveRun(request, { ...policy, enabled: true, dailyBudgetMicros: 10 });
  const late = new Date(request.now.getTime() + 60_000);
  await expect(reserveRun({ ...request, requestId: 'no-refund', now: late }, {
    ...policy, enabled: true, dailyBudgetMicros: 10,
  })).rejects.toMatchObject({ code: 'QUOTA_BUDGET' });
  const nextDay = new Date(request.now.getTime() + 86_400_000);
  const second = await reserveRun({ ...request, requestId: 'next-day', now: nextDay }, {
    ...policy, enabled: true, dailyBudgetMicros: 10,
  });
  await database().query('UPDATE sessions SET expires_at=clock_timestamp() WHERE id=$1', [request.ownerId]);
  expect(await settle(r.reservationId, 2, nextDay)).toMatchObject({ day: r.day, chargedCostMicros: 2 });
  expect(await settle(second.reservationId, null, nextDay)).toMatchObject({ day: second.day, chargedCostMicros: 10 });
  expect(await ledger()).toEqual({ count: 2, charged: '12' });
}));

test('conflicting concurrent settlements produce one immutable receipt; invalid usage leaves it untouched', () => withDatabase(async () => {
  const r = await reserveRun(await input(), policy);
  for (const amount of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    await expect(settle(r.reservationId, amount)).rejects.toMatchObject({ code: 'INVALID_QUOTA_INPUT' });
  }
  await expect(settle(randomUUID(), 0)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  const results = await Promise.allSettled([settle(r.reservationId, 2), settle(r.reservationId, 3)]);
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.find(r => r.status === 'rejected')).toMatchObject({ reason: { code: 'IDEMPOTENCY_CONFLICT' } });
}));

test('session expiry during a real row-lock wait denies reservation', () => withDatabase(async () => {
  const request = await input({ now: new Date() });
  await database().query("UPDATE sessions SET expires_at=clock_timestamp()+interval '1 second' WHERE id=$1", [request.ownerId]);
  const holder = await database().connect();
  let pending: Promise<unknown> | undefined;
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM sessions WHERE id=$1 FOR UPDATE', [request.ownerId]);
    const pid = (await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    pending = reserveRun(request, policy).then(v => v, e => e);
    let blocked = false;
    for (let i = 0; i < 50; i++) {
      if ((await database().query('SELECT 1 FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))', [pid])).rowCount) { blocked = true; break; }
      await delay(10);
    }
    expect(blocked).toBe(true);
    await holder.query('SELECT pg_sleep(1.1)');
    await holder.query('COMMIT');
    expect(await pending).toMatchObject({ code: 'NOT_FOUND' });
    expect((await ledger()).count).toBe(0);
  } finally { await holder.query('ROLLBACK'); holder.release(); await pending; }
}));

test('different day buckets compete for one global concurrency gate', () => withDatabase(async () => {
  const midnight = new Date(clock().getTime() + 12 * 3_600_000);
  const requests = await Promise.all(Array.from({ length: 8 }, (_, i) => input({
    now: new Date(midnight.getTime() + (i % 2 ? 0 : -10_000)), ipKey: hash(`midnight-${i}`),
  })));
  const results = await Promise.allSettled(requests.map(r => reserveRun(r, policy)));
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(3);
  expect(results.filter(r => r.status === 'rejected').every(r => r.reason.code === 'QUOTA_CONCURRENCY')).toBe(true);
}));

test('competing last IP/session slots cannot both be reserved', () => withDatabase(async () => {
  const request = await input();
  for (let i = 0; i < 19; i++) {
    const r = await reserveRun({ ...request, requestId: `prepare-${i}`, ipKey: hash(`prepare-${i}`) }, policy);
    await settle(r.reservationId, 0);
  }
  const sessionResults = await Promise.allSettled(['a', 'b'].map(requestId => reserveRun({
    ...request, requestId, ipKey: hash(requestId),
  }, policy)));
  expect(sessionResults.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(sessionResults.find(r => r.status === 'rejected')).toMatchObject({ reason: { code: 'QUOTA_SESSION_DAY' } });
  const fresh = await input({ ipKey: hash('last-minute-slot') });
  for (let i = 0; i < 4; i++) {
    const r = await reserveRun({ ...fresh, requestId: `ip-${i}` }, policy);
    await settle(r.reservationId, 0);
  }
  const ipResults = await Promise.allSettled(['last-a', 'last-b'].map(requestId => reserveRun({ ...fresh, requestId }, policy)));
  expect(ipResults.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(ipResults.find(r => r.status === 'rejected')).toMatchObject({ reason: { code: 'QUOTA_IP_MINUTE' } });
}), 20_000);

test('known settlement releases budget while preserving call counts and original receipts', () => withDatabase(async () => {
  const request = await input();
  const small: QuotaPolicy = { ...policy, enabled: true, dailyBudgetMicros: 10 };
  const first = await reserveRun(request, small);
  await settle(first.reservationId, 4);
  const next = await reserveRun({ ...request, requestId: 'remaining', maxCostMicros: 6 }, small);
  expect(next.created).toBe(true);
  await expect(reserveRun({ ...request, requestId: 'exceeded', maxCostMicros: 1 }, small)).rejects.toMatchObject({ code: 'QUOTA_BUDGET' });
  expect(await ledger()).toEqual({ count: 2, charged: '10' });
  expect(await reserveRun(request, small)).toMatchObject({ created: false, status: 'settled', chargedCostMicros: 4 });
}));

async function blockedReserve(request: ReserveRunInput, configured: QuotaPolicy, lock: 'global' | 'ip' | 'session') {
  const holder = await database().connect();
  let pending: Promise<Awaited<ReturnType<typeof reserveRun>> | Error> | undefined;
  try {
    if (lock === 'ip') await database().query('INSERT INTO quota_ips(ip_key) VALUES ($1)', [request.ipKey]);
    await holder.query('BEGIN');
    if (lock === 'global') await holder.query('SELECT id FROM quota_global_lock WHERE id=1 FOR UPDATE');
    else if (lock === 'ip') await holder.query('SELECT ip_key FROM quota_ips WHERE ip_key=$1 FOR UPDATE', [request.ipKey]);
    else await holder.query('SELECT id FROM sessions WHERE id=$1 FOR UPDATE', [request.ownerId]);
    const pid = (await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const started = performance.now();
    pending = reserveRun(request, configured).catch((error: Error) => error);
    let blocked = false;
    for (let i = 0; i < 100; i++) {
      if ((await database().query('SELECT 1 FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))', [pid])).rowCount) { blocked = true; break; }
      await delay(10);
    }
    expect(blocked, 'Must observe PostgreSQL lock wait before advancing elapsed time').toBe(true);
    await holder.query('SELECT pg_sleep(0.35)');
    await holder.query('COMMIT');
    const result = await pending;
    return { result, elapsed: performance.now() - started };
  } finally { await holder.query('ROLLBACK'); holder.release(); await pending; }
}

const clockCases = [0, 10].flatMap(maxCostMicros => (['global', 'ip', 'session'] as const).map(lock => ({ maxCostMicros, lock })));
test.each(clockCases)('$maxCostMicros-cost reservation clock: $lock wait consumes TTL and cannot authorize expired execution', ({ maxCostMicros, lock }) => withDatabase(async () => {
  const request = await input({ maxCostMicros });
  const { result, elapsed } = await blockedReserve(request, { ...policy, enabled: true, reservationTtlMs: 200 }, lock);
  expect(elapsed).toBeGreaterThan(200);
  expect(result).toMatchObject({ code: 'QUOTA_RESERVATION_EXPIRED' });
  expect(await ledger()).toEqual({ count: 0, charged: '0' });
}), 20_000);

test.each(clockCases)('$maxCostMicros-cost reservation clock: $lock wait crossing Taipei midnight cannot debit the old bucket', ({ maxCostMicros, lock }) => withDatabase(async () => {
  const midnight = new Date(clock().getTime() + 12 * 3_600_000);
  const request = await input({ maxCostMicros, now: new Date(midnight.getTime() - 200) });
  const { result, elapsed } = await blockedReserve(request, policy, lock);
  expect(elapsed).toBeGreaterThan(200);
  expect(result).toMatchObject({ code: 'QUOTA_CLOCK_CHANGED' });
  expect(await ledger()).toEqual({ count: 0, charged: '0' });
  const retry = await reserveRun({ ...request, now: midnight, ipKey: hash('new-day'), previousIpKey: request.ipKey }, policy);
  expect(retry.created).toBe(true);
  expect(retry.day).toBe(midnight.toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' }));
}), 20_000);

test('reservation clock: successful admission after a real wait still has a live lease', () => withDatabase(async () => {
  const request = await input();
  const { result, elapsed } = await blockedReserve(request, policy, 'global');
  expect(result).toMatchObject({ created: true, status: 'reserved' });
  if (result instanceof Error) throw result;
  expect(result.expiresAt.getTime()).toBeGreaterThan(request.now.getTime() + Math.ceil(elapsed));
}), 20_000);
