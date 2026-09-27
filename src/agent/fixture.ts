import { randomUUID } from 'node:crypto';
import { BaseLlm, type BaseLlmConnection, type LlmRequest, type LlmResponse } from '@google/adk';
import type { Snapshot } from '../domain/types.ts';
import { evidenceIdSchema, type AnswerPlan } from '../domain/answer.ts';
import { FINAL_RESPONSE_TOOL } from './model-guard.ts';

export const fixtureToolName = 'propose_changes';

/** Deliberately literal script: never claims general language understanding. */
export class FixtureModel extends BaseLlm {
  private readonly snapshot: Snapshot;
  private readonly message: string;
  constructor(snapshot: Snapshot, message: string) {
    super({ model: 'offline-dive-trip-fixture' });
    this.snapshot = snapshot;
    this.message = message;
  }
  async *generateContentAsync(request: LlmRequest): AsyncGenerator<LlmResponse> {
    const parts = request.contents.flatMap(content => content.parts ?? []);
    const result = parts
      .findLast(part => part.functionResponse?.name === fixtureToolName)?.functionResponse?.response;
    const ref = (value: unknown) => evidenceIdSchema.parse(value);
    const call = (name: string, args: Record<string, unknown>): LlmResponse => ({ content: { role: 'model',
      parts: [{ functionCall: { id: randomUUID(), name, args } }] } });
    let answer: AnswerPlan['answer'];
    if (result) throw new Error('FIXTURE_RECEIPT_MUST_NOT_CALL_MODEL');
    if (['查詢目的地', '試算目前預算'].includes(this.message.trim())) {
      const name = this.message.trim() === '查詢目的地' ? 'find_destinations' : 'calculate_budget';
      const readResult = request.contents.flatMap(content => content.parts ?? [])
        .findLast(part => part.functionResponse?.name === name)?.functionResponse?.response;
      if (!readResult) {
        yield call(name, {});
        return;
      }
      answer = { kind: name === 'find_destinations' ? 'destinations' : 'budget', evidenceRef: ref(readResult.answerEvidenceRef) };
    } else if (this.message.trim() === '把行程改為悠閒') {
      const changes = [{ kind: 'requirements', value: { pace: 'relaxed' } }];
      const validation = request.contents.flatMap(content => content.parts ?? [])
        .findLast(part => part.functionResponse?.name === 'validate_changes')?.functionResponse?.response;
      if (validation && validation.canApply !== true) {
        answer = { kind: 'conflict', evidenceRef: ref(validation.answerEvidenceRef) };
      } else {
        yield { content: { role: 'model', parts: [{ functionCall: { id: randomUUID(),
          name: validation ? fixtureToolName : 'validate_changes',
          args: validation ? { validationId: validation.validationId } : { changes } } }] } };
        return;
      }
    } else if (this.message.trim() === '第二天下午留白') {
      const entries = this.snapshot.entries.filter(entry => entry.day === 2 && entry.slot === 'afternoon' && entry.item.kind === 'activity');
      if (entries.length) {
        const validation = request.contents.flatMap(content => content.parts ?? [])
          .findLast(part => part.functionResponse?.name === 'validate_changes')?.functionResponse?.response;
        if (validation && validation.canApply !== true) {
          yield call(FINAL_RESPONSE_TOOL, { version: '1', answer: { kind: 'conflict', evidenceRef: ref(validation.answerEvidenceRef) } });
          return;
        }
        yield { content: { role: 'model', parts: [{ functionCall: {
          id: randomUUID(), name: validation ? fixtureToolName : 'validate_changes',
          args: validation ? { validationId: validation.validationId }
            : { changes: entries.map(entry => ({ kind: 'remove', entryId: entry.id })) },
        } }] } };
        return;
      }
      const reference = parts.flatMap(part => {
        try { return part.text ? [JSON.parse(part.text) as Record<string, unknown>] : []; } catch { return []; }
      }).find(item => item.requirementsEvidenceRef)?.requirementsEvidenceRef;
      answer = { kind: 'requirements', evidenceRef: ref(reference) };
    } else if (this.message.trim() === '人數未定') {
      answer = { kind: 'clarify', fields: ['people', 'divers'] };
    } else {
      answer = { kind: 'unsupported', reason: 'outside-scope' };
    }
    yield call(FINAL_RESPONSE_TOOL, { version: '1', answer });
  }
  async connect(): Promise<BaseLlmConnection> { throw new Error('FIXTURE_NETWORK_DISABLED'); }
}
