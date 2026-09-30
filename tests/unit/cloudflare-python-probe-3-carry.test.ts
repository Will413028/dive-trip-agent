import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import { comparePythonProbe3Carry } from '../../evals/cloudflare-python-probe-3-carry.ts';
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
    invocations: 46 as const, modelCalls: 68 as const, chargedMicros: 949848 as const,
    observedTokens: 286610 as const, totalTokens: null,
    remainingInvocationCeiling: 54 as const, remainingReferenceMicros: 2050152 as const };
  const events = ['RUN_STARTED', 'TOOL_CALL_START', 'TOOL_CALL_END', 'TOOL_CALL_RESULT', 'TOOL_CALL_START', 'TOOL_CALL_END', 'TOOL_CALL_RESULT', 'CUSTOM', 'RUN_FINISHED'].map(type => ({ type }));
  const tokens = [1221, 1396];
  const callIds = ['one', 'two'];
  const privateUsage = { schemaVersion: 3, executor: 'temporal-v1', execution_run_id: executionRunId,
    status: 'awaiting_confirmation', run: { runId, tripId, ownerId },
    provider: { provider: 'cloudflare', model: CLOUDFLARE_MODEL, accountId: recoveryAccount },
    invocations: [{ id: invocationId, reservation_id: reservationId, kind: 'start',
      status: 'settled', charged_cost_micros: 288, actual_cost_micros: 288 }],
    calls: callIds.map((callId, index) => ({ invocation_id: invocationId, status: 'completed',
      event: { callId, usage: { totalTokens: tokens[index] } } })),
    steps: [1, 2].map(ordinal => ({ ordinal, completed: true, arguments_rejected: false, argument_diagnostic: null })),
    tools: [{ name: 'validate_changes', ordinal: 1, completed: true }, { name: 'propose_changes', ordinal: 2, completed: true }] };
  const report = { schemaVersion: 2, model: CLOUDFLARE_MODEL, accountId: recoveryAccount,
    prior: old, stopped: 'FAILED_RUN_STOP', diagnosticComplete: false,
    accountingComplete: false, dispatchAuthorized: false, evaluationGatePassed: false,
    historicalUnknownReceipts: 5, invocations: 1, modelCalls: 2, chargedMicros: 288,
    totalTokens: 2617, cumulativeInvocations: 47, cumulativeModelCalls: 70,
    cumulativeChargedMicros: 950136, cumulativeTokens: null,
    sourceFingerprint: profile.sourceSha256, sourceManifest: { sha256: profile.sourceSha256 },
    replays: [{ file: `cloudflare-probe-3-${runId}.replay.json`, runId,
      sha256: hash('synthetic replay'), recordedResume: false }],
    records: [{ schemaVersion: 2, round: 1, caseId: 'unknown-cost', outcome: 'failed',
      grade: { pass: false, safetyFailures: ['UNEXPECTED_SIDE_EFFECT'] },
      evidence: { runId, usageRunId: runId, model: CLOUDFLARE_MODEL, modelCalls: 2,
        toolCount: 2, usageComplete: true, costMicros: 288, runStatus: 'awaiting_confirmation' }, events },
    { kind: 'durable-audit', schemaVersion: 3, executor: 'temporal-v1', round: 1,
      caseId: 'unknown-cost', retainedSchema: schema,
      temporalStorage: `.artifacts/${storageDir}/temporal.sqlite`,
      storageFingerprint: profile.storageFingerprint, chargedMicros: 288, modelCalls: 2,
      privateUsageComplete: true, quiescent: true,
      runs: [{ id: runId, trip_id: tripId, status: 'awaiting_confirmation' }],
      events: events.map((event, index) => ({ run_id: runId, sequence: index + 1, event })),
      privateUsage: [privateUsage], nativeHistory: [{ workflow_id: profile.workflowId,
        execution_run_id: executionRunId, terminal: 'awaiting_confirmation',
        models: ['completed', 'completed'].map(terminal => ({ terminal })) }] }] };
  const database = { fingerprint: profile.storageFingerprint,
    runs: [{ id: runId, trip_id: tripId, status: 'awaiting_confirmation' }],
    trips: [{ id: tripId, owner_id: ownerId }],
    invocations: [{ id: invocationId, run_id: runId, reservation_id: reservationId,
      provider: 'cloudflare', model: CLOUDFLARE_MODEL, account_id: recoveryAccount }],
    calls: callIds.map((call_id, index) => ({ run_id: runId, invocation_id: invocationId,
      call_id, usage: { totalTokens: tokens[index] } })),
    reservations: [{ id: reservationId, logical_run_id: runId,
      charged_cost_micros: '288', actual_cost_micros: '288' }] };
  const temporal = { workflowMatches: 1, executionMatches: 1, argumentMarkers: 0 };
  return { old, profile, report, database, temporal };
}

test('retained task-failed probe carries two known calls and keeps five older unknown receipts', () => {
  const v = vector();
  expect(comparePythonProbe3Carry(v.old, v.profile, v.report, v.database, v.temporal))
    .toMatchObject({ historyConsistent: true, invocations: 47, modelCalls: 70,
      chargedMicros: 950136, observedTokens: 289227, historicalUnknownReceipts: 5,
      accountingComplete: false, dispatchAuthorized: false, evaluationGatePassed: false });
});

test.each(['source', 'prior', 'extra-record', 'replay', 'database-owner', 'database-row',
  'call-binding', 'rejected-step', 'native-marker', 'diagnostic', 'temporal-execution', 'database-provider', 'settlement'] as const)('%s mutation blocks the new carry', mutation => {
  const v = vector();
  const audit = v.report.records[1] as typeof v.report.records[1] & {
    privateUsage: { steps: { arguments_rejected: boolean }[] }[] };
  if (mutation === 'source') v.report.sourceFingerprint = hash('changed source');
  if (mutation === 'prior') v.report.prior = { ...v.old, modelCalls: 67 as 68 };
  if (mutation === 'extra-record') v.report.records.push({ ...v.report.records[0] });
  if (mutation === 'replay') v.report.replays[0].runId = tripId;
  if (mutation === 'database-owner') v.database.trips[0].owner_id = runId;
  if (mutation === 'database-row') v.database.fingerprint = hash('mutated original row');
  if (mutation === 'call-binding') v.database.calls[0].call_id = 'other';
  if (mutation === 'rejected-step') audit.privateUsage[0].steps[0].arguments_rejected = true;
  if (mutation === 'native-marker') v.temporal.argumentMarkers = 1;
  if (mutation === 'diagnostic') (v.report.records[1].privateUsage![0].steps[0] as {argument_diagnostic: unknown}).argument_diagnostic = {tool:'validate_changes'};
  if (mutation === 'temporal-execution') v.temporal.executionMatches = 0;
  if (mutation === 'database-provider') v.database.invocations[0].account_id = 'other';
  if (mutation === 'settlement') v.database.reservations[0].actual_cost_micros = '0';
  expect(() => comparePythonProbe3Carry(v.old, v.profile, v.report, v.database, v.temporal))
    .toThrow('CLOUDFLARE_PYTHON_PROBE_3_CARRY_INVALID');
});
