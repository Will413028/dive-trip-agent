import { randomUUID } from 'node:crypto';
import { afterEach, expect, test, vi } from 'vitest';
import { App, FunctionTool, InMemorySessionService, LlmAgent, Runner, type Event, type LlmRequest } from '@google/adk';
import { z } from 'zod';
import { cloudflareInvalidResponse, providerDiagnosticErrorCode } from '../../src/agent/provider-diagnostic';
import { cloudflareResponse, CLOUDFLARE_MODEL } from '../../src/agent/cloudflare-wire';
import { createCloudflareProvider } from '../../src/agent/cloudflare-provider';
import { FINAL_RESPONSE_TOOL, GuardedModel } from '../../src/agent/model-guard';
import { publicAgentErrorCode } from '../../src/server/agent-error';
import { AGENT_INSTRUCTION } from '../../src/agent/prompt';
import { agentToolParameters } from '../../src/agent/tool-schemas';
import { acceptedAnswerSchema, answerPlanSchema } from '../../src/domain/answer';
import { requirementsEvidence } from '../../src/agent/answer-evidence';
import { recordModelAnswer, savedAnswer } from '../../src/agent/answer-session';
import { createReadTools } from '../../src/agent/tools';
import { makeSnapshot } from '../support/domain-fixtures';

afterEach(() => vi.restoreAllMocks());
const raw = (reason: unknown) => ({ success: true, result: { model: CLOUDFLARE_MODEL,
  usage: { prompt_tokens: 10, completion_tokens: 2048, total_tokens: 2058 },
  choices: [{ finish_reason: reason, message: { role: 'assistant', content: 'private_body',
    reasoning: 'private_reasoning', tool_calls: [{ private_field: 'private_args' }] } }] } });

test.each([['length', 'length'], ['content_filter', 'content_filter'], ['private_finish', 'other-response'],
  [null, 'other-response']])('invalid response keeps only allowlisted reason %s', (reason, expected) => {
  let message = '';
  try { cloudflareResponse(raw(reason)); } catch (error) { message = (error as Error).message; }
  expect(JSON.parse(message)).toEqual({ code: 'AGENT_PROVIDER_INVALID_RESPONSE', provider: 'cloudflare', stage: 'response', reason: expected });
  expect(message).not.toContain('private');
  expect(providerDiagnosticErrorCode(message)).toBe('AGENT_PROVIDER_INVALID_RESPONSE');
});

test('metadata decoder rejects extra fields, unknown values, prefixes and oversized input', () => {
  const message = cloudflareInvalidResponse('response', 'length').message;
  for (const bad of [undefined, '{', message + 'suffix', 'prefix' + message, 'x'.repeat(513),
    message.replace('length', 'private_reason'), message.replace('cloudflare', 'private_provider'),
    message.replace('response"', 'private_stage"'),
    JSON.stringify({ ...JSON.parse(message), body: 'private_body' })]) {
    expect(providerDiagnosticErrorCode(bad)).toBeUndefined();
  }
  expect(publicAgentErrorCode(new Error(message))).toBe('AGENT_INTERRUPTED');
  expect(publicAgentErrorCode(new Error(providerDiagnosticErrorCode(message)))).toBe('AGENT_PROVIDER_INVALID_RESPONSE');
});

test.each(['length', 'usage-invalid', 'model-mismatch'] as const)('native ADK persists %s metadata, saves usage once, executes no valid candidate tool and does not retry', async reason => {
  const data = raw(reason === 'length' ? 'length' : 'tool_calls');
  if (reason === 'usage-invalid') data.result.usage.total_tokens = 1;
  if (reason === 'model-mismatch') data.result.model = '@cf/other/model';
  const candidate = { ...data, result: { ...data.result, choices: [{ finish_reason: reason === 'length' ? 'length' : 'tool_calls',
    message: { role: 'assistant', content: 'private_body', reasoning: 'private_reasoning',
      tool_calls: [{ id: 'valid-call', type: 'function', function: { name: 'calculate_budget', arguments: '{}' } }] } }] } };
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(candidate));
  const execute = vi.fn(async () => ({ knownTwdDisplay: 'synthetic' }));
  const tool = new FunctionTool({ name: 'calculate_budget', description: 'synthetic', parameters: agentToolParameters.calculate_budget, execute });
  const usage = vi.fn(async () => {}), start = vi.fn(async () => {});
  const provider = createCloudflareProvider({ apiKey: 'synthetic-only', accountId: 'a'.repeat(32), model: CLOUDFLARE_MODEL,
    deadlineMs: Date.now() + 5000, onCallStart: start, onEvidence: usage });
  const sessions = new InMemorySessionService();
  const identity = { appName: 'diagnostic', userId: 'synthetic', sessionId: 'synthetic' };
  await sessions.createSession(identity);
  const runner = new Runner({ app: new App({ name: identity.appName,
    rootAgent: new LlmAgent({ name: 'diagnostic', model: new GuardedModel(provider), instruction: AGENT_INSTRUCTION, tools: [tool] }) }), sessionService: sessions });
  const events: Event[] = [];
  for await (const event of runner.runAsync({ userId: identity.userId, sessionId: identity.sessionId,
    newMessage: { role: 'user', parts: [{ text: '合成測試' }] } })) events.push(event);
  const error = events.find(e => e.errorCode);
  expect(JSON.parse(error!.errorMessage!)).toMatchObject({ reason, stage: reason === 'length' ? 'response' : 'evidence' });
  expect(providerDiagnosticErrorCode(error!.errorMessage)).toBe('AGENT_PROVIDER_INVALID_RESPONSE');
  expect(JSON.stringify(await sessions.getSession(identity))).toContain(reason);
  expect(JSON.stringify(events)).not.toMatch(/private_body|private_reasoning|private_args|synthetic-only/);
  expect(events.flatMap(e => e.content?.parts ?? [])).toEqual([]);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toMatchObject({
    max_completion_tokens: 2048, chat_template_kwargs: { enable_thinking: false },
  });
  expect(execute).not.toHaveBeenCalled();
  expect(start).toHaveBeenCalledTimes(1);
  expect(usage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ usage: reason === 'usage-invalid' ? null
    : { promptTokens: 10, outputTokens: 2048, totalTokens: 2058 } }), expect.any(String));
});

test.each(['usage-invalid', 'model-mismatch'] as const)('evidence failure %s has private classification and yields no text', async reason => {
  const data = raw('stop');
  if (reason === 'usage-invalid') data.result.usage.total_tokens = 1;
  else data.result.model = '@cf/other/model';
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(data));
  const onEvidence = vi.fn(async () => {});
  const provider = createCloudflareProvider({ apiKey: 'synthetic-only', accountId: 'a'.repeat(32), model: CLOUDFLARE_MODEL,
    deadlineMs: Date.now() + 5000, onCallStart: async () => {}, onEvidence });
  const request: LlmRequest = { contents: [{ role: 'user', parts: [{ text: 'synthetic' }] }], toolsDict: {}, liveConnectConfig: {} };
  await expect(provider.generateContentAsync(request).next()).rejects.toThrow(cloudflareInvalidResponse('evidence', reason).message);
  expect(onEvidence).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledTimes(1);
});

test.each(['requirements', 'raw-prose', 'invented-price', 'foreign-ref'] as const)(
  'native outbound answer schema handles %s through evidence validation without a prose fallback', async scenario => {
  const snapshot = makeSnapshot(), catalog = snapshot.entries.map(entry => entry.item);
  const binding = { ownerId: randomUUID(), tripId: randomUUID(), runId: randomUUID(), baseVersion: 1 };
  const requirementsRef = requirementsEvidence(binding, snapshot).id;
  const foreignRef = requirementsEvidence({ ...binding, tripId: randomUUID() }, snapshot).id;
  const plan = { version: '1', answer: { kind: 'requirements',
    evidenceRef: scenario === 'foreign-ref' ? foreignRef : requirementsRef,
    ...(scenario === 'invented-price' ? { display: 'private_body TWD 0.00' } : {}) } };
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ success: true, result: {
    model: CLOUDFLARE_MODEL, usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    choices: [{ finish_reason: scenario === 'raw-prose' ? 'stop' : 'tool_calls', message: scenario === 'raw-prose'
      ? { role: 'assistant', content: 'private_body 已保存且全程免費' }
      : { role: 'assistant', content: null, tool_calls: [{ id: 'requirements-answer', type: 'function',
        function: { name: FINAL_RESPONSE_TOOL, arguments: JSON.stringify(plan) } }] } }],
  } }));
  const onEvidence = vi.fn(async () => {});
  const provider = createCloudflareProvider({ apiKey: 'synthetic-only', accountId: 'a'.repeat(32), model: CLOUDFLARE_MODEL,
    deadlineMs: Date.now() + 5000, onCallStart: async () => {}, onEvidence });
  const sessions = new InMemorySessionService();
  const identity = { appName: 'requirements_contract', userId: binding.ownerId, sessionId: binding.runId };
  await sessions.createSession(identity);
  const tools = createReadTools({ snapshot, catalog });
  const toolRuns = tools.map(tool => vi.spyOn(tool, 'runAsync'));
  const model = new GuardedModel(provider);
  const runner = new Runner({ app: new App({ name: identity.appName, rootAgent: new LlmAgent({
    name: 'requirements_contract', model, instruction: AGENT_INSTRUCTION, tools, outputSchema: answerPlanSchema,
    afterModelCallback: ({ context, response }) => { recordModelAnswer({ binding, snapshot, catalog }, context, response); },
  }) }), sessionService: sessions });
  const events: Event[] = [];
  for await (const event of runner.runAsync({ userId: identity.userId, sessionId: identity.sessionId,
    newMessage: { role: 'user', parts: [{ text: 'private_user_marker 只確認已保存需求' },
      { text: JSON.stringify({ untrustedTripData: snapshot }) }, { text: JSON.stringify({ requirementsEvidenceRef: requirementsRef }) }] },
    runConfig: { maxLlmCalls: 7 },
  })) events.push(event);
  const body = JSON.parse(String(fetch.mock.calls[0]![1]!.body));
  expect(body.messages[0].content).toContain(AGENT_INSTRUCTION);
  expect(body.messages[0].content).not.toMatch(/private_user_marker|untrustedTripData":|ev_[a-f0-9]{64}/);
  expect(body.tools.find((tool: { function: { name: string } }) => tool.function.name === FINAL_RESPONSE_TOOL).function.parameters)
    .toEqual(z.toJSONSchema(answerPlanSchema));
  expect(body.max_completion_tokens).toBe(2048);
  expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(onEvidence).toHaveBeenCalledTimes(1);
  for (const run of toolRuns) expect(run).not.toHaveBeenCalled();
  const answers = events.map(event => savedAnswer(event, binding.runId)).filter(answer => answer !== undefined);
  if (scenario === 'requirements') {
    expect(events.filter(event => event.errorCode)).toEqual([]);
    expect(model.callCounts).toEqual({ modelCalls: 1, toolCalls: 1 });
    expect(answers).toHaveLength(1);
    const { budgetMinor, ...requirements } = snapshot.requirements;
    expect(acceptedAnswerSchema.parse(answers[0])).toMatchObject({ runId: binding.runId, evidenceRefs: [requirementsRef],
      body: { kind: 'requirements', version: 1, requirements: {
        ...requirements, target: { minor: budgetMinor, display: 'TWD 10000.00' } } } });
    expect(JSON.stringify(answers)).not.toMatch(/items|capacityPerRoom|room-night|private_user_marker|ownerId|tripId/);
  } else {
    expect(answers).toEqual([]); // A safe rejection is a failed turn, never a quality pass.
    const errors = events.filter(event => event.errorCode);
    expect(errors).toHaveLength(1);
    expect(errors[0].errorMessage).toBe(scenario === 'foreign-ref' ? 'AGENT_ANSWER_EVIDENCE' : 'AGENT_ANSWER_SCHEMA');
  }
  expect(JSON.stringify(events)).not.toContain('private_body');
  expect(JSON.stringify(events)).not.toContain('synthetic-only');
});
