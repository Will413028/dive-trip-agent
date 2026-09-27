import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { App, BaseLlm, createEvent, FunctionTool, InMemorySessionService, LlmAgent, Runner,
  type Event, type LlmRequest, type LlmResponse, type BaseLlmConnection } from '@google/adk';
import { confirmationGates } from '../../src/agent/confirmation';
import { createReadTools } from '../../src/agent/tools';
import { GuardedModel } from '../../src/agent/model-guard';
import { agentToolParameters, expandAgentChanges } from '../../src/agent/tool-schemas';
import { buildProposal } from '../../src/domain/proposal';
import { makeSnapshot } from '../support/domain-fixtures';

const snapshot = makeSnapshot(), catalog = snapshot.entries.map(entry => entry.item);
const changes = [{ kind: 'requirements', value: { divers: 0 } }];
const validationId = randomUUID();
const draft = buildProposal(snapshot, expandAgentChanges(snapshot, changes), catalog, 'agent');
const validationResult = { canApply: draft.canApply, validationId, budget: draft.budget, issues: draft.issues };
function event(parts: NonNullable<Event['content']>['parts'], author = 'agent') {
  return createEvent({ author, content: { role: 'model', parts } });
}
function validation(args: unknown = { changes }, response: Record<string, unknown> = validationResult, id = 'validate') {
  return [event([{ functionCall: { id, name: 'validate_changes', args: args as Record<string, unknown> } }]),
    event([{ functionResponse: { id, name: 'validate_changes', response } }])];
}
function gate(args: Record<string, unknown> = { validationId }) {
  return event([{ functionCall: { id: 'interrupt', name: 'adk_request_confirmation', args: {
    originalFunctionCall: { id: 'proposal', name: 'propose_changes', args },
  } } }]);
}

test('reference resolves exact validated canonical changes after JSON persistence; no numeric coercion', () => {
  const events = [...validation(), gate()];
  const result = confirmationGates(JSON.parse(JSON.stringify(events)), snapshot, catalog);
  expect(result).toEqual([{ interruptId: 'interrupt', toolCallId: 'proposal', eventId: events.at(-1)!.id,
    changes: expandAgentChanges(snapshot, changes) }]);
  expect(result[0].changes[0]).toMatchObject({ value: { divers: 0, startDate: snapshot.requirements.startDate } });
  expect(() => confirmationGates([...validation({ changes: [{ kind: 'requirements', value: { divers: '0' } }] }), gate()], snapshot, catalog)).toThrow();
});

test.each(['missing', 'foreign', 'failed', 'superseded', 'missing-call', 'duplicate-call', 'user-response', 'partial-response', 'future'])(
  'rejects %s validation without creating a proposal', kind => {
    let prior = validation();
    if (kind === 'missing') prior = [];
    if (kind === 'foreign') prior = validation(undefined, { ...validationResult, validationId: randomUUID() });
    if (kind === 'failed') prior = validation(undefined, { ...validationResult, canApply: false, validationId: null });
    if (kind === 'superseded') prior.push(...validation(undefined, { ...validationResult, validationId: randomUUID() }, 'later'));
    if (kind === 'missing-call') prior.shift();
    if (kind === 'duplicate-call') prior.unshift(prior[0]);
    if (kind === 'user-response') prior[1].author = 'user';
    if (kind === 'partial-response') prior[1].partial = true;
    const events = kind === 'future' ? [gate(), ...prior] : [...prior, gate()];
    expect(() => confirmationGates(events, snapshot, catalog)).toThrow('AGENT_VALIDATION_REFERENCE');
  });

test.each(['duplicate-response', 'response-before-call', 'name-mismatch'])(
  'rejects malformed validation history: %s', kind => {
    const prior = validation();
    if (kind === 'duplicate-response') prior.push(prior[1]);
    if (kind === 'response-before-call') prior.reverse();
    if (kind === 'name-mismatch') prior[0].content!.parts![0].functionCall!.name = 'calculate_budget';
    expect(() => confirmationGates([...prior, gate()], snapshot, catalog)).toThrow('AGENT_VALIDATION_REFERENCE');
  });

test.each(['serial', 'parallel'] as const)('latest unfinished validation supersedes prior success (%s)', order => {
  const prior = validation(), [later] = validation(undefined, validationResult, 'later');
  const history = order === 'serial' ? [...prior, later] : [prior[0], later, prior[1]];
  expect(() => confirmationGates([...history, gate()], snapshot, catalog)).toThrow('AGENT_VALIDATION_REFERENCE');
});

test.each(['error', 'domain-failure'] as const)('latest failed validation supersedes an older parallel response (%s)', kind => {
  const args = { changes: [{ kind: 'requirements', value: { budgetMinor: 1 } }] };
  const failed = buildProposal(snapshot, expandAgentChanges(snapshot, args.changes), catalog, 'agent');
  expect(failed.canApply).toBe(false);
  const response = kind === 'error' ? { error: 'TOOL_OUTPUT_TOO_LARGE' }
    : { canApply: failed.canApply, validationId: null, budget: failed.budget, issues: failed.issues };
  const prior = validation(), later = validation(args, response, 'later');
  expect(() => confirmationGates([prior[0], later[0], later[1], prior[1], gate()], snapshot, catalog))
    .toThrow('AGENT_VALIDATION_REFERENCE');
});

test.each([false, true])('latest successful parallel call wins regardless of response order (%s)', reversed => {
  const args = { changes: [{ kind: 'requirements', value: { people: 1, divers: 0 } }] };
  const latestDraft = buildProposal(snapshot, expandAgentChanges(snapshot, args.changes), catalog, 'agent');
  const latestId = randomUUID();
  const prior = validation(), later = validation(args, { canApply: latestDraft.canApply,
    validationId: latestId, budget: latestDraft.budget, issues: latestDraft.issues }, 'later');
  const history = [prior[0], later[0], ...(reversed ? [later[1], prior[1]] : [prior[1], later[1]])];
  expect(confirmationGates([...history, gate({ validationId: latestId })], snapshot, catalog)[0].changes)
    .toEqual(latestDraft.changes);
  expect(() => confirmationGates([...history, gate()], snapshot, catalog)).toThrow('AGENT_VALIDATION_REFERENCE');
});

test.each([
  { canApply: true, validationId },
  { ...validationResult, budget: { ...draft.budget, knownMinor: draft.budget.knownMinor + 1 } },
  { ...validationResult, budget: { ...draft.budget, withinBudget: null } },
  { ...validationResult, budget: { ...draft.budget, unknownEntryIds: ['stay'] } },
  { ...validationResult, issues: [{ code: 'INVENTED', message: 'not from domain' }] },
])('rejects incomplete or tampered validation result %#', response => {
  expect(() => confirmationGates([...validation(undefined, response), gate()], snapshot, catalog))
    .toThrow('AGENT_VALIDATION_REFERENCE');
});

test('only preceding parts of the confirmation event can supply validation', () => {
  const [call, response] = validation(), confirmation = gate();
  const parts = [call, response, confirmation].flatMap(item => item.content!.parts!);
  expect(confirmationGates([event(parts)], snapshot, catalog)[0].changes).toEqual(draft.changes);
  const futureResponse = [call, confirmation, response].flatMap(item => item.content!.parts!);
  expect(() => confirmationGates([event(futureResponse)], snapshot, catalog)).toThrow('AGENT_VALIDATION_REFERENCE');
});

test('rechecks domain locks/budget against bound base; successful marker alone is insufficient', () => {
  for (const changes of [[{ kind: 'remove', entryId: 'stay' }],
    [{ kind: 'requirements', value: { budgetMinor: 1 } }]]) {
    const locked = structuredClone(snapshot); locked.entries.find(entry => entry.id === 'stay')!.locked = true;
    expect(() => confirmationGates([...validation({ changes }), gate()], locked, catalog)).toThrow('AGENT_VALIDATION_REFERENCE');
  }
});

test('legacy confirmations stay read-only; no executable changes fallback', () => {
  expect(() => confirmationGates([gate({ changes })], snapshot, catalog)).toThrow('AGENT_LEGACY_READ_ONLY');
  for (const args of [{ changes }, { validationId, changes }, { validationId: 'invented' }, {}]) {
    expect(agentToolParameters.propose_changes.safeParse(args).success).toBe(false);
  }
});

class ReferenceScript extends BaseLlm {
  proposalArgs: unknown;
  constructor(readonly resubmitChanges: boolean) { super({ model: 'offline-reference-test' }); }
  async *generateContentAsync(request: LlmRequest): AsyncGenerator<LlmResponse> {
    const result = request.contents.flatMap(content => content.parts ?? [])
      .findLast(part => part.functionResponse?.name === 'validate_changes')?.functionResponse?.response;
    const args = result ? this.resubmitChanges ? { changes } : { validationId: result.validationId } : { changes };
    if (result) this.proposalArgs = args;
    yield { content: { role: 'model', parts: [{ functionCall: { id: randomUUID(),
      name: result ? 'propose_changes' : 'validate_changes', args } }] } };
  }
  async connect(): Promise<BaseLlmConnection> { throw new Error('NO_NETWORK'); }
}

test.each([false, true])('native ADK validation → confirmation, resubmit changes=%s', async resubmit => {
  const sessions = new InMemorySessionService();
  const identity = { appName: 'reference', userId: 'synthetic', sessionId: randomUUID() };
  await sessions.createSession(identity);
  const source = new ReferenceScript(resubmit);
  const proposal = new FunctionTool({ name: 'propose_changes', description: 'Reference only',
    parameters: agentToolParameters.propose_changes, requireConfirmation: true,
    execute: () => { throw new Error('MUST_NOT_EXECUTE_BEFORE_DECISION'); } });
  const runner = new Runner({ app: new App({ name: identity.appName, resumabilityConfig: { isResumable: true },
    rootAgent: new LlmAgent({ name: 'agent', model: new GuardedModel(source),
      tools: [...createReadTools({ snapshot, catalog }), proposal] }) }), sessionService: sessions });
  const events: Event[] = [];
  for await (const next of runner.runAsync({ userId: identity.userId, sessionId: identity.sessionId,
    newMessage: { role: 'user', parts: [{ text: '沒有人潛水，請提供修改卡片。' }] },
    runConfig: { maxLlmCalls: 7, plainTextToolConfirmation: false, allowRemoteToolConfirmation: false },
  })) events.push(next);
  const saved = (await sessions.getSession(identity))!;
  if (resubmit) {
    expect(events.some(item => item.errorMessage?.includes('AGENT_TOOL_ARGUMENTS'))).toBe(true);
    expect(confirmationGates(saved.events, snapshot, catalog)).toEqual([]);
  } else {
    expect(events.filter(item => item.errorCode)).toEqual([]);
    expect(source.proposalArgs).toEqual({ validationId: expect.any(String) });
    expect(confirmationGates(saved.events, snapshot, catalog)).toHaveLength(1);
    expect(confirmationGates(saved.events, snapshot, catalog)[0].changes).toEqual(expandAgentChanges(snapshot, changes));
  }
});
