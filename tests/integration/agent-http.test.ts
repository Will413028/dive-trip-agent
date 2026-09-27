import { randomUUID } from 'node:crypto';
import { expect, test, vi } from 'vitest';
import { handleRequest } from '../../src/server/http';
import type { AgentServerContext } from '../../src/server/agent-policy';
import { database } from '../../src/server/db';
import { maximumModelCost } from '../../src/server/model-cost';
import * as costs from '../../src/server/model-cost';
import * as admissions from '../../src/server/agent-admission';
import { withDatabase } from '../support/database';

const origin = 'http://127.0.0.1:4318';
const placeholder = 'offline-placeholder-not-a-credential';
function req(path: string, cookie?: string, body?: unknown) {
  return new Request(`${origin}/api${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
function policy(scenario: 'clarify' | 'proposal' | 'rate-limit' | 'missing-usage' | 'hang' = 'clarify') {
  const loadCredential = vi.fn(async () => placeholder);
  return { provider: 'gemini' as const, verifiedPeerAddress: '127.0.0.1', hashingKey: new Uint8Array(32).fill(42),
    quota: { enabled: true as const, dailyBudgetMicros: 100_000_000, priceBasis: 'synthetic' as const, reservationTtlMs: 60_000 },
    offlineScenario: scenario, loadCredential };
}
async function demo() {
  const response = await handleRequest(req('/demo', undefined, { scenario: 'normal' }));
  return { trip: await response.json(), cookie: response.headers.get('set-cookie')!.split(';')[0] };
}
function input(tripId: string) {
  return { threadId: tripId, runId: randomUUID(), messages: [{ id: randomUUID(), role: 'user', content: '請放慢行程' }],
    state: {}, tools: [], context: [], forwardedProps: { baseVersion: 1 } };
}
async function runs(tripId: string, cookie: string) {
  return (await (await handleRequest(req(`/trips/${tripId}/runs`, cookie))).json()).runs;
}
async function consume(response: Response) {
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(text).not.toContain(placeholder);
  expect(text).not.toMatch(/promptTokens|totalTokens|reservationId|model-call-start/);
  return text;
}

test('offline gate, quota, verified peer and client provider selectors fail before credential or claim', () => withDatabase(async () => {
  const { trip, cookie } = await demo();
  const base = policy();
  const contexts: AgentServerContext[] = [
    { ...base, quota: { enabled: false } },
    { ...base, quota: { ...base.quota, dailyBudgetMicros: 1 } },
    { ...base, verifiedPeerAddress: '' },
    { ...base, offlineScenario: undefined } as unknown as AgentServerContext,
  ];
  for (const context of contexts) {
    const request = req(`/trips/${trip.id}/agent`, cookie, input(trip.id));
    request.headers.set('x-forwarded-for', '127.0.0.1');
    expect([429, 503]).toContain((await handleRequest(request, origin, context)).status);
  }
  for (const extra of [{ provider: 'fixture' }, { forwardedProps: { baseVersion: 1, provider: 'fixture' } }]) {
    expect((await handleRequest(req(`/trips/${trip.id}/agent`, cookie, { ...input(trip.id), ...extra }), origin, base)).status).toBe(400);
  }
  expect(base.loadCredential).not.toHaveBeenCalled();
  expect((await database().query('SELECT * FROM agent_runs')).rowCount).toBe(0);
  expect((await database().query('SELECT * FROM quota_reservations')).rowCount).toBe(0);
}), 30_000);

test.each(['failure', 'abort'] as const)('credential %s is bounded before worker dispatch and never exposes loader errors', mode => withDatabase(async () => {
  const { trip, cookie } = await demo(); const context = policy();
  const started = Promise.withResolvers<void>();
  context.loadCredential.mockImplementation(async () => {
    started.resolve();
    if (mode === 'failure') throw new Error('private-loader-marker');
    return new Promise<string>(() => {});
  });
  const abort = new AbortController();
  const request = new Request(req(`/trips/${trip.id}/agent`, cookie, input(trip.id)), { signal: abort.signal });
  const response = await handleRequest(request, origin, context);
  await started.promise;
  if (mode === 'abort') abort.abort();
  const output = await consume(response);
  expect(output).toContain('RUN_ERROR');
  expect(output).not.toMatch(/private-loader-marker|RUN_FINISHED/);
  expect((await database().query('SELECT * FROM model_calls')).rowCount).toBe(0);
  const [reservation] = (await database().query('SELECT * FROM quota_reservations')).rows;
  expect(reservation.status).toBe('settled');
  expect(reservation.actual_cost_micros).toBeNull();
}), 30_000);

test('request abort after durable model start preserves unknown accounting, failed replay never reloads credentials', () => withDatabase(async () => {
  const { trip, cookie } = await demo(); const context = policy('hang'); const start = input(trip.id);
  const abort = new AbortController();
  const response = await handleRequest(new Request(req(`/trips/${trip.id}/agent`, cookie, start), { signal: abort.signal }), origin, context);
  await vi.waitFor(async () => {
    expect((await database().query('SELECT * FROM model_calls')).rowCount).toBe(1);
  }, { timeout: 10_000, interval: 25 });
  abort.abort();
  const output = await consume(response);
  expect(output).toContain('RUN_ERROR');
  expect(output).not.toMatch(/RUN_FINISHED|TEXT_MESSAGE_CONTENT/);
  const [reservation] = (await database().query('SELECT * FROM quota_reservations')).rows;
  expect(reservation.status).toBe('settled');
  expect(reservation.actual_cost_micros).toBeNull();
  expect(Number(reservation.charged_cost_micros)).toBe(maximumModelCost());
  expect((await handleRequest(req(`/trips/${trip.id}/agent`, cookie, start), origin, context)).status).toBe(409);
  expect(context.loadCredential).toHaveBeenCalledTimes(1);
}), 30_000);

test('concurrent identical HTTP admission executes one credential loader; replay and other owner never execute', () => withDatabase(async () => {
  const { trip, cookie } = await demo(); const other = await demo(); const context = policy(); const start = input(trip.id);
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<string>();
  context.loadCredential.mockImplementation(() => { entered.resolve(); return release.promise; });
  expect((await handleRequest(req(`/trips/${trip.id}/agent`, other.cookie, start), origin, context)).status).toBe(404);
  expect(context.loadCredential).not.toHaveBeenCalled();
  const first = await handleRequest(req(`/trips/${trip.id}/agent`, cookie, start), origin, context);
  await entered.promise;
  try {
    expect((await handleRequest(req(`/trips/${trip.id}/agent`, cookie, start), origin, context)).status).toBe(409);
    expect(context.loadCredential).toHaveBeenCalledTimes(1);
  } finally { release.resolve(placeholder); }
  const output = await consume(first);
  expect(output).toContain('RUN_FINISHED');
  expect(await consume(await handleRequest(req(`/trips/${trip.id}/agent`, cookie, start), origin, context))).toBe(output);
  expect(context.loadCredential).toHaveBeenCalledTimes(1);
  const [run] = await runs(trip.id, cookie);
  expect((await handleRequest(req(`/trips/${trip.id}/runs/${run.id}/events`, other.cookie))).status).toBe(404);
  expect((await handleRequest(req(`/trips/${trip.id}/runs`, other.cookie))).status).toBe(404);
  expect((await database().query('SELECT * FROM agent_invocations')).rowCount).toBe(1);
  expect((await database().query('SELECT * FROM model_calls')).rowCount).toBe(1);
}), 30_000);

test.each([true, false])('SDK proposal resume confirmed=%s, policy before mutation, zero generation cost and no fixture downgrade', confirmed => withDatabase(async () => {
  const { trip, cookie } = await demo(); const context = policy('proposal'); const start = input(trip.id);
  const post = (body: unknown, ctx: AgentServerContext = context) => handleRequest(req(`/trips/${trip.id}/agent`, cookie, body), origin, ctx);
  expect(await consume(await post(start))).toContain('"type":"interrupt"');
  const [run] = await runs(trip.id, cookie);
  expect(run.status).toBe('awaiting_confirmation');
  expect(run.proposal.draft.canApply).toBe(true);
  expect((await post(start, { provider: 'fixture' })).status).toBe(409);
  const resume = { ...input(trip.id), messages: [], forwardedProps: { runId: run.id },
    resume: [{ interruptId: run.interruptId, status: 'resolved', payload: { confirmed } }] };
  expect((await post(resume, { provider: 'fixture' })).status).toBe(409);
  expect((await post(resume, { ...context, quota: { enabled: false } })).status).toBe(503);
  expect(context.loadCredential).toHaveBeenCalledTimes(1);
  expect((await runs(trip.id, cookie))[0]).toMatchObject({ status: 'awaiting_confirmation', decision: null });
  expect((await database().query('SELECT status FROM proposals WHERE id=$1', [run.proposalId])).rows[0].status).toBe('pending');
  // A committed receipt needs no generation budget or second credential load.
  expect(await consume(await post(resume, { ...context, quota: { ...context.quota, dailyBudgetMicros: 1 } })))
    .toContain('"type":"success"');
  await consume(await post(resume));
  expect(context.loadCredential).toHaveBeenCalledTimes(1);
  const view = await (await handleRequest(req(`/trips/${trip.id}`, cookie))).json();
  expect(view.version).toBe(confirmed ? 2 : 1);
  const invocations = (await database().query('SELECT * FROM agent_invocations ORDER BY prior_model_calls')).rows;
  expect(invocations).toHaveLength(2);
  expect(invocations.map(invocation => ({ kind: invocation.kind, prior: invocation.prior_model_calls })))
    .toEqual([{ kind: 'start', prior: 0 }, { kind: 'resume', prior: 2 }]);
  expect(invocations.every(i => i.status === 'settled')).toBe(true);
  const calls = (await database().query('SELECT * FROM model_calls')).rows;
  expect(calls).toHaveLength(2);
  expect(calls.every(call => call.invocation_id === invocations[0].id)).toBe(true);
  expect(calls.every(c => c.status === 'completed' && c.usage !== null)).toBe(true);
  const reservations = (await database().query('SELECT * FROM quota_reservations')).rows;
  expect(reservations).toHaveLength(2);
  expect(new Set(reservations.map(r => r.logical_run_id)).size).toBe(1);
  expect(reservations.every(r => r.actual_cost_micros !== null && Number(r.charged_cost_micros) < maximumModelCost())).toBe(true);
  const resumedReservation = reservations.find(reservation => reservation.id === invocations[1].reservation_id);
  expect(Number(invocations[1].max_cost_micros)).toBe(0);
  expect(Number(resumedReservation.max_cost_micros)).toBe(0);
  expect(Number(resumedReservation.actual_cost_micros)).toBe(0);
  expect(Number(resumedReservation.charged_cost_micros)).toBe(0);
  expect(JSON.stringify(await runs(trip.id, cookie))).not.toMatch(/promptTokens|totalTokens|reservationId|offline-placeholder/);
}), 60_000);

test.each(['rate-limit', 'missing-usage'] as const)('%s retains unknown reservation and exposes no accounting', scenario => withDatabase(async () => {
  const { trip, cookie } = await demo(); const context = policy(scenario);
  const output = await consume(await handleRequest(req(`/trips/${trip.id}/agent`, cookie, input(trip.id)), origin, context));
  expect(output).toContain(scenario === 'rate-limit' ? 'RUN_ERROR' : 'RUN_FINISHED');
  if (scenario === 'rate-limit') expect(output).toContain('AGENT_PROVIDER_RATE_LIMIT');
  const [reservation] = (await database().query('SELECT * FROM quota_reservations')).rows;
  expect(reservation.status).toBe('settled');
  expect(reservation.actual_cost_micros).toBeNull();
  expect(Number(reservation.charged_cost_micros)).toBe(maximumModelCost());
  expect((await database().query('SELECT * FROM model_calls')).rowCount).toBe(1);
}), 30_000);

test('default fixture remains offline and cannot be upgraded by request or injected context replay', () => withDatabase(async () => {
  const { trip, cookie } = await demo(); const start = input(trip.id);
  start.messages[0].content = '人數未定';
  expect(await consume(await handleRequest(req(`/trips/${trip.id}/agent`, cookie, start)))).toContain('RUN_FINISHED');
  const context = policy();
  expect((await handleRequest(req(`/trips/${trip.id}/agent`, cookie, start), origin, context)).status).toBe(409);
  expect(context.loadCredential).not.toHaveBeenCalled();
  expect((await database().query('SELECT * FROM agent_invocations')).rowCount).toBe(0);
}), 30_000);

test('observed cost overrun is persisted without clamp but cannot finish successfully', () => withDatabase(async () => {
  const { trip, cookie } = await demo(); const context = policy();
  const observed = maximumModelCost() + 1;
  const cost = vi.spyOn(costs, 'referenceModelCost').mockReturnValue(observed);
  try {
    const output = await consume(await handleRequest(req(`/trips/${trip.id}/agent`, cookie, input(trip.id)), origin, context));
    expect(output).toContain('RUN_ERROR');
    expect(output).not.toContain('RUN_FINISHED');
    const [reservation] = (await database().query('SELECT * FROM quota_reservations')).rows;
    expect(reservation.status).toBe('settled');
    expect(Number(reservation.actual_cost_micros)).toBe(observed);
    expect(Number(reservation.charged_cost_micros)).toBe(observed);
  } finally { cost.mockRestore(); }
}), 30_000);

test('duplicate start ACK never authorizes dispatch; failed execution conservatively retains reservation', () => withDatabase(async () => {
  const { trip, cookie } = await demo(); const context = policy();
  const accounting = vi.spyOn(admissions, 'accountModelCall').mockResolvedValue({ recorded: false });
  try {
    const output = await consume(await handleRequest(req(`/trips/${trip.id}/agent`, cookie, input(trip.id)), origin, context));
    expect(output).toContain('RUN_ERROR');
    expect(output).not.toContain('TEXT_MESSAGE_CONTENT');
    expect(accounting).toHaveBeenCalledTimes(1);
    expect(accounting.mock.calls[0][3].kind).toBe('model-call-start');
    const [reservation] = (await database().query('SELECT * FROM quota_reservations')).rows;
    expect(reservation.actual_cost_micros).toBeNull();
    expect(Number(reservation.charged_cost_micros)).toBe(maximumModelCost());
  } finally { accounting.mockRestore(); }
}), 30_000);
