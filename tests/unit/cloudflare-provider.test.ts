import { afterEach, expect, test, vi } from 'vitest';
import { App, FunctionTool, InMemorySessionService, LlmAgent, Runner, type Event, type BaseLlm, type LlmRequest } from '@google/adk';
import { createCloudflareProvider } from '../../src/agent/cloudflare-provider';
import { CLOUDFLARE_MODEL, cloudflareRequest, type CloudflareEvidence } from '../../src/agent/cloudflare-wire';
import { agentToolParameters } from '../../src/agent/tool-schemas';
import { GuardedModel } from '../../src/agent/model-guard';
import { answerPlanSchema } from '../../src/domain/answer';

const modelId = CLOUDFLARE_MODEL; // All fetches stubbed; synthetic account/key only.
const accountId = 'a'.repeat(32);
const reply = (data: unknown) => Response.json({ success: true, result: data });
const request = (): LlmRequest => ({ contents: [{ role: 'user', parts: [{ text: 'synthetic' }] }], toolsDict: {}, liveConnectConfig: {} });
const raw = () => ({ id: 'gen-offline', model: `${modelId}-external`,
  choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'DEMO answer' } }],
  usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14,
    completion_tokens_details: { reasoning_tokens: 2 } } });
function setup(respond: () => Promise<Response> = async () => reply(raw())) {
  const transport = vi.spyOn(globalThis, 'fetch').mockImplementation(respond);
  const onCallStart = vi.fn<() => Promise<void>>(async () => {});
  const onEvidence = vi.fn<(e: CloudflareEvidence, id: string) => Promise<void>>(async () => {});
  const options = { apiKey: 'offline-placeholder-not-a-credential', model: modelId, accountId, deadlineMs: Date.now() + 5000, onCallStart, onEvidence };
  return { transport, onCallStart, onEvidence, options, model: createCloudflareProvider(options) };
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
  input.config = { httpOptions: { baseUrl: 'https://invalid.invalid', retryOptions: { attempts: 5 } }, maxOutputTokens: 99999,
    thinkingConfig: { includeThoughts: true, thinkingBudget: 99999 } };
  const overrides = { chat_template_kwargs: { enable_thinking: true }, max_completion_tokens: 99999, stream: true };
  Object.assign(input, overrides);
  Object.assign(input.config, overrides);
  Object.assign(input.config.httpOptions!, { extraBody: overrides });
  const original = structuredClone(input);
  const iterator = s.model.generateContentAsync(input, true);
  expect((await iterator.next()).value).toMatchObject({ content: { parts: [{ text: 'DEMO answer' }] } });
  expect(s.onEvidence).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ provider: 'cloudflare', generationId: 'gen-offline',
    requestedModel: modelId, returnedModel: `${modelId}-external`, usage: { promptTokens: 10, outputTokens: 4, totalTokens: 14, thoughtTokens: 2 } }), expect.any(String));
  expect(s.onCallStart.mock.invocationCallOrder[0]).toBeLessThan(s.transport.mock.invocationCallOrder[0]!);
  expect(s.transport).toHaveBeenCalledTimes(1);
  const [url, init] = s.transport.mock.calls[0]!;
  expect(url).toBe(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${modelId}`);
  expect(init?.redirect).toBe('error');
  expect(JSON.parse(String(init?.body))).toEqual({ messages: [{ role: 'user', content: 'synthetic' }],
    stream: false, max_completion_tokens: 2048, chat_template_kwargs: { enable_thinking: false } });
  expect(input).toEqual(original);
  await iterator.return();
});

test.each(['cloudflare/free', 'example/paid', 'example/model:free:online', 'https://invalid.invalid:free'])('rejects unapproved model syntax %s', model => {
  const s = setup();
  expect(() => createCloudflareProvider({ ...s.options, model })).toThrow('AGENT_PROVIDER_CONFIG');
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
  // The adapter leaves parallelism at the provider default; the local
  // GuardedModel validates the complete batch before ADK executes it.
  expect(body).not.toHaveProperty('parallel_tool_calls');
  expect(body).not.toHaveProperty('provider');
  expect(body).not.toHaveProperty('model');
  const requirements = body.tools[0].function.parameters.properties.changes.items.anyOf[0].properties.value;
  expect(requirements.required ?? []).not.toContain('startDate');
  expect(requirements.properties.startDate.anyOf).toContainEqual({ type: 'null' });
  expect(requirements.additionalProperties).toBe(false);
  expect(body.messages[0]).toEqual({ role: 'system', content: 'instruction\nsecond instruction' });
  expect(body.messages.at(-1)).toEqual({ role: 'tool', tool_call_id: 'call-1', content: '{"canApply":false}' });
});

test('converts complete tool calls, does not leak reasoning or provider metadata', async () => {
  const s = setup(async () => reply({ ...raw(), secret: 'hidden', choices: [{ finish_reason: 'tool_calls',
    message: { role: 'assistant', content: null, reasoning: 'hidden reasoning', tool_calls: [
      { id: 'call-1', type: 'function', function: { name: 'calculate_budget', arguments: '{}' } },
    ] } }] }));
  expect(await collect(s.model)).toEqual([{ content: { role: 'model', parts: [{ functionCall: { id: 'call-1', name: 'calculate_budget', args: {} } }] } }]);
  expect(JSON.stringify(s.onEvidence.mock.calls)).not.toContain('hidden');
});

test('disabling thinking never invents zero thought usage when the provider omits the count', async () => {
  const s = setup(async () => reply({ ...raw(), usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } }));
  await collect(s.model);
  expect(JSON.parse(String(s.transport.mock.calls[0]![1]?.body)).chat_template_kwargs).toEqual({ enable_thinking: false });
  expect(s.onEvidence).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    usage: { promptTokens: 10, outputTokens: 4, totalTokens: 14 },
  }), expect.any(String));
});

test.each([429, 402, 401, 503])('HTTP %s stops without retry, records unknown usage and strips raw diagnostics', async status => {
  const s = setup(async () => new Response('secret provider diagnostic', { status }));
  await expect(collect(s.model)).rejects.toThrow({ 429: 'AGENT_PROVIDER_RATE_LIMIT', 402: 'AGENT_PROVIDER_BILLING',
    401: 'AGENT_PROVIDER_AUTH', 503: 'AGENT_PROVIDER_UNAVAILABLE' }[status]);
  expect(s.transport).toHaveBeenCalledTimes(1);
  expect(s.onEvidence).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ usage: null }), expect.any(String));
});

test.each(['missing', 'inconsistent', 'reasoning-overrun', 'truncated', 'malformed'])('%s response is saved then rejected', async variant => {
  const data: Record<string, unknown> = raw();
  if (variant === 'missing') delete data.usage;
  if (variant === 'inconsistent') data.usage = { ...raw().usage, total_tokens: 3 };
  if (variant === 'reasoning-overrun') data.usage = { ...raw().usage, completion_tokens_details: { reasoning_tokens: 99 } };
  if (variant === 'truncated') data.choices = [{ finish_reason: 'length', message: { role: 'assistant', content: 'partial' } }];
  const s = setup(async () => variant === 'malformed' ? new Response('{broken') : reply(data));
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
  const s = setup(async () => reply({ ...raw(), model: '@cf/other/model' }));
  await expect(collect(s.model)).rejects.toThrow('AGENT_PROVIDER_INVALID_RESPONSE');
  expect(s.onEvidence).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ returnedModel: '@cf/other/model' }), expect.any(String));
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
  const short = createCloudflareProvider({ ...s.options, deadlineMs: Date.now() + 40 });
  await expect(collect(short)).rejects.toThrow('AGENT_PROVIDER_TIMEOUT');
});

test('rejects unsupported parts and unmatched function response before transport', () => {
  const input = request();
  input.contents = [{ role: 'user', parts: [{ functionResponse: { name: 'calculate_budget', id: 'orphan', response: {} } }] }];
  expect(() => cloudflareRequest(input, modelId)).toThrow('AGENT_PROVIDER_INVALID_RESPONSE');
  input.contents = [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: 'AA==' } }] }];
  expect(() => cloudflareRequest(input, modelId)).toThrow('AGENT_PROVIDER_INVALID_RESPONSE');
});

test('real ADK runner pauses for human confirmation and resumes tool history through the adapter', async () => {
  const s = setup();
  const validationId = '12345678-1234-4234-8234-123456789abc';
  s.transport.mockResolvedValueOnce(reply({ ...raw(), choices: [{ finish_reason: 'tool_calls', message: {
    role: 'assistant', content: null, tool_calls: [{ id: 'proposal-1', type: 'function', function: {
      name: 'propose_changes', arguments: JSON.stringify({ validationId }),
    } }],
  } }] }));
  const plan = { version: '1', answer: { kind: 'receipt', evidenceRef: `ev_${'1'.repeat(64)}` } };
  s.transport.mockResolvedValueOnce(reply({ ...raw(), choices: [{ finish_reason: 'tool_calls', message: {
    role: 'assistant', content: null, tool_calls: [{ id: 'final-1', type: 'function', function: {
      name: 'set_model_response', arguments: JSON.stringify(plan),
    } }],
  } }] }));
  const execute = vi.fn(() => ({ status: 'applied', version: 2 }));
  const tool = new FunctionTool({ name: 'propose_changes', description: 'synthetic confirmation',
    parameters: agentToolParameters.propose_changes, requireConfirmation: true, execute });
  const sessions = new InMemorySessionService();
  const identity = { appName: 'cloudflare_offline', userId: 'test', sessionId: 'test' };
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
  for (const [, init] of s.transport.mock.calls) {
    expect(JSON.parse(String(init?.body))).toMatchObject({ stream: false, max_completion_tokens: 2048,
      chat_template_kwargs: { enable_thinking: false } });
  }
});

test.each(['../account', 'A'.repeat(32), 'a'.repeat(31), 'a'.repeat(32) + '/ai', 'a'.repeat(32) + '\n'])('rejects account URL injection %s', accountId => {
  const s = setup();
  expect(() => createCloudflareProvider({ ...s.options, accountId })).toThrow('AGENT_PROVIDER_CONFIG');
  expect(s.transport).not.toHaveBeenCalled();
});
test('HTTP 200 failed envelope is not a successful model response', async () => {
  const s = setup(async () => Response.json({ success: false, result: raw(), errors: [{ code: 1, message: 'private' }] }));
  await expect(collect(s.model)).rejects.toThrow('AGENT_PROVIDER_INVALID_RESPONSE');
  expect(s.onEvidence).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ usage: null }), expect.any(String));
});
test('oversized request stops before admission or network', async () => {
  const s = setup(); const input = request();
  input.contents = [{ role: 'user', parts: [{ text: 'x'.repeat(96_001) }] }];
  await expect(collect(s.model, input)).rejects.toThrow('AGENT_PROVIDER_BAD_REQUEST');
  expect(s.onCallStart).not.toHaveBeenCalled(); expect(s.transport).not.toHaveBeenCalled();
});
