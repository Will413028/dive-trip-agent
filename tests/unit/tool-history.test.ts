import { createEvent, type Event } from '@google/adk';
import { expect, test } from 'vitest';
import { toolEvidence } from '../../src/agent/answer-evidence';
import { readToolHistory, resolveValidationResult, READ_TOOL_NAMES } from '../../src/agent/tool-history';
import { expandAgentChanges } from '../../src/agent/tool-schemas';
import { buildProposal } from '../../src/domain/proposal';
import { makeSnapshot } from '../support/domain-fixtures';

function event(parts: NonNullable<Event['content']>['parts'], author = 'agent', partial = false) {
  return createEvent({ author, partial, content: { role: 'model', parts } });
}
function call(id: string | undefined, name = 'validate_changes', args: Record<string, unknown> = {}) {
  return event([{ functionCall: { id, name, args } }]);
}
function reply(id: string | undefined, name: string | undefined = 'validate_changes', response: Record<string, unknown> = {}) {
  return event([{ functionResponse: { id, name, response } }]);
}

test('pairs persisted read tools in response order without mutating history or losing original args/results', () => {
  const calls = READ_TOOL_NAMES.map((name, index) => call(`call-${index}`, name, { input: index }));
  const responses = READ_TOOL_NAMES.map((name, index) => reply(`call-${index}`, name,
    index === 3 ? { error: 'TOOL_OUTPUT_TOO_LARGE' } : { output: index })).reverse();
  const events: Event[] = JSON.parse(JSON.stringify([...calls, ...responses]));
  const before = structuredClone(events);
  expect(readToolHistory(events)).toEqual({ latestValidationCallId: 'call-3',
    records: READ_TOOL_NAMES.map((name, index) => ({ id: `call-${index}`, name, args: { input: index },
      result: index === 3 ? { error: 'TOOL_OUTPUT_TOO_LARGE' } : { output: index } })).reverse() });
  expect(events).toEqual(before);
});

test('empty, non-tool, and unrelated tool events do not create read records', () => {
  expect(readToolHistory([])).toEqual({ records: [], latestValidationCallId: undefined });
  expect(readToolHistory([event([{ text: 'not evidence' }]), call('proposal', 'propose_changes'),
    reply('proposal', 'propose_changes')])).toEqual({ records: [], latestValidationCallId: undefined });
});

test.each(['user', 'partial'] as const)('ignores %s calls and responses, including fake duplicates and validations', source => {
  const ignored = [call('budget', 'calculate_budget'), reply('budget', 'calculate_budget'),
    call('validation'), reply('absent')];
  for (const item of ignored) {
    if (source === 'user') item.author = 'user';
    else item.partial = true;
  }
  expect(readToolHistory([call('budget', 'calculate_budget'), ...ignored, reply('budget', 'calculate_budget')]))
    .toEqual({ records: [{ id: 'budget', name: 'calculate_budget', args: {}, result: {} }], latestValidationCallId: undefined });
  expect(() => readToolHistory([ignored[2], reply('validation')])).toThrow('AGENT_TOOL_HISTORY');
});

test.each(['error', 'unfinished', 'rejected', 'successful'] as const)(
  'latest validation follows call order, including parallel %s calls', kind => {
    const result = kind === 'error' ? { error: 'TOOL_OUTPUT_TOO_LARGE' } : { canApply: kind === 'successful' };
    const events = [call('first'), call('second'), call('latest'),
      ...(kind === 'unfinished' ? [] : [reply('latest', 'validate_changes', result)]), reply('second'), reply('first')];
    const history = readToolHistory(events);
    expect(history.latestValidationCallId).toBe('latest');
    expect(history.records.map(record => record.id)).toEqual(kind === 'unfinished' ? ['second', 'first'] : ['latest', 'second', 'first']);
    expect(history.records.find(record => record.id === history.latestValidationCallId)?.result)
      .toEqual(kind === 'unfinished' ? undefined : result);
  });

test('pairs parts within one event and keeps unfinished read calls out of records', () => {
  const parts = [call('validation'), reply('validation'), call('pending', 'find_items')].flatMap(item => item.content!.parts!);
  expect(readToolHistory([event(parts)])).toEqual({ latestValidationCallId: 'validation',
    records: [{ id: 'validation', name: 'validate_changes', args: {}, result: {} }] });
  expect(() => readToolHistory([event([...parts].reverse())])).toThrow('AGENT_TOOL_HISTORY');
});

test.each([
  ['missing call id', () => [call(undefined)]],
  ['empty call id', () => [call('')]],
  ['duplicate call', () => [call('same'), call('same')]],
  ['duplicate call with a different read name', () => [call('same'), call('same', 'find_items')]],
  ['read call reuses a non-read id', () => [call('same', 'propose_changes'), call('same')]],
  ['non-read call reuses a read id', () => [call('same'), call('same', 'propose_changes')]],
  ['duplicate call after completion', () => [call('same'), reply('same'), call('same')]],
  ['missing response id', () => [call('original'), reply(undefined)]],
  ['empty response id', () => [call('original'), reply('')]],
  ['response without call', () => [reply('absent')]],
  ['response before call', () => [reply('later'), call('later')]],
  ['mismatched response id', () => [call('original'), reply('different')]],
  ['mismatched read name', () => [call('original'), reply('original', 'calculate_budget')]],
  ['mismatched non-read name', () => [call('original'), reply('original', 'propose_changes')]],
  ['duplicate response', () => [call('original'), reply('original'), reply('original')]],
  ['response after error', () => [call('original'), reply('original', 'validate_changes', { error: 'FAILED' }), reply('original')]],
] as const)('rejects malformed history: %s', (_name, history) => {
  expect(() => readToolHistory(history())).toThrow('AGENT_TOOL_HISTORY');
});

test('a response with no name cannot complete a known read call', () => {
  const response = reply('original');
  delete response.content!.parts![0].functionResponse!.name;
  expect(() => readToolHistory([call('original'), response])).toThrow('AGENT_TOOL_HISTORY');
});

const binding = { ownerId: '00000000-0000-4000-8000-000000000001', tripId: '00000000-0000-4000-8000-000000000002',
  runId: '00000000-0000-4000-8000-000000000003', baseVersion: 1 };
function validationFixture(failed = false, warnings = false) {
  const snapshot = makeSnapshot();
  if (warnings) snapshot.exclusions = ['未包含船票'];
  const catalog = snapshot.entries.map(entry => entry.item);
  const args = { changes: [{ kind: 'requirements', value: failed ? { budgetMinor: 1 } : { divers: 0 } }] };
  const draft = buildProposal(snapshot, expandAgentChanges(snapshot, args.changes), catalog, 'agent');
  const result = { canApply: draft.canApply, validationId: draft.canApply ? '00000000-0000-4000-8000-000000000004' : null,
    budget: draft.budget, issues: draft.issues };
  return { snapshot, catalog, args, draft, result };
}

test.each([[false, false], [true, false], [false, true]])(
  'reconstructs complete domain validation without evidence refs (failed=%s, warnings=%s)', (failed, warnings) => {
    const f = validationFixture(failed, warnings), before = structuredClone(f);
    const resolved = resolveValidationResult(f.snapshot, f.catalog, f.args, f.result);
    expect(resolved).toEqual({ base: f.snapshot, draft: f.draft, validationId: f.result.validationId });
    expect(resolved.draft.canApply).toBe(!failed);
    expect(f.result).not.toHaveProperty('answerEvidenceRef');
    expect(toolEvidence(binding, f.snapshot, f.catalog, { id: 'validation', name: 'validate_changes', args: f.args, result: f.result }))
      .toMatchObject({ kind: 'validation', scope: 'candidate', ...resolved });
    expect(f).toEqual(before);
  });

test.each([
  ['canApply', false], ['canApply', 'true'], ['canApply', undefined],
  ['validationId', null], ['validationId', 'invented'], ['validationId', undefined],
  ['budget', undefined], ['budget', { knownMinor: 0, unknownEntryIds: [], withinBudget: true }],
  ['issues', undefined], ['issues', [{ code: 'INVENTED', message: 'not from domain' }]],
  ['error', 'TOOL_OUTPUT_TOO_LARGE'],
] as const)('validation helper and evidence both reject invalid %s (%j)', (field, value) => {
  const f = validationFixture(), result = { ...f.result, [field]: value };
  expect(() => resolveValidationResult(f.snapshot, f.catalog, f.args, result)).toThrow();
  expect(() => toolEvidence(binding, f.snapshot, f.catalog, { id: 'validation', name: 'validate_changes', args: f.args, result })).toThrow();
});

test('rejects a failed verdict with an ID, omitted domain warnings, and invalid change args', () => {
  const failed = validationFixture(true), warned = validationFixture(false, true);
  expect(() => resolveValidationResult(failed.snapshot, failed.catalog, failed.args,
    { ...failed.result, validationId: binding.runId })).toThrow('AGENT_EVIDENCE_INVALID');
  expect(warned.result.issues.length).toBeGreaterThan(0);
  expect(() => resolveValidationResult(warned.snapshot, warned.catalog, warned.args,
    { ...warned.result, issues: [] })).toThrow('AGENT_EVIDENCE_INVALID');
  expect(() => resolveValidationResult(warned.snapshot, warned.catalog,
    { changes: [{ kind: 'requirements', value: { divers: '0' } }] }, warned.result)).toThrow();
});
