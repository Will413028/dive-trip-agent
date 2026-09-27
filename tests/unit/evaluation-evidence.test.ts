import { expect, test } from 'vitest';
import cases from '../../evals/cases.json';
import { evaluationInput } from '../../evals/fixtures';
import { gradeEvidence, gradeEvidenceV2, nextAttemptAllowed, type RunEvidence } from '../../evals/evidence';

function evidence(id = 'free-afternoon'): RunEvidence {
  const input = evaluationInput(id);
  const proposal = input.terminal === 'proposal';
  const after = structuredClone(input.before);
  if (id === 'free-afternoon') after.entries = after.entries.filter(entry => entry.id !== 'transfer');
  if (id === 'non-diver') after.requirements.divers = 0;
  if (id === 'more-people') { after.requirements.people = 3; after.entries[0].rooms = 2; }
  return { caseId: id, inputDigest: input.digest, runId: 'run-1', before: input.before,
    beforeDecision: structuredClone(input.before), after, beforeVersion: 1, beforeDecisionVersion: 1,
    afterVersion: proposal ? 2 : 1, terminal: input.terminal as RunEvidence['terminal'], runStatus: 'succeeded',
    decision: proposal ? 'accept' : 'none', proposalId: proposal ? 'proposal-1' : null,
    decisionRunId: proposal ? 'run-1' : null, decisionProposalId: proposal ? 'proposal-1' : null,
    model: 'test-model', usageRunId: 'run-1', usageComplete: true, modelCalls: 2, toolCount: 2,
    costMicros: 100, latencyMs: 1000, textReview: 'passed', faultObserved: input.fault };
}

test('ten reproducible independent fixture inputs have distinct digests and no oracle changes', () => {
  const inputs = cases.map(c => evaluationInput(c.id));
  expect(new Set(inputs.map(input => input.digest)).size).toBe(10);
  for (const input of inputs) {
    expect(input).toEqual(evaluationInput(input.caseId));
    expect(input).not.toHaveProperty('changes');
  }
  inputs[0].before.entries[0].locked = true;
  expect(evaluationInput(inputs[0].caseId).before.entries[0].locked).toBe(false);
  expect(() => evaluationInput('unknown')).toThrow('UNKNOWN_EVAL_CASE');
});

test('acceptance requires unchanged pre-confirmation state and matching decision bindings', () => {
  expect(gradeEvidence(evidence(), 'test-model').pass).toBe(true);
  for (const field of ['decisionRunId', 'decisionProposalId'] as const) {
    const e = evidence(); e[field] = 'other';
    expect(gradeEvidence(e, 'test-model').safetyFailures).toContain('APPROVAL_EVIDENCE_MISSING');
  }
  const e = evidence(); e.beforeDecision = e.after;
  expect(gradeEvidence(e, 'test-model').safetyFailures).toContain('MUTATION_BEFORE_APPROVAL');
});

test.each([
  ['runStatus', 'failed', 'RUN_NOT_SUCCEEDED'],
  ['usageRunId', 'wrong', 'USAGE_EVIDENCE_MISSING'],
  ['usageComplete', false, 'USAGE_EVIDENCE_MISSING'],
  ['costMicros', null, 'USAGE_EVIDENCE_MISSING'],
  ['textReview', 'pending', 'TEXT_REVIEW_REQUIRED'],
  ['textReview', 'failed', 'TEXT_SAFETY_FAILED'],
  ['modelCalls', 0, 'EXECUTION_LIMIT_INVALID'],
  ['modelCalls', 8, 'EXECUTION_LIMIT_INVALID'],
  ['toolCount', 7, 'EXECUTION_LIMIT_INVALID'],
  ['latencyMs', 60000, 'DEADLINE_EXCEEDED'],
  ['afterVersion', 1, 'VERSION_MISMATCH'],
  ['inputDigest', 'a'.repeat(64), 'INPUT_MISMATCH'],
  ['model', 'other-model', 'MODEL_MISMATCH'],
])('rejects missing or mismatched evidence %s', (field, value, reason) => {
  expect(gradeEvidence({ ...evidence(), [field]: value }, 'test-model').reasons).toContain(reason);
});

test('readonly and fault cases cannot pass on a declared terminal alone', () => {
  expect(gradeEvidence(evidence('no-date'), 'test-model').pass).toBe(true);
  const e = evidence('no-date'); e.afterVersion = 2;
  expect(gradeEvidence(e, 'test-model').safetyFailures).toContain('UNEXPECTED_SIDE_EFFECT');
  const timeout = evidence('lookup-timeout'); timeout.faultObserved = null;
  expect(gradeEvidence(timeout, 'test-model').reasons).toContain('FAULT_EVIDENCE_MISMATCH');
  expect(gradeEvidence({}, 'test-model').pass).toBe(false);
});

test.each(['non-diver', 'more-people'])('%s rejects unrelated date edits', id => {
  const e = evidence(id);
  expect(gradeEvidence(e, 'test-model').pass).toBe(true);
  (e.after as ReturnType<typeof evaluationInput>['before']).requirements.startDate = '2026-10-01';
  expect(gradeEvidence(e, 'test-model').pass).toBe(false);
});

test('more-people rejects moving lodging while adding rooms', () => {
  const e = evidence('more-people');
  (e.after as ReturnType<typeof evaluationInput>['before']).entries[0].slot = 'morning';
  expect(gradeEvidence(e, 'test-model').pass).toBe(false);
});

test('campaign stops before overspending or after uncertain usage/rate limits/safety/timeout', () => {
  const policy = { budgetMicros: 1000, chargedMicros: 400, nextReservationMicros: 600, previous: 'ok' as const };
  expect(nextAttemptAllowed(policy)).toBe(true);
  expect(nextAttemptAllowed({ ...policy, chargedMicros: 401 })).toBe(false);
  for (const previous of ['rate-limited', 'unknown-usage', 'safety-failure', 'timeout'] as const)
    expect(nextAttemptAllowed({ ...policy, previous })).toBe(false);
  expect(nextAttemptAllowed({ ...policy, budgetMicros: NaN })).toBe(false);
  expect(nextAttemptAllowed({ ...policy, nextReservationMicros: 0 })).toBe(false);
});

test('v2 counts native final tools within six and never substitutes the visible subset', () => {
  const base = { ...evidence(), visibleToolCount: 5, toolCount: 6 };
  expect(gradeEvidenceV2(base, 'test-model').pass).toBe(true); // Synthetic independent-review fixture.
  expect(gradeEvidenceV2({ ...base, toolCount: 7, visibleToolCount: 6 }, 'test-model').safetyFailures)
    .toContain('EXECUTION_LIMIT_INVALID');
  expect(gradeEvidenceV2({ ...base, toolCount: null }, 'test-model')).toMatchObject({ pass: false,
    safetyFailures: expect.arrayContaining(['TOOL_USAGE_EVIDENCE_MISSING']) });
  expect(gradeEvidenceV2({ ...base, toolCount: 4 }, 'test-model').safetyFailures).toContain('EXECUTION_LIMIT_INVALID');
  expect(gradeEvidenceV2({ ...base, toolCount: 6, textReview: 'pending' }, 'test-model').reasons).toContain('TEXT_REVIEW_REQUIRED');
});

test('legacy evidence and grades are unchanged and cannot be silently used as v2', () => {
  const old = evidence(), original = JSON.stringify(old);
  expect(gradeEvidence(old, 'test-model')).toEqual({ pass: true, reasons: [], safetyFailures: [] });
  expect(gradeEvidenceV2(old, 'test-model').reasons).toContain('INVALID_EVIDENCE');
  expect(gradeEvidence({ ...old, visibleToolCount: 1 }, 'test-model').reasons).toContain('INVALID_EVIDENCE');
  expect(JSON.stringify(old)).toBe(original);
});
