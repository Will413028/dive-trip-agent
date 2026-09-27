import { afterEach, expect, test, vi } from 'vitest';
import { App, InMemorySessionService, LlmAgent, Runner, type LlmRequest } from '@google/adk';
import { createCloudflareProvider } from '../../src/agent/cloudflare-provider';
import { createOpenRouterProvider } from '../../src/agent/openrouter-provider';
import { CLOUDFLARE_MODEL } from '../../src/agent/cloudflare-wire';
import { AgentProviderError } from '../../src/agent/provider-errors';
import { providerDiagnosticErrorCode } from '../../src/agent/provider-diagnostic';
import { publicAgentErrorCode } from '../../src/server/agent-error';
import { UnaryRestModel } from '../../src/agent/unary-rest-model';

type Provider = 'cloudflare' | 'openrouter';
const providers: Provider[] = ['cloudflare', 'openrouter'];
const stages = ['request', 'call-start', 'fetch', 'http', 'body-read', 'body-json', 'evidence-save'] as const;
const input = (): LlmRequest => ({ contents: [{ role: 'user', parts: [{ text: 'synthetic prompt' }] }],
  toolsDict: {}, liveConnectConfig: {} });
const privateMarkers = /private_(?:credential|body|header|exception|callback)_marker/;
function setup(provider: Provider, stage: typeof stages[number]) {
  const model = provider === 'cloudflare' ? CLOUDFLARE_MODEL : 'example/model:free';
  const response = { id: 'synthetic-generation', model,
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'synthetic answer' } }],
    usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, cost: 0 } };
  const transport = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    if (stage === 'fetch') throw new TypeError('private_exception_marker');
    if (stage === 'http') return new Response('private_body_marker', { status: 418,
      headers: { 'x-provider-debug': 'private_header_marker' } });
    if (stage === 'body-read') return new Response(new ReadableStream({ start(controller) {
      controller.error(new Error('private_body_marker'));
    } }));
    if (stage === 'body-json') return new Response('{private_body_marker', {
      headers: { 'x-provider-debug': 'private_header_marker' } });
    return Response.json(provider === 'cloudflare' ? { success: true, result: response } : response);
  });
  const onCallStart = vi.fn(async (_callId: string) => { void _callId; });
  const onEvidence = vi.fn(async (_evidence: unknown, _callId: string) => { void _evidence; void _callId; });
  if (stage === 'call-start') onCallStart.mockRejectedValueOnce(new Error('private_callback_marker'));
  if (stage === 'evidence-save') onEvidence.mockRejectedValueOnce(new Error('private_callback_marker'));
  const options = { apiKey: 'private_credential_marker', model, deadlineMs: Date.now() + 5000, onCallStart, onEvidence };
  const adapter = provider === 'cloudflare'
    ? createCloudflareProvider({ ...options, accountId: 'a'.repeat(32) }) : createOpenRouterProvider(options);
  const request = input();
  if (stage === 'request') Object.defineProperty(request, 'contents', { get() { throw new Error('private_exception_marker'); } });
  return { adapter, request, transport, onCallStart, onEvidence };
}
afterEach(() => vi.restoreAllMocks());

test.each(providers.flatMap(provider => stages.map(stage => ({ provider, stage }))))(
  '$provider records only the private $stage classification and preserves call/usage boundaries', async ({ provider, stage }) => {
  const s = setup(provider, stage);
  const caught: unknown = await s.adapter.generateContentAsync(s.request).next().catch(error => error);
  expect(caught).toBeInstanceOf(AgentProviderError);
  const error = caught as AgentProviderError;
  const expected = { code: 'AGENT_PROVIDER_ERROR', provider, stage, ...(stage === 'http' ? { httpStatus: 418 } : {}) };
  expect(error.code).toBe('AGENT_PROVIDER_ERROR');
  expect(JSON.parse(error.message)).toEqual(expected);
  expect(error.message).not.toMatch(privateMarkers);
  expect(error.cause).toBeUndefined();
  expect(providerDiagnosticErrorCode(error.message)).toBe('AGENT_PROVIDER_ERROR');
  expect(publicAgentErrorCode(new Error(providerDiagnosticErrorCode(error.message)))).toBe('AGENT_PROVIDER_ERROR');
  // A raw private diagnostic never passes directly into the public mapper.
  expect(publicAgentErrorCode(error)).toBe('AGENT_INTERRUPTED');
  const dispatched = stage !== 'request' && stage !== 'call-start';
  expect(s.transport).toHaveBeenCalledTimes(dispatched ? 1 : 0);
  expect(s.onCallStart).toHaveBeenCalledTimes(stage === 'request' ? 0 : 1);
  expect(s.onEvidence).toHaveBeenCalledTimes(dispatched ? 1 : 0);
  if (dispatched) {
    expect(s.onEvidence.mock.calls[0][1]).toBe(s.onCallStart.mock.calls[0][0]);
    expect(s.onEvidence.mock.calls[0][0]).toMatchObject({ usage: stage === 'evidence-save'
      ? { promptTokens: 10, outputTokens: 4, totalTokens: 14 } : null });
    expect(s.onCallStart.mock.invocationCallOrder[0]).toBeLessThan(s.transport.mock.invocationCallOrder[0]);
    expect(s.transport.mock.invocationCallOrder[0]).toBeLessThan(s.onEvidence.mock.invocationCallOrder[0]);
  }
});

test.each(providers)('%s native ADK stores the fixed stage without raw body, header, key or exception text', async provider => {
  const s = setup(provider, 'body-json');
  const sessions = new InMemorySessionService();
  const identity = { appName: 'rest_diagnostic', userId: 'synthetic', sessionId: 'synthetic' };
  await sessions.createSession(identity);
  const runner = new Runner({ app: new App({ name: identity.appName,
    rootAgent: new LlmAgent({ name: 'diagnostic', model: s.adapter, instruction: 'Synthetic input only.' }) }), sessionService: sessions });
  const events = [];
  for await (const event of runner.runAsync({ userId: identity.userId, sessionId: identity.sessionId,
    newMessage: { role: 'user', parts: [{ text: 'synthetic task' }] } })) events.push(event);
  const failures = events.filter(event => event.errorCode);
  expect(failures).toHaveLength(1);
  const expected = { code: 'AGENT_PROVIDER_ERROR', provider, stage: 'body-json' };
  expect(JSON.parse(failures[0].errorMessage!)).toEqual(expected);
  const saved = await sessions.getSession(identity);
  expect(saved!.events!.filter(event => event.errorCode).map(event => JSON.parse(event.errorMessage!))).toEqual([expected]);
  expect(JSON.stringify({ events, saved })).not.toMatch(privateMarkers);
  expect(events.flatMap(event => event.content?.parts ?? [])).toEqual([]);
  expect(s.transport).toHaveBeenCalledTimes(1);
  expect(s.onEvidence).toHaveBeenCalledTimes(1);
});

test.each(providers.flatMap(provider => (['evidence', 'response'] as const).map(stage => ({ provider, stage }))))(
  '$provider classifies unexpected $stage adapter failures while still saving the available evidence', async ({ provider, stage }) => {
  const transport = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ synthetic: true }));
  const onCallStart = vi.fn(), onEvidence = vi.fn();
  const adapter = new UnaryRestModel({ provider, model: 'synthetic', endpoint: 'https://example.invalid',
    apiKey: 'private_credential_marker', deadlineMs: Date.now() + 5000, onCallStart, onEvidence,
    request: () => ({}), evidence: value => {
      if (value !== null && stage === 'evidence') throw new Error('private_callback_marker');
      return { usage: value === null ? null : { totalTokens: 1 } };
    }, validateEvidence: () => {}, response: () => { throw new AgentProviderError('AGENT_PROVIDER_ERROR'); },
  });
  const error = await adapter.generateContentAsync(input()).next().catch(error => error) as AgentProviderError;
  expect(JSON.parse(error.message)).toEqual({ code: 'AGENT_PROVIDER_ERROR', provider, stage });
  expect(error.message).not.toMatch(privateMarkers);
  expect(transport).toHaveBeenCalledTimes(1);
  expect(onEvidence).toHaveBeenCalledExactlyOnceWith({ usage: stage === 'evidence' ? null : { totalTokens: 1 } },
    onCallStart.mock.calls[0][0]);
});

test('generic private diagnostics have a closed schema, distinct HTTP shape and bounded input', () => {
  const diagnostic = { code: 'AGENT_PROVIDER_ERROR', provider: 'cloudflare', stage: 'body-json' };
  expect(providerDiagnosticErrorCode(JSON.stringify(diagnostic))).toBe('AGENT_PROVIDER_ERROR');
  for (const value of [
    { ...diagnostic, body: 'private_body_marker' }, { ...diagnostic, cause: 'private_exception_marker' },
    { ...diagnostic, code: 'AGENT_PROVIDER_AUTH' }, { ...diagnostic, provider: 'unknown' },
    { ...diagnostic, stage: 'unknown' }, { ...diagnostic, httpStatus: 418 },
    { ...diagnostic, stage: 'http' }, { ...diagnostic, stage: 'http', httpStatus: '418' },
    { ...diagnostic, stage: 'http', httpStatus: -1 }, { ...diagnostic, stage: 'http', httpStatus: 600 },
    { ...diagnostic, stage: 'http', httpStatus: 418.5 },
  ]) expect(providerDiagnosticErrorCode(JSON.stringify(value))).toBeUndefined();
  for (const value of [undefined, '{', 'prefix' + JSON.stringify(diagnostic), JSON.stringify(diagnostic) + 'suffix', 'x'.repeat(513)]) {
    expect(providerDiagnosticErrorCode(value)).toBeUndefined();
  }
});

test.each(providers)('%s cancellation during a failing body read keeps timeout precedence and saves unknown usage once', async provider => {
  const s = setup(provider, 'body-read');
  const abort = new AbortController();
  s.transport.mockResolvedValueOnce(new Response(new ReadableStream({ pull(controller) {
    abort.abort(); controller.error(new Error('private_exception_marker'));
  } }, { highWaterMark: 0 })));
  await expect(s.adapter.generateContentAsync(s.request, false, abort.signal).next()).rejects.toThrow('AGENT_PROVIDER_TIMEOUT');
  expect(s.transport).toHaveBeenCalledTimes(1);
  expect(s.onEvidence).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ usage: null }), s.onCallStart.mock.calls[0][0]);
});
