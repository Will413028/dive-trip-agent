import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, test } from 'vitest';
import { EventType } from '@ag-ui/core';
import { acceptedAnswerSchema, ANSWER_EVENT_NAME, type AcceptedAnswer } from '../../src/domain/answer';
import { evidenceIdentity } from '../../src/agent/answer-evidence';
import { executeAgent, validateRuntimeConfig, validateRuntimeExecution, type AgentExecution, type AgentRuntimeConfig,
  type AgentRuntimeEvent, type AgentAccountingEvent, type OfflineScenario } from '../../src/agent/runtime';
import { withDatabase, testDatabaseUrl } from '../support/database';
import { database } from '../../src/server/db';
import { makeSnapshot } from '../support/domain-fixtures';

const syntheticKey = 'offline-placeholder-not-a-credential';
async function setup(offlineScenario: OfflineScenario = 'clarify') {
  const schema = (await database().query('SELECT current_schema() AS name')).rows[0].name;
  const config: AgentRuntimeConfig = { databaseUrl: testDatabaseUrl(), schema: `${schema}_adk`, offlineScenario,
    generation: { apiKey: syntheticKey },
    provider: { kind: 'gemini', deadlineMs: Date.now() + 30_000, previousModelCalls: 0 } };
  const snapshot = makeSnapshot();
  const runId = randomUUID();
  const input: AgentExecution = { runId, sessionId: runId, ownerId: randomUUID(), tripId: randomUUID(), baseVersion: 1,
    snapshot, catalog: snapshot.entries.map(entry => entry.item), input: { kind: 'start', message: '請協助規劃行程' } };
  return { config, input };
}
async function run(input: AgentExecution, config: AgentRuntimeConfig) {
  const events: AgentRuntimeEvent[] = [], accounting: AgentAccountingEvent[] = [];
  const outcome = await executeAgent(input, { signal: AbortSignal.timeout(25_000),
    onEvent: async event => { events.push(event); }, onAccounting: async event => { accounting.push(event); } }, config);
  return { outcome, events, accounting };
}
function counts(events: AgentAccountingEvent[]) { return events.filter(event => event.kind === 'model-call-start').length; }
function nextConfig(config: AgentRuntimeConfig, previousModelCalls: number): AgentRuntimeConfig {
  return { ...config, provider: { ...config.provider!, deadlineMs: Date.now() + 30_000, previousModelCalls } };
}
function receiptConfig(config: AgentRuntimeConfig, previousModelCalls: number): AgentRuntimeConfig {
  return { databaseUrl: config.databaseUrl, schema: config.schema,
    provider: { ...config.provider!, deadlineMs: Date.now() + 30_000, previousModelCalls } };
}
async function stored(config: AgentRuntimeConfig) {
  const rows = await Promise.all(['sessions', 'events', 'app_states', 'user_states'].map(table =>
    database().query(`SELECT to_jsonb(t) AS data FROM "${config.schema}"."${table}" t`)));
  return rows.flatMap(result => result.rows.map(row => row.data));
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
  expect(serialized).not.toMatch(/ownerId|tripId|untrustedTripData|answerEvidenceRef|validationId|set_model_response|model-call-start|model-call-usage|promptTokens|providerEvidence|priceBasis|private_value_marker|private_key_marker/);
  for (const privateValue of [syntheticKey, input.ownerId, input.tripId]) expect(serialized).not.toContain(privateValue);
  return answers;
}
function reference(input: AgentExecution, kind: 'proposal' | 'receipt', callId: string) {
  const { ownerId, tripId, runId, baseVersion } = input;
  return evidenceIdentity({ ownerId, tripId, runId, baseVersion }, kind, callId);
}

test('provider binding與generation分離：start需capability及accounting，resume禁止generation', async () => {
  const config: AgentRuntimeConfig = { databaseUrl: 'postgresql://postgres@127.0.0.1:1/dive_trip_test', schema: 'test_adk',
    provider: { kind: 'gemini', deadlineMs: Date.now() + 10_000, previousModelCalls: 0 },
    generation: { apiKey: syntheticKey }, offlineScenario: 'clarify' };
  const snapshot = makeSnapshot(); const runId = randomUUID();
  const input: AgentExecution = { runId, sessionId: runId, ownerId: randomUUID(), tripId: randomUUID(), baseVersion: 1,
    snapshot, catalog: snapshot.entries.map(entry => entry.item), input: { kind: 'start', message: '請協助規劃行程' } };
  const resume: AgentExecution = { ...input, input: { kind: 'resume', interruptId: randomUUID(), decision: 'approved',
    committedResult: { status: 'applied', version: 2 } } };
  const bindingOnly = receiptConfig(config, 2);
  const hooks = { signal: new AbortController().signal, onEvent: async () => {} };
  expect(() => validateRuntimeConfig(bindingOnly)).not.toThrow();
  expect(() => validateRuntimeExecution(input, config)).not.toThrow();
  expect(() => validateRuntimeExecution(resume, bindingOnly)).not.toThrow();
  expect(() => validateRuntimeExecution(input, bindingOnly)).toThrow('AGENT_GENERATION_REQUIRED');
  await expect(executeAgent(input, hooks, bindingOnly)).rejects.toThrow('AGENT_GENERATION_REQUIRED');
  expect(() => validateRuntimeExecution(resume, config)).toThrow('AGENT_GENERATION_DISABLED');
  await expect(executeAgent(resume, hooks, config)).rejects.toThrow('AGENT_GENERATION_DISABLED');
  expect(() => validateRuntimeExecution(resume, { ...bindingOnly, generation: { apiKey: 'synthetic-unit-only-key' } }))
    .toThrow('AGENT_GENERATION_DISABLED');
  expect(() => validateRuntimeExecution(resume, { ...bindingOnly, offlineScenario: 'clarify' }))
    .toThrow('AGENT_OFFLINE_CONFIG');
  expect(() => validateRuntimeExecution(resume, { ...bindingOnly, schema: `test_${'a'.repeat(32)}_adk`, lookupTimeout: true }))
    .toThrow('AGENT_GENERATION_DISABLED');
  await expect(executeAgent(input, hooks, config))
    .rejects.toThrow('AGENT_ACCOUNTING_REQUIRED');
  const legacyCredentialBinding = { ...config, provider: { ...config.provider!, apiKey: syntheticKey } };
  expect(() => validateRuntimeConfig(legacyCredentialBinding)).toThrow('AGENT_PROVIDER_CONFIG');
  expect(() => validateRuntimeConfig({ ...config, provider: undefined })).toThrow('AGENT_PROVIDER_CONFIG');
  expect(() => validateRuntimeConfig({ ...config, generation: { apiKey: '' } })).toThrow('AGENT_PROVIDER_CONFIG');
  expect(() => validateRuntimeConfig({ ...config, generation: { apiKey: 'another-synthetic-key' } }))
    .toThrow('AGENT_OFFLINE_CONFIG');
  expect(() => validateRuntimeConfig({ ...config, offlineScenario: '../other.ts' as OfflineScenario })).toThrow('AGENT_OFFLINE_CONFIG');
  expect(() => validateRuntimeConfig({ ...config, offlineScenario: undefined })).toThrow('AGENT_OFFLINE_CONFIG');
  expect(() => validateRuntimeConfig({ ...config, provider: { ...config.provider!, previousModelCalls: -1 } })).toThrow('AGENT_PROVIDER_CONFIG');
  expect(() => validateRuntimeConfig({ ...config, schema: 'workbench_live_adk', lookupTimeout: true })).toThrow('AGENT_LEGACY_READ_ONLY');
  expect(() => validateRuntimeConfig({ ...config, lookupTimeout: true })).toThrow('AGENT_OFFLINE_CONFIG');
  expect(() => validateRuntimeConfig({ ...config, schema: `test_${'a'.repeat(32)}_adk`, lookupTimeout: true })).not.toThrow();
});

test('真Gemini adapter離線回覆：private usage不進AGUI，key不進ADK state/events；重播不再計費', () => withDatabase(async () => {
  const { input, config } = await setup();
  const result = await run(input, config);
  expect(result.outcome).toEqual({ status: 'succeeded' });
  expect(result.accounting.map(event => event.kind)).toEqual(['model-call-start', 'model-call-usage']);
  expect(result.accounting[1]).toMatchObject({ callId: result.accounting[0].callId, usage: expect.any(Object) });
  const answers = publicAnswers(result.events, input);
  expect(answers).toHaveLength(1);
  expect(answers[0]).toMatchObject({ schemaVersion: 1, templateVersion: 1, evidenceRefs: [],
    body: { kind: 'clarify', fields: ['people', 'divers'] } });
  expect(JSON.stringify(result.events)).not.toMatch(/model-call-start|model-call-usage|promptTokens/);
  const before = await stored(config);
  expect(JSON.stringify(before)).toContain('providerMode');
  expect(JSON.stringify({ before, events: result.events, accounting: result.accounting })).not.toContain(syntheticKey);
  const replay = await run(input, nextConfig(config, counts(result.accounting)));
  expect(replay.outcome.status).toBe('succeeded');
  expect(replay.accounting).toEqual([]);
  expect(publicAnswers(replay.events, input)).toEqual(answers);
  expect(await stored(config)).toEqual(before);
}), 30_000);

test.each(['model-call-start', 'model-call-usage'] as const)('%s等待parent持久化ACK才前進', phase => withDatabase(async () => {
  const { input, config } = await setup();
  let release!: () => void, reached!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { reached = resolve; });
  const accounting: AgentAccountingEvent[] = [], events: AgentRuntimeEvent[] = [];
  const controller = new AbortController();
  let settled = false;
  const pending = executeAgent(input, { signal: controller.signal, onEvent: async event => { events.push(event); },
    onAccounting: async event => { accounting.push(event); if (event.kind === phase) { reached(); await gate; } },
  }, config).then(outcome => ({ outcome }), error => ({ error })).finally(() => { settled = true; });
  try {
    await Promise.race([entered, pending.then(() => { throw new Error('EXIT_BEFORE_ACCOUNTING'); })]);
    await delay(100);
    expect(settled).toBe(false);
    expect(events).toEqual([]);
    expect(accounting).toHaveLength(phase === 'model-call-start' ? 1 : 2);
    release();
    expect(await pending).toEqual({ outcome: { status: 'succeeded' } });
  } finally { release(); controller.abort(); await pending; }
}), 30_000);

test.each(['model-call-start', 'model-call-usage'] as const)('%s ACK失敗不暴露模型輸出／raw error', phase => withDatabase(async () => {
  const { input, config } = await setup();
  const accounting: AgentAccountingEvent[] = [], events: AgentRuntimeEvent[] = [];
  await expect(executeAgent(input, { signal: AbortSignal.timeout(20_000), onEvent: async event => { events.push(event); },
    onAccounting: async event => { accounting.push(event); if (event.kind === phase) throw new Error(`raw-secret:${syntheticKey}`); },
  }, config)).rejects.toThrow(/^AGENT_ACCOUNTING_PERSISTENCE_FAILED$/);
  expect(events).toEqual([]);
  expect(accounting).toHaveLength(phase === 'model-call-start' ? 1 : 2);
  const saved = await stored(config);
  expect(JSON.stringify(saved)).not.toContain(syntheticKey);
  expect(JSON.stringify(saved)).not.toContain('usage_metadata');
}), 30_000);

test.each(['fixture-first', 'gemini-first'] as const)('%s不可在既有session切換provider mode', direction => withDatabase(async () => {
  const { input, config } = await setup();
  const fixture = { databaseUrl: config.databaseUrl, schema: config.schema };
  await run(input, direction === 'fixture-first' ? fixture : config);
  const before = await stored(config);
  await expect(run(input, direction === 'fixture-first' ? config : fixture)).rejects.toThrow('AGENT_PROVIDER_MODE_CONFLICT');
  expect(await stored(config)).toEqual(before);
  if (direction === 'fixture-first') expect(JSON.stringify(before)).not.toContain('providerMode');
}), 30_000);

test('DB previousModelCalls不可低於ADK歷史，已耗盡預算也不可呼叫provider', () => withDatabase(async () => {
  const { input, config } = await setup();
  await run(input, config);
  await expect(run(input, config)).rejects.toThrow('AGENT_MODEL_HISTORY_CONFLICT');
  const anotherId = randomUUID();
  const accounting: AgentAccountingEvent[] = [];
  await expect(executeAgent({ ...input, runId: anotherId, sessionId: anotherId }, {
    signal: AbortSignal.timeout(20_000), onEvent: async () => {}, onAccounting: async event => { accounting.push(event); },
  }, nextConfig(config, 7))).rejects.toThrow('AGENT_MODEL_LIMIT');
  expect(accounting).toEqual([]);
}), 30_000);

test.each(['approved', 'rejected'] as const)('Gemini讀工具／proposal後跨程序%s，native confirmation及accounting保持獨立', decision => withDatabase(async () => {
  const { input, config } = await setup('proposal');
  const first = await run(input, config);
  expect(first.outcome.status).toBe('awaiting_confirmation');
  expect(first.events.some(event => event.kind === 'event' && event.event.type === EventType.TOOL_CALL_START
    && event.event.toolCallName === 'validate_changes')).toBe(true);
  expect(first.events.some(event => event.kind === 'event' && event.event.type === EventType.TOOL_CALL_RESULT)).toBe(true);
  const proposal = first.events.find(event => event.kind === 'proposal');
  if (!proposal || proposal.kind !== 'proposal') throw new Error('MISSING_PROPOSAL');
  const pending = publicAnswers(first.events, input);
  expect(pending).toHaveLength(1);
  const proposalRef = reference(input, 'proposal', proposal.toolCallId);
  expect(pending[0]).toMatchObject({ evidenceRefs: [proposalRef], body: { kind: 'proposal', proposalRef, changeCount: 1,
    budget: { scope: 'candidate', baseVersion: 1, known: { minor: 430000, display: 'TWD 4300.00' }, containsDemo: true } } });
  expect(counts(first.accounting)).toBe(2);
  const resume: AgentExecution = { ...input, input: { kind: 'resume', interruptId: proposal.interruptId, decision,
    committedResult: { status: decision === 'approved' ? 'applied' : 'rejected', version: decision === 'approved' ? 2 : 1 } } };
  await expect(run(resume, { databaseUrl: config.databaseUrl, schema: config.schema })).rejects.toThrow('AGENT_PROVIDER_MODE_CONFLICT');
  const selected = receiptConfig(config, counts(first.accounting));
  expect(selected).not.toHaveProperty('generation');
  expect(selected).not.toHaveProperty('offlineScenario');
  const resumed = await run(resume, selected);
  expect(resumed.outcome.status).toBe('succeeded');
  expect(resumed.events.some(event => event.kind === 'event' && event.event.type === EventType.TOOL_CALL_RESULT)).toBe(true);
  expect(resumed.events.some(event => event.kind === 'proposal')).toBe(false);
  expect(resumed.accounting).toEqual([]);
  expect(counts(first.accounting) + counts(resumed.accounting)).toBe(2);
  const answers = publicAnswers(resumed.events, input);
  expect(answers).toHaveLength(1);
  expect(answers[0].evidenceRefs).toEqual([reference(input, 'receipt', proposal.toolCallId)]);
  expect(answers[0].body).toEqual({ kind: 'receipt', status: decision === 'approved' ? 'applied' : 'rejected',
    version: decision === 'approved' ? 2 : 1 });
  const replay = await run(resume, receiptConfig(config, 2));
  expect(replay.outcome.status).toBe('succeeded');
  expect(replay.accounting).toEqual([]);
  expect(publicAnswers(replay.events, input)).toEqual(answers);
  expect(JSON.stringify(await stored(config))).not.toContain(syntheticKey);
}), 30_000);

test.each(['rate-limit', 'missing-usage'] as const)('%s保留unknown usage，錯誤只傳safe code', scenario => withDatabase(async () => {
  const { input, config } = await setup(scenario);
  const accounting: AgentAccountingEvent[] = [];
  const events: AgentRuntimeEvent[] = [];
  const result = executeAgent(input, { signal: AbortSignal.timeout(20_000), onEvent: async event => { events.push(event); },
    onAccounting: async event => { accounting.push(event); } }, config);
  if (scenario === 'rate-limit') await expect(result).rejects.toThrow(/^AGENT_PROVIDER_RATE_LIMIT$/);
  else expect(await result).toEqual({ status: 'succeeded' });
  expect(accounting.map(event => event.kind)).toEqual(['model-call-start', 'model-call-usage']);
  expect(accounting[1]).toEqual({ kind: 'model-call-usage', callId: accounting[0].callId, usage: null });
  const answers = publicAnswers(events, input);
  if (scenario === 'rate-limit') expect(answers).toEqual([]);
  else {
    expect(answers).toHaveLength(1);
    expect(answers[0].body).toEqual({ kind: 'clarify', fields: ['people', 'divers'] });
  }
}), 30_000);

test('absolute deadline不從worker重新起算，hang被kill且連線關閉', () => withDatabase(async () => {
  const { input, config } = await setup('hang');
  const began = Date.now();
  config.provider!.deadlineMs = began + 6_000;
  const accounting: AgentAccountingEvent[] = [];
  await expect(executeAgent(input, { signal: AbortSignal.timeout(12_000), onEvent: async () => {},
    onAccounting: async event => { accounting.push(event); } }, config)).rejects.toThrow(/^AGENT_(?:TIMEOUT|PROVIDER_TIMEOUT)$/);
  expect(counts(accounting)).toBe(1);
  expect(Date.now() - began).toBeLessThan(9_000);
  // Child close is not an acknowledgement of PostgreSQL backend teardown.
  // Each sample is autocommit (withDatabase does not open a transaction), so
  // polling cannot reuse a transaction-scoped pg_stat_activity snapshot.
  // Keep the invocation deadline assertion above independent of cleanup grace.
  await expect.poll(async () => (await database().query(
    'SELECT pid,state,wait_event_type,wait_event FROM pg_stat_activity WHERE application_name=$1',
    [`agent-runtime:${input.runId}`],
  )).rows, { timeout: 2_000, interval: 25 }).toEqual([]);
}), 15_000);
