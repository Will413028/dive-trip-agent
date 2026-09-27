import { randomUUID } from 'node:crypto';
import { EventType } from '@ag-ui/core';
import { expect, test } from 'vitest';
import { compileAnswer } from '../../src/agent/answer-compiler';
import { ANSWER_EVENT_NAME } from '../../src/domain/answer';
import { parseStoredRunEvent, runErrorEvent } from '../../src/server/answer-events';

function answerEvent() {
  const runId = randomUUID();
  const value = compileAnswer({ version: '1', answer: { kind: 'clarify', fields: ['dates'] } }, {
    binding: { ownerId: randomUUID(), tripId: randomUUID(), runId, baseVersion: 1 }, eventId: 'final', evidence: [],
  });
  return { type: EventType.CUSTOM, name: ANSWER_EVENT_NAME, value };
}

test('P3 revalidates the accepted JSON projection and keeps a detached copy', () => {
  const raw = answerEvent();
  const saved = parseStoredRunEvent(raw, raw.value.runId);
  expect(saved).toEqual(raw);
  raw.value.body = { kind: 'unsupported', reason: 'booking' };
  expect(saved).not.toEqual(raw);
});

test('P3 rejects cross-run, unknown template/schema and untyped/private output', () => {
  const event = answerEvent();
  const runId = event.value.runId;
  for (const raw of [
    { ...event, value: { ...event.value, runId: randomUUID() } },
    { ...event, value: { ...event.value, templateVersion: 2 } },
    { ...event, value: { ...event.value, schemaVersion: 0 } },
    { ...event, value: { ...event.value, privateEvidence: 'private' } },
    { ...event, value: { ...event.value, body: { kind: 'clarify', fields: ['dates'], text: 'raw' } } },
    { ...event, name: 'private-accounting' }, { ...event, rawEvent: { private: true } },
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'm', delta: 'raw' },
    { type: EventType.TOOL_CALL_ARGS, toolCallId: 'tool', delta: '{}' },
    { type: EventType.STATE_SNAPSHOT, snapshot: {} },
    { type: EventType.TOOL_CALL_START, toolCallId: 'tool', toolCallName: 'raw title' },
    { type: EventType.TOOL_CALL_RESULT, messageId: 'm', toolCallId: 'tool', role: 'tool', content: '{"status":"applied"}' },
    { type: EventType.TOOL_CALL_END, toolCallId: 'tool', private: 'raw' },
  ]) expect(() => parseStoredRunEvent(raw, runId)).toThrow('INVALID_RUN_EVENT');
});

test('P3 accepts only fixed public tool progress and server lifecycle metadata', () => {
  const runId = randomUUID();
  for (const raw of [
    { type: EventType.TOOL_CALL_START, toolCallId: 'tool', toolCallName: 'calculate_budget' },
    { type: EventType.TOOL_CALL_END, toolCallId: 'tool' },
    { type: EventType.TOOL_CALL_RESULT, messageId: 'm:result', toolCallId: 'tool', role: 'tool', content: '{}' },
    { type: EventType.RUN_STARTED, threadId: randomUUID(), runId: randomUUID() },
    { type: EventType.RUN_FINISHED, threadId: randomUUID(), runId: randomUUID(), outcome: { type: 'success' } },
  ]) expect(parseStoredRunEvent(raw, runId)).toEqual(raw);
  expect(() => parseStoredRunEvent({ type: EventType.RUN_FINISHED, threadId: randomUUID(), runId,
    result: { raw: 'private' } }, runId)).toThrow('INVALID_RUN_EVENT');
});

test('P3 never persists Error.message, arbitrary codes or interrupt prose', () => {
  const runId = randomUUID();
  for (const code of [undefined, 'AGENT_TIMEOUT', 'untrusted-provider-payload']) {
    const result = parseStoredRunEvent({ type: EventType.RUN_ERROR, message: 'raw-private-error', ...(code ? { code } : {}) }, runId);
    expect(result).toEqual(runErrorEvent(code));
    expect(JSON.stringify(result)).not.toMatch(/raw-private-error|untrusted-provider-payload/);
  }
  expect(() => parseStoredRunEvent({ type: EventType.RUN_FINISHED, threadId: randomUUID(), runId,
    outcome: { type: 'interrupt', interrupts: [{ id: 'gate', reason: 'approval', message: 'raw-private-error' }] } }, runId))
    .toThrow('INVALID_RUN_EVENT');
});
