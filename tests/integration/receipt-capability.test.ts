import { randomUUID } from 'node:crypto';
import { expect, test, vi } from 'vitest';
import { CLOUDFLARE_MODEL } from '../../src/agent/cloudflare-wire';
import { GEMINI_MODEL } from '../../src/agent/model-id';
import type { AgentServerContext } from '../../src/server/agent-policy';
import { database } from '../../src/server/db';
import { handleRequest } from '../../src/server/http';
import { withDatabase } from '../support/database';

const origin = 'http://127.0.0.1:4318';
function req(path: string, cookie?: string, body?: unknown) {
  return new Request(`${origin}/api${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function consume(response: Response) {
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(text).not.toMatch(/offline-placeholder|promptTokens|model-call-start|providerAccountId/);
  return text;
}

for (const provider of ['gemini', 'openrouter', 'cloudflare'] as const) {
  test.each([true, false])(`${provider}: confirmation %s has no credential or model-budget dependency`, confirmed => withDatabase(async () => {
    const created = await handleRequest(req('/demo', undefined, { scenario: 'normal' }));
    expect(created.status).toBe(200);
    const trip = await created.json(), cookie = created.headers.get('set-cookie')!.split(';')[0];
    const loadCredential = vi.fn(async () => 'offline-placeholder-not-a-credential');
    const context: Exclude<AgentServerContext, { provider: 'fixture' }> = {
      provider, model: provider === 'gemini' ? GEMINI_MODEL : provider === 'cloudflare' ? CLOUDFLARE_MODEL : 'example/synthetic:free',
      ...(provider === 'cloudflare' ? { accountId: 'a'.repeat(32) } : {}),
      verifiedPeerAddress: '127.0.0.1', hashingKey: new Uint8Array(32).fill(23),
      quota: { enabled: true, priceBasis: 'synthetic', dailyBudgetMicros: 100_000_000, reservationTtlMs: 60_000 },
      offlineScenario: 'proposal', loadCredential,
    };
    const post = (body: unknown) => handleRequest(req(`/trips/${trip.id}/agent`, cookie, body), origin, context);
    expect(await consume(await post({ threadId: trip.id, runId: randomUUID(),
      messages: [{ id: randomUUID(), role: 'user', content: '請提出修改' }], state: {}, tools: [], context: [],
      forwardedProps: { baseVersion: 1 } }))).toContain('"type":"interrupt"');
    expect(loadCredential).toHaveBeenCalledTimes(1);
    const calls = (await database().query('SELECT call_id,invocation_id,usage FROM model_calls ORDER BY call_id')).rows;
    expect(calls).toHaveLength(2);
    const charged = Number((await database().query('SELECT SUM(charged_cost_micros) AS cost FROM quota_reservations')).rows[0].cost);
    if (provider !== 'openrouter') expect(charged).toBeGreaterThan(1);

    // Existing reference cost now exceeds the generation budget for paid-price
    // synthetic adapters. A deterministic receipt still needs invocation/rate
    // admission, but must not load credentials or reserve generation funds.
    if (context.quota.enabled) context.quota.dailyBudgetMicros = 1;
    loadCredential.mockRejectedValue(new Error('CREDENTIAL_UNAVAILABLE_AFTER_PROPOSAL'));
    const run = (await (await handleRequest(req(`/trips/${trip.id}/runs`, cookie))).json()).runs[0];
    const resume = { threadId: trip.id, runId: randomUUID(), messages: [], state: {}, tools: [], context: [],
      forwardedProps: { runId: run.id },
      resume: [{ interruptId: run.interruptId, status: 'resolved', payload: { confirmed } }] };
    const text = await consume(await post(resume));
    expect(text).toContain('"type":"success"');
    expect(text).toContain(`"status":"${confirmed ? 'applied' : 'rejected'}"`);
    expect(loadCredential).toHaveBeenCalledTimes(1);
    expect((await database().query('SELECT current_version FROM trips WHERE id=$1', [trip.id])).rows[0].current_version)
      .toBe(confirmed ? 2 : 1);
    const receipt = (await database().query(`SELECT i.status,i.provider,i.model,i.max_cost_micros,
      q.max_cost_micros AS reserved,q.actual_cost_micros,q.charged_cost_micros
      FROM agent_invocations i JOIN quota_reservations q ON q.id=i.reservation_id WHERE i.kind='resume'`)).rows;
    expect(receipt).toHaveLength(1);
    expect(receipt[0]).toMatchObject({ status: 'settled', provider, model: context.model });
    for (const field of ['max_cost_micros', 'reserved', 'actual_cost_micros', 'charged_cost_micros']) {
      expect(Number(receipt[0][field])).toBe(0);
    }
    const replay = await consume(await handleRequest(req(`/trips/${trip.id}/runs/${run.id}/events`, cookie)));
    expect(replay).toContain(text);
    expect(await consume(await post(resume))).toBe(replay);
    expect(loadCredential).toHaveBeenCalledTimes(1);
    expect((await database().query('SELECT call_id,invocation_id,usage FROM model_calls ORDER BY call_id')).rows).toEqual(calls);
    expect((await database().query('SELECT id FROM agent_invocations')).rows).toHaveLength(2);
  }), 45_000);
}
