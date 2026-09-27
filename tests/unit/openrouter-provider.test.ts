import { afterEach, expect, test, vi } from 'vitest';
import { App, FunctionTool, InMemorySessionService, LlmAgent, Runner, type Event, type BaseLlm, type LlmRequest } from '@google/adk';
import { createOpenRouterProvider } from '../../src/agent/openrouter-provider';
import { openRouterRequest, type OpenRouterEvidence } from '../../src/agent/openrouter-wire';
import { agentToolParameters } from '../../src/agent/tool-schemas';
import { GuardedModel } from '../../src/agent/model-guard';
import { answerPlanSchema } from '../../src/domain/answer';

const modelId = 'example/synthetic:free'; // Not a real model selection or endpoint.
const request = (): LlmRequest => ({ contents: [{ role: 'user', parts: [{ text: 'synthetic' }] }], toolsDict: {}, liveConnectConfig: {} });
const raw = () => ({ id: 'gen-offline', model: 'example/synthetic',
  choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'DEMO answer' } }],
  usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, cost: 0,
    completion_tokens_details: { reasoning_tokens: 2 } } });
function setup(reply: () => Promise<Response> = async () => Response.json(raw())) {
  const transport = vi.spyOn(globalThis, 'fetch').mockImplementation(reply);
  const onCallStart = vi.fn<() => Promise<void>>(async () => {});
  const onEvidence = vi.fn<(e: OpenRouterEvidence, id: string) => Promise<void>>(async () => {});
  const options = { apiKey: 'offline-placeholder-not-a-credential', model: modelId, deadlineMs: Date.now() + 5000, onCallStart, onEvidence };
  return { transport, onCallStart, onEvidence, options, model: createOpenRouterProvider(options) };
}
async function collect(model: BaseLlm, input = request(), signal?: AbortSignal) {
  const values = [];
  for await (const value of model.generateContentAsync(input, true, signal)) values.push(value);
  return values;
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

test('fixed free-only endpoint/body; saves evidence before yielding and never forwards config overrides', async () => {
  const s = setup();
  const input = request();
  input.model = 'paid/model';
  input.config = { httpOptions: { baseUrl: 'https://invalid.invalid', retryOptions: { attempts: 5 } }, maxOutputTokens: 99999 };
  const original = structuredClone(input);
  const iterator = s.model.generateContentAsync(input, true);
  expect((await iterator.next()).value).toMatchObject({ content: { parts: [{ text: 'DEMO answer' }] } });
  expect(s.onEvidence).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ provider: 'openrouter', generationId: 'gen-offline',
    requestedModel: modelId, returnedModel: 'example/synthetic', usage: { promptTokens: 10, outputTokens: 4, totalTokens: 14, thoughtTokens: 2, cost: 0 } }), expect.any(String));
  expect(s.onCallStart.mock.invocationCallOrder[0]).toBeLessThan(s.transport.mock.invocationCallOrder[0]!);
  expect(s.transport).toHaveBeenCalledTimes(1);
  const [url, init] = s.transport.mock.calls[0]!;
  expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
  expect(init?.redirect).toBe('error');
  expect(JSON.parse(String(init?.body))).toEqual({ model: modelId, messages: [{ role: 'user', content: 'synthetic' }],
    stream: false, max_tokens: 2048, provider: { allow_fallbacks: false, require_parameters: true, data_collection: 'deny',
      max_price: { prompt: 0, completion: 0, request: 0, image: 0 } } });
  expect(input).toEqual(original);
  await iterator.return();
});

test.each(['openrouter/free', 'example/paid', 'example/model:free:online', 'https://invalid.invalid:free'])('rejects unapproved model syntax %s', model => {
  const s = setup();
  expect(() => createOpenRouterProvider({ ...s.options, model })).toThrow('AGENT_PROVIDER_CONFIG');
  expect(s.transport).not.toHaveBeenCalled();
});

test('native JSON Schema preserves required nullable date, strict keys and paired tool history IDs', async () => {
  const s = setup();
  const tool = new FunctionTool({ name: 'validate_changes', description: 'validate', parameters: agentToolParameters.validate_changes, execute: () => ({}) });
  const input = request(); input.toolsDict = { validate_changes: tool };
  input.config = { systemInstruction: ['instruction', { text: 'second instruction' }] };
  input.contents.push({ role: 'model', parts: [{ functionCall: { id: 'call-1', name: 'validate_changes', args: { changes: [] } } }] },
    { role: 'user', parts: [{ functionResponse: { id: 'call-1', name: 'validate_changes', response: { canApply: false } } }] });
  await collect(s.model, input);
  const body = JSON.parse(String(s.transport.mock.calls[0]![1]?.body));
  // Free endpoints advertise tools/tool_choice but not parallel_tool_calls;
  // the local GuardedModel validates the complete batch before ADK executes it.
  expect(body).not.toHaveProperty('parallel_tool_calls');
  expect(body.provider.require_parameters).toBe(true);
  const requirements = body.tools[0].function.parameters.properties.changes.items.anyOf[0].properties.value;
  expect(requirements.required ?? []).not.toContain('startDate');
  expect(requirements.properties.startDate.anyOf).toContainEqual({ type: 'null' });
  expect(requirements.additionalProperties).toBe(false);
  expect(body.messages[0]).toEqual({ role: 'system', content: 'instruction\nsecond instruction' });
  expect(body.messages.at(-1)).toEqual({ role: 'tool', tool_call_id: 'call-1', content: '{"canApply":false}' });
});

test('converts complete tool calls, does not leak reasoning or provider metadata', async () => {
  const s = setup(async () => Response.json({ ...raw(), secret: 'hidden', choices: [{ finish_reason: 'tool_calls',
    message: { role: 'assistant', content: null, reasoning: 'hidden reasoning', tool_calls: [
      { id: 'call-1', type: 'function', function: { name: 'calculate_budget', arguments: '{}' } },
    ] } }] }));
  expect(await collect(s.model)).toEqual([{ content: { role: 'model', parts: [{ functionCall: { id: 'call-1', name: 'calculate_budget', args: {} } }] } }]);
  expect(JSON.stringify(s.onEvidence.mock.calls)).not.toContain('hidden');
});

test.each([429, 402, 401, 503])('HTTP %s stops without retry, records unknown usage and strips raw diagnostics', async status => {
  const s = setup(async () => new Response('secret provider diagnostic', { status }));
  await expect(collect(s.model)).rejects.toThrow({ 429: 'AGENT_PROVIDER_RATE_LIMIT', 402: 'AGENT_PROVIDER_BILLING',
    401: 'AGENT_PROVIDER_AUTH', 503: 'AGENT_PROVIDER_UNAVAILABLE' }[status]);
  expect(s.transport).toHaveBeenCalledTimes(1);
  expect(s.onEvidence).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ usage: null }), expect.any(String));
});

test.each(['missing', 'inconsistent', 'paid', 'truncated', 'malformed'])('%s response is saved then rejected', async variant => {
  const data: Record<string, unknown> = raw();
  if (variant === 'missing') delete data.usage;
  if (variant === 'inconsistent') data.usage = { ...raw().usage, total_tokens: 3 };
  if (variant === 'paid') data.usage = { ...raw().usage, cost: 0.01 };
  if (variant === 'truncated') data.choices = [{ finish_reason: 'length', message: { role: 'assistant', content: 'partial' } }];
  const s = setup(async () => variant === 'malformed' ? new Response('{broken') : Response.json(data));
  await expect(collect(s.model)).rejects.toThrow('AGENT_PROVIDER_');
  expect(s.onEvidence).toHaveBeenCalledTimes(1);
  expect(s.transport).toHaveBeenCalledTimes(1);
});

test('failed start ACK sends nothing; failed evidence ACK yields nothing and sanitizes callback errors', async () => {
  const s = setup();
  s.onCallStart.mockRejectedValueOnce(new Error('private diagnostic'));
  await expect(collect(s.model)).rejects.toThrow('AGENT_PROVIDER_ERROR');
  expect(s.transport).not.toHaveBeenCalled(); expect(s.onEvidence).not.toHaveBeenCalled();
  s.onEvidence.mockRejectedValueOnce(new Error('private persistence diagnostic'));
  await expect(collect(s.model)).rejects.toThrow('AGENT_PROVIDER_ERROR');
});

test('unexpected returned model is recorded but never accepted as the selected model', async () => {
  const s = setup(async () => Response.json({ ...raw(), model: 'other/model' }));
  await expect(collect(s.model)).rejects.toThrow('AGENT_PROVIDER_INVALID_RESPONSE');
  expect(s.onEvidence).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ returnedModel: 'other/model' }), expect.any(String));
});

test('cancellation during evidence persistence waits for acknowledgement then yields no result', async () => {
  const s = setup();
  const controller = new AbortController();
  s.onEvidence.mockImplementationOnce(async () => { controller.abort(); });
  await expect(collect(s.model, request(), controller.signal)).rejects.toThrow('AGENT_PROVIDER_TIMEOUT');
  expect(s.onEvidence).toHaveBeenCalledTimes(1);
});

test('pre-aborted calls never dispatch; abort after dispatch still saves unknown evidence', async () => {
  const controller = new AbortController(); controller.abort();
  const s = setup();
  await expect(collect(s.model, request(), controller.signal)).rejects.toThrow('AGENT_PROVIDER_TIMEOUT');
  expect(s.transport).not.toHaveBeenCalled();
  const during = new AbortController();
  s.transport.mockImplementationOnce(async () => { during.abort(); return new Promise(() => {}); });
  await expect(collect(s.model, request(), during.signal)).rejects.toThrow('AGENT_PROVIDER_TIMEOUT');
  expect(s.onEvidence).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ usage: null }), expect.any(String));
});

test('bounded response rejects oversized or hanging body without leaking partial output', async () => {
  const s = setup(async () => new Response('x'.repeat(65_537)));
  await expect(collect(s.model)).rejects.toThrow('AGENT_PROVIDER_INVALID_RESPONSE');
  s.transport.mockResolvedValueOnce(new Response(new ReadableStream({ start() {} })));
  const short = createOpenRouterProvider({ ...s.options, deadlineMs: Date.now() + 40 });
  await expect(collect(short)).rejects.toThrow('AGENT_PROVIDER_TIMEOUT');
});

test('rejects unsupported parts and unmatched function response before transport', () => {
  const input = request();
  input.contents = [{ role: 'user', parts: [{ functionResponse: { name: 'calculate_budget', id: 'orphan', response: {} } }] }];
  expect(() => openRouterRequest(input, modelId)).toThrow('AGENT_PROVIDER_INVALID_RESPONSE');
  input.contents = [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: 'AA==' } }] }];
  expect(() => openRouterRequest(input, modelId)).toThrow('AGENT_PROVIDER_INVALID_RESPONSE');
});

test('real ADK runner pauses for human confirmation and resumes tool history through the adapter', async () => {
  const s = setup();
  const validationId = '12345678-1234-4234-8234-123456789abc';
  s.transport.mockResolvedValueOnce(Response.json({ ...raw(), choices: [{ finish_reason: 'tool_calls', message: {
    role: 'assistant', content: null, tool_calls: [{ id: 'proposal-1', type: 'function', function: {
      name: 'propose_changes', arguments: JSON.stringify({ validationId }),
    } }],
  } }] }));
  const plan = { version: '1', answer: { kind: 'receipt', evidenceRef: `ev_${'1'.repeat(64)}` } };
  s.transport.mockResolvedValueOnce(Response.json({ ...raw(), choices: [{ finish_reason: 'tool_calls', message: {
    role: 'assistant', content: null, tool_calls: [{ id: 'final-1', type: 'function', function: {
      name: 'set_model_response', arguments: JSON.stringify(plan),
    } }],
  } }] }));
  const execute = vi.fn(() => ({ status: 'applied', version: 2 }));
  const tool = new FunctionTool({ name: 'propose_changes', description: 'synthetic confirmation',
    parameters: agentToolParameters.propose_changes, requireConfirmation: true, execute });
  const sessions = new InMemorySessionService();
  const identity = { appName: 'openrouter_offline', userId: 'test', sessionId: 'test' };
  await sessions.createSession(identity);
  const runner = new Runner({ app: new App({ name: identity.appName, resumabilityConfig: { isResumable: true },
    rootAgent: new LlmAgent({ name: 'offline_agent', instruction: 'Synthetic data only.', outputSchema: answerPlanSchema,
      model: new GuardedModel(s.model), tools: [tool] }) }), sessionService: sessions });
  const events: Event[] = [];
  for await (const event of runner.runAsync({ userId: 'test', sessionId: 'test', newMessage: { role: 'user', parts: [{ text: 'synthetic change' }] },
    runConfig: { maxLlmCalls: 7, plainTextToolConfirmation: false, allowRemoteToolConfirmation: false } })) events.push(event);
  expect(events.filter(e => e.errorCode)).toEqual([]);
  const interrupt = events.flatMap(e => e.content?.parts ?? []).find(p => p.functionCall?.name === 'adk_request_confirmation')?.functionCall;
  expect(interrupt?.id).toBeTruthy();
  expect(execute).not.toHaveBeenCalled(); expect(s.transport).toHaveBeenCalledTimes(1);
  const resumed: Event[] = [];
  for await (const event of runner.runAsync({ userId: 'test', sessionId: 'test', newMessage: { role: 'user', parts: [{ functionResponse: {
    id: interrupt!.id, name: 'adk_request_confirmation', response: { confirmed: true },
  } }] }, runConfig: { maxLlmCalls: 7, plainTextToolConfirmation: false, allowRemoteToolConfirmation: false } })) resumed.push(event);
  expect(resumed.filter(e => e.errorCode)).toEqual([]);
  expect(execute).toHaveBeenCalledTimes(1); expect(s.transport).toHaveBeenCalledTimes(2);
  expect(resumed.at(-1)?.content?.parts?.[0].text).toBe(JSON.stringify(plan));
  expect(resumed.at(-1)?.actions.skipSummarization).toBe(true);
  expect(s.onEvidence).toHaveBeenCalledTimes(2);
});
