import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient, QueryConfig } from 'pg';
import { EventType } from '@ag-ui/core';
import { expect, test, vi } from 'vitest';
import { waitForCloudflareCampaignDrain } from '../../evals/cloudflare-campaign-drain';
import { runCloudflareCampaign, type CloudflareCampaignReport } from '../../evals/cloudflare-campaign';
import { auditUsage } from '../../evals/usage';
import { exportUsageEvidence } from '../../evals/usage-evidence';
import { CLOUDFLARE_MODEL, CLOUDFLARE_PRICE_BASIS } from '../../src/agent/cloudflare-wire';
import { accountModelCall, admitStart, settleAdmission } from '../../src/server/agent-admission';
import { withAdkSchemaLock } from '../../src/server/adk-schema-lock';
import { database, makePool } from '../../src/server/db';
import { finishRun } from '../../src/server/run-store';
import { createSession } from '../../src/server/session';
import { createTrip } from '../../src/server/trip-store';
import { withDatabase, testDatabaseUrl } from '../support/database';
import { makeSnapshot } from '../support/domain-fixtures';

const binding = { provider: 'cloudflare', model: CLOUDFLARE_MODEL, accountId: 'a'.repeat(32) } as const;
const usage = { promptTokens: 20, outputTokens: 8, totalTokens: 28 };
const providerEvidence = { provider: 'cloudflare', returnedModel: `${CLOUDFLARE_MODEL}-external`, priceBasis: CLOUDFLARE_PRICE_BASIS } as const;

async function startSyntheticCall() {
  const owner = await createSession();
  const trip = await createTrip(owner.id, makeSnapshot());
  const admitted = await admitStart({ ownerId: owner.id, tripId: trip.id,
    ipKey: createHash('sha256').update('synthetic-campaign-retention').digest('hex'),
    requestId: randomUUID(), message: 'synthetic cancellation', baseVersion: 1, maxCostMicros: 7, now: new Date(),
    policy: { enabled: true, priceBasis: 'synthetic', dailyBudgetMicros: 100, reservationTtlMs: 60_000 }, ...binding });
  await accountModelCall(owner.id, trip.id, admitted.admission.id, { kind: 'model-call-start', callId: 'synthetic-call' });
  return { owner, trip, admitted };
}
type SyntheticCall = Awaited<ReturnType<typeof startSyntheticCall>>;

async function saveUsage(current: SyntheticCall, known: boolean) {
  await accountModelCall(current.owner.id, current.trip.id, current.admitted.admission.id, {
    kind: 'model-call-usage', callId: 'synthetic-call', usage: known ? usage : null, providerEvidence,
  });
}

async function finishFailed(current: SyntheticCall) {
  await finishRun(current.owner.id, current.trip.id, current.admitted.run.id, { status: 'failed',
    event: { type: EventType.RUN_ERROR, code: 'AGENT_ABORTED', message: 'Synthetic cancellation' } });
}

async function removeOwnRetainedSchema(admin: Pool, schema: string) {
  if (!schema) return;
  // Only a name captured inside this test's withDatabase callback may reach here.
  expect(schema).toMatch(/^test_[a-f0-9]{32}$/);
  const client = await admin.connect();
  try {
    await withAdkSchemaLock(client, async () => {
      await client.query(`DROP SCHEMA IF EXISTS "${schema}_adk" CASCADE`);
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    });
  } finally { client.release(); }
}

test('drain waits through delayed settlement and terminal run before exporting the final private evidence', async () => {
  let ownSchema = '';
  const admin = makePool(testDatabaseUrl());
  try {
    await withDatabase(async () => {
      const pool = database();
      ownSchema = (await pool.query('SELECT current_schema() AS name')).rows[0].name;
      const current = await startSyntheticCall();
      await saveUsage(current, true);
      const firstPoll = Promise.withResolvers<void>();
      const secondPoll = Promise.withResolvers<void>();
      const trace: string[] = [];
      const settled = (async () => {
        await firstPoll.promise;
        await settleAdmission(current.admitted.admission.id, 5);
        trace.push('settled');
      })();
      const finished = (async () => {
        await settled;
        await secondPoll.promise;
        await finishFailed(current);
        trace.push('terminal');
      })();
      // Attach a handler immediately; cleanup below still awaits and checks this work.
      void finished.catch(() => undefined);
      let polls = 0;
      const observedPool = { connect: async () => {
        const client = await pool.connect();
        return { release: (destroy?: boolean) => client.release(destroy), query: async (config: QueryConfig) => {
        const result = await client.query(config);
        const poll = ++polls;
        trace.push(`poll:${result.rows[0].busy}`);
        if (poll === 1) {
          firstPoll.resolve();
          await settled;
        } else if (poll === 2) {
          // Invocation is settled now, but the run is still running.
          expect((await pool.query('SELECT status FROM agent_invocations WHERE id=$1', [current.admitted.admission.id])).rows[0].status).toBe('settled');
          expect(result.rows[0].busy).toBe(true);
          secondPoll.resolve();
          await finished;
        }
        return result;
        } } as unknown as PoolClient;
      } } as unknown as Pool;
      const capture = vi.fn(async () => {
        trace.push('export');
        return exportUsageEvidence(pool, current.owner.id, current.trip.id, current.admitted.run.id, binding);
      });
      try {
        expect(capture).not.toHaveBeenCalled();
        expect(await waitForCloudflareCampaignDrain(observedPool, current.trip.id)).toBe(true);
        const evidence = await capture();
        expect(trace).toEqual(['poll:true', 'settled', 'poll:true', 'terminal', 'poll:false', 'export']);
        expect(evidence).toMatchObject({ schemaVersion: 2, binding,
          invocations: [{ status: 'settled', reservation_status: 'settled', charged_cost_micros: '5', actual_cost_micros: '5' }],
          calls: [{ status: 'completed', usage }] });
        expect(await auditUsage(pool, current.owner.id, current.trip.id, current.admitted.run.id, binding))
          .toMatchObject({ complete: true, modelCalls: 1, costMicros: 5 });
      } finally {
        firstPoll.resolve(); secondPoll.resolve();
        await finished;
      }
    }, { retainOnFailure: true });
    expect((await admin.query('SELECT to_regnamespace($1) AS name', [ownSchema])).rows[0].name).toBeNull();
  } finally {
    try { await removeOwnRetainedSchema(admin, ownSchema); } finally { await admin.end(); }
  }
}, 30_000);

test.each(['missing-run', 'missing-invocation', 'missing-event', 'wrong-terminal-event', 'latest-nonterminal-event',
  'interrupted-run', 'expired-invocation', 'expired-reservation', 'missing-reservation-binding'] as const)(
  'drain SQL rejects %s as incomplete durable state', mode => withDatabase(async () => {
    const pool = database();
    const current = await startSyntheticCall();
    await saveUsage(current, true);
    await settleAdmission(current.admitted.admission.id, 5);
    await finishFailed(current);
    const runId = current.admitted.run.id;
    let tripId = current.trip.id;
    if (mode === 'missing-run') tripId = (await createTrip(current.owner.id, makeSnapshot())).id;
    if (mode === 'missing-invocation') {
      await pool.query('DELETE FROM model_calls WHERE run_id=$1', [runId]);
      await pool.query('DELETE FROM agent_invocations WHERE run_id=$1', [runId]);
    }
    if (mode === 'missing-event') await pool.query('DELETE FROM agent_run_events WHERE run_id=$1', [runId]);
    if (mode === 'wrong-terminal-event') await pool.query(`UPDATE agent_run_events
      SET event=jsonb_build_object('type','RUN_FINISHED') WHERE run_id=$1`, [runId]);
    if (mode === 'latest-nonterminal-event') await pool.query(`INSERT INTO agent_run_events(run_id,sequence,event)
      SELECT $1,COALESCE(MAX(sequence),0)+1,'{"type":"TEXT_MESSAGE_END","messageId":"synthetic"}'::jsonb
      FROM agent_run_events WHERE run_id=$1`, [runId]);
    if (mode === 'interrupted-run') await pool.query("UPDATE agent_runs SET status='interrupted' WHERE id=$1", [runId]);
    if (mode === 'expired-invocation') await pool.query("UPDATE agent_invocations SET status='expired' WHERE run_id=$1", [runId]);
    if (mode === 'expired-reservation') await pool.query(`UPDATE quota_reservations SET status='expired',
      settled_at=NULL,actual_cost_micros=NULL,charged_cost_micros=max_cost_micros WHERE id=$1`, [current.admitted.admission.reservationId]);
    if (mode === 'missing-reservation-binding') await pool.query('UPDATE quota_reservations SET logical_run_id=NULL WHERE id=$1',
      [current.admitted.admission.reservationId]);
    const observations: boolean[] = [];
    const releases: boolean[] = [];
    const observedPool = { connect: async () => {
      const client = await pool.connect();
      return { release: (destroy: boolean) => { releases.push(destroy); client.release(destroy); },
        query: async (config: QueryConfig) => {
          // Execute the real drain SQL once. The unit suite covers repeated polls;
          // abort the second probe to avoid nine unnecessary five-second waits.
          if (observations.length) throw new Error('SYNTHETIC_END_SQL_PROBE');
          const result = await client.query(config);
          observations.push(result.rows[0].busy);
          return result;
        } } as unknown as PoolClient;
    } } as unknown as Pool;
    const ready = await waitForCloudflareCampaignDrain(observedPool, tripId);
    expect(observations).toEqual([true]);
    expect(ready).toBe(false);
    expect(releases).toEqual([true]);
  }), 30_000);

test.each(['known-failure', 'unknown-usage', 'undrained'] as const)(
  '%s throws inside withDatabase and retains the actual accounting schema until test-owned cleanup', async mode => {
    let ownSchema = '';
    let runId = '';
    let returnedReport: CloudflareCampaignReport | undefined;
    const checkpoints: CloudflareCampaignReport[] = [];
    const admin = makePool(testDatabaseUrl());
    let fakeNow = 100_000;
    let current: SyntheticCall | undefined;
    let executions = 0;
    let captures = 0;
    const failure = mode === 'undrained' ? 'EVAL_PRIVATE_USAGE_EXPORT_FAILED' : 'EVAL_CLOUDFLARE_CAMPAIGN_STOPPED';
    try {
      await expect(withDatabase(async () => {
        const pool = database();
        ownSchema = (await pool.query('SELECT current_schema() AS name')).rows[0].name;
        const report = await runCloudflareCampaign({ accountId: binding.accountId,
          prior: { chargedMicros: 3976, invocations: 6, modelCalls: 9, totalTokens: 36403 },
          now: () => fakeNow, pause: async ms => { fakeNow += ms; },
          checkpoint: async report => { checkpoints.push(structuredClone(report)); },
          execute: async (_caseId, beforeDispatch) => {
            executions++;
            current = await startSyntheticCall();
            runId = current.admitted.run.id;
            await beforeDispatch(new AbortController().signal);
            if (mode !== 'undrained') {
              await saveUsage(current, mode === 'known-failure');
              await settleAdmission(current.admitted.admission.id, mode === 'known-failure' ? 5 : null);
              await finishFailed(current);
            }
            // Models the collector exiting while a stream's background work may remain.
            throw new Error('EVAL_COLLECTOR_CANCELLED');
          },
          capture: async () => {
            captures++;
            if (!current) throw new Error('MISSING_SYNTHETIC_RUN');
            const quiescent = await waitForCloudflareCampaignDrain(pool, current.trip.id);
            const evidence = await exportUsageEvidence(pool, current.owner.id, current.trip.id, runId, binding);
            const audit = await auditUsage(pool, current.owner.id, current.trip.id, runId, binding);
            const chargedMicros = Number(evidence.invocations[0].charged_cost_micros);
            const usageKnown = quiescent && audit.complete;
            return { chargedMicros, modelCalls: evidence.calls.length,
              totalTokens: usageKnown ? evidence.calls.reduce((total, call) => total + (call.usage?.totalTokens ?? 0), 0) : null,
              usageKnown, privateUsageComplete: quiescent,
              record: { privateUsage: [evidence], privateUsageComplete: quiescent, quiescent } };
          },
        });
        returnedReport = report;
        // Mirror the entry's orchestration without importing its authorized live test.
        // Moving this throw outside withDatabase would destroy the evidence schema.
        if (report.stopped) throw new Error('EVAL_CLOUDFLARE_CAMPAIGN_STOPPED');
      }, { retainOnFailure: true })).rejects.toThrow(failure);
      expect(executions).toBe(1);
      expect(captures).toBe(1);
      expect(ownSchema).toMatch(/^test_[a-f0-9]{32}$/);
      expect((await admin.query('SELECT to_regnamespace($1) AS name', [ownSchema])).rows[0].name).toBe(ownSchema);
      const retained = await admin.query(`SELECT r.status AS run_status,i.status AS invocation_status,
        q.status AS reservation_status,q.charged_cost_micros,q.actual_cost_micros,c.status AS call_status
        FROM "${ownSchema}".agent_runs r JOIN "${ownSchema}".agent_invocations i ON i.run_id=r.id
        JOIN "${ownSchema}".quota_reservations q ON q.id=i.reservation_id
        JOIN "${ownSchema}".model_calls c ON c.invocation_id=i.id WHERE r.id=$1`, [runId]);
      expect(retained.rows).toEqual([{
        run_status: mode === 'undrained' ? 'running' : 'failed',
        invocation_status: mode === 'undrained' ? 'active' : 'settled',
        reservation_status: mode === 'undrained' ? 'reserved' : 'settled',
        charged_cost_micros: mode === 'known-failure' ? '5' : '7',
        actual_cost_micros: mode === 'known-failure' ? '5' : null,
        call_status: mode === 'undrained' ? 'started' : 'completed',
      }]);
      expect(checkpoints.at(-1)?.stopped).toBe(mode === 'undrained' ? 'EVIDENCE_EXPORT_STOP'
        : mode === 'unknown-usage' ? 'UNKNOWN_USAGE_STOP' : 'EVAL_COLLECTOR_CANCELLED');
      const exported = checkpoints.at(-1)?.records.find(record =>
        !!record && typeof record === 'object' && 'kind' in record && record.kind === 'durable-audit');
      expect(exported).toMatchObject({ privateUsageComplete: mode !== 'undrained', quiescent: mode !== 'undrained' });
      if (mode === 'undrained') expect(returnedReport).toBeUndefined();
      else expect(returnedReport?.records.filter(record =>
        !!record && typeof record === 'object' && 'outcome' in record && record.outcome === 'skipped')).toHaveLength(29);
    } finally {
      try { await removeOwnRetainedSchema(admin, ownSchema); } finally { await admin.end(); }
    }
  }, 30_000);
