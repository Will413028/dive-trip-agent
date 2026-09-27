import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readFile, readdir, unlink } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'vitest';
import cases from '../../evals/cases.json';
import { collectCase } from '../../evals/collector';
import { auditAcceptedAnswerUsage } from '../../evals/usage';
import { exportUsageEvidence, type UsageEvidence } from '../../evals/usage-evidence';
import { writeAtomicCheckpoint } from '../../evals/checkpoint';
import { nextAttemptAllowed } from '../../evals/evidence';
import { CAMPAIGN_BUDGET_MICROS, CAMPAIGN_INVOCATION_LIMIT, campaignPreflight, carryCampaignUsage } from '../../evals/campaign-policy';
import { withDatabase } from '../support/database';
import { database } from '../../src/server/db';
import { createSession } from '../../src/server/session';
import { createTrip } from '../../src/server/trip-store';
import { handleRequest } from '../../src/server/http';
import { maximumModelCost } from '../../src/server/model-cost';
import { GEMINI_MODEL } from '../../src/agent/model-id';
import { loadLiveCredential } from '../support/live-credential';

const authorized = process.env.DIVE_TRIP_LIVE_EVAL_AUTHORIZATION === '30-cases-free-tier-confirmed';
/** Explicit opt-in only. Sequential, no retries, fixed synthetic fixtures, no paid fallback.
 * JSON is private synthetic review evidence, not an automatically approved score. */
test.skipIf(!authorized)('live HTTP evaluation campaign with hard stop and pending human text review', { timeout: 1800000, retry: 0, repeats: 0 }, async () => {
  const records: unknown[] = [];
  const budgetMicros = CAMPAIGN_BUDGET_MICROS;
  let chargedMicros = 0, invocations = 0, stopped: string | null = null, lastDispatch = 0;
  let prior = { chargedMicros: 0, invocations: 0 };
  let sourceFingerprint = '', historyNames: string[] = [];
  let reportCreated = false;
  await mkdir('.artifacts', { recursive: true });
  // Owned disposable lock: concurrent campaigns must not both read the same history.
  const lockPath = '.artifacts/live-evaluation.lock';
  const lock = await open(lockPath, 'wx', 0o600);
  const reportPath = `.artifacts/live-evaluation-${randomUUID()}.json`;
  const startedAt = new Date().toISOString();
  const save = () => writeAtomicCheckpoint(reportPath, JSON.stringify({ schemaVersion: 2, model: GEMINI_MODEL, budgetMicros,
    startedAt, sourceFingerprint, historyNames, prior, invocations,
    cumulativeChargedMicros: prior.chargedMicros + chargedMicros,
    cumulativeInvocations: prior.invocations + invocations,
    transport: 'real-gemini-via-http-handler', chargedMicros, stopped, textReview: 'pending', evaluationGatePassed: false, records }, null, 2));
  try {
    historyNames = (await readdir('.artifacts')).filter(name => /^live-evaluation-[a-f0-9-]{36}\.json$/.test(name)).sort();
    const history: unknown[] = [];
    for (const name of historyNames) {
      const file = await open(`.artifacts/${name}`, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > 8_388_608) throw new Error('EVAL_HISTORY_INVALID');
        history.push(JSON.parse(await file.readFile('utf8')));
      } finally { await file.close(); }
    }
    prior = carryCampaignUsage(history, GEMINI_MODEL);
    campaignPreflight(prior, maximumModelCost());
    const source = createHash('sha256');
    for (const path of ['src/agent/prompt.ts', 'src/agent/tool-schemas.ts', 'src/agent/tools.ts', 'src/agent/worker.ts',
      'src/agent/provider.ts', 'src/agent/provider-errors.ts', 'src/server/agent-error.ts', 'src/server/chat-http.ts']) {
      source.update(path).update(await readFile(path));
    }
    sourceFingerprint = source.digest('hex');
    await save(); reportCreated = true; // Fail before any live call if artifact cannot be written.
    await withDatabase(async () => {
      const hashingKey = randomBytes(32);
      for (const round of [1, 2, 3]) for (const spec of cases) {
        if (stopped) { records.push({ round, caseId: spec.id, outcome: 'skipped', reason: stopped }); continue; }
        if (!nextAttemptAllowed({ budgetMicros, chargedMicros: prior.chargedMicros + chargedMicros, nextReservationMicros: maximumModelCost(), previous: 'ok' })) {
          stopped = 'BUDGET_STOP'; records.push({ round, caseId: spec.id, outcome: 'skipped', reason: stopped }); continue;
        }
        const owner = await createSession(); let tripId = '';
        const context = { provider: 'gemini' as const, liveLocal: true as const, verifiedPeerAddress: '127.0.0.1', hashingKey,
          quota: { enabled: true as const, priceBasis: 'server-verified' as const, dailyBudgetMicros: budgetMicros - prior.chargedMicros, reservationTtlMs: 60000 },
          loadCredential: () => loadLiveCredential(authorized), evaluation: { catalog: [] as ReturnType<typeof import('../../evals/fixtures').evaluationInput>['catalog'], lookupTimeout: false } };
        try {
          // Preserve the same IP identity and rate window across all case sessions.
          if (lastDispatch) await delay(Math.max(0, 15000 - (Date.now() - lastDispatch)));
          const result = await collectCase(spec.id, {
            model: GEMINI_MODEL, faultSupported: true,
            setup: async input => { context.evaluation = { catalog: input.catalog, lookupTimeout: input.fault === 'catalog-timeout' };
              const trip = await createTrip(owner.id, input.before); tripId = trip.id; return trip; },
            request: async (path, body, signal) => {
              if (path.endsWith('/agent')) {
                if (prior.invocations + invocations >= CAMPAIGN_INVOCATION_LIMIT) throw new Error('EVAL_CUMULATIVE_INVOCATION_STOP');
                await delay(Math.max(0, 15000 - (Date.now() - lastDispatch)), undefined, { signal });
                lastDispatch = Date.now();
                invocations++;
              }
              return handleRequest(new Request(`http://localhost${path}`, { method: body === undefined ? 'GET' : 'POST',
                headers: { cookie: `dive_trip_session=${owner.token}`, origin: 'http://localhost', 'content-type': 'application/json' },
                body: body === undefined ? undefined : JSON.stringify(body), signal }), 'http://localhost', context);
            },
            audit: runId => auditAcceptedAnswerUsage(database(), owner.id, tripId, runId),
          });
          const unknown = !result.evidence.usageComplete || result.evidence.costMicros === null;
          records.push({ round, caseId: spec.id, outcome: result.evidence.runStatus === 'succeeded' ? 'completed' : 'failed', ...result });
          if (unknown) stopped = 'UNKNOWN_USAGE_STOP';
          else if (result.evidence.runStatus !== 'succeeded') stopped = 'FAILED_RUN_STOP';
          else if (result.grade.safetyFailures.length) stopped = 'SAFETY_EVIDENCE_STOP';
          console.info(JSON.stringify({ evaluation: 'case-finished', round, caseId: spec.id,
            status: result.evidence.runStatus, costMicros: result.evidence.costMicros, reasons: result.grade.reasons, stopped }));
        } catch (error) {
          // Do not echo provider errors/credentials. Missing accounting is never zero.
          stopped = 'EVAL_EXCEPTION_STOP';
          const code = error instanceof Error && /^EVAL_[A-Z_]+$/.test(error.message) ? error.message : 'EVAL_UNCLASSIFIED';
          records.push({ round, caseId: spec.id, outcome: 'failed', reason: code, costMicros: null });
        } finally {
          // Capture failure evidence before withDatabase removes this isolated schema.
          const runs = await database().query('SELECT id,status,proposal_id,interrupt_id,decision FROM agent_runs WHERE trip_id=$1', [tripId || '00000000-0000-0000-0000-000000000000']);
          const events = await database().query(`SELECT e.run_id,e.sequence,e.event FROM agent_run_events e JOIN agent_runs r ON r.id=e.run_id WHERE r.trip_id=$1 ORDER BY e.sequence`, [tripId || '00000000-0000-0000-0000-000000000000']);
          const total = await database().query<{ total: string }>('SELECT COALESCE(sum(charged_cost_micros),0)::text AS total FROM quota_reservations');
          chargedMicros = Number(total.rows[0].total);
          const audit = { round, caseId: spec.id, kind: 'durable-audit', runs: runs.rows, events: events.rows, chargedMicros,
            privateUsage: [] as UsageEvidence[], privateUsageComplete: false };
          records.push(audit);
          await save(); // Keep public failure evidence even if the private export fails.
          try {
            for (const run of runs.rows) audit.privateUsage.push(await exportUsageEvidence(database(), owner.id, tripId, run.id));
            audit.privateUsageComplete = true; // Export completeness, NOT usage knownness.
            await save();
          } catch {
            audit.privateUsageComplete = false;
            stopped = 'EVIDENCE_EXPORT_STOP';
            await save();
          }
        }
        if (stopped === 'EVIDENCE_EXPORT_STOP') throw new Error('EVAL_PRIVATE_USAGE_EXPORT_FAILED');
      }
    }, { retainOnFailure: true });
  } finally {
    try {
      if (reportCreated) {
        await save();
        console.info(JSON.stringify({ evaluation: 'campaign-ended', reportPath, stopped, chargedMicros, evaluationGatePassed: false }));
      }
    } finally { await lock.close(); await unlink(lockPath); }
  }
});
