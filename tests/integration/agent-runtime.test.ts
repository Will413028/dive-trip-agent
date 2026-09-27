import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, test } from 'vitest';
import { EventType } from '@ag-ui/core';
import { executeAgent, validateRuntimeConfig, type AgentExecution, type AgentRuntimeConfig, type AgentRuntimeEvent } from '../../src/agent/runtime';
import { withDatabase, testDatabaseUrl } from '../support/database';
import { database } from '../../src/server/db';
import { withAdkSchemaLock } from '../../src/server/adk-schema-lock';
import { makeSnapshot } from '../support/domain-fixtures';
import { acceptedAnswerSchema, ANSWER_EVENT_NAME } from '../../src/domain/answer';
import { ACCEPTED_ANSWER_STATE } from '../../src/agent/answer-session';

async function setup() {
  const schema = (await database().query('SELECT current_schema() AS name')).rows[0].name;
  const config: AgentRuntimeConfig = { databaseUrl: testDatabaseUrl(), schema: `${schema}_adk` };
  const snapshot = makeSnapshot();
  snapshot.entries.find(entry => entry.id === 'transfer')!.id = 'renamed-afternoon-activity';
  const id = randomUUID();
  const input: AgentExecution = { runId: id, sessionId: id, ownerId: randomUUID(), tripId: randomUUID(), baseVersion: 1,
    snapshot, catalog: snapshot.entries.map(entry => entry.item), input: { kind: 'start', message: '第二天下午留白' } };
  return { config, input };
}
async function run(input: AgentExecution, config: AgentRuntimeConfig) {
  const events: AgentRuntimeEvent[] = [];
  const outcome = await executeAgent(input, { signal: AbortSignal.timeout(20_000),
    onEvent: async event => { events.push(event); } }, config);
  return { events, outcome };
}

test.each(['approved', 'rejected'] as const)('獨立子程序 native confirmation %s 可恢復／重播，產品表不寫入', async decision => withDatabase(async () => {
  const { input, config } = await setup();
  const first = await run(input, config);
  expect(first.outcome.status).toBe('awaiting_confirmation');
  const proposal = first.events.find(event => event.kind === 'proposal');
  if (!proposal || proposal.kind !== 'proposal') throw new Error('MISSING_PROPOSAL');
  expect(proposal.changes).toEqual([{ kind: 'remove', entryId: 'renamed-afternoon-activity' }]);
  expect(proposal.eventId).toBeTruthy();
  const resumed: AgentExecution = { ...input, input: { kind: 'resume', decision,
    interruptId: proposal.interruptId, committedResult: { status: decision === 'approved' ? 'applied' : 'rejected', version: decision === 'approved' ? 2 : 1 } } };
  const firstResume = await run(resumed, config);
  expect(firstResume.outcome).toEqual({ status: 'succeeded' });
  const history = () => database().query(`SELECT id,event_data FROM "${config.schema}".events
    WHERE session_id=$1 AND user_id=$2 ORDER BY timestamp,id`, [input.sessionId, input.ownerId]).then(result => result.rows);
  const beforeReplay = await history();
  const replay = await run(resumed, config);
  expect(replay.outcome).toEqual({ status: 'succeeded' });
  expect(replay.events).toEqual(firstResume.events);
  expect(await history()).toEqual(beforeReplay);
  const toolResult = firstResume.events.find(event => event.kind === 'event' && event.event.type === EventType.TOOL_CALL_RESULT);
  expect(toolResult).toBeTruthy();
  expect(replay.events.find(event => event.kind === 'event' && event.event.type === EventType.TOOL_CALL_RESULT)).toEqual(toolResult);
  if (toolResult?.kind === 'event') expect(toolResult.event.content).toBe('{}');
  const answer = firstResume.events.find(event => event.kind === 'event' && event.event.type === EventType.CUSTOM);
  expect(answer?.kind === 'event' && acceptedAnswerSchema.parse(answer.event.value).body).toEqual({ kind: 'receipt',
    status: decision === 'approved' ? 'applied' : 'rejected', version: decision === 'approved' ? 2 : 1 });
  const receipts = (await database().query(`SELECT id,event_data FROM "${config.schema}".events
    WHERE session_id=$1 AND user_id=$2
      AND event_data #>> '{content,parts,0,function_response,id}'=$3
      AND event_data #>> '{content,parts,0,function_response,response,status}'=$4`,
  [input.sessionId, input.ownerId, proposal.toolCallId, decision === 'approved' ? 'applied' : 'rejected'])).rows;
  expect(receipts).toHaveLength(1);
  const native = receipts[0];
  expect(native.event_data.actions.skip_summarization).toBe(true);
  expect(native.event_data.content.parts).toHaveLength(1);
  expect(native.event_data.content.parts[0].function_response.name).toBe('propose_changes');
  expect(native.event_data.actions.state_delta[ACCEPTED_ANSWER_STATE]).toEqual(answer?.kind === 'event' && answer.event.value);
  expect(toolResult).toMatchObject({ kind: 'event', event: { messageId: `${native.id}:0:result` } });
  await expect(run({ ...resumed, input: { kind: 'resume', decision: decision === 'approved' ? 'rejected' : 'approved',
    interruptId: proposal.interruptId, committedResult: { status: decision === 'approved' ? 'rejected' : 'applied', version: 2 } } }, config)).rejects.toThrow();
  expect((await database().query('SELECT * FROM trips')).rowCount).toBe(0);
  expect((await database().query('SELECT * FROM proposals')).rowCount).toBe(0);
  const tables = await database().query('SELECT table_name FROM information_schema.tables WHERE table_schema=$1', [config.schema]);
  expect(tables.rows.map(row => row.table_name)).toEqual(expect.arrayContaining(['sessions', 'events', 'app_states', 'user_states']));
  const productColumns = await database().query("SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='sessions'");
  expect(productColumns.rows.map(row => row.column_name)).toContain('token_hash');
  expect(productColumns.rows.map(row => row.column_name)).not.toContain('app_name');
}), 30_000);

test('未知訊息明示固定DEMO範圍；不產生提案', () => withDatabase(async () => {
  const { input, config } = await setup(); input.input = { kind: 'start', message: '幫我訂機票' };
  const result = await run(input, config);
  expect(result.outcome).toEqual({ status: 'succeeded' });
  expect(result.events.some(event => event.kind === 'proposal')).toBe(false);
  const texts = result.events.filter(event => event.kind === 'event').map(event => JSON.stringify(event.event)).join('');
  expect(texts).toContain('"kind":"unsupported"');
  expect(texts).not.toContain('TEXT_MESSAGE');
  expect(result.events.every(event => event.kind !== 'event' || ![EventType.RUN_STARTED, EventType.RUN_FINISHED].includes(event.event.type as EventType.RUN_STARTED))).toBe(true);
}), 20_000);

test.each(['approved', 'rejected'] as const)('舊changes格式的native confirmation禁止跨程序%s接續，保留歷史不改寫', decision => withDatabase(async () => {
  const { input, config } = await setup();
  const first = await run(input, config);
  const gate = first.events.find(event => event.kind === 'proposal');
  if (!gate || gate.kind !== 'proposal') throw new Error('MISSING_PROPOSAL');
  // Only this newly-created synthetic session: reproduce the old persisted
  // native call shape, not a new model response bypassing GuardedModel.
  let replacements = 0;
  function legacy(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(legacy);
    if (!value || typeof value !== 'object') return value;
    const record = value as Record<string, unknown>;
    if (record.name === 'propose_changes' && record.id === gate!.toolCallId && 'args' in record) {
      replacements++;
      return { ...record, args: { changes: gate!.changes } };
    }
    return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, legacy(item)]));
  }
  const rows = await database().query<{ id: string; event_data: unknown }>(
    `SELECT id,event_data FROM "${config.schema}".events WHERE session_id=$1`, [input.sessionId]);
  for (const row of rows.rows) await database().query(
    `UPDATE "${config.schema}".events SET event_data=$1 WHERE id=$2 AND session_id=$3`,
    [JSON.stringify(legacy(row.event_data)), row.id, input.sessionId]);
  expect(replacements).toBeGreaterThanOrEqual(2);
  await expect(run(input, config)).rejects.toThrow('AGENT_LEGACY_READ_ONLY');
  const resumed: AgentExecution = { ...input, input: { kind: 'resume', decision, interruptId: gate.interruptId,
    committedResult: { status: decision === 'approved' ? 'applied' : 'rejected', version: decision === 'approved' ? 2 : 1 } } };
  await expect(run(resumed, config)).rejects.toThrow('AGENT_LEGACY_READ_ONLY');
}), 30_000);

test('ACK等持久化；取消會等worker退出且不在背景继续', () => withDatabase(async () => {
  const { input, config } = await setup();
  const controller = new AbortController();
  let release!: () => void;
  let reached!: () => void;
  const blocked = new Promise<void>(resolve => { reached = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const events: AgentRuntimeEvent[] = [];
  const pending = executeAgent(input, { signal: controller.signal, onEvent: async event => {
    events.push(event); reached(); await gate;
  } }, config);
  let settled = false;
  const outcome = pending.catch(error => error).finally(() => { settled = true; });
  try {
    await Promise.race([blocked, outcome.then(error => { throw error; })]);
    await delay(100);
    expect(events).toHaveLength(1);
    expect((await database().query('SELECT pid FROM pg_stat_activity WHERE application_name=$1', [`agent-runtime:${input.runId}`])).rowCount).toBeGreaterThan(0);
    controller.abort();
    await delay(100);
    expect(settled).toBe(false); // caller cannot clean up while its write hook remains active
    release();
    expect(await outcome).toMatchObject({ message: 'AGENT_ABORTED' });
    // Query after executeAgent rejects: child exit has already closed both pools.
    const clients = await database().query('SELECT pid FROM pg_stat_activity WHERE application_name=$1', [`agent-runtime:${input.runId}`]);
    expect(clients.rowCount).toBe(0);
    await delay(50); expect(events).toHaveLength(1);
  } finally { controller.abort(); release(); await outcome; }
}), 20_000);

test('確認結果已保存但答案投影失敗，重播保留相同投影與ID', () => withDatabase(async () => {
  const { input, config } = await setup();
  const first = await run(input, config);
  const gate = first.events.find(event => event.kind === 'proposal');
  if (!gate || gate.kind !== 'proposal') throw new Error('MISSING_PROPOSAL');
  const resumed: AgentExecution = { ...input, input: { kind: 'resume', decision: 'approved',
    interruptId: gate.interruptId, committedResult: { status: 'applied', version: 2 } } };
  let failedText: AgentRuntimeEvent | undefined;
  await expect(executeAgent(resumed, { signal: AbortSignal.timeout(20_000), onEvent: async event => {
    if (event.kind === 'event' && event.event.type === EventType.CUSTOM) {
      failedText = event; throw new Error('injected text projection failure');
    }
  } }, config)).rejects.toThrow('AGENT_EVENT_PERSISTENCE_FAILED');
  expect(failedText).toBeTruthy();
  const replay = await run(resumed, config);
  expect(replay.events).toContainEqual(failedText);
  expect(replay.outcome.status).toBe('succeeded');
}), 30_000);

test('proposal持久化ACK失敗後，新子程序重播同interrupt/toolCall/event ID', () => withDatabase(async () => {
  const { input, config } = await setup();
  let proposal: AgentRuntimeEvent | undefined;
  const publicEvents: AgentRuntimeEvent[] = [];
  await expect(executeAgent(input, { signal: AbortSignal.timeout(20_000), onEvent: async event => {
    if (event.kind === 'proposal') { proposal = event; throw new Error('injected persistence failure'); }
    publicEvents.push(event);
  } }, config)).rejects.toThrow('AGENT_EVENT_PERSISTENCE_FAILED');
  expect(publicEvents.some(event => event.kind === 'event' && event.event.type === EventType.CUSTOM)).toBe(false);
  const replay = await run(input, config);
  expect(replay.events.find(event => event.kind === 'proposal')).toEqual(proposal);
  expect(replay.events.findIndex(event => event.kind === 'proposal')).toBeLessThan(
    replay.events.findIndex(event => event.kind === 'event' && event.event.type === EventType.CUSTOM));
  expect(replay.outcome.status).toBe('awaiting_confirmation');
}), 30_000);

test('缺session／未知interrupt拒絕，鎖定項目驗證失敗不產生確認', () => withDatabase(async () => {
  const { input, config } = await setup();
  const resume: AgentExecution = { ...input, input: { kind: 'resume', interruptId: 'unknown', decision: 'approved', committedResult: { status: 'applied', version: 2 } } };
  await expect(run(resume, config)).rejects.toThrow();
  input.snapshot.entries.find(entry => entry.day === 2 && entry.slot === 'afternoon')!.locked = true;
  const first = await run(input, config);
  expect(first.events.find(event => event.kind === 'proposal')).toBeUndefined();
  expect(first.outcome.status).toBe('succeeded');
  const answer = first.events.find(event => event.kind === 'event' && event.event.type === EventType.CUSTOM);
  expect(answer?.kind === 'event' && acceptedAnswerSchema.parse(answer.event.value).body).toMatchObject({ kind: 'conflict',
    budget: { issues: expect.arrayContaining([expect.objectContaining({ code: 'LOCKED_ENTRY' })]) } });
  await expect(run({ ...resume, snapshot: input.snapshot }, config)).rejects.toThrow();
}), 30_000);

test('拒絕非專用DB、危險schema及連線URL覆寫', () => {
  const config = { databaseUrl: 'postgresql://postgres@127.0.0.1:5432/dive_trip_test', schema: 'test_runtime_adk' };
  validateRuntimeConfig(config);
  expect(() => validateRuntimeConfig({ ...config, schema: 'public' })).toThrow();
  expect(() => validateRuntimeConfig({ ...config, schema: 'x_adk;DROP SCHEMA public' })).toThrow();
  expect(() => validateRuntimeConfig({ ...config, databaseUrl: config.databaseUrl.replace('dive_trip_test', 'postgres') })).toThrow();
  expect(() => validateRuntimeConfig({ ...config, databaseUrl: config.databaseUrl.replace('127.0.0.1', 'example.com') })).toThrow();
  expect(() => validateRuntimeConfig({ ...config, databaseUrl: `${config.databaseUrl}?host=example.com` })).toThrow();
});

test.each(['查詢目的地', '試算目前預算'])('有限唯讀工具：%s 真正執行並持久化AG-UI結果', message => withDatabase(async () => {
  const { input, config } = await setup(); input.input = { kind: 'start', message };
  const result = await run(input, config);
  expect(result.outcome.status).toBe('succeeded');
  expect(result.events.some(event => event.kind === 'proposal')).toBe(false);
  const events = result.events.flatMap(event => event.kind === 'event' ? [event.event] : []);
  const started = events.find(event => event.type === EventType.TOOL_CALL_START);
  expect(started?.toolCallName).toBe(message === '查詢目的地' ? 'find_destinations' : 'calculate_budget');
  const output = events.find(event => event.type === EventType.TOOL_CALL_RESULT);
  expect(output?.toolCallId).toBe(started?.toolCallId);
  expect(output?.content).toBe('{}');
  const value = events.find(event => event.type === EventType.CUSTOM && event.name === ANSWER_EVENT_NAME)?.value;
  const answer = acceptedAnswerSchema.parse(value);
  if (message === '查詢目的地') expect(answer.body).toMatchObject({ kind: 'destinations', destinations: expect.arrayContaining([
    expect.objectContaining({ id: 'xiaoliuqiu' })]) });
  else expect(answer.body).toMatchObject({ kind: 'budget', budget: { known: { minor: 430_000, display: 'TWD 4300.00' }, withinBudget: true } });
}), 20_000);

test('有限工具驗證需求修改，人工確認後新程序接續；不是remove限定', () => withDatabase(async () => {
  const { input, config } = await setup(); input.input = { kind: 'start', message: '把行程改為悠閒' };
  const first = await run(input, config);
  const proposal = first.events.find(event => event.kind === 'proposal');
  expect(first.events.some(event => event.kind === 'event' && event.event.type === EventType.TOOL_CALL_RESULT)).toBe(true);
  if (!proposal || proposal.kind !== 'proposal') throw new Error('MISSING_PROPOSAL');
  expect(proposal.changes).toEqual([{ kind: 'requirements', value: { ...input.snapshot.requirements, pace: 'relaxed' } }]);
  const resumed = await run({ ...input, input: { kind: 'resume', interruptId: proposal.interruptId,
    decision: 'approved', committedResult: { status: 'applied', version: 2 } } }, config);
  expect(resumed.outcome.status).toBe('succeeded');
}), 30_000);

test('同ADK schema兩子程序並行初始化，各自session隔離且結束後關閉所有連線', () => withDatabase(async () => {
  const { input, config } = await setup();
  const secondId = randomUUID();
  const second = { ...input, runId: secondId, sessionId: secondId, ownerId: randomUUID() };
  const outcomes = await Promise.all([run(input, config), run(second, config)]);
  expect(outcomes.every(result => result.outcome.status === 'awaiting_confirmation')).toBe(true);
  const interrupts = outcomes.map(result => result.events.find(event => event.kind === 'proposal'));
  expect(interrupts[0]).not.toEqual(interrupts[1]);
  const clients = await database().query('SELECT pid FROM pg_stat_activity WHERE application_name=ANY($1::text[])',
    [[`agent-runtime:${input.runId}`, `agent-runtime:${secondId}`]]);
  expect(clients.rowCount).toBe(0);
}), 30_000);

test('產品search_path不污染ADK；JSON key排序變化不影響resume綁定', () => withDatabase(async () => {
  const { input, config } = await setup();
  const productSchema = config.schema.slice(0, -4);
  const url = new URL(config.databaseUrl); url.searchParams.set('options', `-c search_path=${productSchema}`);
  config.databaseUrl = url.toString();
  const first = await run(input, config);
  const gate = first.events.find(event => event.kind === 'proposal');
  if (!gate || gate.kind !== 'proposal') throw new Error('MISSING_PROPOSAL');
  const snapshot = (await database().query('SELECT $1::jsonb AS snapshot', [JSON.stringify(input.snapshot)])).rows[0].snapshot;
  const catalog = (await database().query('SELECT $1::jsonb AS catalog', [JSON.stringify(input.catalog)])).rows[0].catalog;
  const resumed = await run({ ...input, snapshot, catalog, input: { kind: 'resume', interruptId: gate.interruptId,
    decision: 'approved', committedResult: { status: 'applied', version: 2 } } }, config);
  expect(resumed.outcome).toEqual({ status: 'succeeded' });
  expect((await database().query('SELECT count(*)::int AS count FROM sessions')).rows[0].count).toBe(0);
}), 30_000);

test('跨schema並行初始化與其他測試清理schema不互相破壞', async () => {
  const results = await Promise.allSettled(Array.from({ length: 6 }, (_, index) => withDatabase(async () => {
    const { input, config } = await setup();
    await delay(index * 500);
    input.input = { kind: 'start', message: 'schema isolation fixture' };
    expect((await run(input, config)).outcome).toEqual({ status: 'succeeded' });
  })));
  for (const result of results) if (result.status === 'rejected') throw result.reason;
}, 30_000);

test('ADK初始化與本專案跨schema DDL共用鎖，不撞到清理中的表', () => withDatabase(async () => {
  const { input, config } = await setup();
  input.input = { kind: 'start', message: 'DDL churn fixture' };
  const results = await Promise.allSettled([
    run(input, config),
    (async () => {
      for (let attempt = 0; attempt < 100; attempt++) {
        await database().query(`CREATE TABLE runtime_ddl_churn_${attempt} (id integer PRIMARY KEY)`);
        await delay(20);
        const client = await database().connect();
        try { await withAdkSchemaLock(client, () => client.query(`DROP TABLE runtime_ddl_churn_${attempt}`)); }
        finally { client.release(); }
        await delay(20);
      }
    })(),
  ]);
  for (const result of results) if (result.status === 'rejected') throw result.reason;
}), 30_000);
