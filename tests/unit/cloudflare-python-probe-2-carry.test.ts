import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import { comparePythonProbe2Carry } from '../../evals/cloudflare-python-probe-2-carry.ts';
import { recoveryAccount } from '../support/cloudflare-recovery-fixture.ts';
import { CLOUDFLARE_MODEL } from '../../src/agent/cloudflare-wire.ts';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const runId = '11111111-1111-4111-8111-111111111111';
const tripId = '22222222-2222-4222-8222-222222222222';
const ownerId = '33333333-3333-4333-8333-333333333333';
const invocationId = '44444444-4444-4444-8444-444444444444';
const reservationId = '55555555-5555-4555-8555-555555555555';
const executionRunId = '66666666-6666-4666-8666-666666666666';
const schema = 'python_test_' + '7'.repeat(32);
const storageDir = 'python-evaluation-TEST01';

function vector() {
  const profile = { schemaVersion: 1, reportSha256: hash('synthetic first probe report'),
    sourceSha256: hash('synthetic first probe source'), retainedSchema: schema, storageDir,
    contextSha256: hash('context'), temporalSha256: hash('sqlite'),
    storageFingerprint: hash('complete retained rows'), runId, tripId, ownerId,
    executionRunId, workflowId: 'synthetic-workflow' };
  const old = { sourceSha256: hash('synthetic stopped diagnostic report'), historyConsistent: true as const,
    dispatchAuthorized: false as const, accountingComplete: false as const,
    evaluationGatePassed: false as const, historicalUnknownReceipts: 5 as const,
    invocations: 45 as const, modelCalls: 67 as const, chargedMicros: 949683 as const,
    observedTokens: 285297 as const, totalTokens: null,
    remainingInvocationCeiling: 55 as const, remainingReferenceMicros: 2050317 as const };
  const events = ['RUN_STARTED', 'CUSTOM', 'RUN_ERROR'].map(type => ({ type }));
  const tokens = [1313];
  const callIds = ['one'];
  const privateUsage = { schemaVersion: 3, executor: 'temporal-v1', execution_run_id: executionRunId,
    status: 'failed', run: { runId, tripId, ownerId },
    provider: { provider: 'cloudflare', model: CLOUDFLARE_MODEL, accountId: recoveryAccount },
    invocations: [{ id: invocationId, reservation_id: reservationId, kind: 'start',
      status: 'settled', charged_cost_micros: 165, actual_cost_micros: 165 }],
    calls: callIds.map((callId, index) => ({ invocation_id: invocationId, status: 'completed',
      event: { callId, usage: { totalTokens: tokens[index] } } })),
    steps: [{ ordinal: 1, completed: true, arguments_rejected: true, argument_diagnostic: { tool: 'validate_changes', candidate_ordinal: 1, issues: [{ code: 'invalid_value', path: ['changes', '*'] }] } }],
    tools: [] };
  const report = { schemaVersion: 2, model: CLOUDFLARE_MODEL, accountId: recoveryAccount,
    prior: old, stopped: 'FAILED_RUN_STOP', diagnosticComplete: false,
    accountingComplete: false, dispatchAuthorized: false, evaluationGatePassed: false,
    historicalUnknownReceipts: 5, invocations: 1, modelCalls: 1, chargedMicros: 165,
    totalTokens: 1313, cumulativeInvocations: 46, cumulativeModelCalls: 68,
    cumulativeChargedMicros: 949848, cumulativeTokens: null,
    sourceFingerprint: profile.sourceSha256, sourceManifest: { sha256: profile.sourceSha256 },
    replays: [{ file: `cloudflare-probe-2-${runId}.replay.json`, runId,
      sha256: hash('synthetic replay'), recordedResume: false }],
    records: [{ schemaVersion: 2, round: 1, caseId: 'unknown-cost', outcome: 'failed',
      evidence: { runId, usageRunId: runId, model: CLOUDFLARE_MODEL, modelCalls: 1,
        toolCount: 0, usageComplete: true, costMicros: 165, runStatus: 'failed' }, events },
    { kind: 'durable-audit', schemaVersion: 3, executor: 'temporal-v1', round: 1,
      caseId: 'unknown-cost', retainedSchema: schema,
      temporalStorage: `.artifacts/${storageDir}/temporal.sqlite`,
      storageFingerprint: profile.storageFingerprint, chargedMicros: 165, modelCalls: 1,
      privateUsageComplete: true, quiescent: true,
      runs: [{ id: runId, trip_id: tripId, status: 'failed' }],
      events: events.map((event, index) => ({ run_id: runId, sequence: index + 1, event })),
      privateUsage: [privateUsage], nativeHistory: [{ workflow_id: profile.workflowId,
        execution_run_id: executionRunId, terminal: 'failed',
        models: ['failed'].map(terminal => ({ terminal })) }] }] };
  const database = { fingerprint: profile.storageFingerprint,
    runs: [{ id: runId, trip_id: tripId, status: 'failed' }],
    trips: [{ id: tripId, owner_id: ownerId }],
    invocations: [{ id: invocationId, run_id: runId, reservation_id: reservationId,
      provider: 'cloudflare', model: CLOUDFLARE_MODEL, account_id: recoveryAccount }],
    calls: callIds.map((call_id, index) => ({ run_id: runId, invocation_id: invocationId,
      call_id, usage: { totalTokens: tokens[index] } })),
    reservations: [{ id: reservationId, logical_run_id: runId,
      charged_cost_micros: '165', actual_cost_micros: '165' }] };
  const temporal = { workflowMatches: 1, executionMatches: 1, argumentMarkers: 1 };
  return { old, profile, report, database, temporal };
}

test('retained failed probe carries one known call and keeps five older unknown receipts', () => {
  const v = vector();
  expect(comparePythonProbe2Carry(v.old, v.profile, v.report, v.database, v.temporal))
    .toMatchObject({ historyConsistent: true, invocations: 46, modelCalls: 68,
      chargedMicros: 949848, observedTokens: 286610, historicalUnknownReceipts: 5,
      accountingComplete: false, dispatchAuthorized: false, evaluationGatePassed: false });
});

test.each(['source', 'prior', 'extra-record', 'replay', 'database-owner', 'database-row',
  'call-binding', 'rejected-step', 'native-marker', 'diagnostic', 'temporal-execution', 'database-provider', 'settlement'] as const)('%s mutation blocks the new carry', mutation => {
  const v = vector();
  const audit = v.report.records[1] as typeof v.report.records[1] & {
    privateUsage: { steps: { arguments_rejected: boolean }[] }[] };
  if (mutation === 'source') v.report.sourceFingerprint = hash('changed source');
  if (mutation === 'prior') v.report.prior = { ...v.old, modelCalls: 66 as 67 };
  if (mutation === 'extra-record') v.report.records.push({ ...v.report.records[0] });
  if (mutation === 'replay') v.report.replays[0].runId = tripId;
  if (mutation === 'database-owner') v.database.trips[0].owner_id = runId;
  if (mutation === 'database-row') v.database.fingerprint = hash('mutated original row');
  if (mutation === 'call-binding') v.database.calls[0].call_id = 'other';
  if (mutation === 'rejected-step') audit.privateUsage[0].steps[0].arguments_rejected = false;
  if (mutation === 'native-marker') v.temporal.argumentMarkers = 0;
  if (mutation === 'diagnostic') v.report.records[1].privateUsage![0].steps[0].argument_diagnostic.issues[0].code = 'kind_missing';
  if (mutation === 'temporal-execution') v.temporal.executionMatches = 0;
  if (mutation === 'database-provider') v.database.invocations[0].account_id = 'other';
  if (mutation === 'settlement') v.database.reservations[0].actual_cost_micros = '0';
  expect(() => comparePythonProbe2Carry(v.old, v.profile, v.report, v.database, v.temporal))
    .toThrow('CLOUDFLARE_PYTHON_PROBE_2_CARRY_INVALID');
});
