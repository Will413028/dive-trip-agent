import { expect, test } from 'vitest';
import { compareCloudflareGroundedCarry, groundedCarrySchema } from '../../evals/cloudflare-grounded-carry';
import { GROUNDED_REPORT_SHA256 } from '../../evals/cloudflare-artifacts';
import { groundedCarryFixture, type GroundedCarryFixture } from '../support/cloudflare-grounded-carry-fixture';
import { syntheticId } from '../support/cloudflare-quality-carry-fixture';

const compare = (f: GroundedCarryFixture) => compareCloudflareGroundedCarry(f.report, f.prior, f.snapshot);
const summary = { sourceSha256: GROUNDED_REPORT_SHA256(), historyConsistent: true, dispatchAuthorized: false,
  accountingComplete: false, evaluationGatePassed: false, historicalUnknownReceipts: 3, invocations: 42, modelCalls: 60,
  chargedMicros: 581989, observedTokens: 277874, totalTokens: null, remainingInvocationCeiling: 58, remainingReferenceMicros: 2418011 };

test('carries the stopped v2 failure, not a successful or known-cost run', () => {
  const f = groundedCarryFixture(), before = structuredClone(f);
  expect(groundedCarrySchema().parse({ ...compare(f), sourceSha256: GROUNDED_REPORT_SHA256() })).toEqual(summary);
  expect(f).toEqual(before);
  expect(f.attempt.events[0].runId).not.toBe(f.attempt.evidence.runId); // Native invocation ID is not the logical run.
  expect(f.attempt.evidence).toMatchObject({ runStatus: 'failed', terminal: 'clarification', usageComplete: false,
    costMicros: null, toolCount: null, visibleToolCount: 0 });
  expect(f.audit).toMatchObject({ privateUsageComplete: true, quiescent: true });
  expect(f.snapshot.usage[0].invocations[0]).toMatchObject({ actual_cost_micros: null, charged_cost_micros: '183505' });
  expect(f.report.records).toHaveLength(31); expect(f.skipped).toHaveLength(29);
});

const changes: [string, (f: GroundedCarryFixture) => void][] = [
  ['legacy attempt', f => { f.attempt.schemaVersion = 1; }],
  ['legacy report', f => { f.report.schemaVersion = 1; }],
  ['wrong prior', f => { f.prior.observedTokens++; }],
  ['wrong report prior', f => { f.report.prior.chargedMicros--; }],
  ['extra prior authority', f => { Object.assign(f.report.prior, { granted: true }); }],
  ['wrong account', f => { f.report.accountId = 'a'.repeat(32); }],
  ['wrong model', f => { Object.assign(f.report, { model: 'other' }); }],
  ['new dispatch ceiling', f => { f.report.maxInvocations = 60; }],
  ['new call ceiling', f => { f.report.maxModelCalls++; }],
  ['new budget', f => { f.report.budgetMicros++; }],
  ['historical unknown relabeled', f => { f.report.historicalUnknownReceipts = 3; }],
  ['report accounting complete', f => { f.report.accountingComplete = true; }],
  ['report dispatch granted', f => { f.report.dispatchAuthorized = true; }],
  ['report gate passed', f => { f.report.evaluationGatePassed = true; }],
  ['report text accepted', f => { f.report.textReview = 'passed'; }],
  ['report cost recalculated', f => { f.report.chargedMicros = 950; }],
  ['cumulative cost changed', f => { f.report.cumulativeChargedMicros--; }],
  ['cumulative invocations changed', f => { f.report.cumulativeInvocations++; }],
  ['cumulative calls changed', f => { f.report.cumulativeModelCalls++; }],
  ['known cumulative tokens', f => { Object.assign(f.report, { cumulativeTokens: 277874 }); }],
  ['known batch tokens', f => { Object.assign(f.report, { totalTokens: 5401 }); }],
  ['stop cleared', f => { f.report.stopped = ''; }],
  ['attempt completed', f => { f.attempt.outcome = 'completed'; }],
  ['case changed', f => { f.attempt.caseId = 'no-date'; }],
  ['input digest missing', f => { Reflect.deleteProperty(f.attempt.evidence, 'inputDigest'); }],
  ['wrong attempt run', f => { f.attempt.evidence.runId = syntheticId(799); }],
  ['usage marked complete', f => { f.attempt.evidence.usageComplete = true; }],
  ['cost marked known', f => { f.attempt.evidence.costMicros = 950; }],
  ['unknown tool count set to zero', f => { f.attempt.evidence.toolCount = 0; }],
  ['visible tools added', f => { f.attempt.evidence.visibleToolCount = 1; }],
  ['grade pass', f => { f.attempt.grade.pass = true; }],
  ['failure reason removed', f => { f.attempt.grade.reasons.pop(); }],
  ['safety failures cleared', f => { f.attempt.grade.safetyFailures = []; }],
  ['before snapshot changed', f => { f.attempt.evidence.before.label = 'changed'; }],
  ['before-decision snapshot changed', f => { f.attempt.evidence.beforeDecision.label = 'changed'; }],
  ['saved snapshot changed', f => { f.snapshot.runs[0].snapshot.label = 'changed'; }],
  ['version changed', f => { f.snapshot.runs[0].current_version++; }],
  ['wrong trip', f => { f.snapshot.runs[0].trip_id = syntheticId(799); }],
  ['proposal added', f => { f.snapshot.runs[0].proposal_id = syntheticId(799); }],
  ['accepted decision', f => { f.snapshot.runs[0].decision = true; }],
  ['run succeeded', f => { f.snapshot.runs[0].status = 'succeeded'; }],
  ['audit missing usage', f => { f.audit.privateUsage = []; }],
  ['audit incomplete', f => { f.audit.privateUsageComplete = false; }],
  ['audit not quiescent', f => { f.audit.quiescent = false; }],
  ['audit extra attempt tag', f => { Object.assign(f.audit, { outcome: 'failed' }); }],
  ['attempt extra audit tag', f => { Object.assign(f.attempt, { kind: 'durable-audit' }); }],
  ['audit wrong round', f => { f.audit.round++; }],
  ['audit wrong charge', f => { f.audit.chargedMicros--; }],
  ['private usage binding', f => { f.snapshot.usage[0].binding.accountId = 'a'.repeat(32); }],
  ['private usage run', f => { f.snapshot.usage[0].runId = syntheticId(799); }],
  ['extra invocation', f => { f.snapshot.usage[0].invocations.push(structuredClone(f.snapshot.usage[0].invocations[0])); }],
  ['extra call', f => { f.snapshot.usage[0].calls.push(structuredClone(f.snapshot.usage[0].calls[0])); }],
  ['missing event', f => { f.snapshot.events.pop(); }],
  ['duplicate event sequence', f => { f.snapshot.events[1].sequence = 1; }],
  ['missing skip', f => { f.report.records.pop(); }],
  ['skip order changed', f => { [f.report.records[2], f.report.records[3]] = [f.report.records[3], f.report.records[2]]; }],
  ['skip reason changed', f => { f.skipped[0].reason = 'FAILED_RUN_STOP'; }],
  ['skip claimed completed', f => { f.skipped[0].outcome = 'completed'; }],
  ['skip extra evidence', f => { Object.assign(f.skipped[0], { evidence: {} }); }],
];
test.each(changes)('rejects %s', (_label, change) => {
  const f = groundedCarryFixture(); change(f);
  expect(() => compare(f)).toThrow(/^CLOUDFLARE_GROUNDED_CARRY_INVALID$/);
});

test.each(['runs', 'trips', 'invocations', 'calls', 'reservations', 'proposals'] as const)('rejects extra inventory: %s', key => {
  const f = groundedCarryFixture(); f.snapshot.counts[key]++;
  expect(() => compare(f)).toThrow(/^CLOUDFLARE_GROUNDED_CARRY_INVALID$/);
});

test.each([
  { kind: 'resume' }, { status: 'active' }, { reservation_status: 'reserved' }, { provider: 'gemini' }, { model: 'other' },
  { account_id: 'a'.repeat(32) }, { run_id: syntheticId(799) }, { logical_run_id: syntheticId(799) },
  { actual_cost_micros: '950', charged_cost_micros: '950' }, { actual_cost_micros: '183505' },
  { max_cost_micros: '183506' }, { charged_cost_micros: '0' },
])('rejects matched report/DB receipt tampering: %j', overrides => {
  const f = groundedCarryFixture();
  for (const u of [f.snapshot.usage[0], f.audit.privateUsage[0]]) Object.assign(u.invocations[0], overrides);
  expect(() => compare(f)).toThrow(/^CLOUDFLARE_GROUNDED_CARRY_INVALID$/);
});

test.each([
  { run_id: syntheticId(799) }, { invocation_id: syntheticId(799) }, { usage: null }, { provider_evidence: null },
  { status: 'started', completed_at: null }, { usage: { promptTokens: 3354, outputTokens: 2047, totalTokens: 5401, cachedTokens: 0 } },
])('rejects matched report/DB call tampering: %j', overrides => {
  const f = groundedCarryFixture();
  for (const u of [f.snapshot.usage[0], f.audit.privateUsage[0]]) Object.assign(u.calls[0], overrides);
  expect(() => compare(f)).toThrow(/^CLOUDFLARE_GROUNDED_CARRY_INVALID$/);
});

test.each([
  [0, { threadId: syntheticId(799) }], [1, { name: 'other-answer' }], [2, { type: 'RUN_FINISHED' }],
  [2, { code: 'AGENT_TOOL_ARGUMENTS' }], [1, { value: { schemaVersion: 1, body: { kind: 'clarification' } } }],
] as const)('rejects matched captured/durable failure-event tampering at %i', (index, overrides) => {
  const f = groundedCarryFixture();
  Object.assign(f.attempt.events[index], overrides);
  Object.assign(f.audit.events[index].event, overrides);
  Object.assign(f.snapshot.events[index].event, overrides);
  expect(() => compare(f)).toThrow(/^CLOUDFLARE_GROUNDED_CARRY_INVALID$/);
});
