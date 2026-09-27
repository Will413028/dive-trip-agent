import { randomUUID } from 'node:crypto';
import { expect, test, vi } from 'vitest';
import { handleRequest } from '../../src/server/http';
import { database } from '../../src/server/db';
import type { AgentServerContext } from '../../src/server/agent-policy';
import { CLOUDFLARE_MODEL } from '../../src/agent/cloudflare-wire';
import { maximumProviderModelCost } from '../../src/server/model-cost';
import { withDatabase } from '../support/database';

test('changing Cloudflare accounts cannot resume or apply a saved proposal', () => withDatabase(async () => {
  const origin = 'http://127.0.0.1:4318';
  let cookie = '';
  const req = (path: string, body?: unknown) => new Request(`${origin}/api${path}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { origin, cookie, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const demo = await handleRequest(req('/demo', { scenario: 'normal' }));
  cookie = demo.headers.get('set-cookie')!.split(';')[0];
  const trip = await demo.json();
  const firstLoader = vi.fn(async () => 'offline-placeholder-not-a-credential');
  const context: Exclude<AgentServerContext, { provider: 'fixture' }> = {
    provider: 'cloudflare', model: CLOUDFLARE_MODEL, accountId: 'a'.repeat(32),
    verifiedPeerAddress: '127.0.0.1', hashingKey: new Uint8Array(32).fill(24),
    quota: { enabled: true, priceBasis: 'synthetic', dailyBudgetMicros: maximumProviderModelCost('cloudflare') * 10, reservationTtlMs: 60000 },
    offlineScenario: 'proposal', loadCredential: firstLoader,
  };
  const base = { threadId: trip.id, runId: randomUUID(), state: {}, tools: [], context: [] };
  const startBody = { ...base,
    messages: [{ id: randomUUID(), role: 'user', content: 'Synthetic proposal' }], forwardedProps: { baseVersion: 1 } };
  const start = await handleRequest(req(`/trips/${trip.id}/agent`, startBody), origin, context);
  expect(await start.text()).toContain('"type":"interrupt"');
  const runs = await (await handleRequest(req(`/trips/${trip.id}/runs`))).json();
  const run = runs.runs[0];
  const resume = { ...base, runId: randomUUID(), messages: [], forwardedProps: { runId: run.id },
    resume: [{ interruptId: run.interruptId, status: 'resolved', payload: { confirmed: true } }] };
  const wrongLoader = vi.fn(async () => 'offline-placeholder-not-a-credential');
  const wrongStart = await handleRequest(req(`/trips/${trip.id}/agent`, startBody), origin,
    { ...context, accountId: 'b'.repeat(32), loadCredential: wrongLoader });
  expect(wrongStart.status).toBe(409);
  expect(await wrongStart.text()).toContain('PROVIDER_CONFLICT');
  const wrong = await handleRequest(req(`/trips/${trip.id}/agent`, resume), origin,
    { ...context, accountId: 'b'.repeat(32), loadCredential: wrongLoader });
  expect(wrong.status).toBe(409);
  expect(await wrong.text()).toContain('PROVIDER_CONFLICT');
  expect(wrongLoader).not.toHaveBeenCalled();
  expect((await database().query('SELECT account_id FROM agent_invocations')).rows).toEqual([{ account_id: context.accountId }]);
  expect((await database().query('SELECT id FROM quota_reservations')).rows).toHaveLength(1);
  expect((await database().query('SELECT current_version FROM trips WHERE id=$1', [trip.id])).rows[0].current_version).toBe(1);
  // The same account binding can resume without consulting a replacement loader.
  const replacementLoader = vi.fn(async () => 'offline-placeholder-not-a-credential');
  const accepted = await handleRequest(req(`/trips/${trip.id}/agent`, resume), origin,
    { ...context, loadCredential: replacementLoader });
  expect(await accepted.text()).toContain('"type":"success"');
  expect(replacementLoader).not.toHaveBeenCalled();
  expect(firstLoader).toHaveBeenCalledOnce();
  expect((await database().query('SELECT account_id FROM agent_invocations')).rows).toEqual([
    { account_id: context.accountId }, { account_id: context.accountId },
  ]);
  expect((await database().query('SELECT current_version FROM trips WHERE id=$1', [trip.id])).rows[0].current_version).toBe(2);
}), 45_000);
