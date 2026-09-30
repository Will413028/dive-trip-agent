import { isDeepStrictEqual } from 'node:util';
import { Pool } from 'pg';
import { z } from 'zod';
import { assertEvaluationLock, type EvaluationLockLease } from './live-evaluation-lock.ts';
import { assertPrivateCloudflareHistory, historyIdentity } from './cloudflare-history-profile.ts';
import { captureCloudflarePythonProbeHistory, compareCloudflarePythonProbeHistory,
  pythonProbeCarrySchema, pythonProbeProfileSchema, readPinnedPythonProbeProfile,
  capturePinnedPythonProbeFiles } from './cloudflare-python-probe-carry.ts';
import { capturePythonRetainedDatabase } from './cloudflare-python-retained-database.ts';
import { probeReplayFromReport } from './cloudflare-probe-replay.ts';
import { CLOUDFLARE_MODEL } from '../src/agent/cloudflare-wire.ts';
import { CAMPAIGN_BUDGET_MICROS, CAMPAIGN_INVOCATION_LIMIT } from './campaign-policy.ts';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.uuid();
const invalid = (): never => { throw new Error('CLOUDFLARE_PYTHON_PROBE_2_CARRY_INVALID'); };
type OldCarry = z.infer<ReturnType<typeof pythonProbeCarrySchema>>;
type CapturedDb = Awaited<ReturnType<typeof capturePythonRetainedDatabase>>;

export const pythonProbe2CarrySchema = () => z.strictObject({
  sourceSha256: digest, historyConsistent: z.literal(true), dispatchAuthorized: z.literal(false),
  accountingComplete: z.literal(false), evaluationGatePassed: z.literal(false),
  historicalUnknownReceipts: z.literal(5), invocations: z.literal(46), modelCalls: z.literal(68),
  chargedMicros: z.literal(949848), observedTokens: z.literal(286610), totalTokens: z.null(),
  remainingInvocationCeiling: z.literal(54), remainingReferenceMicros: z.literal(2050152),
});

// Original report, complete retained rows and Temporal execution were double-audited
// before creating this immutable ignored profile. This pin does not grant dispatch.
const PRIVATE_PROFILE_SHA256 = '573d70e501b5c6e13082186cc35c1562779068f53d0945ba4c1b97672747c684';

export function comparePythonProbe2Carry(
  old: OldCarry, profileInput: unknown, reportInput: unknown,
  database: Pick<CapturedDb, 'fingerprint' | 'runs' | 'trips' | 'invocations' | 'calls' | 'reservations'>,
  temporal: { workflowMatches: number; executionMatches: number; argumentMarkers: number },
) {
  try {
    const profile = pythonProbeProfileSchema.parse(profileInput);
    const report = z.object({
      schemaVersion: z.literal(2), model: z.literal(CLOUDFLARE_MODEL),
      accountId: z.literal(historyIdentity('accountId_1')),
      prior: pythonProbeCarrySchema(), stopped: z.literal('FAILED_RUN_STOP'),
      accountingComplete: z.literal(false), dispatchAuthorized: z.literal(false),
      evaluationGatePassed: z.literal(false), diagnosticComplete: z.literal(false),
      historicalUnknownReceipts: z.literal(5), invocations: z.literal(1), modelCalls: z.literal(1),
      chargedMicros: z.literal(165), totalTokens: z.literal(1313),
      cumulativeInvocations: z.literal(46), cumulativeModelCalls: z.literal(68),
      cumulativeChargedMicros: z.literal(949848), cumulativeTokens: z.null(),
      sourceFingerprint: digest, sourceManifest: z.object({ sha256: digest }),
      records: z.array(z.unknown()).length(2),
    }).parse(reportInput);
    const replayRef = probeReplayFromReport(reportInput, 'cloudflare-probe-2');
    if (!isDeepStrictEqual(report.prior, old) || report.sourceFingerprint !== profile.sourceSha256
      || report.sourceManifest.sha256 !== profile.sourceSha256 || replayRef.runId !== profile.runId
      || old.invocations + report.invocations !== report.cumulativeInvocations
      || old.modelCalls + report.modelCalls !== report.cumulativeModelCalls
      || old.chargedMicros + report.chargedMicros !== report.cumulativeChargedMicros) invalid();
    const eventTypes = ['RUN_STARTED', 'CUSTOM', 'RUN_ERROR'];
    const attempt = z.object({ schemaVersion: z.literal(2), round: z.literal(1),
      caseId: z.literal('unknown-cost'), outcome: z.literal('failed'),
      evidence: z.object({ runId: z.literal(profile.runId), usageRunId: z.literal(profile.runId),
        model: z.literal(CLOUDFLARE_MODEL), modelCalls: z.literal(1), toolCount: z.literal(0),
        usageComplete: z.literal(true), costMicros: z.literal(165), runStatus: z.literal('failed') }),
      events: z.array(z.object({ type: z.string() })).length(3),
    }).parse(report.records[0]);
    const audit = z.object({ kind: z.literal('durable-audit'), schemaVersion: z.literal(3),
      executor: z.literal('temporal-v1'), round: z.literal(1), caseId: z.literal('unknown-cost'),
      retainedSchema: z.literal(profile.retainedSchema),
      temporalStorage: z.literal(`.artifacts/${profile.storageDir}/temporal.sqlite`),
      storageFingerprint: z.literal(profile.storageFingerprint), chargedMicros: z.literal(165),
      modelCalls: z.literal(1), privateUsageComplete: z.literal(true), quiescent: z.literal(true),
      runs: z.array(z.object({ id: z.literal(profile.runId), trip_id: z.literal(profile.tripId),
        status: z.literal('failed') })).length(1),
      events: z.array(z.object({ run_id: z.literal(profile.runId), sequence: z.number().int().positive() })).length(3),
      privateUsage: z.array(z.object({ schemaVersion: z.literal(3), executor: z.literal('temporal-v1'),
        execution_run_id: z.literal(profile.executionRunId), status: z.literal('failed'),
        run: z.object({ runId: z.literal(profile.runId), tripId: z.literal(profile.tripId),
          ownerId: z.literal(profile.ownerId) }),
        provider: z.object({ provider: z.literal('cloudflare'), model: z.literal(CLOUDFLARE_MODEL),
          accountId: z.literal(historyIdentity('accountId_1')) }),
        invocations: z.array(z.object({ id: uuid, reservation_id: uuid, kind: z.literal('start'),
          status: z.literal('settled'), charged_cost_micros: z.literal(165),
          actual_cost_micros: z.literal(165) })).length(1),
        calls: z.array(z.object({ invocation_id: uuid, status: z.literal('completed'),
          event: z.object({ callId: z.string().min(1), usage: z.object({ totalTokens: z.number().int().positive() }) }) })).length(1),
        steps: z.array(z.object({ ordinal: z.number().int().positive(), completed: z.boolean(),
          arguments_rejected: z.boolean(), argument_diagnostic: z.strictObject({
            tool: z.literal('validate_changes'), candidate_ordinal: z.literal(1),
            issues: z.tuple([z.strictObject({ code: z.literal('invalid_value'),
              path: z.tuple([z.literal('changes'), z.literal('*')]) })]),
          }) })).length(1),
        tools: z.array(z.unknown()).length(0),
      })).length(1),
      nativeHistory: z.array(z.object({ workflow_id: z.literal(profile.workflowId),
        execution_run_id: z.literal(profile.executionRunId), terminal: z.literal('failed'),
        models: z.array(z.object({ terminal: z.string() })).length(1) })).length(1),
    }).parse(report.records[1]);
    const usage = audit.privateUsage[0];
    if (!isDeepStrictEqual(attempt.events.map(value => value.type), eventTypes)
      || audit.events.some((row, index) => row.sequence !== index + 1)
      || !isDeepStrictEqual(usage.steps.map(row => [row.ordinal, row.completed, row.arguments_rejected]),
        [[1, true, true]])
      || !isDeepStrictEqual(audit.nativeHistory[0].models.map(row => row.terminal),
        ['failed'])
      || usage.calls.some(row => row.invocation_id !== usage.invocations[0].id)
      || new Set(usage.calls.map(row => row.event.callId)).size !== 1
      || usage.calls.reduce((sum, row) => sum + row.event.usage.totalTokens, 0) !== 1313
      || database.fingerprint !== profile.storageFingerprint
      || database.runs.length !== 1 || database.trips.length !== 1
      || database.invocations.length !== 1 || database.calls.length !== 1
      || database.reservations.length !== 1
      || database.runs[0].id !== profile.runId || database.runs[0].trip_id !== profile.tripId
      || database.runs[0].status !== 'failed' || database.trips[0].id !== profile.tripId
      || database.trips[0].owner_id !== profile.ownerId
      || database.invocations[0].id !== usage.invocations[0].id
      || database.invocations[0].run_id !== profile.runId
      || database.invocations[0].provider !== 'cloudflare'
      || database.invocations[0].model !== CLOUDFLARE_MODEL
      || database.invocations[0].account_id !== historyIdentity('accountId_1')
      || database.invocations[0].reservation_id !== usage.invocations[0].reservation_id
      || database.reservations[0].id !== usage.invocations[0].reservation_id
      || database.reservations[0].logical_run_id !== profile.runId
      || database.reservations[0].charged_cost_micros !== '165'
      || database.reservations[0].actual_cost_micros !== '165'
      || database.calls.some((row, index) => row.run_id !== profile.runId
        || row.invocation_id !== usage.invocations[0].id
        || row.call_id !== usage.calls[index].event.callId || row.usage === null)
      || temporal.workflowMatches !== 1 || temporal.executionMatches !== 1
      || temporal.argumentMarkers !== 1) invalid();
    return Object.freeze({ sourceSha256: profile.reportSha256, historyConsistent: true as const,
      dispatchAuthorized: false as const, accountingComplete: false as const,
      evaluationGatePassed: false as const, historicalUnknownReceipts: 5 as const,
      invocations: report.cumulativeInvocations, modelCalls: report.cumulativeModelCalls,
      chargedMicros: report.cumulativeChargedMicros, observedTokens: old.observedTokens + report.totalTokens,
      totalTokens: null, remainingInvocationCeiling: CAMPAIGN_INVOCATION_LIMIT - report.cumulativeInvocations,
      remainingReferenceMicros: CAMPAIGN_BUDGET_MICROS - report.cumulativeChargedMicros });
  } catch { return invalid(); }
}

/** Two complete captures of all eleven scopes; lower readers capture once. */
export async function readCloudflarePythonProbe2Carry(pools: Pool[], lease: EvaluationLockLease) {
  try {
    if (pools.length !== 8) invalid();
    const capture = async () => {
      const pinned = await readPinnedPythonProbeProfile(lease, {
        file: 'cloudflare-python-probe-2-history.json', sha256: PRIVATE_PROFILE_SHA256 });
      const history = await captureCloudflarePythonProbeHistory(pools, lease);
      const files = await capturePinnedPythonProbeFiles(pinned.profile, lease, 'cloudflare-probe-2');
      const pool = new Pool({ host: '127.0.0.1', port: pools[0].options.port,
        database: 'dive_trip_test', user: 'postgres', password: 'offline-placeholder-not-a-credential',
        ssl: false, connectionTimeoutMillis: 2000, statement_timeout: 2000, max: 1,
        options: `-c search_path=${pinned.profile.retainedSchema}` });
      try {
        const database = await capturePythonRetainedDatabase(pool, pinned.profile, 1);
        await assertEvaluationLock(lease);
        return { pinned, history, files, database };
      } finally { await pool.end(); }
    };
    const compare = (value: Awaited<ReturnType<typeof capture>>) => pythonProbe2CarrySchema().parse(
      comparePythonProbe2Carry(compareCloudflarePythonProbeHistory(value.history), value.pinned.profile,
        value.files.report.value, value.database, value.files.temporal.native));
    const before = await capture();
    compare(before);
    const after = await capture();
    if (!isDeepStrictEqual(before, after)) invalid();
    const result = compare(after);
    await assertPrivateCloudflareHistory();
    await assertEvaluationLock(lease);
    return result;
  } catch { return invalid(); }
}
