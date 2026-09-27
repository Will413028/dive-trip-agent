import { createHash, randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { auditUsage } from '../../evals/usage';
import { exportUsageEvidence, usageEvidenceSchema } from '../../evals/usage-evidence';
import { CLOUDFLARE_MODEL, CLOUDFLARE_PRICE_BASIS } from '../../src/agent/cloudflare-wire';
import { accountModelCall, admitStart, settleAdmission } from '../../src/server/agent-admission';
import { database } from '../../src/server/db';
import { finishRun } from '../../src/server/run-store';
import { createSession } from '../../src/server/session';
import { createTrip } from '../../src/server/trip-store';
import { withDatabase } from '../support/database';
import { makeSnapshot } from '../support/domain-fixtures';
import { recordSimpleAnswer, startAnswerPhase } from './p3-fixtures';

const binding = { provider: 'cloudflare', model: CLOUDFLARE_MODEL, accountId: 'a'.repeat(32) } as const;
const usage = { promptTokens: 20, outputTokens: 8, totalTokens: 28 };
const providerEvidence = { provider: 'cloudflare', returnedModel: `${CLOUDFLARE_MODEL}-external`, priceBasis: CLOUDFLARE_PRICE_BASIS } as const;

async function setup(known = true) {
  const owner = await createSession();
  const trip = await createTrip(owner.id, makeSnapshot());
  const input = { ownerId: owner.id, tripId: trip.id, ipKey: createHash('sha256').update('synthetic-eval').digest('hex'),
    requestId: randomUUID(), message: 'synthetic', baseVersion: 1, maxCostMicros: 7, now: new Date(),
    policy: { enabled: true, priceBasis: 'synthetic', dailyBudgetMicros: 100, reservationTtlMs: 60_000 } as const, ...binding };
  const admitted = await admitStart(input);
  await accountModelCall(owner.id, trip.id, admitted.admission.id, { kind: 'model-call-start', callId: 'synthetic-call' });
  await accountModelCall(owner.id, trip.id, admitted.admission.id, { kind: 'model-call-usage', callId: 'synthetic-call',
    usage: known ? usage : null, providerEvidence });
  await settleAdmission(admitted.admission.id, known ? 5 : null);
  await startAnswerPhase(owner.id, trip.id, admitted.run.id);
  await recordSimpleAnswer(owner.id, trip.id, admitted.run.id);
  await finishRun(owner.id, trip.id, admitted.run.id, { status: 'succeeded' });
  return { owner, trip, admitted, input };
}

test.each([true, false])('Cloudflare eval SQL exports known=%s evidence with strict account binding', known => withDatabase(async () => {
  const { owner, trip, admitted } = await setup(known);
  expect(await auditUsage(database(), owner.id, trip.id, admitted.run.id, binding)).toEqual({
    model: CLOUDFLARE_MODEL, runId: admitted.run.id, complete: known, modelCalls: 1, costMicros: known ? 5 : null,
  });
  const evidence = await exportUsageEvidence(database(), owner.id, trip.id, admitted.run.id, binding);
  expect(evidence).toMatchObject({ schemaVersion: 2, binding,
    invocations: [{ reservation_id: admitted.admission.reservationId, actual_cost_micros: known ? '5' : null,
      charged_cost_micros: known ? '5' : '7', logical_run_id: admitted.run.id }],
    calls: [{ invocation_id: admitted.admission.id, usage: known ? usage : null }] });
  expect(usageEvidenceSchema.parse(JSON.parse(JSON.stringify(evidence)))).toEqual(evidence);
  expect(JSON.stringify(evidence)).not.toContain(owner.token);
  await expect(auditUsage(database(), owner.id, trip.id, admitted.run.id, { ...binding, accountId: 'b'.repeat(32) }))
    .rejects.toThrow('EVAL_USAGE_BINDING_INVALID');
  await expect(exportUsageEvidence(database(), owner.id, trip.id, admitted.run.id))
    .rejects.toThrow('EVAL_USAGE_BINDING_INVALID');
  await expect(exportUsageEvidence(database(), randomUUID(), trip.id, admitted.run.id, binding))
    .rejects.toThrow('EVAL_AUDIT_OWNER_MISMATCH');
}));

test('audit finds a call whose run_id was moved away but invocation still belongs to the target run', () => withDatabase(async () => {
  const { owner, trip, admitted, input } = await setup();
  const other = await admitStart({ ...input, requestId: randomUUID(), now: new Date() });
  // Deliberately inconsistent references only inside this disposable test schema.
  await database().query('UPDATE model_calls SET run_id=$1 WHERE invocation_id=$2', [other.run.id, admitted.admission.id]);
  await expect(auditUsage(database(), owner.id, trip.id, admitted.run.id, binding)).rejects.toThrow('EVAL_USAGE_BINDING_INVALID');
  await expect(exportUsageEvidence(database(), owner.id, trip.id, admitted.run.id, binding)).rejects.toThrow('EVAL_USAGE_BINDING_INVALID');
}));
