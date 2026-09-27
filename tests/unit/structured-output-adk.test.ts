import { App, BaseLlm, FunctionTool, InMemorySessionService, LlmAgent, Runner,
  type BaseLlmConnection, type Event, type LlmRequest, type LlmResponse } from '@google/adk';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { GuardedModel } from '../../src/agent/model-guard';
import { confirmationGates } from '../../src/agent/confirmation';
import { createReadTools } from '../../src/agent/tools';
import { validatedProposalParametersSchema } from '../../src/agent/tool-schemas';
import { makeSnapshot } from '../support/domain-fixtures';
import { answerPlanSchema } from '../../src/domain/answer';

// P0 protocol probe, not the product AnswerPlan contract or a live model eval.
const outputSchema = z.strictObject({ intent: z.enum(['clarify', 'budget', 'receipt']),
  references: z.array(z.string().min(1)).max(4) });
const clarification = { intent: 'clarify', references: [] };
const response = (name: string, args: Record<string, unknown>, id = name): LlmResponse => ({
  content: { role: 'model', parts: [{ functionCall: { name, args, id } }] },
});
class Script extends BaseLlm {
  requests: LlmRequest[] = [];
  constructor(readonly steps: ((request: LlmRequest) => LlmResponse)[]) { super({ model: 'offline-structured-probe' }); }
  async *generateContentAsync(request: LlmRequest): AsyncGenerator<LlmResponse> {
    this.requests.push(request);
    const step = this.steps[this.requests.length - 1];
    if (!step) throw new Error('UNEXPECTED_MODEL_CALL');
    yield step(request);
  }
  async connect(): Promise<BaseLlmConnection> { throw new Error('NO_NETWORK'); }
}
const identity = { appName: 'structured_probe', userId: 'synthetic', sessionId: 'synthetic' };
async function setup(steps: Script['steps'], previous = { modelCalls: 0, toolCalls: 0 }, guarded = true,
  contract: typeof outputSchema | typeof answerPlanSchema = outputSchema) {
  const snapshot = makeSnapshot();
  const catalog = snapshot.entries.map(entry => entry.item);
  const sessions = new InMemorySessionService();
  await sessions.createSession(identity);
  const source = new Script(steps);
  const model = guarded ? new GuardedModel(source, previous, contract) : source;
  const tools = createReadTools({ snapshot, catalog });
  const executed = vi.fn(() => ({ status: 'applied', version: 2 }));
  const proposal = new FunctionTool({ name: 'propose_changes', description: 'native confirmation probe',
    parameters: validatedProposalParametersSchema, requireConfirmation: true, execute: executed });
  const agent = new LlmAgent({ name: identity.appName, model, tools: [...tools, proposal],
    outputSchema: contract, outputKey: 'probe_answer' });
  const runner = () => new Runner({ app: new App({ name: identity.appName,
    rootAgent: agent, resumabilityConfig: { isResumable: true } }), sessionService: sessions });
  return { runner, sessions, source, tools, executed, snapshot, catalog };
}
async function run(runner: Runner, interruptId?: string, confirmed = true) {
  const events: Event[] = [];
  for await (const event of runner.runAsync({ userId: identity.userId, sessionId: identity.sessionId,
    newMessage: { role: 'user', parts: interruptId ? [{ functionResponse: {
      name: 'adk_request_confirmation', id: interruptId, response: { confirmed },
    } }] : [{ text: '合成離線測試' }] }, abortSignal: AbortSignal.timeout(3000),
    runConfig: { maxLlmCalls: 7, plainTextToolConfirmation: false, allowRemoteToolConfirmation: false },
  })) events.push(event);
  return events;
}
function answer(events: Event[]) {
  const last = events.at(-1);
  expect(events.some(event => event.errorCode)).toBe(false);
  expect(last?.actions.skipSummarization).toBe(true);
  return JSON.parse(last!.content!.parts![0].text!);
}
beforeEach(() => { vi.stubGlobal('fetch', vi.fn(() => { throw new Error('NETWORK_FORBIDDEN'); })); });
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });

test('native outputSchema final tool yields a persisted JSON answer without a formatting model call', async () => {
  const fixture = await setup([() => response('set_model_response', clarification)]);
  expect(answer(await run(fixture.runner()))).toEqual(clarification);
  expect(fixture.source.requests).toHaveLength(1);
  expect(fixture.source.requests[0].toolsDict.set_model_response).toBeDefined();
  // ADK rewrites the final function call to text before executing FunctionTool.
  const saved = await fixture.sessions.getSession(identity);
  expect(saved?.state.probe_answer).toEqual(clarification);
  expect(saved?.events.at(-1)?.content?.parts?.[0].functionCall).toBeUndefined();
  expect(answer(saved!.events)).toEqual(clarification);
  expect(fixture.source.requests).toHaveLength(1); // reading saved state is zero-call replay
});

test('the product AnswerPlan union runs through native ADK, not just a simplified probe schema', async () => {
  const plan = { version: '1', answer: { kind: 'clarify', fields: ['dates'] } };
  const fixture = await setup([() => response('set_model_response', plan)], undefined, true, answerPlanSchema);
  expect(answer(await run(fixture.runner()))).toEqual(plan);
  expect((await fixture.sessions.getSession(identity))?.state.probe_answer).toEqual(plan);
  expect(fixture.source.requests).toHaveLength(1);
});

test('read then native structured answer shares the original bounded ADK loop', async () => {
  const fixture = await setup([
    () => response('calculate_budget', {}),
    request => {
      const result = request.contents.flatMap(content => content.parts ?? [])
        .find(part => part.functionResponse?.name === 'calculate_budget')?.functionResponse;
      expect(result?.response?.knownMinor).toBe(430000);
      return response('set_model_response', { intent: 'budget', references: [result!.id!] });
    },
  ]);
  expect(answer(await run(fixture.runner()))).toEqual({ intent: 'budget', references: ['calculate_budget'] });
  expect(fixture.source.requests).toHaveLength(2);
});

// Framework-only probe: this fixture intentionally omits the product receipt
// callbacks, so its scripted post-confirmation model turn is not a runtime contract.
test.each([true, false])('framework probe: validation → native confirmation → new Runner → structured result (%s)', async confirmed => {
  const fixture = await setup([
    () => response('validate_changes', { changes: [{ kind: 'remove', entryId: 'transfer' }] }),
    request => {
      const result = request.contents.flatMap(content => content.parts ?? [])
        .find(part => part.functionResponse?.name === 'validate_changes')?.functionResponse?.response;
      expect(result?.canApply).toBe(true);
      return response('propose_changes', { validationId: result!.validationId });
    },
    () => response('set_model_response', { intent: 'receipt', references: ['propose_changes'] }),
  ]);
  const first = await run(fixture.runner());
  const gate = confirmationGates(first, fixture.snapshot, fixture.catalog).at(-1)!;
  expect(gate).toMatchObject({ changes: [{ kind: 'remove', entryId: 'transfer' }] });
  expect(fixture.executed).not.toHaveBeenCalled();
  expect(fixture.source.requests).toHaveLength(2);
  expect(answer(await run(fixture.runner(), gate.interruptId, confirmed)))
    .toEqual({ intent: 'receipt', references: ['propose_changes'] });
  expect(fixture.executed).toHaveBeenCalledTimes(confirmed ? 1 : 0);
  expect(fixture.source.requests).toHaveLength(3);
  const persisted = await fixture.sessions.getSession(identity);
  expect(answer(persisted!.events)).toEqual({ intent: 'receipt', references: ['propose_changes'] });
});

test('SDK outputSchema alone accepts extra args: application validation is required', async () => {
  const invalid = { ...clarification, amount: 330 };
  const fixture = await setup([() => response('set_model_response', invalid)], undefined, false);
  expect(answer(await run(fixture.runner()))).toEqual(invalid);
  expect(outputSchema.safeParse(invalid).success).toBe(false);
});

test.each([
  { ...clarification, amount: 330 }, { intent: 'invented', references: [] },
  { intent: 'budget', references: 'fake' },
])('guard rejects invalid final-tool arguments before ADK converts them (%j)', async invalid => {
  const fixture = await setup([() => response('set_model_response', invalid)]);
  const events = await run(fixture.runner());
  expect(events.some(event => event.errorMessage === 'AGENT_ANSWER_SCHEMA')).toBe(true);
  expect((await fixture.sessions.getSession(identity))?.state.probe_answer).toBeUndefined();
});

test('a final response mixed with another tool is rejected atomically, not silently dropped by ADK', async () => {
  const fixture = await setup([() => ({ content: { role: 'model', parts: [
    ...response('set_model_response', clarification).content!.parts!,
    ...response('calculate_budget', {}).content!.parts!,
  ] } })]);
  const read = vi.spyOn(fixture.tools[2], 'runAsync');
  const events = await run(fixture.runner());
  expect(events.some(event => event.errorMessage === 'AGENT_ANSWER_SCHEMA')).toBe(true);
  expect(read).not.toHaveBeenCalled();
});

test('final tool consumes the sixth tool slot; it is not an uncounted seventh tool', async () => {
  const ok = await setup([() => response('set_model_response', clarification)], { modelCalls: 6, toolCalls: 5 });
  expect(answer(await run(ok.runner()))).toEqual(clarification);
  const full = await setup([() => response('set_model_response', clarification)], { modelCalls: 6, toolCalls: 6 });
  expect((await run(full.runner())).some(event => event.errorMessage === 'AGENT_TOOL_LIMIT')).toBe(true);
  const callsFull = await setup([() => response('set_model_response', clarification)], { modelCalls: 7, toolCalls: 5 });
  expect((await run(callsFull.runner())).some(event => event.errorMessage === 'AGENT_MODEL_LIMIT')).toBe(true);
  expect(callsFull.source.requests).toHaveLength(0);
});

test('proposal may use the sixth tool slot on the seventh model call and pause for confirmation', async () => {
  const fixture = await setup([() => response('propose_changes', { validationId: '00000000-0000-4000-8000-000000000001' })],
    { modelCalls: 6, toolCalls: 5 });
  const events = await run(fixture.runner());
  expect(events.some(event => event.errorCode)).toBe(false);
  expect(events.some(event => event.content?.parts?.some(part => part.functionCall?.name === 'adk_request_confirmation'))).toBe(true);
  expect(fixture.source.requests).toHaveLength(1);
  expect(fixture.executed).not.toHaveBeenCalled();
});

test.each(['價格是330', '{bad json}', JSON.stringify({ ...clarification, text: 'free prose' })])(
  'unstructured text cannot bypass the final-answer schema (%s)', async text => {
    const fixture = await setup([() => ({ content: { role: 'model', parts: [{ text }] } })]);
    expect((await run(fixture.runner())).some(event => event.errorMessage === 'AGENT_ANSWER_SCHEMA')).toBe(true);
  });

test('direct structured JSON final uses the same validation, without requiring fallback tool support', async () => {
  const fixture = await setup([() => ({ content: { role: 'model', parts: [{ text: JSON.stringify(clarification) }] } })]);
  const events = await run(fixture.runner());
  expect(events.some(event => event.errorCode)).toBe(false);
  expect((await fixture.sessions.getSession(identity))?.state.probe_answer).toEqual(clarification);
  expect(fixture.source.requests).toHaveLength(1);
});

test.each([
  [{ text: 'private thinking', thought: true }, { text: JSON.stringify(clarification) }],
  [{ text: '{"nested":', thought: true }, { text: JSON.stringify(clarification) }, { text: ',"amount":330}', thought: true }],
].map(parts => ({ parts })))('thought text cannot alter the structured value ADK persists (%j)', async ({ parts }) => {
  const fixture = await setup([() => ({ content: { role: 'model', parts } })]);
  expect((await run(fixture.runner())).some(event => event.errorMessage === 'AGENT_ANSWER_SCHEMA')).toBe(true);
  expect((await fixture.sessions.getSession(identity))?.state.probe_answer).toBeUndefined();
});
