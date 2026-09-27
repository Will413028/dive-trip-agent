import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { EventType, type BaseEvent } from '@ag-ui/core';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { compileAnswer, compileFailure } from '../agent/answer-compiler';
import { evidenceIdentity, proposalEvidence, receiptEvidence, type ValidationEvidence } from '../agent/answer-evidence';
import { ANSWER_EVENT_NAME, type AcceptedAnswer } from '../domain/answer';
import { DomainError } from '../domain/errors';
import { parseSnapshot } from '../domain/snapshot';
import type { ProposalDraft } from '../domain/types';
import { parseStoredRunEvent, runErrorEvent } from './answer-events';
import { database, transaction } from './db';
import { readAgentDecisionReceipt } from './version-store';

export type RunStatus = 'running' | 'awaiting_confirmation' | 'succeeded' | 'failed' | 'interrupted';
export type RunEvent = { sequence: number; event: BaseEvent };
export type AgentRun = {
  id: string; tripId: string; requestId: string; baseVersion: number; message: string;
  status: RunStatus; events: RunEvent[]; proposalId: string | null; interruptId: string | null;
  decision: boolean | null;
  answerContractVersion: number;
};
export type FinishRunInput = {
  status: Exclude<RunStatus, 'running'>;
  proposalId?: string | null;
  interruptId?: string | null;
  event?: BaseEvent;
};

type Row = {
  id: string; trip_id: string; request_id: string; base_version: number; message: string; status: RunStatus;
  proposal_id: string | null; interrupt_id: string | null; decision: boolean | null; payload_hash: string;
  answer_contract_version: number;
  proposal_tool_call_id: string | null;
};
const textId = z.string().min(1).max(128).refine(s => s.trim().length > 0 && !s.includes('\0'));
const startSchema = z.object({ requestId: textId,
  message: z.string().min(1).max(4000).refine(s => s.trim().length > 0 && !s.includes('\0')),
  baseVersion: z.number().int().positive().max(2147483647),
});
const finishSchema = z.strictObject({
  status: z.enum(['awaiting_confirmation', 'succeeded', 'failed', 'interrupted']),
  proposalId: z.uuid().nullable().optional(), interruptId: textId.nullable().optional(),
  event: z.unknown().optional(),
});
const validIds = (...ids: string[]) => ids.every(id => z.uuid().safeParse(id).success);
function fail(code: string): never { throw new DomainError(code); }
function requireContract(row: Row): void {
  if (row.answer_contract_version !== 1) fail('RUN_STATE_CONFLICT');
}
async function requireWritableSchema(client: PoolClient): Promise<void> {
  const scope = (await client.query<{ name: string }>('SELECT current_schema() AS name')).rows[0]?.name;
  if (scope === 'workbench_live') fail('AGENT_POLICY_DISABLED');
}

async function recoverFailures(client: PoolClient, owner: string, tripId: string): Promise<void> {
  await client.query(`UPDATE agent_runs SET status='interrupted',lease_expires_at=NULL
    WHERE trip_id=$1 AND answer_contract_version=1 AND status='running' AND lease_expires_at<=clock_timestamp()`, [tripId]);
  const rows = await client.query<Row>(`SELECT * FROM agent_runs WHERE trip_id=$1 AND answer_contract_version=1
    AND status IN ('failed','interrupted') ORDER BY created_at,id`, [tripId]);
  for (const row of rows.rows) {
    await persistFailure(client, owner, row);
    const last = (await client.query<{ event: unknown }>(
      'SELECT event FROM agent_run_events WHERE run_id=$1 ORDER BY sequence DESC LIMIT 1', [row.id])).rows[0];
    const event = last && parseStoredRunEvent(last.event, row.id);
    if (event?.type !== EventType.RUN_ERROR && !(event?.type === EventType.RUN_FINISHED && event.outcome?.type === 'cancelled')) {
      await insertEvent(client, row.id, runErrorEvent('AGENT_WORKER_INTERRUPTED'), true);
    }
  }
}

// Match version-store's session -> trip lock order. All per-trip operations,
// including reads, serialize against writers and recheck TTL after waiting.
export async function withRunScope<T>(owner: string, tripId: string,
  work: (client: PoolClient, version: number) => Promise<T>, externalClient?: PoolClient): Promise<T> {
  if (!validIds(owner, tripId)) fail('NOT_FOUND');
  const operation = async (client: PoolClient) => {
    const session = await client.query('SELECT id FROM sessions WHERE id=$1 FOR SHARE', [owner]);
    if (!session.rowCount) fail('NOT_FOUND');
    const trip = await client.query<{ current_version: number; schema_name: string }>(
      'SELECT current_version,current_schema() AS schema_name FROM trips WHERE id=$1 AND owner_id=$2 FOR UPDATE', [tripId, owner]);
    if (!trip.rowCount) fail('NOT_FOUND');
    const live = await client.query(`SELECT t.id FROM trips t JOIN sessions s ON s.id=t.owner_id
      WHERE t.id=$1 AND t.expires_at>clock_timestamp() AND s.expires_at>clock_timestamp()`, [tripId]);
    if (!live.rowCount) fail('NOT_FOUND');
    const readOnly = trip.rows[0].schema_name === 'workbench_live';
    if (!readOnly) await recoverFailures(client, owner, tripId);
    // A rejected late writer must still commit the lease expiry above, but no
    // partially completed operation. Other errors roll back the transaction.
    await client.query('SAVEPOINT run_operation');
    try { return await work(client, trip.rows[0].current_version); }
    catch (error) {
      if (!(error instanceof DomainError)) throw error;
      await client.query('ROLLBACK TO SAVEPOINT run_operation');
      if (!readOnly) await recoverFailures(client, owner, tripId);
      return error;
    }
  };
  const result = externalClient ? await operation(externalClient) : await transaction(database(), operation);
  if (result instanceof DomainError) throw result;
  return result;
}
const scoped = withRunScope;

async function find(client: PoolClient, tripId: string, id: string): Promise<Row> {
  const row = (await client.query<Row>('SELECT * FROM agent_runs WHERE trip_id=$1 AND id=$2', [tripId, id])).rows[0];
  if (!row) fail('NOT_FOUND');
  return row;
}
async function view(client: PoolClient, row: Row): Promise<AgentRun> {
  // Old rows are audit-only. Do not parse or return their raw public history,
  // nor manufacture a new accepted answer for a historical success.
  const events = row.answer_contract_version === 1 ? (await client.query<{ sequence: number; event: unknown }>(
    'SELECT sequence,event FROM agent_run_events WHERE run_id=$1 ORDER BY sequence', [row.id])).rows : [];
  return { id: row.id, tripId: row.trip_id, requestId: row.request_id, baseVersion: row.base_version, message: row.message,
    status: row.status, proposalId: row.proposal_id, interruptId: row.interrupt_id, decision: row.decision,
    answerContractVersion: row.answer_contract_version ?? 0,
    events: events.map(e => ({ sequence: e.sequence, event: parseStoredRunEvent(e.event, row.id) })) };
}

export async function startRun(owner: string, tripId: string, requestId: string,
  message: string, baseVersion: number, externalClient?: PoolClient, allocatedId?: string): Promise<{ run: AgentRun; created: boolean }> {
  if (allocatedId !== undefined && !validIds(allocatedId)) fail('INVALID_RUN');
  if (!startSchema.safeParse({ requestId, message, baseVersion }).success) fail('INVALID_RUN');
  const hash = createHash('sha256').update(JSON.stringify([tripId, message, baseVersion])).digest('hex');
  return scoped(owner, tripId, async (client, version) => {
    await requireWritableSchema(client);
    const previous = (await client.query<Row>('SELECT * FROM agent_runs WHERE trip_id=$1 AND request_id=$2', [tripId, requestId])).rows[0];
    if (previous) {
      requireContract(previous);
      if (previous.payload_hash !== hash) fail('IDEMPOTENCY_CONFLICT');
      return { run: await view(client, previous), created: false };
    }
    if (version !== baseVersion) fail('STALE_VERSION');
    const active = await client.query("SELECT id FROM agent_runs WHERE trip_id=$1 AND status IN ('running','awaiting_confirmation')", [tripId]);
    if (active.rowCount) fail('RUN_ACTIVE');
    const row = (await client.query<Row>(`INSERT INTO agent_runs
      (id,trip_id,request_id,payload_hash,base_version,message,status,lease_expires_at,answer_contract_version)
      VALUES ($1,$2,$3,$4,$5,$6,'running',clock_timestamp()+interval '60 seconds',1) RETURNING *`,
    [allocatedId ?? randomUUID(), tripId, requestId, hash, baseVersion, message])).rows[0];
    return { run: await view(client, row), created: true };
  }, externalClient);
}

export async function getRun(owner: string, tripId: string, runId: string): Promise<AgentRun | null> {
  if (!validIds(owner, tripId, runId)) return null;
  try { return await scoped(owner, tripId, async client => view(client, await find(client, tripId, runId))); }
  catch (error) { if (error instanceof DomainError && error.code === 'NOT_FOUND') return null; throw error; }
}
export async function listRuns(owner: string, tripId: string): Promise<AgentRun[]> {
  if (!validIds(owner, tripId)) return [];
  try {
    return await scoped(owner, tripId, async client => {
      const rows = await client.query<Row>('SELECT * FROM agent_runs WHERE trip_id=$1 ORDER BY created_at,id', [tripId]);
      return Promise.all(rows.rows.map(row => view(client, row)));
    });
  } catch (error) { if (error instanceof DomainError && error.code === 'NOT_FOUND') return []; throw error; }
}

export async function appendRunEvent(owner: string, tripId: string, runId: string, event: BaseEvent): Promise<RunEvent> {
  if (!validIds(runId)) fail('NOT_FOUND');
  const parsed = parseStoredRunEvent(event, runId);
  if (parsed.type === EventType.RUN_FINISHED || parsed.type === EventType.RUN_ERROR) fail('INVALID_RUN_EVENT');
  if (parsed.type === EventType.RUN_STARTED && parsed.threadId !== tripId) fail('INVALID_RUN_EVENT');
  return scoped(owner, tripId, async client => {
    await requireWritableSchema(client);
    const row = await find(client, tripId, runId);
    requireContract(row);
    if (row.status !== 'running') fail('RUN_NOT_RUNNING');
    if (parsed.type === EventType.CUSTOM) {
      const body = parsed.value.body;
      if (body.kind === 'proposal') await requireProposalAnswer(client, owner, row, parsed.value);
      const committed = await readAgentDecisionReceipt(client, owner, tripId, runId);
      if (body.kind === 'receipt' && !isDeepStrictEqual(committed, { status: body.status, version: body.version })) fail('INVALID_RUN_EVENT');
      if (body.kind === 'failure' && !isDeepStrictEqual(committed, body.committed)) fail('INVALID_RUN_EVENT');
      if (committed && body.kind !== 'receipt' && body.kind !== 'failure') fail('INVALID_RUN_EVENT');
    }
    return insertEvent(client, runId, parsed);
  });
}

async function insertEvent(client: PoolClient, runId: string, raw: BaseEvent, recovery = false): Promise<RunEvent> {
  const event = parseStoredRunEvent(raw, runId);
  const writable = await client.query(`SELECT id FROM agent_runs WHERE id=$1 AND answer_contract_version=1
    AND ((status='running' AND lease_expires_at>clock_timestamp()) OR ($2 AND status IN ('failed','interrupted')))`, [runId, recovery]);
  if (!writable.rowCount) fail('RUN_NOT_RUNNING');
  if (event.type === EventType.CUSTOM) {
    const previous = (await client.query<{ sequence: number; event: unknown }>(`SELECT sequence,event FROM agent_run_events
      WHERE run_id=$1 AND event->>'type'='CUSTOM' AND event->>'name'=$2 AND event->'value'->>'answerId'=$3`,
    [runId, ANSWER_EVENT_NAME, event.value.answerId])).rows[0];
    if (previous) {
      const saved = parseStoredRunEvent(previous.event, runId);
      if (saved.type !== EventType.CUSTOM || !isDeepStrictEqual(saved.value, event.value)) fail('IDEMPOTENCY_CONFLICT');
      return { sequence: previous.sequence, event: saved };
    }
  }
  const stored = await client.query<{ sequence: number }>(`INSERT INTO agent_run_events(run_id,sequence,event)
    SELECT r.id,(SELECT COALESCE(MAX(sequence),0)+1 FROM agent_run_events WHERE run_id=r.id),$2::jsonb
    FROM agent_runs r WHERE r.id=$1 AND r.answer_contract_version=1
      AND ((r.status='running' AND r.lease_expires_at>clock_timestamp()) OR ($3 AND r.status IN ('failed','interrupted')))
    RETURNING sequence`, [runId, JSON.stringify(event), recovery]);
  if (!stored.rowCount) fail('RUN_NOT_RUNNING');
  return { sequence: stored.rows[0].sequence, event };
}

async function persistFailure(client: PoolClient, owner: string, row: Row): Promise<void> {
  const previous = (await client.query<{ event: unknown }>(`SELECT event FROM agent_run_events WHERE run_id=$1
    AND event->>'type'='CUSTOM' AND event->>'name'=$2 AND event->'value'->'body'->>'kind'='failure'`, [row.id, ANSWER_EVENT_NAME])).rows[0];
  // Frozen projections survive template/compiler changes: do not recompile.
  if (previous) { parseStoredRunEvent(previous.event, row.id); return; }
  const binding = { ownerId: owner, tripId: row.trip_id, runId: row.id, baseVersion: row.base_version };
  const committed = await readAgentDecisionReceipt(client, owner, row.trip_id, row.id);
  const evidence = committed ? [receiptEvidence(binding, `decision:${row.id}`, committed)] : [];
  const answer = compileFailure({ binding, eventId: 'server:terminal-failure', evidence });
  await insertEvent(client, row.id, { type: EventType.CUSTOM, name: ANSWER_EVENT_NAME, value: answer }, true);
}

export async function bindProposal(owner: string, tripId: string, runId: string,
  proposalId: string, interruptId: string, toolCallId: string): Promise<AgentRun> {
  if (!validIds(runId, proposalId)) fail('NOT_FOUND');
  if (!textId.safeParse(interruptId).success || !textId.safeParse(toolCallId).success) fail('INVALID_RUN');
  return scoped(owner, tripId, async client => {
    await requireWritableSchema(client);
    const row = await find(client, tripId, runId);
    requireContract(row);
    if (row.status !== 'running') fail('RUN_NOT_RUNNING');
    if (row.decision !== null || (row.proposal_id !== null && row.proposal_id !== proposalId)
      || (row.interrupt_id !== null && row.interrupt_id !== interruptId)
      || (row.proposal_tool_call_id !== null && row.proposal_tool_call_id !== toolCallId)) fail('RUN_STATE_CONFLICT');
    const proposal = await client.query('SELECT id FROM proposals WHERE id=$1 AND trip_id=$2 AND base_version=$3',
      [proposalId, tripId, row.base_version]);
    if (!proposal.rowCount) fail('NOT_FOUND');
    const updated = (await client.query<Row>(`UPDATE agent_runs SET proposal_id=$2,interrupt_id=$3,proposal_tool_call_id=$4
      WHERE id=$1 AND status='running' AND lease_expires_at>clock_timestamp() RETURNING *`,
      [runId, proposalId, interruptId, toolCallId])).rows[0];
    if (!updated) fail('RUN_NOT_RUNNING');
    return view(client, updated);
  });
}

async function requirePhaseAnswer(client: PoolClient, owner: string, row: Row,
  status: 'succeeded' | 'awaiting_confirmation'): Promise<void> {
  const started = (await client.query<{ sequence: number; event: unknown }>(`SELECT sequence,event FROM agent_run_events
    WHERE run_id=$1 AND event->>'type'='RUN_STARTED' ORDER BY sequence DESC LIMIT 1`, [row.id])).rows[0];
  if (!started) fail('INVALID_RUN_EVENT');
  const begin = parseStoredRunEvent(started.event, row.id);
  if (begin.type !== EventType.RUN_STARTED || begin.threadId !== row.trip_id) fail('INVALID_RUN_EVENT');
  const projections = (await client.query<{ event: unknown }>(`SELECT event FROM agent_run_events
    WHERE run_id=$1 AND sequence>$2 AND event->>'type'='CUSTOM' ORDER BY sequence`, [row.id, started.sequence])).rows;
  // A phase has one accepted terminal projection. An earlier phase, progress,
  // or a subsequent attempt to replace a failure is not completion evidence.
  if (projections.length !== 1) fail('INVALID_RUN_EVENT');
  const event = parseStoredRunEvent(projections[0].event, row.id);
  if (event.type !== EventType.CUSTOM) fail('INVALID_RUN_EVENT');
  const answer = event.value;
  if (status === 'succeeded') {
    if (answer.body.kind === 'failure' || answer.body.kind === 'proposal') fail('INVALID_RUN_EVENT');
    const receipt = await readAgentDecisionReceipt(client, owner, row.trip_id, row.id);
    if (row.proposal_id !== null || row.decision !== null || answer.body.kind === 'receipt') {
      if (!receipt || answer.body.kind !== 'receipt'
        || !isDeepStrictEqual(receipt, { status: answer.body.status, version: answer.body.version })) fail('INVALID_RUN_EVENT');
    }
    return;
  }
  await requireProposalAnswer(client, owner, row, answer);
}

async function requireProposalAnswer(client: PoolClient, owner: string, row: Row, answer: AcceptedAnswer): Promise<void> {
  if (answer.body.kind !== 'proposal' || row.proposal_id === null || row.interrupt_id === null
    || row.proposal_tool_call_id === null || row.decision !== null) fail('INVALID_RUN_EVENT');
  const proposal = (await client.query<{ draft: ProposalDraft; snapshot: unknown }>(`SELECT p.draft,v.snapshot
    FROM proposals p JOIN trip_versions v ON v.trip_id=p.trip_id AND v.version=p.base_version
    WHERE p.id=$1 AND p.trip_id=$2 AND p.base_version=$3 AND p.status='pending'`,
  [row.proposal_id, row.trip_id, row.base_version])).rows[0];
  if (!proposal || !proposal.draft.canApply) fail('INVALID_RUN_EVENT');
  const binding = { ownerId: owner, tripId: row.trip_id, runId: row.id, baseVersion: row.base_version };
  // Verify before first publication and before the phase transition against
  // the frozen product proposal. Reads and idempotent finishes never recompile.
  const validation: ValidationEvidence = { binding, originId: row.proposal_id,
    id: evidenceIdentity(binding, 'validation', row.proposal_id), kind: 'validation', scope: 'candidate',
    base: parseSnapshot(proposal.snapshot), draft: proposal.draft, validationId: row.proposal_id };
  const evidence = proposalEvidence(validation, row.proposal_tool_call_id);
  const expected = compileAnswer({ version: '1', answer: { kind: 'proposal', evidenceRef: evidence.id } }, {
    binding, eventId: 'server:proposal-check', evidence: [validation, evidence],
  });
  if (!isDeepStrictEqual(answer.body, expected.body) || !isDeepStrictEqual(answer.evidenceRefs, expected.evidenceRefs)) fail('INVALID_RUN_EVENT');
}

export async function finishRun(owner: string, tripId: string, runId: string, input: FinishRunInput): Promise<AgentRun> {
  if (!validIds(runId)) fail('NOT_FOUND');
  const validation = finishSchema.safeParse(input);
  if (!validation.success) fail('INVALID_RUN');
  const finish = validation.data;
  const event = finish.event === undefined
    ? (finish.status === 'failed' || finish.status === 'interrupted' ? runErrorEvent() : undefined)
    : parseStoredRunEvent(finish.event, runId);
  return scoped(owner, tripId, async client => {
    await requireWritableSchema(client);
    const row = await find(client, tripId, runId);
    requireContract(row);
    const proposalId = finish.proposalId === undefined ? row.proposal_id : finish.proposalId;
    const interruptId = finish.interruptId === undefined ? row.interrupt_id : finish.interruptId;
    if (event) {
      if (event.type === EventType.RUN_FINISHED) {
        const latest = (await client.query<{ event: unknown }>(`SELECT event FROM agent_run_events
          WHERE run_id=$1 AND event->>'type'='RUN_STARTED' ORDER BY sequence DESC LIMIT 1`, [runId])).rows[0];
        const started = latest ? parseStoredRunEvent(latest.event, runId) : null;
        if (started?.type !== EventType.RUN_STARTED || started.threadId !== tripId
          || event.threadId !== tripId || event.runId !== started.runId) fail('INVALID_RUN_EVENT');
        const outcome = event.outcome;
        if (finish.status === 'awaiting_confirmation') {
          if (outcome?.type !== 'interrupt' || outcome.interrupts.length !== 1
            || outcome.interrupts[0].id !== interruptId) fail('INVALID_RUN_EVENT');
        } else if (finish.status === 'succeeded') {
          if (outcome && outcome.type !== 'success') fail('INVALID_RUN_EVENT');
        } else if (finish.status !== 'interrupted' || outcome?.type !== 'cancelled') fail('INVALID_RUN_EVENT');
      } else if (event.type !== EventType.RUN_ERROR || !['failed', 'interrupted'].includes(finish.status)) fail('INVALID_RUN_EVENT');
    }
    if (row.status !== 'running') {
      if (row.status === finish.status && proposalId === row.proposal_id && interruptId === row.interrupt_id) {
        const saved = await view(client, row);
        if (event && !isDeepStrictEqual(saved.events.at(-1)?.event, event)) fail('RUN_STATE_CONFLICT');
        return saved;
      }
      fail('RUN_STATE_CONFLICT');
    }
    if (row.interrupt_id !== null && interruptId !== row.interrupt_id) fail('RUN_STATE_CONFLICT');
    if (row.proposal_id !== null && proposalId !== row.proposal_id) fail('RUN_STATE_CONFLICT');
    if (finish.status === 'awaiting_confirmation' && (interruptId === null || row.decision !== null)) fail('RUN_STATE_CONFLICT');
    if (proposalId !== null) {
      const proposal = await client.query('SELECT id FROM proposals WHERE id=$1 AND trip_id=$2 AND base_version=$3', [proposalId, tripId, row.base_version]);
      if (!proposal.rowCount) fail('NOT_FOUND');
    }
    if (finish.status === 'succeeded' || finish.status === 'awaiting_confirmation') await requirePhaseAnswer(client, owner, row, finish.status);
    if (finish.status === 'failed' || finish.status === 'interrupted') await persistFailure(client, owner, row);
    if (event) await insertEvent(client, runId, event);
    const updated = (await client.query<Row>(`UPDATE agent_runs SET status=$2,proposal_id=$3,interrupt_id=$4,lease_expires_at=NULL
      WHERE id=$1 AND status='running' AND lease_expires_at>clock_timestamp() RETURNING *`, [runId, finish.status, proposalId, interruptId])).rows[0];
    if (!updated) fail('RUN_NOT_RUNNING');
    return view(client, updated);
  });
}

// One human gate per run. Only claimed=true authorizes the caller to run ADK.
// A crashed claimant expires to interrupted; retries never reclaim execution.
export async function claimResume(owner: string, tripId: string, runId: string,
  interruptId: string, confirmed: boolean, externalClient?: PoolClient): Promise<{ run: AgentRun; claimed: boolean }> {
  if (!validIds(runId)) fail('NOT_FOUND');
  if (!textId.safeParse(interruptId).success || typeof confirmed !== 'boolean') fail('INVALID_RUN');
  return scoped(owner, tripId, async client => {
    await requireWritableSchema(client);
    const row = await find(client, tripId, runId);
    requireContract(row);
    if (row.interrupt_id !== interruptId) fail('RUN_STATE_CONFLICT');
    if (row.decision !== null) {
      if (row.decision !== confirmed) fail('IDEMPOTENCY_CONFLICT');
      return { run: await view(client, row), claimed: false };
    }
    if (row.status !== 'awaiting_confirmation') fail('RUN_STATE_CONFLICT');
    const updated = (await client.query<Row>(`UPDATE agent_runs SET status='running',decision=$2,
      lease_expires_at=clock_timestamp()+interval '60 seconds' WHERE id=$1 RETURNING *`, [runId, confirmed])).rows[0];
    return { run: await view(client, updated), claimed: true };
  }, externalClient);
}
