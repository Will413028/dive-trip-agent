import { randomUUID } from 'node:crypto';
import { App, BaseLlm, FunctionTool, InMemorySessionService, LlmAgent, Runner,
  type BaseLlmConnection, type Event, type LlmRequest, type LlmResponse } from '@google/adk';
import { expect, test, vi } from 'vitest';
import { GuardedModel } from '../../src/agent/model-guard';
import { answerPlanSchema } from '../../src/domain/answer';
import { createReadTools } from '../../src/agent/tools';
import { recordModelAnswer, recordToolEvidence, savedAnswer, type AnswerSession } from '../../src/agent/answer-session';
import { validatedProposalParametersSchema } from '../../src/agent/tool-schemas';
import { makeSnapshot } from '../support/domain-fixtures';

class Script extends BaseLlm {
  calls = 0;
  constructor() { super({ model: 'synthetic-no-model-receipt' }); }
  async *generateContentAsync(request: LlmRequest): AsyncGenerator<LlmResponse> {
    if (++this.calls > 2) throw new Error('RECEIPT_MUST_NOT_CALL_MODEL');
    const result = request.contents.flatMap(content => content.parts ?? [])
      .findLast(part => part.functionResponse?.name === 'validate_changes')?.functionResponse?.response;
    yield { content: { role: 'model', parts: [{ functionCall: { id: result ? 'proposal' : 'validation',
      name: result ? 'propose_changes' : 'validate_changes', args: result ? { validationId: result.validationId }
        : { changes: [{ kind: 'remove', entryId: 'transfer' }] } } }] } };
  }
  async connect(): Promise<BaseLlmConnection> { throw new Error('NETWORK_FORBIDDEN'); }
}

test.each([true, false])('native confirmation %s ends in one durable receipt with zero further model calls', async confirmed => {
  const source = new Script(), snapshot = makeSnapshot();
  const input: AnswerSession = { binding: { ownerId: randomUUID(), tripId: randomUUID(), runId: randomUUID(), baseVersion: 1 },
    snapshot, catalog: snapshot.entries.map(entry => entry.item) };
  const sessions = new InMemorySessionService();
  const identity = { appName: 'deterministic_receipt', userId: input.binding.ownerId, sessionId: input.binding.runId };
  await sessions.createSession(identity);
  const execute = vi.fn(() => input.committedResult!);
  const agent = new LlmAgent({ name: identity.appName, model: new GuardedModel(source), outputSchema: answerPlanSchema,
    tools: [...createReadTools(input), new FunctionTool({ name: 'propose_changes', description: 'Native confirmation probe with a committed receipt.',
      parameters: validatedProposalParametersSchema, requireConfirmation: true, execute })],
    afterToolCallback: ({ tool, args, context, response }) => recordToolEvidence(input, tool, args, context, response),
    afterModelCallback: ({ context, response }) => { recordModelAnswer(input, context, response); },
  });
  const runner = () => new Runner({ app: new App({ name: identity.appName, rootAgent: agent,
    resumabilityConfig: { isResumable: true } }), sessionService: sessions });
  const run = async (parts: NonNullable<LlmResponse['content']>['parts']) => {
    const events: Event[] = [];
    for await (const event of runner().runAsync({ userId: identity.userId, sessionId: identity.sessionId,
      newMessage: { role: 'user', parts }, runConfig: { plainTextToolConfirmation: false, allowRemoteToolConfirmation: false } })) events.push(event);
    expect(events.filter(event => event.errorCode)).toEqual([]);
    return events;
  };
  const first = await run([{ text: '第二天下午留白' }]);
  const gate = first.flatMap(event => event.content?.parts ?? []).find(part => part.functionCall?.name === 'adk_request_confirmation')?.functionCall;
  expect(gate?.id).toBeTruthy(); expect(source.calls).toBe(2); expect(execute).not.toHaveBeenCalled();
  input.committedResult = { status: confirmed ? 'applied' : 'rejected', version: confirmed ? 2 : 1 };
  const resumed = await run([{ functionResponse: { id: gate!.id, name: 'adk_request_confirmation', response: { confirmed } } }]);
  const terminal = resumed.findLast(event => savedAnswer(event, input.binding.runId)?.body.kind === 'receipt')!;
  expect(terminal.actions.skipSummarization).toBe(true);
  expect(terminal.content?.parts?.[0].functionResponse?.name).toBe('propose_changes');
  expect(savedAnswer(terminal, input.binding.runId)?.body).toEqual({ kind: 'receipt', ...input.committedResult });
  expect((await sessions.getSession(identity))!.events).toContainEqual(terminal);
  expect(source.calls).toBe(2); expect(execute).toHaveBeenCalledTimes(confirmed ? 1 : 0);
});
