import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, test } from 'vitest';
import { database } from '../../src/server/db';
import { loadMigrations, migrate } from '../../src/server/migrate';
import { createSession } from '../../src/server/session';
import { createTrip } from '../../src/server/trip-store';
import { getRun, startRun } from '../../src/server/run-store';
import { reserveRun, settleRun, type QuotaPolicy } from '../../src/server/quota';
import { accountModelCall, admitStart, admitResume, getAdmissionUsage, getRunProvider,
  settleAdmission, settleRejectedToolArguments, type AdmitStartInput } from '../../src/server/agent-admission';
import { withDatabase } from '../support/database';
import { makeSnapshot } from '../support/domain-fixtures';
import { awaitConfirmation } from './p3-fixtures';

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const policy: QuotaPolicy = { enabled: true, priceBasis: 'synthetic', dailyBudgetMicros: 100_000, reservationTtlMs: 60_000 };
const usage = { promptTokens: 10, outputTokens: 5, totalTokens: 15 };

test.each(['complete', 'empty', 'started', 'null', 'invalid', 'binding', 'old', 'expired', 'foreign-run', 'foreign-evidence', 'aborted', 'elapsed'] as const)(
  'tool rejection settlement %s uses locked evidence and preserves unknown/history', mode => withDatabase(async () => {
    const input = await setup(); const result = await admitStart(input);
    const hook = (event: Parameters<typeof accountModelCall>[3]) => accountModelCall(input.ownerId, input.tripId, result.admission.id, event);
    if (mode !== 'empty') await hook({ kind: 'model-call-start', callId: 'call' });
    if (!['empty', 'started'].includes(mode)) await hook({ kind: 'model-call-usage', callId: 'call', usage: mode === 'null' ? null : usage });
    if (mode === 'invalid') await database().query("UPDATE model_calls SET usage='{}'::jsonb");
    if (mode === 'foreign-evidence') await database().query('UPDATE model_calls SET provider_evidence=$1::jsonb',
      [JSON.stringify({ provider: 'openrouter', generationId: 'synthetic', returnedModel: 'synthetic/model', reportedCostMicros: 0 })]);
    if (mode === 'foreign-run') {
      const other = await admitStart(await setup());
      await database().query('UPDATE model_calls SET run_id=$1 WHERE invocation_id=$2', [other.run.id, result.admission.id]);
    }
    if (mode === 'old') await settleAdmission(result.admission.id, null);
    if (mode === 'expired') await database().query("UPDATE agent_invocations SET status='expired' WHERE id=$1", [result.admission.id]);
    if (mode === 'elapsed') await database().query("UPDATE agent_invocations SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [result.admission.id]);
    const expected = mode === 'binding' ? { ...result.admission, reservationId: randomUUID() } : result.admission;
    if (mode === 'old' || mode === 'expired') {
      await expect(settleRejectedToolArguments(expected)).rejects.toMatchObject({ code: 'ADMISSION_NOT_ACTIVE' });
      const saved = (await database().query('SELECT actual_cost_micros,charged_cost_micros FROM quota_reservations WHERE id=$1', [result.admission.reservationId])).rows[0];
      expect(saved.actual_cost_micros).toBeNull();
      expect(Number(saved.charged_cost_micros)).toBe(100);
    } else expect(await settleRejectedToolArguments(expected, mode === 'aborted' ? AbortSignal.abort() : undefined)).toMatchObject(mode === 'complete'
      ? { actualCostMicros: 10, chargedCostMicros: 10 }
      : { actualCostMicros: null, chargedCostMicros: 100 });
  }));
async function setup(): Promise<AdmitStartInput> {
  const owner = await createSession();
  const trip = await createTrip(owner.id, makeSnapshot());
  return { ownerId: owner.id, tripId: trip.id, ipKey: hash('peer'), requestId: randomUUID(),
    message: 'offline synthetic', baseVersion: 1, maxCostMicros: 100, now: new Date(), policy };
}
async function counts() {
  return (await database().query(`SELECT (SELECT count(*)::int FROM agent_runs) AS runs,
    (SELECT count(*)::int FROM quota_reservations) AS reservations,
    (SELECT count(*)::int FROM agent_invocations) AS invocations`)).rows[0];
}

test('tool rejection rechecks cancellation after a real invocation lock wait', () => withDatabase(async () => {
  const input = await setup(); const first = await admitStart(input);
  await accountModelCall(input.ownerId, input.tripId, first.admission.id, { kind: 'model-call-start', callId: 'call' });
  await accountModelCall(input.ownerId, input.tripId, first.admission.id, { kind: 'model-call-usage', callId: 'call', usage });
  const client = await database().connect(); const abort = new AbortController();
  let work: Promise<unknown> | undefined;
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM agent_invocations WHERE id=$1 FOR UPDATE', [first.admission.id]);
    const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    work = expect(settleRejectedToolArguments(first.admission, abort.signal))
      .resolves.toMatchObject({ actualCostMicros: null, chargedCostMicros: 100 });
    let blocked = false;
    for (let i = 0; i < 50; i++) {
      if ((await database().query('SELECT 1 FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))', [pid])).rowCount) {
        blocked = true; break;
      }
      await delay(10);
    }
    expect(blocked).toBe(true);
    abort.abort();
    await client.query('COMMIT');
    await work;
  } finally {
    await client.query('ROLLBACK'); client.release();
    await work;
  }
}));
async function pending(input: AdmitStartInput, runId: string) {
  await awaitConfirmation(input.ownerId, input.tripId, runId);
}
function resumeInput(input: AdmitStartInput, runId: string) {
  return { ownerId: input.ownerId, tripId: input.tripId, ipKey: input.ipKey, policy: input.policy,
    maxCostMicros: 0, now: new Date(), runId, interruptId: 'gate', confirmed: true };
}

test('model transition preserves history but rejects old-model resume and accounting', () => withDatabase(async () => {
  const input = await setup();
  const first = await admitStart(input);
  expect((await database().query('SELECT model FROM agent_invocations WHERE id=$1', [first.admission.id])).rows[0].model)
    .toBe('gemini-3.1-flash-lite');
  await database().query("UPDATE agent_invocations SET model='gemini-2.5-flash' WHERE id=$1", [first.admission.id]);
  await expect(admitStart(input)).rejects.toMatchObject({ code: 'PROVIDER_CONFLICT' });
  await expect(accountModelCall(input.ownerId, input.tripId, first.admission.id, { kind: 'model-call-start', callId: 'legacy' }))
    .rejects.toMatchObject({ code: 'PROVIDER_CONFLICT' });
  await expect(getAdmissionUsage(input.ownerId, input.tripId, first.admission.id)).rejects.toMatchObject({ code: 'PROVIDER_CONFLICT' });
  await pending(input, first.run.id);
  await expect(admitResume(resumeInput(input, first.run.id))).rejects.toMatchObject({ code: 'PROVIDER_CONFLICT' });
  expect((await settleAdmission(first.admission.id, 0)).chargedCostMicros).toBe(input.maxCostMicros);
  expect(await counts()).toEqual({ runs: 1, reservations: 1, invocations: 1 });
}));

test('atomic concurrent start + stable receipt/provider binding and owner isolation', () => withDatabase(async () => {
  const input = await setup();
  const results = await Promise.all(Array.from({ length: 5 }, () => admitStart(input)));
  expect(results.filter(r => r.executed)).toHaveLength(1);
  expect(new Set(results.map(r => r.admission.id)).size).toBe(1);
  expect(await counts()).toEqual({ runs: 1, reservations: 1, invocations: 1 });
  const result = results[0];
  expect(result.admission.expiresAt.getTime()).toBeGreaterThan(Date.now());
  expect(await getRunProvider(input.ownerId, input.tripId, { runId: result.run.id })).toBe('gemini');
  expect(await getRunProvider(input.ownerId, input.tripId, { requestId: input.requestId })).toBe('gemini');
  expect(await getRunProvider(randomUUID(), input.tripId, { runId: result.run.id })).toBeNull();
  await expect(getAdmissionUsage(randomUUID(), input.tripId, result.admission.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(admitStart({ ...input, message: 'changed' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect((await admitStart({ ...input, ipKey: hash('rotated'), now: new Date() })).executed).toBe(false);
  const fixture = await setup();
  const old = await startRun(fixture.ownerId, fixture.tripId, fixture.requestId, fixture.message, 1);
  expect(await getRunProvider(fixture.ownerId, fixture.tripId, { runId: old.run.id })).toBe('fixture');
  await expect(admitStart(fixture)).rejects.toMatchObject({ code: 'PROVIDER_CONFLICT' });
}));

test('quota denial leaves no run; run failure rolls back quota; resume denial leaves decision untouched', () => withDatabase(async () => {
  const input = await setup();
  for (const maxCostMicros of [0, -1]) {
    await expect(admitStart({ ...input, maxCostMicros })).rejects.toMatchObject({ code: 'INVALID_ADMISSION' });
  }
  await expect(admitStart({ ...input, policy: { enabled: false } })).rejects.toMatchObject({ code: 'LIVE_DISABLED' });
  await expect(admitStart({ ...input, maxCostMicros: 100_001 })).rejects.toMatchObject({ code: 'QUOTA_BUDGET' });
  await expect(admitStart({ ...input, baseVersion: 2 })).rejects.toMatchObject({ code: 'STALE_VERSION' });
  expect(await counts()).toEqual({ runs: 0, reservations: 0, invocations: 0 });
  const first = await admitStart({ ...input, now: new Date() });
  await pending(input, first.run.id);
  await settleAdmission(first.admission.id, 0);
  for (const maxCostMicros of [-1, 1, 100_001]) {
    await expect(admitResume({ ...resumeInput(input, first.run.id), maxCostMicros }))
      .rejects.toMatchObject({ code: 'INVALID_ADMISSION' });
  }
  await expect(admitResume({ ...resumeInput(input, first.run.id), interruptId: 'wrong-gate' }))
    .rejects.toMatchObject({ code: 'RUN_STATE_CONFLICT' });
  expect(await getRun(input.ownerId, input.tripId, first.run.id)).toMatchObject({ status: 'awaiting_confirmation', decision: null });
  expect(await counts()).toEqual({ runs: 1, reservations: 1, invocations: 1 });
  const resumed = await Promise.all(Array.from({ length: 3 }, () => admitResume(resumeInput(input, first.run.id))));
  expect(resumed.filter(result => result.executed)).toHaveLength(1);
  expect(new Set(resumed.map(result => result.admission.id)).size).toBe(1);
  expect((await admitResume(resumeInput(input, first.run.id))).executed).toBe(false);
  await expect(admitResume({ ...resumeInput(input, first.run.id), confirmed: false }))
    .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
}));

test('seven start calls authorize durably; eighth denied; hook replay and usage are strict', () => withDatabase(async () => {
  const input = await setup(); const result = await admitStart(input);
  const hook = (event: Parameters<typeof accountModelCall>[3]) => accountModelCall(input.ownerId, input.tripId, result.admission.id, event);
  await expect(hook({ kind: 'model-call-usage', callId: 'absent', usage })).rejects.toMatchObject({ code: 'MODEL_CALL_NOT_STARTED' });
  for (let i = 0; i < 7; i++) {
    expect(await hook({ kind: 'model-call-start', callId: `call-${i}` })).toEqual({ recorded: true });
    // A separate pool checkout sees the committed authorization before provider execution.
    expect((await database().query('SELECT count(*)::int AS n FROM model_calls')).rows[0].n).toBe(i + 1);
    expect(await hook({ kind: 'model-call-start', callId: `call-${i}` })).toEqual({ recorded: false });
    expect(await hook({ kind: 'model-call-usage', callId: `call-${i}`, usage })).toEqual({ recorded: true });
  }
  await expect(hook({ kind: 'model-call-start', callId: 'eighth' })).rejects.toMatchObject({ code: 'MODEL_CALL_LIMIT' });
  expect(await hook({ kind: 'model-call-usage', callId: 'call-0', usage })).toEqual({ recorded: false });
  await expect(hook({ kind: 'model-call-usage', callId: 'call-0', usage: null })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  await expect(hook({ kind: 'model-call-usage', callId: 'call-0', usage: { ...usage, totalTokens: 1 } }))
    .rejects.toMatchObject({ code: 'INVALID_MODEL_USAGE' });
  for (const invalid of [{ ...usage, totalTokens: 10 }, { ...usage, thoughtTokens: 1 }]) {
    await expect(hook({ kind: 'model-call-usage', callId: 'call-0', usage: invalid }))
      .rejects.toMatchObject({ code: 'INVALID_MODEL_USAGE' });
  }
  expect(await settleAdmission(result.admission.id, 7)).toMatchObject({ actualCostMicros: 7, chargedCostMicros: 7 });
  expect(await settleAdmission(result.admission.id, 7)).toMatchObject({ actualCostMicros: 7 });
  await expect(settleAdmission(result.admission.id, 8)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  await expect(hook({ kind: 'model-call-start', callId: 'late' })).rejects.toMatchObject({ code: 'ADMISSION_NOT_ACTIVE' });
}));

test.each(['missing', 'null'] as const)('%s usage is unknown, never refunded as zero', mode => withDatabase(async () => {
  const input = await setup(); const result = await admitStart(input);
  await accountModelCall(input.ownerId, input.tripId, result.admission.id, { kind: 'model-call-start', callId: 'call' });
  if (mode === 'null') await accountModelCall(input.ownerId, input.tripId, result.admission.id,
    { kind: 'model-call-usage', callId: 'call', usage: null });
  expect(await getAdmissionUsage(input.ownerId, input.tripId, result.admission.id))
    .toMatchObject({ complete: mode === 'null', hasUnknownUsage: true });
  expect(await settleAdmission(result.admission.id, 0)).toMatchObject({ actualCostMicros: null, chargedCostMicros: 100 });
}));

test.each([0, 6, 7, 8])('zero resume preserves %i prior calls and never authorizes model accounting', prior => withDatabase(async () => {
  const input = await setup(); const first = await admitStart(input);
  for (let i = 0; i < Math.min(prior, 7); i++) await accountModelCall(input.ownerId, input.tripId, first.admission.id,
    { kind: 'model-call-start', callId: `first-${i}` });
  if (prior > 7) await database().query(`INSERT INTO model_calls(invocation_id,run_id,call_id,status)
    VALUES ($1,$2,'historical-eighth','started')`, [first.admission.id, first.run.id]);
  await pending(input, first.run.id); await settleAdmission(first.admission.id, null);
  if (prior > 7) {
    await expect(admitResume(resumeInput(input, first.run.id))).rejects.toMatchObject({ code: 'MODEL_CALL_LIMIT' });
    expect(await getRun(input.ownerId, input.tripId, first.run.id)).toMatchObject({ status: 'awaiting_confirmation', decision: null });
    expect(await counts()).toEqual({ runs: 1, reservations: 1, invocations: 1 });
    return;
  }
  const second = await admitResume(resumeInput(input, first.run.id));
  expect(second.admission.priorModelCalls).toBe(prior);
  const results = await Promise.allSettled(['seventh', 'eighth'].map(callId =>
    accountModelCall(input.ownerId, input.tripId, second.admission.id, { kind: 'model-call-start', callId })));
  expect(results).toEqual(Array.from({ length: 2 }, () => expect.objectContaining({
    status: 'rejected', reason: expect.objectContaining({ code: 'MODEL_GENERATION_DISABLED' }),
  })));
  for (const callId of ['absent', 'first-0']) {
    await expect(accountModelCall(input.ownerId, input.tripId, second.admission.id, { kind: 'model-call-usage', callId, usage }))
      .rejects.toMatchObject({ code: 'MODEL_GENERATION_DISABLED' });
  }
  expect(await getAdmissionUsage(input.ownerId, input.tripId, second.admission.id))
    .toMatchObject({ calls: [], complete: true, hasUnknownUsage: false });
  expect((await database().query('SELECT count(*)::int AS n FROM model_calls')).rows[0].n).toBe(prior);
}));

test.each([100, 99])('zero resume works with historical charge at/above budget %i without refunding history', dailyBudgetMicros => withDatabase(async () => {
  const input = await setup(); const first = await admitStart(input);
  await accountModelCall(input.ownerId, input.tripId, first.admission.id, { kind: 'model-call-start', callId: 'unknown' });
  await pending(input, first.run.id); await settleAdmission(first.admission.id, null);
  const history = () => database().query(`SELECT to_jsonb(i) AS invocation,to_jsonb(q) AS reservation,
    (SELECT jsonb_agg(to_jsonb(c) ORDER BY call_id) FROM model_calls c WHERE c.invocation_id=i.id) AS calls
    FROM agent_invocations i JOIN quota_reservations q ON q.id=i.reservation_id WHERE i.id=$1`, [first.admission.id]);
  const before = (await history()).rows;
  const limited: QuotaPolicy = { ...policy, enabled: true, dailyBudgetMicros };
  const second = await admitResume({ ...resumeInput(input, first.run.id), policy: limited });
  expect(second.executed).toBe(true);
  expect(await settleAdmission(second.admission.id, 0)).toMatchObject({ maxCostMicros: 0, chargedCostMicros: 0, actualCostMicros: 0 });
  expect((await admitResume({ ...resumeInput(input, first.run.id), policy: limited })).executed).toBe(false);
  expect((await history()).rows).toEqual(before);
  const trip = await createTrip(input.ownerId, makeSnapshot());
  await expect(admitStart({ ...input, tripId: trip.id, requestId: randomUUID(), maxCostMicros: 1, policy: limited, now: new Date() }))
    .rejects.toMatchObject({ code: 'QUOTA_BUDGET' });
  expect(await counts()).toEqual({ runs: 1, reservations: 2, invocations: 2 });
}));

test.each(['disabled', 'owner', 'session-ttl', 'trip-ttl', 'ip-minute', 'concurrency'] as const)(
  'zero resume preserves %s admission guard and atomic decision claim', mode => withDatabase(async () => {
    const input = await setup(); const first = await admitStart(input);
    await pending(input, first.run.id); await settleAdmission(first.admission.id, null);
    if (mode === 'session-ttl') await database().query('UPDATE sessions SET expires_at=clock_timestamp() WHERE id=$1', [input.ownerId]);
    if (mode === 'trip-ttl') await database().query('UPDATE trips SET expires_at=clock_timestamp() WHERE id=$1', [input.tripId]);
    if (mode === 'ip-minute' || mode === 'concurrency') {
      for (let i = 0; i < (mode === 'ip-minute' ? 4 : 3); i++) {
        const reserved = await reserveRun({ ownerId: input.ownerId, ipKey: mode === 'ip-minute' ? input.ipKey : hash(`other-${i}`),
          requestId: `other-${i}`, payloadHash: hash('payload'), maxCostMicros: 0, now: new Date() }, policy);
        if (mode === 'ip-minute') {
          await delay(2);
          await settleRun({ reservationId: reserved.reservationId, actualCostMicros: 0, now: new Date() });
        }
      }
    }
    const before = await counts();
    const resume = resumeInput(input, first.run.id);
    await expect(admitResume({ ...resume, ownerId: mode === 'owner' ? randomUUID() : input.ownerId,
      policy: mode === 'disabled' ? { enabled: false } : policy })).rejects.toMatchObject({
      code: mode === 'disabled' ? 'LIVE_DISABLED' : mode === 'ip-minute' ? 'QUOTA_IP_MINUTE'
        : mode === 'concurrency' ? 'QUOTA_CONCURRENCY' : 'NOT_FOUND',
    });
    expect(await counts()).toEqual(before);
    expect((await database().query('SELECT status,decision FROM agent_runs WHERE id=$1', [first.run.id])).rows[0])
      .toEqual({ status: 'awaiting_confirmation', decision: null });
  }));

test('zero resume unknown settlement stays null and cannot be rewritten as successful zero usage', () => withDatabase(async () => {
  const input = await setup(); const first = await admitStart(input);
  await pending(input, first.run.id); await settleAdmission(first.admission.id, null);
  const second = await admitResume(resumeInput(input, first.run.id));
  expect(await settleAdmission(second.admission.id, null)).toMatchObject({ maxCostMicros: 0, chargedCostMicros: 0, actualCostMicros: null });
  await expect(settleAdmission(second.admission.id, 0)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  await expect(settleRejectedToolArguments(second.admission)).rejects.toMatchObject({ code: 'ADMISSION_NOT_ACTIVE' });
}));

test('013 changes only constraints: historical positive resume and unknown failed audit remain unchanged', () => withDatabase(async () => {
  const input = await setup(); const first = await admitStart(input);
  await accountModelCall(input.ownerId, input.tripId, first.admission.id, { kind: 'model-call-start', callId: 'historical-start' });
  await settleAdmission(first.admission.id, null);
  const historical = await reserveRun({ ownerId: input.ownerId, ipKey: input.ipKey, logicalRunId: first.run.id,
    requestId: 'historical-resume', payloadHash: hash('historical'), maxCostMicros: 100, now: new Date() }, policy);
  await delay(2);
  await settleRun({ reservationId: historical.reservationId, actualCostMicros: null, now: new Date() });
  const historicalId = randomUUID();
  await database().query(`INSERT INTO agent_invocations
    (id,run_id,reservation_id,kind,provider,model,max_cost_micros,status,prior_model_calls,expires_at)
    VALUES ($1,$2,$3,'resume','gemini',$4,100,'settled',1,$5)`,
  [historicalId, first.run.id, historical.reservationId, first.admission.model, historical.expiresAt]);
  await database().query(`INSERT INTO model_calls(invocation_id,run_id,call_id,status,usage,completed_at)
    VALUES ($1,$2,'historical-resume-call','completed',$3::jsonb,clock_timestamp())`, [historicalId, first.run.id, JSON.stringify(usage)]);
  await database().query(`UPDATE agent_runs SET status='failed',lease_expires_at=NULL,answer_contract_version=0,
    interrupt_id='historical-gate',decision=true WHERE id=$1`, [first.run.id]);
  // Recreate the pre-013 constraints only in this test's fresh isolated schema.
  await database().query(`ALTER TABLE quota_reservations DROP CONSTRAINT quota_reservations_max_cost_micros_check;
    ALTER TABLE quota_reservations ADD CONSTRAINT quota_reservations_max_cost_micros_check CHECK (max_cost_micros BETWEEN 1 AND 9007199254740991);
    ALTER TABLE agent_invocations DROP CONSTRAINT agent_invocations_zero_cost_resume_check;
    ALTER TABLE agent_invocations DROP CONSTRAINT agent_invocations_max_cost_micros_check;
    ALTER TABLE agent_invocations ADD CONSTRAINT agent_invocations_max_cost_micros_check CHECK (max_cost_micros BETWEEN 1 AND 9007199254740991);
    DELETE FROM schema_migrations WHERE id='013-zero-model-continuation'`);
  const audit = async () => (await database().query(`SELECT
    (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM agent_runs r) AS runs,
    (SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM agent_invocations i) AS invocations,
    (SELECT jsonb_agg(to_jsonb(q) ORDER BY id) FROM quota_reservations q) AS reservations,
    (SELECT jsonb_agg(to_jsonb(c) ORDER BY call_id) FROM model_calls c) AS calls,
    (SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM schema_migrations m WHERE id<>'013-zero-model-continuation') AS migrations`)).rows[0];
  const before = await audit();
  const migrations = await loadMigrations();
  expect(migrations.at(-1)?.id).toBe('013-zero-model-continuation');
  await migrate(database(), migrations);
  expect(await audit()).toEqual(before);
  await expect(database().query('UPDATE agent_invocations SET max_cost_micros=0 WHERE id=$1', [first.admission.id]))
    .rejects.toMatchObject({ code: '23514', constraint: 'agent_invocations_zero_cost_resume_check' });
  for (const invalid of ['-1', '9007199254740992']) {
    await expect(database().query('UPDATE agent_invocations SET max_cost_micros=$1 WHERE id=$2', [invalid, historicalId]))
      .rejects.toMatchObject({ code: '23514', constraint: 'agent_invocations_max_cost_micros_check' });
  }
  await expect(settleAdmission(historicalId, 0)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(await audit()).toEqual(before);
}));

test('twenty logical runs/day: resume does not take a second session slot, but counts IP invocation', () => withDatabase(async () => {
  const input = await setup();
  for (let i = 0; i < 19; i++) {
    const q = await reserveRun({ ownerId: input.ownerId, ipKey: hash(`other-${i}`), logicalRunId: randomUUID(),
      requestId: `other-${i}`, payloadHash: hash('payload'), now: new Date(), maxCostMicros: 1 }, policy);
    await delay(2);
    await settleRun({ reservationId: q.reservationId, actualCostMicros: 0, now: new Date() });
  }
  const first = await admitStart({ ...input, now: new Date() });
  await pending(input, first.run.id); await settleAdmission(first.admission.id, 0);
  expect((await admitResume(resumeInput(input, first.run.id))).executed).toBe(true);
  const trip = await createTrip(input.ownerId, makeSnapshot());
  await expect(admitStart({ ...input, tripId: trip.id, requestId: 'twenty-one', now: new Date() }))
    .rejects.toMatchObject({ code: 'QUOTA_SESSION_DAY' });
  expect((await database().query(`SELECT count(*)::int AS n,
    count(DISTINCT COALESCE(logical_run_id,id))::int AS logical FROM quota_reservations`)).rows[0])
    .toEqual({ n: 21, logical: 20 });
  expect((await database().query('SELECT count(*)::int AS n FROM quota_reservations WHERE ip_key=$1', [input.ipKey])).rows[0].n).toBe(2);
}), 30_000);

test.each(['ttl', 'midnight'] as const)('global lock wait includes admission entry clock: %s rejection is atomic', mode => withDatabase(async () => {
  const input = await setup();
  const client = await database().connect();
  let work: Promise<unknown> | undefined;
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM quota_global_lock WHERE id=1 FOR UPDATE');
    const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const today = new Date();
    const midnight = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 1, 16);
    work = expect(admitStart({ ...input,
      now: mode === 'midnight' ? new Date(midnight - 200) : new Date(),
      policy: { ...policy, enabled: true, reservationTtlMs: mode === 'ttl' ? 200 : 60_000 },
    })).rejects.toMatchObject({ code: mode === 'ttl' ? 'QUOTA_RESERVATION_EXPIRED' : 'QUOTA_CLOCK_CHANGED' });
    let blocked = false;
    for (let i = 0; i < 50; i++) {
      const waiting = await database().query('SELECT 1 FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))', [pid]);
      if (waiting.rowCount) { blocked = true; break; }
      await delay(10);
    }
    expect(blocked).toBe(true);
    await delay(400);
    await client.query('COMMIT');
    await work;
    expect(await counts()).toEqual({ runs: 0, reservations: 0, invocations: 0 });
  } finally {
    await client.query('ROLLBACK'); client.release();
    await work;
  }
}));

test('expired run fences callbacks; settlement still conservatively releases capacity', () => withDatabase(async () => {
  const input = await setup(); const first = await admitStart(input);
  await database().query("UPDATE agent_runs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [first.run.id]);
  await expect(accountModelCall(input.ownerId, input.tripId, first.admission.id, { kind: 'model-call-start', callId: 'late' }))
    .rejects.toMatchObject({ code: 'ADMISSION_NOT_ACTIVE' });
  expect((await database().query('SELECT count(*)::int AS n FROM model_calls')).rows[0].n).toBe(0);
  expect(await settleAdmission(first.admission.id, null)).toMatchObject({ status: 'settled', chargedCostMicros: 100 });
}));

test.each(['sessions', 'trips'] as const)('invocation lock wait rechecks %s TTL before authorizing a model call', table => withDatabase(async () => {
  const input = await setup(); const first = await admitStart(input);
  const client = await database().connect();
  let work: Promise<unknown> | undefined;
  try {
    await database().query(`UPDATE ${table} SET expires_at=clock_timestamp()+interval '1 second' WHERE id=$1`,
      [table === 'sessions' ? input.ownerId : input.tripId]);
    await client.query('BEGIN');
    await client.query('SELECT id FROM agent_invocations WHERE id=$1 FOR UPDATE', [first.admission.id]);
    const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    work = expect(accountModelCall(input.ownerId, input.tripId, first.admission.id,
      { kind: 'model-call-start', callId: 'blocked' })).rejects.toMatchObject({ code: 'ADMISSION_NOT_ACTIVE' });
    // Observe a real waiter, rather than merely arranging a theoretical ordering.
    let blocked = false;
    for (let i = 0; i < 50; i++) {
      const waiting = await database().query('SELECT 1 FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))', [pid]);
      if (waiting.rowCount) { blocked = true; break; }
      await delay(10);
    }
    expect(blocked).toBe(true);
    await delay(1100);
    await client.query('COMMIT');
    await work;
    expect((await database().query('SELECT count(*)::int AS n FROM model_calls')).rows[0].n).toBe(0);
  } finally {
    await client.query('ROLLBACK'); client.release();
    await work;
  }
}));
