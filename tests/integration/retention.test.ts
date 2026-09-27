import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, test } from 'vitest';
import { database } from '../../src/server/db';
import { createSession } from '../../src/server/session';
import { createDemo } from '../../src/server/demo';
import { getTrip } from '../../src/server/trip-store';
import { deleteTrip, expireTrips } from '../../src/server/retention';
import { createShare, hashPreview, previewShare, readShare } from '../../src/server/share-store';
import { startRun } from '../../src/server/run-store';
import { reserveRun } from '../../src/server/quota';
import { admitStart, accountModelCall } from '../../src/server/agent-admission';
import { handleRequest } from '../../src/server/http';
import { executeAgent } from '../../src/agent/runtime';
import { restoreVersion } from '../../src/server/version-store';
import { withDatabase, testDatabaseUrl } from '../support/database';

const origin = 'http://127.0.0.1:4318';
async function setup() {
  const owner = await createSession(), trip = await createDemo(owner.id, 'normal');
  return { owner, trip };
}
test('delete is owner-only and atomic; shares and versions disappear, quota does not reset', () => withDatabase(async () => {
  const { owner, trip } = await setup(), other = await setup();
  const share = await createShare(owner.id, trip.id, 1, hashPreview(previewShare(trip)));
  await reserveRun({ ownerId: owner.id, ipKey: 'a'.repeat(64), requestId: 'quota', payloadHash: 'b'.repeat(64), maxCostMicros: 100, now: new Date() },
    { enabled: true, dailyBudgetMicros: 100, priceBasis: 'synthetic', reservationTtlMs: 60_000 });
  await expect(deleteTrip(other.owner.id, trip.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  expect(await readShare(share.token)).not.toBeNull();
  await deleteTrip(owner.id, trip.id);
  expect(await getTrip(owner.id, trip.id)).toBeNull();
  expect(await readShare(share.token)).toBeNull();
  expect(await getTrip(other.owner.id, other.trip.id)).not.toBeNull();
  for (const table of ['trip_versions', 'trip_shares', 'proposals', 'mutation_receipts', 'agent_runs']) {
    expect((await database().query(`SELECT * FROM ${table} WHERE trip_id=$1`, [trip.id])).rowCount).toBe(0);
  }
  expect((await database().query('SELECT charged_cost_micros FROM quota_reservations')).rows).toEqual([{ charged_cost_micros: '100' }]);
  await expect(reserveRun({ ownerId: owner.id, ipKey: 'a'.repeat(64), requestId: 'new', payloadHash: 'b'.repeat(64), maxCostMicros: 1, now: new Date() },
    { enabled: true, dailyBudgetMicros: 100, priceBasis: 'synthetic', reservationTtlMs: 60_000 })).rejects.toMatchObject({ code: 'QUOTA_BUDGET' });
}));

test('active lease and worker advisory lock both fence deletion; no partial deletion', () => withDatabase(async () => {
  const { owner, trip } = await setup();
  const { run } = await startRun(owner.id, trip.id, 'run', '第二天下午留白', 1);
  await expect(deleteTrip(owner.id, trip.id)).rejects.toMatchObject({ code: 'RUN_ACTIVE' });
  await database().query("UPDATE agent_runs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [run.id]);
  const client = await database().connect();
  const schema = (await client.query('SELECT current_schema() AS name')).rows[0].name;
  const key = `${schema}_adk:${run.id}`;
  try {
    await client.query('SELECT pg_advisory_lock(724916,hashtext($1))', [key]);
    await expect(deleteTrip(owner.id, trip.id)).rejects.toMatchObject({ code: 'RUN_ACTIVE' });
    expect(await getTrip(owner.id, trip.id)).not.toBeNull();
  } finally { await client.query('SELECT pg_advisory_unlock(724916,hashtext($1))', [key]); client.release(); }
  await deleteTrip(owner.id, trip.id);
}));

test('expiry checks trip and owner at DB time, leaves live trips, and is repeatable', () => withDatabase(async () => {
  const a = await setup(), b = await setup(), live = await setup();
  await database().query('UPDATE trips SET expires_at=clock_timestamp() WHERE id=$1', [a.trip.id]);
  await database().query('UPDATE sessions SET expires_at=clock_timestamp() WHERE id=$1', [b.owner.id]);
  expect(await expireTrips()).toEqual({ deletedTrips: 2, busyTrips: 0 });
  expect(await expireTrips()).toEqual({ deletedTrips: 0, busyTrips: 0 });
  expect(await getTrip(live.owner.id, live.trip.id)).not.toBeNull();
}));

test('DELETE requires same origin, owner cookie and strict empty JSON', () => withDatabase(async () => {
  const { owner, trip } = await setup();
  const req = (site = origin, body: unknown = {}, token = owner.token) => new Request(`${origin}/api/trips/${trip.id}`, {
    method: 'DELETE', headers: { origin: site, 'content-type': 'application/json', cookie: `dive_trip_session=${token}` }, body: JSON.stringify(body),
  });
  expect((await handleRequest(req('https://attacker.invalid'))).status).toBe(400);
  expect((await handleRequest(req(origin, { owner: owner.id }))).status).toBe(400);
  expect((await handleRequest(req(origin, {}, 'invalid'))).status).toBe(404);
  expect((await handleRequest(req())).status).toBe(200);
  expect((await handleRequest(req())).status).toBe(404);
}));

test('expired invocation/accounting is removed but conservative reservation remains', () => withDatabase(async () => {
  const { owner, trip } = await setup();
  const admitted = await admitStart({ ownerId: owner.id, tripId: trip.id, ipKey: 'a'.repeat(64),
    requestId: 'start', message: 'test', baseVersion: 1, maxCostMicros: 100, now: new Date(),
    policy: { enabled: true, dailyBudgetMicros: 100, priceBasis: 'synthetic', reservationTtlMs: 60_000 } });
  await accountModelCall(owner.id, trip.id, admitted.admission.id, { kind: 'model-call-start', callId: randomUUID() });
  await database().query("UPDATE agent_runs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [admitted.run.id]);
  await deleteTrip(owner.id, trip.id);
  expect((await database().query('SELECT * FROM model_calls')).rowCount).toBe(0);
  expect((await database().query('SELECT * FROM agent_invocations')).rowCount).toBe(0);
  expect((await database().query('SELECT charged_cost_micros FROM quota_reservations')).rows).toEqual([{ charged_cost_micros: '100' }]);
}));

test('expiry skips executing workers without deleting a partial graph', () => withDatabase(async () => {
  const { owner, trip } = await setup();
  await startRun(owner.id, trip.id, 'running', 'test', 1);
  await database().query('UPDATE trips SET expires_at=clock_timestamp() WHERE id=$1', [trip.id]);
  expect(await expireTrips()).toEqual({ deletedTrips: 0, busyTrips: 1 });
  expect((await database().query('SELECT * FROM trip_versions WHERE trip_id=$1', [trip.id])).rowCount).toBe(1);
  await database().query("UPDATE agent_runs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE trip_id=$1", [trip.id]);
  expect(await expireTrips()).toEqual({ deletedTrips: 1, busyTrips: 0 });
}));

test('deletion drains receipt replay before locking trip, preventing lock inversion', () => withDatabase(async () => {
  const { owner, trip } = await setup();
  await restoreVersion(owner.id, { tripId: trip.id, baseVersion: 1, targetVersion: 1, requestId: 'receipt' });
  const replay = await database().connect();
  let deletion: Promise<void> | undefined;
  try {
    await replay.query('BEGIN');
    await replay.query('SELECT id FROM sessions WHERE id=$1 FOR SHARE', [owner.id]);
    await replay.query('SELECT * FROM mutation_receipts WHERE owner_id=$1 FOR UPDATE', [owner.id]);
    const pid = (await replay.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    deletion = deleteTrip(owner.id, trip.id);
    // Observe an actual blocked DELETE transaction, not an arbitrary sleep.
    let waiting = false;
    for (let i = 0; i < 200; i++) {
      waiting = (await replay.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
        WHERE $1=ANY(pg_blocking_pids(pid)) AND wait_event_type='Lock') AS waiting`, [pid])).rows[0].waiting;
      if (waiting) break;
      await delay(10);
      await replay.query('SELECT pg_stat_clear_snapshot()');
    }
    expect(waiting).toBe(true);
    // Old SHARE deletion had already locked trip before waiting on receipt.
    await replay.query('SELECT id FROM trips WHERE id=$1 FOR UPDATE NOWAIT', [trip.id]);
  } finally {
    await replay.query('ROLLBACK'); replay.release();
    await deletion;
  }
  expect(await getTrip(owner.id, trip.id)).toBeNull();
}));

test('real ADK pending session/events erased; late worker cannot recreate deleted session', () => withDatabase(async () => {
  const { owner, trip } = await setup();
  const req = new Request(`${origin}/api/trips/${trip.id}/agent`, { method: 'POST',
    headers: { origin, 'content-type': 'application/json', cookie: `dive_trip_session=${owner.token}` },
    body: JSON.stringify({ threadId: trip.id, runId: randomUUID(), messages: [{ id: randomUUID(), role: 'user', content: '第二天下午留白' }],
      state: {}, tools: [], context: [], forwardedProps: { baseVersion: 1 } }),
  });
  const response = await handleRequest(req);
  expect(await response.text()).toContain('RUN_FINISHED');
  const run = (await database().query('SELECT id,status FROM agent_runs WHERE trip_id=$1', [trip.id])).rows[0];
  expect(run.status).toBe('awaiting_confirmation');
  const schema = (await database().query('SELECT current_schema() AS name')).rows[0].name;
  expect((await database().query(`SELECT id FROM "${schema}_adk".events`)).rowCount).toBeGreaterThan(0);
  // Inject a final product-delete failure after ADK DELETE statements executed.
  await database().query(`CREATE FUNCTION fail_delete() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'injected'; END $$;
    CREATE TRIGGER fail_delete BEFORE DELETE ON trips FOR EACH ROW EXECUTE FUNCTION fail_delete()`);
  await expect(deleteTrip(owner.id, trip.id)).rejects.toThrow();
  expect((await database().query(`SELECT id FROM "${schema}_adk".events`)).rowCount).toBeGreaterThan(0);
  expect(await getTrip(owner.id, trip.id)).not.toBeNull();
  await database().query('DROP TRIGGER fail_delete ON trips; DROP FUNCTION fail_delete()');
  await deleteTrip(owner.id, trip.id);
  for (const table of ['sessions', 'events', 'user_states']) {
    expect((await database().query(`SELECT * FROM "${schema}_adk".${table} WHERE user_id=$1`, [owner.id])).rowCount).toBe(0);
  }
  await expect(executeAgent({ runId: run.id, sessionId: run.id, ownerId: owner.id, tripId: trip.id, baseVersion: 1,
    snapshot: trip.snapshot, catalog: trip.snapshot.entries.map(e => e.item), input: { kind: 'start', message: '第二天下午留白' } },
  { signal: AbortSignal.timeout(20_000), onEvent: async () => {} },
  { databaseUrl: testDatabaseUrl(), schema: `${schema}_adk`, productTripId: trip.id })).rejects.toThrow();
  expect((await database().query(`SELECT * FROM "${schema}_adk".sessions WHERE user_id=$1`, [owner.id])).rowCount).toBe(0);
}), 30_000);
