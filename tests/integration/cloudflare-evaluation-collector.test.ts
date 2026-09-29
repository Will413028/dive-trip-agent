import { randomBytes, randomUUID } from 'node:crypto';
import { expect, test, vi } from 'vitest';
import cases from '../../evals/cases.json';
import { collectCase } from '../../evals/collector';
import { evaluationInput } from '../../evals/fixtures';
import { auditAcceptedAnswerUsage as auditUsage } from '../../evals/usage';
import { exportUsageEvidence, usageEvidenceSchema, type EvaluationUsageBinding } from '../../evals/usage-evidence';
import { CLOUDFLARE_MODEL } from '../../src/agent/cloudflare-wire';
import { credential, validateAgentContext, type AgentServerContext } from '../../src/server/agent-policy';
import { database } from '../../src/server/db';
import { handleRequest } from '../../src/server/http';
import { maximumProviderModelCost } from '../../src/server/model-cost';
import { createSession } from '../../src/server/session';
import { createTrip, getTrip } from '../../src/server/trip-store';
import { withDatabase } from '../support/database';

const binding = { provider: 'cloudflare', model: CLOUDFLARE_MODEL, accountId: 'a'.repeat(32) } as const satisfies EvaluationUsageBinding;
type ProviderContext = Exclude<AgentServerContext, { provider: 'fixture' }>;
type SyntheticContext = ProviderContext & { quota: Extract<ProviderContext['quota'], { enabled: true }> };
function context(caseId = 'free-afternoon'): SyntheticContext {
  const fixture = evaluationInput(caseId);
  return { ...binding, offlineScenario: 'proposal',
    verifiedPeerAddress: '127.0.0.1', hashingKey: randomBytes(32),
    quota: { enabled: true, priceBasis: 'synthetic', dailyBudgetMicros: maximumProviderModelCost('cloudflare') * 2,
      reservationTtlMs: 60_000 }, loadCredential: vi.fn(async () => 'offline-placeholder-not-a-credential'),
    evaluation: { catalog: fixture.catalog, lookupTimeout: fixture.fault === 'catalog-timeout' } };
}
function request(ownerToken: string, tripId: string, body: unknown) {
  return new Request(`http://localhost/api/trips/${tripId}/agent`, { method: 'POST',
    headers: { cookie: `dive_trip_session=${ownerToken}`, origin: 'http://localhost', 'content-type': 'application/json' },
    body: JSON.stringify(body) });
}
function start(tripId: string) {
  return { threadId: tripId, runId: randomUUID(), messages: [{ id: randomUUID(), role: 'user', content: '合成案例' }],
    state: {}, tools: [], context: [], forwardedProps: { baseVersion: 1 } };
}
async function expectNoAdmission() {
  const counts = await database().query(`SELECT
    (SELECT count(*)::int FROM agent_runs) AS runs,
    (SELECT count(*)::int FROM agent_invocations) AS invocations,
    (SELECT count(*)::int FROM quota_reservations) AS reservations,
    (SELECT count(*)::int FROM model_calls) AS calls`);
  expect(counts.rows[0]).toEqual({ runs: 0, invocations: 0, reservations: 0, calls: 0 });
}

// Three representative inputs from the existing ten-case manifest. No live
// campaign is enabled here; synthetic protocol checks are not quality passes.
const representativeCases = cases.filter(spec => ['free-afternoon', 'source-injection', 'lookup-timeout'].includes(spec.id));
test.each(representativeCases)('Cloudflare collector preserves isolated fixture $id and private binding', spec => withDatabase(async () => {
  const owner = await createSession();
  const fixture = evaluationInput(spec.id);
  let tripId = '';
  let agentPosts = 0;
  const publicPayloads: string[] = [];
  const selected = context(spec.id);
  const result = await collectCase(fixture.caseId, {
    model: CLOUDFLARE_MODEL, faultSupported: true,
    setup: async input => {
      selected.evaluation = { catalog: input.catalog, lookupTimeout: input.fault === 'catalog-timeout' };
      const trip = await createTrip(owner.id, input.before); tripId = trip.id; return trip;
    },
    request: async (path, body, signal) => {
      if (path.endsWith('/agent')) agentPosts++;
      const response = await handleRequest(new Request(`http://localhost${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { cookie: `dive_trip_session=${owner.token}`, origin: 'http://localhost', 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body), signal,
      }), 'http://localhost', selected);
      publicPayloads.push(await response.clone().text());
      return response;
    },
    audit: runId => auditUsage(database(), owner.id, tripId, runId, binding),
  });
  const proposed = spec.terminal === 'proposal';
  const sourceProposal = spec.id === 'source-injection';
  expect(agentPosts).toBe(proposed ? 2 : 1);
  expect(result.evidence).toMatchObject({ beforeVersion: 1, beforeDecisionVersion: 1, afterVersion: proposed ? 2 : 1,
    runStatus: sourceProposal ? 'awaiting_confirmation' : 'succeeded', decision: proposed ? 'accept' : 'none', textReview: 'pending',
    model: CLOUDFLARE_MODEL, usageComplete: true });
  expect(result.evidence.beforeDecision).toEqual(fixture.before);
  if (!proposed) expect(result.evidence.after).toEqual(fixture.before);
  expect(result.grade.pass).toBe(false);
  expect(result.grade.reasons).toContain('TEXT_REVIEW_REQUIRED');
  if (fixture.fault) {
    expect(result.evidence.faultObserved).toBe('catalog-timeout');
    expect(result.evidence.modelCalls).toBe(2);
    expect(result.evidence).toMatchObject({ toolCount: 2, visibleToolCount: 1 });
    expect(result.events.filter(event => event.type === 'TOOL_CALL_START').map(event => event.toolCallName))
      .toEqual(['find_items']);
  }
  if (sourceProposal) {
    // Deliberately generic fake-model proposal on a read-only fixture: the
    // collector must not approve it or claim semantic success. Its persisted
    // proposal catalog must still retain this fixture's untrusted source text.
    expect(result.grade.reasons).toContain('UNEXPECTED_SIDE_EFFECT');
    expect(result.grade.reasons).toContain('RUN_NOT_SUCCEEDED');
  }
  const serializedPublic = publicPayloads.join('\n');
  expect(serializedPublic).not.toContain(binding.accountId);
  expect(serializedPublic).not.toContain('offline-placeholder-not-a-credential');
  expect(serializedPublic).not.toMatch(/promptTokens|priceBasis|returnedModel|provider_evidence|hashingKey|CATALOG_TIMEOUT|nativeToolCalls|faultObserved/);
  const proposals = await database().query('SELECT catalog_snapshot FROM proposals WHERE trip_id=$1', [tripId]);
  expect(proposals.rows).toHaveLength(proposed || sourceProposal ? 1 : 0);
  // RED confirmed the previous Cloudflare branch persisted the normal demo
  // catalog instead of these three explicit evaluation items.
  if (proposed || sourceProposal) expect(proposals.rows[0].catalog_snapshot).toEqual(fixture.catalog);
  const privateUsage = await exportUsageEvidence(database(), owner.id, tripId, result.evidence.runId, binding);
  expect(privateUsage).toMatchObject({ schemaVersion: 2, binding, runId: result.evidence.runId });
  expect(privateUsage.invocations).toHaveLength(agentPosts);
  expect(privateUsage.calls).toHaveLength(result.evidence.modelCalls);
  expect(privateUsage.calls.every(call => call.status === 'completed' && call.usage !== null)).toBe(true);
  expect(result.evidence.costMicros).toBeGreaterThan(0);
  expect(privateUsage.invocations.reduce((sum, row) => sum + Number(row.actual_cost_micros), 0)).toBe(result.evidence.costMicros);
  expect(usageEvidenceSchema.parse(privateUsage)).toEqual(privateUsage);
  expect(JSON.stringify(privateUsage)).not.toMatch(/offline-placeholder|dive_trip_session|promptText|hashingKey/);
  if (spec.id === 'free-afternoon') {
    // Generic synthetic proposal changes pace; protocol success is not goal success.
    expect(result.grade.reasons).toContain('GOAL_MISSED');
    await expect(exportUsageEvidence(database(), randomUUID(), tripId, result.evidence.runId, binding))
      .rejects.toThrow('EVAL_AUDIT_OWNER_MISMATCH');
    await expect(exportUsageEvidence(database(), owner.id, tripId, result.evidence.runId,
      { ...binding, accountId: 'b'.repeat(32) })).rejects.toThrow();
  }
}), 90_000);

test('Cloudflare evaluation rejects non-test schema before credentials or admission', () => withDatabase(async () => {
  const owner = await createSession();
  const fixture = evaluationInput('lookup-timeout');
  const trip = await createTrip(owner.id, fixture.before);
  const selected = context('lookup-timeout');
  const campaign: ProviderContext = { ...selected, liveLocal: true, offlineScenario: undefined,
    quota: { ...selected.quota, priceBasis: 'server-verified' },
    evaluation: { catalog: fixture.catalog, lookupTimeout: true, liveCampaign: 'cloudflare-30-cases' } };
  const grounded: ProviderContext = { ...campaign,
    evaluation: { ...campaign.evaluation!, liveCampaign: 'cloudflare-grounded-30-cases' } };
  const nonthinking: ProviderContext = { ...campaign,
    evaluation: { ...campaign.evaluation!, liveCampaign: 'cloudflare-nonthinking-one-case' } };
  const diagnostic: ProviderContext = { ...campaign,
    evaluation: { ...campaign.evaluation!, liveCampaign: 'cloudflare-diagnostic-30-cases' } };
  const probe: ProviderContext = { ...campaign,
    evaluation: { ...campaign.evaluation!, liveCampaign: 'cloudflare-probe-one-case' } };
  const pool = database();
  // All data stays in the helper's disposable test schema. Only the schema
  // metadata query is spoofed; no production schema is opened or modified.
  const scopes = ['public', 'workbench_live', 'test_demo', `test_${'a'.repeat(32)}\n`];
  for (const candidate of [selected, campaign, grounded, nonthinking, diagnostic, probe]) for (const scope of scopes) {
    const original = pool.query;
    const query = vi.spyOn(pool, 'query').mockImplementation((...args: unknown[]) => {
      if (args[0] === 'SELECT current_schema() AS name') return Promise.resolve({ rows: [{ name: scope }],
        command: 'SELECT', rowCount: 1, oid: 0, fields: [] });
      return Reflect.apply(original, pool, args);
    });
    try {
      const response = await handleRequest(request(owner.token, trip.id, start(trip.id)), 'http://localhost', candidate);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'SERVICE_UNAVAILABLE' });
    } finally { query.mockRestore(); }
    expect(candidate.loadCredential).not.toHaveBeenCalled();
    await expectNoAdmission();
  }
  expect((await getTrip(owner.id, trip.id))?.snapshot).toEqual(fixture.before);
}));

test('HTTP cannot supply evaluation catalog, faults or provider selectors', () => withDatabase(async () => {
  const owner = await createSession();
  const fixture = evaluationInput('ambiguous');
  const trip = await createTrip(owner.id, fixture.before);
  const selected = context('ambiguous');
  const payload = start(trip.id);
  const overrides = [
    ...Object.entries({ provider: 'cloudflare', model: CLOUDFLARE_MODEL, accountId: binding.accountId,
      apiKey: 'synthetic-forged-key', evaluation: { catalog: fixture.catalog, lookupTimeout: true },
      catalog: fixture.catalog, lookupTimeout: true, offlineScenario: 'proposal', liveCampaign: 'cloudflare-30-cases' })
      .map(([key, value]) => ({ field: `top-level.${key}`, body: { ...payload, [key]: value } })),
    { field: 'evaluation.liveCampaign', body: { ...payload, evaluation: { catalog: fixture.catalog, lookupTimeout: true, liveCampaign: 'cloudflare-30-cases' } } },
    { field: 'forwardedProps.evaluation.lookupTimeout', body: { ...payload, forwardedProps: { baseVersion: 1, evaluation: { lookupTimeout: true } } } },
    { field: 'forwardedProps.liveCampaign', body: { ...payload, forwardedProps: { baseVersion: 1, liveCampaign: 'cloudflare-30-cases' } } },
    { field: 'forwardedProps.evaluation.liveCampaign', body: { ...payload, forwardedProps: { baseVersion: 1, evaluation: { liveCampaign: 'cloudflare-30-cases' } } } },
    { field: 'state.lookupTimeout', body: { ...payload, state: { lookupTimeout: true } } },
    { field: 'state.liveCampaign', body: { ...payload, state: { liveCampaign: 'cloudflare-30-cases' } } },
    { field: 'state.evaluation.liveCampaign', body: { ...payload, state: { evaluation: { liveCampaign: 'cloudflare-30-cases' } } } },
    { field: 'context', body: { ...payload, context: [{ description: 'override', value: 'lookupTimeout=true' }] } },
    { field: 'grounded.liveCampaign', body: { ...payload, liveCampaign: 'cloudflare-grounded-30-cases' } },
    { field: 'grounded.evaluation', body: { ...payload, evaluation: { liveCampaign: 'cloudflare-grounded-30-cases' } } },
    { field: 'grounded.forwardedProps', body: { ...payload, forwardedProps: { baseVersion: 1, liveCampaign: 'cloudflare-grounded-30-cases' } } },
    { field: 'nonthinking.liveCampaign', body: { ...payload, liveCampaign: 'cloudflare-nonthinking-one-case' } },
    { field: 'nonthinking.evaluation', body: { ...payload, evaluation: { liveCampaign: 'cloudflare-nonthinking-one-case' } } },
    { field: 'nonthinking.forwardedProps', body: { ...payload, forwardedProps: { baseVersion: 1, liveCampaign: 'cloudflare-nonthinking-one-case' } } },
    { field: 'diagnostic.liveCampaign', body: { ...payload, liveCampaign: 'cloudflare-diagnostic-30-cases' } },
    { field: 'diagnostic.evaluation', body: { ...payload, evaluation: { liveCampaign: 'cloudflare-diagnostic-30-cases' } } },
    { field: 'diagnostic.forwardedProps', body: { ...payload, forwardedProps: { baseVersion: 1, liveCampaign: 'cloudflare-diagnostic-30-cases' } } },
    { field: 'probe.liveCampaign', body: { ...payload, liveCampaign: 'cloudflare-probe-one-case' } },
    { field: 'probe.evaluation', body: { ...payload, evaluation: { liveCampaign: 'cloudflare-probe-one-case' } } },
    { field: 'probe.forwardedProps', body: { ...payload, forwardedProps: { baseVersion: 1, liveCampaign: 'cloudflare-probe-one-case' } } },
  ];
  for (const { field, body } of overrides) {
    const response = await handleRequest(request(owner.token, trip.id, body), 'http://localhost', selected);
    expect(response.status, `${field} must be rejected before admission`).toBe(400);
    expect(selected.loadCredential, `${field} must not load credentials`).not.toHaveBeenCalled();
    await expectNoAdmission();
  }
}));

test('context-only: Cloudflare live evaluation rejects before key while Gemini stays compatible', async () => {
  const selected = context();
  expect(() => validateAgentContext(selected)).not.toThrow();
  const live: ProviderContext = { ...selected, offlineScenario: undefined, liveLocal: true,
    quota: { ...selected.quota, priceBasis: 'server-verified' } };
  await expect(Promise.resolve().then(() => {
    validateAgentContext(live);
    return credential(live, new AbortController().signal);
  })).rejects.toThrow('AGENT_POLICY_DISABLED');
  expect(live.loadCredential).not.toHaveBeenCalled();
  expect(() => validateAgentContext({ ...selected, quota: { ...selected.quota, priceBasis: 'server-verified' } }))
    .toThrow('AGENT_POLICY_DISABLED');
  expect(() => validateAgentContext({ ...selected, provider: 'openrouter', model: 'example/synthetic:free', accountId: undefined }))
    .toThrow('AGENT_POLICY_DISABLED');
  expect(() => validateAgentContext({ ...selected, provider: 'gemini', model: undefined, accountId: undefined })).not.toThrow();
  expect(() => validateAgentContext({ ...selected, provider: 'gemini', model: undefined, accountId: undefined,
    offlineScenario: undefined, liveLocal: true, quota: { ...selected.quota, priceBasis: 'server-verified' } })).not.toThrow();
});

test.each(['cloudflare-grounded-30-cases', 'cloudflare-nonthinking-one-case', 'cloudflare-diagnostic-30-cases',
  'cloudflare-probe-one-case', 'cloudflare-probe-2-one-case'] as const)(
  '%s is retired before credentials and admission even in a test schema', marker => withDatabase(async () => {
  const owner = await createSession(), fixture = evaluationInput('unknown-cost');
  const trip = await createTrip(owner.id, fixture.before);
  const selected = context('unknown-cost');
  const loadCredential = vi.fn(async (): Promise<string> => { throw new Error('SYNTHETIC_DENY_NO_REAL_CREDENTIAL'); });
  const live: ProviderContext = { ...selected, liveLocal: true, offlineScenario: undefined,
    quota: { ...selected.quota, priceBasis: 'server-verified' }, loadCredential };
  for (const liveCampaign of [undefined, 'cloudflare-30-cases'] as const) {
    const candidate = { ...live, evaluation: { catalog: fixture.catalog, lookupTimeout: false, liveCampaign } };
    const response = await handleRequest(request(owner.token, trip.id, start(trip.id)), 'http://localhost', candidate);
    expect(response.status).toBe(503); expect(loadCredential).not.toHaveBeenCalled(); await expectNoAdmission();
  }
  const grounded: ProviderContext = { ...live,
    evaluation: { catalog: fixture.catalog, lookupTimeout: false, liveCampaign: marker } };
  const response = await handleRequest(request(owner.token, trip.id, start(trip.id)), 'http://localhost', grounded);
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: 'SERVICE_UNAVAILABLE' });
  expect(loadCredential).not.toHaveBeenCalled();
  await expectNoAdmission();
  expect((await getTrip(owner.id, trip.id))?.snapshot).toEqual(fixture.before);
}));
