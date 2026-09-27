import { timingSafeEqual } from 'node:crypto';
import { DomainError } from '../domain/errors';
import { FIXTURE_AGENT_CONTEXT, type AgentServerContext } from './agent-policy';
import { maximumProviderModelCost } from './model-cost';
import type { AgentProviderKind } from '../agent/provider-contract';
import { GEMINI_MODEL } from '../agent/model-id';
import { freeModelSchema } from '../agent/openrouter-wire';
import { CLOUDFLARE_MODEL } from '../agent/cloudflare-wire';

export const LOCAL_LIVE_ORIGIN = 'http://127.0.0.1:4318';
export const INGRESS_HEADER = 'x-dive-local-ingress';
export const PEER_HEADER = 'x-dive-local-peer';

/** Only the loopback launcher creates these process-scoped credentials. They
 * are never NEXT_PUBLIC or returned to a browser. This is not a public ingress. */
export function localLiveContext(request: Request, env: Readonly<Record<string, string | undefined>>,
  loadCredential: (provider?: AgentProviderKind) => Promise<string>): AgentServerContext {
  if (env.DIVE_LOCAL_LIVE === undefined) return FIXTURE_AGENT_CONTEXT;
  const fail = (): never => { throw new DomainError('AGENT_POLICY_DISABLED'); };
  if (env.DIVE_LOCAL_LIVE !== 'free-tier-confirmed'
    || ![LOCAL_LIVE_ORIGIN, 'http://127.0.0.1:4418'].includes(env.APP_ORIGIN ?? '')) return fail();
  const token = env.DIVE_LOCAL_INGRESS_TOKEN;
  const received = request.headers.get(INGRESS_HEADER);
  const salt = env.DIVE_LOCAL_IP_KEY;
  if (!token || !/^[a-f0-9]{64}$/.test(token) || !received || !/^[a-f0-9]{64}$/.test(received)
    || !timingSafeEqual(Buffer.from(token), Buffer.from(received))
    || request.headers.get(PEER_HEADER) !== '127.0.0.1'
    || !salt || !/^[a-f0-9]{64}$/.test(salt)) return fail();
  const configuredProvider = env.DIVE_LOCAL_PROVIDER ?? 'gemini';
  if (configuredProvider !== 'gemini' && configuredProvider !== 'openrouter' && configuredProvider !== 'cloudflare') return fail();
  const provider: AgentProviderKind = configuredProvider;
  const model = provider === 'openrouter' ? env.OPENROUTER_MODEL : provider === 'cloudflare' ? CLOUDFLARE_MODEL : GEMINI_MODEL;
  if (provider === 'openrouter' && (!model || !freeModelSchema.safeParse(model).success)) return fail();
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  if (provider === 'cloudflare' && (!accountId || accountId.length !== 32 || !/^[a-f0-9]{32}$/.test(accountId)
    || (env.CLOUDFLARE_MODEL !== undefined && env.CLOUDFLARE_MODEL !== CLOUDFLARE_MODEL)
    || env.OPENROUTER_MODEL !== undefined)) return fail();
  if (provider !== 'cloudflare' && (accountId !== undefined || env.CLOUDFLARE_MODEL !== undefined)) return fail();
  return { provider, ...(model ? { model } : {}), ...(provider === 'cloudflare' ? { accountId } : {}),
    liveLocal: true, verifiedPeerAddress: '127.0.0.1', hashingKey: Buffer.from(salt, 'hex'),
    // A bounded local demo, not permission to spend. User confirmed billing off.
    quota: { enabled: true, priceBasis: 'server-verified', dailyBudgetMicros: maximumProviderModelCost(provider) * 10, reservationTtlMs: 60_000 },
    loadCredential: () => loadCredential(provider) };
}
