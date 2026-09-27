import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { loadCatalog } from '../catalog/catalog';
import { calculateBudget } from '../domain/budget';
import { DomainError } from '../domain/errors';
import { buildProposal } from '../domain/proposal';
import { parseSnapshot, parseSnapshotStructure } from '../domain/snapshot';
import type { CatalogItem, ProposalDraft, Snapshot, TripView } from '../domain/types';
import { database, transaction } from './db';

export type ApplyInput = { tripId: string; proposalId: string; requestId: string; baseVersion: number };
export type RestoreInput = { tripId: string; targetVersion: number; baseVersion: number; requestId: string };
export type AgentDecisionReceipt = { status: 'applied' | 'rejected'; version: number };

const version = z.number().int().positive().max(2147483647);
const requestId = z.string().min(1).max(128).refine(value => value.trim().length > 0);
const common = { tripId: z.uuid(), baseVersion: version, requestId };
const applySchema = z.strictObject({ ...common, proposalId: z.uuid() });
const restoreSchema = z.strictObject({ ...common, targetVersion: version });

function invalid(): never { throw new DomainError('INVALID_PROPOSAL'); }
function validIds(...ids: string[]): void {
  if (!ids.every(id => z.uuid().safeParse(id).success)) throw new DomainError('NOT_FOUND');
}

async function lockTrip(client: PoolClient, owner: string, tripId: string): Promise<TripView> {
  const result = await client.query<{ current_version: number; schema_name: string }>(`
    SELECT t.current_version,current_schema() AS schema_name FROM trips t
    JOIN sessions s ON s.id=t.owner_id
    WHERE t.id=$1 AND t.owner_id=$2 AND t.expires_at>clock_timestamp() AND s.expires_at>clock_timestamp()
    FOR UPDATE OF t
  `, [tripId, owner]);
  const row = result.rows[0];
  if (!row) throw new DomainError('NOT_FOUND');
  if (row.schema_name === 'workbench_live') throw new DomainError('AGENT_POLICY_DISABLED');
  // Do not join versions in the locking statement: after waiting for a writer,
  // the new version may not be visible to that statement's earlier snapshot.
  // Expiry may pass during a lock-only wait without triggering EvalPlanQual.
  // Recheck both TTLs in a new statement after acquiring the lock, including
  // receipt replay (which must not resurrect an expired trip).
  const current = await client.query<{ snapshot: unknown }>(`
    SELECT v.snapshot FROM trip_versions v
    JOIN trips t ON t.id=v.trip_id
    JOIN sessions s ON s.id=t.owner_id
    WHERE t.id=$1 AND v.version=$2 AND t.expires_at>clock_timestamp() AND s.expires_at>clock_timestamp()
  `, [tripId, row.current_version]);
  if (!current.rowCount) throw new DomainError('NOT_FOUND');
  const snapshot = parseSnapshot(current.rows[0].snapshot);
  return { id: tripId, version: row.current_version, snapshot, budget: calculateBudget(snapshot) };
}

function validateDraft(base: Snapshot, input: ProposalDraft, suppliedCatalog: CatalogItem[]): ProposalDraft {
  try {
    const next = parseSnapshotStructure(input.next);
    // Caller is a trusted server adapter which built the draft from catalog.
    // HTTP must not accept next/item/actor from a request. Rebuild all rules and
    // totals here; the persisted canApply flag is not authorization.
    const catalog = [...new Map([
      ...[...base.entries, ...next.entries].map(e => e.item), ...loadCatalog(suppliedCatalog),
    ].map(item => [item.id, item])).values()];
    const rebuilt = buildProposal(base, input.changes, catalog, 'user');
    if (!isDeepStrictEqual(rebuilt, input)) invalid();
    return rebuilt;
  } catch { return invalid(); }
}

function requireBase(trip: TripView, base: number): void {
  if (trip.version !== base) throw new DomainError('STALE_VERSION');
}

export async function saveProposal(owner: string, tripId: string, baseVersion: number, input: ProposalDraft, suppliedCatalog: CatalogItem[] = []): Promise<string> {
  validIds(owner, tripId);
  if (!version.safeParse(baseVersion).success) invalid();
  return transaction(database(), async client => {
    const trip = await lockTrip(client, owner, tripId);
    requireBase(trip, baseVersion);
    const draft = validateDraft(trip.snapshot, input, suppliedCatalog);
    const id = randomUUID();
    await client.query('INSERT INTO proposals (id,trip_id,base_version,draft,catalog_snapshot) VALUES ($1,$2,$3,$4::jsonb,$5::jsonb)', [id, tripId, baseVersion, JSON.stringify(draft), JSON.stringify(suppliedCatalog)]);
    return id;
  });
}

function receiptView(raw: unknown, tripId: string): TripView {
  const parsed = z.strictObject({ id: z.uuid(), version, snapshot: z.unknown(), budget: z.unknown() }).parse(raw);
  const snapshot = parseSnapshot(parsed.snapshot);
  const budget = calculateBudget(snapshot);
  if (parsed.id !== tripId || !isDeepStrictEqual(parsed.budget, budget)) invalid();
  return { id: parsed.id, version: parsed.version, snapshot, budget };
}

async function mutate(owner: string, operation: 'apply' | 'restore', input: ApplyInput | RestoreInput,
  work: (client: PoolClient, trip: TripView) => Promise<Snapshot>, agentRunId?: string): Promise<TripView> {
  validIds(owner);
  // Fixed tuple is canonical regardless of incoming property order.
  const hash = createHash('sha256').update(JSON.stringify([
    operation, input.tripId, input.baseVersion, 'proposalId' in input ? input.proposalId : input.targetVersion,
  ])).digest('hex');
  return transaction(database(), async client => {
    const session = await client.query('SELECT id FROM sessions WHERE id=$1 AND expires_at>clock_timestamp() FOR SHARE', [owner]);
    if (!session.rowCount) throw new DomainError('NOT_FOUND');
    // Unique claim waits for a concurrent same-ID transaction. A crash or any
    // later failure rolls back the claim along with the version and pointer.
    await client.query(`INSERT INTO mutation_receipts(owner_id,request_id,operation,payload_hash)
      VALUES ($1,$2,$3,$4) ON CONFLICT (owner_id,request_id) DO NOTHING`, [owner, input.requestId, operation, hash]);
    const receipt = (await client.query<{ payload_hash: string; response: unknown }>(
      'SELECT payload_hash,response FROM mutation_receipts WHERE owner_id=$1 AND request_id=$2 FOR UPDATE', [owner, input.requestId],
    )).rows[0];
    const trip = await lockTrip(client, owner, input.tripId);
    if (agentRunId) await guardAgentDecision(client, agentRunId, input.tripId, 'proposalId' in input ? input.proposalId : '', true);
    else if ('proposalId' in input) await rejectChatBypass(client, input.proposalId);
    if (receipt.payload_hash !== hash) throw new DomainError('IDEMPOTENCY_CONFLICT');
    if (receipt.response !== null) return receiptView(receipt.response, input.tripId);
    requireBase(trip, input.baseVersion);
    if (trip.version >= 2147483647) invalid();
    const snapshot = parseSnapshot(await work(client, trip));
    const response = { id: trip.id, version: trip.version + 1, snapshot, budget: calculateBudget(snapshot) };
    await client.query('INSERT INTO trip_versions(trip_id,version,snapshot) VALUES ($1,$2,$3::jsonb)', [trip.id, response.version, JSON.stringify(snapshot)]);
    await client.query('UPDATE trips SET current_version=$2 WHERE id=$1', [trip.id, response.version]);
    await client.query("UPDATE proposals SET status='stale' WHERE trip_id=$1 AND status='pending'", [trip.id]);
    await client.query(`UPDATE mutation_receipts SET trip_id=$3,response=$4::jsonb WHERE owner_id=$1 AND request_id=$2`,
      [owner, input.requestId, trip.id, JSON.stringify(response)]);
    return response;
  });
}

async function guardAgentDecision(client: PoolClient, runId: string, tripId: string, proposalId: string, confirmed: boolean): Promise<void> {
  // Under the same trip lock used by run-store: an expired or fenced worker
  // must not perform its first product mutation after losing its lease.
  const result = await client.query(`SELECT id FROM agent_runs WHERE id=$1 AND trip_id=$2
    AND answer_contract_version=1 AND proposal_id=$3 AND decision=$4
    AND status='running' AND lease_expires_at>clock_timestamp()`,
  [runId, tripId, proposalId, confirmed]);
  if (!result.rowCount) throw new DomainError('RUN_STATE_CONFLICT');
}

async function rejectChatBypass(client: PoolClient, proposalId: string): Promise<void> {
  const linked = await client.query('SELECT id FROM agent_runs WHERE proposal_id=$1', [proposalId]);
  if (linked.rowCount) throw new DomainError('RUN_STATE_CONFLICT');
}

export async function applyProposal(owner: string, raw: ApplyInput, agentRunId?: string): Promise<TripView> {
  const parsed = applySchema.safeParse(raw);
  if (!parsed.success) invalid();
  const input = parsed.data;
  if (agentRunId && input.requestId !== `agent:${agentRunId}`) throw new DomainError('RUN_STATE_CONFLICT');
  return mutate(owner, 'apply', input, async (client, trip) => {
    const proposal = (await client.query<{ base_version: number; status: string; draft: ProposalDraft; catalog_snapshot: CatalogItem[] }>(
      'SELECT base_version,status,draft,catalog_snapshot FROM proposals WHERE id=$1 AND trip_id=$2', [input.proposalId, trip.id],
    )).rows[0];
    if (!proposal) throw new DomainError('NOT_FOUND');
    if (proposal.base_version !== trip.version || proposal.status === 'stale') throw new DomainError('STALE_VERSION');
    if (proposal.status !== 'pending') invalid();
    const draft = validateDraft(trip.snapshot, proposal.draft, proposal.catalog_snapshot);
    if (!draft.canApply) invalid();
    await client.query("UPDATE proposals SET status='applied' WHERE id=$1", [input.proposalId]);
    return draft.next;
  }, agentRunId);
}

export async function restoreVersion(owner: string, raw: RestoreInput): Promise<TripView> {
  const parsed = restoreSchema.safeParse(raw);
  if (!parsed.success) invalid();
  const input = parsed.data;
  return mutate(owner, 'restore', input, async (client, trip) => {
    const target = (await client.query<{ snapshot: unknown }>(
      'SELECT snapshot FROM trip_versions WHERE trip_id=$1 AND version=$2', [trip.id, input.targetVersion],
    )).rows[0];
    if (!target) throw new DomainError('NOT_FOUND');
    return parseSnapshot(target.snapshot);
  });
}

export async function rejectProposal(owner: string, tripId: string, proposalId: string, agentRunId?: string): Promise<AgentDecisionReceipt | null> {
  validIds(owner, tripId, proposalId);
  return transaction(database(), async client => {
    const trip = await lockTrip(client, owner, tripId);
    if (agentRunId) await guardAgentDecision(client, agentRunId, tripId, proposalId, false);
    else await rejectChatBypass(client, proposalId);
    const proposal = (await client.query<{ status: string; rejection_version: number | null }>(
      'SELECT status,rejection_version FROM proposals WHERE id=$1 AND trip_id=$2', [proposalId, tripId])).rows[0];
    if (!proposal) throw new DomainError('NOT_FOUND');
    if (proposal.status === 'rejected') return proposal.rejection_version === null ? null
      : { status: 'rejected', version: proposal.rejection_version };
    if (proposal.status !== 'pending') invalid();
    await client.query("UPDATE proposals SET status='rejected',rejection_version=$2 WHERE id=$1", [proposalId, trip.version]);
    return { status: 'rejected', version: trip.version };
  });
}

/** Read under the caller's authenticated trip lock. The apply receipt and the
 * rejection transaction are authoritative; current_version is never evidence
 * of a past decision. No snapshot/catalog computation or mutation is needed. */
export async function readAgentDecisionReceipt(client: PoolClient, owner: string, tripId: string,
  runId: string): Promise<AgentDecisionReceipt | null> {
  const row = (await client.query<{ base_version: number; proposal_id: string; decision: boolean | null;
    status: string; rejection_version: number | null }>(`
    SELECT r.base_version,r.proposal_id,r.decision,p.status,p.rejection_version
    FROM agent_runs r JOIN trips t ON t.id=r.trip_id JOIN proposals p ON p.id=r.proposal_id
    WHERE r.id=$1 AND r.trip_id=$2 AND t.owner_id=$3 AND r.answer_contract_version=1
      AND p.trip_id=r.trip_id AND p.base_version=r.base_version`, [runId, tripId, owner])).rows[0];
  if (!row || row.decision === null) return null;
  if (row.decision === false) {
    if (row.status !== 'rejected') return null;
    const observed = version.safeParse(row.rejection_version);
    if (!observed.success || observed.data < row.base_version) {
      throw new DomainError('RUN_STATE_CONFLICT');
    }
    return { status: 'rejected', version: observed.data };
  }
  const receipt = (await client.query<{ payload_hash: string; response: unknown }>(`
    SELECT payload_hash,response FROM mutation_receipts
    WHERE owner_id=$1 AND request_id=$2 AND trip_id=$3 AND operation='apply'`,
  [owner, `agent:${runId}`, tripId])).rows[0];
  if (!receipt && row.status !== 'applied') return null;
  const expected = createHash('sha256').update(JSON.stringify(['apply', tripId, row.base_version, row.proposal_id])).digest('hex');
  const response = z.object({ id: z.uuid(), version }).safeParse(receipt?.response);
  if (row.status !== 'applied' || receipt?.payload_hash !== expected || !response.success
    || response.data.id !== tripId || response.data.version !== row.base_version + 1) throw new DomainError('RUN_STATE_CONFLICT');
  return { status: 'applied', version: response.data.version };
}
