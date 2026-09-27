import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { EventType, type BaseEvent } from '@ag-ui/core';
import { expect, test } from 'vitest';
import { database, makePool, withDatabasePool } from '../../src/server/db';
import { createSession } from '../../src/server/session';
import { createTrip } from '../../src/server/trip-store';
import { saveProposal, applyProposal } from '../../src/server/version-store';
import { buildProposal } from '../../src/domain/proposal';
import { startRun, getRun, listRuns, appendRunEvent, finishRun, claimResume, bindProposal } from '../../src/server/run-store';
import { testDatabaseUrl, withDatabase } from '../support/database';
import { makeSnapshot } from '../support/domain-fixtures';
import { awaitConfirmation, recordDecisionAnswer, recordProposalAnswer, recordSimpleAnswer, startAnswerPhase } from './p3-fixtures';

async function setup() {
  const owner = await createSession();
  const trip = await createTrip(owner.id, makeSnapshot());
  const { run } = await startRun(owner.id, trip.id, 'request', '第二天下午留白', 1);
  return { owner, trip, run };
}
const event = (value = 1) => ({ type: EventType.TOOL_CALL_END, toolCallId: `call-${value}` });
async function expire(id: string) {
  await database().query("UPDATE agent_runs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [id]);
}
async function proposal(owner: string, tripId: string) {
  const snapshot = makeSnapshot();
  return saveProposal(owner, tripId, 1,
    buildProposal(snapshot, [{ kind: 'remove', entryId: 'transfer' }], snapshot.entries.map(e => e.item), 'user'));
}

test('同 ID 並行只建立一個 UUID run，hash 綁 payload，不同 payload 衝突', () => withDatabase(async () => {
  const owner = await createSession(); const trip = await createTrip(owner.id, makeSnapshot());
  const results = await Promise.all(Array.from({ length: 10 }, () => startRun(owner.id, trip.id, 'same', 'message', 1)));
  expect(results.filter(r => r.created)).toHaveLength(1);
  expect(new Set(results.map(r => r.run.id)).size).toBe(1);
  expect(results[0].run).toMatchObject({ tripId: trip.id, baseVersion: 1, message: 'message', status: 'running',
    events: [], proposalId: null, interruptId: null, decision: null, answerContractVersion: 1 });
  expect(results[0].run.id).toMatch(/^[0-9a-f-]{36}$/);
  for (const args of [['changed', 1], ['message', 2]] as const) {
    await expect(startRun(owner.id, trip.id, 'same', args[0], args[1])).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  }
  const row = (await database().query('SELECT payload_hash,EXTRACT(EPOCH FROM lease_expires_at-created_at)::float8 AS lease FROM agent_runs')).rows[0];
  expect(row.payload_hash).toMatch(/^[0-9a-f]{64}$/);
  expect(row.lease).toBeCloseTo(60, 1);
}));

test('不同 ID 並行同 trip 只有一個 active；同 ID 異 payload 只有一個贏', () => withDatabase(async () => {
  const owner = await createSession(); const trip = await createTrip(owner.id, makeSnapshot());
  const results = await Promise.allSettled(['a', 'b'].map(id => startRun(owner.id, trip.id, id, 'message', 1)));
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.find(r => r.status === 'rejected')).toMatchObject({ reason: { code: 'RUN_ACTIVE' } });
  const otherTrip = await createTrip(owner.id, makeSnapshot());
  const clash = await Promise.allSettled(['one', 'two'].map(text => startRun(owner.id, otherTrip.id, 'same', text, 1)));
  expect(clash.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(clash.find(r => r.status === 'rejected')).toMatchObject({ reason: { code: 'IDEMPOTENCY_CONFLICT' } });
}));

test('request/text 上限與 version；失敗不留 run', () => withDatabase(async () => {
  const owner = await createSession(); const trip = await createTrip(owner.id, makeSnapshot());
  for (const [id, text, version] of [['', 'x', 1], [' '.repeat(2), 'x', 1], ['a'.repeat(129), 'x', 1],
    ['id', '', 1], ['id', ' '.repeat(2), 1], ['id', 'x'.repeat(4001), 1], ['id', 'x', 0], ['id', 'x', 1.5]] as const) {
    await expect(startRun(owner.id, trip.id, id, text, version)).rejects.toMatchObject({ code: 'INVALID_RUN' });
  }
  await expect(startRun(owner.id, trip.id, 'stale', 'x', 2)).rejects.toMatchObject({ code: 'STALE_VERSION' });
  expect(await listRuns(owner.id, trip.id)).toEqual([]);
  await expect(startRun(owner.id, trip.id, 'a'.repeat(128), 'x'.repeat(4000), 1)).resolves.toMatchObject({ created: true });
}));

test('owner／trip／run 隔離覆蓋所有入口；非法 ID 不洩漏', () => withDatabase(async () => {
  const { owner, trip, run } = await setup(); const stranger = await createSession();
  const otherTrip = await createTrip(owner.id, makeSnapshot());
  for (const [ownerId, tripId] of [[stranger.id, trip.id], [owner.id, otherTrip.id], ['invalid', trip.id]]) {
    expect(await getRun(ownerId, tripId, run.id)).toBeNull();
    expect(await listRuns(ownerId, tripId)).toEqual([]);
    for (const work of [() => appendRunEvent(ownerId, tripId, run.id, event()),
      () => finishRun(ownerId, tripId, run.id, { status: 'failed' }),
      () => bindProposal(ownerId, tripId, run.id, randomUUID(), 'gate', 'proposal-call'),
      () => claimResume(ownerId, tripId, run.id, 'gate', true)]) {
      await expect(work()).rejects.toMatchObject({ code: 'NOT_FOUND' });
    }
  }
  await expect(startRun(stranger.id, trip.id, 'request', run.message, 1)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  expect(await getRun(owner.id, trip.id, 'invalid')).toBeNull();
}));

test.each(['sessions', 'trips'] as const)('%s TTL 禁止讀取、重送及所有寫入', table => withDatabase(async () => {
  const { owner, trip, run } = await setup();
  await awaitConfirmation(owner.id, trip.id, run.id);
  await database().query(`UPDATE ${table} SET expires_at=clock_timestamp() WHERE id=$1`, [table === 'sessions' ? owner.id : trip.id]);
  expect(await getRun(owner.id, trip.id, run.id)).toBeNull();
  expect(await listRuns(owner.id, trip.id)).toEqual([]);
  for (const work of [() => startRun(owner.id, trip.id, 'request', run.message, 1),
    () => appendRunEvent(owner.id, trip.id, run.id, event()),
    () => finishRun(owner.id, trip.id, run.id, { status: 'failed' }),
    () => bindProposal(owner.id, trip.id, run.id, randomUUID(), 'gate', 'proposal-call'),
    () => claimResume(owner.id, trip.id, run.id, 'gate', true)]) {
    await expect(work()).rejects.toMatchObject({ code: 'NOT_FOUND' });
  }
}));

test('schema 驗證、並行連續 sequence、JSONB commit 後新連線可重播；append 不延 lease', () => withDatabase(async () => {
  const { owner, trip, run } = await setup();
  const before = (await database().query('SELECT lease_expires_at FROM agent_runs WHERE id=$1', [run.id])).rows[0];
  for (const invalid of [{ type: 'invented' }, { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'id' }]) {
    await expect(appendRunEvent(owner.id, trip.id, run.id, invalid as BaseEvent)).rejects.toMatchObject({ code: 'INVALID_RUN_EVENT' });
  }
  const outputs = await Promise.all(Array.from({ length: 12 }, (_, n) => appendRunEvent(owner.id, trip.id, run.id, event(n))));
  expect(outputs.map(e => e.sequence).sort((a, b) => a - b)).toEqual(Array.from({ length: 12 }, (_, n) => n + 1));
  const schema = (await database().query('SELECT current_schema() AS name')).rows[0].name;
  const pool = makePool(testDatabaseUrl(), schema);
  try {
    const read = await withDatabasePool(pool, () => getRun(owner.id, trip.id, run.id));
    expect(read?.events).toEqual(outputs.sort((a, b) => a.sequence - b.sequence));
  } finally { await pool.end(); }
  expect((await database().query('SELECT lease_expires_at FROM agent_runs WHERE id=$1', [run.id])).rows[0]).toEqual(before);
  expect((await database().query('SELECT pg_typeof(event)::text AS type FROM agent_run_events LIMIT 1')).rows[0].type).toBe('jsonb');
}));

test('event 寫入失敗 rollback，不消耗 sequence', () => withDatabase(async () => {
  const { owner, trip, run } = await setup();
  await database().query(`CREATE FUNCTION reject_event() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'injected event failure'; END $$;
    CREATE TRIGGER reject_event BEFORE INSERT ON agent_run_events FOR EACH ROW EXECUTE FUNCTION reject_event()`);
  await expect(appendRunEvent(owner.id, trip.id, run.id, event())).rejects.toThrow('injected event failure');
  expect((await getRun(owner.id, trip.id, run.id))?.events).toEqual([]);
  await database().query('DROP TRIGGER reject_event ON agent_run_events');
  expect((await appendRunEvent(owner.id, trip.id, run.id, event())).sequence).toBe(1);
}));

test.each(['get', 'list', 'append', 'finish', 'start'] as const)('%s 入口持久化 lease 過期；終態不能復活', entry => withDatabase(async () => {
  const { owner, trip, run } = await setup(); await expire(run.id);
  if (entry === 'get') expect((await getRun(owner.id, trip.id, run.id))?.status).toBe('interrupted');
  if (entry === 'list') expect((await listRuns(owner.id, trip.id))[0].status).toBe('interrupted');
  if (entry === 'append') await expect(appendRunEvent(owner.id, trip.id, run.id, event())).rejects.toMatchObject({ code: 'RUN_NOT_RUNNING' });
  if (entry === 'finish') await expect(finishRun(owner.id, trip.id, run.id, { status: 'succeeded' })).rejects.toMatchObject({ code: 'RUN_STATE_CONFLICT' });
  if (entry === 'start') expect((await startRun(owner.id, trip.id, 'request', run.message, 1)).run.status).toBe('interrupted');
  expect((await database().query('SELECT status FROM agent_runs WHERE id=$1', [run.id])).rows[0].status).toBe('interrupted');
  await expect(startRun(owner.id, trip.id, 'new', 'new', 1)).resolves.toMatchObject({ created: true });
  await expect(finishRun(owner.id, trip.id, run.id, { status: 'succeeded' })).rejects.toMatchObject({ code: 'RUN_STATE_CONFLICT' });
}));

test('bind 僅保存同 trip/base proposal；保持 running、不可換綁；await 不受原 lease 影響', () => withDatabase(async () => {
  const { owner, trip, run } = await setup(); const id = await proposal(owner.id, trip.id);
  const other = await createTrip(owner.id, makeSnapshot()); const otherId = await proposal(owner.id, other.id);
  await expect(bindProposal(owner.id, trip.id, run.id, otherId, 'gate', 'proposal-call')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  const bound = await bindProposal(owner.id, trip.id, run.id, id, 'gate', 'proposal-call');
  expect(bound).toMatchObject({ status: 'running', proposalId: id, interruptId: 'gate', decision: null });
  expect(await bindProposal(owner.id, trip.id, run.id, id, 'gate', 'proposal-call')).toEqual(bound);
  await expect(bindProposal(owner.id, trip.id, run.id, id, 'other', 'proposal-call')).rejects.toMatchObject({ code: 'RUN_STATE_CONFLICT' });
  await expect(bindProposal(owner.id, trip.id, run.id, id, 'gate', 'other-tool')).rejects.toMatchObject({ code: 'RUN_STATE_CONFLICT' });
  await expect(finishRun(owner.id, trip.id, run.id, { status: 'awaiting_confirmation', proposalId: otherId })).rejects.toMatchObject({ code: 'RUN_STATE_CONFLICT' });
  await startAnswerPhase(owner.id, trip.id, run.id);
  await recordProposalAnswer(owner.id, trip.id, run.id, id);
  const waiting = await finishRun(owner.id, trip.id, run.id, { status: 'awaiting_confirmation' });
  expect(waiting.status).toBe('awaiting_confirmation');
  await database().query("UPDATE agent_runs SET created_at=clock_timestamp()-interval '1 day' WHERE id=$1", [run.id]);
  expect((await getRun(owner.id, trip.id, run.id))?.status).toBe('awaiting_confirmation');
  expect((await database().query('SELECT lease_expires_at FROM agent_runs WHERE id=$1', [run.id])).rows[0].lease_expires_at).toBeNull();
  await expect(startRun(owner.id, trip.id, 'new', 'new', 1)).rejects.toMatchObject({ code: 'RUN_ACTIVE' });
  await expect(appendRunEvent(owner.id, trip.id, run.id, event())).rejects.toMatchObject({ code: 'RUN_NOT_RUNNING' });
}));

test.each([true, false])('decision=%s 並行 claim 只有一次、不可反轉、終態重播不執行', decision => withDatabase(async () => {
  const { owner, trip, run } = await setup();
  await awaitConfirmation(owner.id, trip.id, run.id);
  await expect(claimResume(owner.id, trip.id, run.id, 'unknown', decision)).rejects.toMatchObject({ code: 'RUN_STATE_CONFLICT' });
  const claims = await Promise.all(Array.from({ length: 10 }, () => claimResume(owner.id, trip.id, run.id, 'gate', decision)));
  expect(claims.filter(r => r.claimed)).toHaveLength(1);
  expect(claims.every(r => r.run.decision === decision && r.run.status === 'running')).toBe(true);
  await expect(claimResume(owner.id, trip.id, run.id, 'gate', !decision)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  await expect(finishRun(owner.id, trip.id, run.id, { status: 'awaiting_confirmation' })).rejects.toMatchObject({ code: 'RUN_STATE_CONFLICT' });
  await startAnswerPhase(owner.id, trip.id, run.id);
  await recordDecisionAnswer(owner.id, trip.id, run.id);
  await finishRun(owner.id, trip.id, run.id, { status: 'succeeded' });
  expect(await claimResume(owner.id, trip.id, run.id, 'gate', decision)).toMatchObject({ claimed: false, run: { status: 'succeeded', decision } });
  await expect(finishRun(owner.id, trip.id, run.id, { status: 'failed' })).rejects.toMatchObject({ code: 'RUN_STATE_CONFLICT' });
  expect((await finishRun(owner.id, trip.id, run.id, { status: 'succeeded' })).status).toBe('succeeded');
}));

test('互反 decision 競爭只接受一個；resume crash 不自動重新 claim', () => withDatabase(async () => {
  const { owner, trip, run } = await setup();
  await awaitConfirmation(owner.id, trip.id, run.id);
  const outcomes = await Promise.allSettled([true, false].map(d => claimResume(owner.id, trip.id, run.id, 'gate', d)));
  expect(outcomes.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(outcomes.find(r => r.status === 'rejected')).toMatchObject({ reason: { code: 'IDEMPOTENCY_CONFLICT' } });
  const saved = await getRun(owner.id, trip.id, run.id); const decision = saved!.decision!;
  await expire(run.id);
  expect(await claimResume(owner.id, trip.id, run.id, 'gate', decision)).toMatchObject({ claimed: false, run: { status: 'interrupted', decision } });
  await expect(claimResume(owner.id, trip.id, run.id, 'gate', !decision)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
}));

test('版本前進後 start 重送仍回原 run；proposal 必須符合 run base', () => withDatabase(async () => {
  const { owner, trip, run } = await setup(); const id = await proposal(owner.id, trip.id);
  const next = await applyProposal(owner.id, { tripId: trip.id, proposalId: id, requestId: 'apply', baseVersion: 1 });
  const newerId = await saveProposal(owner.id, trip.id, 2,
    buildProposal(next.snapshot, [{ kind: 'remove', entryId: 'tour' }], next.snapshot.entries.map(e => e.item), 'user'));
  await expect(bindProposal(owner.id, trip.id, run.id, newerId, 'gate', 'proposal-call')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  expect((await startRun(owner.id, trip.id, 'request', run.message, 1)).run.id).toBe(run.id);
}));

test.each(['sessions', 'trips'] as const)('等 trip 鎖跨 %s TTL 不得寫入', table => withDatabase(async () => {
  const { owner, trip, run } = await setup();
  await database().query(`UPDATE ${table} SET expires_at=clock_timestamp()+interval '1 second' WHERE id=$1`, [table === 'sessions' ? owner.id : trip.id]);
  const holder = await database().connect(); let pending: Promise<unknown> | undefined;
  try {
    await holder.query('BEGIN'); await holder.query('SELECT id FROM trips WHERE id=$1 FOR UPDATE', [trip.id]);
    const pid = (await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    pending = appendRunEvent(owner.id, trip.id, run.id, event()).then(v => v, e => e);
    let blocked = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      if ((await database().query('SELECT 1 FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))', [pid])).rowCount) { blocked = true; break; }
      await delay(10);
    }
    expect(blocked).toBe(true); await holder.query('SELECT pg_sleep(1.1)'); await holder.query('COMMIT');
    expect(await pending).toMatchObject({ code: 'NOT_FOUND' });
    expect((await database().query('SELECT * FROM agent_run_events')).rowCount).toBe(0);
  } finally { await holder.query('ROLLBACK'); holder.release(); await pending; }
}));

test('terminal event 與 status 原子提交，失敗不留假成功，重送不新增事件', () => withDatabase(async () => {
  const { owner, trip, run } = await setup();
  const invocationId = randomUUID();
  const started = { type: EventType.RUN_STARTED, threadId: trip.id, runId: invocationId };
  const terminal = { type: EventType.RUN_FINISHED, threadId: trip.id, runId: invocationId, outcome: { type: 'success' } };
  await expect(finishRun(owner.id, trip.id, run.id, { status: 'succeeded', event: terminal })).rejects.toMatchObject({ code: 'INVALID_RUN_EVENT' });
  await appendRunEvent(owner.id, trip.id, run.id, started);
  await expect(appendRunEvent(owner.id, trip.id, run.id, terminal)).rejects.toMatchObject({ code: 'INVALID_RUN_EVENT' });
  await expect(appendRunEvent(owner.id, trip.id, run.id, { type: EventType.RUN_ERROR, message: 'failed' })).rejects.toMatchObject({ code: 'INVALID_RUN_EVENT' });
  await expect(finishRun(owner.id, trip.id, run.id, { status: 'succeeded', event: terminal })).rejects.toMatchObject({ code: 'INVALID_RUN_EVENT' });
  const answer = await recordSimpleAnswer(owner.id, trip.id, run.id);
  await database().query(`CREATE FUNCTION reject_finish() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.status='succeeded' THEN RAISE EXCEPTION 'injected finish failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_finish BEFORE UPDATE ON agent_runs FOR EACH ROW EXECUTE FUNCTION reject_finish()`);
  await expect(finishRun(owner.id, trip.id, run.id, { status: 'succeeded', event: terminal })).rejects.toThrow('injected finish failure');
  expect(await getRun(owner.id, trip.id, run.id)).toMatchObject({ status: 'running', events: [{ sequence: 1, event: started }, answer] });
  await database().query('DROP TRIGGER reject_finish ON agent_runs');
  const finished = await finishRun(owner.id, trip.id, run.id, { status: 'succeeded', event: terminal });
  expect(finished).toMatchObject({ status: 'succeeded', events: [{ sequence: 1, event: started }, answer, { sequence: 3, event: terminal }] });
  expect(await finishRun(owner.id, trip.id, run.id, { status: 'succeeded', event: terminal })).toEqual(finished);
  await expect(finishRun(owner.id, trip.id, run.id, { status: 'succeeded', event: { ...terminal, timestamp: 1 } })).rejects.toMatchObject({ code: 'RUN_STATE_CONFLICT' });
  const schema = (await database().query('SELECT current_schema() AS name')).rows[0].name;
  const pool = makePool(testDatabaseUrl(), schema);
  try { expect(await withDatabasePool(pool, () => getRun(owner.id, trip.id, run.id))).toEqual(finished); }
  finally { await pool.end(); }
}));

test('awaiting terminal 與 interrupt 原子提交；resume 後可追加第二段事件', () => withDatabase(async () => {
  const { owner, trip, run } = await setup();
  const id = await proposal(owner.id, trip.id); await bindProposal(owner.id, trip.id, run.id, id, 'gate', 'proposal-call');
  const invocationId = randomUUID();
  const started = { type: EventType.RUN_STARTED, threadId: trip.id, runId: invocationId };
  await appendRunEvent(owner.id, trip.id, run.id, started);
  const terminal = { type: EventType.RUN_FINISHED, threadId: trip.id, runId: invocationId,
    outcome: { type: 'interrupt', interrupts: [{ id: 'gate', reason: 'approval' }] } };
  const answer = await recordProposalAnswer(owner.id, trip.id, run.id, id);
  const awaiting = await finishRun(owner.id, trip.id, run.id, { status: 'awaiting_confirmation', event: terminal });
  expect(awaiting).toMatchObject({ status: 'awaiting_confirmation', proposalId: id, interruptId: 'gate',
    events: [{ sequence: 1, event: started }, answer, { sequence: 3, event: terminal }] });
  expect(await finishRun(owner.id, trip.id, run.id, { status: 'awaiting_confirmation', event: terminal })).toEqual(awaiting);
  await claimResume(owner.id, trip.id, run.id, 'gate', true);
  const resumedId = randomUUID();
  await appendRunEvent(owner.id, trip.id, run.id, { ...started, runId: resumedId });
  await expect(finishRun(owner.id, trip.id, run.id, { status: 'succeeded',
    event: { ...terminal, outcome: { type: 'success' } } })).rejects.toMatchObject({ code: 'INVALID_RUN_EVENT' });
  expect((await appendRunEvent(owner.id, trip.id, run.id, event())).sequence).toBe(5);
  await recordDecisionAnswer(owner.id, trip.id, run.id);
  const finished = await finishRun(owner.id, trip.id, run.id, { status: 'succeeded',
    event: { type: EventType.RUN_FINISHED, threadId: trip.id, runId: resumedId, outcome: { type: 'success' } } });
  expect(finished.events.map(e => e.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  expect(finished.decision).toBe(true);
}));

test('terminal schema、status、thread/run/interrupt 必須吻合且錯誤不寫入', () => withDatabase(async () => {
  const { owner, trip, run } = await setup();
  const started = { type: EventType.RUN_STARTED, threadId: trip.id, runId: run.id };
  await appendRunEvent(owner.id, trip.id, run.id, started);
  const success = { type: EventType.RUN_FINISHED, threadId: trip.id, runId: run.id, outcome: { type: 'success' } };
  const cases = [
    { status: 'succeeded', event: event() },
    { status: 'succeeded', event: { type: EventType.RUN_ERROR, message: 'oops' } },
    { status: 'failed', event: success },
    { status: 'interrupted', event: success },
    { status: 'succeeded', event: { ...success, runId: randomUUID() } },
    { status: 'succeeded', event: { ...success, threadId: randomUUID() } },
    { status: 'awaiting_confirmation', interruptId: 'gate', event: success },
    { status: 'awaiting_confirmation', interruptId: 'gate', event: { ...success, outcome: { type: 'interrupt', interrupts: [{ id: 'wrong', reason: 'approval' }] } } },
    { status: 'succeeded', event: { type: EventType.RUN_FINISHED } },
  ] as const;
  for (const input of cases) await expect(finishRun(owner.id, trip.id, run.id, input)).rejects.toMatchObject({ code: 'INVALID_RUN_EVENT' });
  expect(await getRun(owner.id, trip.id, run.id)).toMatchObject({ status: 'running', events: [{ sequence: 1, event: started }] });
  await finishRun(owner.id, trip.id, run.id, { status: 'failed', event: { type: EventType.RUN_ERROR, message: 'offline failure' } });
  const next = await startRun(owner.id, trip.id, 'next', 'next', 1);
  await appendRunEvent(owner.id, trip.id, next.run.id, { ...started, runId: next.run.id });
  expect((await finishRun(owner.id, trip.id, next.run.id, { status: 'interrupted',
    event: { type: EventType.RUN_FINISHED, threadId: trip.id, runId: next.run.id, outcome: { type: 'cancelled' } } })).status).toBe('interrupted');
}));

test('等待 trip 鎖跨 lease 後不得 append，過期會提交', () => withDatabase(async () => {
  const { owner, trip, run } = await setup();
  await database().query("UPDATE agent_runs SET lease_expires_at=clock_timestamp()+interval '1 second' WHERE id=$1", [run.id]);
  const holder = await database().connect(); let pending: Promise<unknown> | undefined;
  try {
    await holder.query('BEGIN'); await holder.query('SELECT id FROM trips WHERE id=$1 FOR UPDATE', [trip.id]);
    pending = appendRunEvent(owner.id, trip.id, run.id, event()).then(v => v, e => e);
    await holder.query('SELECT pg_sleep(1.1)'); await holder.query('COMMIT');
    expect(await pending).toMatchObject({ code: 'RUN_NOT_RUNNING' });
    expect((await database().query('SELECT status FROM agent_runs WHERE id=$1', [run.id])).rows[0].status).toBe('interrupted');
    expect((await getRun(owner.id, trip.id, run.id))?.events).toMatchObject([
      { event: { type: 'CUSTOM', value: { body: { kind: 'failure', committed: null } } } },
      { event: { type: 'RUN_ERROR' } },
    ]);
  } finally { await holder.query('ROLLBACK'); holder.release(); await pending; }
}));

test('DB unique active / sequence 是最後防線，trip 刪除連帶清除 run/events', () => withDatabase(async () => {
  const { owner, trip, run } = await setup(); await appendRunEvent(owner.id, trip.id, run.id, event());
  await expect(database().query(`INSERT INTO agent_runs(id,trip_id,request_id,payload_hash,base_version,message,status,lease_expires_at)
    SELECT $1,trip_id,'other',payload_hash,base_version,message,status,lease_expires_at FROM agent_runs WHERE id=$2`,
  [randomUUID(), run.id])).rejects.toMatchObject({ code: '23505' });
  await expect(database().query('INSERT INTO agent_run_events SELECT * FROM agent_run_events WHERE run_id=$1', [run.id])).rejects.toMatchObject({ code: '23505' });
  const id = await proposal(owner.id, trip.id); await bindProposal(owner.id, trip.id, run.id, id, 'gate', 'proposal-call');
  await database().query('DELETE FROM trips WHERE id=$1', [trip.id]);
  expect((await database().query('SELECT * FROM agent_runs')).rowCount).toBe(0);
  expect((await database().query('SELECT * FROM agent_run_events')).rowCount).toBe(0);
}));
