import { EventType } from '@ag-ui/core';
import { evaluationInput } from '../../evals/fixtures';
import { parseReplayBundle, type ReplayBundle } from '../../evals/replay-bundle';
import { compileAnswer } from '../../src/agent/answer-compiler';
import { proposalEvidence, receiptEvidence, toolEvidence } from '../../src/agent/answer-evidence';
import { ANSWER_EVENT_NAME, type AcceptedAnswer } from '../../src/domain/answer';
import { calculateBudget } from '../../src/domain/budget';
import { buildProposal } from '../../src/domain/proposal';

export const syntheticReplayScenarios = ['proposal', 'clarification'] as const;
export type SyntheticReplayScenario = typeof syntheticReplayScenarios[number];
export const syntheticReplayModel = 'synthetic-accepted-answer-v2-no-model';
const tripId = '00000000-0000-4000-8000-000000000001';
const runId = '00000000-0000-4000-8000-000000000002';
const proposalId = '00000000-0000-4000-8000-000000000003';

/** Fresh deterministic public fixtures, NOT captured model/quality evidence.
 * Pure domain/compiler calls only: no artifacts, environment, DB or provider.
 * The production replay validator checks every generated v2 checkpoint. */
export function createSyntheticReplayBundle(scenario: SyntheticReplayScenario): ReplayBundle {
  const input = evaluationInput(scenario === 'proposal' ? 'free-afternoon' : 'ambiguous');
  const initial = { id: tripId, version: 1, snapshot: input.before, budget: calculateBudget(input.before) };
  const binding = { ownerId: '00000000-0000-4000-8000-000000000004', tripId, runId, baseVersion: 1 };
  const draft = scenario === 'proposal'
    ? buildProposal(input.before, [{ kind: 'remove', entryId: 'transfer' }], input.catalog, 'agent') : undefined;
  let answer: AcceptedAnswer;
  if (draft) {
    const validation = toolEvidence(binding, input.before, input.catalog, { id: 'synthetic-validation', name: 'validate_changes',
      args: { changes: [{ kind: 'remove', entryId: 'transfer' }] }, result: { ...draft, validationId: proposalId } });
    if (validation.kind !== 'validation' || !draft.canApply) throw new Error('SYNTHETIC_REPLAY_VALIDATION_REQUIRED');
    const proposal = proposalEvidence(validation, 'synthetic-proposal');
    answer = compileAnswer({ version: '1', answer: { kind: 'proposal', evidenceRef: proposal.id } },
      { binding, eventId: 'synthetic-start', evidence: [validation, proposal] });
  } else {
    answer = compileAnswer({ version: '1', answer: { kind: 'clarify', fields: ['people'] } },
      { binding, eventId: 'synthetic-start', evidence: [] });
  }
  const startEvents = [
    { type: EventType.RUN_STARTED, threadId: tripId, runId: 'synthetic-start-request' },
    { type: EventType.CUSTOM, name: ANSWER_EVENT_NAME, value: answer },
    { type: EventType.RUN_FINISHED, threadId: tripId, runId: 'synthetic-start-request' },
  ];
  const receipt = receiptEvidence(binding, 'synthetic-receipt', { status: 'applied', version: 2 });
  const resumeEvents = draft ? [
    { type: EventType.RUN_STARTED, threadId: tripId, runId: 'synthetic-resume-request' },
    { type: EventType.CUSTOM, name: ANSWER_EVENT_NAME,
      value: compileAnswer({ version: '1', answer: { kind: 'receipt', evidenceRef: receipt.id } },
        { binding, eventId: 'synthetic-resume', evidence: [receipt] }) },
    { type: EventType.RUN_FINISHED, threadId: tripId, runId: 'synthetic-resume-request' },
  ] : [];
  const run = { id: runId, tripId, requestId: 'synthetic-start-request', baseVersion: 1, message: input.prompt,
    answerContractVersion: 1, status: draft ? 'awaiting_confirmation' : 'succeeded',
    proposalId: draft ? proposalId : null, interruptId: draft ? 'synthetic-interrupt' : null, decision: null,
    events: startEvents.map((event, sequence) => ({ sequence, event })),
    ...(draft ? { proposal: { draft, base: initial } } : {}),
  };
  return parseReplayBundle({ schemaVersion: 2, caseId: input.caseId, inputDigest: input.digest, model: syntheticReplayModel,
    decisionReceipt: draft ? { runId, status: 'applied', version: 2 } : null,
    prompt: input.prompt, catalog: input.catalog, startEvents, resumeEvents,
    initial: { trip: initial, runs: { runs: [] } },
    afterStart: { trip: initial, runs: { runs: [run] } },
    final: { trip: draft ? { ...initial, version: 2, snapshot: draft.next, budget: draft.budget } : initial,
      runs: { runs: [{ ...run, status: 'succeeded', decision: draft ? true : null,
        events: [...startEvents, ...resumeEvents].map((event, sequence) => ({ sequence, event })) }] } },
  });
}
