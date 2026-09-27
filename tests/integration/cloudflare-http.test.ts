import { randomUUID } from 'node:crypto';
import { expect, test, vi } from 'vitest';
import { EventSchemas } from '@ag-ui/core/schemas';
import { handleRequest } from '../../src/server/http';
import type { AgentServerContext } from '../../src/server/agent-policy';
import type { OfflineScenario } from '../../src/agent/runtime';
import { CLOUDFLARE_MODEL } from '../../src/agent/cloudflare-wire';
import { maximumProviderModelCost } from '../../src/server/model-cost';
import { database } from '../../src/server/db';
import { withDatabase } from '../support/database';

const origin = 'http://127.0.0.1:4318';
const placeholder = 'offline-placeholder-not-a-credential';
const accountId = 'a'.repeat(32);
function req(path: string, cookie?: string, body?: unknown) {
  return new Request(`${origin}/api${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
function context(offlineScenario: OfflineScenario = 'proposal'): AgentServerContext {
  return { provider: 'cloudflare', model: CLOUDFLARE_MODEL, accountId,
    verifiedPeerAddress: '127.0.0.1', hashingKey: new Uint8Array(32).fill(23),
    quota: { enabled: true, priceBasis: 'synthetic', dailyBudgetMicros: 100_000_000, reservationTtlMs: 60_000 },
    offlineScenario, loadCredential: vi.fn(async () => placeholder) };
}
async function demo() {
  const response = await handleRequest(req('/demo', undefined, { scenario: 'normal' }));
  return { trip: await response.json(), cookie: response.headers.get('set-cookie')!.split(';')[0] };
}
function start(tripId: string) {
  return { threadId: tripId, runId: randomUUID(), messages: [{ id: randomUUID(), role: 'user', content: '請提出修改' }],
    state: {}, tools: [], context: [], forwardedProps: { baseVersion: 1 } };
}
async function consume(response: Response) {
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(text).not.toContain(placeholder);
  expect(text).not.toContain(accountId);
  expect(text).not.toMatch(/promptTokens|priceBasis|returnedModel|model-call-start/);
  return text;
}

test.each([true, false])('Cloudflare HTTP pace-only patch persists full requirements and awaits confirmation (%s) before cross-process resume', confirmed => withDatabase(async () => {
  const { trip, cookie } = await demo(); const selected = context();
  if (selected.provider === 'fixture') throw new Error('EXPECTED_PROVIDER');
  const base = structuredClone(trip.snapshot);
  expect(base.requirements.pace).not.toBe('relaxed');
  const expected = { ...base, requirements: { ...base.requirements, pace: 'relaxed' } };
  const read = async () => {
    const response = await handleRequest(req(`/trips/${trip.id}`, cookie));
    expect(response.status).toBe(200);
    return response.json();
  };
  const post = (body: unknown) => handleRequest(req(`/trips/${trip.id}/agent`, cookie, body), origin, selected);
  expect(await consume(await post(start(trip.id)))).toContain('"type":"interrupt"');
  expect(selected.loadCredential).toHaveBeenCalledOnce();
  const runs = (await (await handleRequest(req(`/trips/${trip.id}/runs`, cookie))).json()).runs;
  const run = runs[0]; expect(run.status).toBe('awaiting_confirmation');
  const beforeDecision = await read();
  expect(beforeDecision.version).toBe(1);
  expect(beforeDecision.snapshot).toEqual(base);
  const savedProposal = (await database().query('SELECT base_version,draft,status FROM proposals WHERE id=$1', [run.proposalId])).rows[0];
  expect(savedProposal.base_version).toBe(1);
  expect(savedProposal.status).toBe('pending');
  expect(savedProposal.draft.canApply).toBe(true);
  expect(savedProposal.draft.changes).toEqual([{ kind: 'requirements', value: expected.requirements }]);
  expect(savedProposal.draft.next).toEqual(expected);
  expect((await database().query('SELECT current_version FROM trips WHERE id=$1', [trip.id])).rows[0].current_version).toBe(1);
  const evidence = (await database().query('SELECT provider_evidence FROM model_calls')).rows;
  expect(evidence).toHaveLength(2);
  for (const row of evidence) expect(row.provider_evidence).toEqual({ provider: 'cloudflare',
    returnedModel: `${CLOUDFLARE_MODEL}-external`, priceBasis: 'cloudflare-gemma4-26b-2026-09-26' });
  const resume = { threadId: trip.id, runId: randomUUID(), messages: [], state: {}, tools: [], context: [], forwardedProps: { runId: run.id },
    resume: [{ interruptId: run.interruptId, status: 'resolved', payload: { confirmed } }] };
  expect(await consume(await post(resume))).toContain('"type":"success"');
  expect(selected.loadCredential).toHaveBeenCalledOnce();
  expect((await database().query('SELECT current_version FROM trips WHERE id=$1', [trip.id])).rows[0].current_version).toBe(confirmed ? 2 : 1);
  const reloaded = await read();
  expect(reloaded.version).toBe(confirmed ? 2 : 1);
  expect(reloaded.snapshot).toEqual(confirmed ? expected : base);
  const versions = (await database().query('SELECT version,snapshot FROM trip_versions WHERE trip_id=$1 ORDER BY version', [trip.id])).rows;
  expect(versions).toEqual([{ version: 1, snapshot: base }, ...(confirmed ? [{ version: 2, snapshot: expected }] : [])]);
  expect((await database().query('SELECT base_version,draft,status FROM proposals WHERE id=$1', [run.proposalId])).rows).toEqual([
    { ...savedProposal, status: confirmed ? 'applied' : 'rejected' },
  ]);
  const invocations = (await database().query('SELECT id,reservation_id,kind,prior_model_calls,provider,model,status,max_cost_micros FROM agent_invocations ORDER BY created_at')).rows;
  expect(invocations).toHaveLength(2);
  expect(invocations.every(row => row.provider === 'cloudflare' && row.model === CLOUDFLARE_MODEL && row.status === 'settled')).toBe(true);
  expect(invocations.map(row => ({ kind: row.kind, prior: row.prior_model_calls })))
    .toEqual([{ kind: 'start', prior: 0 }, { kind: 'resume', prior: 2 }]);
  expect(Number(invocations[1].max_cost_micros)).toBe(0);
  const reservations = (await database().query('SELECT id,max_cost_micros,actual_cost_micros,charged_cost_micros FROM quota_reservations')).rows;
  expect(reservations).toHaveLength(2);
  expect(reservations.every(row => row.actual_cost_micros !== null
    && Number(row.actual_cost_micros) === Number(row.charged_cost_micros))).toBe(true);
  expect(Number(reservations.find(row => row.id === invocations[0].reservation_id).actual_cost_micros)).toBeGreaterThan(0);
  expect(Number(reservations.find(row => row.id === invocations[1].reservation_id).actual_cost_micros)).toBe(0);
  expect(Number(reservations.find(row => row.id === invocations[1].reservation_id).max_cost_micros)).toBe(0);
  expect(await consume(await post(resume))).toContain('"type":"success"');
  expect(selected.loadCredential).toHaveBeenCalledOnce();
  expect(await read()).toEqual(reloaded);
  expect((await database().query('SELECT version,snapshot FROM trip_versions WHERE trip_id=$1 ORDER BY version', [trip.id])).rows).toEqual(versions);
  expect((await database().query('SELECT id FROM agent_invocations')).rows).toHaveLength(2);
  const calls = (await database().query('SELECT call_id,invocation_id FROM model_calls')).rows;
  expect(calls).toHaveLength(2);
  expect(calls.every(call => call.invocation_id === invocations[0].id)).toBe(true);
}), 45_000);

test('HTTP requirements remain full replacements while agent tools accept patches', () => withDatabase(async () => {
  const { trip, cookie } = await demo();
  const propose = (value: unknown) => handleRequest(req(`/trips/${trip.id}/proposals`, cookie,
    { baseVersion: 1, changes: [{ kind: 'requirements', value }] }));
  for (const patch of [{ pace: 'relaxed' }, {}]) {
    expect((await propose(patch)).status).toBe(400);
  }
  expect((await database().query('SELECT id FROM proposals WHERE trip_id=$1', [trip.id])).rows).toEqual([]);
  const requirements = { ...trip.snapshot.requirements, pace: 'relaxed' };
  const response = await propose(requirements);
  expect(response.status).toBe(200);
  const { proposalId, draft } = await response.json();
  expect(draft.canApply).toBe(true);
  expect(draft.changes).toEqual([{ kind: 'requirements', value: requirements }]);
  expect(draft.next).toEqual({ ...trip.snapshot, requirements });
  expect((await database().query('SELECT draft FROM proposals WHERE id=$1', [proposalId])).rows).toEqual([{ draft }]);
  const reloaded = await handleRequest(req(`/trips/${trip.id}`, cookie));
  expect(reloaded.status).toBe(200);
  expect(await reloaded.json()).toEqual(trip);
  expect((await database().query('SELECT version,snapshot FROM trip_versions WHERE trip_id=$1', [trip.id])).rows)
    .toEqual([{ version: 1, snapshot: trip.snapshot }]);
}));

test.each(['missing-usage', 'rate-limit'] as const)('Cloudflare HTTP %s keeps unknown cost reserved', scenario => withDatabase(async () => {
  const { trip, cookie } = await demo();
  const text = await consume(await handleRequest(req(`/trips/${trip.id}/agent`, cookie, start(trip.id)), origin, context(scenario)));
  expect(text).toContain('RUN_ERROR');
  const reservations = (await database().query('SELECT actual_cost_micros,charged_cost_micros FROM quota_reservations')).rows;
  expect(reservations).toHaveLength(1);
  expect(reservations[0].actual_cost_micros).toBeNull();
  expect(Number(reservations[0].charged_cost_micros)).toBe(maximumProviderModelCost('cloudflare'));
  const evidence = (await database().query('SELECT provider_evidence FROM model_calls')).rows;
  expect(evidence).toHaveLength(1);
  expect(evidence[0].provider_evidence).toEqual({ provider: 'cloudflare',
    returnedModel: scenario === 'rate-limit' ? null : `${CLOUDFLARE_MODEL}-external`, priceBasis: 'cloudflare-gemma4-26b-2026-09-26' });
}), 30_000);

test('Cloudflare accountId is server-only and rejected in HTTP input', () => withDatabase(async () => {
  const { trip, cookie } = await demo(); const selected = context();
  const response = await handleRequest(req(`/trips/${trip.id}/agent`, cookie, { ...start(trip.id), accountId }), origin, selected);
  expect(response.status).toBe(400);
  if (selected.provider === 'fixture') throw new Error('EXPECTED_PROVIDER');
  expect(selected.loadCredential).not.toHaveBeenCalled();
  expect((await database().query('SELECT id FROM agent_invocations')).rows).toEqual([]);
}));

test('invalid arguments traverse real worker/ADK/IPC to safe durable AG-UI error without retry or mutation', () => withDatabase(async () => {
  const { trip, cookie } = await demo();
  const selected = context('invalid-tool-arguments');
  const request = start(trip.id);
  const post = () => handleRequest(req(`/trips/${trip.id}/agent`, cookie, request), origin, selected);
  const text = await consume(await post());
  const events = text.split('\n').filter(line => line.startsWith('data: '))
    .map(line => EventSchemas.parse(JSON.parse(line.slice(6))));
  expect(events.filter(event => event.type === 'RUN_ERROR')).toEqual([
    expect.objectContaining({ code: 'AGENT_TOOL_ARGUMENTS' }),
  ]);
  expect(events.some(event => event.type === 'RUN_FINISHED' || event.type.startsWith('TOOL_CALL'))).toBe(false);
  expect(text).not.toMatch(/private_|invalid_value|unrecognized_keys|destinationId|"issues"/);
  const schema = (await database().query('SELECT current_schema() AS name')).rows[0].name;
  const privateEvents = (await database().query(`SELECT to_jsonb(t) AS data FROM "${schema}_adk"."events" t`)).rows;
  const saved = JSON.stringify(privateEvents);
  expect(saved).toContain('AGENT_TOOL_ARGUMENTS');
  expect(saved).toContain('invalid_value');
  expect(saved).toContain('destinationId');
  expect(saved).not.toMatch(/private_|function_call|functionCall/);
  expect((await database().query('SELECT current_version FROM trips WHERE id=$1', [trip.id])).rows[0].current_version).toBe(1);
  const runs = (await (await handleRequest(req(`/trips/${trip.id}/runs`, cookie))).json()).runs;
  expect(runs).toHaveLength(1);
  expect(runs[0]).toMatchObject({ status: 'failed', proposalId: null });
  const calls = (await database().query('SELECT status,usage FROM model_calls')).rows;
  expect(calls).toEqual([{ status: 'completed', usage: { promptTokens: 20, outputTokens: 8, totalTokens: 28 } }]);
  const reservations = (await database().query('SELECT actual_cost_micros,charged_cost_micros FROM quota_reservations')).rows;
  expect(reservations).toHaveLength(1);
  expect(Number(reservations[0].actual_cost_micros)).toBe(5);
  expect(Number(reservations[0].charged_cost_micros)).toBe(5);
  // Failed starts are not restartable: POST conflicts, GET replays saved events.
  expect((await post()).status).toBe(409);
  expect(await consume(await handleRequest(req(`/trips/${trip.id}/runs/${runs[0].id}/events`, cookie)))).toBe(text);
  expect((await database().query('SELECT call_id FROM model_calls')).rows).toHaveLength(1);
  expect((await database().query('SELECT id FROM agent_invocations')).rows).toHaveLength(1);
}), 30_000);
