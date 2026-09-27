import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { withDatabase } from '../support/database';
import { database } from '../../src/server/db';
import { compactQuota, expireData, expireSessions, retentionPreview } from '../../src/server/retention';
import { withAdkSchemaLock } from '../../src/server/adk-schema-lock';
import { createSession } from '../../src/server/session';
import { reserveRun, settleRun } from '../../src/server/quota';

async function seed(ageDays: number, charged = 100, actual: number | null = null, owner: string = randomUUID(), maxCost = 100) {
  const id = randomUUID();
  await database().query(`INSERT INTO quota_reservations(id,owner_id,ip_key,request_id,payload_hash,day,
    reserved_at,expires_at,max_cost_micros,charged_cost_micros,actual_cost_micros,status,settled_at)
    SELECT $1::uuid,$2,$3,$1::uuid::text,$3,(stamp AT TIME ZONE 'Asia/Taipei')::date,stamp,stamp+interval '1 minute',$7,$4,$5,
      CASE WHEN $5::bigint IS NULL THEN 'expired' ELSE 'settled' END,
      CASE WHEN $5::bigint IS NULL THEN NULL ELSE stamp+interval '1 minute' END
    FROM (SELECT clock_timestamp()-$6::int*interval '1 day' AS stamp) s`, [id, owner, 'a'.repeat(64), charged, actual, ageDays, maxCost]);
  return id;
}
test('only old inactive receipts compact; unknown cost remains charged; concurrent runs count once', () => withDatabase(async () => {
  const unknown = await seed(31), known = await seed(31, 20, 20);
  const zeroUnknown = await seed(31, 0, null, randomUUID(), 0), zeroKnown = await seed(31, 0, 0, randomUUID(), 0);
  const recent = await seed(0);
  const live = await createSession(); const liveReceipt = await seed(31, 100, null, live.id);
  const before = await retentionPreview();
  expect(before.compactableReceipts).toBe(4);
  expect((await database().query('SELECT id FROM quota_reservations')).rowCount).toBe(6);
  expect((await Promise.all([compactQuota(), compactQuota()])).reduce((a, b) => a + b, 0)).toBe(4);
  expect((await database().query('SELECT id FROM quota_reservations ORDER BY id')).rows.map(r => r.id).sort()).toEqual([recent, liveReceipt].sort());
  expect((await database().query('SELECT reservations,charged_cost_micros,unknown_usage FROM quota_daily_totals')).rows)
    .toEqual([{ reservations: '4', charged_cost_micros: '120', unknown_usage: '2' }]);
  expect(await compactQuota()).toBe(0);
  for (const id of [unknown, known, zeroUnknown, zeroKnown]) await expect(settleRun({ reservationId: id, actualCostMicros: 1, now: new Date() })).rejects.toMatchObject({ code: 'NOT_FOUND' });
}));

test('aggregate failure rolls receipt deletion back', () => withDatabase(async () => {
  const id = await seed(31);
  await database().query(`CREATE FUNCTION fail_total() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$;
    CREATE TRIGGER fail_total BEFORE INSERT ON quota_daily_totals FOR EACH ROW EXECUTE FUNCTION fail_total()`);
  await expect(compactQuota()).rejects.toThrow();
  expect((await database().query('SELECT id FROM quota_reservations')).rows).toEqual([{ id }]);
}));

test('expiry deletes empty expired owners, preserves current receipts and purges old identifier buckets', () => withDatabase(async () => {
  const owner = await createSession(), live = await createSession();
  await seed(31, 100, null, owner.id);
  const recent = await seed(0, 100, null, owner.id);
  await database().query('UPDATE sessions SET expires_at=clock_timestamp() WHERE id=$1', [owner.id]);
  await database().query(`INSERT INTO quota_ips VALUES ($1);`, ['b'.repeat(64)]);
  await database().query(`INSERT INTO quota_session_days VALUES ($1,current_date-31)`, [owner.id]);
  const result = await expireData();
  expect(result).toEqual({ deletedTrips: 0, busyTrips: 0, deletedSessions: 1, compactedReceipts: 1 });
  expect((await database().query('SELECT id FROM sessions')).rows).toEqual([{ id: live.id }]);
  expect((await database().query('SELECT id FROM quota_reservations')).rows).toEqual([{ id: recent }]);
  expect((await database().query('SELECT * FROM quota_ips')).rowCount).toBe(0);
  expect((await database().query('SELECT * FROM quota_session_days')).rowCount).toBe(0);
}));

test.each([100, 99])('daily budget %i includes totals but admits zero cost; old aggregate retention is bounded', dailyBudgetMicros => withDatabase(async () => {
  const owner = await createSession();
  await database().query(`INSERT INTO quota_daily_totals VALUES
    ((clock_timestamp() AT TIME ZONE 'Asia/Taipei')::date,1,100,1),
    ((clock_timestamp() AT TIME ZONE 'Asia/Taipei')::date-91,1,100,1)`);
  await compactQuota();
  expect((await database().query('SELECT * FROM quota_daily_totals')).rowCount).toBe(1);
  const before = (await database().query('SELECT * FROM quota_daily_totals')).rows;
  const request = { ownerId: owner.id, ipKey: 'a'.repeat(64), requestId: 'new', payloadHash: 'b'.repeat(64), maxCostMicros: 1, now: new Date() };
  const policy = { enabled: true as const, dailyBudgetMicros, priceBasis: 'synthetic' as const, reservationTtlMs: 60_000 };
  await expect(reserveRun(request, policy)).rejects.toMatchObject({ code: 'QUOTA_BUDGET' });
  expect(await reserveRun({ ...request, maxCostMicros: 0, now: new Date() }, policy))
    .toMatchObject({ created: true, maxCostMicros: 0, chargedCostMicros: 0, actualCostMicros: null });
  expect((await database().query('SELECT * FROM quota_daily_totals')).rows).toEqual(before);
}));

test('100 protected orphan owners cannot starve a later expired owner', () => withDatabase(async () => {
  const client = await database().connect();
  try {
    const schema = (await client.query('SELECT current_schema() AS name')).rows[0].name;
    // Minimal pinned-schema fixture for candidate selection; real ADK deletion
    // and schema atomicity are covered in retention.test.ts.
    await withAdkSchemaLock(client, async () => {
      await client.query(`CREATE SCHEMA "${schema}_adk";
        CREATE TABLE "${schema}_adk".adk_internal_metadata(key text,value text);
        INSERT INTO "${schema}_adk".adk_internal_metadata VALUES ('schema_version','1');
        CREATE TABLE "${schema}_adk".sessions(user_id text);
        CREATE TABLE "${schema}_adk".events(user_id text);
        CREATE TABLE "${schema}_adk".user_states(app_name text,user_id text)`);
    });
    await client.query(`INSERT INTO sessions(id,token_hash,expires_at)
      SELECT ('00000000-0000-4000-8000-'||lpad(to_hex(i),12,'0'))::uuid,repeat(md5(i::text),2),clock_timestamp()-interval '1 day'
      FROM generate_series(1,100) i`);
    await client.query(`INSERT INTO "${schema}_adk".sessions SELECT id::text FROM sessions`);
    await client.query(`INSERT INTO sessions(id,token_hash,expires_at)
      VALUES ('ffffffff-ffff-4fff-8fff-ffffffffffff',repeat('f',64),clock_timestamp()-interval '1 day')`);
    expect(await expireSessions()).toBe(1);
    expect((await client.query('SELECT * FROM sessions')).rowCount).toBe(100);
    expect((await client.query(`SELECT * FROM "${schema}_adk".sessions`)).rowCount).toBe(100);
  } finally { client.release(); }
}));
