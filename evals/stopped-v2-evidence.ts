import { isDeepStrictEqual } from 'node:util';
import type { UsageEvidence } from './usage-evidence.ts';

type Run = { id: string; status: string; proposal_id: string | null; interrupt_id: string | null; decision: boolean | null };
type Event = { run_id: string; sequence: number; event: unknown };
type Attempt = { evidence: { runId: string; before: unknown; beforeDecision: unknown; after: unknown }; events: readonly unknown[] };
type Audit = { runs: readonly Run[]; events: readonly Event[]; privateUsage: readonly UsageEvidence[] };
type Snapshot = { runs: readonly (Run & { snapshot: unknown })[]; events: readonly Event[]; usage: readonly UsageEvidence[] };
function fail(): never { throw new Error('EVAL_STOPPED_V2_EVIDENCE_INVALID'); }

/** Cross-record invariants only, after a closed historical wrapper parses its
 * fixed schemas. No IO, grader, authorization or caller-configurable policy.
 * The wrapper still owns hashes, identities, recorded grades, exact charge and
 * provider-observation facts; unknown usage is never settled or reinterpreted. */
export function assertStoppedV2Evidence(attempt: Attempt, audit: Audit, snapshot: Snapshot, accountId: string) {
  if (snapshot.runs.length !== 1 || snapshot.usage.length !== 1 || audit.runs.length !== 1) fail();
  const run = snapshot.runs[0], usage = snapshot.usage[0], evidence = attempt.evidence;
  const { id, status, proposal_id, interrupt_id, decision } = run;
  if (!isDeepStrictEqual({ id, status, proposal_id, interrupt_id, decision }, audit.runs[0])
    || evidence.runId !== run.id || !isDeepStrictEqual(evidence.before, evidence.beforeDecision)
    || !isDeepStrictEqual(evidence.before, evidence.after) || !isDeepStrictEqual(run.snapshot, evidence.after)
    || !isDeepStrictEqual(snapshot.events, audit.events) || !isDeepStrictEqual(snapshot.events.map(e => e.event), attempt.events)
    || snapshot.events.some((e, i) => e.run_id !== run.id || e.sequence !== i + 1)
    || !isDeepStrictEqual(snapshot.usage, audit.privateUsage) || usage.schemaVersion !== 2
    || usage.runId !== run.id || usage.binding.accountId !== accountId
    || usage.invocations.length !== 1 || usage.calls.length !== 1) fail();
  const receipt = usage.invocations[0], call = usage.calls[0];
  if (receipt.kind !== 'start' || receipt.status !== 'settled' || receipt.reservation_status !== 'settled'
    || receipt.actual_cost_micros !== null || receipt.charged_cost_micros !== receipt.max_cost_micros
    || call.status !== 'completed') fail();
  return { receipt, call };
}
