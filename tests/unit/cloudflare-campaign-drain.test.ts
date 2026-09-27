import type { Pool, PoolClient, QueryConfig } from 'pg';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { waitForCloudflareCampaignDrain } from '../../evals/cloudflare-campaign-drain';

const clock = vi.hoisted(() => ({ now: 0 }));
vi.mock('node:timers/promises', () => ({
  setTimeout: vi.fn(async (ms: number) => { clock.now += ms; }),
}));
import { setTimeout as delay } from 'node:timers/promises';

const tripId = '11111111-1111-4111-8111-111111111111';
const schema = `test_${'a'.repeat(32)}`;
type DrainQuery = QueryConfig & { query_timeout: number };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  clock.now = 100_000;
  vi.mocked(delay).mockClear();
  vi.spyOn(Date, 'now').mockImplementation(() => clock.now);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function fakePool(rows: unknown[] = [{ schema, busy: false }]) {
  const query = vi.fn(async (config: DrainQuery) => { void config; return { rows }; });
  const release = vi.fn();
  const client = { query, release } as unknown as PoolClient;
  const connect = vi.fn(async () => client);
  return { pool: { connect } as unknown as Pool, client, query, connect, release };
}

test('terminal isolated run returns immediately with a bounded, parameterized read', async () => {
  const { pool, query, connect, release } = fakePool();
  await expect(waitForCloudflareCampaignDrain(pool, tripId)).resolves.toBe(true);
  expect(query).toHaveBeenCalledTimes(1);
  expect(query.mock.calls[0][0]).toMatchObject({ values: [tripId], query_timeout: 1000 });
  expect(query.mock.calls[0][0].text).toMatch(/^SELECT /);
  expect(delay).not.toHaveBeenCalled();
  expect(connect).toHaveBeenCalledTimes(1);
  expect(release).toHaveBeenCalledExactlyOnceWith(true);
});

test('polls until active state becomes terminal without dispatch or reconciliation', async () => {
  const { pool, query } = fakePool();
  query.mockResolvedValueOnce({ rows: [{ schema, busy: true }] })
    .mockResolvedValueOnce({ rows: [{ schema, busy: true }] });
  await expect(waitForCloudflareCampaignDrain(pool, tripId)).resolves.toBe(true);
  expect(query).toHaveBeenCalledTimes(3);
  expect(vi.mocked(delay).mock.calls.map(([ms]) => ms)).toEqual([200, 200]);
  expect(query.mock.calls.every(([config]) => config.values?.[0] === tripId && config.query_timeout <= 1000)).toBe(true);
  expect(clock.now).toBe(100_400);
});

test('persistent active state stops at 5000ms and starts no query at or after the deadline', async () => {
  const { pool, query } = fakePool([{ schema, busy: true }]);
  const starts: number[] = [];
  query.mockImplementation(async () => {
    starts.push(clock.now);
    return { rows: [{ schema, busy: true }] };
  });
  await expect(waitForCloudflareCampaignDrain(pool, tripId)).resolves.toBe(false);
  expect(clock.now).toBe(105_000);
  expect(starts).toHaveLength(25);
  expect(starts.every(time => time < 105_000)).toBe(true);
  expect(query.mock.calls.every(([config]) => config.query_timeout > 0 && config.query_timeout <= 1000)).toBe(true);
});

test('query time consumes the same deadline and shortens the last query and pause', async () => {
  const { pool, query } = fakePool();
  const starts: number[] = [];
  query.mockImplementation(async () => {
    starts.push(clock.now);
    clock.now += 375;
    return { rows: [{ schema, busy: true }] };
  });
  await expect(waitForCloudflareCampaignDrain(pool, tripId)).resolves.toBe(false);
  expect(clock.now).toBe(105_000);
  expect(query.mock.calls.every(([config], index) =>
    config.query_timeout >= 1 && config.query_timeout <= 1000 && config.query_timeout <= 105_000 - starts[index])).toBe(true);
  expect(query.mock.calls.at(-1)?.[0].query_timeout).toBe(400);
  expect(vi.mocked(delay).mock.calls.at(-1)?.[0]).toBe(25);
});

test.each(['public', 'workbench_live', 'workbench_demo', `${schema}_adk`, `${schema}\n`, `test_${'A'.repeat(32)}`, 'test_short'])(
  'rejects non-isolated schema %j even if idle', async name => {
    const { pool, query } = fakePool([{ schema: name, busy: false }]);
    await expect(waitForCloudflareCampaignDrain(pool, tripId)).resolves.toBe(false);
    expect(query).toHaveBeenCalledTimes(1);
    expect(delay).not.toHaveBeenCalled();
  });

test.each([[], [{ schema, busy: false }, { schema, busy: false }], [{ schema }], [{ schema, busy: 'false' }],
  [{ schema: null, busy: false }]].map(rows => ({ rows })))('malformed query result $rows cannot certify drain', async ({ rows }) => {
  const { pool } = fakePool(rows);
  await expect(waitForCloudflareCampaignDrain(pool, tripId)).resolves.toBe(false);
  expect(delay).not.toHaveBeenCalled();
});

test.each([0, 1])('query rejection after %i active polls returns false without echo or retry', async activePolls => {
  const { pool, query, release } = fakePool();
  if (activePolls) query.mockResolvedValueOnce({ rows: [{ schema, busy: true }] });
  query.mockRejectedValueOnce(new Error('synthetic-private-database-detail'));
  await expect(waitForCloudflareCampaignDrain(pool, tripId)).resolves.toBe(false);
  expect(query).toHaveBeenCalledTimes(activePolls + 1);
  expect(delay).toHaveBeenCalledTimes(activePolls);
  expect(release).toHaveBeenCalledExactlyOnceWith(true);
});

test('acquisition timeout returns at five seconds and destroys a late client without querying it', async () => {
  const { pool, client, connect, query, release } = fakePool();
  const acquired = Promise.withResolvers<PoolClient>();
  connect.mockReturnValueOnce(acquired.promise);
  const draining = waitForCloudflareCampaignDrain(pool, tripId);
  await Promise.resolve();
  clock.now += 5000;
  await vi.advanceTimersByTimeAsync(5000);
  await expect(draining).resolves.toBe(false);
  expect(query).not.toHaveBeenCalled();
  expect(release).not.toHaveBeenCalled();
  acquired.resolve(client);
  await vi.advanceTimersByTimeAsync(0);
  expect(release).toHaveBeenCalledExactlyOnceWith(true);
  expect(query).not.toHaveBeenCalled();
});

test('failed acquisition returns false without querying or releasing an unacquired client', async () => {
  const { pool, connect, query, release } = fakePool();
  connect.mockRejectedValueOnce(new Error('synthetic-private-acquisition-detail'));
  await expect(waitForCloudflareCampaignDrain(pool, tripId)).resolves.toBe(false);
  expect(query).not.toHaveBeenCalled();
  expect(release).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

test('acquisition consumes the shared deadline and leaves only 500ms for polling', async () => {
  const { pool, client, connect, query, release } = fakePool([{ schema, busy: true }]);
  connect.mockImplementationOnce(async () => { clock.now += 4500; return client; });
  await expect(waitForCloudflareCampaignDrain(pool, tripId)).resolves.toBe(false);
  expect(query.mock.calls.map(([config]) => config.query_timeout)).toEqual([500, 300, 100]);
  expect(vi.mocked(delay).mock.calls.map(([ms]) => ms)).toEqual([200, 200, 100]);
  expect(clock.now).toBe(105_000);
  expect(release).toHaveBeenCalledExactlyOnceWith(true);
});

test('client acquired at the deadline is destroyed without starting a query', async () => {
  const { pool, client, connect, query, release } = fakePool();
  connect.mockImplementationOnce(async () => { clock.now += 5000; return client; });
  await expect(waitForCloudflareCampaignDrain(pool, tripId)).resolves.toBe(false);
  expect(query).not.toHaveBeenCalled();
  expect(release).toHaveBeenCalledExactlyOnceWith(true);
});

test('an idle query response arriving at the deadline cannot certify drain', async () => {
  const { pool, query, release } = fakePool();
  query.mockImplementationOnce(async () => { clock.now += 5000; return { rows: [{ schema, busy: false }] }; });
  await expect(waitForCloudflareCampaignDrain(pool, tripId)).resolves.toBe(false);
  expect(delay).not.toHaveBeenCalled();
  expect(release).toHaveBeenCalledExactlyOnceWith(true);
});

test('invalid trip identity is rejected before querying', async () => {
  const { pool, query } = fakePool();
  await expect(waitForCloudflareCampaignDrain(pool, 'not-a-trip-id')).rejects.toThrow();
  expect(query).not.toHaveBeenCalled();
});
