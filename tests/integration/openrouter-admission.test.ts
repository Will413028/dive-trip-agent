import { createHash, randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { database } from '../../src/server/db';
import { createSession } from '../../src/server/session';
import { createTrip } from '../../src/server/trip-store';
import { accountModelCall, admitResume, admitStart, getAdmissionUsage, settleAdmission, type AdmitStartInput } from '../../src/server/agent-admission';
import { withDatabase } from '../support/database';
import { makeSnapshot } from '../support/domain-fixtures';
import { awaitConfirmation } from './p3-fixtures';

const model = 'example/synthetic:free';
const otherModel = 'example/other:free';
const policy = { enabled: true as const, priceBasis: 'synthetic' as const, dailyBudgetMicros: 100, reservationTtlMs: 60_000 };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const usage = { promptTokens: 20, outputTokens: 8, totalTokens: 28 };
const evidence = { provider: 'openrouter' as const, generationId: 'generation-offline', returnedModel: 'example/synthetic', reportedCostMicros: 0 };

async function setup(): Promise<AdmitStartInput> {
  const owner = await createSession(); const trip = await createTrip(owner.id, makeSnapshot());
  return { ownerId: owner.id, tripId: trip.id, ipKey: hash('openrouter'), requestId: randomUUID(), message: 'synthetic', baseVersion: 1,
    maxCostMicros: 7, now: new Date(), policy, provider: 'openrouter', model };
}

test('OpenRouter admission stores private evidence, settles free usage to zero, and forbids provider/model switching', () => withDatabase(async () => {
  const input = await setup(); const first = await admitStart(input);
  expect(first.admission).toMatchObject({ provider: 'openrouter', model, priorModelCalls: 0 });
  expect((await database().query('SELECT provider,model FROM agent_invocations')).rows[0]).toEqual({ provider: 'openrouter', model });
  await accountModelCall(input.ownerId, input.tripId, first.admission.id, { kind: 'model-call-start', callId: 'openrouter-call' });
  await accountModelCall(input.ownerId, input.tripId, first.admission.id,
    { kind: 'model-call-usage', callId: 'openrouter-call', usage, providerEvidence: evidence });
  await expect(getAdmissionUsage(input.ownerId, input.tripId, first.admission.id)).resolves.toMatchObject({
    provider: 'openrouter', model, complete: true, hasUnknownUsage: false,
    calls: [{ providerEvidence: evidence }],
  });
  expect(await settleAdmission(first.admission.id, 0)).toMatchObject({ actualCostMicros: 0, chargedCostMicros: 0 });
  await awaitConfirmation(input.ownerId, input.tripId, first.run.id, undefined, 'offline-gate');
  const resume = { ownerId: input.ownerId, tripId: input.tripId, ipKey: input.ipKey, maxCostMicros: 0,
    now: new Date(), policy: input.policy, provider: input.provider, model: input.model, runId: first.run.id,
    interruptId: 'offline-gate', confirmed: true };
  const resumed = await admitResume(resume);
  expect(resumed).toMatchObject({ admission: { provider: 'openrouter', model } });
  await expect(accountModelCall(input.ownerId, input.tripId, resumed.admission.id, { kind: 'model-call-start', callId: 'forbidden' }))
    .rejects.toMatchObject({ code: 'MODEL_GENERATION_DISABLED' });
  await expect(accountModelCall(input.ownerId, input.tripId, resumed.admission.id,
    { kind: 'model-call-usage', callId: 'forbidden', usage, providerEvidence: evidence }))
    .rejects.toMatchObject({ code: 'MODEL_GENERATION_DISABLED' });
  await expect(admitResume({ ...resume, provider: 'gemini', model: 'gemini-3.1-flash-lite' }))
    .rejects.toMatchObject({ code: 'PROVIDER_CONFLICT' });
  await expect(admitResume({ ...resume, model: otherModel }))
    .rejects.toMatchObject({ code: 'PROVIDER_CONFLICT' });
}));

test('OpenRouter missing usage remains unknown instead of settling the reservation to zero', () => withDatabase(async () => {
  const input = await setup(); const first = await admitStart(input);
  await accountModelCall(input.ownerId, input.tripId, first.admission.id, { kind: 'model-call-start', callId: 'unknown-openrouter-call' });
  await accountModelCall(input.ownerId, input.tripId, first.admission.id,
    { kind: 'model-call-usage', callId: 'unknown-openrouter-call', usage: null });
  await expect(getAdmissionUsage(input.ownerId, input.tripId, first.admission.id)).resolves.toMatchObject({
    provider: 'openrouter', complete: true, hasUnknownUsage: true,
  });
  await expect(settleAdmission(first.admission.id, 0)).resolves.toMatchObject({ actualCostMicros: null, chargedCostMicros: 7 });
}));
