import { randomUUID } from 'node:crypto';
import { EventType, type BaseEvent } from '@ag-ui/core';
import type { PoolClient } from 'pg';
import { beforeEach, expect, test, vi } from 'vitest';
import { compileAnswer, compileFailure } from '../../src/agent/answer-compiler';
import { executeAgent } from '../../src/agent/runtime';
import { ANSWER_EVENT_NAME } from '../../src/domain/answer';
import { calculateBudget } from '../../src/domain/budget';
import { DomainError } from '../../src/domain/errors';
import * as admissions from '../../src/server/agent-admission';
import { type AgentServerContext } from '../../src/server/agent-policy';
import { parseStoredRunEvent } from '../../src/server/answer-events';
import { chatAgent } from '../../src/server/chat-http';
import { database } from '../../src/server/db';
import * as runs from '../../src/server/run-store';
import { getTrip } from '../../src/server/trip-store';
import { makeSnapshot } from '../support/domain-fixtures';

// Transport ordering tests only. No database, worker, network or credential file.
vi.mock('../../src/agent/runtime', () => ({ executeAgent: vi.fn() }));
vi.mock('../../src/server/db', () => ({ database: vi.fn(), transaction: vi.fn() }));
vi.mock('../../src/server/trip-store', () => ({ getTrip: vi.fn() }));
vi.mock('../../src/server/run-store', () => ({ startRun: vi.fn(), appendRunEvent: vi.fn(), finishRun: vi.fn(),
  bindProposal: vi.fn(), claimResume: vi.fn(), getRun: vi.fn(), listRuns: vi.fn() }));
vi.mock('../../src/server/agent-admission', () => ({ admitStart: vi.fn(), admitResume: vi.fn(), accountModelCall: vi.fn(),
  getAdmissionUsage: vi.fn(), settleAdmission: vi.fn(), settleRejectedToolArguments: vi.fn() }));
vi.mock('../../src/server/agent-policy', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/server/agent-policy')>(),
  fixtureClaim: vi.fn(async (_trip: string, _selector: unknown, work: (client: PoolClient) => Promise<unknown>) => work({} as PoolClient)),
}));

beforeEach(() => vi.clearAllMocks());
function setup() {
  const owner = randomUUID(), tripId = randomUUID(), runId = randomUUID();
  const snapshot = makeSnapshot();
  const binding = { ownerId: owner, tripId, runId, baseVersion: 1 };
  const value = compileAnswer({ version: '1', answer: { kind: 'clarify', fields: ['dates'] } }, { binding, eventId: 'final', evidence: [] });
  const answer = { type: EventType.CUSTOM, name: ANSWER_EVENT_NAME, value };
  const stored: runs.RunEvent[] = [];
  const run: runs.AgentRun = { id: runId, tripId, requestId: 'request', baseVersion: 1, message: '日期未定',
    status: 'running', events: [], proposalId: null, interruptId: null, decision: null, answerContractVersion: 1 };
  const input = { threadId: tripId, runId: randomUUID(), messages: [{ id: 'user', role: 'user', content: run.message }],
    tools: [], state: {}, context: [], forwardedProps: { baseVersion: 1 } };
  vi.mocked(getTrip).mockResolvedValue({ id: tripId, version: 1, snapshot, budget: calculateBudget(snapshot) });
  const query = vi.fn(async () => ({ rows: [{ name: `test_${'a'.repeat(32)}` }], rowCount: 1 }));
  vi.mocked(database).mockReturnValue({ query, options: { connectionString: 'postgresql://postgres@127.0.0.1:5432/dive_trip_test' } } as unknown as ReturnType<typeof database>);
  vi.mocked(runs.startRun).mockResolvedValue({ run, created: true });
  const save = (raw: BaseEvent) => {
    const event = parseStoredRunEvent(raw, runId);
    if (event.type === EventType.CUSTOM) {
      const prior = stored.find(({ event: raw }) => {
        const prior = parseStoredRunEvent(raw, runId);
        return prior.type === EventType.CUSTOM && prior.value.answerId === event.value.answerId;
      });
      if (prior) return prior;
    }
    const saved = { sequence: stored.length + 1, event };
    stored.push(saved); return saved;
  };
  vi.mocked(runs.appendRunEvent).mockImplementation(async (_owner, _trip, _run, event) => save(event));
  vi.mocked(runs.finishRun).mockImplementation(async (_owner, _trip, _run, input) => {
    if (input.status === 'failed') save({ type: EventType.CUSTOM, name: ANSWER_EVENT_NAME,
      value: compileFailure({ binding, eventId: 'server:terminal-failure', evidence: [] }) });
    if (input.event) save(input.event);
    return { ...run, status: input.status, events: [...stored] };
  });
  vi.mocked(executeAgent).mockImplementation(async (_execution, hooks) => {
    await hooks.onEvent({ kind: 'event', event: answer });
    return { status: 'succeeded' };
  });
  const request = new Request('http://127.0.0.1:4318/api/agent', { method: 'POST' });
  return { owner, tripId, run, input, answer, stored, save, query, request,
    start: (context?: AgentServerContext) => chatAgent(request, owner, tripId, input, context) };
}

test('P3 HTTP hook ACK and SSE both wait for product persistence, duplicate answer emits once', async () => {
  const f = setup();
  const writing = Promise.withResolvers<void>(), commit = Promise.withResolvers<void>();
  let acknowledged = false;
  vi.mocked(runs.appendRunEvent).mockImplementation(async (_owner, _trip, _run, event) => {
    if (event.type === EventType.CUSTOM) { writing.resolve(); await commit.promise; }
    return f.save(event);
  });
  vi.mocked(executeAgent).mockImplementation(async (execution, hooks) => {
    expect(execution.tripId).toBe(f.tripId);
    await hooks.onEvent({ kind: 'event', event: f.answer });
    acknowledged = true;
    await hooks.onEvent({ kind: 'event', event: f.answer });
    return { status: 'succeeded' };
  });
  const response = await f.start();
  const reader = response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain('RUN_STARTED');
  await writing.promise;
  let published = false;
  const next = reader.read().then(chunk => { published = true; return chunk; });
  await Promise.resolve();
  expect(acknowledged).toBe(false); expect(published).toBe(false);
  expect(f.stored).toHaveLength(1);
  commit.resolve();
  expect(new TextDecoder().decode((await next).value)).toContain(f.answer.value.answerId);
  const remainder: string[] = [];
  for (;;) { const chunk = await reader.read(); if (chunk.done) break; remainder.push(new TextDecoder().decode(chunk.value)); }
  expect(acknowledged).toBe(true);
  expect(remainder.join('')).not.toContain(f.answer.value.answerId);
  expect(remainder.join('')).toContain('RUN_FINISHED');
});

test('P3 failed answer persistence cannot be emitted or ACKed as accepted', async () => {
  const f = setup();
  let acknowledged = false;
  vi.mocked(runs.appendRunEvent).mockImplementation(async (_owner, _trip, _run, event) => {
    if (event.type === EventType.CUSTOM) throw new DomainError('INVALID_RUN_EVENT');
    return f.save(event);
  });
  vi.mocked(executeAgent).mockImplementation(async (_execution, hooks) => {
    await hooks.onEvent({ kind: 'event', event: f.answer }); acknowledged = true;
    return { status: 'succeeded' };
  });
  const text = await (await f.start()).text();
  expect(acknowledged).toBe(false);
  expect(text).not.toContain(f.answer.value.answerId);
  expect(text).toContain('failure'); expect(text).toContain('RUN_ERROR');
  expect(text).not.toContain('RUN_FINISHED');
});

test.each(['raw-text', 'private', 'foreign-run', 'worker-lifecycle'])('P3 HTTP rejects %s before handing it to the store', async kind => {
  const f = setup();
  const bad = kind === 'raw-text' ? { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'raw', delta: 'raw-private-output' }
    : kind === 'private' ? { ...f.answer, rawEvent: { private: 'raw-private-output' } }
    : kind === 'foreign-run' ? { ...f.answer, value: { ...f.answer.value, runId: randomUUID() } }
    : { type: EventType.RUN_FINISHED, threadId: f.tripId, runId: f.input.runId, result: 'raw-private-output' };
  vi.mocked(executeAgent).mockImplementation(async (_execution, hooks) => {
    await hooks.onEvent({ kind: 'event', event: bad });
    return { status: 'succeeded' };
  });
  const text = await (await f.start()).text();
  expect(vi.mocked(runs.appendRunEvent).mock.calls.map(call => call[3].type)).toEqual([EventType.RUN_STARTED]);
  expect(text).not.toContain('raw-private-output');
  expect(text).not.toContain(f.answer.value.answerId);
  expect(text).toContain('RUN_ERROR');
});

test('P5 live and legacy schema are rejected before claim, admission, credential loading or execution', async () => {
  const f = setup(), loadCredential = vi.fn(async () => { throw new Error('must not read a key'); });
  const live: AgentServerContext = { provider: 'gemini', liveLocal: true, verifiedPeerAddress: '127.0.0.1',
    hashingKey: new Uint8Array(32), quota: { enabled: true, dailyBudgetMicros: 1_000_000, priceBasis: 'server-verified', reservationTtlMs: 60_000 },
    loadCredential };
  await expect(f.start(live)).rejects.toMatchObject({ code: 'AGENT_POLICY_DISABLED' });
  expect(getTrip).not.toHaveBeenCalled();
  f.query.mockResolvedValue({ rows: [{ name: 'workbench_live' }], rowCount: 1 });
  await expect(f.start()).rejects.toMatchObject({ code: 'AGENT_POLICY_DISABLED' });
  expect(loadCredential).not.toHaveBeenCalled();
  expect(admissions.admitStart).not.toHaveBeenCalled();
  expect(runs.startRun).not.toHaveBeenCalled();
  expect(executeAgent).not.toHaveBeenCalled();
});

test('P5 synthetic evaluation remains testable without accessing a real credential', async () => {
  const f = setup();
  const loadCredential = vi.fn(async () => 'offline-placeholder-not-a-credential');
  const context: AgentServerContext = { provider: 'gemini', offlineScenario: 'clarify', verifiedPeerAddress: '127.0.0.1',
    hashingKey: new Uint8Array(32), quota: { enabled: true, dailyBudgetMicros: 1_000_000, priceBasis: 'synthetic', reservationTtlMs: 60_000 },
    loadCredential, evaluation: { catalog: makeSnapshot().entries.map(entry => entry.item), lookupTimeout: false } };
  vi.mocked(admissions.admitStart).mockResolvedValue({ run: f.run, executed: true, admission: {
    id: randomUUID(), reservationId: randomUUID(), provider: 'gemini', model: 'gemini-3.1-flash-lite',
    expiresAt: new Date(Date.now() + 60_000), priorModelCalls: 0,
  } });
  vi.mocked(admissions.getAdmissionUsage).mockResolvedValue({ runId: f.run.id, reservationId: randomUUID(),
    provider: 'gemini', model: 'gemini-3.1-flash-lite', hasUnknownUsage: true, complete: false, calls: [] });
  vi.mocked(admissions.settleAdmission).mockResolvedValue({ maxCostMicros: 100, chargedCostMicros: 100 } as Awaited<ReturnType<typeof admissions.settleAdmission>>);
  const text = await (await f.start(context)).text();
  expect(text).toContain(ANSWER_EVENT_NAME); expect(text).toContain('RUN_FINISHED');
  expect(loadCredential).toHaveBeenCalledOnce();
  expect(executeAgent).toHaveBeenCalledOnce();
  const runtimeConfig = vi.mocked(executeAgent).mock.calls[0][2];
  expect(runtimeConfig).toMatchObject({ provider: { kind: 'gemini', previousModelCalls: 0 },
    generation: { apiKey: 'offline-placeholder-not-a-credential' }, offlineScenario: 'clarify' });
  expect(runtimeConfig.provider).not.toHaveProperty('apiKey');
});
