/// <reference lib="esnext.temporal" />
import { createHash } from 'node:crypto';
import { App, LlmAgent, FunctionTool, Runner, DatabaseSessionService, type Event, type Session } from '@google/adk';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { Pool } from 'pg';
import { EventType, type BaseEvent } from '@ag-ui/core';
import { EventSchemas } from '@ag-ui/core/schemas';
import { z } from 'zod';
import { FixtureModel, fixtureToolName } from './fixture.ts';
import { ReceiptOnlyModel } from './receipt-model.ts';
import { GEMINI_MODEL } from './model-id.ts';
import { createGeminiProvider, PROVIDER_ERROR_CODES, type ProviderUsage } from './provider.ts';
import { createOpenRouterProvider } from './openrouter-provider.ts';
import type { OpenRouterEvidence } from './openrouter-wire.ts';
import { createCloudflareProvider } from './cloudflare-provider.ts';
import { matchesCloudflareModel, type CloudflareEvidence } from './cloudflare-wire.ts';
import { GuardedModel, MODEL_LIMITS } from './model-guard.ts';
import { toolArgumentErrorCode } from './tool-diagnostic.ts';
import { providerDiagnosticErrorCode } from './provider-diagnostic.ts';
import { AGENT_INSTRUCTION } from './prompt.ts';
import { createReadTools } from './tools.ts';
import { validatedProposalParametersSchema } from './tool-schemas.ts';
import { answerPlanSchema, ANSWER_EVENT_NAME } from '../domain/answer.ts';
import { requirementsEvidence } from './answer-evidence.ts';
import { recordModelAnswer, recordToolEvidence, savedAnswer, type AnswerSession } from './answer-session.ts';
import { confirmationGates, type ConfirmationGate } from './confirmation.ts';
import { withAdkSchemaLock } from '../server/adk-schema-lock.ts';
import { validateRuntimeExecution, type AgentExecution, type AgentRuntimeConfig,
  type AgentRuntimeEvent, type AgentAccountingEvent, type AgentExecutionOutcome } from './runtime.ts';

const appName = 'dive_trip_fixture';
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return '{' + Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',') + '}';
  return JSON.stringify(value);
}
const publicTools = new Set(['find_destinations', 'find_items', 'calculate_budget', 'validate_changes', fixtureToolName]);
const safeModelErrors = new Set([
  ...PROVIDER_ERROR_CODES,
  'AGENT_PROVIDER_CONFIG', 'AGENT_PROVIDER_TIMEOUT', 'AGENT_PROVIDER_RATE_LIMIT', 'AGENT_PROVIDER_REFUSAL',
  'AGENT_PROVIDER_INVALID_RESPONSE', 'AGENT_PROVIDER_ERROR', 'AGENT_MODEL_LIMIT', 'AGENT_TOOL_LIMIT',
  'AGENT_CONTEXT_LIMIT', 'AGENT_OUTPUT_LIMIT', 'AGENT_MODEL_RESPONSE', 'AGENT_MODEL_REFUSED',
  'AGENT_PROPOSAL_LIMIT', 'AGENT_TOOL_NOT_ALLOWED', 'AGENT_TOOL_ARGUMENTS', 'AGENT_TIMEOUT', 'AGENT_ABORTED',
  'AGENT_ANSWER_SCHEMA', 'AGENT_ANSWER_EVIDENCE', 'AGENT_EVIDENCE_INVALID', 'AGENT_ANSWER_ALREADY_COMPLETED',
  'AGENT_GENERATION_DISABLED',
]);
const inputSchema = z.strictObject({
  runId: z.uuid(), sessionId: z.uuid(), ownerId: z.uuid(), tripId: z.uuid(), baseVersion: z.number().int().min(1).max(2147483647),
  snapshot: z.custom<AgentExecution['snapshot']>(value => !!value && typeof value === 'object'),
  catalog: z.array(z.custom<AgentExecution['catalog'][number]>(value => !!value && typeof value === 'object')),
  input: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('start'), message: z.string().min(1).max(8000) }),
    z.strictObject({ kind: z.literal('resume'), interruptId: z.string().min(1),
      decision: z.enum(['approved', 'rejected']),
      committedResult: z.strictObject({ status: z.enum(['applied', 'rejected']), version: z.number().int().min(1).max(2147483647) }),
    }),
  ]),
});

let sequence = 0;
let acknowledgement: { sequence: number; resolve(): void } | undefined;
let finishing = false;
let started = false;
let stage: 'CONFIG' | 'INIT' | 'SESSION' | 'RUN' | 'PROJECTION' = 'CONFIG';

function send(message: unknown): void {
  if (!process.connected || !process.send) throw new Error('AGENT_PARENT_DISCONNECTED');
  process.send(message);
}
async function publish(event: AgentRuntimeEvent): Promise<void> {
  if (event.kind === 'event') EventSchemas.parse(event.event);
  await publishAcknowledged('event', event);
}
async function publishAcknowledged(type: 'event' | 'accounting', event: AgentRuntimeEvent | AgentAccountingEvent): Promise<void> {
  await new Promise<void>(resolve => {
    acknowledgement = { sequence: ++sequence, resolve };
    send({ type, sequence, event });
  });
}
async function emit(event: BaseEvent): Promise<void> { await publish({ kind: 'event', event }); }

async function publishProposal(gate: ConfirmationGate): Promise<void> {
  await publish({ kind: 'proposal', ...gate });
}

function terminalModelEvent(events: Event[], runId: string): Event | undefined {
  // Ignore metadata-only checkpoints, never a later tool/user/error event.
  const terminal = events.findLast(event => event.content?.parts?.length || event.errorCode || event.interrupted);
  if (!terminal || terminal.invocationId !== events.at(-1)?.invocationId
    || terminal.author !== appName || terminal.partial || terminal.errorCode || terminal.interrupted
    || (terminal.finishReason && terminal.finishReason !== 'STOP')) return undefined;
  const parts = terminal.content?.parts ?? [];
  // ADK isFinalResponse also accepts long-running tools / skipSummarization;
  // this product requires an actual final assistant answer, not those exits.
  if (!parts.some(part => !part.thought && part.text?.trim())
    || parts.some(part => part.functionCall || part.functionResponse || part.executableCode || part.codeExecutionResult)
    || terminal.longRunningToolIds?.length
    || Object.keys(terminal.actions.requestedAuthConfigs ?? {}).length
    || Object.keys(terminal.actions.requestedToolConfirmations ?? {}).length) return undefined;
  const answer = savedAnswer(terminal, runId);
  return answer && answer.body.kind !== 'proposal' ? terminal : undefined;
}

function terminalReceiptEvent(events: Event[], runId: string, gate: ConfirmationGate,
  expected?: { status: 'applied' | 'rejected'; version: number }): Event | undefined {
  const terminal = events.findLast(event => event.content?.parts?.length || event.errorCode || event.interrupted);
  if (!terminal || terminal.invocationId !== events.at(-1)?.invocationId || terminal.author !== appName
    || terminal.partial || terminal.errorCode || terminal.interrupted || terminal.actions.skipSummarization !== true
    || events.indexOf(terminal) <= events.findIndex(event => event.id === gate.eventId)) return undefined;
  const parts = terminal.content?.parts ?? [];
  const receipt = parts.length === 1 && parts[0].functionResponse;
  const answer = savedAnswer(terminal, runId);
  if (!receipt || receipt.id !== gate.toolCallId || receipt.name !== fixtureToolName || answer?.body.kind !== 'receipt'
    || receipt.response?.status !== answer.body.status || receipt.response.version !== answer.body.version
    || (expected && (answer.body.status !== expected.status || answer.body.version !== expected.version))) return undefined;
  return terminal;
}

async function project(event: Event, runId: string): Promise<void> {
  if (event.partial) return; // SDK partial events have not been committed.
  for (const [index, part] of (event.content?.parts ?? []).entries()) {
    const call = part.functionCall;
    if (call?.name && publicTools.has(call.name) && call.id) {
      await emit({ type: EventType.TOOL_CALL_START, toolCallId: call.id, toolCallName: call.name });
      await emit({ type: EventType.TOOL_CALL_END, toolCallId: call.id });
    }
    const response = part.functionResponse;
    if (response?.name === fixtureToolName && response.id) {
      const receipt = response.response?.status === 'applied' || response.response?.status === 'rejected';
      const rejected = response.response?.error === 'This tool call is rejected.';
      if (receipt || rejected) await emit({ type: EventType.TOOL_CALL_RESULT,
        messageId: `${event.id}:${index}:result`, toolCallId: response.id, role: 'tool',
        content: '{}',
      });
    }
    if (response?.name && response.name !== fixtureToolName && publicTools.has(response.name) && response.id) {
      await emit({ type: EventType.TOOL_CALL_RESULT, messageId: `${event.id}:${index}:result`,
        toolCallId: response.id, role: 'tool', content: '{}' });
    }
  }
  const answer = savedAnswer(event, runId);
  if (answer) await emit({ type: EventType.CUSTOM, name: ANSWER_EVENT_NAME, value: answer });
}

async function execute(rawInput: unknown, config: AgentRuntimeConfig): Promise<AgentExecutionOutcome> {
  const input = inputSchema.parse(rawInput);
  validateRuntimeExecution(input, config);
  const remaining = config.provider ? config.provider.deadlineMs - Date.now() : 55_000;
  if (remaining <= 0) throw new Error('AGENT_TIMEOUT');
  const runSignal = AbortSignal.timeout(Math.min(60_000, Math.floor(remaining)));
  if (input.runId !== input.sessionId) throw new Error('INVALID_AGENT_IDENTITY');
  if (input.input.kind === 'resume' && (input.input.decision === 'approved') !== (input.input.committedResult.status === 'applied')) {
    throw new Error('INVALID_AGENT_DECISION');
  }
  stage = 'INIT';
  const pool = new Pool({ connectionString: config.databaseUrl, max: 1,
    connectionTimeoutMillis: 5000, statement_timeout: 10_000, application_name: `agent-runtime:${input.runId}` });
  const admin = await pool.connect();
  try {
    if ((await admin.query('SELECT current_database() AS name')).rows[0].name !== 'dive_trip_test') {
      throw new Error('INVALID_AGENT_DATABASE');
    }
    // Session lock spans the SDK's separate ORM connections and DDL commits.
    const sessions = new DatabaseSessionService({ driver: PostgreSqlDriver,
      clientUrl: config.databaseUrl, schema: config.schema, debug: false,
      driverOptions: { application_name: `agent-runtime:${input.runId}`, connectionTimeoutMillis: 5000, statement_timeout: 10_000 },
      pool: { min: 0, max: 3 } });
    await withAdkSchemaLock(admin, async () => {
      await admin.query(`CREATE SCHEMA IF NOT EXISTS "${config.schema}"`);
      await sessions.init();
    });
    // Defense in depth; product run-store still owns leases/fencing/decisions.
    const lock = await admin.query('SELECT pg_try_advisory_lock(724916, hashtext($1)) AS acquired', [`${config.schema}:${input.sessionId}`]);
    if (!lock.rows[0].acquired) throw new Error('AGENT_SESSION_BUSY');
    // A delayed worker must not recreate ADK data after product deletion.
    // Deletion holds this same advisory lock through its transaction.
    if (config.productTripId) {
      const productSchema = config.schema.slice(0, -4);
      const live = await admin.query(`SELECT r.id FROM "${productSchema}".agent_runs r
        JOIN "${productSchema}".trips t ON t.id=r.trip_id JOIN "${productSchema}".sessions s ON s.id=t.owner_id
        WHERE r.id=$1 AND t.id=$2 AND s.id=$3 AND r.status='running'
          AND r.lease_expires_at>clock_timestamp() AND t.expires_at>clock_timestamp() AND s.expires_at>clock_timestamp()`,
      [input.runId, config.productTripId, input.ownerId]);
      if (!live.rowCount) throw new Error('AGENT_PRODUCT_EXPIRED');
    }
    stage = 'SESSION';
    const identity = { appName, userId: input.ownerId, sessionId: input.sessionId };
    const providerModel = config.provider && (config.provider.model ?? GEMINI_MODEL);
    const binding = createHash('sha256').update(canonical({ answerContractVersion: 1, tripId: input.tripId, baseVersion: input.baseVersion,
      snapshot: input.snapshot, catalog: input.catalog })).digest('hex');
    const answerSession: AnswerSession = { binding: { ownerId: input.ownerId, tripId: input.tripId,
      runId: input.runId, baseVersion: input.baseVersion }, snapshot: input.snapshot, catalog: input.catalog,
      ...(input.input.kind === 'resume' ? { committedResult: input.input.committedResult } : {}) };
    // createSession also creates shared app/user rows by check-then-insert.
    // Serialize this short bootstrap, not the model turn, across the schema.
    let saved: Session | undefined;
    await admin.query('SELECT pg_advisory_lock(724915, hashtext($1))', [config.schema]);
    try {
      saved = await sessions.getSession(identity);
      if (!saved) {
        if (input.input.kind !== 'start') throw new Error('AGENT_SESSION_NOT_FOUND');
        saved = await sessions.createSession({ ...identity, state: { binding, answerContractVersion: 1, message: input.input.message,
          ...(config.provider ? { providerMode: config.provider.kind, providerModel } : {}),
          ...(config.provider?.kind === 'cloudflare' ? { providerAccountId: config.provider.accountId } : {}) } });
      }
    } finally { await admin.query('SELECT pg_advisory_unlock(724915, hashtext($1))', [config.schema]); }
    if (saved.state.answerContractVersion !== 1) throw new Error('AGENT_LEGACY_READ_ONLY');
    if (saved.state.binding !== binding || (input.input.kind === 'start' && saved.state.message !== input.input.message)) {
      throw new Error('AGENT_INPUT_CONFLICT');
    }
    if (saved.state.providerMode !== config.provider?.kind) throw new Error('AGENT_PROVIDER_MODE_CONFLICT');
    if (saved.state.providerModel !== providerModel) throw new Error('AGENT_PROVIDER_MODE_CONFLICT');
    if (config.provider?.kind === 'cloudflare' && saved.state.providerAccountId !== config.provider.accountId) {
      throw new Error('AGENT_PROVIDER_ACCOUNT_CONFLICT');
    }
    const previous = saved.events.filter(event => !event.partial && event.author !== 'user');
    const previousCalls = previous.flatMap(event => event.content?.parts ?? [])
      .flatMap(part => part.functionCall?.name && publicTools.has(part.functionCall.name) ? [part.functionCall] : []);
    const savedModelCalls = previous.filter(event => event.content?.parts?.some(part => part.text
      || (part.functionCall?.name && publicTools.has(part.functionCall.name)))).length;
    if (config.provider && config.provider.previousModelCalls < savedModelCalls) throw new Error('AGENT_MODEL_HISTORY_CONFLICT');
    const gate = confirmationGates(saved.events, input.snapshot, input.catalog).at(-1);
    const resultEvent = gate && saved.events.findLast(event => event.content?.parts?.some(part =>
      part.functionResponse?.name === fixtureToolName && part.functionResponse.id === gate.toolCallId
      && (part.functionResponse.response?.status === 'applied' || part.functionResponse.response?.error === 'This tool call is rejected.')));
    const response = resultEvent?.content?.parts?.find(part => part.functionResponse?.id === gate?.toolCallId)?.functionResponse?.response;
    if (input.input.kind === 'resume') {
      if (!gate || gate.interruptId !== input.input.interruptId) throw new Error('UNKNOWN_AGENT_CONFIRMATION');
      if (response) {
        const applied = response.status === 'applied';
        if (applied !== (input.input.decision === 'approved')
          || (applied && response.version !== input.input.committedResult.version)) throw new Error('AGENT_DECISION_CONFLICT');
        const terminal = resultEvent && terminalReceiptEvent(saved.events, input.runId, gate, input.input.committedResult);
        if (!terminal) throw new Error('AGENT_RESUME_INCOMPLETE');
        // The receipt and accepted projection share one native final event.
        // Replay it exactly; never re-execute the tool or ask a model to narrate.
        for (const event of saved.events.slice(saved.events.indexOf(resultEvent), saved.events.indexOf(terminal) + 1)) await project(event, input.runId);
        return { status: 'succeeded' };
      }
    } else if (gate) {
      if (response) {
        const terminal = resultEvent && terminalReceiptEvent(saved.events, input.runId, gate);
        if (!terminal) throw new Error('AGENT_RUN_INTERRUPTED');
        for (const event of saved.events.slice(saved.events.indexOf(resultEvent), saved.events.indexOf(terminal) + 1)) await project(event, input.runId);
        return { status: 'succeeded' };
      }
      await publishProposal(gate);
      const pendingAnswer = saved.events.findLast(event => savedAnswer(event, input.runId)?.body.kind === 'proposal');
      if (!pendingAnswer) throw new Error('AGENT_RUN_INCOMPLETE');
      await project(pendingAnswer, input.runId);
      return { status: 'awaiting_confirmation', interruptId: gate.interruptId };
    } else if (saved.events.length) {
      // Do not start a second invocation in an ambiguous mid-run crash window.
      // Replay the already compiled immutable projection, never regenerate it.
      const terminal = terminalModelEvent(saved.events, input.runId);
      if (!terminal) throw new Error('AGENT_RUN_INTERRUPTED');
      await project(terminal, input.runId);
      return { status: 'succeeded' };
    }
    const tool = new FunctionTool({ name: fixtureToolName,
      description: '只引用最近一次成功驗證的validationId建立確認卡片，不重新提交changes；暫停等待人工決定。接續時status=applied、version=N表示產品服務已保存版本N，不可再次要求確認。',
      parameters: validatedProposalParametersSchema, requireConfirmation: true,
      execute: (_args, context) => {
        if (input.input.kind !== 'resume' || input.input.decision !== 'approved'
          || !gate || context?.functionCallId !== gate.toolCallId) throw new Error('MISSING_COMMITTED_DECISION');
        // No product database writes. The authenticated HTTP path already committed.
        return input.input.committedResult;
      },
    });
    const onCallStart = async (callId: string) => {
      await publishAcknowledged('accounting', { kind: 'model-call-start', callId });
    };
    const onGeminiUsage = async (usage: ProviderUsage | null, callId: string) => {
      await publishAcknowledged('accounting', { kind: 'model-call-usage', callId, usage });
    };
    const onOpenRouterEvidence = async (evidence: OpenRouterEvidence, callId: string) => {
      const usage = evidence.usage && {
        promptTokens: evidence.usage.promptTokens, outputTokens: evidence.usage.outputTokens,
        totalTokens: evidence.usage.totalTokens, ...(evidence.usage.cachedTokens === undefined ? {} : { cachedTokens: evidence.usage.cachedTokens }),
      };
      const providerEvidence = evidence.generationId && evidence.returnedModel ? {
        provider: 'openrouter' as const, generationId: evidence.generationId,
        returnedModel: evidence.returnedModel, reportedCostMicros: evidence.usage?.cost === 0 ? 0 : null,
      } : undefined;
      await publishAcknowledged('accounting', { kind: 'model-call-usage', callId, usage: usage ?? null,
        ...(providerEvidence ? { providerEvidence } : {}) });
    };
    const onCloudflareEvidence = async (evidence: CloudflareEvidence, callId: string) => {
      const usage = evidence.usage && matchesCloudflareModel(evidence.returnedModel) ? {
        promptTokens: evidence.usage.promptTokens, outputTokens: evidence.usage.outputTokens,
        totalTokens: evidence.usage.totalTokens,
        ...(evidence.usage.cachedTokens === undefined ? {} : { cachedTokens: evidence.usage.cachedTokens }),
      } : null;
      await publishAcknowledged('accounting', { kind: 'model-call-usage', callId, usage,
        providerEvidence: { provider: 'cloudflare', returnedModel: evidence.returnedModel,
          priceBasis: 'cloudflare-gemma4-26b-2026-09-26' } });
    };
    const source = input.input.kind === 'resume' ? new ReceiptOnlyModel()
      : !config.provider ? new FixtureModel(input.snapshot, String(saved.state.message))
      : config.provider.kind === 'gemini' ? createGeminiProvider({ apiKey: config.generation!.apiKey,
        deadlineMs: config.provider.deadlineMs, onCallStart, onUsage: onGeminiUsage })
      : config.provider.kind === 'cloudflare' ? createCloudflareProvider({ model: config.provider.model,
        accountId: config.provider.accountId, apiKey: config.generation!.apiKey,
        deadlineMs: config.provider.deadlineMs, onCallStart, onEvidence: onCloudflareEvidence })
      : createOpenRouterProvider({ model: config.provider.model, apiKey: config.generation!.apiKey,
        deadlineMs: config.provider.deadlineMs, onCallStart, onEvidence: onOpenRouterEvidence });
    const model = new GuardedModel(source, {
      modelCalls: config.provider?.previousModelCalls ?? savedModelCalls,
      toolCalls: previousCalls.length, callIds: previousCalls.flatMap(call => call.id ? [call.id] : []),
      proposed: previousCalls.some(call => call.name === fixtureToolName),
    }, answerPlanSchema);
    const runner = new Runner({ app: new App({ name: appName,
      rootAgent: new LlmAgent({ name: 'dive_trip_fixture', model,
        outputSchema: answerPlanSchema,
        instruction: AGENT_INSTRUCTION,
        afterToolCallback: ({ tool, args, context, response }) => recordToolEvidence(answerSession, tool, args, context, response),
        afterModelCallback: ({ context, response }) => { recordModelAnswer(answerSession, context, response); },
        tools: [...createReadTools(input, config.lookupTimeout === true), tool] }),
      resumabilityConfig: { isResumable: true } }), sessionService: sessions });
    const parts = input.input.kind === 'start' ? [{ text: input.input.message },
      { text: JSON.stringify({ untrustedTripData: input.snapshot }) },
      { text: JSON.stringify({ requirementsEvidenceRef: requirementsEvidence(answerSession.binding, input.snapshot).id }) }] : [{ functionResponse: {
      id: input.input.interruptId, name: 'adk_request_confirmation', response: { confirmed: input.input.decision === 'approved' },
    } }];
    stage = 'RUN';
    const committedEvents = [...saved.events];
    for await (const event of runner.runAsync({ userId: input.ownerId, sessionId: input.sessionId,
      newMessage: { role: 'user', parts }, abortSignal: runSignal,
      runConfig: { maxLlmCalls: MODEL_LIMITS.modelCalls, plainTextToolConfirmation: false, allowRemoteToolConfirmation: false } })) {
      // ADK wraps thrown model errors as UNKNOWN_ERROR + errorMessage. Preserve
      // only our exact public codes; never forward arbitrary SDK diagnostics.
      if (event.errorCode) throw new Error(toolArgumentErrorCode(event.errorMessage)
        ?? providerDiagnosticErrorCode(event.errorMessage)
        ?? (event.errorMessage && safeModelErrors.has(event.errorMessage) ? event.errorMessage : 'AGENT_MODEL_FAILED'));
      stage = 'PROJECTION';
      if (!event.partial) {
        committedEvents.push(event);
        for (const newGate of confirmationGates(committedEvents, input.snapshot, input.catalog)
          .filter(candidate => candidate.eventId === event.id)) await publishProposal(newGate);
      }
      await project(event, input.runId);
      stage = 'RUN';
    }
    if (runSignal.aborted) throw new Error('AGENT_TIMEOUT');
    const final = await sessions.getSession(identity);
    if (!final) throw new Error('AGENT_SESSION_NOT_FOUND');
    const pending = confirmationGates(final.events, input.snapshot, input.catalog).at(-1);
    if (input.input.kind === 'start' && pending) return { status: 'awaiting_confirmation', interruptId: pending.interruptId };
    if (input.input.kind === 'start' && !terminalModelEvent(final.events, input.runId)) throw new Error('AGENT_RUN_INCOMPLETE');
    // Runner completion by itself is not proof of a completed native confirmation.
    if (input.input.kind === 'resume') {
      const receipt = final.events.findLast(event => event.content?.parts?.some(part => {
      const response = part.functionResponse;
      return response && response.id === gate?.toolCallId && response.name === fixtureToolName
        && (response.response?.status === 'applied' || response.response?.error === 'This tool call is rejected.');
      }));
      if (!receipt || !gate || !terminalReceiptEvent(final.events, input.runId, gate, input.input.committedResult)) throw new Error('AGENT_RESUME_INCOMPLETE');
    }
    return { status: 'succeeded' };
  } finally {
    // Process exit closes the SDK's private pool; never reach into private ORM.
    admin.release();
    await pool.end();
  }
}

process.on('disconnect', () => process.exit(1));
process.on('message', (raw: unknown) => {
  const message = z.object({ type: z.string() }).passthrough().safeParse(raw);
  if (!message.success) { process.exit(1); }
  const data = message.data;
  if (data.type === 'ack' && acknowledgement && data.sequence === acknowledgement.sequence) {
    const pending = acknowledgement; acknowledgement = undefined; pending.resolve();
  } else if (data.type === 'finish' && finishing) {
    process.exit(0);
  } else if (data.type === 'start' && !started) {
    started = true;
    void execute(data.input, data.config as AgentRuntimeConfig).then(outcome => {
      finishing = true; send({ type: 'outcome', outcome });
    }).catch(error => { send({ type: 'failure', code: error instanceof Error && /^AGENT_[A-Z_]+$/.test(error.message)
      ? error.message : `AGENT_${stage}_FAILED`,
    }); });
  } else { process.exit(1); }
});
