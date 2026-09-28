import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Pool, type PoolClient, type QueryConfig } from 'pg';
import { z } from 'zod';
import { withBoundedArtifactDirectory } from './bounded-artifact-file.ts';
import { assertEvaluationLock, type EvaluationLockLease } from './live-evaluation-lock.ts';
import { assertPrivateCloudflareHistory, historyIdentity } from './cloudflare-history-profile.ts';
import { readCloudflareNonthinkingCarry } from './cloudflare-nonthinking-carry.ts';
import { nonthinkingCarrySchema } from './cloudflare-nonthinking-carry-schema.ts';
import { diagnosticReplayFromReport } from './cloudflare-diagnostic-replay.ts';
import { assertCloudflareAuditPool } from '../tests/support/cloudflare-audit-database.ts';
import { CLOUDFLARE_MODEL } from '../src/agent/cloudflare-wire.ts';
import { CAMPAIGN_BUDGET_MICROS, CAMPAIGN_INVOCATION_LIMIT } from './campaign-policy.ts';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.uuid();
const profileSchema = z.strictObject({
  schemaVersion: z.literal(1), reportSha256: digest, sourceSha256: digest,
  retainedSchema: z.string().regex(/^python_test_[a-f0-9]{32}$/),
  storageDir: z.string().regex(/^python-evaluation-[A-Za-z0-9]{6,32}$/),
  contextSha256: digest, temporalSha256: digest, storageFingerprint: digest,
  runId: uuid, tripId: uuid, ownerId: uuid, executionRunId: uuid, workflowId: z.string().min(1).max(128),
});
export type PythonDiagnosticProfile = z.infer<typeof profileSchema>;
export const pythonDiagnosticCarrySchema = () => z.strictObject({
  sourceSha256: digest, historyConsistent: z.literal(true), dispatchAuthorized: z.literal(false),
  accountingComplete: z.literal(false), evaluationGatePassed: z.literal(false),
  historicalUnknownReceipts: z.literal(5), invocations: z.literal(44), modelCalls: z.literal(63),
  chargedMicros: z.literal(948999), observedTokens: z.literal(279171), totalTokens: z.null(),
  remainingInvocationCeiling: z.literal(56), remainingReferenceMicros: z.literal(2051001),
});

// A new fixed profile adds the Python-era stopped scope without changing any
// of the eight original private history anchors. Re-pin only after an audited
// read-only capture; this hash is not an authorization or a quota reset.
const PRIVATE_PYTHON_DIAGNOSTIC_PROFILE_SHA256 = '010854d8b01e9814175deff4e63cbffbfdab732ef5f200bdb4303764b2de7558';
const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const artifacts = join(root, '.artifacts');
const invalid = (): never => { throw new Error('CLOUDFLARE_PYTHON_DIAGNOSTIC_CARRY_INVALID'); };
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

type OldCarry = z.infer<ReturnType<typeof nonthinkingCarrySchema>>;
type CapturedDb = Awaited<ReturnType<typeof captureDatabase>>;

/** A pure comparison of the pinned stopped report, full DB fingerprint, and
 * identity-bearing rows. It never regrades old model output or clears unknown. */
export function comparePythonDiagnosticCarry(
  old: OldCarry, profileInput: unknown, reportInput: unknown,
  database: Pick<CapturedDb, 'fingerprint' | 'runs' | 'trips' | 'invocations' | 'calls' | 'reservations'>,
  temporal: { workflowMatches: number; executionMatches: number; timeoutMarkers: number },
) {
  try {
    const profile = profileSchema.parse(profileInput);
    const report = z.object({
      schemaVersion: z.literal(2), model: z.literal(CLOUDFLARE_MODEL),
      accountId: z.literal(historyIdentity('accountId_1')),
      prior: nonthinkingCarrySchema(), stopped: z.literal('UNKNOWN_USAGE_STOP'),
      accountingComplete: z.literal(false), dispatchAuthorized: z.literal(false),
      evaluationGatePassed: z.literal(false), historicalUnknownReceipts: z.literal(4),
      invocations: z.literal(1), modelCalls: z.literal(2), chargedMicros: z.literal(183505),
      cumulativeInvocations: z.literal(44), cumulativeModelCalls: z.literal(63),
      cumulativeChargedMicros: z.literal(948999), totalTokens: z.null(), cumulativeTokens: z.null(),
      sourceFingerprint: digest, sourceManifest: z.object({ sha256: digest }),
      records: z.array(z.unknown()).length(31),
    }).parse(reportInput);
    const replayRef = diagnosticReplayFromReport(reportInput);
    if (!isDeepStrictEqual(report.prior, old) || report.sourceFingerprint !== profile.sourceSha256
      || report.sourceManifest.sha256 !== profile.sourceSha256
      || replayRef.runId !== profile.runId
      || old.invocations + report.invocations !== report.cumulativeInvocations
      || old.modelCalls + report.modelCalls !== report.cumulativeModelCalls
      || old.chargedMicros + report.chargedMicros !== report.cumulativeChargedMicros) invalid();

    const attempt = z.object({ schemaVersion: z.literal(2), round: z.literal(1),
      caseId: z.literal('unknown-cost'), outcome: z.literal('failed'),
      evidence: z.object({ runId: z.literal(profile.runId), usageRunId: z.literal(profile.runId),
        model: z.literal(CLOUDFLARE_MODEL), modelCalls: z.literal(2), usageComplete: z.literal(false),
        costMicros: z.null(), runStatus: z.literal('failed') }),
      events: z.array(z.object({ type: z.string() })).length(6),
    }).parse(report.records[0]);
    const audit = z.object({ kind: z.literal('durable-audit'), schemaVersion: z.literal(3),
      executor: z.literal('temporal-v1'), round: z.literal(1), caseId: z.literal('unknown-cost'),
      retainedSchema: z.literal(profile.retainedSchema),
      temporalStorage: z.literal(`.artifacts/${profile.storageDir}/temporal.sqlite`),
      storageFingerprint: z.literal(profile.storageFingerprint),
      chargedMicros: z.literal(183505), modelCalls: z.literal(2),
      privateUsageComplete: z.literal(true), quiescent: z.literal(true),
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
        calls: z.tuple([z.object({ invocation_id: uuid, status: z.literal('completed'),
          event: z.object({ callId: z.string().min(1), usage: z.object({ totalTokens: z.number().int().positive() }) }) }),
        z.object({ invocation_id: uuid, status: z.literal('completed'),
          event: z.object({ callId: z.string().min(1), usage: z.null() }) })]),
      })).length(1),
      nativeHistory: z.array(z.object({ workflow_id: z.literal(profile.workflowId),
        execution_run_id: z.literal(profile.executionRunId), terminal: z.literal('failed'),
        models: z.tuple([z.object({ terminal: z.literal('completed') }),
          z.object({ terminal: z.literal('failed') })]) })).length(1),
    }).parse(report.records[1]);
    if (!isDeepStrictEqual(attempt.events.map(value => value.type),
      ['RUN_STARTED', 'TOOL_CALL_START', 'TOOL_CALL_END', 'TOOL_CALL_RESULT', 'CUSTOM', 'RUN_ERROR'])) invalid();
    if (audit.events.some((row, index) => row.sequence !== index + 1)) invalid();
    if (report.records.slice(2).some((value, index) => {
      const parsed = z.object({ round: z.number().int(), caseId: z.string(),
        outcome: z.literal('skipped'), reason: z.literal('UNKNOWN_USAGE_STOP') }).safeParse(value);
      return !parsed.success || index >= 29;
    })) invalid();
    const usage = audit.privateUsage[0];
    if (usage.calls[0].invocation_id !== usage.invocations[0].id
      || usage.calls[1].invocation_id !== usage.invocations[0].id
      || usage.calls[0].event.callId === usage.calls[1].event.callId
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
        || row.call_id !== usage.calls[index].event.callId
        || (row.usage === null) !== (index === 1))
      || temporal.workflowMatches !== 1 || temporal.executionMatches !== 1
      || temporal.timeoutMarkers !== 1) invalid();
    return Object.freeze({ sourceSha256: profile.reportSha256, historyConsistent: true as const,
      dispatchAuthorized: false as const, accountingComplete: false as const,
      evaluationGatePassed: false as const, historicalUnknownReceipts: 5 as const,
      invocations: report.cumulativeInvocations, modelCalls: report.cumulativeModelCalls,
      chargedMicros: report.cumulativeChargedMicros,
      observedTokens: old.observedTokens + usage.calls[0].event.usage.totalTokens,
      totalTokens: null, remainingInvocationCeiling: CAMPAIGN_INVOCATION_LIMIT - report.cumulativeInvocations,
      remainingReferenceMicros: CAMPAIGN_BUDGET_MICROS - report.cumulativeChargedMicros });
  } catch { return invalid(); }
}

async function readProfile(lease: EvaluationLockLease) {
  await assertPrivateCloudflareHistory();
  await assertEvaluationLock(lease);
  return withBoundedArtifactDirectory([root, artifacts], async directory => {
    const file = await directory.read('cloudflare-python-diagnostic-history.json', { minBytes: 1, maxBytes: 8192 });
    if (sha256(file.bytes) !== PRIVATE_PYTHON_DIAGNOSTIC_PROFILE_SHA256) invalid();
    return { profile: profileSchema.parse(JSON.parse(file.bytes.toString('utf8'))),
      directory: directory.snapshot, file: file.snapshot };
  });
}

async function captureFiles(profile: PythonDiagnosticProfile, lease: EvaluationLockLease) {
  await assertEvaluationLock(lease);
  const report = await withBoundedArtifactDirectory([root, artifacts], async directory => {
    const claim = await directory.read('cloudflare-diagnostic.claim', { minBytes: 0, maxBytes: 0 });
    const file = await directory.read('cloudflare-diagnostic.json', { minBytes: 1, maxBytes: 2_000_000 });
    if (sha256(file.bytes) !== profile.reportSha256) invalid();
    const value = JSON.parse(file.bytes.toString('utf8')) as unknown;
    const replayRef = diagnosticReplayFromReport(value);
    if (replayRef.runId !== profile.runId) invalid();
    const expected = ['cloudflare-diagnostic.claim', 'cloudflare-diagnostic.json', replayRef.file].sort();
    const names = (await readdir(artifacts)).filter(name => name.startsWith('cloudflare-diagnostic')).sort();
    if (!isDeepStrictEqual(names, expected)) invalid();
    const replay = await directory.read(replayRef.file, { minBytes: 1, maxBytes: 2_000_000 });
    if (sha256(replay.bytes) !== replayRef.sha256
      || !isDeepStrictEqual((await readdir(artifacts)).filter(name => name.startsWith('cloudflare-diagnostic')).sort(), expected)) invalid();
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
        timeoutMarkers: nodes.filter(row => Buffer.from(row.data).includes(Buffer.from('AGENT_PROVIDER_TIMEOUT'))).length };
      return { native, context: context.snapshot, sqlite: sqlite.snapshot, directory: directory.snapshot };
    } finally { db.close(); }
  });
  await assertEvaluationLock(lease);
  return { report, temporal };
}

async function captureDatabase(pool: Pool, profile: PythonDiagnosticProfile) {
  assertCloudflareAuditPool(pool);
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    const selected = client;
    const query = async (text: string) => (await selected.query({ text, query_timeout: 2000 } as QueryConfig & { query_timeout: number })).rows;
    await query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await query("SET LOCAL statement_timeout = '2000ms'");
    const scope = await query('SELECT current_database() AS database,current_schema() AS schema');
    if (scope.length !== 1 || scope[0].database !== 'dive_trip_test' || scope[0].schema !== profile.retainedSchema) invalid();
    const relations = await query("SELECT relname FROM pg_class WHERE relnamespace=current_schema()::regnamespace AND relkind='r' ORDER BY relname LIMIT 33");
    if (relations.length !== 22) invalid();
    const hash = createHash('sha256');
    const raw: { name: string; rows: string[] }[] = [];
    let size = 0;
    for (const { relname } of relations) {
      if (typeof relname !== 'string') invalid();
      hash.update(relname + '\0');
      const quoted = `"${relname.replaceAll('"', '""')}"`;
      const rows = await query(`SELECT to_jsonb(t)::text AS row FROM ${quoted} t ORDER BY 1 LIMIT 10001`);
      if (rows.length > 10000) invalid();
      const values: string[] = [];
      for (const entry of rows) {
        if (typeof entry.row !== 'string') invalid();
        const bytes = Buffer.from(entry.row);
        size += bytes.length;
        if (size > 64 * 1024 * 1024) invalid();
        const length = Buffer.alloc(8);
        length.writeBigUInt64BE(BigInt(bytes.length));
        hash.update(length).update(bytes);
        values.push(entry.row);
      }
      raw.push({ name: relname, rows: values });
    }
    const runs = await query('SELECT id::text,trip_id::text,status FROM agent_runs ORDER BY id LIMIT 2');
    const trips = await query('SELECT id::text,owner_id::text FROM trips ORDER BY id LIMIT 2');
    const invocations = await query('SELECT id::text,run_id::text,reservation_id::text,provider,model,account_id FROM agent_invocations ORDER BY id LIMIT 2');
    const calls = await query('SELECT run_id::text,invocation_id::text,call_id,usage FROM model_calls ORDER BY started_at,call_id LIMIT 3');
    const reservations = await query('SELECT id::text,logical_run_id::text,charged_cost_micros::text,actual_cost_micros::text FROM quota_reservations ORDER BY id LIMIT 2');
    return { fingerprint: hash.digest('hex'), raw, runs, trips, invocations, calls, reservations };
  } catch { return invalid(); }
  finally { client?.release(true); }
}

/** Double read of all historical scopes and complete retained Python storage.
 * The shared lease and source manifest are checked again before dispatch. */
export async function readCloudflarePythonDiagnosticCarry(pools: Pool[], lease: EvaluationLockLease) {
  try {
    if (pools.length !== 8) invalid();
    const pinned = await readProfile(lease);
    const profile = pinned.profile;
    const port = pools[0].options.port;
    const pool = new Pool({ host: '127.0.0.1', port, database: 'dive_trip_test', user: 'postgres',
      password: 'offline-placeholder-not-a-credential', ssl: false,
      connectionTimeoutMillis: 2000, statement_timeout: 2000, max: 1,
      options: `-c search_path=${profile.retainedSchema}` });
    try {
    const capture = async () => {
      const old = await readCloudflareNonthinkingCarry(pools[0], pools[1], pools[2], pools[3],
        pools[4], pools[5], pools[6], pools[7], lease);
      const files = await captureFiles(profile, lease);
      const database = await captureDatabase(pool, profile);
      const carry = comparePythonDiagnosticCarry(old, profile, files.report.value, database, files.temporal.native);
      return { old, files, database, carry };
    };
    const before = await capture();
    const after = await capture();
    if (!isDeepStrictEqual(before, after)) invalid();
    if (!isDeepStrictEqual(await readProfile(lease), pinned)) invalid();
    await assertPrivateCloudflareHistory();
    await assertEvaluationLock(lease);
    return pythonDiagnosticCarrySchema().parse(after.carry);
    } finally { await pool.end(); }
  } catch { return invalid(); }
}
