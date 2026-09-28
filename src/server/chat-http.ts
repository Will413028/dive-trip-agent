import { EventType, type BaseEvent } from '@ag-ui/core';
import { RunAgentInputSchema } from '@ag-ui/core/schemas';
import { z } from 'zod';
import { executeAgent } from '../agent/runtime';
import { parsePublicAgentEvent } from '../agent/public-events';
import { publicAgentErrorCode } from './agent-error';
import { runErrorEvent } from './answer-events';
import { admitStart, admitResume, accountModelCall, getAdmissionUsage, settleAdmission, settleRejectedToolArguments, type Admission } from './agent-admission';
import { credential, fixtureClaim, validateAgentContext,
  FIXTURE_AGENT_CONTEXT, type AgentServerContext } from './agent-policy';
import { quotaIpKeys } from './client-ip';
import { maximumProviderModelCost, referenceModelCost, referenceProviderCost } from './model-cost';
import { calculateBudget } from '../domain/budget';
import { DomainError } from '../domain/errors';
import { buildProposal } from '../domain/proposal';
import { parseSnapshot } from '../domain/snapshot';
import { reviewProposal } from './proposal-review';
import type { CatalogItem, ProposalDraft } from '../domain/types';
import { database } from './db';
import { catalog } from './demo';
import { appendRunEvent, bindProposal, claimResume, finishRun, getRun, listRuns, startRun, type AgentRun } from './run-store';
import { getTrip } from './trip-store';
import { applyProposal, rejectProposal, saveProposal } from './version-store';

const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
const positiveVersion = z.number().int().positive().max(2147483647);
async function requireTrip(owner: string, tripId: string) {
  const trip = await getTrip(owner, tripId);
  if (!trip) throw new DomainError('NOT_FOUND');
  return trip;
}

export async function chatRuns(owner: string, tripId: string): Promise<Response> {
  await requireTrip(owner, tripId);
  const runs = await listRuns(owner, tripId);
  const views = await Promise.all(runs.map(async run => {
    if (run.answerContractVersion !== 1 || !run.proposalId) return run;
    const row = (await database().query<{ draft: ProposalDraft; snapshot: unknown }>(`
      SELECT p.draft,v.snapshot FROM proposals p JOIN trip_versions v
      ON v.trip_id=p.trip_id AND v.version=p.base_version
      WHERE p.id=$1 AND p.trip_id=$2`, [run.proposalId, tripId])).rows[0];
    if (!row) throw new DomainError('NOT_FOUND');
    const snapshot = parseSnapshot(row.snapshot);
    return { ...run, proposal: { draft: row.draft,
      review: reviewProposal(snapshot, row.draft),
      base: { id: tripId, version: run.baseVersion, snapshot, budget: calculateBudget(snapshot) } } };
  }));
  // A read of the projection must not outlive the ownership TTL check.
  await requireTrip(owner, tripId);
  return Response.json({ runs: views }, { headers });
}

export async function chatReplay(owner: string, tripId: string, runId: string): Promise<Response> {
  const run = await getRun(owner, tripId, runId);
  if (!run) throw new DomainError('NOT_FOUND');
  if (run.answerContractVersion !== 1) throw new DomainError('RUN_STATE_CONFLICT');
  return new Response(run.events.map(({ sequence, event }) => `id: ${sequence}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
    { headers: { ...headers, 'Content-Type': 'text/event-stream' } });
}

export async function chatAgent(request: Request, owner: string, tripId: string, body: unknown,
  context: AgentServerContext = FIXTURE_AGENT_CONTEXT): Promise<Response> {
  // Legacy HTTP remains only an offline regression oracle. Reviewed live
  // evaluation now owns a Python process and cannot enter this ADK path.
  if (context.provider !== 'fixture' && (context.liveLocal || context.offlineScenario === undefined
    || !context.quota.enabled || context.quota.priceBasis !== 'synthetic' || context.evaluation?.liveCampaign !== undefined)) {
    throw new DomainError('AGENT_POLICY_DISABLED');
  }
  // RunAgentInput strips unknown fields; explicitly reject server-only provider
  // selectors and evaluation inputs rather than silently accepting overrides.
  if (body && typeof body === 'object' && ['provider', 'model', 'apiKey', 'accountId',
    'evaluation', 'catalog', 'lookupTimeout', 'offlineScenario', 'liveCampaign'].some(key => key in body)) {
    throw new DomainError('INVALID_RUN');
  }
  const input = RunAgentInputSchema.parse(body);
  // Only this turn is input. The SDK's client state/history/tool declarations
  // are not a source of authority for product or ADK sessions.
  if (input.threadId !== tripId || input.tools.length || input.context.length
    || !z.strictObject({}).safeParse(input.state).success) throw new DomainError('INVALID_RUN');
  z.uuid().parse(input.runId);
  const trip = await requireTrip(owner, tripId);
  validateAgentContext(context);
  const scope = (await database().query<{ name: string }>('SELECT current_schema() AS name')).rows[0]?.name;
  if (scope === 'workbench_live') throw new DomainError('AGENT_POLICY_DISABLED');
  const liveContext = context.provider === 'fixture' ? undefined : context;
  if (liveContext?.evaluation) {
    if (!scope || scope.length !== 37 || !/^test_[a-f0-9]{32}$/.test(scope)) throw new DomainError('AGENT_POLICY_DISABLED');
  }
  const answers = input.resume ?? [];
  let run: AgentRun;
  let execute: boolean;
  let confirmed: boolean | undefined;
  let admission: Admission | undefined;
  const admissionInput = (kind: 'start' | 'resume') => {
    if (context.provider === 'fixture') throw new DomainError('INVALID_RUN');
    const now = new Date();
    return { ownerId: owner, tripId, ...quotaIpKeys(request, context.verifiedPeerAddress, context.hashingKey, now),
      provider: context.provider, model: context.model ?? 'gemini-3.1-flash-lite',
      accountId: context.accountId,
      maxCostMicros: kind === 'start' ? maximumProviderModelCost(context.provider) : 0, now, policy: context.quota };
  };
  if (answers.length) {
    const props = z.strictObject({ runId: z.uuid() }).parse(input.forwardedProps);
    if (answers.length !== 1 || input.messages.length) throw new DomainError('INVALID_RUN');
    const answer = answers[0];
    if (answer.status !== 'resolved') throw new DomainError('INVALID_RUN');
    confirmed = z.strictObject({ confirmed: z.boolean() }).parse(answer.payload).confirmed;
    if (context.provider !== 'fixture') {
      const claim = await admitResume({ ...admissionInput('resume'), runId: props.runId, interruptId: answer.interruptId, confirmed });
      run = claim.run; execute = claim.executed; admission = claim.admission;
    } else {
      const decision = confirmed;
      const claim = await fixtureClaim(tripId, { runId: props.runId }, client =>
        claimResume(owner, tripId, props.runId, answer.interruptId, decision, client));
      run = claim.run; execute = claim.claimed;
    }
  } else {
    const props = z.strictObject({ baseVersion: positiveVersion }).parse(input.forwardedProps);
    const messages = z.array(z.strictObject({ id: z.string().min(1).max(128), role: z.literal('user'),
      content: z.string().trim().min(1).max(4000) })).length(1).parse(input.messages);
    if (context.provider !== 'fixture') {
      const claim = await admitStart({ ...admissionInput('start'), requestId: input.runId, message: messages[0].content, baseVersion: props.baseVersion });
      run = claim.run; execute = claim.executed; admission = claim.admission;
    } else {
      const claim = await fixtureClaim(tripId, { requestId: input.runId }, client =>
        startRun(owner, tripId, input.runId, messages[0].content, props.baseVersion, client));
      run = claim.run; execute = claim.created;
    }
  }
  if (!execute) {
    // Replayed requests never restart ADK or reapply a product mutation.
    if (run.status === 'running') throw new DomainError('RUN_ACTIVE');
    if (run.status === 'interrupted' || run.status === 'failed') throw new DomainError('RUN_STATE_CONFLICT');
    return chatReplay(owner, tripId, run.id);
  }

  const abort = new AbortController();
  const deadlineMs = Math.min(Date.now() + 55_000, admission?.expiresAt.getTime() ?? Infinity);
  const signal = AbortSignal.any([request.signal, abort.signal, AbortSignal.timeout(Math.max(0, deadlineMs - Date.now()))]);
  let settled = false;
  let drainedToolRejection = false;
  const encoder = new TextEncoder();
  let connected = true;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let emittedThrough = run.events.at(-1)?.sequence ?? 0;
      const emit = (sequence: number, event: BaseEvent) => {
        if (connected && sequence > emittedThrough) {
          controller.enqueue(encoder.encode(`id: ${sequence}\ndata: ${JSON.stringify(event)}\n\n`));
          emittedThrough = sequence;
        }
      };
      const persist = async (event: BaseEvent) => {
        const saved = await appendRunEvent(owner, tripId, run.id, event);
        emit(saved.sequence, saved.event);
      };
      const finish = async (status: 'awaiting_confirmation' | 'succeeded' | 'failed', event: BaseEvent) => {
        const saved = await finishRun(owner, tripId, run.id, { status, event });
        // Failure finalization may append both a recovered receipt answer and
        // the lifecycle event. They are emitted only after the commit resolves.
        for (const item of saved.events) emit(item.sequence, item.event);
      };
      try {
        const provider = liveContext && admission
          ? liveContext.provider === 'gemini'
            ? { kind: 'gemini' as const, ...(liveContext.model ? { model: liveContext.model } : {}), deadlineMs,
              previousModelCalls: admission.priorModelCalls }
            : liveContext.provider === 'cloudflare'
            ? { kind: 'cloudflare' as const, model: admission.model, accountId: admission.accountId!,
              deadlineMs, previousModelCalls: admission.priorModelCalls }
            : { kind: 'openrouter' as const, model: liveContext.model!, deadlineMs,
              previousModelCalls: admission.priorModelCalls }
          : undefined;
        // A committed confirmation is deterministic work, not generation.
        // Provider identity survives, but no credential is loaded or sent to
        // the worker and no provider instance is constructed during resume.
        const generation = confirmed === undefined && provider && liveContext
          ? { apiKey: await credential(liveContext, signal) } : undefined;
        signal.throwIfAborted();
        await persist({ type: EventType.RUN_STARTED, threadId: tripId, runId: input.runId });
        const current = await requireTrip(owner, tripId);
        signal.throwIfAborted();
        let committedResult: { status: 'applied' | 'rejected'; version: number } | undefined;
        if (confirmed !== undefined) {
          if (!run.proposalId || !run.interruptId) throw new DomainError('INVALID_RUN');
          if (confirmed) {
            const applied = await applyProposal(owner, { tripId, proposalId: run.proposalId,
              baseVersion: run.baseVersion, requestId: `agent:${run.id}` }, run.id);
            committedResult = { status: 'applied', version: applied.version };
          } else {
            const receipt = await rejectProposal(owner, tripId, run.proposalId, run.id);
            if (!receipt) throw new DomainError('RUN_STATE_CONFLICT');
            committedResult = receipt;
          }
        } else if (current.version !== run.baseVersion) throw new DomainError('STALE_VERSION');
        const schema = (await database().query<{ name: string }>('SELECT current_schema() AS name')).rows[0].name;
        const databaseUrl = database().options.connectionString;
        if (!databaseUrl || !/^[a-z][a-z0-9_]{0,55}$/.test(schema)) throw new DomainError('INVALID_RUN');
        let items = catalog();
        if (liveContext?.evaluation) {
          if (schema.length !== 37 || !/^test_[a-f0-9]{32}$/.test(schema)) throw new DomainError('AGENT_POLICY_DISABLED');
          items = liveContext.evaluation.catalog;
        }
        let baseSnapshot = trip.snapshot;
        if (confirmed !== undefined) {
          const frozen = (await database().query<{ snapshot: unknown; catalog_snapshot: CatalogItem[] }>(`
            SELECT v.snapshot,p.catalog_snapshot FROM proposals p JOIN trip_versions v
            ON v.trip_id=p.trip_id AND v.version=p.base_version
            WHERE p.id=$1 AND p.trip_id=$2`, [run.proposalId, tripId])).rows[0];
          if (!frozen) throw new DomainError('NOT_FOUND');
          baseSnapshot = parseSnapshot(frozen.snapshot); items = frozen.catalog_snapshot;
        }
        const outcome = await executeAgent({ runId: run.id, sessionId: run.id, ownerId: owner, tripId,
          baseVersion: run.baseVersion, snapshot: baseSnapshot, catalog: items,
          input: confirmed === undefined ? { kind: 'start', message: run.message }
            : { kind: 'resume', interruptId: run.interruptId!, decision: confirmed ? 'approved' : 'rejected', committedResult: committedResult! },
        }, { signal, ...(admission ? { onAccounting: async (event: Parameters<typeof accountModelCall>[3]) => {
          const result = await accountModelCall(owner, tripId, admission.id, event);
          if (event.kind === 'model-call-start' && !result.recorded) throw new Error('AGENT_ACCOUNTING_CONFLICT');
        } } : {}), onEvent: async event => {
          if (event.kind === 'event') { await persist(parsePublicAgentEvent(event.event, run.id)); return; }
          if (confirmed !== undefined || event.changes.some(change => change.kind === 'lock')) throw new DomainError('INVALID_PROPOSAL');
          const draft = buildProposal(trip.snapshot, event.changes, items, 'agent');
          const proposalId = await saveProposal(owner, tripId, run.baseVersion, draft, items);
          run = await bindProposal(owner, tripId, run.id, proposalId, event.interruptId, event.toolCallId);
        } }, { databaseUrl, schema: `${schema}_adk`, productTripId: tripId,
          ...(provider ? { provider } : {}), ...(generation ? { generation,
            ...(liveContext?.offlineScenario ? { offlineScenario: liveContext.offlineScenario } : {}),
            ...(liveContext?.evaluation?.lookupTimeout ? { lookupTimeout: true } : {}) } : {}) }).catch(error => {
          // executeAgent rejects only after child close and persistence-hook drain.
          drainedToolRejection = !signal.aborted && error instanceof Error && error.message === 'AGENT_TOOL_ARGUMENTS';
          throw error;
        });
        const interrupted = outcome.status === 'awaiting_confirmation';
        if (interrupted && (!run.proposalId || !run.interruptId)) throw new DomainError('INVALID_RUN');
        if (admission) {
          const usage = await getAdmissionUsage(owner, tripId, admission.id);
          let actual: number | null = usage.hasUnknownUsage || !usage.complete ? null : 0;
          for (const call of usage.calls) {
            const cost = usage.provider === 'gemini' ? referenceModelCost(call.usage)
              : referenceProviderCost(usage.provider, call.usage, call.providerEvidence);
            if (actual === null || cost === null || !Number.isSafeInteger(actual + cost)) actual = null;
            else actual += cost;
          }
          const settlement = await settleAdmission(admission.id, actual);
          settled = true;
          if (settlement.chargedCostMicros > settlement.maxCostMicros) throw new Error('AGENT_COST_LIMIT');
        }
        await finish(interrupted ? 'awaiting_confirmation' : 'succeeded', {
          type: EventType.RUN_FINISHED, threadId: tripId, runId: input.runId,
          outcome: interrupted ? { type: 'interrupt', interrupts: [{ id: run.interruptId!, reason: 'approval',
            message: 'DEMO：請檢查差異後接受或拒絕修改。' }] } : { type: 'success' },
        });
      } catch (error) {
        if (admission && !settled) {
          try {
            if (drainedToolRejection && !signal.aborted) await settleRejectedToolArguments(admission, signal);
            else await settleAdmission(admission.id, null);
          }
          catch { /* Reservation remains conservatively charged on unavailable DB. */ }
        }
        const code = publicAgentErrorCode(error);
        try { await finish('failed', runErrorEvent(code)); }
        catch { /* Expired lease / lost DB: never manufacture a successful end. */ }
      } finally {
        if (connected) { connected = false; controller.close(); }
      }
    },
    cancel() { connected = false; abort.abort(); },
  });
  return new Response(stream, { headers: { ...headers, 'Content-Type': 'text/event-stream', 'X-Accel-Buffering': 'no' } });
}
