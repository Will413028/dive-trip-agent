import { expect, test } from 'vitest';
import type { Context } from '@google/adk';
import { evaluationInput } from '../../evals/fixtures';
import { createReadTools } from '../../src/agent/tools';

function setup() {
  const { before, catalog } = evaluationInput('locked-budget');
  const call = (name: string, changes?: unknown[]) => createReadTools({ snapshot: before, catalog })
    .find(tool => tool.name === name)!.runAsync({ args: changes ? { changes } : {}, toolContext: {} as Context });
  return { before, catalog, call };
}
test('locked-budget evidence exposes the requested limit and unavoidable known subtotal with DEMO disclosure', async () => {
  const { before, call } = setup(), original = structuredClone(before);
  const result = await call('validate_changes', [{ kind: 'requirements', value: { budgetMinor: 200000 } }]);
  expect(result).toMatchObject({ canApply: false,
    priceDisclosure: { containsDemo: true },
    budgetConstraint: { status: 'locked-known-cost-exceeds-budget', targetBudgetMinor: 200000,
      lockedKnownMinor: 300000, lockedEntryIds: ['stay'], unknownLockedEntryIds: [] },
  });
  expect(before).toEqual(original);
  expect(JSON.stringify(result)).not.toMatch(/knownTwdDisplay|targetBudgetTwdDisplay|lockedKnownTwdDisplay/);
});
test.each([null, 300000, 400000])('non-exceeding locked subtotal is not proof of feasibility for %s', async budgetMinor => {
  const { call } = setup();
  expect(await call('validate_changes', [{ kind: 'requirements', value: { budgetMinor } }]))
    .toMatchObject({ budgetConstraint: { status: budgetMinor === null ? 'budget-unspecified' : 'not-proven-infeasible' } });
});
test('unknown locked cost stays unknown; known subtotal can still prove excess with excluded costs', async () => {
  const { before, call } = setup();
  before.entries[0].item.price.unitMinor = null;
  before.entries[0].item.price.unknownReason = '待確認';
  expect(await call('validate_changes', [{ kind: 'requirements', value: { budgetMinor: 200000 } }]))
    .toMatchObject({ budgetConstraint: { status: 'not-proven-infeasible', lockedKnownMinor: 0, unknownLockedEntryIds: ['stay'] } });
  before.entries[0].item.price.unitMinor = 100000;
  before.entries[0].item.price.unknownReason = null;
  before.exclusions = ['船票未計'];
  expect(await call('validate_changes', [{ kind: 'requirements', value: { budgetMinor: 200000 } }]))
    .toMatchObject({ budgetConstraint: { status: 'locked-known-cost-exceeds-budget' } });
});
test.each([
  { changes: [{ kind: 'remove', entryId: 'stay' }] },
  { changes: [{ kind: 'requirements', value: { days: 2, budgetMinor: 200000 } }] },
  { changes: [{ kind: 'requirements', value: { people: 3, budgetMinor: 200000 } }] },
  { changes: [{ kind: 'requirements', value: { people: 1, divers: 6, budgetMinor: 200000 } }] },
])('invalid/locked edits do not produce a feasibility claim: %j', async ({ changes }) => {
  expect(await setup().call('validate_changes', changes)).toMatchObject({ canApply: false,
    budgetConstraint: { status: 'unavailable', lockedKnownMinor: null, targetBudgetMinor: null } });
});
test('current calculation carries DEMO; estimate-only candidate and demo provenance are distinguished', async () => {
  const { before, call } = setup();
  expect(await call('calculate_budget')).toMatchObject({
    priceDisclosure: { containsDemo: true }, budgetConstraint: { targetBudgetMinor: 1000000, lockedKnownMinor: 300000 } });
  for (const entry of before.entries) {
    entry.item.price.basis = 'estimate';
    entry.item.sources[0].kind = 'fact';
    entry.item.sources[0].url = 'https://example.com/synthetic-price';
  }
  expect(await call('calculate_budget')).toMatchObject({ priceDisclosure: { containsDemo: false } });
  before.entries[0].item.sources[0].kind = 'demo';
  expect(await call('calculate_budget')).toMatchObject({ priceDisclosure: { containsDemo: true } });
});

test('locked per-person price uses candidate participants; no locked entries does not imply feasible', async () => {
  const { before, call } = setup();
  before.entries[0].locked = false;
  before.entries[1].locked = true;
  expect(await call('validate_changes', [{ kind: 'requirements', value: { people: 1, budgetMinor: 75000 } }]))
    .toMatchObject({ budgetConstraint: { lockedKnownMinor: 50000, status: 'not-proven-infeasible' } });
  expect(await call('validate_changes', [{ kind: 'requirements', value: { budgetMinor: 75000 } }]))
    .toMatchObject({ budgetConstraint: { lockedKnownMinor: 100000, status: 'locked-known-cost-exceeds-budget' } });
  before.entries[1].locked = false;
  expect(await call('validate_changes', [{ kind: 'requirements', value: { budgetMinor: 0 } }]))
    .toMatchObject({ canApply: false, budgetConstraint: { lockedKnownMinor: 0,
      lockedEntryIds: [], status: 'not-proven-infeasible' } });
});

test('mixed known and unknown locked prices retain a provable known lower bound', async () => {
  const { before, call } = setup();
  before.entries[1].locked = true;
  before.entries[1].item.price.unitMinor = null;
  before.entries[1].item.price.unknownReason = '待確認';
  expect(await call('validate_changes', [{ kind: 'requirements', value: { budgetMinor: 200000 } }]))
    .toMatchObject({ budget: { withinBudget: null }, budgetConstraint: {
      status: 'locked-known-cost-exceeds-budget', lockedKnownMinor: 300000, unknownLockedEntryIds: ['tour'] } });
});
