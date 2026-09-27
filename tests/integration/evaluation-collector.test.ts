import { randomBytes, randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { collectCase } from '../../evals/collector';
import { auditAcceptedAnswerUsage as auditUsage } from '../../evals/usage';
import { exportUsageEvidence, usageEvidenceSchema, type UsageEvidence } from '../../evals/usage-evidence';
import { buildReviewPacket } from '../../evals/review-packet';
import { withDatabase, testDatabaseUrl } from '../support/database';
import { database, makePool } from '../../src/server/db';
import { createSession } from '../../src/server/session';
import { createTrip } from '../../src/server/trip-store';
import { handleRequest } from '../../src/server/http';
import type { AgentServerContext } from '../../src/server/agent-policy';
import { maximumModelCost } from '../../src/server/model-cost';
import { GEMINI_MODEL } from '../../src/agent/model-id';

test('collector traverses HTTP admission, ADK confirmation and private persisted usage without live LLM', () => withDatabase(async () => {
  const owner = await createSession(); let tripId = '';
  const context: AgentServerContext = { provider: 'gemini', offlineScenario: 'proposal', verifiedPeerAddress: '127.0.0.1',
    hashingKey: randomBytes(32), quota: { enabled: true, priceBasis: 'synthetic', dailyBudgetMicros: maximumModelCost() * 2, reservationTtlMs: 60000 },
    loadCredential: async () => 'offline-placeholder-not-a-credential' };
  const result = await collectCase('free-afternoon', {
    model: GEMINI_MODEL,
    setup: async input => { const trip = await createTrip(owner.id, input.before); tripId = trip.id; return trip; },
    request: (path, body, signal) => handleRequest(new Request(`http://localhost${path}`, {
      method: body === undefined ? 'GET' : 'POST', headers: { cookie: `dive_trip_session=${owner.token}`, origin: 'http://localhost', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal,
    }), 'http://localhost', context),
    audit: runId => auditUsage(database(), owner.id, tripId, runId),
  });
  expect(result.evidence).toMatchObject({ beforeVersion: 1, beforeDecisionVersion: 1, afterVersion: 2,
    decision: 'accept', usageComplete: true, runStatus: 'succeeded', textReview: 'pending' });
  // The synthetic transport changes pace, not the requested free afternoon.
  // Verifies that completing the protocol does not masquerade as task success.
  expect(result.grade.reasons).toEqual(['GOAL_MISSED', 'TEXT_REVIEW_REQUIRED']);
  expect(result.evidence.modelCalls).toBeGreaterThan(0);
  expect(result.evidence.costMicros).not.toBeNull();
  const privateUsage = await exportUsageEvidence(database(), owner.id, tripId, result.evidence.runId);
  expect(privateUsage.invocations).toHaveLength(2);
  expect(privateUsage.calls).toHaveLength(result.evidence.modelCalls);
  expect(privateUsage.calls.every(call => call.usage !== null && call.status === 'completed')).toBe(true);
  expect(JSON.stringify(privateUsage)).not.toMatch(/offline-placeholder|dive_trip_session|promptText|hashingKey/);
  await expect(exportUsageEvidence(database(), randomUUID(), tripId, result.evidence.runId)).rejects.toThrow('EVAL_AUDIT_OWNER_MISMATCH');
  await expect(exportUsageEvidence(database(), owner.id, randomUUID(), result.evidence.runId)).rejects.toThrow('EVAL_AUDIT_OWNER_MISMATCH');
  const contaminated = structuredClone(privateUsage) as unknown as { calls: Array<{ usage: object | null; raw?: string }> };
  contaminated.calls[0].raw = 'synthetic-private-data';
  contaminated.calls[0].usage = { ...contaminated.calls[0].usage, secret: 'synthetic-private-data' };
  expect(JSON.stringify(usageEvidenceSchema.parse(contaminated))).not.toContain('synthetic-private-data');
  const wrongBinding = structuredClone(privateUsage);
  wrongBinding.calls[0].invocation_id = randomUUID();
  expect(() => usageEvidenceSchema.parse(wrongBinding)).toThrow('EVAL_USAGE_BINDING_INVALID');
}), 90_000);

test('failed usage evidence survives isolated DB cleanup without inventing known cost', async () => {
  let saved: UsageEvidence | undefined;
  await withDatabase(async () => {
    const owner = await createSession(); let tripId = '';
    const context: AgentServerContext = { provider: 'gemini', offlineScenario: 'rate-limit', verifiedPeerAddress: '127.0.0.1',
      hashingKey: randomBytes(32), quota: { enabled: true, priceBasis: 'synthetic', dailyBudgetMicros: maximumModelCost() * 2, reservationTtlMs: 60000 },
      loadCredential: async () => 'offline-placeholder-not-a-credential' };
    const result = await collectCase('ambiguous', { model: GEMINI_MODEL,
      setup: async input => { const trip = await createTrip(owner.id, input.before); tripId = trip.id; return trip; },
      request: (path, body, signal) => handleRequest(new Request(`http://localhost${path}`, {
        method: body === undefined ? 'GET' : 'POST', headers: { cookie: `dive_trip_session=${owner.token}`, origin: 'http://localhost', 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body), signal,
      }), 'http://localhost', context),
      audit: runId => auditUsage(database(), owner.id, tripId, runId),
    });
    expect(result.evidence).toMatchObject({ runStatus: 'failed', usageComplete: false, costMicros: null });
    saved = JSON.parse(JSON.stringify(await exportUsageEvidence(database(), owner.id, tripId, result.evidence.runId)));
    const packet = buildReviewPacket({ schemaVersion: 2, model: GEMINI_MODEL, transport: 'real-gemini-via-http-handler',
      budgetMicros: maximumModelCost() * 2, chargedMicros: maximumModelCost(), stopped: 'UNKNOWN_USAGE_STOP',
      textReview: 'pending', evaluationGatePassed: false, records: [
        { round: 1, caseId: 'ambiguous', outcome: 'failed', ...result },
        { round: 1, caseId: 'ambiguous', kind: 'durable-audit',
          runs: [{ id: result.evidence.runId, status: 'failed', proposal_id: null, interrupt_id: null, decision: null }],
          events: result.events.map((event, sequence) => ({ run_id: result.evidence.runId, sequence, event })), chargedMicros: maximumModelCost(),
          privateUsage: [saved], privateUsageComplete: true },
      ] });
    expect(packet.cases[0].privateUsageExportComplete).toBe(true);
    expect(packet.evaluationGatePassed).toBe(false);
  });
  // DB schema has been removed. The serialized evidence still has the unknown call.
  expect(saved?.calls).toHaveLength(1);
  expect(saved?.calls[0]).toMatchObject({ status: 'completed', usage: null });
  expect(saved?.invocations[0]).toMatchObject({ status: 'settled', actual_cost_micros: null,
    charged_cost_micros: String(maximumModelCost()) });
  expect(saved?.calls[0].started_at).toMatch(/^\d{4}-/);
  const publicPool = makePool(testDatabaseUrl());
  try {
    await expect(exportUsageEvidence(publicPool, randomUUID(), randomUUID(), randomUUID())).rejects.toThrow('EVAL_TEST_SCHEMA_REQUIRED');
  } finally { await publicPool.end(); }
}, 60_000);
