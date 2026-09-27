import { createHash, randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { database } from '../../src/server/db';
import { createSession } from '../../src/server/session';
import { createTrip } from '../../src/server/trip-store';
import { accountModelCall, admitResume, admitStart, getAdmissionUsage, settleAdmission, settleRejectedToolArguments, type AdmitStartInput } from '../../src/server/agent-admission';
import { withDatabase } from '../support/database';
import { makeSnapshot } from '../support/domain-fixtures';
import { awaitConfirmation } from './p3-fixtures';

import { CLOUDFLARE_MODEL, CLOUDFLARE_PRICE_BASIS } from '../../src/agent/cloudflare-wire';
const model = CLOUDFLARE_MODEL;
const accountId = 'a'.repeat(32);
const otherModel = '@cf/other/model';
const policy = { enabled: true as const, priceBasis: 'synthetic' as const, dailyBudgetMicros: 100, reservationTtlMs: 60_000 };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const usage = { promptTokens: 20, outputTokens: 8, totalTokens: 28 };
const evidence = { provider: 'cloudflare', returnedModel: `${model}-external`, priceBasis: CLOUDFLARE_PRICE_BASIS } as const;

test.each(['complete', 'account', 'model', 'evidence', 'missing'] as const)(
  'Cloudflare tool rejection %s rechecks binding and evidence inside settlement', mode => withDatabase(async () => {
    const input = await setup(); const first = await admitStart(input);
    await accountModelCall(input.ownerId, input.tripId, first.admission.id, { kind: 'model-call-start', callId: 'call' });
    await accountModelCall(input.ownerId, input.tripId, first.admission.id,
      { kind: 'model-call-usage', callId: 'call', usage, providerEvidence: evidence });
    if (mode === 'account') await database().query('UPDATE agent_invocations SET account_id=$1 WHERE id=$2', ['b'.repeat(32), first.admission.id]);
    if (mode === 'model' || mode === 'evidence') await database().query('UPDATE model_calls SET provider_evidence=$1::jsonb',
      [JSON.stringify({ ...evidence, ...(mode === 'model' ? { returnedModel: '@cf/wrong/model' } : { priceBasis: 'wrong' }) })]);
    if (mode === 'missing') await database().query('UPDATE model_calls SET provider_evidence=NULL');
    expect(await settleRejectedToolArguments(first.admission)).toMatchObject(mode === 'complete'
      ? { actualCostMicros: 5, chargedCostMicros: 5 } : { actualCostMicros: null, chargedCostMicros: 7 });
  }));

async function setup(): Promise<AdmitStartInput> {
  const owner = await createSession(); const trip = await createTrip(owner.id, makeSnapshot());
  return { ownerId: owner.id, tripId: trip.id, ipKey: hash('cloudflare'), requestId: randomUUID(), message: 'synthetic', baseVersion: 1,
    maxCostMicros: 7, now: new Date(), policy, provider: 'cloudflare', model, accountId };
}

test('Cloudflare admission stores private evidence, settles reference usage, and forbids provider/model switching', () => withDatabase(async () => {
  const input = await setup(); const first = await admitStart(input);
  expect(first.admission).toMatchObject({ provider: 'cloudflare', model, accountId, priorModelCalls: 0 });
  expect((await database().query('SELECT provider,model,account_id FROM agent_invocations')).rows[0]).toEqual({ provider: 'cloudflare', model, account_id: accountId });
  await accountModelCall(input.ownerId, input.tripId, first.admission.id, { kind: 'model-call-start', callId: 'cloudflare-call' });
  await accountModelCall(input.ownerId, input.tripId, first.admission.id,
    { kind: 'model-call-usage', callId: 'cloudflare-call', usage, providerEvidence: evidence });
  await expect(getAdmissionUsage(input.ownerId, input.tripId, first.admission.id)).resolves.toMatchObject({
    provider: 'cloudflare', model, complete: true, hasUnknownUsage: false,
    calls: [{ providerEvidence: evidence }],
  });
  expect(await settleAdmission(first.admission.id, 5)).toMatchObject({ actualCostMicros: 5, chargedCostMicros: 5 });
  await awaitConfirmation(input.ownerId, input.tripId, first.run.id, undefined, 'offline-gate');
  const resume = { ownerId: input.ownerId, tripId: input.tripId, ipKey: input.ipKey, maxCostMicros: 0,
    now: new Date(), policy: input.policy, provider: input.provider, model: input.model, accountId: input.accountId, runId: first.run.id,
    interruptId: 'offline-gate', confirmed: true };
  await expect(admitResume({ ...resume, accountId: 'b'.repeat(32) }))
    .rejects.toMatchObject({ code: 'PROVIDER_CONFLICT' });
  const resumed = await admitResume(resume);
  expect(resumed).toMatchObject({ admission: { provider: 'cloudflare', model, accountId } });
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

test('Cloudflare admission rejects missing or invalid accounts and persists database constraints', () => withDatabase(async () => {
  const input = await setup();
  for (const invalid of [undefined, '', 'A'.repeat(32), 'a'.repeat(31), 'a'.repeat(33), `${accountId}\n`, '../account']) {
    await expect(admitStart({ ...input, accountId: invalid })).rejects.toMatchObject({ code: 'PROVIDER_CONFLICT' });
  }
  expect((await database().query('SELECT id FROM agent_invocations')).rows).toEqual([]);
  expect((await database().query('SELECT id FROM quota_reservations')).rows).toEqual([]);
  const first = await admitStart(input);
  await expect(admitStart({ ...input, accountId: 'b'.repeat(32) })).rejects.toMatchObject({ code: 'PROVIDER_CONFLICT' });
  for (const invalid of [null, '', 'A'.repeat(32), 'a'.repeat(31), `${accountId}\n`]) {
    await expect(database().query('UPDATE agent_invocations SET account_id=$1 WHERE id=$2', [invalid, first.admission.id]))
      .rejects.toMatchObject({ code: '23514' });
  }
  await expect(database().query("UPDATE agent_invocations SET provider='gemini',model='gemini-3.1-flash-lite' WHERE id=$1", [first.admission.id]))
    .rejects.toMatchObject({ code: '23514' });
}));

test.each(['gemini', 'openrouter', 'cloudflare'] as const)('%s payload hashes preserve historical binding except for Cloudflare account', provider => withDatabase(async () => {
  const input = { ...await setup(), provider,
    model: provider === 'cloudflare' ? model : provider === 'gemini' ? 'gemini-3.1-flash-lite' : 'example/synthetic:free',
    accountId: provider === 'cloudflare' ? accountId : undefined };
  const first = await admitStart(input);
  if (provider === 'cloudflare') expect(first.admission.accountId).toBe(accountId);
  else expect(first.admission).not.toHaveProperty('accountId');
  const binding = provider === 'cloudflare' ? [provider, input.model, accountId] : [provider, input.model];
  const expected = (payload: unknown[]) => hash(JSON.stringify([...binding, ...payload]));
  expect((await database().query('SELECT payload_hash FROM quota_reservations WHERE id=$1', [first.admission.reservationId])).rows[0].payload_hash)
    .toBe(expected(['start', input.tripId, input.requestId, input.message, input.baseVersion]));
  await settleAdmission(first.admission.id, 0);
  await awaitConfirmation(input.ownerId, input.tripId, first.run.id, undefined, 'hash-gate');
  const resumed = await admitResume({ ownerId: input.ownerId, tripId: input.tripId, ipKey: input.ipKey,
    maxCostMicros: 0, now: new Date(), policy, provider, model: input.model, accountId: input.accountId,
    runId: first.run.id, interruptId: 'hash-gate', confirmed: true });
  expect((await database().query('SELECT payload_hash FROM quota_reservations WHERE id=$1', [resumed.admission.reservationId])).rows[0].payload_hash)
    .toBe(expected(['resume', first.run.id, 'hash-gate', true]));
  if (provider !== 'cloudflare') {
    await expect(admitStart({ ...input, accountId })).rejects.toMatchObject({ code: 'PROVIDER_CONFLICT' });
    await expect(database().query('UPDATE agent_invocations SET account_id=$1 WHERE id=$2', [accountId, first.admission.id]))
      .rejects.toMatchObject({ code: '23514' });
  }
}));

test('Cloudflare missing usage remains unknown instead of settling the reservation to zero', () => withDatabase(async () => {
  const input = await setup(); const first = await admitStart(input);
  await accountModelCall(input.ownerId, input.tripId, first.admission.id, { kind: 'model-call-start', callId: 'unknown-cloudflare-call' });
  await accountModelCall(input.ownerId, input.tripId, first.admission.id,
    { kind: 'model-call-usage', callId: 'unknown-cloudflare-call', usage: null });
  await expect(getAdmissionUsage(input.ownerId, input.tripId, first.admission.id)).resolves.toMatchObject({
    provider: 'cloudflare', complete: true, hasUnknownUsage: true,
  });
  await expect(settleAdmission(first.admission.id, 0)).resolves.toMatchObject({ actualCostMicros: null, chargedCostMicros: 7 });
}));

test('Cloudflare rejects foreign evidence and additive reasoning before settlement', () => withDatabase(async () => {
  const input = await setup(); const first = await admitStart(input);
  await accountModelCall(input.ownerId, input.tripId, first.admission.id, { kind: 'model-call-start', callId: 'guarded-call' });
  const event = { kind: 'model-call-usage' as const, callId: 'guarded-call', usage };
  for (const providerEvidence of [
    { provider: 'openrouter' as const, generationId: 'gen', returnedModel: 'example/synthetic', reportedCostMicros: 0 },
    { ...evidence, returnedModel: '@cf/other/model' },
  ]) {
    await expect(accountModelCall(input.ownerId, input.tripId, first.admission.id, { ...event, providerEvidence }))
      .rejects.toMatchObject({ code: 'INVALID_MODEL_USAGE' });
  }
  await expect(accountModelCall(input.ownerId, input.tripId, first.admission.id,
    { ...event, usage: { ...usage, totalTokens: 30, thoughtTokens: 2 }, providerEvidence: evidence }))
    .rejects.toMatchObject({ code: 'INVALID_MODEL_USAGE' });
  expect((await getAdmissionUsage(input.ownerId, input.tripId, first.admission.id)).hasUnknownUsage).toBe(true);
}));
