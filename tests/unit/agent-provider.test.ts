import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Gemini, type LlmRequest } from '@google/adk';
import { AgentProviderError, createGeminiProvider, GEMINI_MODEL, type ProviderUsage } from '../../src/agent/provider';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

type Generate = Gemini['apiClient']['models']['generateContent'];
type RawResponse = Awaited<ReturnType<Generate>>;
const request = (): LlmRequest => ({ contents: [{ role: 'user', parts: [{ text: 'offline test' }] }], liveConnectConfig: {}, toolsDict: {} });
const raw = (extra: Record<string, unknown> = {}): RawResponse => ({
  candidates: [{ content: { role: 'model', parts: [{ text: 'DEMO answer' }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4, totalTokenCount: 16, thoughtsTokenCount: 2 }, ...extra,
}) as RawResponse;
function setup(implementation: Generate = async () => raw()) {
  const generate = vi.fn<Generate>(implementation);
  const stream = vi.fn();
  const client = { vertexai: false, models: { generateContent: generate, generateContentStream: stream } };
  vi.spyOn(Gemini.prototype, 'apiClient', 'get').mockReturnValue(client as unknown as Gemini['apiClient']);
  const onUsage = vi.fn<(usage: ProviderUsage | null, callId: string) => void | Promise<void>>();
  const deadlineMs = Date.now() + 5000;
  const model = createGeminiProvider({ apiKey: 'offline-placeholder-not-a-credential', deadlineMs, onUsage });
  return { generate, stream, client, model, onUsage, deadlineMs };
}
async function collect(model: Gemini, input = request(), stream = false, signal?: AbortSignal) {
  const values = [];
  for await (const value of model.generateContentAsync(input, stream, signal)) values.push(value);
  return values;
}
beforeEach(() => { vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('OFFLINE_NETWORK_FORBIDDEN')); });
afterEach(() => {
  try { expect(globalThis.fetch).not.toHaveBeenCalled(); }
  finally { vi.restoreAllMocks(); vi.useRealTimers(); }
});

test('ADK tool schemas survive real SDK serialization using Gemini parameters fields only', async () => {
  const script = String.raw`
    import assert from 'node:assert/strict';
    import { FunctionTool } from '@google/adk';
    import { proposalParametersSchema } from './src/agent/tool-schemas.ts';
    import { createGeminiProvider } from './src/agent/provider.ts';
    const tool = new FunctionTool({ name: 'validate_changes', description: 'synthetic',
      parameters: proposalParametersSchema, execute: () => ({}) });
    let wire;
    globalThis.fetch = async (_url, init) => {
      wire = JSON.parse(init.body).tools[0].functionDeclarations[0].parameters;
      return Response.json({ candidates: [{ content: { role: 'model', parts: [{ text: 'offline' }] }, finishReason: 'STOP' }] });
    };
    const model = createGeminiProvider({ apiKey: 'offline-placeholder-not-a-credential',
      deadlineMs: Date.now() + 5000, onUsage: () => {} });
    for await (const output of model.generateContentAsync({ contents: [{ role: 'user', parts: [{ text: 'synthetic' }] }],
      config: { tools: [{ functionDeclarations: [tool._getDeclaration()] }] }, liveConnectConfig: {}, toolsDict: {} })) void output;
    const allowed = new Set(['type','format','title','description','nullable','enum','maxItems','minItems','properties',
      'required','minProperties','maxProperties','minLength','maxLength','pattern','example','anyOf','propertyOrdering','default','items','minimum','maximum']);
    function check(schema) {
      for (const key of Object.keys(schema)) assert.ok(allowed.has(key), 'unsupported Schema field: ' + key);
      for (const child of Object.values(schema.properties ?? {})) check(child);
      for (const child of schema.anyOf ?? []) check(child);
      if (schema.items) check(schema.items);
    }
    check(wire);
    const branches = wire.properties.changes.items.anyOf;
    assert.equal(branches.length, 6);
    assert.equal(new Set(branches.map(b => b.properties.kind.enum[0])).size, 6);
    const requirements = branches.find(b => b.properties.kind.enum[0] === 'requirements').properties.value;
    assert.equal(requirements.properties.startDate.nullable, true);
    assert.equal(requirements.properties.startDate.type, 'STRING');
    assert.ok(!(requirements.required ?? []).includes('startDate')); // Omission preserves the server value.
    for (const kind of ['add','move','rooms']) {
      const branch = branches.find(b => b.properties.kind.enum[0] === kind);
      const number = kind === 'add' ? branch.properties.entry.properties.day : branch.properties[kind === 'move' ? 'day' : 'rooms'];
      assert.equal(number.minimum, 1);
    }
    console.log('SCHEMA_WIRE_PASS');
  `;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)), timeout: 10_000,
    env: { NODE_ENV: 'test', OTEL_SDK_DISABLED: 'true' },
  });
  expect(stdout).toContain('SCHEMA_WIRE_PASS');
}, 15_000);

test('actual Gemini SDK converts response; fixed model, bounded HTTP and one attempt reach transport', async () => {
  const { model, generate, stream, onUsage, deadlineMs } = setup();
  const controller = new AbortController();
  const input = request();
  input.model = 'unapproved-model';
  input.config = { temperature: 0.2, httpOptions: { timeout: 999999, retryOptions: { attempts: 5 }, baseUrl: 'https://invalid.invalid' } };
  const original = structuredClone(input);
  const response = await collect(model, input, true, controller.signal);
  expect(model).toBeInstanceOf(Gemini);
  expect(model.model).toBe(GEMINI_MODEL);
  expect(model.useInteractionsApi).toBe(false);
  expect(generate).toHaveBeenCalledTimes(1); expect(stream).not.toHaveBeenCalled();
  const call = generate.mock.calls[0][0];
  expect(call.model).toBe(GEMINI_MODEL);
  expect(call.config).toMatchObject({ temperature: 0.2, httpOptions: { retryOptions: { attempts: 1 } } });
  expect(call.config?.httpOptions?.timeout).toBeGreaterThan(0);
  expect(call.config?.httpOptions?.timeout).toBeLessThanOrEqual(5000);
  expect(deadlineMs).toBeGreaterThanOrEqual(Date.now());
  expect(call.config?.httpOptions?.baseUrl).toBeUndefined();
  expect(call.config?.abortSignal).toBeInstanceOf(AbortSignal);
  expect(input).toEqual(original);
  expect(response[0].content?.parts?.[0].text).toBe('DEMO answer');
  expect(onUsage).toHaveBeenCalledExactlyOnceWith({ promptTokens: 10, outputTokens: 4, totalTokens: 16, thoughtTokens: 2 }, expect.any(String));
});

test('usage is recorded before first yield even when caller guard stops consuming', async () => {
  const { model, onUsage } = setup();
  const iterator = model.generateContentAsync(request());
  await iterator.next();
  expect(onUsage).toHaveBeenCalledTimes(1);
  await iterator.return();
  expect(onUsage).toHaveBeenCalledTimes(1);
});

test.each([undefined, {}, { promptTokenCount: 1, candidatesTokenCount: NaN, totalTokenCount: 1 },
  { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: -1 },
  { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: Number.MAX_SAFE_INTEGER },
  { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 3 },
  { promptTokenCount: 10, candidatesTokenCount: 10, totalTokenCount: 10 },
  { promptTokenCount: 10, candidatesTokenCount: 4, thoughtsTokenCount: 2, totalTokenCount: 15 },
  { promptTokenCount: 10, candidatesTokenCount: 4, thoughtsTokenCount: 2, toolUsePromptTokenCount: 3, totalTokenCount: 18 },
  { promptTokenCount: 10, candidatesTokenCount: 4, toolUsePromptTokenCount: -1, totalTokenCount: 16 },
  { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3, thoughtsTokenCount: Infinity },
])('missing/malformed metadata is unknown, not zero: %j', async metadata => {
  const { model, onUsage } = setup(async () => raw({ usageMetadata: metadata }));
  const response = await collect(model);
  expect(onUsage).toHaveBeenCalledExactlyOnceWith(null, expect.any(String));
  expect(response[0].usageMetadata).toBeUndefined();
});

test('only bounded numeric allowlist leaves SDK metadata', async () => {
  const { model, onUsage } = setup(async () => raw({ usageMetadata: {
    promptTokenCount: 10, candidatesTokenCount: 4, totalTokenCount: 14, cachedContentTokenCount: 3,
    promptTokensDetails: [{ modality: 'TEXT', tokenCount: 10 }], privateNote: 'must not leak',
  } }));
  const response = await collect(model);
  expect(onUsage).toHaveBeenCalledExactlyOnceWith({ promptTokens: 10, outputTokens: 4, totalTokens: 14, cachedTokens: 3 }, expect.any(String));
  expect(JSON.stringify(response)).not.toContain('must not leak');
  expect(JSON.stringify(response)).not.toContain('promptTokensDetails');
});

test.each([
  [{ status: 400, message: 'private upstream payload' }, 'AGENT_PROVIDER_BAD_REQUEST'],
  [{ status: 401, message: 'private upstream payload' }, 'AGENT_PROVIDER_AUTH'],
  [{ status: 402, message: 'private upstream payload' }, 'AGENT_PROVIDER_BILLING'],
  [{ status: 403, message: 'private upstream payload' }, 'AGENT_PROVIDER_PERMISSION'],
  [{ status: 404, message: 'private upstream payload' }, 'AGENT_PROVIDER_NOT_FOUND'],
  [{ status: 503, message: 'private upstream payload' }, 'AGENT_PROVIDER_UNAVAILABLE'],
  [{ cause: { code: 'ECONNRESET', message: 'private upstream payload' } }, 'AGENT_PROVIDER_NETWORK'],
  [{ cause: { code: 'CERT_HAS_EXPIRED', message: 'private upstream payload' } }, 'AGENT_PROVIDER_TLS'],
  [{ cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } }, 'AGENT_PROVIDER_TIMEOUT'],
  [{ cause: { code: 'unknown-private-code' }, message: 'private upstream payload' }, 'AGENT_PROVIDER_ERROR'],
  [{ name: 'ApiError', status: 400, message: JSON.stringify({ error: { message: 'private upstream payload', details: [
    { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID', metadata: { key: 'private upstream payload' } },
  ] } }) }, 'AGENT_PROVIDER_AUTH'],
  [{ name: 'ApiError', status: 400, message: '{invalid JSON private upstream payload' }, 'AGENT_PROVIDER_BAD_REQUEST'],
  [{ name: 'ApiError', status: 400, message: JSON.stringify({ error: { details: [
    { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'UNKNOWN_PRIVATE_REASON' },
  ] } }) }, 'AGENT_PROVIDER_BAD_REQUEST'],
  [{ status: 429, message: 'private upstream payload' }, 'AGENT_PROVIDER_RATE_LIMIT'],
  [{ status: 504, message: 'private upstream payload' }, 'AGENT_PROVIDER_TIMEOUT'],
  [new DOMException('private upstream payload', 'TimeoutError'), 'AGENT_PROVIDER_TIMEOUT'],
  [new Error('private upstream payload'), 'AGENT_PROVIDER_ERROR'],
])('transport failure is sanitized with unknown usage and no retry', async (failure, code) => {
  const { model, generate, onUsage } = setup(async () => { throw failure; });
  const error = await collect(model).catch(error => error as Error);
  expect(error).toMatchObject({ code, message: code });
  expect(error).not.toHaveProperty('cause');
  expect(String(error)).not.toContain('private upstream payload');
  expect(generate).toHaveBeenCalledTimes(1); expect(onUsage).toHaveBeenCalledExactlyOnceWith(null, expect.any(String));
});

test.each([
  [{ candidates: [], promptFeedback: { blockReason: 'SAFETY', blockReasonMessage: 'private diagnostic' } }, 'AGENT_PROVIDER_REFUSAL'],
  [{ candidates: [{ finishReason: 'PROHIBITED_CONTENT', finishMessage: 'private diagnostic' }] }, 'AGENT_PROVIDER_REFUSAL'],
  [{ candidates: [{ content: { parts: [{ text: 'partial' }] }, finishReason: 'MAX_TOKENS' }] }, 'AGENT_PROVIDER_INVALID_RESPONSE'],
  [{ candidates: [] }, 'AGENT_PROVIDER_INVALID_RESPONSE'],
])('SDK response errors are classified after collecting usage', async (override, code) => {
  const { model, onUsage } = setup(async () => raw(override));
  await expect(collect(model)).rejects.toMatchObject({ code, message: code });
  expect(onUsage).toHaveBeenCalledExactlyOnceWith({ promptTokens: 10, outputTokens: 4, totalTokens: 16, thoughtTokens: 2 }, expect.any(String));
});

test('caller cancellation reaches actual SDK transport; ignored abort still bounds adapter', async () => {
  const { model, generate, onUsage } = setup(() => new Promise(() => {}));
  const controller = new AbortController();
  const result = collect(model, request(), false, controller.signal);
  const rejection = expect(result).rejects.toMatchObject({ code: 'AGENT_PROVIDER_TIMEOUT' });
  controller.abort(new Error('private cancellation reason'));
  await rejection;
  expect(generate.mock.calls[0][0].config?.abortSignal?.aborted).toBe(true);
  expect(onUsage).toHaveBeenCalledExactlyOnceWith(null, expect.any(String));
});

test('deadline expires without response; HTTP timeout respects remaining budget', async () => {
  vi.useFakeTimers();
  const { model, generate, onUsage } = setup(() => new Promise(() => {}));
  const result = collect(model);
  const rejection = expect(result).rejects.toMatchObject({ code: 'AGENT_PROVIDER_TIMEOUT' });
  await vi.advanceTimersByTimeAsync(5000); await rejection;
  expect(generate.mock.calls[0][0].config?.httpOptions?.timeout).toBe(5000);
  expect(generate.mock.calls[0][0].config?.abortSignal?.aborted).toBe(true);
  expect(onUsage).not.toHaveBeenCalled(); // Shared deadline exhausted: start remains outstanding.
});

test('expired deadline / pre-aborted caller never starts transport', async () => {
  vi.useFakeTimers();
  const { model, generate, onUsage } = setup();
  await expect(collect(model, request(), false, AbortSignal.abort())).rejects.toMatchObject({ code: 'AGENT_PROVIDER_TIMEOUT' });
  await vi.advanceTimersByTimeAsync(5001);
  await expect(collect(model)).rejects.toMatchObject({ code: 'AGENT_PROVIDER_TIMEOUT' });
  expect(generate).not.toHaveBeenCalled(); expect(onUsage).not.toHaveBeenCalled();
});

test('request-level cancellation is preserved and HTTP duration is capped at 30 seconds', async () => {
  const { generate, onUsage } = setup(() => new Promise(() => {}));
  const model = createGeminiProvider({ apiKey: 'offline-placeholder', deadlineMs: Date.now() + 120_000, onUsage });
  const controller = new AbortController();
  const input = request(); input.config = { abortSignal: controller.signal };
  const result = collect(model, input);
  const rejection = expect(result).rejects.toMatchObject({ code: 'AGENT_PROVIDER_TIMEOUT' });
  expect(generate.mock.calls[0][0].config?.httpOptions?.timeout).toBe(30_000);
  controller.abort(); await rejection;
  expect(onUsage).toHaveBeenCalledExactlyOnceWith(null, expect.any(String));
});

test('backend switching and live connections fail closed', async () => {
  const { model, client, generate } = setup();
  client.vertexai = true;
  await expect(collect(model)).rejects.toMatchObject({ code: 'AGENT_PROVIDER_CONFIG' });
  await expect(model.connect(request())).rejects.toMatchObject({ code: 'AGENT_PROVIDER_CONFIG' });
  expect(generate).not.toHaveBeenCalled();
});

test('empty key is rejected before constructing SDK and callback exceptions do not leak', async () => {
  expect(() => createGeminiProvider({ apiKey: '', deadlineMs: Date.now() + 1000, onUsage: () => {} })).toThrow(AgentProviderError);
  const { onUsage } = setup();
  onUsage.mockImplementation(() => { throw new Error('private accounting details'); });
  const model = createGeminiProvider({ apiKey: 'offline-placeholder', deadlineMs: Date.now() + 1000, onUsage });
  await expect(collect(model)).rejects.toMatchObject({ message: 'AGENT_PROVIDER_ERROR' });
});

test('durable start ACK precedes transport; usage ACK precedes yield with the same unique callId', async () => {
  const { generate } = setup();
  let startAck!: () => void;
  let usageAck!: () => void;
  const onCallStart = vi.fn<(callId: string) => Promise<void>>(() => new Promise(resolve => { startAck = resolve; }));
  const onUsage = vi.fn<(usage: ProviderUsage | null, callId: string) => Promise<void>>(() => new Promise(resolve => { usageAck = resolve; }));
  const model = createGeminiProvider({ apiKey: 'offline-placeholder', deadlineMs: Date.now() + 5000, onCallStart, onUsage });
  let yielded = false;
  const pending = collect(model).then(value => { yielded = true; return value; });
  expect(onCallStart).toHaveBeenCalledTimes(1);
  expect(generate).not.toHaveBeenCalled();
  startAck();
  await vi.waitFor(() => expect(onUsage).toHaveBeenCalledTimes(1));
  expect(generate).toHaveBeenCalledTimes(1); expect(yielded).toBe(false);
  const callId = onCallStart.mock.calls[0][0];
  expect(callId).toMatch(/^[0-9a-f-]{36}$/);
  expect(onUsage.mock.calls[0][1]).toBe(callId);
  usageAck(); await pending;
  onCallStart.mockResolvedValue(); onUsage.mockResolvedValue();
  await collect(model);
  expect(onCallStart.mock.calls[1][0]).not.toBe(callId);
  expect(onUsage.mock.calls[1][1]).toBe(onCallStart.mock.calls[1][0]);
});

test('failed start ACK makes zero transport calls and no usage settlement', async () => {
  const { generate, onUsage } = setup();
  const model = createGeminiProvider({ apiKey: 'offline-placeholder', deadlineMs: Date.now() + 5000,
    onCallStart: async () => { throw new Error('private callback details'); }, onUsage });
  await expect(collect(model)).rejects.toMatchObject({ code: 'AGENT_PROVIDER_ERROR', message: 'AGENT_PROVIDER_ERROR' });
  expect(generate).not.toHaveBeenCalled(); expect(onUsage).not.toHaveBeenCalled();
});

test.each(['start', 'usage'])('hung %s callback is bounded by the shared deadline', async stage => {
  vi.useFakeTimers();
  const { generate } = setup();
  const onCallStart = vi.fn(() => stage === 'start' ? new Promise<void>(() => {}) : Promise.resolve());
  const onUsage = vi.fn(() => new Promise<void>(() => {}));
  const model = createGeminiProvider({ apiKey: 'offline-placeholder', deadlineMs: Date.now() + 5000, onCallStart, onUsage });
  const rejection = expect(collect(model)).rejects.toMatchObject({ code: 'AGENT_PROVIDER_TIMEOUT' });
  await vi.advanceTimersByTimeAsync(5000); await rejection;
  expect(generate).toHaveBeenCalledTimes(stage === 'start' ? 0 : 1);
  expect(onUsage).toHaveBeenCalledTimes(stage === 'start' ? 0 : 1);
});

test('slow start ACK consumes shared deadline before SDK HTTP timeout is computed', async () => {
  vi.useFakeTimers();
  const { generate, onUsage } = setup();
  const model = createGeminiProvider({ apiKey: 'offline-placeholder', deadlineMs: Date.now() + 5000,
    onCallStart: () => new Promise(resolve => setTimeout(resolve, 2000)), onUsage });
  const pending = collect(model);
  await vi.advanceTimersByTimeAsync(2000); await pending;
  expect(generate.mock.calls[0][0].config?.httpOptions?.timeout).toBe(3000);
  expect(onUsage).toHaveBeenCalledTimes(1);
});

test('failed async usage ACK never yields and never exposes callback diagnostics', async () => {
  const { generate, onUsage } = setup();
  onUsage.mockRejectedValue(new Error('private accounting details'));
  const model = createGeminiProvider({ apiKey: 'offline-placeholder', deadlineMs: Date.now() + 5000, onUsage });
  const iterator = model.generateContentAsync(request());
  await expect(iterator.next()).rejects.toMatchObject({ message: 'AGENT_PROVIDER_ERROR' });
  expect(generate).toHaveBeenCalledTimes(1);
});

test('transport timeout still awaits unknown usage when shared deadline has time left', async () => {
  vi.useFakeTimers();
  const { onUsage } = setup(() => new Promise(() => {}));
  const onCallStart = vi.fn();
  const model = createGeminiProvider({ apiKey: 'offline-placeholder', deadlineMs: Date.now() + 55_000, onCallStart, onUsage });
  const rejection = expect(collect(model)).rejects.toMatchObject({ code: 'AGENT_PROVIDER_TIMEOUT' });
  await vi.advanceTimersByTimeAsync(30_000); await rejection;
  expect(onUsage).toHaveBeenCalledExactlyOnceWith(null, onCallStart.mock.calls[0][0]);
});

test.each(['global', 'environment', 'both'])('real SDK client pins endpoint despite %s defaults (isolated offline process)', async mode => {
  const script = String.raw`
    import assert from 'node:assert/strict';
    import { createRequire } from 'node:module';
    import { pathToFileURL } from 'node:url';
    import { Gemini } from '@google/adk';
    import { createGeminiProvider } from './src/agent/provider.ts';
    const mode = process.argv[1];
    const adkUrl = import.meta.resolve('@google/adk');
    // Resolve the pinned SDK's ESM build, the same instance imported by ADK.
    const sdkPath = createRequire(adkUrl).resolve('@google/genai').replace(/index\.cjs$/, 'index.mjs');
    const { setDefaultBaseUrls } = await import(pathToFileURL(sdkPath).href);
    if (mode !== 'environment') setDefaultBaseUrls({ geminiUrl: 'https://global-endpoint.invalid' });
    const calls = [];
    // Never delegate to native fetch. Even the vulnerable control stays offline.
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return Response.json({ candidates: [{ content: { role: 'model', parts: [{ text: 'offline answer' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, totalTokenCount: 3 } });
    };
    const key = 'offline-placeholder-not-a-credential';
    const input = () => ({ contents: [{ role: 'user', parts: [{ text: 'offline synthetic prompt' }] }], liveConnectConfig: {}, toolsDict: {} });
    const control = new Gemini({ model: 'gemini-2.5-flash', apiKey: key, vertexai: false, useInteractionsApi: false });
    for await (const unused of control.generateContentAsync(input())) void unused;
    assert.equal(new URL(calls[0].url).hostname, mode === 'environment' ? 'env-endpoint.invalid' : 'global-endpoint.invalid');
    const usage = [];
    const model = createGeminiProvider({ apiKey: key, deadlineMs: Date.now() + 5000, onUsage: value => usage.push(value) });
    assert.equal(model.apiClient.vertexai, false);
    assert.equal(model.useInteractionsApi, false);
    const request = input();
    request.config = { httpOptions: { baseUrl: 'https://request-endpoint.invalid', apiVersion: 'v999' } };
    for await (const unused of model.generateContentAsync(request)) void unused;
    assert.equal(calls.length, 2);
    const endpoint = new URL(calls[1].url);
    assert.equal(endpoint.origin, 'https://generativelanguage.googleapis.com');
    assert.equal(endpoint.pathname, '/v1beta/models/gemini-3.1-flash-lite:generateContent');
    assert.equal(new Headers(calls[1].init.headers).get('x-goog-api-key'), key);
    assert.equal(JSON.parse(calls[1].init.body).contents[0].parts[0].text, 'offline synthetic prompt');
    assert.deepEqual(usage, [{ promptTokens: 2, outputTokens: 1, totalTokens: 3 }]);
    console.log('ENDPOINT_PIN_PASS');
  `;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, mode], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)), timeout: 10_000,
    env: { NODE_ENV: 'test', OTEL_SDK_DISABLED: 'true',
      ...(mode === 'global' ? {} : { GOOGLE_GEMINI_BASE_URL: 'https://env-endpoint.invalid' }) },
  });
  expect(stdout).toContain('ENDPOINT_PIN_PASS');
}, 15_000);
