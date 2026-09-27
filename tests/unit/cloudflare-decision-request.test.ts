import { randomUUID } from 'node:crypto';
import { afterEach, expect, test, vi } from 'vitest';
import { App, FunctionTool, InMemorySessionService, LlmAgent, Runner, type Event } from '@google/adk';
import { z } from 'zod';
import { createCloudflareProvider } from '../../src/agent/cloudflare-provider';
import { CLOUDFLARE_MODEL } from '../../src/agent/cloudflare-wire';
import { FINAL_RESPONSE_TOOL, GuardedModel } from '../../src/agent/model-guard';
import { AGENT_INSTRUCTION } from '../../src/agent/prompt';
import { agentToolParameters } from '../../src/agent/tool-schemas';
import { createReadTools } from '../../src/agent/tools';
import { acceptedAnswerSchema, answerPlanSchema, evidenceIdSchema } from '../../src/domain/answer';
import { evidenceIdentity, requirementsEvidence } from '../../src/agent/answer-evidence';
import { ACCEPTED_ANSWER_STATE, recordModelAnswer, recordToolEvidence, savedAnswer } from '../../src/agent/answer-session';
import { makeSnapshot } from '../support/domain-fixtures';

const proposalId = 'synthetic-proposal';
const validationCallId = 'synthetic-validation';
const accountId = 'a'.repeat(32);
const apiKey = 'offline-placeholder-not-a-credential';
const requestSchema = z.object({ messages: z.array(z.object({ role: z.string(), content: z.string().nullable(),
  tool_call_id: z.string().optional(), tool_calls: z.array(z.object({ id: z.string(),
    function: z.object({ name: z.string(), arguments: z.string() }) })).optional() })),
  tools: z.array(z.object({ function: z.object({ name: z.string(), parameters: z.record(z.string(), z.unknown()) }) })) });
afterEach(() => { vi.restoreAllMocks(); });

test.each(['approved', 'rejected'] as const)(
  'native ADK %s compiles the committed receipt without another Cloudflare request or model callback', async decision => {
    const receipt = { status: decision === 'approved' ? 'applied' as const : 'rejected' as const,
      version: decision === 'approved' ? 2 : 1 };
    const snapshot = makeSnapshot(), catalog = snapshot.entries.map(entry => entry.item);
    const binding = { ownerId: randomUUID(), tripId: randomUUID(), runId: randomUUID(), baseVersion: 1 };
    const requirementsRef = requirementsEvidence(binding, snapshot).id;
    const changes = [{ kind: 'requirements', value: { pace: 'relaxed' } }];
    let validationId: string | undefined;
    const receiptRef = evidenceIdentity(binding, 'receipt', proposalId);
    const requests: z.infer<typeof requestSchema>[] = [];
    // This stub owns every fetch; unexpected URLs/calls fail locally with no fallback.
    const transport = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      expect(url).toBe(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${CLOUDFLARE_MODEL}`);
      expect(init?.method).toBe('POST');
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${apiKey}`);
      expect(requests.length).toBeLessThan(2);
      requests.push(requestSchema.parse(JSON.parse(String(init?.body))));
      const outbound = requests.at(-1)!;
      expect(outbound.tools.find(tool => tool.function.name === FINAL_RESPONSE_TOOL)?.function.parameters)
        .toEqual(z.toJSONSchema(answerPlanSchema));
      let name: string, args: Record<string, unknown>, id: string;
      if (requests.length === 1) {
        name = 'validate_changes'; args = { changes }; id = validationCallId;
      } else {
        const result = JSON.parse(outbound.messages.findLast(message => message.tool_call_id === validationCallId)!.content!);
        expect(result.canApply).toBe(true);
        expect(evidenceIdSchema.safeParse(result.answerEvidenceRef).success).toBe(true);
        validationId = z.uuid().parse(result.validationId);
        name = 'propose_changes'; args = { validationId }; id = proposalId;
      }
      return Response.json({ success: true, result: { id: `synthetic-generation-${requests.length}`,
        model: `${CLOUDFLARE_MODEL}-external`, usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
        choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
          tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }],
      } });
    });
    const sessions = new InMemorySessionService();
    const identity = { appName: 'cloudflare_decision_request', userId: binding.ownerId, sessionId: binding.runId };
    await sessions.createSession(identity);
    const execute = vi.fn(() => receipt);
    const onCallStart = vi.fn(async () => {}), onEvidence = vi.fn(async () => {});
    const beforeModel = vi.fn(() => undefined);
    const guards: GuardedModel[] = [];
    function makeRunner(resume: boolean) {
      const source = createCloudflareProvider({ model: CLOUDFLARE_MODEL, accountId, apiKey,
        deadlineMs: Date.now() + 10_000, onCallStart, onEvidence });
      // Recreate runner/guard as the worker does, retaining only ADK session history.
      const model = new GuardedModel(source, resume
        ? { modelCalls: 2, toolCalls: 2, callIds: [validationCallId, proposalId], proposed: true }
        : { modelCalls: 0, toolCalls: 0 });
      guards.push(model);
      const answerSession = { binding, snapshot, catalog, ...(resume ? { committedResult: receipt } : {}) };
      const tool = new FunctionTool({ name: 'propose_changes', description: 'Synthetic proposal with native human confirmation and committed receipt.',
        parameters: agentToolParameters.propose_changes, requireConfirmation: true, execute });
      return new Runner({ app: new App({ name: identity.appName, resumabilityConfig: { isResumable: true },
        rootAgent: new LlmAgent({ name: 'synthetic_agent', model,
          instruction: AGENT_INSTRUCTION,
          tools: [...createReadTools({ snapshot, catalog }), tool], outputSchema: answerPlanSchema,
          beforeModelCallback: beforeModel,
          afterToolCallback: ({ tool, args, context, response }) => recordToolEvidence(answerSession, tool, args, context, response),
          afterModelCallback: ({ context, response }) => { recordModelAnswer(answerSession, context, response); },
        }) }), sessionService: sessions });
    }
    const runConfig = { maxLlmCalls: 7, plainTextToolConfirmation: false, allowRemoteToolConfirmation: false };
    const initial: Event[] = [];
    for await (const event of makeRunner(false).runAsync({ userId: identity.userId, sessionId: identity.sessionId,
      newMessage: { role: 'user', parts: [{ text: '請提出修改，先不要套用，供我確認。' },
        { text: JSON.stringify({ untrustedTripData: snapshot }) },
        { text: JSON.stringify({ requirementsEvidenceRef: requirementsRef }) }] }, runConfig })) initial.push(event);
    expect(initial.filter(event => event.errorCode)).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
    expect(transport).toHaveBeenCalledTimes(2);
    expect(beforeModel).toHaveBeenCalledTimes(2);
    expect(guards[0].callCounts).toEqual({ modelCalls: 2, toolCalls: 2 });
    const pending = initial.map(event => savedAnswer(event, binding.runId)).filter(answer => answer !== undefined);
    expect(pending).toHaveLength(1);
    expect(acceptedAnswerSchema.parse(pending[0])).toMatchObject({ runId: binding.runId,
      body: { kind: 'proposal', changeCount: 1, budget: { scope: 'candidate', baseVersion: 1 } } });
    const initialSystem = requests[0].messages.filter(message => message.role === 'system').map(message => message.content).join('\n');
    expect(initialSystem).toContain(AGENT_INSTRUCTION);
    expect(initialSystem).not.toContain('目前階段：修改已');
    expect(initialSystem).not.toContain(requirementsRef);
    const interrupt = initial.flatMap(event => event.content?.parts ?? [])
      .find(part => part.functionCall?.name === 'adk_request_confirmation')?.functionCall;
    expect(interrupt?.id).toBeTruthy();
    const resumed: Event[] = [];
    for await (const event of makeRunner(true).runAsync({ userId: identity.userId, sessionId: identity.sessionId,
      newMessage: { role: 'user', parts: [{ functionResponse: { id: interrupt!.id, name: 'adk_request_confirmation',
        response: { confirmed: decision === 'approved' } } }] }, runConfig })) resumed.push(event);
    expect(resumed.filter(event => event.errorCode)).toEqual([]);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(beforeModel).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(decision === 'approved' ? 1 : 0);
    expect(onCallStart).toHaveBeenCalledTimes(2);
    expect(onEvidence).toHaveBeenCalledTimes(2);
    expect(guards[1].callCounts).toEqual({ modelCalls: 2, toolCalls: 2 });
    expect(initial.flatMap(event => event.content?.parts ?? []).flatMap(part => part.functionCall
      && part.functionCall.name !== 'adk_request_confirmation' ? [{ id: part.functionCall.id, name: part.functionCall.name }] : []))
      .toEqual([{ id: validationCallId, name: 'validate_changes' }, { id: proposalId, name: 'propose_changes' }]);
    expect(initial.flatMap(event => event.content?.parts ?? []).flatMap(part => part.functionCall
      && part.functionCall.name !== 'adk_request_confirmation' ? [part.functionCall.args] : []))
      .toEqual([{ changes }, { validationId }]);
    // Rejection skips execute; the real afterTool callback supplies the bound
    // receipt and immutable answer in the same durable native tool event.
    const receiptEvents = resumed.filter(event => event.content?.parts?.some(part =>
      part.functionResponse?.name === 'propose_changes' && part.functionResponse.id === proposalId));
    expect(receiptEvents).toHaveLength(1);
    const terminal = receiptEvents[0];
    expect(terminal.actions.skipSummarization).toBe(true);
    expect(terminal.content?.parts).toHaveLength(1);
    expect(terminal.content?.parts?.[0].functionResponse?.response).toEqual({ ...receipt, answerEvidenceRef: receiptRef,
      ...(decision === 'rejected' ? { error: 'This tool call is rejected.' } : {}) });
    expect(resumed.flatMap(event => event.content?.parts ?? []).some(part => part.functionCall || part.text)).toBe(false);
    expect(JSON.stringify(requests)).not.toContain('adk_request_confirmation');
    expect(JSON.stringify(requests)).not.toContain(receiptRef);
    expect(JSON.stringify(requests)).not.toContain(apiKey);
    const answers = resumed.map(event => savedAnswer(event, binding.runId)).filter(answer => answer !== undefined);
    expect(answers).toHaveLength(1);
    expect(acceptedAnswerSchema.parse(answers[0])).toMatchObject({ runId: binding.runId, evidenceRefs: [receiptRef],
      body: { kind: 'receipt', ...receipt } });
    expect(answers[0]!.body).toEqual({ kind: 'receipt', ...receipt });
    expect(JSON.stringify(answers)).not.toMatch(/ownerId|tripId|answerEvidenceRef|validationId|This tool call is rejected/);
    expect(JSON.stringify(answers)).not.toContain(apiKey);
    expect(terminal.actions.stateDelta[ACCEPTED_ANSWER_STATE]).toEqual(answers[0]);
    const saved = (await sessions.getSession(identity))!;
    expect(saved.events).toContainEqual(terminal);
    expect(saved.events.findLast(event => event.content?.parts?.length)).toEqual(terminal);
    expect(savedAnswer(terminal, binding.runId)).toEqual(answers[0]);
    expect(transport).toHaveBeenCalledTimes(2);
  }, 15_000);
