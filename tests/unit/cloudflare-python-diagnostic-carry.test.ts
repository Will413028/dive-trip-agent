import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import { comparePythonDiagnosticCarry } from '../../evals/cloudflare-python-diagnostic-carry.ts';
import { diagnosticPrior } from '../support/cloudflare-diagnostic-fixture.ts';
import { recoveryAccount } from '../support/cloudflare-recovery-fixture.ts';
import { CLOUDFLARE_MODEL } from '../../src/agent/cloudflare-wire.ts';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const runId = '11111111-1111-4111-8111-111111111111';
const tripId = '22222222-2222-4222-8222-222222222222';
const ownerId = '33333333-3333-4333-8333-333333333333';
const invocationId = '44444444-4444-4444-8444-444444444444';
const reservationId = '55555555-5555-4555-8555-555555555555';
const executionRunId = '66666666-6666-4666-8666-666666666666';
const workflowId = 'synthetic-workflow';
const schema = 'python_test_' + '7'.repeat(32);
const storageDir = 'python-evaluation-TEST01';

function vector() {
  const profile = { schemaVersion: 1, reportSha256: hash('synthetic stopped report'),
    sourceSha256: hash('synthetic old source'), retainedSchema: schema, storageDir,
    contextSha256: hash('context'), temporalSha256: hash('sqlite'),
    storageFingerprint: hash('all original table rows'), runId, tripId, ownerId,
    executionRunId, workflowId };
  const old = diagnosticPrior();
  const events = ['RUN_STARTED', 'TOOL_CALL_START', 'TOOL_CALL_END', 'TOOL_CALL_RESULT', 'CUSTOM', 'RUN_ERROR']
    .map(type => ({ type }));
  const privateUsage = { schemaVersion: 3, executor: 'temporal-v1', execution_run_id: executionRunId,
    status: 'failed', run: { runId, tripId, ownerId },
    provider: { provider: 'cloudflare', model: CLOUDFLARE_MODEL, accountId: recoveryAccount },
    invocations: [{ id: invocationId, reservation_id: reservationId, kind: 'start',
      status: 'settled', charged_cost_micros: 183505, actual_cost_micros: null }],
    calls: [{ invocation_id: invocationId, status: 'completed', event: { callId: 'call-one',
      usage: { totalTokens: 1297 } } },
    { invocation_id: invocationId, status: 'completed', event: { callId: 'call-two', usage: null } }] };
  const report = { schemaVersion: 2, model: CLOUDFLARE_MODEL, accountId: recoveryAccount,
    prior: old, stopped: 'UNKNOWN_USAGE_STOP', accountingComplete: false,
    dispatchAuthorized: false, evaluationGatePassed: false, historicalUnknownReceipts: 4,
    invocations: 1, modelCalls: 2, chargedMicros: 183505,
    cumulativeInvocations: 44, cumulativeModelCalls: 63, cumulativeChargedMicros: 948999,
    totalTokens: null, cumulativeTokens: null, sourceFingerprint: profile.sourceSha256,
    sourceManifest: { sha256: profile.sourceSha256 },
    records: [{ schemaVersion: 2, round: 1, caseId: 'unknown-cost', outcome: 'failed', events,
      evidence: { runId, usageRunId: runId, model: CLOUDFLARE_MODEL, modelCalls: 2,
        usageComplete: false, costMicros: null, runStatus: 'failed' } },
    { kind: 'durable-audit', schemaVersion: 3, executor: 'temporal-v1', round: 1,
      caseId: 'unknown-cost', retainedSchema: schema,
      temporalStorage: `.artifacts/${storageDir}/temporal.sqlite`, storageFingerprint: profile.storageFingerprint,
      chargedMicros: 183505, modelCalls: 2, privateUsageComplete: true, quiescent: true,
      runs: [{ id: runId, trip_id: tripId, status: 'failed' }],
      events: events.map((event, index) => ({ run_id: runId, sequence: index + 1, event })),
      privateUsage: [privateUsage], nativeHistory: [{ workflow_id: workflowId,
        execution_run_id: executionRunId, terminal: 'failed',
        models: [{ terminal: 'completed' }, { terminal: 'failed' }] }] },
    ...Array.from({ length: 29 }, (_, index) => ({ round: index < 9 ? 1 : index < 19 ? 2 : 3,
      caseId: `synthetic-skipped-${index}`, outcome: 'skipped', reason: 'UNKNOWN_USAGE_STOP' }))] };
  const database = { fingerprint: profile.storageFingerprint,
    runs: [{ id: runId, trip_id: tripId, status: 'failed' }],
    trips: [{ id: tripId, owner_id: ownerId }],
    invocations: [{ id: invocationId, run_id: runId, reservation_id: reservationId,
      provider: 'cloudflare', model: CLOUDFLARE_MODEL, account_id: recoveryAccount }],
    calls: [{ run_id: runId, invocation_id: invocationId, call_id: 'call-one', usage: { totalTokens: 1297 } },
      { run_id: runId, invocation_id: invocationId, call_id: 'call-two', usage: null }],
    reservations: [{ id: reservationId, logical_run_id: runId,
      charged_cost_micros: '183505', actual_cost_micros: null }] };
  const temporal = { workflowMatches: 1, executionMatches: 1, timeoutMarkers: 1 };
  return { old, profile, report, database, temporal };
}

test('stopped Python report, owner, full storage pin and Temporal marker carry five unknowns', () => {
  const v = vector();
  expect(comparePythonDiagnosticCarry(v.old, v.profile, v.report, v.database, v.temporal))
    .toMatchObject({ historyConsistent: true, historicalUnknownReceipts: 5,
      invocations: 44, modelCalls: 63, chargedMicros: 948999, observedTokens: 279171,
      totalTokens: null, dispatchAuthorized: false, evaluationGatePassed: false });
});

test.each(['report-prior', 'report-account', 'report-call', 'database-owner',
  'database-rows', 'temporal-marker', 'temporal-run'] as const)('%s mutation cannot become a new grant', mutation => {
  const v = vector();
  if (mutation === 'report-prior') Object.assign(v.report.prior, { modelCalls: 60 });
  if (mutation === 'report-account') v.report.accountId = '0'.repeat(32);
  if (mutation === 'report-call') {
    const audit = v.report.records[1] as { privateUsage: { calls: { event: { usage: unknown } }[] }[] };
    audit.privateUsage[0].calls[1].event.usage = { totalTokens: 1 };
  }
  if (mutation === 'database-owner') v.database.trips[0].owner_id = runId;
  if (mutation === 'database-rows') v.database.fingerprint = hash('changed original row');
  if (mutation === 'temporal-marker') v.temporal.timeoutMarkers = 0;
  if (mutation === 'temporal-run') v.temporal.executionMatches = 0;
  expect(() => comparePythonDiagnosticCarry(v.old, v.profile, v.report, v.database, v.temporal))
    .toThrow('CLOUDFLARE_PYTHON_DIAGNOSTIC_CARRY_INVALID');
});
