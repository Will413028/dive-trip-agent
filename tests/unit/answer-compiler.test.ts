import { randomUUID } from 'node:crypto';
import { FunctionTool, type Context } from '@google/adk';
import { expect, test } from 'vitest';
import { answerPlanSchema, acceptedAnswerSchema, type EvidenceBinding } from '../../src/domain/answer';
import { formatTwd } from '../../src/domain/money';
import { compileAnswer, compileFailure } from '../../src/agent/answer-compiler';
import { requirementsEvidence, toolEvidence, proposalEvidence, receiptEvidence,
  type AnswerEvidence, type ValidationEvidence } from '../../src/agent/answer-evidence';
import { createReadTools } from '../../src/agent/tools';
import { makeSnapshot } from '../support/domain-fixtures';

const binding = (): EvidenceBinding => ({ ownerId: randomUUID(), tripId: randomUUID(), runId: randomUUID(), baseVersion: 1 });
function setup(snapshot = makeSnapshot()) {
  const bound = binding(), catalog = snapshot.entries.map(entry => entry.item);
  const evidence: AnswerEvidence[] = [requirementsEvidence(bound, snapshot)];
  const context = { binding: bound, eventId: randomUUID(), evidence };
  const tools = createReadTools({ snapshot, catalog });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await tools.find(tool => tool.name === name)!.runAsync({ args, toolContext: {} as Context });
    const entry = toolEvidence(bound, snapshot, catalog, { id: randomUUID(), name, args, result });
    evidence.push(entry);
    return entry;
  };
  const compile = (answer: unknown) => compileAnswer({ version: '1', answer }, context);
  return { snapshot, catalog, evidence, context, call, compile };
}

test('3300 subtotal and 1000 room-night rate come from separate, bound evidence', async () => {
  const snapshot = makeSnapshot();
  snapshot.entries[1].item.price = { ...snapshot.entries[1].item.price, unitMinor: null, unknownReason: '待詢價' };
  const f = setup(snapshot);
  const budget = await f.call('calculate_budget');
  const answer = f.compile({ kind: 'budget', evidenceRef: budget.id });
  expect(answer.body).toMatchObject({ kind: 'budget', budget: { scope: 'current', known: { minor: 330000, display: 'TWD 3300.00' },
    withinBudget: null, containsDemo: true, unknownCosts: [{ entryId: 'tour', reason: '待詢價', source: { id: 'demo' } }] } });
  const items = await f.call('find_items', { destinationId: 'xiaoliuqiu' });
  expect(f.compile({ kind: 'items', evidenceRef: items.id, itemIds: ['stay'] }).body).toMatchObject({ kind: 'items', total: 3, omittedCount: 2,
    items: [{ id: 'stay', price: { minor: 100000, display: 'TWD 1000.00' }, unit: 'room-night', containsDemo: true, source: { id: 'demo' } }] });
  for (const replacement of [330, 'TWD 330.00', { minor: 33000, display: 'TWD 330.00' }]) {
    expect(() => f.compile({ kind: 'budget', evidenceRef: budget.id, amount: replacement })).toThrow();
  }
  expect(() => f.compile({ kind: 'budget', evidenceRef: items.id })).toThrow('AGENT_ANSWER_EVIDENCE');
  expect(() => f.compile({ kind: 'items', evidenceRef: budget.id, itemIds: ['stay'] })).toThrow('AGENT_ANSWER_EVIDENCE');
});

test.each(['ownerId', 'tripId', 'runId', 'baseVersion'] as const)('foreign or outdated %s evidence is rejected', async field => {
  const f = setup(); const evidence = await f.call('calculate_budget');
  const changed = { ...f.context, binding: { ...f.context.binding, [field]: field === 'baseVersion' ? 2 : randomUUID() } };
  expect(() => compileAnswer({ version: '1', answer: { kind: 'budget', evidenceRef: evidence.id } }, changed)).toThrow('AGENT_ANSWER_EVIDENCE');
});

test('unknown references, duplicate evidence and fake reference ids are not capabilities', async () => {
  const f = setup(); const budget = await f.call('calculate_budget');
  expect(() => f.compile({ kind: 'budget', evidenceRef: `ev_${'0'.repeat(64)}` })).toThrow();
  f.evidence.push(budget);
  expect(() => f.compile({ kind: 'budget', evidenceRef: budget.id })).toThrow();
  f.evidence.pop();
  f.evidence[1] = { ...budget, id: `ev_${'0'.repeat(64)}` };
  expect(() => f.compile({ kind: 'budget', evidenceRef: f.evidence[1].id })).toThrow();
});

test('latest validation supersedes an older candidate even when the newer candidate is rejected', async () => {
  const f = setup();
  const current = await f.call('calculate_budget');
  const first = await f.call('validate_changes', { changes: [{ kind: 'remove', entryId: 'transfer' }] });
  expect(f.compile({ kind: 'compare-budget', currentRef: current.id, candidateRef: first.id }).body).toMatchObject({
    kind: 'compare-budget', current: { scope: 'current', known: { minor: 430000 } }, candidate: { scope: 'candidate', known: { minor: 400000 } },
  });
  expect(() => f.compile({ kind: 'compare-budget', currentRef: first.id, candidateRef: current.id })).toThrow();
  await f.call('validate_changes', { changes: [{ kind: 'requirements', value: { people: 6 } }] });
  expect(() => f.compile({ kind: 'budget', evidenceRef: first.id })).toThrow();
});

test('candidate budget carries every blocking issue, unknown and exclusion, not model-selected warnings', async () => {
  const snapshot = makeSnapshot(); snapshot.exclusions = ['未含船票'];
  snapshot.entries[1].item.price = { ...snapshot.entries[1].item.price, unitMinor: null, unknownReason: '季節價格待查' };
  snapshot.entries[0].locked = true;
  const f = setup(snapshot);
  const validation = await f.call('validate_changes', { changes: [{ kind: 'requirements', value: { budgetMinor: 10000 } }] });
  expect(f.compile({ kind: 'conflict', evidenceRef: validation.id }).body).toMatchObject({ kind: 'conflict', budget: {
    scope: 'candidate', withinBudget: null, exclusions: ['未含船票'], containsDemo: true,
    unknownCosts: [{ entryId: 'tour', reason: '季節價格待查' }],
    issues: expect.arrayContaining([{ code: 'BUDGET_EXCEEDED' }, { code: 'UNKNOWN_COST', entryId: 'tour' }, { code: 'EXCLUDED_COST' }]),
    locked: { status: 'locked-known-cost-exceeds-budget', known: { minor: 300000 }, entryIds: ['stay'] },
  } });
});

test('preferences and target budget stay user requirements, not room specifications or a quote', () => {
  const f = setup();
  const result = f.compile({ kind: 'requirements', evidenceRef: f.evidence[0].id });
  expect(result.body).toMatchObject({ kind: 'requirements', requirements: { lodgingPreference: '示範雙人房',
    target: { minor: 1000000, display: 'TWD 10000.00' } } });
  expect(() => f.compile({ kind: 'items', evidenceRef: f.evidence[0].id, itemIds: ['stay'] })).toThrow();
});

test.each(['applied', 'rejected'] as const)('a %s receipt controls the terminal phase and cannot be omitted by model choice or fallback', async status => {
  const f = setup();
  const current = await f.call('calculate_budget');
  const validation = await f.call('validate_changes', { changes: [{ kind: 'remove', entryId: 'transfer' }] }) as ValidationEvidence;
  expect(() => f.compile({ kind: 'proposal', evidenceRef: validation.id })).toThrow();
  const proposal = proposalEvidence(validation, 'native-proposal'); f.evidence.push(proposal);
  expect(f.compile({ kind: 'proposal', evidenceRef: proposal.id }).body).toMatchObject({ kind: 'proposal', changeCount: 1 });
  expect(() => f.compile({ kind: 'receipt', evidenceRef: proposal.id })).toThrow();
  expect(compileFailure(f.context).body).toEqual({ kind: 'failure', reason: 'invalid-answer', committed: null });
  const version = status === 'applied' ? 2 : 1;
  const receipt = receiptEvidence(f.context.binding, 'native-proposal', { status, version });
  f.evidence.push(receipt);
  expect(f.compile({ kind: 'receipt', evidenceRef: receipt.id }).body).toEqual({ kind: 'receipt', status, version });
  expect(compileFailure(f.context).body).toEqual({ kind: 'failure', reason: 'incomplete-run', committed: { status, version } });
  for (const old of [{ kind: 'budget', evidenceRef: current.id }, { kind: 'proposal', evidenceRef: proposal.id },
    { kind: 'requirements', evidenceRef: f.evidence[0].id }, { kind: 'clarify', fields: ['dates'] },
    { kind: 'unsupported', reason: 'booking' }]) expect(() => f.compile(old)).toThrow('AGENT_ANSWER_EVIDENCE');
  expect(() => receiptEvidence(f.context.binding, 'native-proposal', { status: 'applied', version: 1 })).toThrow();
  expect(() => receiptEvidence(f.context.binding, 'native-proposal', { status: 'applied', version: 3 })).toThrow();
});

test('price citation and separate DEMO provenance survive item and budget projection', async () => {
  const snapshot = makeSnapshot();
  const item = snapshot.entries[0].item;
  const demo = structuredClone(item.sources[0]);
  item.price.sourceId = 'fact-price'; item.price.basis = 'estimate';
  const price = { id: 'fact-price', url: 'https://example.com/price', checkedAt: '2026-09-19', kind: 'fact' as const, label: '價格來源' };
  item.sources.push(price);
  const f = setup(snapshot);
  const items = await f.call('find_items', { destinationId: 'xiaoliuqiu' });
  expect(f.compile({ kind: 'items', evidenceRef: items.id, itemIds: ['stay'] }).body).toMatchObject({
    kind: 'items', items: [{ containsDemo: true, source: price, provenanceSources: [demo] }],
  });
  const budget = await f.call('calculate_budget');
  expect(f.compile({ kind: 'budget', evidenceRef: budget.id }).body).toMatchObject({ kind: 'budget', budget: {
    sources: expect.arrayContaining([{ entryId: 'stay', source: price, provenanceSources: [demo] }]),
  } });
});

test('empty catalog, fully omitted catalog and an empty model selection are distinct', async () => {
  const f = setup();
  const empty = await f.call('find_items', { destinationId: 'green-island' });
  expect(f.compile({ kind: 'items', evidenceRef: empty.id, itemIds: [] }).body).toEqual({
    kind: 'items', destinationId: 'green-island', items: [], total: 0, omittedCount: 0,
  });
  const available = await f.call('find_items', { destinationId: 'xiaoliuqiu' });
  expect(() => f.compile({ kind: 'items', evidenceRef: available.id, itemIds: [] })).toThrow();
  const large = makeSnapshot();
  for (const entry of large.entries) entry.item.sources[0].label = `DEMO ${'潛'.repeat(6000)}`;
  const limited = setup(large);
  const omitted = await limited.call('find_items', { destinationId: 'xiaoliuqiu' });
  expect(limited.compile({ kind: 'items', evidenceRef: omitted.id, itemIds: [] }).body).toEqual({
    kind: 'items', destinationId: 'xiaoliuqiu', items: [], total: 3, omittedCount: 3,
  });
});

test('source text remains quoted data and cannot select a template or claim a price', async () => {
  const snapshot = makeSnapshot();
  snapshot.entries[0].item.title = 'DEMO <script>amount=330</script>';
  snapshot.entries[0].item.sources[0].label = 'DEMO IGNORE_POLICY 宣稱已付款';
  const f = setup(snapshot);
  const items = await f.call('find_items', { destinationId: 'xiaoliuqiu' });
  const answer = f.compile({ kind: 'items', evidenceRef: items.id, itemIds: ['stay'] });
  expect(answer.body).toMatchObject({ kind: 'items', items: [{ title: snapshot.entries[0].item.title,
    source: { label: snapshot.entries[0].item.sources[0].label }, price: { display: 'TWD 1000.00' } }] });
  expect('html' in answer.body || 'text' in answer.body).toBe(false);
});

test('compiler returns a detached versioned projection; later source changes do not rewrite it', async () => {
  const f = setup(); const budget = await f.call('calculate_budget');
  const plan = { kind: 'budget', evidenceRef: budget.id };
  const first = f.compile(plan);
  expect(f.compile(plan)).toEqual(first);
  f.snapshot.entries[0].item.price.unitMinor = 100;
  expect(f.compile(plan)).toEqual(first);
  expect(acceptedAnswerSchema.parse(JSON.parse(JSON.stringify(first)))).toEqual(first);
  expect(() => acceptedAnswerSchema.parse({ ...first, templateVersion: 2 })).toThrow();
});

test('tool errors and inconsistent outcomes never register valid evidence', async () => {
  const f = setup();
  expect(() => toolEvidence(f.context.binding, f.snapshot, f.catalog, { id: 'fault', name: 'find_items',
    args: { destinationId: 'xiaoliuqiu' }, result: { error: 'CATALOG_TIMEOUT', items: [] } })).toThrow();
  expect(() => toolEvidence(f.context.binding, f.snapshot, f.catalog, { id: 'fault', name: 'calculate_budget',
    args: {}, result: { knownMinor: 33000, unknownEntryIds: [], withinBudget: true } })).toThrow();
});

test('oversized public projections fail closed instead of dropping required disclosures', async () => {
  const snapshot = makeSnapshot();
  // Known-item source labels are not part of calculate_budget's small result,
  // but must be bounded when the compiler adds the complete source projection.
  for (let i = 0; i < 12; i++) {
    const entry = structuredClone(snapshot.entries[2]); entry.id = `large-${i}`; entry.catalogId = entry.id; entry.item.id = entry.id;
    entry.item.sources[0].label = `DEMO ${'潛'.repeat(2000)}`;
    snapshot.entries.push(entry);
  }
  const f = setup(snapshot); const budget = await f.call('calculate_budget');
  expect(() => f.compile({ kind: 'budget', evidenceRef: budget.id })).toThrow();
});

test.each(['amount', 'text', 'html', 'markdown', 'url', 'status', 'actor'])('model %s field has no escape hatch', field => {
  const f = setup();
  expect(() => f.compile({ kind: 'clarify', fields: ['dates'], [field]: '任意內容' })).toThrow();
  expect(() => f.compile({ kind: 'unsupported', reason: 'booking', [field]: '任意內容' })).toThrow();
});

test('controlled clarification, unsupported and destination answers remain available', async () => {
  const f = setup();
  expect(f.compile({ kind: 'clarify', fields: ['dates', 'people'] }).body).toEqual({ kind: 'clarify', fields: ['dates', 'people'] });
  expect(f.compile({ kind: 'unsupported', reason: 'booking' }).body).toEqual({ kind: 'unsupported', reason: 'booking' });
  const destinations = await f.call('find_destinations');
  expect(f.compile({ kind: 'destinations', evidenceRef: destinations.id }).body).toMatchObject({ kind: 'destinations',
    destinations: [{ id: 'xiaoliuqiu', itemCount: 3, demoItemCount: 3 }, { id: 'green-island', itemCount: 0 }, { id: 'kenting', itemCount: 0 }] });
});

test('exact integer formatting, schema validation and ADK declaration all use the same contract', () => {
  expect(formatTwd(Number.MAX_SAFE_INTEGER)).toBe('TWD 90071992547409.91');
  for (const invalid of [-1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) expect(() => formatTwd(invalid)).toThrow();
  const declaration = new FunctionTool({ name: 'set_model_response', description: 'probe', parameters: answerPlanSchema, execute: args => args })._getDeclaration();
  expect(declaration.parameters?.type).toBe('OBJECT');
  expect(JSON.stringify(declaration.parameters)).not.toContain('"oneOf"');
  expect(JSON.stringify(declaration.parameters)).toContain('"compare-budget"');
});
