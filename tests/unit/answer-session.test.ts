import { randomUUID } from 'node:crypto';
import { BaseLlm, InMemorySessionService, LlmAgent, Runner, createEvent,
  type BaseLlmConnection, type Context, type Event, type LlmRequest, type LlmResponse } from '@google/adk';
import { EventType } from '@ag-ui/core';
import { expect, test, vi } from 'vitest';
import { answerPlanSchema, ANSWER_EVENT_NAME } from '../../src/domain/answer';
import { GuardedModel } from '../../src/agent/model-guard';
import { createReadTools } from '../../src/agent/tools';
import { recordModelAnswer, recordToolEvidence, savedAnswer, sessionEvidence, type AnswerSession } from '../../src/agent/answer-session';
import { parsePublicAgentEvent } from '../../src/agent/public-events';
import { makeSnapshot } from '../support/domain-fixtures';
import { buildProposal } from '../../src/domain/proposal';
import { toolEvidence } from '../../src/agent/answer-evidence';
import { compileAnswer } from '../../src/agent/answer-compiler';

class Script extends BaseLlm {
  count = 0;
  constructor(readonly final: (request: LlmRequest) => Record<string, unknown>) { super({ model: 'offline-answer-session' }); }
  async *generateContentAsync(request: LlmRequest): AsyncGenerator<LlmResponse> {
    this.count++;
    yield { content: { role: 'model', parts: this.count === 1 ? [
      { text: 'UNTRUSTED_INTERMEDIATE_PRICE_330' }, { functionCall: { id: 'budget', name: 'calculate_budget', args: {} } },
    ] : [{ functionCall: { id: 'final', name: 'set_model_response', args: this.final(request) } }] } };
  }
  async connect(): Promise<BaseLlmConnection> { throw new Error('NETWORK_FORBIDDEN'); }
}
async function fixture(final: Script['final']) {
  const snapshot = makeSnapshot();
  const input: AnswerSession = { binding: { ownerId: randomUUID(), tripId: randomUUID(), runId: randomUUID(), baseVersion: 1 },
    snapshot, catalog: snapshot.entries.map(entry => entry.item) };
  const sessions = new InMemorySessionService();
  const identity = { appName: 'answer_test', userId: input.binding.ownerId, sessionId: input.binding.runId };
  await sessions.createSession(identity);
  const source = new Script(final);
  const runner = new Runner({ appName: identity.appName, sessionService: sessions, agent: new LlmAgent({ name: 'answer_test',
    outputSchema: answerPlanSchema, model: new GuardedModel(source), tools: createReadTools(input),
    afterToolCallback: ({ tool, args, context, response }) => recordToolEvidence(input, tool, args, context, response),
    afterModelCallback: ({ context, response }) => { recordModelAnswer(input, context, response); },
  }) });
  const events: Event[] = [];
  for await (const event of runner.runAsync({ userId: identity.userId, sessionId: identity.sessionId,
    newMessage: { role: 'user', parts: [{ text: '合成資料：請試算預算' }] }, runConfig: { maxLlmCalls: 7 } })) events.push(event);
  return { input, source, events, saved: (await sessions.getSession(identity))! };
}
const budgetRef = (request: LlmRequest) => request.contents.flatMap(content => content.parts ?? [])
  .findLast(part => part.functionResponse?.name === 'calculate_budget')?.functionResponse?.response?.answerEvidenceRef;

test('native callbacks bind tool evidence and commit immutable projection with final event', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('NETWORK_FORBIDDEN'));
  try {
    const { events, saved, input, source } = await fixture(request => ({ version: '1', answer: { kind: 'budget', evidenceRef: budgetRef(request) } }));
    expect(events.some(event => event.errorCode)).toBe(false);
    const answer = savedAnswer(saved.events.at(-1)!, input.binding.runId)!;
    expect(answer.body).toMatchObject({ kind: 'budget', budget: { scope: 'current', known: { minor: 430_000, display: 'TWD 4300.00' } } });
    expect(events.map(event => savedAnswer(event, input.binding.runId)).filter(Boolean)).toEqual([answer]);
    expect(JSON.stringify(answer)).not.toContain('UNTRUSTED_INTERMEDIATE');
    const preserved = JSON.parse(JSON.stringify(saved.events.at(-1)));
    input.snapshot.entries[0].item.title = 'CHANGED_CATALOG';
    expect(savedAnswer(preserved, input.binding.runId)).toEqual(answer);
    expect(source.count).toBe(2); expect(fetchSpy).not.toHaveBeenCalled();
    expect(parsePublicAgentEvent({ type: EventType.CUSTOM, name: ANSWER_EVENT_NAME, value: answer }, input.binding.runId)).toBeTruthy();
    expect(() => parsePublicAgentEvent({ type: EventType.CUSTOM, name: ANSWER_EVENT_NAME, value: answer }, randomUUID())).toThrow();
  } finally { fetchSpy.mockRestore(); }
});

test.each(['foreign', 'wrong-kind', 'free-prose'])('invalid final %s never saves accepted projection', async attack => {
  const { saved, events, input } = await fixture(request => attack === 'free-prose'
    ? { version: '1', answer: { kind: 'budget', evidenceRef: budgetRef(request), text: '已保存 TWD330' } }
    : { version: '1', answer: { kind: attack === 'wrong-kind' ? 'receipt' : 'budget',
      evidenceRef: attack === 'foreign' ? `ev_${'0'.repeat(64)}` : budgetRef(request) } });
  expect(events.some(event => event.errorCode)).toBe(true);
  expect(saved.events.map(event => savedAnswer(event, input.binding.runId)).filter(Boolean)).toEqual([]);
});

test('evidence reconstruction rejects reordered/missing call and untrusted response refs', async () => {
  const { saved, input } = await fixture(request => ({ version: '1', answer: { kind: 'budget', evidenceRef: budgetRef(request) } }));
  const history = saved.events.filter(event => event.content?.parts?.some(part => part.functionCall?.name === 'calculate_budget' || part.functionResponse?.name === 'calculate_budget'));
  expect(sessionEvidence(input, history)).toHaveLength(2);
  expect(() => sessionEvidence(input, [...history].reverse())).toThrow('AGENT_ANSWER_EVIDENCE');
  expect(() => sessionEvidence(input, [...history, history.at(-1)!])).toThrow('AGENT_ANSWER_EVIDENCE');
  const altered = structuredClone(history);
  altered.at(-1)!.content!.parts![0].functionResponse!.response!.answerEvidenceRef = `ev_${'0'.repeat(64)}`;
  expect(() => sessionEvidence(input, altered)).toThrow('AGENT_ANSWER_EVIDENCE');
  const user = createEvent({ author: 'user', content: { role: 'user', parts: history.at(-1)!.content!.parts } });
  expect(sessionEvidence(input, [user])).toHaveLength(1);
});

function validationHistory() {
  const snapshot = makeSnapshot();
  const input: AnswerSession = { binding: { ownerId: randomUUID(), tripId: randomUUID(), runId: randomUUID(), baseVersion: 1 },
    snapshot, catalog: snapshot.entries.map(entry => entry.item) };
  const args = { changes: [{ kind: 'remove' as const, entryId: 'transfer' }] };
  const draft = buildProposal(snapshot, args.changes, input.catalog, 'agent');
  const result = { canApply: draft.canApply, validationId: randomUUID(), budget: draft.budget, issues: draft.issues };
  const evidence = toolEvidence(input.binding, snapshot, input.catalog, { id: 'valid', name: 'validate_changes', args, result });
  const call = (id: string) => createEvent({ author: 'agent', content: { role: 'model', parts: [
    { functionCall: { id, name: 'validate_changes', args } },
  ] } });
  const reply = (id: string, response: Record<string, unknown>) => createEvent({ author: 'agent', content: { role: 'user', parts: [
    { functionResponse: { id, name: 'validate_changes', response } },
  ] } });
  const history = [call('valid'), reply('valid', { ...result, answerEvidenceRef: evidence.id })];
  return { input, args, evidence, result, history, call, reply };
}

test.each(['failed', 'unfinished', 'parallel-failed'] as const)('later %s validation invalidates the earlier candidate', mode => {
  const f = validationHistory();
  const later = [f.call('later'), ...(mode === 'unfinished' ? [] : [f.reply('later', { error: 'TOOL_OUTPUT_TOO_LARGE' })])];
  const events = mode === 'parallel-failed' ? [f.history[0], later[0], f.history[1], later[1]] : [...f.history, ...later];
  const evidence = sessionEvidence(f.input, events);
  expect(evidence.some(item => item.kind === 'validation')).toBe(false);
  expect(() => compileAnswer({ version: '1', answer: { kind: 'budget', evidenceRef: f.evidence.id } }, {
    binding: f.input.binding, eventId: 'final', evidence,
  })).toThrow('AGENT_ANSWER_EVIDENCE');
});

test.each(['__proto__', 'constructor', 'toString'])('inherited confirmation key %s is not a native gate', id => {
  const f = validationHistory();
  const set = vi.fn();
  const context = { functionCallId: id, actions: { requestedToolConfirmations: {} }, state: { set },
    invocationContext: { session: { events: f.history } } } as unknown as Context;
  expect(() => recordToolEvidence(f.input, { name: 'propose_changes' }, { validationId: f.result.validationId }, context, {}))
    .toThrow('AGENT_ANSWER_EVIDENCE');
  expect(set).not.toHaveBeenCalled();
});

test.each([
  { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'x', delta: 'PRIVATE' },
  { type: EventType.TOOL_CALL_ARGS, toolCallId: 'x', delta: 'PRIVATE' },
  { type: EventType.TOOL_CALL_RESULT, messageId: 'x', toolCallId: 'x', role: 'tool', content: '{"price":330}' },
  { type: EventType.TOOL_CALL_START, toolCallId: 'x', toolCallName: 'send_email' },
  { type: EventType.CUSTOM, name: 'dive_trip.answer.v99', value: { text: 'PRIVATE' } },
])('public boundary rejects raw and unknown event %#', event => {
  expect(() => parsePublicAgentEvent(event, randomUUID())).toThrow();
});
