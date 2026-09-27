import { randomUUID } from 'node:crypto';
import { expect, test, vi } from 'vitest';
import { handleRequest } from '../../src/server/http';
import type { AgentServerContext } from '../../src/server/agent-policy';
import { database } from '../../src/server/db';
import { withDatabase } from '../support/database';

const origin = 'http://127.0.0.1:4318';
const placeholder = 'offline-placeholder-not-a-credential';
const model = 'example/synthetic:free';
function req(path: string, cookie?: string, body?: unknown) {
  return new Request(`${origin}/api${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
function context(): AgentServerContext {
  return { provider: 'openrouter', model, verifiedPeerAddress: '127.0.0.1', hashingKey: new Uint8Array(32).fill(23),
    quota: { enabled: true, priceBasis: 'synthetic', dailyBudgetMicros: 100, reservationTtlMs: 60_000 },
    offlineScenario: 'proposal', loadCredential: vi.fn(async () => placeholder) };
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
  expect(text).not.toMatch(/promptTokens|generation-offline|model-call-start/);
  return text;
}

test('OpenRouter offline HTTP/AG-UI path preserves confirmation, resume binding and private evidence', () => withDatabase(async () => {
  const { trip, cookie } = await demo(); const selected = context(); const initial = start(trip.id);
  if (selected.provider === 'fixture') throw new Error('EXPECTED_PROVIDER');
  expect(await (await handleRequest(req('/agent-mode'), origin, selected)).json()).toEqual({ mode: 'openrouter' });
  expect(await consume(await handleRequest(req(`/trips/${trip.id}/agent`, cookie, initial), origin, selected))).toContain('"type":"interrupt"');
  expect(selected.loadCredential).toHaveBeenCalledOnce();
  const runs = (await (await handleRequest(req(`/trips/${trip.id}/runs`, cookie))).json()).runs;
  const run = runs[0]; expect(run.status).toBe('awaiting_confirmation');
  expect((await database().query('SELECT provider,model FROM agent_invocations')).rows).toEqual([{ provider: 'openrouter', model }]);
  const calls = (await database().query('SELECT call_id,invocation_id,provider_evidence FROM model_calls ORDER BY call_id')).rows;
  expect(calls).toHaveLength(2);
  expect(calls.every(row => row.provider_evidence?.provider === 'openrouter')).toBe(true);
  const resume = { threadId: trip.id, runId: randomUUID(), messages: [], state: {}, tools: [], context: [], forwardedProps: { runId: run.id },
    resume: [{ interruptId: run.interruptId, status: 'resolved', payload: { confirmed: true } }] };
  expect(await consume(await handleRequest(req(`/trips/${trip.id}/agent`, cookie, resume), origin, selected))).toContain('"type":"success"');
  expect(selected.loadCredential).toHaveBeenCalledOnce();
  const invocations = (await database().query('SELECT id,kind,prior_model_calls,provider,model,status,max_cost_micros FROM agent_invocations ORDER BY created_at')).rows;
  expect(invocations).toHaveLength(2); expect(invocations.every(row => row.provider === 'openrouter' && row.model === model && row.status === 'settled')).toBe(true);
  expect(invocations.map(row => ({ kind: row.kind, prior: row.prior_model_calls })))
    .toEqual([{ kind: 'start', prior: 0 }, { kind: 'resume', prior: 2 }]);
  expect(Number(invocations[1].max_cost_micros)).toBe(0);
  expect(calls.every(call => call.invocation_id === invocations[0].id)).toBe(true);
  expect((await database().query('SELECT call_id,invocation_id,provider_evidence FROM model_calls ORDER BY call_id')).rows).toEqual(calls);
  expect((await database().query('SELECT actual_cost_micros FROM quota_reservations')).rows.every(row => row.actual_cost_micros === '0' || row.actual_cost_micros === 0)).toBe(true);
  expect(await consume(await handleRequest(req(`/trips/${trip.id}/agent`, cookie, resume), origin, selected))).toContain('"type":"success"');
  expect(selected.loadCredential).toHaveBeenCalledOnce();
  expect((await database().query('SELECT call_id,invocation_id,provider_evidence FROM model_calls ORDER BY call_id')).rows).toEqual(calls);
  expect((await database().query('SELECT id FROM agent_invocations')).rows).toHaveLength(2);
}), 30_000);
