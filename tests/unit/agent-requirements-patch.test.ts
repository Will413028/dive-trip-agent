import { expect, test } from 'vitest';
import type { Context } from '@google/adk';
import { evaluationInput } from '../../evals/fixtures';
import { agentToolParameters, canonicalAgentChangesSchema, expandAgentChanges } from '../../src/agent/tool-schemas';
import { buildProposal } from '../../src/domain/proposal';
import { createReadTools } from '../../src/agent/tools';

test('omission preserves fields, explicit null clears, sequential patches accumulate without mutation', () => {
  const { before } = evaluationInput('locked-budget');
  before.requirements.startDate = '2026-09-26';
  const original = structuredClone(before);
  const changes = expandAgentChanges(before, [
    { kind: 'requirements', value: { budgetMinor: 200000 } },
    { kind: 'requirements', value: { startDate: null, pace: 'relaxed' } },
  ]);
  expect(changes).toEqual([
    { kind: 'requirements', value: { ...original.requirements, budgetMinor: 200000 } },
    { kind: 'requirements', value: { ...original.requirements, budgetMinor: 200000, startDate: null, pace: 'relaxed' } },
  ]);
  expect(before).toEqual(original);
  expect(canonicalAgentChangesSchema.parse(changes)).toEqual(changes);
});

test('validate_changes retains strict partial input and legacy full compatibility; propose_changes rejects both', () => {
  const { before } = evaluationInput('locked-budget');
  for (const value of [{ pace: 'relaxed' }, { startDate: null }, before.requirements]) {
    const changes = [{ kind: 'requirements', value }];
    expect(agentToolParameters.validate_changes.safeParse({ changes }).success).toBe(true);
    expect(agentToolParameters.propose_changes.safeParse({ changes }).success).toBe(false);
    expect(agentToolParameters.propose_changes.safeParse({ validationId: '12345678-1234-4234-8234-123456789abc', changes }).success).toBe(false);
  }
  for (const value of [{}, { pace: undefined }, { pace: 'relaxed', startDate: undefined }, { days: null },
    { startDate: '' }, { startDate: '2026-02-29' }, { pace: 'relaxed', actor: 'user' }]) {
    expect(agentToolParameters.validate_changes.safeParse({ changes: [{ kind: 'requirements', value }] }).success).toBe(false);
  }
  expect(canonicalAgentChangesSchema.safeParse([{ kind: 'requirements', value: { pace: 'relaxed' } }]).success).toBe(false);
});

test('merged changes retain domain budget, cross-field and lock validation', () => {
  const { before, catalog } = evaluationInput('locked-budget');
  expect(buildProposal(before, expandAgentChanges(before, [{ kind: 'requirements', value: { budgetMinor: 200000 } }]), catalog, 'agent').canApply).toBe(false);
  expect(buildProposal(before, expandAgentChanges(before, [{ kind: 'requirements', value: { people: 1, divers: 6 } }]), catalog, 'agent').canApply).toBe(false);
  before.requirements.startDate = '2026-09-26';
  const locked = buildProposal(before, expandAgentChanges(before, [{ kind: 'requirements', value: { startDate: null } }]), catalog, 'agent');
  expect(locked.canApply).toBe(false);
  expect(locked.issues).toContainEqual(expect.objectContaining({ code: 'LOCKED_ENTRY' }));
});

test('read-only validation uses the same cumulative expansion and detached base', async () => {
  const { before, catalog } = evaluationInput('locked-budget');
  before.requirements.startDate = '2026-09-26';
  const original = structuredClone(before);
  const tool = createReadTools({ snapshot: before, catalog }).find(t => t.name === 'validate_changes')!;
  before.requirements.startDate = null;
  const changes = [{ kind: 'requirements', value: { budgetMinor: 200000 } },
    { kind: 'requirements', value: { pace: 'relaxed' } }];
  const expected = buildProposal(original, expandAgentChanges(original, changes), catalog, 'agent');
  const result = await tool.runAsync({ args: { changes }, toolContext: {} as Context });
  expect(expected.canApply).toBe(false);
  expect(result).toMatchObject({ canApply: false, validationId: null, budget: expected.budget, issues: expected.issues });
  expect(expected.next.requirements).toEqual({ ...original.requirements, budgetMinor: 200000, pace: 'relaxed' });
});
