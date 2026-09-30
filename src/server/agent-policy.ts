import type { PoolClient } from 'pg';
import { offlineScenarioSchema, type OfflineScenario } from '../agent/offline-scenario';
import { DomainError } from '../domain/errors';
import { database, transaction } from './db';
import { lockQuotaGlobal, type QuotaPolicy } from './quota';
import type { CatalogItem } from '../domain/types';
import type { AgentProviderKind } from '../agent/provider-contract';
import { GEMINI_MODEL } from '../agent/model-id';
import { freeModelSchema } from '../agent/openrouter-wire';
import { CLOUDFLARE_MODEL, cloudflareAccountSchema } from '../agent/cloudflare-wire';

/** Closed server policy, not a dispatch grant. Historical markers remain
 * identifiable but cannot enter the current grounded-answer HTTP contract.
 * Each entry still owns its authorization, permanent claim and usage limits. */
const cloudflareCampaignContract = Object.freeze({
  'cloudflare-30-cases': 'historical',
  'cloudflare-grounded-30-cases': 'grounded',
  'cloudflare-nonthinking-one-case': 'grounded',
  'cloudflare-diagnostic-30-cases': 'grounded',
  'cloudflare-probe-one-case': 'grounded',
  'cloudflare-probe-2-one-case': 'grounded',
  'cloudflare-probe-3-one-case': 'grounded',
  'cloudflare-probe-4-one-case': 'grounded',
  'cloudflare-probe-5-one-case': 'grounded',
  'cloudflare-probe-6-one-case': 'grounded',
  'cloudflare-probe-7-one-case': 'grounded',
  'cloudflare-python-quality-30-cases': 'grounded',
} as const);
type CloudflareEvaluationCampaign = keyof typeof cloudflareCampaignContract;
export type GroundedCloudflareEvaluationCampaign = {
  [C in CloudflareEvaluationCampaign]: typeof cloudflareCampaignContract[C] extends 'grounded' ? C : never;
}[CloudflareEvaluationCampaign];

export function isCloudflareEvaluationCampaign(value: unknown): value is CloudflareEvaluationCampaign {
  return typeof value === 'string' && Object.hasOwn(cloudflareCampaignContract, value);
}
export function isGroundedCloudflareEvaluationCampaign(value: unknown): value is GroundedCloudflareEvaluationCampaign {
  return isCloudflareEvaluationCampaign(value) && cloudflareCampaignContract[value] === 'grounded';
}

/** Server transport context only. Never populate from JSON or forwarded headers.
 * Live mode requires the separately authenticated loopback ingress. */
export type AgentServerContext = { provider: 'fixture' } | {
  provider: AgentProviderKind;
  /** Server-selected model; Gemini retains its historical default when omitted. */
  model?: string;
  accountId?: string;
  verifiedPeerAddress: string;
  hashingKey: Uint8Array;
  quota: QuotaPolicy;
  loadCredential: () => Promise<string>;
  offlineScenario?: OfflineScenario;
  liveLocal?: true;
  /** Isolated test schemas only; never derived from HTTP input. */
  evaluation?: {
    catalog: CatalogItem[];
    lookupTimeout: boolean;
    /** Server-only authority: the campaign entry point supplies this only after
     * exact opt-in, claim and baseline-history checks. Ordinary live workbench
     * contexts must not set it. The HTTP handler still requires a test_* schema.
     * This does NOT grant credential loading or replace the seven-call runtime
     * cap, campaign limits or separate live authorization. No campaign is run
     * merely by adding this context capability. */
    liveCampaign?: CloudflareEvaluationCampaign;
  };
};
export const FIXTURE_AGENT_CONTEXT: AgentServerContext = Object.freeze({ provider: 'fixture' });

export function validateAgentContext(context: AgentServerContext): void {
  if (context.provider === 'fixture') return;
  const offline = offlineScenarioSchema.safeParse(context.offlineScenario).success;
  const live = context.liveLocal === true && context.offlineScenario === undefined
    && context.verifiedPeerAddress === '127.0.0.1' && context.quota.enabled && context.quota.priceBasis === 'server-verified';
  const binding = context.provider === 'gemini'
    ? (context.model === undefined || context.model === GEMINI_MODEL)
    : context.provider === 'cloudflare' ? context.model === CLOUDFLARE_MODEL && cloudflareAccountSchema.safeParse(context.accountId).success
    : context.model !== undefined && freeModelSchema.safeParse(context.model).success;
  // A marker is authority supplied by trusted server code, not a browser switch
  // or a loader grant. Keep unmarked synthetic CF and existing Gemini evaluators.
  const campaign = context.evaluation?.liveCampaign;
  const evaluationAllowed = !context.evaluation
    || (context.provider === 'gemini' && campaign === undefined)
    || (context.provider === 'cloudflare' && (campaign === undefined
      ? offline && !context.liveLocal && context.quota.enabled && context.quota.priceBasis === 'synthetic'
      : isCloudflareEvaluationCampaign(campaign) && live));
  if (!binding || !evaluationAllowed || (context.liveLocal ? !live : !offline)) {
    throw new DomainError('AGENT_POLICY_DISABLED');
  }
}

/** Same global -> trip lock ordering as admission. Checking both before and
 * after claim keeps provider binding atomic even for a concurrent first start. */
export async function fixtureClaim<T extends { run: { id: string } }>(tripId: string,
  selector: { runId: string } | { requestId: string }, work: (client: PoolClient) => Promise<T>): Promise<T> {
  return transaction(database(), async client => {
    await lockQuotaGlobal(client);
    const bound = await client.query(`SELECT r.id FROM agent_runs r JOIN agent_invocations i ON i.run_id=r.id
      WHERE r.trip_id=$1 AND ${'runId' in selector ? 'r.id=$2::uuid' : 'r.request_id=$2'}`,
    [tripId, 'runId' in selector ? selector.runId : selector.requestId]);
    if (bound.rowCount) throw new DomainError('PROVIDER_CONFLICT');
    const result = await work(client);
    if ((await client.query('SELECT id FROM agent_invocations WHERE run_id=$1', [result.run.id])).rowCount) {
      throw new DomainError('PROVIDER_CONFLICT');
    }
    return result;
  });
}

/** Lazy loading shares the invocation deadline and cannot leave the route busy
 * forever. A timed-out loader cannot subsequently dispatch a worker. */
export async function credential(context: Exclude<AgentServerContext, { provider: 'fixture' }>, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const aborted = () => reject(new Error('AGENT_TIMEOUT'));
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve().then(context.loadCredential).then(value => {
      const valid = context.liveLocal
        ? typeof value === 'string' && value.length > 0 && value.length <= 4096 && value === value.trim()
          && !/[\r\n\0]/.test(value) && value !== 'offline-placeholder-not-a-credential'
        : value === 'offline-placeholder-not-a-credential';
      if (!valid) {
        reject(new Error('AGENT_PROVIDER_CONFIG'));
      } else resolve(value);
    }, () => reject(new Error('AGENT_PROVIDER_CONFIG')))
      .finally(() => signal.removeEventListener('abort', aborted));
  });
}
