import { expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { withDatabase } from '../support/database';
import { createSession } from '../../src/server/session';
import { createTrip, getTrip } from '../../src/server/trip-store';
import { applyProposal, saveProposal, restoreVersion, rejectProposal } from '../../src/server/version-store';
import { database, makePool, withDatabasePool } from '../../src/server/db';
import { testDatabaseUrl } from '../support/database';
import { buildProposal } from '../../src/domain/proposal';
import { makeSnapshot } from '../support/domain-fixtures';
import type { Change, ProposalDraft, TripView } from '../../src/domain/types';

async function setup() {
  const owner = await createSession(); const trip = await createTrip(owner.id, makeSnapshot());
  return { owner, trip };
}
function draftFor(trip: TripView, changes: Change[] = [{ kind: 'remove', entryId: 'transfer' }]) {
  return buildProposal(trip.snapshot, changes, trip.snapshot.entries.map(e => e.item), 'user');
}
async function proposal(owner: string, trip: TripView, changes?: Change[]) {
  const proposalId = await saveProposal(owner, trip.id, trip.version, draftFor(trip, changes));
  return { tripId: trip.id, proposalId, baseVersion: trip.version, requestId: randomUUID() };
}
async function count(table: 'trip_versions' | 'mutation_receipts') {
  return Number((await database().query(`SELECT count(*) AS count FROM ${table}`)).rows[0].count);
}

test('重送套用只增加一個版本，復原建立新版完整快照', () => withDatabase(async () => {
  const owner = await createSession(); const s = makeSnapshot();
  const trip = await createTrip(owner.id, s);
  const draft = buildProposal(s, [{ kind: 'remove', entryId: 'transfer' }], s.entries.map(e => e.item), 'user');
  const proposalId = await saveProposal(owner.id, trip.id, 1, draft);
  const input = { tripId: trip.id, proposalId, baseVersion: 1, requestId: 'apply-1' };
  const first = await applyProposal(owner.id, input);
  expect(await applyProposal(owner.id, input)).toEqual(first);
  expect((await getTrip(owner.id, trip.id))?.version).toBe(2);
  const restored = await restoreVersion(owner.id, { tripId: trip.id, targetVersion: 1, baseVersion: 2, requestId: 'restore-1' });
  expect(restored.version).toBe(3);
  expect(restored.snapshot).toEqual(s);
}));

test('等待確認與拒絕不寫版本，重複拒絕可重送且不得再套用', () => withDatabase(async () => {
  const { owner, trip } = await setup(); const input = await proposal(owner.id, trip);
  expect(await getTrip(owner.id, trip.id)).toEqual(trip);
  await rejectProposal(owner.id, trip.id, input.proposalId);
  await rejectProposal(owner.id, trip.id, input.proposalId);
  await expect(applyProposal(owner.id, input)).rejects.toMatchObject({ code: 'INVALID_PROPOSAL' });
  expect(await count('trip_versions')).toBe(1);
  expect(await count('mutation_receipts')).toBe(0);
}));

test('相同 requestId 並行 10 次只寫一次且回同一結果', () => withDatabase(async () => {
  const { owner, trip } = await setup(); const input = await proposal(owner.id, trip);
  const results = await Promise.all(Array.from({ length: 10 }, () => applyProposal(owner.id, input)));
  expect(results.every(result => JSON.stringify(result) === JSON.stringify(results[0]))).toBe(true);
  expect(await count('trip_versions')).toBe(2);
  expect(await count('mutation_receipts')).toBe(1);
}));

test('不同提案並行只有一筆成功，另一筆 stale 而非覆寫', () => withDatabase(async () => {
  const { owner, trip } = await setup();
  const a = await proposal(owner.id, trip);
  const b = await proposal(owner.id, trip, [{ kind: 'remove', entryId: 'tour' }]);
  const outcomes = await Promise.allSettled([applyProposal(owner.id, a), applyProposal(owner.id, b)]);
  expect(outcomes.filter(o => o.status === 'fulfilled')).toHaveLength(1);
  const rejected = outcomes.find(o => o.status === 'rejected') as PromiseRejectedResult;
  expect(rejected.reason).toMatchObject({ code: 'STALE_VERSION' });
  expect(await count('trip_versions')).toBe(2);
  expect(await count('mutation_receipts')).toBe(1);
}));

test('同 requestId 異 payload 並行只接受一個', () => withDatabase(async () => {
  const { owner, trip } = await setup(); const a = await proposal(owner.id, trip);
  const b = { ...await proposal(owner.id, trip, [{ kind: 'remove', entryId: 'tour' }]), requestId: a.requestId };
  const results = await Promise.allSettled([applyProposal(owner.id, a), applyProposal(owner.id, b)]);
  expect(results.filter(o => o.status === 'fulfilled')).toHaveLength(1);
  expect((results.find(o => o.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(await count('trip_versions')).toBe(2);
}));

test('跨 operation 重用 requestId 拒絕；不同 owner 可用相同 requestId', () => withDatabase(async () => {
  const a = await setup(); const b = await setup();
  const input = await proposal(a.owner.id, a.trip);
  await applyProposal(a.owner.id, input);
  await expect(restoreVersion(a.owner.id, { tripId: a.trip.id, baseVersion: 2, targetVersion: 1, requestId: input.requestId }))
    .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  const second = await proposal(b.owner.id, b.trip);
  expect((await applyProposal(b.owner.id, { ...second, requestId: input.requestId })).version).toBe(2);
}));

test('回應遺失後重播舊收據，回原版本而不是較新的目前版本', () => withDatabase(async () => {
  const { owner, trip } = await setup(); const input = await proposal(owner.id, trip);
  const first = await applyProposal(owner.id, input);
  const restore = { tripId: trip.id, baseVersion: 2, targetVersion: 1, requestId: 'restore-lost-response' };
  const restored = await restoreVersion(owner.id, restore);
  expect(await restoreVersion(owner.id, restore)).toEqual(restored);
  expect(await applyProposal(owner.id, { requestId: input.requestId, proposalId: input.proposalId, tripId: input.tripId, baseVersion: 1 })).toEqual(first);
  expect((await getTrip(owner.id, trip.id))?.version).toBe(3);
  expect(await count('trip_versions')).toBe(3);
}));

test('套用後新 requestId 不能再套用同提案，其他 pending 變 stale', () => withDatabase(async () => {
  const { owner, trip } = await setup(); const input = await proposal(owner.id, trip);
  const pending = await proposal(owner.id, trip);
  await applyProposal(owner.id, input);
  await expect(applyProposal(owner.id, { ...input, requestId: 'fresh' })).rejects.toMatchObject({ code: 'STALE_VERSION' });
  await expect(applyProposal(owner.id, pending)).rejects.toMatchObject({ code: 'STALE_VERSION' });
  await expect(saveProposal(owner.id, trip.id, 1, draftFor(trip))).rejects.toMatchObject({ code: 'STALE_VERSION' });
  expect((await database().query('SELECT status FROM proposals WHERE id=$1', [pending.proposalId])).rows[0].status).toBe('stale');
}));

test('其他擁有者不能保存／套用／拒絕／復原；跨 trip proposal 不可移用', () => withDatabase(async () => {
  const a = await setup(); const b = await setup(); const input = await proposal(a.owner.id, a.trip);
  await expect(saveProposal(b.owner.id, a.trip.id, 1, draftFor(a.trip))).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(applyProposal(b.owner.id, input)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(rejectProposal(b.owner.id, a.trip.id, input.proposalId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(restoreVersion(b.owner.id, { tripId: a.trip.id, baseVersion: 1, targetVersion: 1, requestId: 'x' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  const sameOwnerTrip = await createTrip(a.owner.id, makeSnapshot());
  await expect(applyProposal(a.owner.id, { ...input, tripId: sameOwnerTrip.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  expect(await count('mutation_receipts')).toBe(0);
}));

test('過期行程即使有成功收據也不能重播', () => withDatabase(async () => {
  const { owner, trip } = await setup(); const input = await proposal(owner.id, trip);
  await applyProposal(owner.id, input);
  await database().query('UPDATE trips SET expires_at=now() WHERE id=$1', [trip.id]);
  await expect(applyProposal(owner.id, input)).rejects.toMatchObject({ code: 'NOT_FOUND' });
}));

test('session 過期拒絕 mutation', () => withDatabase(async () => {
  const { owner, trip } = await setup(); const input = await proposal(owner.id, trip);
  await database().query('UPDATE sessions SET expires_at=now() WHERE id=$1', [owner.id]);
  await expect(applyProposal(owner.id, input)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  expect(await count('mutation_receipts')).toBe(0);
}));

test.each([false, true])('等待 trip 鎖跨過到期必須拒絕，receipt replay=%s', replay => withDatabase(async () => {
  const { owner, trip } = await setup(); const input = await proposal(owner.id, trip);
  if (replay) await applyProposal(owner.id, input);
  const initialVersions = await count('trip_versions');
  await database().query("UPDATE trips SET expires_at=clock_timestamp()+interval '1 second' WHERE id=$1", [trip.id]);
  const holder = await database().connect();
  let pending: Promise<unknown> | undefined;
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM trips WHERE id=$1 FOR UPDATE', [trip.id]);
    const pid = (await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    pending = applyProposal(owner.id, input).then(value => value, error => error);
    let blocked = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      const result = await database().query('SELECT 1 FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))', [pid]);
      if (result.rowCount) { blocked = true; break; }
      await delay(10);
    }
    expect(blocked, 'Must exercise a real lock wait, not a pre-expired request').toBe(true);
    await holder.query('SELECT pg_sleep(1.1)');
    await holder.query('COMMIT');
    expect(await pending).toMatchObject({ code: 'NOT_FOUND' });
    expect(await count('trip_versions')).toBe(initialVersions);
  } finally {
    await holder.query('ROLLBACK'); holder.release();
    await pending;
  }
}));

test('未解衝突可保存供顯示，但不得套用', () => withDatabase(async () => {
  const { owner, trip } = await setup();
  const input = await proposal(owner.id, trip, [{ kind: 'requirements', value: { ...trip.snapshot.requirements, budgetMinor: 100 } }]);
  await expect(applyProposal(owner.id, input)).rejects.toMatchObject({ code: 'INVALID_PROPOSAL' });
  expect(await getTrip(owner.id, trip.id)).toEqual(trip);
}));

test('篡改 canApply、費用或額外欄位不能繞過重新驗證', () => withDatabase(async () => {
  const { owner, trip } = await setup(); const input = await proposal(owner.id, trip);
  const draft = draftFor(trip); draft.budget.knownMinor = 0;
  await expect(saveProposal(owner.id, trip.id, 1, draft)).rejects.toMatchObject({ code: 'INVALID_PROPOSAL' });
  await expect(saveProposal(owner.id, trip.id, 1, { ...draftFor(trip), actor: 'user' } as ProposalDraft)).rejects.toMatchObject({ code: 'INVALID_PROPOSAL' });
  await database().query("UPDATE proposals SET draft=jsonb_set(draft,'{next,entries,0,rooms}','2') WHERE id=$1", [input.proposalId]);
  await expect(applyProposal(owner.id, input)).rejects.toMatchObject({ code: 'INVALID_PROPOSAL' });
  expect(await count('trip_versions')).toBe(1);
}));

test('鎖定不可藉 canApply=true 套用被篡改提案', () => withDatabase(async () => {
  const owner = await createSession(); const s = makeSnapshot(); s.entries[0].locked = true;
  const trip = await createTrip(owner.id, s);
  const draft = draftFor(trip, [{ kind: 'remove', entryId: 'stay' }]);
  expect(draft.canApply).toBe(false);
  const id = await saveProposal(owner.id, trip.id, 1, draft);
  await database().query("UPDATE proposals SET draft=jsonb_set(draft,'{canApply}','true') WHERE id=$1", [id]);
  await expect(applyProposal(owner.id, { tripId: trip.id, proposalId: id, baseVersion: 1, requestId: 'bypass' }))
    .rejects.toMatchObject({ code: 'INVALID_PROPOSAL' });
}));

test('最後收據寫入失敗，版本／pointer／proposal／receipt 全數回滾，可同ID重試', () => withDatabase(async () => {
  const { owner, trip } = await setup(); const input = await proposal(owner.id, trip);
  await database().query(`CREATE FUNCTION fail_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'injected receipt failure'; END $$;
    CREATE TRIGGER fail_receipt BEFORE UPDATE ON mutation_receipts FOR EACH ROW EXECUTE FUNCTION fail_receipt()`);
  await expect(applyProposal(owner.id, input)).rejects.toThrow('injected receipt failure');
  expect(await getTrip(owner.id, trip.id)).toEqual(trip);
  expect(await count('trip_versions')).toBe(1);
  expect(await count('mutation_receipts')).toBe(0);
  expect((await database().query('SELECT status FROM proposals WHERE id=$1', [input.proposalId])).rows[0].status).toBe('pending');
  await database().query('DROP TRIGGER fail_receipt ON mutation_receipts');
  expect((await applyProposal(owner.id, input)).version).toBe(2);
}));

test('复原完整需求、來源、鎖定、座標與 exclusions，並使舊提案 stale', () => withDatabase(async () => {
  const owner = await createSession(); const s = makeSnapshot();
  s.entries[0].locked = true; s.exclusions = ['未含餐費'];
  const trip = await createTrip(owner.id, s);
  const applied = await applyProposal(owner.id, await proposal(owner.id, trip));
  const pending = await proposal(owner.id, applied, [{ kind: 'remove', entryId: 'tour' }]);
  const restored = await restoreVersion(owner.id, { tripId: trip.id, baseVersion: 2, targetVersion: 1, requestId: 'full' });
  expect(restored.snapshot).toEqual(s); expect(restored.budget).toEqual(trip.budget);
  expect((await database().query('SELECT status FROM proposals WHERE id=$1', [pending.proposalId])).rows[0].status).toBe('stale');
  const schema = (await database().query('SELECT current_schema() AS name')).rows[0].name;
  const freshPool = makePool(testDatabaseUrl(), schema);
  try { expect(await withDatabasePool(freshPool, () => getTrip(owner.id, trip.id))).toEqual(restored); }
  finally { await freshPool.end(); }
}));

test('復原不存在版本與 malformed mutation 不能寫入', () => withDatabase(async () => {
  const { owner, trip } = await setup();
  await expect(restoreVersion(owner.id, { tripId: trip.id, baseVersion: 1, targetVersion: 99, requestId: 'missing' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(restoreVersion(owner.id, { tripId: trip.id, baseVersion: 1, targetVersion: 1, requestId: '' })).rejects.toMatchObject({ code: 'INVALID_PROPOSAL' });
  expect(await count('mutation_receipts')).toBe(0);
  expect(await count('trip_versions')).toBe(1);
}));
