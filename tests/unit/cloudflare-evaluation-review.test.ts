import { expect, test } from 'vitest';
import { buildReviewPacket } from '../../evals/review-packet';
import { evaluationInput } from '../../evals/fixtures';
import { CLOUDFLARE_MODEL } from '../../src/agent/cloudflare-wire';
import { ANSWER_EVENT_NAME } from '../../src/domain/answer';

function report() {
  const input = evaluationInput('ambiguous');
  return { schemaVersion: 2, model: CLOUDFLARE_MODEL, accountId: 'a'.repeat(32), transport: 'real-cloudflare-via-http-handler',
    budgetMicros: 3000000, chargedMicros: 12, stopped: null, textReview: 'pending', evaluationGatePassed: false,
    records: [{ schemaVersion: 2, round: 1, caseId: 'ambiguous', outcome: 'completed',
      evidence: { caseId: 'ambiguous', runId: '00000000-0000-4000-8000-000000000003', inputDigest: input.digest,
        model: CLOUDFLARE_MODEL, terminal: input.terminal, runStatus: 'succeeded', before: input.before, after: input.before,
        toolCount: 1, visibleToolCount: 0 },
      events: [{ type: 'CUSTOM', name: ANSWER_EVENT_NAME, value: { schemaVersion: 1, templateVersion: 1,
        answerId: `ans_${'a'.repeat(64)}`, runId: '00000000-0000-4000-8000-000000000003',
        evidenceRefs: [], body: { kind: 'clarify', fields: ['people'] } } }],
      grade: { pass: false, reasons: ['TEXT_REVIEW_REQUIRED'], safetyFailures: [] } }],
  };
}

test('Cloudflare review preserves binding and missing cases without granting acceptance', () => {
  const source = report();
  const packet = buildReviewPacket(source);
  expect(packet).toMatchObject({ model: CLOUDFLARE_MODEL, accountId: 'a'.repeat(32),
    transport: 'real-cloudflare-via-http-handler', textReview: 'pending', evaluationGatePassed: false,
    coverage: { expectedCases: 30, recordedCases: 1, missingCases: 29 } });
  expect(packet.cases[0].acceptedAnswers?.[0].body).toEqual({ kind: 'clarify', fields: ['people'] });
  expect(packet.cases[0]).not.toHaveProperty('modelProse');
  expect(packet.cases[0].observedTerminal).toBeNull();
});

test.each(['', 'A'.repeat(32), 'a'.repeat(31)])('Cloudflare review rejects invalid account %s', accountId => {
  expect(() => buildReviewPacket({ ...report(), accountId })).toThrow();
});
test('Cloudflare report cannot use Gemini or a model alias as its selected model', () => {
  for (const model of ['gemini-3.1-flash-lite', `${CLOUDFLARE_MODEL}-external`]) {
    expect(() => buildReviewPacket({ ...report(), model })).toThrow();
  }
});
test('Cloudflare attempt must carry the same selected model as the report', () => {
  const source = report(); source.records[0].evidence.model = 'gemini-3.1-flash-lite';
  expect(() => buildReviewPacket(source)).toThrow('EVAL_REVIEW_MODEL_MISMATCH');
});

test('missing account and attempt model are not inferred from transport', () => {
  expect(() => buildReviewPacket({ ...report(), accountId: undefined })).toThrow();
  const source = report();
  expect(() => buildReviewPacket({ ...source, records: [{ ...source.records[0],
    evidence: { ...source.records[0].evidence, model: undefined } }] })).toThrow('EVAL_REVIEW_MODEL_MISMATCH');
});
test('Cloudflare source cannot self-certify prose or release acceptance', () => {
  expect(buildReviewPacket({ ...report(), textReview: 'passed', evaluationGatePassed: true }))
    .toMatchObject({ textReview: 'pending', evaluationGatePassed: false });
});

function withPrivate(accountId = 'a'.repeat(32), runId = '00000000-0000-4000-8000-000000000003') {
  const source = report();
  const privateUsage = { schemaVersion: 2, runId,
    binding: { provider: 'cloudflare', model: CLOUDFLARE_MODEL, accountId }, invocations: [], calls: [] };
  return { ...source, records: [...source.records, { round: 1, caseId: 'ambiguous', kind: 'durable-audit',
    chargedMicros: 12, runs: [{ id: runId, status: 'succeeded', proposal_id: null, interrupt_id: null, decision: null }],
    events: source.records[0].events.map((event, sequence) => ({ run_id: runId, sequence, event })),
    privateUsage: [privateUsage], privateUsageComplete: true }] };
}
test('Cloudflare private review evidence keeps the account and does not certify empty usage', () => {
  const packet = buildReviewPacket(withPrivate());
  expect(packet.cases[0].privateUsageEvidence?.[0]).toMatchObject({ schemaVersion: 2,
    binding: { provider: 'cloudflare', accountId: 'a'.repeat(32) } });
  expect(packet.evaluationGatePassed).toBe(false);
});
test('foreign durable event text cannot be relabeled as a failed Cloudflare case', () => {
  const source = withPrivate();
  const audit = source.records[1];
  expect(() => buildReviewPacket({ ...source, records: [
    { round: 1, caseId: 'ambiguous', outcome: 'failed', reason: 'EVAL_EXCEPTION_STOP', costMicros: null },
    { ...audit, events: [{ run_id: '00000000-0000-4000-8000-000000000099', sequence: 1,
      event: source.records[0].events![0] }] },
  ] })).toThrow('EVAL_REVIEW_USAGE_BINDING_MISMATCH');
});
test('Cloudflare private usage cannot be relabeled as a Gemini review', () => {
  expect(() => buildReviewPacket({ ...withPrivate(), transport: 'real-gemini-via-http-handler' }))
    .toThrow('EVAL_REVIEW_USAGE_BINDING_MISMATCH');
});
test('private evidence from another account or run cannot be attached to a Cloudflare case', () => {
  expect(() => buildReviewPacket(withPrivate('b'.repeat(32)))).toThrow('EVAL_REVIEW_USAGE_BINDING_MISMATCH');
  expect(() => buildReviewPacket(withPrivate('a'.repeat(32), '00000000-0000-4000-8000-000000000004')))
    .toThrow('EVAL_REVIEW_USAGE_BINDING_MISMATCH');
});

test.each([true, false])('campaign drain metadata %s is reviewable without granting acceptance', quiescent => {
  const source = withPrivate();
  source.records[1] = { ...source.records[1], ...{ quiescent } };
  const original = JSON.stringify(source);
  const packet = buildReviewPacket(source);
  expect(packet.cases[0]).toMatchObject({ quiescent, textReview: 'pending' });
  expect(packet.evaluationGatePassed).toBe(false);
  expect(JSON.stringify(source)).toBe(original);
});
test('missing drain metadata stays unknown and malformed metadata is rejected', () => {
  expect(buildReviewPacket(withPrivate()).cases[0].quiescent).toBeNull();
  const source = withPrivate();
  expect(() => buildReviewPacket({ ...source, records: [source.records[0],
    { ...source.records[1], quiescent: 'true' }] })).toThrow();
});
