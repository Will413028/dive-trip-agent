import { expect, test } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { withDatabase } from '../support/database';
import { testDatabaseUrl } from '../support/database';
import { database, makePool, transaction, withDatabasePool } from '../../src/server/db';
import { loadMigrations, migrate } from '../../src/server/migrate';
import { createSession, resolveSession } from '../../src/server/session';
import { createTrip, getTrip } from '../../src/server/trip-store';
import { makeSnapshot } from '../support/domain-fixtures';
import type { Snapshot } from '../../src/domain/types';

test('別的 session 即使知道 id 也看不到行程', () => withDatabase(async () => {
  const a = await createSession();
  const b = await createSession();
  const trip = await createTrip(a.id, makeSnapshot());
  expect(await getTrip(b.id, trip.id)).toBeNull();
  expect(await getTrip(a.id, trip.id)).toEqual(trip);
  expect(trip.version).toBe(1);
  expect(trip.budget.knownMinor).toBe(430000);
}));

test('匿名憑證可解析，偽造值不可解析', () => withDatabase(async () => {
  const session = await createSession();
  expect(await resolveSession(session.token)).toBe(session.id);
  expect(await resolveSession('a'.repeat(64))).toBeNull();
  expect(await resolveSession('')).toBeNull();
}));

test('DB 只保存雜湊，憑證為獨立 32 bytes 隨機值', () => withDatabase(async () => {
  const a = await createSession(); const b = await createSession();
  expect(a.token).toMatch(/^[0-9a-f]{64}$/);
  expect(a.token === b.token).toBe(false);
  const result = await database().query('SELECT * FROM sessions WHERE id = $1', [a.id]);
  expect(result.rows[0].token_hash === createHash('sha256').update(a.token).digest('hex')).toBe(true);
  expect(JSON.stringify(result.rows).includes(a.token)).toBe(false);
  expect(await resolveSession(a.id)).toBeNull();
}));

test('不存在／非法 id 與其他擁有者一律查不到', () => withDatabase(async () => {
  const owner = await createSession(); const trip = await createTrip(owner.id, makeSnapshot());
  expect(await getTrip(owner.id, randomUUID())).toBeNull();
  expect(await getTrip(randomUUID(), trip.id)).toBeNull();
  expect(await getTrip(owner.id, "' OR true --")).toBeNull();
  expect(await getTrip('not-a-uuid', trip.id)).toBeNull();
  await expect(createTrip(randomUUID(), makeSnapshot())).rejects.toMatchObject({ code: 'NOT_FOUND' });
}));

test('session 到期不可解析、讀取或建立，即使已知 owner id', () => withDatabase(async () => {
  const owner = await createSession(); const trip = await createTrip(owner.id, makeSnapshot());
  await database().query('UPDATE sessions SET expires_at = now() WHERE id = $1', [owner.id]);
  expect(await resolveSession(owner.token)).toBeNull();
  expect(await getTrip(owner.id, trip.id)).toBeNull();
  await expect(createTrip(owner.id, makeSnapshot())).rejects.toMatchObject({ code: 'NOT_FOUND' });
}));

test('建立行程等待 session 鎖跨過到期也必須拒絕', () => withDatabase(async () => {
  const owner = await createSession();
  await database().query("UPDATE sessions SET expires_at=clock_timestamp()+interval '1 second' WHERE id=$1", [owner.id]);
  const holder = await database().connect();
  let pending: Promise<unknown> | undefined;
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM sessions WHERE id=$1 FOR UPDATE', [owner.id]);
    const pid = (await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    pending = createTrip(owner.id, makeSnapshot()).then(value => value, error => error);
    let blocked = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      const result = await database().query('SELECT 1 FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))', [pid]);
      if (result.rowCount) { blocked = true; break; }
      await delay(10);
    }
    expect(blocked).toBe(true);
    await holder.query('SELECT pg_sleep(1.1)');
    await holder.query('COMMIT');
    expect(await pending).toMatchObject({ code: 'NOT_FOUND' });
    expect((await database().query('SELECT * FROM trips')).rowCount).toBe(0);
  } finally {
    await holder.query('ROLLBACK'); holder.release();
    await pending;
  }
}));

test('行程 30 天固定到期，讀取不延長；到期即拒絕', () => withDatabase(async () => {
  const owner = await createSession(); const trip = await createTrip(owner.id, makeSnapshot());
  const before = await database().query('SELECT expires_at, expires_at - created_at AS lifetime FROM trips WHERE id=$1', [trip.id]);
  expect(before.rows[0].lifetime.days).toBe(30);
  await getTrip(owner.id, trip.id);
  const after = await database().query('SELECT expires_at FROM trips WHERE id=$1', [trip.id]);
  expect(after.rows[0].expires_at).toEqual(before.rows[0].expires_at);
  await database().query('UPDATE trips SET expires_at=now() WHERE id=$1', [trip.id]);
  expect(await getTrip(owner.id, trip.id)).toBeNull();
  expect(await resolveSession(owner.token)).toBe(owner.id);
}));

test('日期／目的地未定的最低結構空行程可以建立', () => withDatabase(async () => {
  const owner = await createSession(); const input = makeSnapshot();
  input.requirements.destinationId = null; input.entries = [];
  const trip = await createTrip(owner.id, input);
  expect(trip.snapshot).toEqual(input);
  expect(trip.budget.knownMinor).toBe(0);
}));

const invalidSnapshots: [string, (s: Snapshot) => unknown][] = [
  ['缺 requirements', s => ({ entries: s.entries, exclusions: [] })],
  ['未知 top-level 欄位', s => ({ ...s, budget: 0 })],
  ['未知 entry 欄位', s => { Object.assign(s.entries[0], { ownerId: 'fake' }); return s; }],
  ['目的地未定仍有活動', s => { s.requirements.destinationId = null; return s; }],
  ['catalog ID 不符', s => { s.entries[0].catalogId = 'forged'; return s; }],
  ['重複 entry ID', s => { s.entries.push(structuredClone(s.entries[0])); return s; }],
  ['錯誤日期', s => { s.requirements.startDate = '2026-02-30'; return s; }],
  ['容量不足', s => { s.requirements.people = 6; return s; }],
  ['超出日期', s => { s.entries[1].day = 9; return s; }],
  ['來源資料不合法', s => { s.entries[1].item.sources = []; return s; }],
];
test.each(invalidSnapshots)('非法快照拒絕且不留行程：%s', (_, mutate) => withDatabase(async () => {
  const owner = await createSession();
  await expect(createTrip(owner.id, mutate(makeSnapshot()) as Snapshot)).rejects.toMatchObject({ code: 'INVALID_SNAPSHOT' });
  expect((await database().query('SELECT * FROM trips')).rowCount).toBe(0);
  expect((await database().query('SELECT * FROM trip_versions')).rowCount).toBe(0);
}));

test('未知費用保留 null，讀回後由程式重算且快照不 alias', () => withDatabase(async () => {
  const owner = await createSession(); const input = makeSnapshot();
  Object.assign(input.entries[1].item.price, { unitMinor: null, unknownReason: '待確認' });
  const trip = await createTrip(owner.id, input);
  input.entries[0].item.price.unitMinor = 1;
  const read = await getTrip(owner.id, trip.id);
  expect(read).toEqual(trip);
  expect(read?.budget).toEqual({ knownMinor: 330000, unknownEntryIds: ['tour'], withinBudget: null });
}));

test('DB JSON 損壞時拒絕，不用型別斷言放行', () => withDatabase(async () => {
  const owner = await createSession(); const trip = await createTrip(owner.id, makeSnapshot());
  await database().query('UPDATE trip_versions SET snapshot=$1::jsonb WHERE trip_id=$2', ['{"forged":true}', trip.id]);
  await expect(getTrip(owner.id, trip.id)).rejects.toMatchObject({ code: 'CORRUPT_SNAPSHOT' });
}));

test('首版寫入失敗時整個行程一起回滾', () => withDatabase(async () => {
  const owner = await createSession();
  await database().query(`CREATE FUNCTION reject_version() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'injected version failure'; END $$;
    CREATE TRIGGER reject_version BEFORE INSERT ON trip_versions FOR EACH ROW EXECUTE FUNCTION reject_version()`);
  await expect(createTrip(owner.id, makeSnapshot())).rejects.toThrow('injected version failure');
  expect((await database().query('SELECT * FROM trips')).rowCount).toBe(0);
  expect((await database().query('SELECT * FROM trip_versions')).rowCount).toBe(0);
  expect(await resolveSession(owner.token)).toBe(owner.id);
}));

test('DB 約束拒絕孤兒 trip、重複版本與空 current pointer', () => withDatabase(async () => {
  const owner = await createSession(); const trip = await createTrip(owner.id, makeSnapshot());
  await expect(database().query('INSERT INTO trip_versions (trip_id,version,snapshot) VALUES ($1,1,$2)', [trip.id, '{}'])).rejects.toMatchObject({ code: '23505' });
  await expect(database().query('UPDATE trips SET current_version=2 WHERE id=$1', [trip.id])).rejects.toMatchObject({ code: '23503' });
  await expect(transaction(database(), async client => {
    await client.query('INSERT INTO trips (id,owner_id,current_version) VALUES ($1,$2,1)', [randomUUID(), randomUUID()]);
  })).rejects.toMatchObject({ code: '23503' });
  expect(await getTrip(owner.id, trip.id)).toEqual(trip);
}));

test('migration 重跑／同時執行冪等，checksum 變動拒絕', () => withDatabase(async () => {
  await Promise.all([migrate(database()), migrate(database())]);
  const rows = await database().query("SELECT * FROM schema_migrations WHERE id='001-core'");
  expect(rows.rowCount).toBe(1);
  const sql = await readFile(new URL('../../migrations/001-core.sql', import.meta.url), 'utf8');
  expect(rows.rows[0].checksum).toBe(createHash('sha256').update(sql).digest('hex'));
  const migrations = await loadMigrations(); migrations[0].sql += '\n-- changed';
  await expect(migrate(database(), migrations)).rejects.toThrow('MIGRATION_CHECKSUM_MISMATCH');
  expect((await database().query('SELECT * FROM schema_migrations')).rowCount).toBe((await loadMigrations()).length);
}));

test('migration SQL 失敗不留下半套 DDL 或版本紀錄', () => withDatabase(async () => {
  await expect(migrate(database(), [
    ...await loadMigrations(),
    { id: '004-failing', sql: 'CREATE TABLE should_rollback(id integer); SELECT missing_column;' },
  ])).rejects.toThrow();
  expect((await database().query("SELECT to_regclass('should_rollback') AS relation")).rows[0].relation).toBeNull();
  expect((await database().query('SELECT * FROM schema_migrations')).rowCount).toBe((await loadMigrations()).length);
}));

test('舊 migration CLI 已退役，不寫入原 migration ledger', () => withDatabase(async () => {
  const schema = (await database().query('SELECT current_schema() AS name')).rows[0].name;
  const url = new URL(testDatabaseUrl()); url.searchParams.set('options', `-c search_path=${schema}`);
  const before = (await database().query('SELECT * FROM schema_migrations ORDER BY id')).rows;
  await expect(promisify(execFile)(process.execPath, ['src/server/migrate.ts'], {
    env: { PATH: process.env.PATH, NODE_ENV: 'test', DATABASE_URL: url.toString() }, timeout: 10_000,
  })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('LEGACY_MIGRATION_RETIRED') });
  expect((await database().query('SELECT * FROM schema_migrations ORDER BY id')).rows).toEqual(before);
}));

test('資料庫無法連線時 fail closed，不以 memory 假成功', async () => {
  const pool = makePool('postgresql://postgres@127.0.0.1:1/dive_trip_test');
  try {
    await expect(withDatabasePool(pool, () => createSession())).rejects.toThrow();
  } finally { await pool.end(); }
});
