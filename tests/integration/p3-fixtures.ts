import { randomUUID } from 'node:crypto';
import { EventType } from '@ag-ui/core';
import { compileAnswer } from '../../src/agent/answer-compiler';
import { proposalEvidence, receiptEvidence, toolEvidence } from '../../src/agent/answer-evidence';
import { ANSWER_EVENT_NAME } from '../../src/domain/answer';
import { buildProposal } from '../../src/domain/proposal';
import { parseSnapshot } from '../../src/domain/snapshot';
import type { CatalogItem, ProposalDraft } from '../../src/domain/types';
import { database } from '../../src/server/db';
import { appendRunEvent, bindProposal, finishRun, getRun } from '../../src/server/run-store';
import { getTrip } from '../../src/server/trip-store';
import { applyProposal, rejectProposal, saveProposal } from '../../src/server/version-store';

// Real contract fixtures for lower-level store/admission tests. These create
// valid evidence through the normal tool/compiler APIs; no SQL terminal bypass.
export async function startAnswerPhase(owner: string, tripId: string, runId: string) {
  return appendRunEvent(owner, tripId, runId, { type: EventType.RUN_STARTED, threadId: tripId, runId: randomUUID() });
}
export async function recordSimpleAnswer(owner: string, tripId: string, runId: string) {
  const run = (await getRun(owner, tripId, runId))!;
  const value = compileAnswer({ version: '1', answer: { kind: 'clarify', fields: ['dates'] } }, {
    binding: { ownerId: owner, tripId, runId, baseVersion: run.baseVersion }, eventId: randomUUID(), evidence: [],
  });
  return appendRunEvent(owner, tripId, runId, { type: EventType.CUSTOM, name: ANSWER_EVENT_NAME, value });
}
export async function proposalAnswer(owner: string, tripId: string, runId: string, proposalId: string,
  toolCallId = 'proposal-call') {
  const row = (await database().query<{ base_version: number; snapshot: unknown; draft: ProposalDraft; catalog_snapshot: CatalogItem[] }>(`
    SELECT p.base_version,p.draft,p.catalog_snapshot,v.snapshot FROM proposals p JOIN trip_versions v
      ON v.trip_id=p.trip_id AND v.version=p.base_version WHERE p.id=$1 AND p.trip_id=$2`, [proposalId, tripId])).rows[0];
  const snapshot = parseSnapshot(row.snapshot);
  const catalog = [...new Map([...snapshot.entries.map(entry => entry.item), ...row.draft.next.entries.map(entry => entry.item),
    ...row.catalog_snapshot].map(item => [item.id, item])).values()];
  const binding = { ownerId: owner, tripId, runId, baseVersion: row.base_version };
  const validation = toolEvidence(binding, snapshot, catalog, { id: `validation:${proposalId}`, name: 'validate_changes',
    args: { changes: row.draft.changes }, result: { canApply: row.draft.canApply, validationId: proposalId,
      budget: row.draft.budget, issues: row.draft.issues } });
  if (validation.kind !== 'validation') throw new Error('TEST_VALIDATION_REQUIRED');
  const proposal = proposalEvidence(validation, toolCallId);
  const value = compileAnswer({ version: '1', answer: { kind: 'proposal', evidenceRef: proposal.id } }, {
    binding, eventId: `proposal:${toolCallId}`, evidence: [validation, proposal],
  });
  return { type: EventType.CUSTOM, name: ANSWER_EVENT_NAME, value };
}
export async function recordProposalAnswer(owner: string, tripId: string, runId: string, proposalId: string,
  toolCallId = 'proposal-call') {
  return appendRunEvent(owner, tripId, runId, await proposalAnswer(owner, tripId, runId, proposalId, toolCallId));
}
export async function awaitConfirmation(owner: string, tripId: string, runId: string,
  existingProposalId?: string, interruptId = 'gate') {
  const trip = (await getTrip(owner, tripId))!;
  const items = trip.snapshot.entries.map(entry => entry.item);
  const proposalId = existingProposalId ?? await saveProposal(owner, tripId, trip.version,
    buildProposal(trip.snapshot, [{ kind: 'remove', entryId: 'transfer' }], items, 'agent'), items);
  const started = await startAnswerPhase(owner, tripId, runId);
  await bindProposal(owner, tripId, runId, proposalId, interruptId, 'proposal-call');
  await recordProposalAnswer(owner, tripId, runId, proposalId);
  return finishRun(owner, tripId, runId, { status: 'awaiting_confirmation', event: {
    type: EventType.RUN_FINISHED, threadId: tripId, runId: started.event.runId,
    outcome: { type: 'interrupt', interrupts: [{ id: interruptId, reason: 'approval' }] },
  } });
}
export async function recordDecisionAnswer(owner: string, tripId: string, runId: string) {
  const run = (await getRun(owner, tripId, runId))!;
  if (!run.proposalId || run.decision === null) throw new Error('TEST_DECISION_REQUIRED');
  const result = run.decision ? { status: 'applied' as const, version: (await applyProposal(owner, {
    tripId, proposalId: run.proposalId, baseVersion: run.baseVersion, requestId: `agent:${runId}`,
  }, runId)).version } : await rejectProposal(owner, tripId, run.proposalId, runId);
  if (!result) throw new Error('TEST_RECEIPT_REQUIRED');
  const binding = { ownerId: owner, tripId, runId, baseVersion: run.baseVersion };
  const receipt = receiptEvidence(binding, 'proposal-call', result);
  const value = compileAnswer({ version: '1', answer: { kind: 'receipt', evidenceRef: receipt.id } }, {
    binding, eventId: randomUUID(), evidence: [receipt],
  });
  return appendRunEvent(owner, tripId, runId, { type: EventType.CUSTOM, name: ANSWER_EVENT_NAME, value });
}
