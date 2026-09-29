import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Pool } from 'pg';
import { z } from 'zod';
import { withBoundedArtifactDirectory } from './bounded-artifact-file.ts';
import { assertEvaluationLock, type EvaluationLockLease } from './live-evaluation-lock.ts';
import { assertPrivateCloudflareHistory, historyIdentity } from './cloudflare-history-profile.ts';
import { captureCloudflarePythonDiagnosticHistory, compareCloudflarePythonDiagnosticHistory,
  pythonDiagnosticCarrySchema } from './cloudflare-python-diagnostic-carry.ts';
import { capturePythonRetainedDatabase } from './cloudflare-python-retained-database.ts';
import { probeReplayFromReport } from './cloudflare-probe-replay.ts';
import { CLOUDFLARE_MODEL } from '../src/agent/cloudflare-wire.ts';
import { CAMPAIGN_BUDGET_MICROS, CAMPAIGN_INVOCATION_LIMIT } from './campaign-policy.ts';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.uuid();
const profileSchema = z.strictObject({
  schemaVersion: z.literal(1), reportSha256: digest, sourceSha256: digest,
  retainedSchema: z.string().regex(/^python_test_[a-f0-9]{32}$/),
  storageDir: z.string().regex(/^python-evaluation-[A-Za-z0-9]{6,32}$/),
  contextSha256: digest, temporalSha256: digest, storageFingerprint: digest,
  runId: uuid, tripId: uuid, ownerId: uuid, executionRunId: uuid,
  workflowId: z.string().min(1).max(128),
});
export type PythonProbeProfile = z.infer<typeof profileSchema>;
export const pythonProbeCarrySchema = () => z.strictObject({
  sourceSha256: digest, historyConsistent: z.literal(true), dispatchAuthorized: z.literal(false),
  accountingComplete: z.literal(false), evaluationGatePassed: z.literal(false),
  historicalUnknownReceipts: z.literal(5), invocations: z.literal(45), modelCalls: z.literal(67),
  chargedMicros: z.literal(949683), observedTokens: z.literal(285297), totalTokens: z.null(),
  remainingInvocationCeiling: z.literal(55), remainingReferenceMicros: z.literal(2050317),
});

// Filled only after the stopped probe's original report, every retained row,
// and Temporal history are audited. This private pin is not a dispatch grant.
const PRIVATE_PYTHON_PROBE_PROFILE_SHA256 = 'cca7f4e2e0618c3a9da844643e8607a5deb7b0b54a05d0a669dc5ecc781fa72c';
const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const artifacts = join(root, '.artifacts');
const invalid = (): never => { throw new Error('CLOUDFLARE_PYTHON_PROBE_CARRY_INVALID'); };
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
type OldCarry = z.infer<ReturnType<typeof pythonDiagnosticCarrySchema>>;
type CapturedDb = Awaited<ReturnType<typeof capturePythonRetainedDatabase>>;

/** The first probe is failed evidence, never a quality pass or a fresh quota. */
export function comparePythonProbeCarry(
  old: OldCarry, profileInput: unknown, reportInput: unknown,
  database: Pick<CapturedDb, 'fingerprint' | 'runs' | 'trips' | 'invocations' | 'calls' | 'reservations'>,
  temporal: { workflowMatches: number; executionMatches: number; argumentMarkers: number },
) {
  try {
    const profile = profileSchema.parse(profileInput);
    const report = z.object({
      schemaVersion: z.literal(2), model: z.literal(CLOUDFLARE_MODEL),
      accountId: z.literal(historyIdentity('accountId_1')),
      prior: pythonDiagnosticCarrySchema(), stopped: z.literal('FAILED_RUN_STOP'),
      accountingComplete: z.literal(false), dispatchAuthorized: z.literal(false),
      evaluationGatePassed: z.literal(false), diagnosticComplete: z.literal(false),
      historicalUnknownReceipts: z.literal(5), invocations: z.literal(1), modelCalls: z.literal(4),
      chargedMicros: z.literal(684), totalTokens: z.literal(6126),
      cumulativeInvocations: z.literal(45), cumulativeModelCalls: z.literal(67),
      cumulativeChargedMicros: z.literal(949683), cumulativeTokens: z.null(),
      sourceFingerprint: digest, sourceManifest: z.object({ sha256: digest }),
      records: z.array(z.unknown()).length(2),
    }).parse(reportInput);
    const replayRef = probeReplayFromReport(reportInput);
    if (!isDeepStrictEqual(report.prior, old) || report.sourceFingerprint !== profile.sourceSha256
      || report.sourceManifest.sha256 !== profile.sourceSha256 || replayRef.runId !== profile.runId
      || old.invocations + report.invocations !== report.cumulativeInvocations
      || old.modelCalls + report.modelCalls !== report.cumulativeModelCalls
      || old.chargedMicros + report.chargedMicros !== report.cumulativeChargedMicros) invalid();
    const eventTypes = ['RUN_STARTED', 'TOOL_CALL_START', 'TOOL_CALL_END', 'TOOL_CALL_RESULT',
      'TOOL_CALL_START', 'TOOL_CALL_END', 'TOOL_CALL_RESULT', 'TOOL_CALL_START',
      'TOOL_CALL_END', 'TOOL_CALL_RESULT', 'CUSTOM', 'RUN_ERROR'];
    const attempt = z.object({ schemaVersion: z.literal(2), round: z.literal(1),
      caseId: z.literal('unknown-cost'), outcome: z.literal('failed'),
      evidence: z.object({ runId: z.literal(profile.runId), usageRunId: z.literal(profile.runId),
        model: z.literal(CLOUDFLARE_MODEL), modelCalls: z.literal(4), toolCount: z.literal(3),
        usageComplete: z.literal(true), costMicros: z.literal(684), runStatus: z.literal('failed') }),
      events: z.array(z.object({ type: z.string() })).length(12),
    }).parse(report.records[0]);
    const audit = z.object({ kind: z.literal('durable-audit'), schemaVersion: z.literal(3),
      executor: z.literal('temporal-v1'), round: z.literal(1), caseId: z.literal('unknown-cost'),
      retainedSchema: z.literal(profile.retainedSchema),
      temporalStorage: z.literal(`.artifacts/${profile.storageDir}/temporal.sqlite`),
      storageFingerprint: z.literal(profile.storageFingerprint), chargedMicros: z.literal(684),
      modelCalls: z.literal(4), privateUsageComplete: z.literal(true), quiescent: z.literal(true),
      runs: z.array(z.object({ id: z.literal(profile.runId), trip_id: z.literal(profile.tripId),
        status: z.literal('failed') })).length(1),
      events: z.array(z.object({ run_id: z.literal(profile.runId), sequence: z.number().int().positive() })).length(12),
      privateUsage: z.array(z.object({ schemaVersion: z.literal(3), executor: z.literal('temporal-v1'),
        execution_run_id: z.literal(profile.executionRunId), status: z.literal('failed'),
        run: z.object({ runId: z.literal(profile.runId), tripId: z.literal(profile.tripId),
          ownerId: z.literal(profile.ownerId) }),
        provider: z.object({ provider: z.literal('cloudflare'), model: z.literal(CLOUDFLARE_MODEL),
          accountId: z.literal(historyIdentity('accountId_1')) }),
        invocations: z.array(z.object({ id: uuid, reservation_id: uuid, kind: z.literal('start'),
          status: z.literal('settled'), charged_cost_micros: z.literal(684),
          actual_cost_micros: z.literal(684) })).length(1),
        calls: z.array(z.object({ invocation_id: uuid, status: z.literal('completed'),
          event: z.object({ callId: z.string().min(1), usage: z.object({ totalTokens: z.number().int().positive() }) }) })).length(4),
        steps: z.array(z.object({ ordinal: z.number().int().positive(), completed: z.boolean(),
          arguments_rejected: z.boolean() })).length(4),
        tools: z.array(z.object({ name: z.literal('validate_changes'), completed: z.literal(true) })).length(3),
      })).length(1),
      nativeHistory: z.array(z.object({ workflow_id: z.literal(profile.workflowId),
        execution_run_id: z.literal(profile.executionRunId), terminal: z.literal('failed'),
        models: z.array(z.object({ terminal: z.string() })).length(4) })).length(1),
    }).parse(report.records[1]);
    const usage = audit.privateUsage[0];
    if (!isDeepStrictEqual(attempt.events.map(value => value.type), eventTypes)
      || audit.events.some((row, index) => row.sequence !== index + 1)
      || !isDeepStrictEqual(usage.steps.map(row => [row.ordinal, row.completed, row.arguments_rejected]),
        [[1, true, false], [2, true, false], [3, true, false], [4, true, true]])
      || !isDeepStrictEqual(audit.nativeHistory[0].models.map(row => row.terminal),
        ['completed', 'completed', 'completed', 'failed'])
      || usage.calls.some(row => row.invocation_id !== usage.invocations[0].id)
      || new Set(usage.calls.map(row => row.event.callId)).size !== 4
      || usage.calls.reduce((sum, row) => sum + row.event.usage.totalTokens, 0) !== 6126
      || database.fingerprint !== profile.storageFingerprint
      || database.runs.length !== 1 || database.trips.length !== 1
      || database.invocations.length !== 1 || database.calls.length !== 4
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
      || database.reservations[0].charged_cost_micros !== '684'
      || database.reservations[0].actual_cost_micros !== '684'
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

async function readProfile(lease: EvaluationLockLease) {
  await assertPrivateCloudflareHistory();
  await assertEvaluationLock(lease);
  return withBoundedArtifactDirectory([root, artifacts], async directory => {
    const file = await directory.read('cloudflare-python-probe-history.json', { minBytes: 1, maxBytes: 8192 });
    if (sha256(file.bytes) !== PRIVATE_PYTHON_PROBE_PROFILE_SHA256) invalid();
    return { profile: profileSchema.parse(JSON.parse(file.bytes.toString('utf8'))),
      directory: directory.snapshot, file: file.snapshot };
  });
}

async function captureFiles(profile: PythonProbeProfile, lease: EvaluationLockLease) {
  await assertEvaluationLock(lease);
  const report = await withBoundedArtifactDirectory([root, artifacts], async directory => {
    const claim = await directory.read('cloudflare-probe.claim', { minBytes: 0, maxBytes: 0 });
    const file = await directory.read('cloudflare-probe.json', { minBytes: 1, maxBytes: 2_000_000 });
    if (sha256(file.bytes) !== profile.reportSha256) invalid();
    const value = JSON.parse(file.bytes.toString('utf8')) as unknown;
    const replayRef = probeReplayFromReport(value);
    if (replayRef.runId !== profile.runId) invalid();
    const oldName = (name: string) => name.startsWith('cloudflare-probe')
      && !/^cloudflare-probe-2(?:\.|-)/.test(name);
    const expected = ['cloudflare-probe.claim', 'cloudflare-probe.json', replayRef.file].sort();
    if (!isDeepStrictEqual((await readdir(artifacts)).filter(oldName).sort(), expected)) invalid();
    const replay = await directory.read(replayRef.file, { minBytes: 1, maxBytes: 2_000_000 });
    if (sha256(replay.bytes) !== replayRef.sha256
      || !isDeepStrictEqual((await readdir(artifacts)).filter(oldName).sort(), expected)) invalid();
    return { value, claim: claim.snapshot, file: file.snapshot, replay: replay.snapshot,
      directory: directory.snapshot };
  });
  const path = join(artifacts, profile.storageDir);
  const temporal = await withBoundedArtifactDirectory([root, artifacts, path], async directory => {
    if (!isDeepStrictEqual((await readdir(path)).sort(), ['context.json', 'temporal.sqlite'])) invalid();
    const context = await directory.read('context.json', { minBytes: 1, maxBytes: 512 });
    const sqlite = await directory.read('temporal.sqlite', { minBytes: 1, maxBytes: 16_000_000 });
    const parsedContext = z.strictObject({ schema: z.literal(profile.retainedSchema),
      databasePort: z.number().int().min(1).max(65535) }).parse(JSON.parse(context.bytes.toString('utf8')));
    if (sha256(context.bytes) !== profile.contextSha256 || sha256(sqlite.bytes) !== profile.temporalSha256
      || parsedContext.schema !== profile.retainedSchema
      || !isDeepStrictEqual((await readdir(path)).sort(), ['context.json', 'temporal.sqlite'])) invalid();
    const db = new DatabaseSync(':memory:');
    try {
      db.deserialize(sqlite.bytes);
      const executions = db.prepare('SELECT workflow_id,run_id FROM executions').all() as { workflow_id: string; run_id: Uint8Array }[];
      const nodes = db.prepare('SELECT data FROM history_node').all() as { data: Uint8Array }[];
      const native = { workflowMatches: executions.filter(row => row.workflow_id === profile.workflowId).length,
        executionMatches: executions.filter(row => Buffer.from(row.run_id).equals(Buffer.from(profile.executionRunId.replaceAll('-', ''), 'hex'))).length,
        argumentMarkers: nodes.filter(row => Buffer.from(row.data).includes(Buffer.from('AGENT_TOOL_ARGUMENTS_REJECTED'))).length };
      return { native, context: context.snapshot, sqlite: sqlite.snapshot, directory: directory.snapshot };
    } finally { db.close(); }
  });
  await assertEvaluationLock(lease);
  return { report, temporal };
}

/** Two full read-only captures of all ten stopped/retained historical scopes. */
export async function readCloudflarePythonProbeCarry(pools: Pool[], lease: EvaluationLockLease) {
  try {
    if (pools.length !== 8) invalid();
    const capture = async () => {
      const pinned = await readProfile(lease);
      const history = await captureCloudflarePythonDiagnosticHistory(pools, lease);
      const files = await captureFiles(pinned.profile, lease);
      const pool = new Pool({ host: '127.0.0.1', port: pools[0].options.port,
        database: 'dive_trip_test', user: 'postgres', password: 'offline-placeholder-not-a-credential',
        ssl: false, connectionTimeoutMillis: 2000, statement_timeout: 2000, max: 1,
        options: `-c search_path=${pinned.profile.retainedSchema}` });
      try {
        const database = await capturePythonRetainedDatabase(pool, pinned.profile, 4);
        await assertEvaluationLock(lease);
        return { pinned, history, files, database };
      } finally { await pool.end(); }
    };
    const compare = (value: Awaited<ReturnType<typeof capture>>) => pythonProbeCarrySchema().parse(
      comparePythonProbeCarry(compareCloudflarePythonDiagnosticHistory(value.history), value.pinned.profile,
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
