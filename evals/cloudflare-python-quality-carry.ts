import { isDeepStrictEqual } from 'node:util';
import { Pool } from 'pg';
import { z } from 'zod';
import { assertEvaluationLock, type EvaluationLockLease } from './live-evaluation-lock.ts';
import { assertPrivateCloudflareHistory, historyIdentity } from './cloudflare-history-profile.ts';
import { captureCloudflarePythonProbe3History, compareCloudflarePythonProbe3History,
  pythonProbe3CarrySchema } from './cloudflare-python-probe-3-carry.ts';
import { pythonProbeProfileSchema, readPinnedPythonProbeProfile,
  capturePinnedPythonProbeFiles } from './cloudflare-python-probe-carry.ts';
import { capturePythonRetainedDatabase } from './cloudflare-python-retained-database.ts';
import { probeReplayFromReport } from './cloudflare-probe-replay.ts';
import { CLOUDFLARE_MODEL } from '../src/agent/cloudflare-wire.ts';
import { CAMPAIGN_BUDGET_MICROS, CAMPAIGN_INVOCATION_LIMIT } from './campaign-policy.ts';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.uuid();
const invalid = (): never => { throw new Error('CLOUDFLARE_PYTHON_QUALITY_CARRY_INVALID'); };
type OldCarry = z.infer<ReturnType<typeof pythonProbe3CarrySchema>>;
type CapturedDb = Awaited<ReturnType<typeof capturePythonRetainedDatabase>>;

export const pythonQualityCarrySchema = () => z.strictObject({
  sourceSha256: digest, historyConsistent: z.literal(true), dispatchAuthorized: z.literal(false),
  accountingComplete: z.literal(false), evaluationGatePassed: z.literal(false),
  historicalUnknownReceipts: z.literal(6), invocations: z.literal(48), modelCalls: z.literal(72),
  chargedMicros: z.literal(1133641), observedTokens: z.literal(291929), totalTokens: z.null(),
  remainingInvocationCeiling: z.literal(52), remainingReferenceMicros: z.literal(1866359),
});

// Original report, complete retained rows and Temporal execution were double-audited
// before creating this immutable ignored profile. This pin does not grant dispatch.
const PRIVATE_PROFILE_SHA256 = 'e53722292cc5d3660996db0f9c0a1d601293ed346b44c68af4216a5a78952995';

export function comparePythonQualityCarry(
  old: OldCarry, profileInput: unknown, reportInput: unknown,
  database: Pick<CapturedDb, 'fingerprint' | 'runs' | 'trips' | 'invocations' | 'calls' | 'reservations'>,
  temporal: { workflowMatches: number; executionMatches: number; argumentMarkers: number; responseMarkers: number },
) {
  try {
    const profile = pythonProbeProfileSchema.parse(profileInput);
    const report = z.object({
      schemaVersion: z.literal(2), model: z.literal(CLOUDFLARE_MODEL),
      accountId: z.literal(historyIdentity('accountId_1')),
      prior: pythonProbe3CarrySchema(), stopped: z.literal('UNKNOWN_USAGE_STOP'),
      accountingComplete: z.literal(false), dispatchAuthorized: z.literal(false),
      evaluationGatePassed: z.literal(false), textReview: z.literal('pending'),
      historicalUnknownReceipts: z.literal(5), invocations: z.literal(1), modelCalls: z.literal(2),
      chargedMicros: z.literal(183505), totalTokens: z.null(),
      cumulativeInvocations: z.literal(48), cumulativeModelCalls: z.literal(72),
      cumulativeChargedMicros: z.literal(1133641), cumulativeTokens: z.null(),
      sourceFingerprint: digest, sourceManifest: z.object({ sha256: digest }),
      records: z.array(z.unknown()).length(31),
    }).parse(reportInput);
    const replayRef = probeReplayFromReport(reportInput, 'cloudflare-python-quality');
    if (!isDeepStrictEqual(report.prior, old) || report.sourceFingerprint !== profile.sourceSha256
      || report.sourceManifest.sha256 !== profile.sourceSha256 || replayRef.runId !== profile.runId
      || old.invocations + report.invocations !== report.cumulativeInvocations
      || old.modelCalls + report.modelCalls !== report.cumulativeModelCalls
      || old.chargedMicros + report.chargedMicros !== report.cumulativeChargedMicros) invalid();
    const eventTypes = ['RUN_STARTED', 'TOOL_CALL_START', 'TOOL_CALL_END', 'TOOL_CALL_RESULT', 'CUSTOM', 'RUN_ERROR'];
    const attempt = z.object({ schemaVersion: z.literal(2), round: z.literal(1),
      caseId: z.literal('unknown-cost'), outcome: z.literal('failed'),
      evidence: z.object({ runId: z.literal(profile.runId), usageRunId: z.literal(profile.runId),
        model: z.literal(CLOUDFLARE_MODEL), modelCalls: z.literal(2), toolCount: z.literal(1),
        usageComplete: z.literal(false), costMicros: z.null(), runStatus: z.literal('failed'),
        proposalId: z.null(), decision: z.literal('none'), beforeVersion: z.number().int(),
        afterVersion: z.number().int(), before: z.unknown(), after: z.unknown() }),
      events: z.array(z.object({ type: z.string() })).length(6),
    }).parse(report.records[0]);
    const audit = z.object({ kind: z.literal('durable-audit'), schemaVersion: z.literal(3),
      executor: z.literal('temporal-v1'), round: z.literal(1), caseId: z.literal('unknown-cost'),
      retainedSchema: z.literal(profile.retainedSchema),
      temporalStorage: z.literal(`.artifacts/${profile.storageDir}/temporal.sqlite`),
      storageFingerprint: z.literal(profile.storageFingerprint), chargedMicros: z.literal(183505),
      modelCalls: z.literal(2), privateUsageComplete: z.literal(true), quiescent: z.literal(true),
      runs: z.array(z.object({ id: z.literal(profile.runId), trip_id: z.literal(profile.tripId),
        status: z.literal('failed') })).length(1),
      events: z.array(z.object({ run_id: z.literal(profile.runId), sequence: z.number().int().positive() })).length(6),
      privateUsage: z.array(z.object({ schemaVersion: z.literal(3), executor: z.literal('temporal-v1'),
        execution_run_id: z.literal(profile.executionRunId), status: z.literal('failed'),
        run: z.object({ runId: z.literal(profile.runId), tripId: z.literal(profile.tripId),
          ownerId: z.literal(profile.ownerId) }),
        provider: z.object({ provider: z.literal('cloudflare'), model: z.literal(CLOUDFLARE_MODEL),
          accountId: z.literal(historyIdentity('accountId_1')) }),
        invocations: z.array(z.object({ id: uuid, reservation_id: uuid, kind: z.literal('start'),
          status: z.literal('settled'), charged_cost_micros: z.literal(183505),
          actual_cost_micros: z.null() })).length(1),
        calls: z.array(z.object({ invocation_id: uuid, status: z.literal('completed'),
          event: z.object({ callId: z.string().min(1), usage: z.object({ totalTokens: z.number().int().positive() }) }) })).length(2),
        steps: z.array(z.object({ ordinal: z.number().int().positive(), completed: z.boolean(),
          arguments_rejected: z.literal(false), argument_diagnostic: z.null() })).length(2),
        tools: z.tuple([z.object({ name: z.literal('calculate_budget'), ordinal: z.literal(1), completed: z.literal(true) })]),
      })).length(1),
      nativeHistory: z.array(z.object({ workflow_id: z.literal(profile.workflowId),
        execution_run_id: z.literal(profile.executionRunId), terminal: z.literal('failed'),
        models: z.array(z.object({ terminal: z.string() })).length(2) })).length(1),
    }).parse(report.records[1]);
    const skipped = report.records.slice(2).map(row => z.object({ round: z.number().int(), caseId: z.string(), outcome: z.literal('skipped') }).parse(row));
    // Bound to the stopped 44e0ae9 campaign, independent of future cases.json.
    const historicalCases = ['ambiguous', 'non-diver', 'locked-budget', 'free-afternoon',
      'more-people', 'unknown-cost', 'no-date', 'source-injection', 'lookup-timeout', 'impossible'];
    const expected = [{ round: 1, caseId: 'no-date', outcome: 'skipped' },
      ...[1, 2, 3].flatMap(round => historicalCases.filter(id => round !== 1 || !['unknown-cost', 'no-date'].includes(id)).map(caseId => ({ round, caseId, outcome: 'skipped' })))];
    if (!isDeepStrictEqual(skipped, expected)) invalid();
    const usage = audit.privateUsage[0];
    if (!isDeepStrictEqual(attempt.events.map(value => value.type), eventTypes)
      || audit.events.some((row, index) => row.sequence !== index + 1)
      || !isDeepStrictEqual(usage.steps.map(row => [row.ordinal, row.completed, row.arguments_rejected]),
        [[1, true, false], [2, false, false]])
      || !isDeepStrictEqual(audit.nativeHistory[0].models.map(row => row.terminal),
        ['completed', 'failed'])
      || usage.calls.some(row => row.invocation_id !== usage.invocations[0].id)
      || new Set(usage.calls.map(row => row.event.callId)).size !== 2
      || usage.calls.reduce((sum, row) => sum + row.event.usage.totalTokens, 0) !== 2702
      || database.fingerprint !== profile.storageFingerprint
      || database.runs.length !== 1 || database.trips.length !== 1
      || database.invocations.length !== 1 || database.calls.length !== 2
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
      || database.reservations[0].charged_cost_micros !== '183505'
      || database.reservations[0].actual_cost_micros !== null
      || database.calls.some((row, index) => row.run_id !== profile.runId
        || row.invocation_id !== usage.invocations[0].id
        || row.call_id !== usage.calls[index].event.callId || row.usage === null)
      || temporal.workflowMatches !== 1 || temporal.executionMatches !== 1
      || temporal.argumentMarkers !== 0 || temporal.responseMarkers !== 1
      || attempt.evidence.beforeVersion !== attempt.evidence.afterVersion
      || !isDeepStrictEqual(attempt.evidence.before, attempt.evidence.after)) invalid();
    return Object.freeze({ sourceSha256: profile.reportSha256, historyConsistent: true as const,
      dispatchAuthorized: false as const, accountingComplete: false as const,
      evaluationGatePassed: false as const, historicalUnknownReceipts: 6 as const,
      invocations: report.cumulativeInvocations, modelCalls: report.cumulativeModelCalls,
      chargedMicros: report.cumulativeChargedMicros, observedTokens: old.observedTokens + 2702,
      totalTokens: null, remainingInvocationCeiling: CAMPAIGN_INVOCATION_LIMIT - report.cumulativeInvocations,
      remainingReferenceMicros: CAMPAIGN_BUDGET_MICROS - report.cumulativeChargedMicros });
  } catch { return invalid(); }
}

/** One complete capture; the outer reader owns the double read. */
export async function captureCloudflarePythonQualityHistory(pools: Pool[], lease: EvaluationLockLease) {
  if (pools.length !== 8) invalid();
      const pinned = await readPinnedPythonProbeProfile(lease, {
        file: 'cloudflare-python-quality-history.json', sha256: PRIVATE_PROFILE_SHA256 });
      const history = await captureCloudflarePythonProbe3History(pools, lease);
      const files = await capturePinnedPythonProbeFiles(pinned.profile, lease, 'cloudflare-python-quality');
      const pool = new Pool({ host: '127.0.0.1', port: pools[0].options.port,
        database: 'dive_trip_test', user: 'postgres', password: 'offline-placeholder-not-a-credential',
        ssl: false, connectionTimeoutMillis: 2000, statement_timeout: 2000, max: 1,
        options: `-c search_path=${pinned.profile.retainedSchema}` });
      try {
        const database = await capturePythonRetainedDatabase(pool, pinned.profile, 2);
        await assertEvaluationLock(lease);
        return { pinned, history, files, database };
      } finally { await pool.end(); }
}
export function compareCloudflarePythonQualityHistory(value: Awaited<ReturnType<typeof captureCloudflarePythonQualityHistory>>) {
  return pythonQualityCarrySchema().parse(comparePythonQualityCarry(
    compareCloudflarePythonProbe3History(value.history), value.pinned.profile,
    value.files.report.value, value.database, value.files.temporal.native));
}

/** Two complete captures of all thirteen scopes; lower readers capture once. */
export async function readCloudflarePythonQualityCarry(pools: Pool[], lease: EvaluationLockLease) {
  try {
    const before = await captureCloudflarePythonQualityHistory(pools, lease);
    compareCloudflarePythonQualityHistory(before);
    const after = await captureCloudflarePythonQualityHistory(pools, lease);
    if (!isDeepStrictEqual(before, after)) invalid();
    const result = compareCloudflarePythonQualityHistory(after);
    await assertPrivateCloudflareHistory();
    await assertEvaluationLock(lease);
    return result;
  } catch { return invalid(); }
}
