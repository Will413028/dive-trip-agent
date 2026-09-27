import { randomUUID, createHash } from 'node:crypto';
import { test } from 'vitest';
import { EventType } from '@ag-ui/core';
import { executeAgent } from '../../src/agent/runtime';
import { GEMINI_MODEL, PROVIDER_ERROR_CODES } from '../../src/agent/provider';
import { database } from '../../src/server/db';
import { createSession } from '../../src/server/session';
import { createTrip } from '../../src/server/trip-store';
import { accountModelCall, admitStart, getAdmissionUsage, settleAdmission } from '../../src/server/agent-admission';
import { maximumModelCost, referenceModelCost } from '../../src/server/model-cost';
import { appendRunEvent, finishRun } from '../../src/server/run-store';
import { withDatabase, testDatabaseUrl } from '../support/database';
import { makeSnapshot } from '../support/domain-fixtures';
import { loadLiveCredential } from '../support/live-credential';
import { acceptedAnswerSchema, ANSWER_EVENT_NAME } from '../../src/domain/answer';

// No retries/repeats. Ordinary test commands never read credentials or call Google.
const authorized = process.env.DIVE_TRIP_LIVE_SMOKE_AUTHORIZATION === 'one-run-free-tier-confirmed';
test.skipIf(!authorized)('explicitly authorized single Gemini ADK smoke (no HTTP activation)',
  { timeout: 90_000, retry: 0, repeats: 0 }, async () => {
  const safeErrors = new Set<string>([...PROVIDER_ERROR_CODES, 'LIVE_CREDENTIAL_UNAVAILABLE', 'AGENT_PROVIDER_RATE_LIMIT', 'AGENT_PROVIDER_TIMEOUT',
    'AGENT_PROVIDER_ERROR', 'AGENT_PROVIDER_CONFIG', 'AGENT_PROVIDER_REFUSAL', 'AGENT_PROVIDER_INVALID_RESPONSE',
    'AGENT_TIMEOUT', 'AGENT_ABORTED', 'LIVE_SMOKE_INCOMPLETE', 'LIVE_SMOKE_COST_LIMIT']);
  try {
    await withDatabase(async () => {
      const now = new Date();
      const deadlineMs = now.getTime() + 60_000;
      const signal = AbortSignal.timeout(60_000);
      const owner = await createSession();
      const snapshot = makeSnapshot();
      const trip = await createTrip(owner.id, snapshot);
      const message = '這是合成資料測試。同行旅客人數還沒確定，請用繁體中文簡短問我需要確認的資訊。不要修改行程或提出修改提案。';
      const claim = await admitStart({ ownerId: owner.id, tripId: trip.id, requestId: randomUUID(), message,
        baseVersion: 1, ipKey: createHash('sha256').update(randomUUID()).digest('hex'), now,
        maxCostMicros: maximumModelCost(), policy: { enabled: true, dailyBudgetMicros: maximumModelCost(),
          priceBasis: 'server-verified', reservationTtlMs: 60_000 } });
      if (!claim.executed) throw new Error('LIVE_SMOKE_INCOMPLETE');
      let calls = 0, answerEvents = 0, toolEvents = 0, settled = false;
      try {
        const key = await loadLiveCredential(authorized);
        signal.throwIfAborted();
        const schema = (await database().query('SELECT current_schema() AS name')).rows[0].name;
        await appendRunEvent(owner.id, trip.id, claim.run.id,
          { type: EventType.RUN_STARTED, threadId: trip.id, runId: claim.run.requestId });
        const outcome = await executeAgent({ runId: claim.run.id, sessionId: claim.run.id, ownerId: owner.id, tripId: trip.id,
          baseVersion: 1, snapshot, catalog: snapshot.entries.map(entry => entry.item), input: { kind: 'start', message },
        }, { signal, onAccounting: async event => {
          const ack = await accountModelCall(owner.id, trip.id, claim.admission.id, event);
          if (event.kind === 'model-call-start') {
            if (!ack.recorded || ++calls > 7) throw new Error('LIVE_SMOKE_INCOMPLETE');
          }
        }, onEvent: async event => {
          // This smoke neither accepts nor applies proposals. No raw model output
          // or credentials are printed by the test runner, even on failure.
          if (event.kind === 'proposal') throw new Error('LIVE_SMOKE_INCOMPLETE');
          if (event.event.type === EventType.CUSTOM && event.event.name === ANSWER_EVENT_NAME) {
            const answer = acceptedAnswerSchema.parse(event.event.value);
            if (answer.runId !== claim.run.id || answer.body.kind !== 'clarify') throw new Error('LIVE_SMOKE_INCOMPLETE');
            answerEvents++;
          }
          if (event.event.type === EventType.TOOL_CALL_START) toolEvents++;
          await appendRunEvent(owner.id, trip.id, claim.run.id, event.event);
        } }, { databaseUrl: testDatabaseUrl(), schema: `${schema}_adk`, generation: { apiKey: key }, provider: {
          kind: 'gemini', previousModelCalls: 0,
          deadlineMs: Math.min(deadlineMs, claim.admission.expiresAt.getTime()),
        } });
        const usage = await getAdmissionUsage(owner.id, trip.id, claim.admission.id);
        let actual: number | null = usage.hasUnknownUsage || !usage.complete ? null : 0;
        for (const call of usage.calls) {
          const cost = referenceModelCost(call.usage);
          actual = actual === null || cost === null || !Number.isSafeInteger(actual + cost) ? null : actual + cost;
        }
        const receipt = await settleAdmission(claim.admission.id, actual); settled = true;
        if (receipt.chargedCostMicros > receipt.maxCostMicros) throw new Error('LIVE_SMOKE_COST_LIMIT');
        if (outcome.status !== 'succeeded' || calls < 1 || answerEvents !== 1) throw new Error('LIVE_SMOKE_INCOMPLETE');
        // Boolean-only audit: never pass secret-bearing data to assertion output.
        for (const table of ['sessions', 'events', 'app_states', 'user_states']) {
          const rows = await database().query(`SELECT to_jsonb(t) AS data FROM "${schema}_adk"."${table}" t`);
          if (JSON.stringify(rows.rows).includes(key)) throw new Error('LIVE_SMOKE_INCOMPLETE');
        }
        const publicEvents = await database().query('SELECT event FROM agent_run_events WHERE run_id=$1', [claim.run.id]);
        if (JSON.stringify(publicEvents.rows).includes(key)) throw new Error('LIVE_SMOKE_INCOMPLETE');
        await finishRun(owner.id, trip.id, claim.run.id, { status: 'succeeded', event: {
          type: EventType.RUN_FINISHED, threadId: trip.id, runId: claim.run.requestId, outcome: { type: 'success' },
        } });
        console.info(JSON.stringify({ smoke: 'passed', model: GEMINI_MODEL, calls, answerEvents, toolEvents,
          usageKnown: !usage.hasUnknownUsage, elapsedMs: Date.now() - now.getTime(), productMutations: 0 }));
      } catch (error) {
        if (!settled) await settleAdmission(claim.admission.id, null).catch(() => undefined);
        console.info(JSON.stringify({ smoke: 'failed', calls, answerEvents, toolEvents,
          elapsedMs: Date.now() - now.getTime(), productMutations: 0 }));
        throw error;
      }
    });
  } catch (error) {
    // Never pass raw SDK, file content, database details or cause into Vitest.
    // eslint-disable-next-line preserve-caught-error -- Raw cause may contain credentials; intentionally sanitized.
    throw new Error(error instanceof Error && safeErrors.has(error.message) ? error.message : 'LIVE_SMOKE_FAILED');
  }
});
