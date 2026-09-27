import { expect, test } from 'vitest';
import { compareCloudflareRevisionCarry, revisionCarrySchema } from '../../evals/cloudflare-revision-carry';
import { REVISION_REPORT_SHA256 } from '../../evals/cloudflare-artifacts';
import type { CloudflareUsageEvidence } from '../../evals/usage-evidence';
import { revisionCarryFixture, revisionAudits, revisionAttempts, type RevisionCarryFixture } from '../support/cloudflare-revision-carry-fixture';
import { syntheticId } from '../support/cloudflare-quality-carry-fixture';

const compare = (f: RevisionCarryFixture) => compareCloudflareRevisionCarry(f.report, f.prior, f.snapshot);
const expected = { historyConsistent: true, dispatchAuthorized: false, accountingComplete: false,
  evaluationGatePassed: false, historicalUnknownReceipts: 2, invocations: 39, modelCalls: 56,
  chargedMicros: 396708, observedTokens: 259078, totalTokens: null,
  remainingInvocationCeiling: 61, remainingReferenceMicros: 2603292 };
function freeze(value: unknown): void {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
}
type Mutation = (f: RevisionCarryFixture) => void;
// Mutate both sides so rejection checks semantics, not just report/DB inequality.
const usageMutation = (mutate: (u: CloudflareUsageEvidence, f: RevisionCarryFixture) => void, index = 0): Mutation => f => {
  mutate(f.snapshot.usage[index], f);
  revisionAudits(f)[index].privateUsage = [structuredClone(f.snapshot.usage[index])];
};
const eventMutation = (mutate: Mutation): Mutation => f => {
  mutate(f);
  revisionAudits(f)[0].events = structuredClone(f.snapshot.events.filter(e => e.run_id === f.snapshot.runs[0].id));
};

test('synthetic revision preserves two unknown receipts and observed tokens without authority', () => {
  const f = revisionCarryFixture(), before = structuredClone(f), receipts = f.snapshot.usage.flatMap(u => u.invocations);
  expect(f.report.records).toHaveLength(40);
  expect(revisionAttempts(f)).toHaveLength(9);
  expect(revisionAudits(f)).toHaveLength(9);
  expect(f.report.records.filter(r => 'outcome' in r && r.outcome === 'skipped')).toHaveLength(22);
  expect(receipts).toHaveLength(13);
  expect(receipts.filter(i => i.actual_cost_micros === null)).toHaveLength(1);
  expect(receipts.reduce((n, i) => n + Number(i.actual_cost_micros), 0)).toBe(8387);
  expect(receipts.reduce((n, i) => n + Number(i.charged_cost_micros), 0)).toBe(191892);
  const calls = f.snapshot.usage.flatMap(u => u.calls);
  expect(calls).toHaveLength(18);
  expect(calls.reduce((n, c) => n + c.usage!.totalTokens, 0)).toBe(75287);
  expect(f.snapshot.events).toHaveLength(86);
  freeze(f);
  expect(compare(f)).toEqual(expected);
  expect(compare(f)).not.toHaveProperty('sourceSha256');
  expect(f).toEqual(before);
  expect(f.report.historicalUnknownReceipts).toBe(1);
});

test('schema has strict exact values including provenance, without coercion', () => {
  const value = { ...expected, sourceSha256: REVISION_REPORT_SHA256() };
  expect(revisionCarrySchema().parse(value)).toEqual(value);
  expect(revisionCarrySchema().safeParse({ ...value, extra: true }).success).toBe(false);
  for (const [key, old] of Object.entries(value)) {
    const changed = typeof old === 'number' ? old + 1 : typeof old === 'boolean' ? !old : 'forged';
    expect(revisionCarrySchema().safeParse({ ...value, [key]: changed }).success, key).toBe(false);
    const missing = { ...value }; Reflect.deleteProperty(missing, key);
    expect(revisionCarrySchema().safeParse(missing).success, key).toBe(false);
  }
});

test('identity matching survives reordered run and usage inventory', () => {
  const f = revisionCarryFixture(); f.snapshot.runs.reverse(); f.snapshot.usage.reverse();
  expect(compare(f)).toEqual(expected);
});

const mutations: [string, Mutation][] = [
  ['unknown receipt moved to a new invocation identity', usageMutation(u => {
    u.invocations[0].id = syntheticId(990); u.calls[0].invocation_id = syntheticId(990);
  }, 8)],
  ['unknown receipt moved to a new reservation', usageMutation(u => { u.invocations[0].reservation_id = syntheticId(991); }, 8)],
  ['unknown actual backfilled even to a calculable value', usageMutation(u => { u.invocations[0].actual_cost_micros = '620'; }, 8)],
  ['unknown resolved at full charge', usageMutation(u => { u.invocations[0].actual_cost_micros = '183505'; }, 8)],
  ['unknown maximum differs from charge', usageMutation(u => { u.invocations[0].max_cost_micros = '183504'; }, 8)],
  ['unknown charge differs from maximum', usageMutation(u => { u.invocations[0].charged_cost_micros = '183504'; }, 8)],
  ['unknown loses usage evidence', usageMutation(u => { u.calls[0].usage = null; }, 8)],
  ['failed run changed on both sides', f => { f.snapshot.runs[8].status = 'succeeded'; revisionAudits(f)[8].runs[0].status = 'succeeded'; }],
  ['skip replaced by unrelated record', f => { Object.assign(f.report.records[39], { outcome: 'completed' }); }],
  ['skip reason changes', f => { Object.assign(f.report.records[39], { reason: 'FAILED_RUN_STOP' }); }],
  ['overlapping record classifications', f => { Object.assign(f.report.records[0], { outcome: 'skipped', reason: 'UNKNOWN_USAGE_STOP' }); }],
  ['forged external prior', f => { f.prior.invocations++; }],
  ['forged report prior', f => { f.report.prior.observedTokens++; }],
  ['matching forged priors', f => { f.prior.chargedMicros--; f.report.prior.chargedMicros--; }],
  ['prior provenance digest', f => { f.prior.sourceSha256 = '0'.repeat(64); f.report.prior.sourceSha256 = f.prior.sourceSha256; }],
  ['extra prior field', f => { Object.assign(f.prior, { extra: 1 }); }],
  ['extra inventory field', f => { Object.assign(f.snapshot.counts, { extra: 1 }); }],
  ['missing usage row', f => { f.snapshot.usage.pop(); }],
  ['duplicate usage run', f => { f.snapshot.usage[1] = structuredClone(f.snapshot.usage[0]); }],
  ['report-only usage change', f => { revisionAudits(f)[0].privateUsage[0].calls[0].call_id = 'changed'; }],
  ['empty audit usage', f => { revisionAudits(f)[0].privateUsage = []; }],
  ['unknown usage', usageMutation(u => { u.calls[0].usage = null; })],
  ['missing usage', usageMutation(u => { Reflect.deleteProperty(u.calls[0], 'usage'); })],
  ['unknown actual cost', usageMutation(u => { u.invocations[0].actual_cost_micros = null; })],
  ['charged cost mismatch', usageMutation(u => { u.invocations[0].charged_cost_micros = '1201'; })],
  ['matching but wrong receipt costs', usageMutation(u => { u.invocations[0].charged_cost_micros = u.invocations[0].actual_cost_micros = '1201'; })],
  ['token sum mismatch', usageMutation(u => { u.calls[0].usage!.totalTokens++; })],
  ['negative tokens', usageMutation(u => { u.calls[0].usage!.promptTokens = -1; })],
  ['changed coherent usage cost', usageMutation(u => { u.calls[0].usage!.promptTokens += 10; u.calls[0].usage!.totalTokens += 10; })],
  ['missing provider evidence', usageMutation(u => { u.calls[0].provider_evidence = null; })],
  ['wrong returned model', usageMutation(u => { u.calls[0].provider_evidence!.returnedModel = 'foreign-model'; })],
  ['wrong price basis', usageMutation(u => { Object.assign(u.calls[0].provider_evidence!, { priceBasis: 'foreign-price' }); })],
  ['wrong provider evidence', usageMutation(u => { Object.assign(u.calls[0].provider_evidence!, { provider: 'gemini' }); })],
  ['wrong binding provider', usageMutation(u => { Object.assign(u.binding, { provider: 'gemini' }); })],
  ['wrong invocation provider', usageMutation(u => { Object.assign(u.invocations[0], { provider: 'gemini' }); })],
  ['wrong invocation model', usageMutation(u => { Object.assign(u.invocations[0], { model: 'foreign-model' }); })],
  ['wrong receipt account', usageMutation(u => { u.invocations[0].account_id = 'a'.repeat(32); })],
  ['coherent foreign account', usageMutation(u => { u.binding.accountId = 'a'.repeat(32); u.invocations.forEach(r => { r.account_id = u.binding.accountId; }); })],
  ['legacy usage schema', usageMutation(u => { Object.assign(u, { schemaVersion: 1 }); })],
  ['cross-run receipt', usageMutation((u, f) => { u.invocations[0].run_id = f.snapshot.runs[1].id; })],
  ['cross-run reservation', usageMutation((u, f) => { u.invocations[0].logical_run_id = f.snapshot.runs[1].id; })],
  ['cross-run call', usageMutation((u, f) => { u.calls[0].run_id = f.snapshot.runs[1].id; })],
  ['foreign invocation call', usageMutation((u, f) => { u.calls[0].invocation_id = f.snapshot.usage[1].invocations[0].id; })],
  ['duplicate call', usageMutation(u => { u.calls[1].call_id = u.calls[0].call_id; })],
  ['duplicate local receipt', usageMutation(u => { u.invocations[1].id = u.invocations[0].id; })],
  ['duplicate global receipt', usageMutation((u, f) => {
    const old = u.invocations[0].id, duplicate = f.snapshot.usage[1].invocations[0].id;
    u.invocations[0].id = duplicate; u.calls.filter(c => c.invocation_id === old).forEach(c => { c.invocation_id = duplicate; });
  })],
  ['duplicate global reservation', usageMutation((u, f) => { u.invocations[0].reservation_id = f.snapshot.usage[1].invocations[0].reservation_id; })],
  ['duplicate local reservation', usageMutation(u => { u.invocations[1].reservation_id = u.invocations[0].reservation_id; })],
  ['active receipt', usageMutation(u => { u.invocations[0].status = 'active'; })],
  ['unsettled reservation', usageMutation(u => { u.invocations[0].reservation_status = 'reserved'; })],
  ['incomplete call', usageMutation(u => { u.calls[0].status = 'started'; u.calls[0].completed_at = null; u.calls[0].usage = null; })],
  ['missing completion timestamp', usageMutation(u => { u.calls[0].completed_at = null; })],
  ['receipt with no calls', usageMutation(u => { u.calls[2].invocation_id = u.invocations[0].id; })],
  ['missing call', usageMutation(u => { u.calls.pop(); })],
  ['extra call', usageMutation(u => { u.calls.push({ ...structuredClone(u.calls[0]), call_id: 'extra-call' }); })],
  ['event body divergence', f => { f.snapshot.events[1].event.value = 'changed'; }],
  ['event sequence gap', eventMutation(f => { f.snapshot.events[1].sequence = 3; })],
  ['event sequence starts at zero', eventMutation(f => { f.snapshot.events[0].sequence = 0; })],
  ['event order', eventMutation(f => { [f.snapshot.events[1], f.snapshot.events[2]] = [f.snapshot.events[2], f.snapshot.events[1]]; })],
  ['wrong initial event', eventMutation(f => { f.snapshot.events[0].event.type = 'RUN_FINISHED'; })],
  ['wrong event trip', eventMutation(f => { f.snapshot.events[0].event.threadId = f.snapshot.runs[1].trip_id; })],
  ['cross-run event', f => { f.snapshot.events[1].run_id = f.snapshot.runs[1].id; }],
  ['missing event', f => { f.snapshot.events.pop(); }],
  ['extra event', f => { f.snapshot.events.push(structuredClone(f.snapshot.events[0])); }],
  ['audit events total below 86', f => { revisionAudits(f)[8].events.pop(); }],
  ['audit events total above 86', f => { revisionAudits(f)[8].events.push(structuredClone(f.snapshot.events[85])); }],
  ['foreign-run event hidden outside otherwise matching audit projections', f => {
    // Keep the inventory at 86 and every known run's sequence/projection valid.
    // The previous comparator ignored this orphan and accepted only 85 audited events.
    f.snapshot.events[85].run_id = syntheticId(999);
    revisionAudits(f)[8].events.pop();
  }],
  ['foreign-run event with audit total still 86', f => {
    f.snapshot.events[85].run_id = syntheticId(999);
    revisionAudits(f)[8].events[13].run_id = syntheticId(999);
  }],
  ['snapshot changes', f => { f.snapshot.runs[0].snapshot.requirements.divers++; }],
  ['version changes', f => { f.snapshot.runs[0].current_version++; }],
  ['run status changes', f => { f.snapshot.runs[0].status = 'failed'; }],
  ['proposal changes', f => { f.snapshot.runs[0].proposal_id = syntheticId(999); }],
  ['decision changes', f => { f.snapshot.runs[0].decision = false; }],
  ['interrupt changes', f => { f.snapshot.runs[0].interrupt_id = 'other'; }],
  ['duplicate snapshot run', f => { f.snapshot.runs[1] = structuredClone(f.snapshot.runs[0]); }],
  ['duplicate trip', f => { f.snapshot.runs[1].trip_id = f.snapshot.runs[0].trip_id; }],
  ['missing snapshot run', f => { f.snapshot.runs.pop(); }],
  ['duplicate audit run', f => { revisionAudits(f)[1].runs = structuredClone(revisionAudits(f)[0].runs); }],
  ['duplicate attempt run', f => { revisionAttempts(f)[1].evidence.runId = revisionAttempts(f)[0].evidence.runId; }],
  ['borrowed attempt', f => { revisionAttempts(f)[0].evidence.runId = syntheticId(999); }],
  ['borrowed audit', f => { revisionAudits(f)[0].runs[0].id = syntheticId(999); }],
  ['borrowed usage', f => { revisionAudits(f)[0].privateUsage = structuredClone(revisionAudits(f)[1].privateUsage); }],
  ['attempt case mismatch', f => { revisionAttempts(f)[0].caseId = revisionAttempts(f)[1].caseId; }],
  ['attempt round mismatch', f => { revisionAttempts(f)[0].round++; }],
  ['swapped attempt snapshots', f => {
    const [a, b] = revisionAttempts(f); [a.evidence.after, b.evidence.after] = [b.evidence.after, a.evidence.after];
  }],
  ['audit order changes', f => { [f.report.records[1], f.report.records[3]] = [f.report.records[3], f.report.records[1]]; }],
  ['per-case instead of cumulative cost', f => { revisionAudits(f)[1].chargedMicros = 1800; }],
  ['wrong cumulative checkpoint', f => { revisionAudits(f)[0].chargedMicros++; }],
  ['incomplete private audit', f => { revisionAudits(f)[0].privateUsageComplete = false; }],
  ['non-quiescent audit', f => { revisionAudits(f)[0].quiescent = false; }],
  ['missing audit with same record count', f => { f.report.records[1] = structuredClone(f.report.records[39]); }],
  ['missing attempt with same record count', f => { f.report.records[0] = structuredClone(f.report.records[39]); }],
  ['extra executed attempt with same record count', f => { f.report.records[39] = structuredClone(f.report.records[0]); }],
  ['extra audit with same record count', f => { f.report.records[39] = structuredClone(f.report.records[1]); }],
  ['missing record', f => { f.report.records.pop(); }],
  ['extra record', f => { f.report.records.push(structuredClone(f.report.records[39])); }],
  // Preserve cost (ceil(5999 / 10) = 600) but change the aggregate token count.
  ['aggregate tokens despite valid per-call sums and costs', usageMutation(u => { u.calls[0].usage!.promptTokens--; u.calls[0].usage!.totalTokens--; })],
];
for (const [name, value] of Object.entries({ null: null, undefined, array: [], string: 'snapshot', number: 1, boolean: false })) {
  mutations.push([`matching non-object after and snapshot: ${name}`, f => {
    Object.assign(revisionAttempts(f)[0].evidence, { after: value });
    Object.assign(f.snapshot.runs[0], { snapshot: value });
  }]);
}
mutations.push(['missing both after and snapshot', f => {
  Reflect.deleteProperty(revisionAttempts(f)[0].evidence, 'after');
  Reflect.deleteProperty(f.snapshot.runs[0], 'snapshot');
}]);
for (const key of ['runs', 'trips', 'invocations', 'calls', 'reservations', 'proposals'] as const) {
  mutations.push([`extra ${key} inventory`, f => { f.snapshot.counts[key]++; }]);
}
for (const [key, value] of Object.entries({ model: 'foreign-model', accountId: 'a'.repeat(32),
  stopped: null, textReview: 'passed', evaluationGatePassed: true, accountingComplete: true,
  dispatchAuthorized: true, historicalUnknownReceipts: 0, invocations: 17, modelCalls: 25,
  chargedMicros: 14750, totalTokens: 122600, cumulativeInvocations: 27, cumulativeModelCalls: 39,
  cumulativeChargedMicros: 204817, cumulativeTokens: 183791 })) {
  mutations.push([`forged report ${key}`, f => { Object.assign(f.report, { [key]: value }); }]);
}

test.each(mutations)('rejects %s without mutating input or exposing evidence', (_, mutate) => {
  const f = revisionCarryFixture();
  mutate(f);
  const before = structuredClone(f);
  freeze(f);
  expect(() => compare(f)).toThrow(/^CLOUDFLARE_REVISION_CARRY_INVALID$/);
  expect(f).toEqual(before);
});

test.each(['report', 'prior', 'snapshot'] as const)('rejects malformed %s', key => {
  const f = revisionCarryFixture();
  for (const invalid of [null, undefined, [], 'invalid', {}]) {
    const args = { ...f, [key]: invalid };
    expect(() => compareCloudflareRevisionCarry(args.report, args.prior, args.snapshot)).toThrow(/^CLOUDFLARE_REVISION_CARRY_INVALID$/);
  }
});
