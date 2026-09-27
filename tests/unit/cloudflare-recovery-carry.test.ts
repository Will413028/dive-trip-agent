import { expect, test } from 'vitest';
import { compareCloudflareRecoveryCarry, recoveryCarrySchema } from '../../evals/cloudflare-recovery-carry';
import { RECOVERY_REPORT_SHA256 } from '../../evals/cloudflare-artifacts';
import type { CloudflareUsageEvidence } from '../../evals/usage-evidence';
import { recoveryCarryFixture, recoveryAudits, recoveryAttempts, type RecoveryCarryFixture } from '../support/cloudflare-recovery-carry-fixture';
import { syntheticId } from '../support/cloudflare-quality-carry-fixture';

const compare = (f: RecoveryCarryFixture) => compareCloudflareRecoveryCarry(f.report, f.prior, f.snapshot);
const expected = { historyConsistent: true, dispatchAuthorized: false, accountingComplete: false, evaluationGatePassed: false,
  historicalUnknownReceipts: 2, invocations: 41, modelCalls: 59, chargedMicros: 398484, observedTokens: 272473,
  totalTokens: null, remainingInvocationCeiling: 59, remainingReferenceMicros: 2601516 };
function freeze(value: unknown): void {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
}
type Mutation = (f: RecoveryCarryFixture) => void;
// Matching report/DB mutations exercise consistency semantics, not simple inequality.
const usageMutation = (mutate: (u: CloudflareUsageEvidence, f: RecoveryCarryFixture) => void, index = 0): Mutation => f => {
  mutate(f.snapshot.usage[index], f);
  recoveryAudits(f)[index].privateUsage = [structuredClone(f.snapshot.usage[index])];
};
const eventMutation = (mutate: Mutation): Mutation => f => {
  mutate(f);
  recoveryAudits(f)[0].events = structuredClone(f.snapshot.events.filter(e => e.run_id === f.snapshot.runs[0].id));
  recoveryAttempts(f)[0].events = recoveryAudits(f)[0].events.map(e => structuredClone(e.event));
};

test('legacy recovery retains both unknowns, pending review and null total without authority or input mutation', () => {
  const f = recoveryCarryFixture(), before = structuredClone(f);
  expect(f.report.records).toHaveLength(32);
  expect(recoveryAttempts(f)).toHaveLength(2);
  expect(recoveryAudits(f)).toHaveLength(2);
  expect(f.report.records.filter(r => 'outcome' in r && r.outcome === 'skipped')).toHaveLength(28);
  expect(f.snapshot.events).toHaveLength(14);
  freeze(f);
  expect(compare(f)).toEqual(expected);
  expect(compare(f)).not.toHaveProperty('sourceSha256');
  expect(f).toEqual(before);
});

test('accepts explicit legacy v1 at report and attempt boundaries', () => {
  const f = recoveryCarryFixture();
  Object.assign(f.report, { schemaVersion: 1 });
  recoveryAttempts(f).forEach(a => Object.assign(a, { schemaVersion: 1 }));
  expect(compare(f)).toEqual(expected);
});

test('joins snapshot rows by identity, without requiring report order', () => {
  const f = recoveryCarryFixture(); f.snapshot.runs.reverse(); f.snapshot.usage.reverse();
  expect(compare(f)).toEqual(expected);
});

test('strict fixed carry schema rejects any changed, omitted, coerced or extra field', () => {
  const value = { ...expected, sourceSha256: RECOVERY_REPORT_SHA256() };
  expect(recoveryCarrySchema().parse(value)).toEqual(value);
  expect(recoveryCarrySchema().safeParse({ ...value, extra: true }).success).toBe(false);
  for (const [key, old] of Object.entries(value)) {
    const changed = typeof old === 'number' ? old + 1 : typeof old === 'boolean' ? !old : 'forged';
    expect(recoveryCarrySchema().safeParse({ ...value, [key]: changed }).success, key).toBe(false);
    const missing = { ...value }; Reflect.deleteProperty(missing, key);
    expect(recoveryCarrySchema().safeParse(missing).success, key).toBe(false);
  }
  expect(recoveryCarrySchema().safeParse({ ...value, invocations: '41' }).success).toBe(false);
});

const mutations: [string, Mutation][] = [
  ['report upgraded to v2', f => { Object.assign(f.report, { schemaVersion: 2 }); }],
  ['attempt upgraded to v2', f => { Object.assign(recoveryAttempts(f)[0], { schemaVersion: 2 }); }],
  ['report version null', f => { Object.assign(f.report, { schemaVersion: null }); }],
  ['wrong prior hash', f => { f.prior.sourceSha256 = '0'.repeat(64); f.report.prior = structuredClone(f.prior); }],
  ['prior unknown repriced', f => { f.prior.chargedMicros--; f.report.prior = structuredClone(f.prior); }],
  ['prior unknown removed', f => { f.prior.historicalUnknownReceipts--; f.report.prior = structuredClone(f.prior); }],
  ['prior observed tokens turned into known total', f => { Object.assign(f.prior, { totalTokens: 259078 }); f.report.prior = structuredClone(f.prior); }],
  ['prior differs from report', f => { f.report.prior.invocations++; }],
  ['new unknown actual cost', usageMutation(u => { u.invocations[0].actual_cost_micros = null; })],
  ['new unknown usage', usageMutation(u => { u.calls[0].usage = null; })],
  ['incorrect settled actual', usageMutation(u => { u.invocations[0].actual_cost_micros = '1260'; })],
  ['incorrect settled charge', usageMutation(u => { u.invocations[0].charged_cost_micros = '1260'; })],
  ['under-reserved invocation', usageMutation(u => { u.invocations[0].max_cost_micros = '1'; })],
  ['new resume', usageMutation(u => { u.invocations[0].kind = 'resume'; })],
  ['unsettled invocation', usageMutation(u => { u.invocations[0].status = 'active'; })],
  ['unsettled reservation', usageMutation(u => { u.invocations[0].reservation_status = 'reserved'; })],
  ['foreign model', usageMutation(u => { Object.assign(u.invocations[0], { model: 'other' }); })],
  ['foreign provider', usageMutation(u => { Object.assign(u.invocations[0], { provider: 'gemini' }); })],
  ['foreign account', usageMutation(u => { u.binding.accountId = 'a'.repeat(32); u.invocations[0].account_id = u.binding.accountId; })],
  ['foreign invocation run', usageMutation(u => { u.invocations[0].run_id = syntheticId(999); })],
  ['foreign logical run', usageMutation(u => { u.invocations[0].logical_run_id = syntheticId(999); })],
  ['foreign call run', usageMutation(u => { u.calls[0].run_id = syntheticId(999); })],
  ['foreign call invocation', usageMutation(u => { u.calls[0].invocation_id = syntheticId(999); })],
  ['duplicate receipt across runs', usageMutation((u, f) => {
    u.invocations[0].id = f.snapshot.usage[0].invocations[0].id; u.calls[0].invocation_id = u.invocations[0].id;
  }, 1)],
  ['duplicate reservation across runs', usageMutation((u, f) => { u.invocations[0].reservation_id = f.snapshot.usage[0].invocations[0].reservation_id; }, 1)],
  ['duplicate call', usageMutation(u => { u.calls[1].call_id = u.calls[0].call_id; })],
  ['missing completed timestamp', usageMutation(u => { u.calls[0].completed_at = null; })],
  ['started call', usageMutation(u => { u.calls[0].status = 'started'; u.calls[0].completed_at = null; u.calls[0].usage = null; })],
  ['wrong provider evidence', usageMutation(u => { u.calls[0].provider_evidence!.returnedModel = 'other'; })],
  ['invalid token sum', usageMutation(u => { u.calls[0].usage!.totalTokens++; })],
  ['same rounded cost but different observed tokens', usageMutation(u => { u.calls[0].usage!.promptTokens--; u.calls[0].usage!.totalTokens--; })],
  ['missing call', usageMutation(u => { u.calls.pop(); })],
  ['extra call', usageMutation(u => { u.calls.push({ ...structuredClone(u.calls[0]), call_id: 'extra' }); })],
  ['wrong initial event', eventMutation(f => { f.snapshot.events[0].event.type = 'RUN_FINISHED'; })],
  ['wrong final event', eventMutation(f => { f.snapshot.events[8].event.type = 'RUN_ERROR'; })],
  ['wrong event trip', eventMutation(f => { f.snapshot.events[0].event.threadId = syntheticId(999); })],
  ['wrong terminal thread', eventMutation(f => { f.snapshot.events[8].event.threadId = syntheticId(999); })],
  ['wrong terminal AGUI run', eventMutation(f => { f.snapshot.events[8].event.runId = syntheticId(999); })],
  ['event gap', eventMutation(f => { f.snapshot.events[1].sequence = 3; })],
  ['event order', eventMutation(f => { [f.snapshot.events[1], f.snapshot.events[2]] = [f.snapshot.events[2], f.snapshot.events[1]]; })],
  ['foreign event outside projections', f => { f.snapshot.events[13].run_id = syntheticId(999); recoveryAudits(f)[1].events.pop(); }],
  ['extra event', f => { f.snapshot.events.push(structuredClone(f.snapshot.events[0])); }],
  ['missing event', f => { f.snapshot.events.pop(); }],
  ['audit event body mismatch', f => { recoveryAudits(f)[0].events[1].event.value = 'changed'; }],
  ['attempt event body mismatch', f => { recoveryAttempts(f)[0].events[1].value = 'changed'; }],
  ['snapshot mismatch', f => { f.snapshot.runs[0].snapshot.requirements.divers++; }],
  ['prior state mismatch', f => { recoveryAttempts(f)[0].evidence.before.requirements.divers++; }],
  ['before-decision state mismatch', f => { recoveryAttempts(f)[0].evidence.beforeDecision.requirements.divers++; }],
  ['version changed on both sides', f => { f.snapshot.runs[0].current_version++; recoveryAttempts(f)[0].evidence.afterVersion++; }],
  ['run failed on both sides', f => { f.snapshot.runs[0].status = 'failed'; recoveryAudits(f)[0].runs[0].status = 'failed'; }],
  ['proposal on both sides', f => { f.snapshot.runs[0].proposal_id = syntheticId(999); recoveryAudits(f)[0].runs[0].proposal_id = syntheticId(999); }],
  ['decision on both sides', f => { f.snapshot.runs[0].decision = true; recoveryAudits(f)[0].runs[0].decision = true; }],
  ['interrupt on both sides', f => { f.snapshot.runs[0].interrupt_id = 'other'; recoveryAudits(f)[0].runs[0].interrupt_id = 'other'; }],
  ['duplicate run', f => { f.snapshot.runs[1] = structuredClone(f.snapshot.runs[0]); }],
  ['duplicate trip', f => { f.snapshot.runs[1].trip_id = f.snapshot.runs[0].trip_id; }],
  ['duplicate usage', f => { f.snapshot.usage[1] = structuredClone(f.snapshot.usage[0]); }],
  ['borrowed audit run', f => { recoveryAudits(f)[0].runs[0].id = syntheticId(999); }],
  ['borrowed audit usage', f => { recoveryAudits(f)[0].privateUsage = structuredClone(recoveryAudits(f)[1].privateUsage); }],
  ['borrowed attempt', f => { recoveryAttempts(f)[0].evidence.runId = syntheticId(999); }],
  ['wrong attempt case', f => { recoveryAttempts(f)[0].caseId = 'no-date'; }],
  ['wrong evidence case', f => { recoveryAttempts(f)[0].evidence.caseId = 'no-date'; }],
  ['wrong audit case', f => { recoveryAudits(f)[0].caseId = 'no-date'; }],
  ['wrong attempt round', f => { recoveryAttempts(f)[0].round = 0; }],
  ['wrong audit round', f => { recoveryAudits(f)[0].round = 0; }],
  ['wrong evidence usage identity', f => { recoveryAttempts(f)[0].evidence.usageRunId = syntheticId(999); }],
  ['wrong evidence calls', f => { recoveryAttempts(f)[0].evidence.modelCalls++; }],
  ['wrong evidence cost', f => { recoveryAttempts(f)[0].evidence.costMicros++; }],
  ['wrong checkpoint cost', f => { recoveryAudits(f)[0].chargedMicros++; }],
  ['per-case checkpoint cost', f => { recoveryAudits(f)[1].chargedMicros = 515; }],
  ['incomplete usage', f => { recoveryAudits(f)[0].privateUsageComplete = false; }],
  ['non-quiescent audit', f => { recoveryAudits(f)[0].quiescent = false; }],
  ['same count but replaced skipped case', f => { Object.assign(f.report.records[4], { caseId: 'no-date' }); }],
  ['duplicate skipped identity', f => { f.report.records[31] = structuredClone(f.report.records[30]); }],
  ['wrong skipped reason', f => { Object.assign(f.report.records[31], { reason: 'UNKNOWN_USAGE_STOP' }); }],
  ['wrong skipped round', f => { Object.assign(f.report.records[31], { round: 4 }); }],
  ['extra skip payload', f => { Object.assign(f.report.records[31], { evidence: {} }); }],
  ['attempt overlaps audit', f => { Object.assign(f.report.records[0], { kind: 'durable-audit' }); }],
  ['audit overlaps attempt', f => { Object.assign(f.report.records[1], { evidence: {} }); }],
  ['audit overlaps skipped', f => { Object.assign(f.report.records[1], { outcome: 'skipped' }); }],
  ['extra record', f => { f.report.records.push(structuredClone(f.report.records[31])); }],
  ['missing record', f => { f.report.records.pop(); }],
  ['null record', f => { Object.assign(f.report.records, { 0: null }); }],
  ['reordered executed cases', f => { [f.report.records[0], f.report.records[2]] = [f.report.records[2], f.report.records[0]]; }],
];
for (const key of ['runs', 'trips', 'invocations', 'calls', 'reservations', 'proposals'] as const) {
  mutations.push([`extra ${key} inventory`, f => { f.snapshot.counts[key]++; }]);
}
for (const [key, value] of Object.entries({ model: 'other', accountId: 'a'.repeat(32), transport: 'synthetic',
  budgetMicros: 3000001, maxModelCalls: 211, maxInvocations: 39, stopped: null, textReview: 'passed',
  evaluationGatePassed: true, accountingComplete: true, dispatchAuthorized: true, historicalUnknownReceipts: 0,
  invocations: 3, modelCalls: 4, chargedMicros: 1777, totalTokens: null, cumulativeInvocations: 42,
  cumulativeModelCalls: 60, cumulativeChargedMicros: 398485, cumulativeTokens: 272473 })) {
  mutations.push([`forged report ${key}`, f => { Object.assign(f.report, { [key]: value }); }]);
}
for (const value of [null, undefined, [], 'invalid', 1, false]) {
  mutations.push([`non-object state ${JSON.stringify(value)}`, f => {
    Object.assign(f.snapshot.runs[0], { snapshot: value });
    Object.assign(recoveryAttempts(f)[0].evidence, { before: value, beforeDecision: value, after: value });
  }]);
}
test.each(mutations)('rejects %s without mutation or private evidence in errors', (_, mutate) => {
  const f = recoveryCarryFixture(); mutate(f);
  const before = structuredClone(f); freeze(f);
  expect(() => compare(f)).toThrow(/^CLOUDFLARE_RECOVERY_CARRY_INVALID$/);
  expect(f).toEqual(before);
});

test.each(['report', 'prior', 'snapshot'] as const)('rejects malformed %s', key => {
  for (const value of [null, undefined, [], 'invalid', {}]) {
    const f = { ...recoveryCarryFixture(), [key]: value };
    expect(() => compareCloudflareRecoveryCarry(f.report, f.prior, f.snapshot)).toThrow(/^CLOUDFLARE_RECOVERY_CARRY_INVALID$/);
  }
});
