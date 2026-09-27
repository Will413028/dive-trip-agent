import { expect, test, vi } from 'vitest';
import { catalog, createDemo, demoScenarios, type DemoScenario } from '../../src/server/demo';
import { handleRequest } from '../../src/server/http';
import { database } from '../../src/server/db';
import { createSession } from '../../src/server/session';
import { createTrip, getTrip } from '../../src/server/trip-store';
import { buildProposal } from '../../src/domain/proposal';
import { parseSnapshot } from '../../src/domain/snapshot';
import type { ProposalDraft, TripView } from '../../src/domain/types';
import { withDatabase } from '../support/database';

const origin = 'http://127.0.0.1:4318';
function request(path: string, body?: unknown, cookie?: string) {
  return new Request(`${origin}/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function demo(scenario: DemoScenario, existingCookie?: string) {
  const response = await handleRequest(request('/demo', { scenario }, existingCookie));
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const cookie = existingCookie ?? response.headers.get('set-cookie')!.split(';')[0];
  return { trip: await response.json() as TripView, cookie };
}

test.each(demoScenarios)('%s creates a valid owned snapshot and round-trips', scenario => withDatabase(async () => {
  const { trip, cookie } = await demo(scenario);
  expect(parseSnapshot(trip.snapshot)).toEqual(trip.snapshot);
  expect(trip.version).toBe(1);
  expect(trip.budget).toEqual({ knownMinor: 430000, unknownEntryIds: [], withinBudget: true });
  expect(trip.snapshot.entries.find(entry => entry.id === 'stay')!.locked).toBe(scenario === 'budget-conflict');
  expect(await (await handleRequest(request(`/trips/${trip.id}`, undefined, cookie))).json()).toEqual(trip);
  expect((await handleRequest(request(`/trips/${trip.id}`))).status).toBe(404);
}));

test('repeated demos preserve existing trips and isolate owners and mutations', () => withDatabase(async () => {
  const a = await demo('normal'), b = await demo('normal');
  const conflict = await demo('budget-conflict', a.cookie);
  const lookup = await demo('lookup-failure', a.cookie);
  const again = await demo('budget-conflict', a.cookie);
  expect(new Set([a, b, conflict, lookup, again].map(value => value.trip.id)).size).toBe(5);
  for (const value of [a, b, conflict, lookup, again]) {
    expect(await (await handleRequest(request(`/trips/${value.trip.id}`, undefined, value.cookie))).json()).toEqual(value.trip);
  }
  expect((await handleRequest(request(`/trips/${conflict.trip.id}`, undefined, b.cookie))).status).toBe(404);
  expect((await handleRequest(request(`/trips/${conflict.trip.id}/proposals`, {
    baseVersion: 1, changes: [],
  }, b.cookie))).status).toBe(404);
  const proposal = await handleRequest(request(`/trips/${lookup.trip.id}/proposals`, {
    baseVersion: 1, changes: [{ kind: 'remove', entryId: 'transfer' }],
  }, a.cookie));
  const { proposalId } = await proposal.json();
  expect((await handleRequest(request(`/trips/${lookup.trip.id}/apply`, {
    baseVersion: 1, proposalId, requestId: 'isolated-demo-change',
  }, a.cookie))).status).toBe(200);
  for (const value of [a, b, conflict, again]) {
    expect(await (await handleRequest(request(`/trips/${value.trip.id}`, undefined, value.cookie))).json()).toEqual(value.trip);
  }
}));

test('budget conflict remains a blocked proposal; locked stay and valid version survive', () => withDatabase(async () => {
  const { trip, cookie } = await demo('budget-conflict');
  const changes = [{ kind: 'requirements', value: { ...trip.snapshot.requirements, budgetMinor: 250000 } }];
  const response = await handleRequest(request(`/trips/${trip.id}/proposals`, { baseVersion: 1, changes }, cookie));
  expect(response.status).toBe(200);
  const { proposalId, draft } = await response.json() as { proposalId: string; draft: ProposalDraft };
  expect(draft.canApply).toBe(false);
  expect(draft.issues).toContainEqual(expect.objectContaining({ code: 'BUDGET_EXCEEDED' }));
  expect(draft.next.entries).toEqual(trip.snapshot.entries);
  expect((await handleRequest(request(`/trips/${trip.id}/apply`, {
    baseVersion: 1, proposalId, requestId: 'blocked-budget',
  }, cookie))).status).toBe(400);
  expect(await (await handleRequest(request(`/trips/${trip.id}`, undefined, cookie))).json()).toEqual(trip);
  const removal = buildProposal(trip.snapshot, [{ kind: 'remove', entryId: 'stay' }], catalog(), 'agent');
  expect(removal.canApply).toBe(false);
  expect(removal.issues).toContainEqual(expect.objectContaining({ code: 'LOCKED_ENTRY' }));
  const owner = await createSession();
  await expect(createTrip(owner.id, draft.next)).rejects.toMatchObject({ code: 'INVALID_SNAPSHOT' });
  expect((await database().query('SELECT * FROM trip_versions WHERE trip_id=$1', [trip.id])).rowCount).toBe(1);
}));

test('lookup-failure only creates a fixture trip, never invokes or binds a provider', () => withDatabase(async () => {
  const loadCredential = vi.fn(async () => { throw new Error('must not load credentials'); });
  const response = await handleRequest(request('/demo', { scenario: 'lookup-failure' }), origin, {
    provider: 'gemini', liveLocal: true, verifiedPeerAddress: '127.0.0.1', hashingKey: new Uint8Array(32),
    quota: { enabled: true, dailyBudgetMicros: 100, priceBasis: 'server-verified', reservationTtlMs: 60000 },
    loadCredential,
  });
  expect(response.status).toBe(200);
  expect(loadCredential).not.toHaveBeenCalled();
  for (const table of ['agent_runs', 'agent_invocations', 'model_calls', 'quota_reservations']) {
    expect((await database().query(`SELECT * FROM ${table}`)).rowCount).toBe(0);
  }
  const owner = await createSession();
  const trip = await createDemo(owner.id, 'lookup-failure');
  expect(await getTrip(owner.id, trip.id)).toEqual(trip);
}));

test.each([
  {}, { scenario: 'unknown' }, { scenario: null },
  { scenario: 'normal', ownerId: 'forged' },
  { scenario: 'lookup-failure', provider: 'gemini' },
  { scenario: 'lookup-failure', offlineScenario: 'hang' },
  { scenario: 'lookup-failure', fault: true },
  { scenario: 'budget-conflict', snapshot: {} },
])('offline: demo rejects invalid scenario or injected controls %j before database writes', async body => {
  const response = await handleRequest(request('/demo', body));
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: 'INVALID_REQUEST' });
  expect(response.headers.get('set-cookie')).toBeNull();
});

test('offline: direct creator rejects unsupported scenario before database access', async () => {
  await expect(createDemo('unused', 'hang' as DemoScenario)).rejects.toThrow('UNKNOWN_SCENARIO');
});
