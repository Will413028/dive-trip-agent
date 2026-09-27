import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { EventType } from '@ag-ui/core';
import { acceptedAnswerSchema, ANSWER_EVENT_NAME, type AcceptedAnswer } from '../../src/domain/answer';
import { evidenceIdentity } from '../../src/agent/answer-evidence';
import { executeAgent, type AgentAccountingEvent, type AgentExecution, type AgentRuntimeConfig, type AgentRuntimeEvent } from '../../src/agent/runtime';
import { withDatabase, testDatabaseUrl } from '../support/database';
import { database } from '../../src/server/db';
import { makeSnapshot } from '../support/domain-fixtures';

const syntheticKey = 'offline-placeholder-not-a-credential';
const model = 'example/synthetic:free';
async function setup(message = '請協助規劃行程') {
  const schema = (await database().query('SELECT current_schema() AS name')).rows[0].name;
  const config: AgentRuntimeConfig = { databaseUrl: testDatabaseUrl(), schema: `${schema}_adk`, offlineScenario: 'proposal',
    generation: { apiKey: syntheticKey },
    provider: { kind: 'openrouter', model, deadlineMs: Date.now() + 30_000, previousModelCalls: 0 } };
  const snapshot = makeSnapshot(); const runId = randomUUID();
  const input: AgentExecution = { runId, sessionId: runId, ownerId: randomUUID(), tripId: randomUUID(), baseVersion: 1,
    snapshot, catalog: snapshot.entries.map(entry => entry.item), input: { kind: 'start', message } };
  return { config, input };
}
async function run(input: AgentExecution, config: AgentRuntimeConfig) {
  const events: AgentRuntimeEvent[] = []; const accounting: AgentAccountingEvent[] = [];
  const outcome = await executeAgent(input, { signal: AbortSignal.timeout(25_000), onEvent: async event => { events.push(event); },
    onAccounting: async event => { accounting.push(event); } }, config);
  return { outcome, events, accounting };
}
function publicAnswers(events: AgentRuntimeEvent[], input: AgentExecution): AcceptedAnswer[] {
  const answers: AcceptedAnswer[] = [];
  const publicEvents = events.flatMap(event => event.kind === 'event' ? [event.event] : []);
  for (const event of publicEvents) {
    expect([EventType.CUSTOM, EventType.TOOL_CALL_START, EventType.TOOL_CALL_END, EventType.TOOL_CALL_RESULT]).toContain(event.type);
    if (event.type === EventType.TOOL_CALL_RESULT) expect(event.content).toBe('{}');
    if (event.type === EventType.CUSTOM) {
      expect(event.name).toBe(ANSWER_EVENT_NAME);
      const answer = acceptedAnswerSchema.parse(event.value);
      expect(answer.runId).toBe(input.runId);
      answers.push(answer);
    }
  }
  const serialized = JSON.stringify(publicEvents);
  expect(serialized).not.toMatch(/ownerId|tripId|untrustedTripData|answerEvidenceRef|validationId|set_model_response|promptTokens|providerEvidence|generationId|reportedCostMicros|returnedModel|model-call-usage/);
  for (const privateValue of [syntheticKey, input.ownerId, input.tripId]) expect(serialized).not.toContain(privateValue);
  return answers;
}
function reference(input: AgentExecution, kind: 'proposal' | 'receipt', callId: string) {
  const { ownerId, tripId, runId, baseVersion } = input;
  return evidenceIdentity({ ownerId, tripId, runId, baseVersion }, kind, callId);
}

test.each(['approved', 'rejected'] as const)('OpenRouter structured proposal/receipt %s keeps zero-cost evidence private and replays exactly', decision => withDatabase(async () => {
  const { input, config } = await setup('查詢並提出修改');
  const first = await run(input, config);
  expect(first.outcome.status).toBe('awaiting_confirmation');
  expect(first.events.some(event => event.kind === 'event' && event.event.type === EventType.TOOL_CALL_RESULT)).toBe(true);
  const proposal = first.events.find(event => event.kind === 'proposal');
  if (!proposal || proposal.kind !== 'proposal') throw new Error('MISSING_PROPOSAL');
  const pending = publicAnswers(first.events, input);
  expect(pending).toHaveLength(1);
  const proposalRef = reference(input, 'proposal', proposal.toolCallId);
  expect(pending[0]).toMatchObject({ evidenceRefs: [proposalRef], body: { kind: 'proposal', proposalRef, changeCount: 1,
    budget: { scope: 'candidate', baseVersion: 1, known: { minor: 430000, display: 'TWD 4300.00' }, containsDemo: true } } });
  expect(first.accounting.filter(event => event.kind === 'model-call-usage')).toHaveLength(2);
  expect(first.accounting.filter(event => event.kind === 'model-call-start')).toHaveLength(2);
  for (const event of first.accounting) if (event.kind === 'model-call-usage') {
    expect(event.providerEvidence).toMatchObject({ provider: 'openrouter', generationId: expect.any(String),
      returnedModel: 'example/synthetic', reportedCostMicros: 0 });
  }
  expect(JSON.stringify(first.events)).not.toContain(syntheticKey);
  const receipt = { status: decision === 'approved' ? 'applied' as const : 'rejected' as const,
    version: decision === 'approved' ? 2 : 1 };
  const resume: AgentExecution = { ...input, input: { kind: 'resume', interruptId: proposal.interruptId, decision, committedResult: receipt } };
  const receiptConfig: AgentRuntimeConfig = { databaseUrl: config.databaseUrl, schema: config.schema,
    provider: { ...config.provider!, deadlineMs: Date.now() + 30_000,
      previousModelCalls: first.accounting.filter(e => e.kind === 'model-call-start').length } };
  expect(receiptConfig).not.toHaveProperty('generation');
  expect(receiptConfig).not.toHaveProperty('offlineScenario');
  const resumed = await run(resume, receiptConfig);
  expect(resumed.outcome).toEqual({ status: 'succeeded' });
  expect(resumed.accounting).toEqual([]);
  const answers = publicAnswers(resumed.events, input);
  expect(answers).toHaveLength(1);
  expect(answers[0].evidenceRefs).toEqual([reference(input, 'receipt', proposal.toolCallId)]);
  expect(answers[0].body).toEqual({ kind: 'receipt', ...receipt });
  expect(resumed.events.some(event => event.kind === 'proposal')).toBe(false);
  const replay = await run(resume, { ...receiptConfig, provider: { ...receiptConfig.provider!, previousModelCalls: 2,
    deadlineMs: Date.now() + 30_000 } });
  expect(replay.outcome).toEqual({ status: 'succeeded' });
  expect(replay.accounting).toEqual([]);
  expect(publicAnswers(replay.events, input)).toEqual(answers);
  const state = await database().query(`SELECT to_jsonb(t) AS data FROM "${config.schema}"."sessions" t`);
  expect(JSON.stringify(state.rows)).toContain('openrouter');
  expect(JSON.stringify({ state: state.rows, accounting: [...first.accounting, ...resumed.accounting] })).not.toContain(syntheticKey);
}), 30_000);
