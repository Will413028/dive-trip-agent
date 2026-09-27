import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { EventType } from '@ag-ui/core';
import { ACCEPTED_ANSWER_STATE } from '../../src/agent/answer-session';
import { acceptedAnswerSchema, ANSWER_EVENT_NAME } from '../../src/domain/answer';
import { executeAgent, type AgentExecution, type AgentRuntimeConfig, type AgentRuntimeEvent } from '../../src/agent/runtime';
import { withDatabase, testDatabaseUrl } from '../support/database';
import { database } from '../../src/server/db';
import { makeSnapshot } from '../support/domain-fixtures';

async function setup(message = '查詢目的地') {
  const schema = (await database().query('SELECT current_schema() AS name')).rows[0].name;
  const config: AgentRuntimeConfig = { databaseUrl: testDatabaseUrl(), schema: `${schema}_adk` };
  const snapshot = makeSnapshot();
  const id = randomUUID();
  const input: AgentExecution = { runId: id, sessionId: id, ownerId: randomUUID(), tripId: randomUUID(), baseVersion: 1,
    snapshot, catalog: snapshot.entries.map(entry => entry.item), input: { kind: 'start', message } };
  return { input, config };
}
async function history(config: AgentRuntimeConfig, input: AgentExecution) {
  return (await database().query(`SELECT id,event_data FROM "${config.schema}".events
    WHERE session_id=$1 AND user_id=$2 ORDER BY timestamp,id`, [input.sessionId, input.ownerId])).rows;
}
async function run(input: AgentExecution, config: AgentRuntimeConfig, onEvent?: (event: AgentRuntimeEvent) => Promise<void>) {
  const events: AgentRuntimeEvent[] = [];
  const outcome = await executeAgent(input, { signal: AbortSignal.timeout(20_000), onEvent: async event => {
    events.push(event); await onEvent?.(event);
  } }, config);
  return { events, outcome };
}
async function failProjection(input: AgentExecution, config: AgentRuntimeConfig, match: (event: AgentRuntimeEvent) => boolean) {
  let failed: AgentRuntimeEvent | undefined;
  await expect(run(input, config, async event => {
    if (match(event)) { failed = event; throw new Error('injected recovery projection failure'); }
  })).rejects.toThrow('AGENT_EVENT_PERSISTENCE_FAILED');
  expect(failed).toBeDefined();
  return failed!;
}
async function storedReceipt(config: AgentRuntimeConfig, input: AgentExecution) {
  const rows = (await database().query(`SELECT id,event_data FROM "${config.schema}".events
    WHERE session_id=$1 AND user_id=$2
      AND event_data #>> '{content,parts,0,function_response,name}'='propose_changes'
      AND event_data #>> '{content,parts,0,function_response,response,status}' IN ('applied','rejected')`,
  [input.sessionId, input.ownerId])).rows;
  expect(rows).toHaveLength(1);
  const row = rows[0];
  expect(row.event_data.actions.skip_summarization).toBe(true);
  expect(row.event_data.content.parts).toHaveLength(1);
  const answer = acceptedAnswerSchema.parse(row.event_data.actions.state_delta[ACCEPTED_ANSWER_STATE]);
  expect(answer.runId).toBe(input.runId);
  const result = row.event_data.content.parts[0].function_response.response;
  expect(answer.body).toEqual({ kind: 'receipt', status: result.status, version: result.version });
  expect(answer.evidenceRefs).toEqual([result.answerEvidenceRef]);
  return { ...row, answer };
}

test.each(['tool progress', 'read tool result'] as const)('%s已保存但模型未完成，重播拒絕且不新增ADK事件', phase => withDatabase(async () => {
  const { input, config } = await setup();
  await failProjection(input, config, event => event.kind === 'event' && (phase === 'tool progress'
    ? event.event.type === EventType.TOOL_CALL_START
    : event.event.type === EventType.TOOL_CALL_RESULT));
  const before = await history(config, input);
  expect(JSON.stringify(before)).toContain('function_call');
  const projected: AgentRuntimeEvent[] = [];
  await expect(run(input, config, async event => { projected.push(event); })).rejects.toThrow('AGENT_RUN_INTERRUPTED');
  expect(projected).toEqual([]);
  expect(await history(config, input)).toEqual(before);
}), 30_000);

test('read tool後真正terminal已保存才可重播，訊息ID穩定且不重跑工具／模型', () => withDatabase(async () => {
  const { input, config } = await setup();
  const failed = await failProjection(input, config, event => event.kind === 'event'
    && event.event.type === EventType.CUSTOM);
  const before = await history(config, input);
  const replay = await run(input, config);
  expect(replay.outcome).toEqual({ status: 'succeeded' });
  expect(replay.events).toContainEqual(failed);
  expect(replay.events.some(event => event.kind === 'proposal'
    || event.event.type === EventType.TOOL_CALL_START)).toBe(false);
  expect(await history(config, input)).toEqual(before);
}), 30_000);

async function confirmation(decision: 'approved' | 'rejected') {
  const { input, config } = await setup('第二天下午留白');
  const first = await run(input, config);
  const gate = first.events.find(event => event.kind === 'proposal');
  if (!gate || gate.kind !== 'proposal') throw new Error('MISSING_CONFIRMATION');
  const resume: AgentExecution = { ...input, input: { kind: 'resume', interruptId: gate.interruptId, decision,
    committedResult: { status: decision === 'approved' ? 'applied' : 'rejected', version: decision === 'approved' ? 2 : 1 } } };
  return { input, resume, config };
}

test.each(['approved', 'rejected'] as const)('%s tool result ACK遺失，同event已有不可變receipt才允許resume/start重播', decision => withDatabase(async () => {
  const { input, resume, config } = await confirmation(decision);
  const failed = await failProjection(resume, config, event => event.kind === 'event' && event.event.type === EventType.TOOL_CALL_RESULT);
  const before = await history(config, input);
  const receipt = await storedReceipt(config, input);
  expect(receipt.answer.body).toEqual({ kind: 'receipt', status: decision === 'approved' ? 'applied' : 'rejected',
    version: decision === 'approved' ? 2 : 1 });
  expect(failed).toMatchObject({ kind: 'event', event: { messageId: `${receipt.id}:0:result` } });
  const expected = [failed, { kind: 'event', event: { type: EventType.CUSTOM, name: ANSWER_EVENT_NAME, value: receipt.answer } }];
  for (const replayInput of [resume, input]) {
    const replay = await run(replayInput, config);
    expect(replay.outcome).toEqual({ status: 'succeeded' });
    expect(replay.events).toEqual(expected);
    expect(await history(config, input)).toEqual(before);
  }
}), 30_000);

test.each(['approved', 'rejected'] as const)('%s tool result缺少receipt stateDelta，session state有答案仍拒絕resume/start重播', decision => withDatabase(async () => {
  const { input, resume, config } = await confirmation(decision);
  await failProjection(resume, config, event => event.kind === 'event' && event.event.type === EventType.TOOL_CALL_RESULT);
  const receipt = await storedReceipt(config, input);
  const sessionState = (await database().query(`SELECT state FROM "${config.schema}".sessions
    WHERE id=$1 AND user_id=$2`, [input.sessionId, input.ownerId])).rows[0].state;
  expect(sessionState[ACCEPTED_ANSWER_STATE]).toEqual(receipt.answer);
  // Only the new synthetic session's receipt event is tampered. Keep its tool
  // result, skipSummarization and session-level answer to rule out fallbacks.
  const changed = await database().query(`UPDATE "${config.schema}".events
    SET event_data=event_data #- '{actions,state_delta}' WHERE id=$1 AND session_id=$2 AND user_id=$3`,
  [receipt.id, input.sessionId, input.ownerId]);
  expect(changed.rowCount).toBe(1);
  const before = await history(config, input);
  const tampered = before.find(row => row.id === receipt.id)!.event_data;
  expect(tampered.actions.state_delta).toBeUndefined();
  expect(tampered.content).toEqual(receipt.event_data.content);
  expect(tampered.actions.skip_summarization).toBe(true);
  const projected: AgentRuntimeEvent[] = [];
  await expect(run(resume, config, async event => { projected.push(event); })).rejects.toThrow('AGENT_RESUME_INCOMPLETE');
  await expect(run(input, config, async event => { projected.push(event); })).rejects.toThrow('AGENT_RUN_INTERRUPTED');
  expect(projected).toEqual([]);
  expect(await history(config, input)).toEqual(before);
}), 30_000);

test.each(['approved', 'rejected'] as const)('%s receipt答案ACK遺失，重播同event已接受projection，不新增ADK事件', decision => withDatabase(async () => {
  const { input, resume, config } = await confirmation(decision);
  const failed = await failProjection(resume, config, event => event.kind === 'event'
    && event.event.type === EventType.CUSTOM);
  const before = await history(config, input);
  const receipt = await storedReceipt(config, input);
  expect(failed).toEqual({ kind: 'event', event: { type: EventType.CUSTOM, name: ANSWER_EVENT_NAME, value: receipt.answer } });
  const replay = await run(resume, config);
  expect(replay.outcome).toEqual({ status: 'succeeded' });
  expect(replay.events).toContainEqual(failed);
  expect(replay.events.some(event => event.kind === 'event' && event.event.type === EventType.TOOL_CALL_RESULT)).toBe(true);
  expect(await history(config, input)).toEqual(before);
}), 30_000);
