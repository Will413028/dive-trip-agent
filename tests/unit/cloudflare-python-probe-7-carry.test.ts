import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import { comparePythonProbe7Carry } from '../../evals/cloudflare-python-probe-7-carry.ts';
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
    evaluationGatePassed: false as const, historicalUnknownReceipts: 9 as const,
    invocations: 51 as const, modelCalls: 83 as const, chargedMicros: 1684156 as const,
    observedTokens: 308936 as const, totalTokens: null,
    remainingInvocationCeiling: 49 as const, remainingReferenceMicros: 1315844 as const };
  const events = ['RUN_STARTED', ...Array.from({length:5},()=>['TOOL_CALL_START','TOOL_CALL_END','TOOL_CALL_RESULT']).flat(), 'CUSTOM', 'RUN_ERROR'].map(type => ({ type }));
  const tokens = [1290, 1417, 1528, 1653, 1778, 2007];
  const callIds = tokens.map((_,index)=>`call-${index+1}`);
  const privateUsage = { schemaVersion: 3, executor: 'temporal-v1', execution_run_id: executionRunId,
    status: 'failed', run: { runId, tripId, ownerId },
    provider: { provider: 'cloudflare', model: CLOUDFLARE_MODEL, accountId: recoveryAccount },
    invocations: [{ id: invocationId, reservation_id: reservationId, kind: 'start',
      status: 'settled', charged_cost_micros: 183505, actual_cost_micros: null }],
    calls: callIds.map((callId, index) => ({ invocation_id: invocationId, status: 'completed',
      event: { callId, usage: { totalTokens: tokens[index] } } })),
    steps: [1, 2, 3, 4, 5, 6].map(ordinal => ({ ordinal, completed: ordinal <= 5, arguments_rejected: false, argument_diagnostic: null })),
    tools: [1,2,3,4,5].map(ordinal=>({ name: 'calculate_budget', ordinal, completed: true })) };
  const report = { schemaVersion: 2, model: CLOUDFLARE_MODEL, accountId: recoveryAccount,
    prior: old, stopped: 'UNKNOWN_USAGE_STOP', textReview: 'pending',
    accountingComplete: false, dispatchAuthorized: false, evaluationGatePassed: false,
    diagnosticComplete: false, maxModelCalls: 7, maxInvocations: 1,
    historicalUnknownReceipts: 9, invocations: 1, modelCalls: 6, chargedMicros: 183505,
    totalTokens: null, cumulativeInvocations: 52, cumulativeModelCalls: 89,
    cumulativeChargedMicros: 1867661, cumulativeTokens: null,
    sourceFingerprint: profile.sourceSha256, sourceManifest: { sha256: profile.sourceSha256 },
    replays: [{ file: `cloudflare-probe-7-${runId}.replay.json`, runId,
      sha256: hash('synthetic replay'), recordedResume: false }],
    records: [{ schemaVersion: 2, round: 1, caseId: 'unknown-cost', outcome: 'failed',
      grade: { pass: false, safetyFailures: ['UNEXPECTED_SIDE_EFFECT'] },
      evidence: { runId, usageRunId: runId, model: CLOUDFLARE_MODEL, modelCalls: 6,
        toolCount: 5, usageComplete: false, costMicros: null, proposalId: null, decision: 'none',
        beforeVersion: 1, afterVersion: 1, before: {same:true}, after: {same:true}, runStatus: 'failed' }, events },
    { kind: 'durable-audit', schemaVersion: 3, executor: 'temporal-v1', round: 1,
      caseId: 'unknown-cost', retainedSchema: schema,
      temporalStorage: `.artifacts/${storageDir}/temporal.sqlite`,
      storageFingerprint: profile.storageFingerprint, chargedMicros: 183505, modelCalls: 6,
      privateUsageComplete: true, quiescent: true,
      runs: [{ id: runId, trip_id: tripId, status: 'failed' }],
      events: events.map((event, index) => ({ run_id: runId, sequence: index + 1, event })),
      privateUsage: [privateUsage], nativeHistory: [{ workflow_id: profile.workflowId,
        execution_run_id: executionRunId, terminal: 'failed',
        models: ['completed', 'completed', 'completed', 'completed', 'completed', 'failed'].map(terminal => ({ terminal })) }] }] };
  const database = { fingerprint: profile.storageFingerprint,
    runs: [{ id: runId, trip_id: tripId, status: 'failed' }],
    trips: [{ id: tripId, owner_id: ownerId }],
    invocations: [{ id: invocationId, run_id: runId, reservation_id: reservationId,
      provider: 'cloudflare', model: CLOUDFLARE_MODEL, account_id: recoveryAccount }],
    calls: callIds.map((call_id, index) => ({ run_id: runId, invocation_id: invocationId,
      call_id, usage: { totalTokens: tokens[index] } })),
    reservations: [{ id: reservationId, logical_run_id: runId,
      charged_cost_micros: '183505', actual_cost_micros: null as string | null }] };
  const temporal = { workflowMatches: 1, executionMatches: 1, argumentMarkers: 0, responseMarkers: 1, toolLimitMarkers: 0, nonToolMarkers: 1, ownedExecutionMatches: 1 };
  return { old, profile, report, database, temporal };
}

test('known call tokens preserve the tenth unknown invocation settlement', () => {
  const v = vector();
  expect(comparePythonProbe7Carry(v.old, v.profile, v.report, v.database, v.temporal))
    .toMatchObject({ historyConsistent: true, invocations: 52, modelCalls: 89,
      chargedMicros: 1867661, observedTokens: 318609, historicalUnknownReceipts: 10,
      accountingComplete: false, dispatchAuthorized: false, evaluationGatePassed: false });
});

test.each(['source', 'prior', 'extra-record', 'replay', 'database-owner', 'database-row',
  'call-binding', 'rejected-step', 'native-marker', 'diagnostic', 'temporal-execution', 'database-provider', 'settlement', 'response-marker', 'limit-marker', 'non-tool-marker', 'owned-execution', 'skip-order', 'version', 'snapshot', 'unknown-normalized'] as const)('%s mutation blocks the new carry', mutation => {
  const v = vector();
  const audit = v.report.records[1] as typeof v.report.records[1] & {
    privateUsage: { steps: { arguments_rejected: boolean }[] }[] };
  if (mutation === 'source') v.report.sourceFingerprint = hash('changed source');
  if (mutation === 'prior') v.report.prior = { ...v.old, modelCalls: 67 as 83 };
  if (mutation === 'extra-record') v.report.records.push({ ...v.report.records[0] });
  if (mutation === 'replay') v.report.replays[0].runId = tripId;
  if (mutation === 'database-owner') v.database.trips[0].owner_id = runId;
  if (mutation === 'database-row') v.database.fingerprint = hash('mutated original row');
  if (mutation === 'call-binding') v.database.calls[0].call_id = 'other';
  if (mutation === 'rejected-step') audit.privateUsage[0].steps[0].arguments_rejected = true;
  if (mutation === 'native-marker') v.temporal.argumentMarkers = 1;
  if (mutation === 'diagnostic') (audit.privateUsage[0].steps[0] as {argument_diagnostic: unknown}).argument_diagnostic = {tool:'validate_changes'};
  if (mutation === 'temporal-execution') v.temporal.executionMatches = 0;
  if (mutation === 'database-provider') v.database.invocations[0].account_id = 'other';
  if (mutation === 'response-marker') v.temporal.responseMarkers = 0;
  if (mutation === 'limit-marker') v.temporal.toolLimitMarkers = 1;
  if (mutation === 'non-tool-marker') v.temporal.nonToolMarkers = 0;
  if (mutation === 'owned-execution') v.temporal.ownedExecutionMatches = 0;
  if (mutation === 'skip-order') v.report.records.reverse();
  if (mutation === 'version') (v.report.records[0] as {evidence:{afterVersion:number}}).evidence.afterVersion = 2;
  if (mutation === 'snapshot') (v.report.records[0] as {evidence:{after:unknown}}).evidence.after = {same:false};
  if (mutation === 'unknown-normalized') Object.assign(v.report,{totalTokens:9673});
  if (mutation === 'settlement') v.database.reservations[0].actual_cost_micros = '0';
  expect(() => comparePythonProbe7Carry(v.old, v.profile, v.report, v.database, v.temporal))
    .toThrow('CLOUDFLARE_PYTHON_PROBE_7_CARRY_INVALID');
});
