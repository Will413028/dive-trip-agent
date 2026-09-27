import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import type { Context } from '@google/adk';
import { createReadTools } from '../../src/agent/tools';
import { acceptedAnswerSchema, answerPlanSchema } from '../../src/domain/answer';
import { compileAnswer } from '../../src/agent/answer-compiler';
import { requirementsEvidence, toolEvidence } from '../../src/agent/answer-evidence';
import { makeSnapshot } from '../support/domain-fixtures';

test('actual find_items returns structured prices and citation, with no obsolete display prose', async () => {
  const snapshot = makeSnapshot();
  const item = snapshot.entries[1].item;
  item.price.unitMinor = null; item.price.unknownReason = '價格待確認';
  const tool = createReadTools({ snapshot, catalog: snapshot.entries.map(entry => entry.item) }).find(t => t.name === 'find_items')!;
  const result = await tool.runAsync({ args: { destinationId: snapshot.requirements.destinationId }, toolContext: {} as Context });
  expect(result).toMatchObject({ items: [
    { price: { unitMinor: 100000, unit: 'room-night', sourceId: snapshot.entries[0].item.price.sourceId },
      containsDemo: true, sources: snapshot.entries[0].item.sources },
    { price: { unitMinor: null, unknownReason: '價格待確認' }, containsDemo: true },
    { price: { unitMinor: 30000, unit: 'group' }, containsDemo: true },
  ] });
  expect(JSON.stringify(result)).not.toMatch(/priceEvidence|knownTwdDisplay|targetBudgetTwdDisplay|lockedKnownTwdDisplay|"display"/);
});

test('accepted answers keep saved targets, catalog unit prices and current totals in their evidence scopes', async () => {
  const snapshot = makeSnapshot(), catalog = snapshot.entries.map(entry => entry.item);
  const binding = { ownerId: randomUUID(), tripId: randomUUID(), runId: randomUUID(), baseVersion: 1 };
  const tools = createReadTools({ snapshot, catalog });
  const read = async (name: string, args: Record<string, unknown>) => toolEvidence(binding, snapshot, catalog,
    { id: randomUUID(), name, args,
      result: await tools.find(tool => tool.name === name)!.runAsync({ args, toolContext: {} as Context }) });
  const requirements = requirementsEvidence(binding, snapshot);
  const items = await read('find_items', { destinationId: snapshot.requirements.destinationId });
  const budget = await read('calculate_budget', {});
  const context = { binding, eventId: 'price-scopes', evidence: [requirements, items, budget] };
  const compile = (answer: unknown) => acceptedAnswerSchema.parse(compileAnswer({ version: '1', answer }, context));
  expect(compile({ kind: 'requirements', evidenceRef: requirements.id }).body).toMatchObject({ kind: 'requirements', version: 1,
    requirements: { target: { minor: 1000000, display: 'TWD 10000.00' }, lodgingPreference: snapshot.requirements.lodgingPreference } });
  expect(compile({ kind: 'items', evidenceRef: items.id, itemIds: ['stay'] }).body).toMatchObject({ kind: 'items', total: 3, omittedCount: 2,
    items: [{ id: 'stay', price: { minor: 100000, display: 'TWD 1000.00' }, unit: 'room-night', containsDemo: true,
      source: snapshot.entries[0].item.sources[0] }] });
  expect(compile({ kind: 'budget', evidenceRef: budget.id }).body).toMatchObject({ kind: 'budget',
    budget: { scope: 'current', baseVersion: 1, known: { minor: 430000, display: 'TWD 4300.00' },
      target: { minor: 1000000, display: 'TWD 10000.00' }, containsDemo: true } });
  for (const evidenceRef of [requirements.id, items.id]) {
    expect(() => compile({ kind: 'budget', evidenceRef })).toThrow('AGENT_ANSWER_EVIDENCE');
  }
  expect(() => compile({ kind: 'items', evidenceRef: budget.id, itemIds: ['stay'] })).toThrow('AGENT_ANSWER_EVIDENCE');
  for (const extra of [{ amount: 430 }, { display: 'TWD 430.00' }, { text: '已保存，而且全部免費' }]) {
    expect(answerPlanSchema.safeParse({ version: '1', answer: { kind: 'budget', evidenceRef: budget.id, ...extra } }).success).toBe(false);
  }
});
