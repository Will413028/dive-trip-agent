import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { EventType } from '@ag-ui/core';
import { acceptedAnswerSchema, ANSWER_EVENT_NAME, type AcceptedAnswer } from '../../src/domain/answer';
import { evidenceIdentity } from '../../src/agent/answer-evidence';
import { executeAgent, validateRuntimeConfig, type AgentAccountingEvent, type AgentExecution,
  type AgentRuntimeConfig, type AgentRuntimeEvent, type OfflineScenario } from '../../src/agent/runtime';
import { CLOUDFLARE_MODEL } from '../../src/agent/cloudflare-wire';
import { withDatabase, testDatabaseUrl } from '../support/database';
import { database } from '../../src/server/db';
import { makeSnapshot } from '../support/domain-fixtures';

const syntheticKey = 'offline-placeholder-not-a-credential';
const accountId = 'a'.repeat(32);
function config(schema = 'test_adk', offlineScenario: OfflineScenario = 'proposal'): AgentRuntimeConfig {
  return { databaseUrl: 'postgresql://postgres@127.0.0.1:1/dive_trip_test', schema, offlineScenario,
    generation: { apiKey: syntheticKey },
    provider: { kind: 'cloudflare', model: CLOUDFLARE_MODEL, accountId,
      deadlineMs: Date.now() + 30_000, previousModelCalls: 0 } };
}
async function setup(scenario: OfflineScenario = 'proposal') {
  const schema = (await database().query('SELECT current_schema() AS name')).rows[0].name;
  const snapshot = makeSnapshot(); const runId = randomUUID();
  const input: AgentExecution = { runId, sessionId: runId, ownerId: randomUUID(), tripId: randomUUID(), baseVersion: 1,
    snapshot, catalog: snapshot.entries.map(entry => entry.item), input: { kind: 'start', message: '請協助規劃行程' } };
  return { input, runtime: { ...config(`${schema}_adk`, scenario), databaseUrl: testDatabaseUrl() } };
}
async function run(input: AgentExecution, runtime: AgentRuntimeConfig) {
  const events: AgentRuntimeEvent[] = [], accounting: AgentAccountingEvent[] = [];
  const outcome = await executeAgent(input, { signal: AbortSignal.timeout(25_000),
    onEvent: async event => { events.push(event); }, onAccounting: async event => { accounting.push(event); } }, runtime);
  return { outcome, events, accounting };
}
function next(runtime: AgentRuntimeConfig, previousModelCalls: number): AgentRuntimeConfig {
  return { ...runtime, provider: { ...runtime.provider!, previousModelCalls, deadlineMs: Date.now() + 30_000 } };
}
function receiptConfig(runtime: AgentRuntimeConfig, previousModelCalls: number): AgentRuntimeConfig {
  return { databaseUrl: runtime.databaseUrl, schema: runtime.schema,
    provider: { ...runtime.provider!, previousModelCalls, deadlineMs: Date.now() + 30_000 } };
}
function calls(events: AgentAccountingEvent[]) { return events.filter(event => event.kind === 'model-call-start').length; }
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
  expect(serialized).not.toMatch(/ownerId|tripId|untrustedTripData|answerEvidenceRef|validationId|set_model_response|promptTokens|priceBasis|returnedModel|model-call-usage|providerEvidence|private_value_marker|private_key_marker/);
  for (const privateValue of [syntheticKey, accountId, input.ownerId, input.tripId]) expect(serialized).not.toContain(privateValue);
  return answers;
}
function reference(input: AgentExecution, kind: 'proposal' | 'receipt', callId: string) {
  const { ownerId, tripId, runId, baseVersion } = input;
  return evidenceIdentity({ ownerId, tripId, runId, baseVersion }, kind, callId);
}

test('Cloudflare runtime validates account/model and requires private accounting before forking', async () => {
  const runtime = config();
  expect(() => validateRuntimeConfig(runtime)).not.toThrow();
  for (const invalid of ['', 'A'.repeat(32), 'a'.repeat(31), '../account']) {
    expect(() => validateRuntimeConfig({ ...runtime, provider: { ...runtime.provider!, kind: 'cloudflare', accountId: invalid,
      model: CLOUDFLARE_MODEL } })).toThrow('AGENT_PROVIDER_CONFIG');
  }
  for (const model of [`${CLOUDFLARE_MODEL}-external`, '@cf/other/model']) {
    expect(() => validateRuntimeConfig({ ...runtime, provider: { ...runtime.provider!, model } })).toThrow('AGENT_PROVIDER_CONFIG');
  }
  expect(() => validateRuntimeConfig({ ...runtime, offlineScenario: undefined })).toThrow('AGENT_OFFLINE_CONFIG');
  const snapshot = makeSnapshot(); const runId = randomUUID();
  const input: AgentExecution = { runId, sessionId: runId, ownerId: randomUUID(), tripId: randomUUID(), baseVersion: 1,
    snapshot, catalog: snapshot.entries.map(entry => entry.item), input: { kind: 'start', message: '請協助規劃行程' } };
  await expect(executeAgent(input, { signal: AbortSignal.timeout(1000), onEvent: async () => {} }, runtime))
    .rejects.toThrow('AGENT_ACCOUNTING_REQUIRED');
});

test('Cloudflare structured clarify keeps accounting private and replays the accepted answer without a model call', () => withDatabase(async () => {
  const { input, runtime } = await setup('clarify');
  const first = await run(input, runtime);
  expect(first.outcome).toEqual({ status: 'succeeded' });
  expect(first.accounting.map(event => event.kind)).toEqual(['model-call-start', 'model-call-usage']);
  const answers = publicAnswers(first.events, input);
  expect(answers).toHaveLength(1);
  expect(answers[0]).toMatchObject({ schemaVersion: 1, templateVersion: 1, evidenceRefs: [],
    body: { kind: 'clarify', fields: ['people', 'divers'] } });
  expect(JSON.stringify(first.events)).not.toMatch(/promptTokens|priceBasis|returnedModel|offline-placeholder/);
  const replay = await run(input, next(runtime, 1));
  expect(replay.outcome).toEqual({ status: 'succeeded' });
  expect(replay.accounting).toEqual([]);
  expect(publicAnswers(replay.events, input)).toEqual(answers);
}), 30_000);

test.each(['approved', 'rejected'] as const)('Cloudflare proposal resumes %s in another worker and replays without calls', decision => withDatabase(async () => {
  const { input, runtime } = await setup();
  const first = await run(input, runtime);
  expect(first.outcome.status).toBe('awaiting_confirmation');
  expect(first.events.some(event => event.kind === 'event' && event.event.type === EventType.TOOL_CALL_RESULT)).toBe(true);
  const proposal = first.events.find(event => event.kind === 'proposal');
  if (!proposal || proposal.kind !== 'proposal') throw new Error('MISSING_PROPOSAL');
  const pending = publicAnswers(first.events, input);
  expect(pending).toHaveLength(1);
  const proposalRef = reference(input, 'proposal', proposal.toolCallId);
  expect(pending[0]).toMatchObject({ evidenceRefs: [proposalRef], body: { kind: 'proposal', proposalRef, changeCount: 1,
    budget: { scope: 'candidate', baseVersion: 1, known: { minor: 430000, display: 'TWD 4300.00' }, containsDemo: true } } });
  const usages = first.accounting.filter(event => event.kind === 'model-call-usage');
  expect(usages).toHaveLength(2);
  expect(calls(first.accounting)).toBe(2);
  for (const event of usages) {
    expect(event.usage).toEqual({ promptTokens: 20, outputTokens: 8, totalTokens: 28 });
    expect(event.providerEvidence).toEqual({ provider: 'cloudflare', returnedModel: `${CLOUDFLARE_MODEL}-external`,
      priceBasis: 'cloudflare-gemma4-26b-2026-09-26' });
  }
  expect(JSON.stringify(first.events)).not.toMatch(/promptTokens|priceBasis|model-call-usage|offline-placeholder/);
  const resume: AgentExecution = { ...input, input: { kind: 'resume', interruptId: proposal.interruptId, decision,
    committedResult: { status: decision === 'approved' ? 'applied' : 'rejected', version: decision === 'approved' ? 2 : 1 } } };
  const selected = receiptConfig(runtime, calls(first.accounting));
  expect(selected).not.toHaveProperty('generation');
  expect(selected).not.toHaveProperty('offlineScenario');
  const resumed = await run(resume, selected);
  expect(resumed.outcome).toEqual({ status: 'succeeded' });
  expect(resumed.accounting).toEqual([]);
  expect(calls(first.accounting) + calls(resumed.accounting)).toBe(2);
  expect(resumed.events.some(event => event.kind === 'proposal')).toBe(false);
  const answers = publicAnswers(resumed.events, input);
  expect(answers).toHaveLength(1);
  expect(answers[0].evidenceRefs).toEqual([reference(input, 'receipt', proposal.toolCallId)]);
  expect(answers[0].body).toEqual({ kind: 'receipt', status: decision === 'approved' ? 'applied' : 'rejected',
    version: decision === 'approved' ? 2 : 1 });
  const replay = await run(resume, receiptConfig(runtime, 2));
  expect(replay.outcome).toEqual({ status: 'succeeded' });
  expect(replay.accounting).toEqual([]);
  expect(publicAnswers(replay.events, input)).toEqual(answers);
  const state = await database().query(`SELECT to_jsonb(t) AS data FROM "${runtime.schema}"."sessions" t`);
  expect(JSON.stringify(state.rows)).toContain('cloudflare');
  expect(JSON.stringify(state.rows)).not.toContain(syntheticKey);
}), 45_000);

test('Cloudflare worker rejects account changes before resume or replay emits events or accounting', () => withDatabase(async () => {
  const { input, runtime } = await setup();
  const first = await run(input, runtime);
  const proposal = first.events.find(event => event.kind === 'proposal');
  if (!proposal || proposal.kind !== 'proposal') throw new Error('MISSING_PROPOSAL');
  const resume: AgentExecution = { ...input, input: { kind: 'resume', interruptId: proposal.interruptId, decision: 'approved',
    committedResult: { status: 'applied', version: 2 } } };
  const selected = receiptConfig(runtime, calls(first.accounting));
  if (selected.provider?.kind !== 'cloudflare') throw new Error('EXPECTED_CLOUDFLARE');
  const changed = { ...selected, provider: { ...selected.provider, accountId: 'b'.repeat(32) } };
  const events: AgentRuntimeEvent[] = [], accounting: AgentAccountingEvent[] = [];
  for (const attempt of [input, resume]) {
    const attemptConfig = attempt.input.kind === 'start'
      ? { ...next(runtime, calls(first.accounting)), provider: changed.provider } : changed;
    await expect(executeAgent(attempt, { signal: AbortSignal.timeout(25_000),
      onEvent: async event => { events.push(event); }, onAccounting: async event => { accounting.push(event); } }, attemptConfig))
      .rejects.toThrow('AGENT_PROVIDER_ACCOUNT_CONFLICT');
  }
  expect(events).toEqual([]);
  expect(accounting).toEqual([]);
  expect((await run(resume, selected)).outcome).toEqual({ status: 'succeeded' });
}), 45_000);

test.each(['rate-limit', 'missing-usage'] as const)('Cloudflare %s retains private evidence with unknown usage', scenario => withDatabase(async () => {
  const { input, runtime } = await setup(scenario);
  const accounting: AgentAccountingEvent[] = [];
  const events: AgentRuntimeEvent[] = [];
  const result = executeAgent(input, { signal: AbortSignal.timeout(25_000), onEvent: async event => { events.push(event); },
    onAccounting: async event => { accounting.push(event); } }, runtime);
  await expect(result).rejects.toThrow(scenario === 'rate-limit' ? 'AGENT_PROVIDER_RATE_LIMIT' : 'AGENT_PROVIDER_INVALID_RESPONSE');
  expect(accounting.map(event => event.kind)).toEqual(['model-call-start', 'model-call-usage']);
  expect(accounting[1]).toEqual({ kind: 'model-call-usage', callId: accounting[0].callId, usage: null,
    providerEvidence: { provider: 'cloudflare', returnedModel: scenario === 'rate-limit' ? null : `${CLOUDFLARE_MODEL}-external`,
      priceBasis: 'cloudflare-gemma4-26b-2026-09-26' } });
  expect(JSON.stringify(events)).not.toMatch(/usage-invalid|other-response|private_body|stage/);
  expect(publicAnswers(events, input)).toEqual([]);
  if (scenario === 'missing-usage') {
    const saved = await database().query(`SELECT to_jsonb(e) AS data FROM "${runtime.schema}"."events" e`);
    expect(JSON.stringify(saved.rows)).toContain('usage-invalid');
  }
}), 30_000);

test.each(['model-call-start', 'model-call-usage'] as const)('invalid candidate cannot mask failed %s persistence', phase => withDatabase(async () => {
  const { input, runtime } = await setup('invalid-tool-arguments');
  const events: AgentRuntimeEvent[] = [];
  await expect(executeAgent(input, { signal: AbortSignal.timeout(25_000),
    onEvent: async event => { events.push(event); }, onAccounting: async event => {
      if (event.kind === phase) throw new Error('synthetic persistence failure');
    } }, runtime)).rejects.toThrow('AGENT_ACCOUNTING_PERSISTENCE_FAILED');
  expect(events.some(event => event.kind === 'proposal'
    || event.kind === 'event' && event.event.type.startsWith('TOOL_CALL'))).toBe(false);
  expect(publicAnswers(events, input)).toEqual([]);
}), 30_000);
