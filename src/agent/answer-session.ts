import type { Context, Event, LlmResponse } from '@google/adk';
import { acceptedAnswerSchema, answerPlanSchema, type EvidenceBinding, type AcceptedAnswer } from '../domain/answer.ts';
import type { CatalogItem, Snapshot } from '../domain/types.ts';
import { compileAnswer } from './answer-compiler.ts';
import { requirementsEvidence, toolEvidence, proposalEvidence, receiptEvidence, type AnswerEvidence } from './answer-evidence.ts';
import { FINAL_RESPONSE_TOOL } from './model-guard.ts';
import { validatedProposalParametersSchema } from './tool-schemas.ts';
import { isReadToolName, readToolHistory, type ReadToolHistory } from './tool-history.ts';

export const ACCEPTED_ANSWER_STATE = 'acceptedAnswerV1';
export type AnswerSession = { binding: EvidenceBinding; snapshot: Snapshot; catalog: CatalogItem[];
  committedResult?: { status: 'applied' | 'rejected'; version: number } };
const invalid = (): never => { throw new Error('AGENT_ANSWER_EVIDENCE'); };

/** Rebuild private evidence from ordered, durable, server-owned native events.
 * No model/user-supplied Evidence JSON and no second mutable fact ledger. */
export function sessionEvidence(input: AnswerSession, events: readonly Event[]): AnswerEvidence[] {
  const evidence: AnswerEvidence[] = [requirementsEvidence(input.binding, input.snapshot)];
  let history: ReadToolHistory;
  try { history = readToolHistory(events); } catch { return invalid(); }
  for (const record of history.records) {
    const result = record.result;
    if (result && typeof result === 'object' && 'error' in result) continue;
    const item = toolEvidence(input.binding, input.snapshot, input.catalog, record);
    if (!result || typeof result !== 'object' || !('answerEvidenceRef' in result)
      || result.answerEvidenceRef !== item.id) return invalid();
    // Only the latest validation attempt can authorize a candidate, even when
    // its response is missing, failed, or completes before an earlier attempt.
    if (record.name === 'validate_changes' && record.id !== history.latestValidationCallId) continue;
    evidence.push(item);
  }
  return evidence;
}

/** Called only after FunctionTool ran, including its native confirmation gate. */
export function recordToolEvidence(input: AnswerSession, tool: { name: string }, args: Record<string, unknown>,
  context: Context, response: Record<string, unknown>): Record<string, unknown> | undefined {
  const id = context.functionCallId ?? invalid();
  if (isReadToolName(tool.name)) {
    if ('error' in response) return undefined;
    const item = toolEvidence(input.binding, input.snapshot, input.catalog, { id, name: tool.name, args, result: response });
    return { ...response, answerEvidenceRef: item.id };
  }
  if (tool.name !== 'propose_changes') return undefined;
  if (input.committedResult) {
    const applied = input.committedResult.status === 'applied';
    if (applied ? response.status !== 'applied' || response.version !== input.committedResult.version
      : response.error !== 'This tool call is rejected.') return invalid();
    const item = receiptEvidence(input.binding, id, input.committedResult);
    // The transaction already decided every receipt field. End through ADK's
    // native tool-result path, with no model acknowledgement or formatter call.
    context.state.set(ACCEPTED_ANSWER_STATE, compileAnswer({ version: '1', answer: { kind: 'receipt', evidenceRef: item.id } },
      { binding: input.binding, eventId: `receipt:${id}`, evidence: [item] }));
    context.actions.skipSummarization = true;
    // In ADK 2.1 confirmation resumes inside request preprocessing, where
    // skipSummarization alone does not stop the following model turn.
    // InvocationContext explicitly exposes this callback termination signal.
    context.invocationContext.endInvocation = true;
    return { ...response, ...input.committedResult, answerEvidenceRef: item.id };
  }
  // A model call alone is not a pending proposal. Native FunctionTool must
  // actually request confirmation, and the latest validation must match.
  const confirmations = context.actions.requestedToolConfirmations;
  if (!confirmations || !Object.hasOwn(confirmations, id) || !confirmations[id]) return invalid();
  const evidence = sessionEvidence(input, context.invocationContext.session.events);
  const latest = evidence.findLast(item => item.kind === 'validation');
  const ref = validatedProposalParametersSchema.parse(args);
  if (latest?.kind !== 'validation' || latest.validationId !== ref.validationId) return invalid();
  const proposal = proposalEvidence(latest, id);
  const answer = compileAnswer({ version: '1', answer: { kind: 'proposal', evidenceRef: proposal.id } },
    { binding: input.binding, eventId: `proposal:${id}`, evidence: [...evidence, proposal] });
  context.state.set(ACCEPTED_ANSWER_STATE, answer);
  return response;
}

/** The compiled immutable projection is committed in the same native event as
 * the validated final model response. Recovery reads this exact stateDelta;
 * it never re-renders old answers against a new catalog or compiler template. */
export function recordModelAnswer(input: AnswerSession, context: Context, response: LlmResponse): void {
  if (input.committedResult) return invalid(); // Receipts never depend on model output.
  const parts = response.content?.parts ?? [];
  const calls = parts.flatMap(part => part.functionCall ? [part.functionCall] : []);
  if (calls.some(call => call.name !== FINAL_RESPONSE_TOOL)) return;
  const plan = answerPlanSchema.parse(calls.length ? calls[0].args : JSON.parse(parts[0]?.text ?? 'null'));
  const evidence = sessionEvidence(input, context.invocationContext.session.events);
  context.state.set(ACCEPTED_ANSWER_STATE, compileAnswer(plan,
    { binding: input.binding, eventId: `final:${context.invocationId}`, evidence }));
}

export function savedAnswer(event: Event, runId: string): AcceptedAnswer | undefined {
  const raw = event.actions.stateDelta?.[ACCEPTED_ANSWER_STATE];
  if (raw === undefined) return undefined;
  const answer = acceptedAnswerSchema.parse(raw);
  if (answer.runId !== runId) return invalid();
  return answer;
}
