import { randomUUID } from 'node:crypto';
import { expect, test, vi } from 'vitest';
import { EventSchemas } from '@ag-ui/core/schemas';
import { CLOUDFLARE_MODEL } from '../../src/agent/cloudflare-wire';
import { handleRequest } from '../../src/server/http';
import type { AgentServerContext } from '../../src/server/agent-policy';
import { maximumProviderModelCost } from '../../src/server/model-cost';
import { database } from '../../src/server/db';
import { withDatabase } from '../support/database';

type Provider = 'cloudflare' | 'openrouter';
const origin = 'http://127.0.0.1:4318';
const placeholder = 'offline-placeholder-not-a-credential';
const accountId = 'a'.repeat(32);
const openRouterModel = 'example/synthetic:free';
const privateMarkers = ['private_body_marker', 'private_header_marker', 'x-provider-debug'];

function req(path: string, cookie?: string, body?: unknown) {
  return new Request(`${origin}/api${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
function context(provider: Provider): Exclude<AgentServerContext, { provider: 'fixture' }> {
  return { provider, model: provider === 'cloudflare' ? CLOUDFLARE_MODEL : openRouterModel,
    ...(provider === 'cloudflare' ? { accountId } : {}),
    verifiedPeerAddress: '127.0.0.1', hashingKey: new Uint8Array(32).fill(23),
    quota: { enabled: true, priceBasis: 'synthetic', dailyBudgetMicros: 100_000_000, reservationTtlMs: 60_000 },
    offlineScenario: 'invalid-json', loadCredential: vi.fn(async () => placeholder) };
}
function assertPublic(text: string) {
  // Boolean assertions avoid dumping a response (including HTTP cookies) on
  // failure; diagnostics and provider/accounting details are private.
  for (const marker of [...privateMarkers, placeholder, accountId, CLOUDFLARE_MODEL, openRouterModel, 'body-json']) {
    expect(text.includes(marker), `public output must exclude ${marker}`).toBe(false);
  }
  expect(/"(?:provider|stage|httpStatus|error_message|error_code|usage|actual_cost_micros)"|promptTokens|priceBasis|returnedModel|providerEvidence|model-call-(?:start|usage)/.test(text)).toBe(false);
}
async function consume(response: Response, status = 200) {
  expect(response.status).toBe(status);
  assertPublic(JSON.stringify([...response.headers]));
  const text = await response.text();
  assertPublic(text);
  return text;
}

test.each(['cloudflare', 'openrouter'] as const)(
  '%s malformed JSON persists only a private stage and cannot restart or expose provider diagnostics', provider => withDatabase(async () => {
    // withDatabase owns a fresh random schema and its ADK companion. There is
    // no environment URL override, retained schema or live context here.
    const schema = (await database().query<{ name: string }>('SELECT current_schema() AS name')).rows[0].name;
    expect(schema).toMatch(/^test_[a-f0-9]{32}$/);
    const demo = await handleRequest(req('/demo', undefined, { scenario: 'normal' }));
    expect(demo.status).toBe(200);
    const trip = await demo.json();
    const cookie = demo.headers.get('set-cookie')!.split(';')[0];
    const base = structuredClone(trip.snapshot);
    const selected = context(provider);
    const request = { threadId: trip.id, runId: randomUUID(),
      messages: [{ id: randomUUID(), role: 'user', content: '請協助規劃行程' }],
      state: {}, tools: [], context: [], forwardedProps: { baseVersion: 1 } };
    const post = () => handleRequest(req(`/trips/${trip.id}/agent`, cookie, request), origin, selected);
    const stream = await consume(await post());
    expect(selected.loadCredential).toHaveBeenCalledOnce();
    const events = stream.split('\n').filter(line => line.startsWith('data: '))
      .map(line => EventSchemas.parse(JSON.parse(line.slice(6))));
    expect(events.map(event => event.type)).toEqual(['RUN_STARTED', 'CUSTOM', 'RUN_ERROR']);
    expect(events.filter(event => event.type === 'RUN_ERROR')).toEqual([{
      type: 'RUN_ERROR', code: 'AGENT_PROVIDER_ERROR', message: '執行未完整完成，請重新讀取行程確認已保存結果。',
    }]);
    expect(events.filter(event => event.type === 'CUSTOM')).toEqual([
      expect.objectContaining({ name: 'dive_trip.answer.v1', value: expect.objectContaining({
        body: expect.objectContaining({ kind: 'failure', committed: null }),
      }) }),
    ]);

    const readRuns = () => handleRequest(req(`/trips/${trip.id}/runs`, cookie));
    const projected = await consume(await readRuns());
    const { runs } = JSON.parse(projected);
    expect(runs).toHaveLength(1);
    const run = runs[0];
    expect(run).toMatchObject({ requestId: request.runId, status: 'failed', baseVersion: 1,
      proposalId: null, interruptId: null, decision: null });
    expect(run.events.map((saved: { event: unknown }) => saved.event)).toEqual(events);
    const readTrip = () => handleRequest(req(`/trips/${trip.id}`, cookie));
    expect(JSON.parse(await consume(await readTrip()))).toEqual(trip);

    // Explicit columns only: never fetch whole ADK events/sessions, prompts,
    // cookies, owner identities, session state, or quota IP/hash fields.
    const readState = async () => {
      const [trips, versions, proposals, invocations, calls, reservations, errors] = await Promise.all([
        database().query('SELECT current_version FROM trips WHERE id=$1', [trip.id]),
        database().query('SELECT version,snapshot FROM trip_versions WHERE trip_id=$1 ORDER BY version', [trip.id]),
        database().query('SELECT id FROM proposals WHERE trip_id=$1', [trip.id]),
        database().query(`SELECT id,run_id,reservation_id,kind,prior_model_calls,provider,model,account_id,status,max_cost_micros
          FROM agent_invocations ORDER BY id`),
        database().query('SELECT invocation_id,run_id,call_id,status,usage FROM model_calls ORDER BY call_id'),
        database().query('SELECT id,status,max_cost_micros,actual_cost_micros,charged_cost_micros FROM quota_reservations ORDER BY id'),
        database().query<{ error_code: string | null; error_message: string | null }>(`
          SELECT event_data::jsonb->>'error_code' AS error_code,event_data::jsonb->>'error_message' AS error_message
          FROM "${schema}_adk".events WHERE session_id=$1 AND app_name='dive_trip_fixture'
            AND (event_data::jsonb->>'error_code' IS NOT NULL OR event_data::jsonb->>'error_message' IS NOT NULL)
          ORDER BY timestamp,id LIMIT 2`, [run.id]),
      ]);
      return { trips: trips.rows, versions: versions.rows, proposals: proposals.rows, invocations: invocations.rows,
        calls: calls.rows, reservations: reservations.rows, errors: errors.rows };
    };
    const saved = await readState();
    expect(saved.errors).toHaveLength(1);
    expect(saved.errors[0].error_code).toBe('UNKNOWN_ERROR');
    expect(typeof saved.errors[0].error_message).toBe('string');
    expect(JSON.parse(saved.errors[0].error_message!)).toEqual({ code: 'AGENT_PROVIDER_ERROR', provider, stage: 'body-json' });
    for (const marker of [...privateMarkers, placeholder, accountId]) {
      expect(JSON.stringify(saved.errors).includes(marker), `private diagnostic must exclude ${marker}`).toBe(false);
    }
    expect(saved.trips).toEqual([{ current_version: 1 }]);
    expect(saved.versions).toEqual([{ version: 1, snapshot: base }]);
    expect(saved.proposals).toEqual([]);
    expect(saved.invocations).toHaveLength(1);
    const invocation = saved.invocations[0];
    expect(invocation).toMatchObject({ run_id: run.id, kind: 'start', prior_model_calls: 0, provider,
      model: selected.model, account_id: provider === 'cloudflare' ? accountId : null, status: 'settled' });
    const reserved = maximumProviderModelCost(provider);
    expect(reserved).toBeGreaterThan(0);
    expect(Number(invocation.max_cost_micros)).toBe(reserved);
    expect(saved.calls).toEqual([{ invocation_id: invocation.id, run_id: run.id, call_id: expect.any(String),
      status: 'completed', usage: null }]);
    expect(saved.reservations).toHaveLength(1);
    const reservation = saved.reservations[0];
    expect(reservation).toMatchObject({ id: invocation.reservation_id, status: 'settled', actual_cost_micros: null });
    expect(Number(reservation.max_cost_micros)).toBe(reserved);
    expect(Number(reservation.charged_cost_micros)).toBe(reserved);

    // Re-submit the identical start only to prove the 409 boundary. No resume,
    // fresh request ID, model retry, additional call or extra reservation.
    await consume(await post(), 409);
    expect(await consume(await handleRequest(req(`/trips/${trip.id}/runs/${run.id}/events`, cookie)))).toBe(stream);
    expect(await consume(await readRuns())).toBe(projected);
    expect(JSON.parse(await consume(await readTrip()))).toEqual(trip);
    expect(selected.loadCredential).toHaveBeenCalledOnce();
    expect(await readState()).toEqual(saved);
  }), 30_000);
