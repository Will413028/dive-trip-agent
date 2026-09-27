import { randomUUID } from 'node:crypto';
import { afterEach, expect, test, vi } from 'vitest';
import { App, FunctionTool, InMemorySessionService, LlmAgent, Runner, type Event } from '@google/adk';
import { z } from 'zod';
import { evaluationInput } from '../../evals/fixtures';
import { createCloudflareProvider } from '../../src/agent/cloudflare-provider';
import { CLOUDFLARE_MODEL } from '../../src/agent/cloudflare-wire';
import { FINAL_RESPONSE_TOOL, GuardedModel } from '../../src/agent/model-guard';
import { AGENT_INSTRUCTION } from '../../src/agent/prompt';
import { agentToolParameters } from '../../src/agent/tool-schemas';
import { createReadTools } from '../../src/agent/tools';
import { toolArgumentErrorCode } from '../../src/agent/tool-diagnostic';
import { acceptedAnswerSchema, answerPlanSchema, evidenceIdSchema } from '../../src/domain/answer';
import { requirementsEvidence } from '../../src/agent/answer-evidence';
import { recordModelAnswer, recordToolEvidence, savedAnswer } from '../../src/agent/answer-session';

afterEach(() => { vi.restoreAllMocks(); });

// Representative counterexamples, NOT reconstructions of the unrecorded live value.
const invalidDates = ['', 'null', '未定', '2026/09/26', '2026-9-26', '2026-02-29',
  '2026-04-31', '2026-09-26T00:00:00Z', ' 2026-09-26 '];
test('validate_changes keeps date validation strict without coercion; propose_changes rejects changes', () => {
  const value = evaluationInput('locked-budget').before.requirements;
  for (const startDate of [null, '2026-09-26', '2028-02-29']) {
    const input = { changes: [{ kind: 'requirements', value: { ...value, startDate } }] };
    expect(agentToolParameters.validate_changes.parse(input)).toEqual(input);
    expect(agentToolParameters.propose_changes.safeParse(input).success).toBe(false);
  }
  for (const startDate of [...invalidDates, 0, false, undefined]) {
    expect(agentToolParameters.validate_changes.safeParse({ changes: [{ kind: 'requirements', value: { ...value, startDate } }] }).success).toBe(false);
  }
});

test.each([undefined, null, '2028-02-29', ...invalidDates])(
  'native ADK/Cloudflare transmits and enforces the date contract for %j', async startDate => {
    const valid = startDate === undefined || startDate === null || startDate === '2028-02-29';
    const fixture = evaluationInput('locked-budget');
    // The valid dated case preserves an existing date, rather than inventing one.
    if (valid && startDate !== undefined) fixture.before.requirements.startDate = startDate;
    const original = structuredClone(fixture.before);
    const binding = { ownerId: randomUUID(), tripId: randomUUID(), runId: randomUUID(), baseVersion: 1 };
    const answerSession = { binding, snapshot: fixture.before, catalog: fixture.catalog };
    const requirementsRef = requirementsEvidence(binding, fixture.before).id;
    const args = { changes: [{ kind: 'requirements', value: {
      budgetMinor: 200000, ...(startDate === undefined ? {} : { startDate }),
    } }] };
    const readTools = createReadTools({ snapshot: fixture.before, catalog: fixture.catalog });
    const validate = readTools.find(t => t.name === 'validate_changes')!;
    const runTool = vi.spyOn(validate, 'runAsync');
    const propose = vi.fn(() => { throw new Error('UNEXPECTED_PROPOSAL'); });
    const proposal = new FunctionTool({ name: 'propose_changes', description: 'synthetic declaration only',
      parameters: agentToolParameters.propose_changes, execute: propose, requireConfirmation: true });
    const accountId = 'a'.repeat(32);
    let requests = 0;
    let candidateRef: string | undefined;
    const transport = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      expect(url).toBe(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${CLOUDFLARE_MODEL}`);
      expect(++requests).toBeLessThanOrEqual(valid ? 2 : 1);
      const body = JSON.parse(String(init?.body));
      if (requests === 1) {
        const system = body.messages.filter((m: { role: string }) => m.role === 'system')
          .map((m: { content: string }) => m.content).join('\n');
        expect(system).toContain(AGENT_INSTRUCTION);
        expect(system).not.toContain('untrustedTripData":');
        expect(system).not.toContain(requirementsRef);
        const user = body.messages.filter((m: { role: string }) => m.role === 'user')
          .map((m: { content: string }) => m.content).join('\n');
        expect(user).toContain(JSON.stringify({ untrustedTripData: fixture.before }));
        expect(user).toContain(JSON.stringify({ requirementsEvidenceRef: requirementsRef }));
        const finalSchema = body.tools.find((t: { function: { name: string } }) => t.function.name === FINAL_RESPONSE_TOOL).function.parameters;
        expect(finalSchema).toEqual(z.toJSONSchema(answerPlanSchema));
        const tool = body.tools.find((t: { function: { name: string } }) => t.function.name === 'validate_changes');
        expect(tool.function.parameters.additionalProperties).toBe(false);
        const requirement = tool.function.parameters.properties.changes.items.anyOf
          .find((b: { properties: { kind: { const: string } } }) => b.properties.kind.const === 'requirements').properties.value;
        expect(requirement.required ?? []).not.toContain('startDate');
        expect(requirement.additionalProperties).toBe(false);
        expect(requirement.properties.startDate.anyOf).toEqual([
          expect.objectContaining({ type: 'string', format: 'date', pattern: expect.any(String) }), { type: 'null' },
        ]);
        const proposalSchema = body.tools.find((t: { function: { name: string } }) => t.function.name === 'propose_changes').function.parameters;
        expect(proposalSchema.additionalProperties).toBe(false);
        expect(proposalSchema.required).toEqual(['validationId']);
        expect(Object.keys(proposalSchema.properties)).toEqual(['validationId']);
        expect(proposalSchema.properties.validationId).toMatchObject({ type: 'string', format: 'uuid' });
      }
      if (requests === 2) {
        const responses = body.messages.filter((m: { role: string }) => m.role === 'tool');
        const result = JSON.parse(responses.at(-1).content);
        expect(result).toMatchObject({ canApply: false, validationId: null,
          priceDisclosure: { containsDemo: true },
          budgetConstraint: { status: 'locked-known-cost-exceeds-budget', lockedKnownMinor: 300000,
            targetBudgetMinor: 200000 } });
        expect(result).not.toHaveProperty('knownTwdDisplay');
        candidateRef = evidenceIdSchema.parse(result.answerEvidenceRef);
      }
      const first = requests === 1;
      return Response.json({ success: true, result: { model: `${CLOUDFLARE_MODEL}-external`,
        usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
        choices: [{ finish_reason: 'tool_calls', message: first
          ? { role: 'assistant', content: null, tool_calls: [{ id: 'synthetic-date-call', type: 'function',
            function: { name: 'validate_changes', arguments: JSON.stringify(args) } }] }
          : { role: 'assistant', content: null, tool_calls: [{ id: 'synthetic-date-answer', type: 'function',
            function: { name: FINAL_RESPONSE_TOOL,
              arguments: JSON.stringify({ version: '1', answer: { kind: 'conflict', evidenceRef: candidateRef } }) } }] } }],
      } });
    });
    const sessions = new InMemorySessionService();
    const identity = { appName: 'date_contract', userId: binding.ownerId, sessionId: binding.runId };
    await sessions.createSession(identity);
    const evidence = vi.fn(async () => {});
    const model = new GuardedModel(createCloudflareProvider({ model: CLOUDFLARE_MODEL, accountId,
      apiKey: 'offline-placeholder-not-a-credential', deadlineMs: Date.now() + 10000,
      onCallStart: async () => {}, onEvidence: evidence }));
    const runner = new Runner({ app: new App({ name: identity.appName, rootAgent: new LlmAgent({
      name: 'agent', instruction: AGENT_INSTRUCTION, model, tools: [...readTools, proposal], outputSchema: answerPlanSchema,
      afterToolCallback: ({ tool, args, context, response }) => recordToolEvidence(answerSession, tool, args, context, response),
      afterModelCallback: ({ context, response }) => { recordModelAnswer(answerSession, context, response); },
    }) }), sessionService: sessions });
    const events: Event[] = [];
    for await (const event of runner.runAsync({ userId: identity.userId, sessionId: identity.sessionId,
      newMessage: { role: 'user', parts: [{ text: fixture.prompt },
        { text: JSON.stringify({ untrustedTripData: fixture.before }) },
        { text: JSON.stringify({ requirementsEvidenceRef: requirementsRef }) }] }, runConfig: { maxLlmCalls: 7 },
    })) events.push(event);
    expect(transport).toHaveBeenCalledTimes(valid ? 2 : 1);
    expect(evidence).toHaveBeenCalledTimes(valid ? 2 : 1);
    expect(propose).not.toHaveBeenCalled();
    expect(fixture.before).toEqual(original);
    const errors = events.filter(e => e.errorCode);
    const answers = events.flatMap(event => {
      const answer = savedAnswer(event, binding.runId);
      return answer ? [acceptedAnswerSchema.parse(answer)] : [];
    });
    if (valid) {
      expect(errors).toEqual([]);
      expect(runTool).toHaveBeenCalledTimes(1);
      expect(runTool.mock.calls[0][0].args).toEqual(args);
      expect(await runTool.mock.results[0].value).toMatchObject({ canApply: false, validationId: null });
      expect(model.callCounts).toEqual({ modelCalls: 2, toolCalls: 2 });
      expect(answers).toHaveLength(1);
      expect(answers[0]).toMatchObject({ runId: binding.runId, evidenceRefs: [candidateRef],
        body: { kind: 'conflict', budget: { scope: 'candidate', baseVersion: 1,
          target: { minor: 200000, display: 'TWD 2000.00' }, containsDemo: true,
          locked: { status: 'locked-known-cost-exceeds-budget', known: { minor: 300000, display: 'TWD 3000.00' } } } } });
      expect(JSON.stringify(answers)).not.toMatch(/ownerId|tripId|answerEvidenceRef|validationId/);
    } else {
      expect(answers).toEqual([]);
      expect(model.callCounts).toEqual({ modelCalls: 1, toolCalls: 0 });
      expect(runTool).not.toHaveBeenCalled();
      expect(errors).toHaveLength(1);
      expect(toolArgumentErrorCode(errors[0].errorMessage)).toBe('AGENT_TOOL_ARGUMENTS');
      expect(JSON.parse(errors[0].errorMessage!)).toEqual({ code: 'AGENT_TOOL_ARGUMENTS', tool: 'validate_changes',
        issues: [{ code: 'invalid_format', path: ['changes', '*', 'value', 'startDate'] }] });
      const saved = await sessions.getSession(identity);
      expect(saved?.events.some(e => e.errorMessage === errors[0].errorMessage)).toBe(true);
      expect(saved?.events.flatMap(e => e.content?.parts ?? []).some(p => p.functionCall)).toBe(false);
    }
  }, 15000);
