import { fork } from 'node:child_process';
import { resolve as resolvePath } from 'node:path';
import type { BaseEvent } from '@ag-ui/core';
import { z } from 'zod';
import type { CatalogItem, Change, Snapshot } from '../domain/types';
import { canonicalAgentChangesSchema } from './tool-schemas.ts';
import type { ProviderUsage } from './provider.ts';
import { providerAccountingEvidenceSchema, type ProviderAccountingEvidence } from './provider-contract.ts';
import { CLOUDFLARE_MODEL } from './cloudflare-wire.ts';
import { GEMINI_MODEL } from './model-id.ts';
import { parsePublicAgentEvent } from './public-events.ts';
import { offlineScenarioSchema, type OfflineScenario } from './offline-scenario.ts';
export type { OfflineScenario } from './offline-scenario.ts';

export type AgentAccountingEvent = { kind: 'model-call-start'; callId: string }
  | { kind: 'model-call-usage'; callId: string; usage: ProviderUsage | null; providerEvidence?: ProviderAccountingEvidence };

export type AgentDecisionResult = { status: 'applied' | 'rejected'; version: number };
export type AgentExecution = {
  runId: string; sessionId: string; ownerId: string; tripId: string; baseVersion: number;
  snapshot: Snapshot; catalog: CatalogItem[];
  input: { kind: 'start'; message: string } | {
    kind: 'resume'; interruptId: string; decision: 'approved' | 'rejected';
    committedResult: AgentDecisionResult;
  };
};
export type AgentRuntimeEvent = { kind: 'event'; event: BaseEvent } | {
  kind: 'proposal'; interruptId: string; changes: Change[]; toolCallId: string; eventId: string;
};
export type AgentExecutionOutcome = { status: 'awaiting_confirmation'; interruptId: string } | { status: 'succeeded' };
export type AgentRuntimeConfig = { databaseUrl: string; schema: string; productTripId?: string;
  lookupTimeout?: true;
  /** Durable provider identity is required for either phase, without granting model access. */
  provider?: { kind: 'gemini'; model?: string; deadlineMs: number; previousModelCalls: number }
    | { kind: 'openrouter'; model: string; deadlineMs: number; previousModelCalls: number }
    | { kind: 'cloudflare'; model: string; accountId: string; deadlineMs: number; previousModelCalls: number };
  /** Only a start invocation may receive the generation capability. */
  generation?: { apiKey: string };
  offlineScenario?: OfflineScenario;
};
export type AgentRuntimeHooks = { signal: AbortSignal; onEvent(event: AgentRuntimeEvent): Promise<void>;
  onAccounting?(event: AgentAccountingEvent): Promise<void>;
};

const tokens = z.number().int().min(0).max(1_000_000_000);
const accountingSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('model-call-start'), callId: z.uuid() }),
  z.strictObject({ kind: z.literal('model-call-usage'), callId: z.uuid(), usage: z.strictObject({
    promptTokens: tokens, outputTokens: tokens, totalTokens: tokens,
    cachedTokens: tokens.optional(), thoughtTokens: tokens.optional(),
  }).nullable(), providerEvidence: providerAccountingEvidenceSchema.optional() }),
]);
const providerSchema = z.union([
  z.strictObject({ kind: z.literal('gemini'), model: z.literal(GEMINI_MODEL).optional(),
    deadlineMs: z.number().int().positive(), previousModelCalls: z.number().int().nonnegative() }),
  z.strictObject({ kind: z.literal('openrouter'), model: z.string().regex(/^[a-z0-9-]+\/[a-z0-9._-]+:free$/),
    deadlineMs: z.number().int().positive(), previousModelCalls: z.number().int().nonnegative() }),
  z.strictObject({ kind: z.literal('cloudflare'), model: z.literal(CLOUDFLARE_MODEL), accountId: z.string().regex(/^[a-f0-9]{32}$/),
    deadlineMs: z.number().int().positive(), previousModelCalls: z.number().int().nonnegative() }),
]);
const generationSchema = z.strictObject({ apiKey: z.string().trim().min(1) });

const outcomeSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('succeeded') }),
  z.strictObject({ status: z.literal('awaiting_confirmation'), interruptId: z.string().min(1) }),
]);
const proposalSchema = z.strictObject({ kind: z.literal('proposal'), interruptId: z.string().min(1),
  changes: canonicalAgentChangesSchema,
  toolCallId: z.string().min(1), eventId: z.string().min(1),
});

// All provider modes retain the dedicated local database boundary.
export function validateRuntimeConfig(config: AgentRuntimeConfig): void {
  // The retained pre-contract live environment is history, never a new runner.
  if (config.schema === 'workbench_live_adk') throw new Error('AGENT_LEGACY_READ_ONLY');
  if (config.lookupTimeout !== undefined && (config.lookupTimeout !== true || !/^test_[a-f0-9]{32}_adk$/.test(config.schema))) throw new Error('AGENT_OFFLINE_CONFIG');
  if (config.productTripId !== undefined && !z.uuid().safeParse(config.productTripId).success) throw new Error('INVALID_AGENT_IDENTITY');
  if (config.provider !== undefined && !providerSchema.safeParse(config.provider).success) throw new Error('AGENT_PROVIDER_CONFIG');
  if (config.generation !== undefined && (!config.provider || !generationSchema.safeParse(config.generation).success)) {
    throw new Error('AGENT_PROVIDER_CONFIG');
  }
  if (config.offlineScenario !== undefined && (!offlineScenarioSchema.safeParse(config.offlineScenario).success
    || !config.provider || config.generation?.apiKey !== 'offline-placeholder-not-a-credential')) throw new Error('AGENT_OFFLINE_CONFIG');
  // The synthetic credential must never reach a real transport accidentally.
  if (config.generation?.apiKey === 'offline-placeholder-not-a-credential' && !config.offlineScenario) throw new Error('AGENT_OFFLINE_CONFIG');
  const url = new URL(config.databaseUrl);
  const options = url.searchParams.get('options');
  if (!['postgres:', 'postgresql:'].includes(url.protocol)
    || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.pathname !== '/dive_trip_test' || url.hash || url.password
    || [...url.searchParams.keys()].some(key => key !== 'options')
    || url.searchParams.getAll('options').length > 1
    || (options !== null && !/^-c search_path=[a-z][a-z0-9_]{0,62}$/.test(options))
    || !/^[a-z][a-z0-9_]{0,58}_adk$/.test(config.schema)) {
    throw new Error('INVALID_AGENT_DATABASE_CONFIG');
  }
}

/** Generation is an execution capability, not part of durable provider identity.
 * Check in both parent and child before DB initialization or model construction. */
export function validateRuntimeExecution(input: AgentExecution, config: AgentRuntimeConfig): void {
  validateRuntimeConfig(config);
  if (input.input.kind === 'resume') {
    if (config.generation !== undefined || config.offlineScenario !== undefined || config.lookupTimeout !== undefined) {
      throw new Error('AGENT_GENERATION_DISABLED');
    }
  } else if (config.provider && !config.generation) throw new Error('AGENT_GENERATION_REQUIRED');
}

/** ACK follows durable onEvent/onAccounting; both hooks must be bounded.
 * Resolves only after the worker exits and its active persistence hook settles. */
export async function executeAgent(input: AgentExecution, hooks: AgentRuntimeHooks,
  config: AgentRuntimeConfig): Promise<AgentExecutionOutcome> {
  validateRuntimeExecution(input, config);
  if (config.generation && typeof hooks.onAccounting !== 'function') throw new Error('AGENT_ACCOUNTING_REQUIRED');
  const deadlineMs = Math.min(config.provider?.deadlineMs ?? Infinity, Date.now() + 60_000);
  if (deadlineMs <= Date.now()) throw new Error('AGENT_TIMEOUT');
  if (hooks.signal.aborted) throw new Error('AGENT_ABORTED');
  if (input.sessionId !== input.runId || ![input.ownerId, input.tripId, input.runId].every(id => z.uuid().safeParse(id).success)
    || (config.productTripId !== undefined && config.productTripId !== input.tripId)) {
    throw new Error('INVALID_AGENT_IDENTITY');
  }
  const databaseUrl = new URL(config.databaseUrl);
  databaseUrl.search = ''; // Never carry the product search_path into ADK.
  return new Promise((resolve, reject) => {
    const child = fork(config.offlineScenario ? resolvePath(process.cwd(), 'tests/support/gemini-worker.ts') : workerPath(),
      config.offlineScenario ? [config.offlineScenario] : [], {
      // No inherited NODE_OPTIONS, credentials, env files, or argv database URL.
      execArgv: [], env: { NODE_ENV: 'test', OTEL_SDK_DISABLED: 'true' },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'json',
    });
    let failure: Error | undefined;
    let outcome: AgentExecutionOutcome | undefined;
    let processing = false;
    let activeHook: Promise<void> | undefined;
    let sequence = 0;
    const stop = (error: Error) => {
      failure ??= error;
      child.kill('SIGKILL');
    };
    const abort = () => stop(new Error('AGENT_ABORTED'));
    const timeout = setTimeout(() => stop(new Error('AGENT_TIMEOUT')), Math.max(1, deadlineMs - Date.now()));
    hooks.signal.addEventListener('abort', abort, { once: true });
    child.on('error', () => stop(new Error('AGENT_WORKER_FAILED')));
    child.on('message', async (raw: unknown) => {
      if (failure) return;
      try {
        const message = z.object({ type: z.string() }).passthrough().parse(raw);
        if (message.type === 'failure') {
          if (processing || outcome) throw new Error('INVALID_AGENT_PROTOCOL');
          const code = typeof message.code === 'string' && /^AGENT_[A-Z_]+$/.test(message.code)
            ? message.code : 'AGENT_EXECUTION_FAILED';
          stop(new Error(code)); return;
        }
        if (message.type === 'outcome') {
          if (processing || outcome) throw new Error('INVALID_AGENT_PROTOCOL');
          outcome = outcomeSchema.parse(message.outcome);
          child.send({ type: 'finish' });
          return;
        }
        if (!['event', 'accounting'].includes(message.type) || processing || outcome || message.sequence !== sequence + 1) {
          throw new Error('INVALID_AGENT_PROTOCOL');
        }
        processing = true;
        if (message.type === 'accounting') {
          if (!config.generation || !hooks.onAccounting) throw new Error('INVALID_AGENT_PROTOCOL');
          activeHook = hooks.onAccounting(accountingSchema.parse(message.event));
        } else {
          const rawEvent = z.object({ kind: z.enum(['event', 'proposal']) }).passthrough().parse(message.event);
          const event: AgentRuntimeEvent = rawEvent.kind === 'proposal' ? proposalSchema.parse(rawEvent)
            : { kind: 'event', event: parsePublicAgentEvent(rawEvent.event, input.runId) };
          activeHook = hooks.onEvent(event);
        }
        await activeHook;
        if (failure || hooks.signal.aborted) return;
        sequence++;
        processing = false;
        child.send({ type: 'ack', sequence });
      } catch {
        const accounting = raw && typeof raw === 'object' && 'type' in raw && raw.type === 'accounting';
        stop(new Error(accounting ? 'AGENT_ACCOUNTING_PERSISTENCE_FAILED' : 'AGENT_EVENT_PERSISTENCE_FAILED'));
      }
    });
    // 'close' also fires when spawn fails (which need not emit 'exit').
    child.once('close', async code => {
      clearTimeout(timeout);
      hooks.signal.removeEventListener('abort', abort);
      // The child can exit while the parent is committing its last event.
      // Do not let callers clean up/release the run until that bounded hook settles.
      await activeHook?.catch(() => undefined);
      if (failure) reject(failure);
      else if (code !== 0 || !outcome || processing) reject(new Error('AGENT_WORKER_INTERRUPTED'));
      else resolve(outcome);
    });
    if (hooks.signal.aborted) abort();
    else child.send({ type: 'start', input, config: { databaseUrl: databaseUrl.href, schema: config.schema,
      ...(config.productTripId ? { productTripId: config.productTripId } : {}),
      ...(config.offlineScenario ? { offlineScenario: config.offlineScenario } : {}),
      ...(config.lookupTimeout ? { lookupTimeout: true } : {}),
      ...(config.provider ? { provider: { ...config.provider, deadlineMs } } : {}),
      ...(config.generation ? { generation: config.generation } : {}),
    } });
  });
}

// Next rewrites import.meta.url into its server chunk; worker stays source TS.
function workerPath(): string { return resolvePath(process.cwd(), 'src/agent/worker.ts'); }
