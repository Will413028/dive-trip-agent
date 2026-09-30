import { expect, test, vi } from 'vitest';
import { CLOUDFLARE_MODEL } from '../../src/agent/cloudflare-wire';
import { GEMINI_MODEL } from '../../src/agent/model-id';
import { credential, validateAgentContext, isCloudflareEvaluationCampaign, isGroundedCloudflareEvaluationCampaign,
  type AgentServerContext } from '../../src/server/agent-policy';

test.each([
  ['cloudflare-30-cases', true, false],
  ['cloudflare-grounded-30-cases', true, true],
  ['cloudflare-nonthinking-one-case', true, true],
  ['cloudflare-diagnostic-30-cases', true, true],
  ['cloudflare-probe-one-case', true, true],
  ['cloudflare-probe-2-one-case', true, true],
  ['cloudflare-probe-3-one-case', true, true],
  ['cloudflare-probe-3-one-case-extra', false, false],
  ['cloudflare-probe-one-case-extra', false, false],
  ['cloudflare-diagnostic-30-cases-extra', false, false],
  ['cloudflare-nonthinking-one-case-extra', false, false],
  ['constructor', false, false],
  ['__proto__', false, false],
  [undefined, false, false],
  [null, false, false],
  [true, false, false],
  [{}, false, false],
  [[], false, false],
] as const)('closed campaign policy distinguishes known and grounded markers: %j', (value, known, grounded) => {
  expect(isCloudflareEvaluationCampaign(value)).toBe(known);
  expect(isGroundedCloudflareEvaluationCampaign(value)).toBe(grounded);
});

const marker = 'cloudflare-30-cases' as const;
function campaignContext() {
  return { provider: 'cloudflare' as const, model: CLOUDFLARE_MODEL, accountId: 'a'.repeat(32),
    liveLocal: true as const, verifiedPeerAddress: '127.0.0.1', hashingKey: new Uint8Array(32),
    quota: { enabled: true as const, priceBasis: 'server-verified' as const, dailyBudgetMicros: 1_000_000, reservationTtlMs: 60_000 },
    evaluation: { catalog: [], lookupTimeout: true, liveCampaign: marker },
    // A validation marker cannot grant credential access; this fake loader denies it.
    loadCredential: vi.fn(async (): Promise<string> => { throw new Error('LOADER_GRANT_REQUIRED'); }) };
}

test('explicit Cloudflare campaign authority validates lazily without granting credential access', async () => {
  const context = campaignContext();
  expect(() => validateAgentContext(context)).not.toThrow();
  expect(context.loadCredential).not.toHaveBeenCalled();
  await expect(credential(context, new AbortController().signal)).rejects.toThrow('AGENT_PROVIDER_CONFIG');
  expect(context.loadCredential).toHaveBeenCalledTimes(1);
});

test('live credential loading remains lazy and respects an already-aborted invocation', async () => {
  const context = campaignContext();
  context.loadCredential.mockResolvedValue('synthetic-local-credential');
  validateAgentContext(context);
  expect(context.loadCredential).not.toHaveBeenCalled();
  await expect(credential(context, AbortSignal.abort())).rejects.toThrow();
  expect(context.loadCredential).not.toHaveBeenCalled();
  expect(await credential(context, new AbortController().signal)).toBe('synthetic-local-credential');
  expect(context.loadCredential).toHaveBeenCalledTimes(1);
});

test('live credential validation rejects the offline placeholder and control characters', async () => {
  const context = campaignContext();
  for (const value of ['offline-placeholder-not-a-credential', 'synthetic\rkey', 'synthetic\nkey', 'synthetic\0key']) {
    context.loadCredential.mockResolvedValue(value);
    await expect(credential(context, new AbortController().signal)).rejects.toThrow('AGENT_PROVIDER_CONFIG');
  }
});

test.each(['cloudflare-grounded-30-cases', 'cloudflare-nonthinking-one-case', 'cloudflare-diagnostic-30-cases',
  'cloudflare-probe-one-case', 'cloudflare-probe-2-one-case', 'cloudflare-probe-3-one-case'] as const)(
  '%s is a separate server marker and never supplies a credential grant', async liveCampaign => {
  const base = campaignContext();
  const context = { ...base, evaluation: { ...base.evaluation, liveCampaign } };
  expect(() => validateAgentContext(context)).not.toThrow();
  expect(context.loadCredential).not.toHaveBeenCalled();
  await expect(credential(context, new AbortController().signal)).rejects.toThrow('AGENT_PROVIDER_CONFIG');
  expect(() => validateAgentContext({ ...context, offlineScenario: 'proposal' })).toThrow('AGENT_POLICY_DISABLED');
  expect(() => validateAgentContext({ ...context, verifiedPeerAddress: '203.0.113.1' })).toThrow('AGENT_POLICY_DISABLED');
});

test.each([
  ['missing marker', { evaluation: { catalog: [], lookupTimeout: true } }],
  ['wrong marker', { evaluation: { catalog: [], lookupTimeout: true, liveCampaign: 'cloudflare-30-cases-extra' } }],
  ['boolean marker', { evaluation: { catalog: [], lookupTimeout: true, liveCampaign: true } }],
  ['not live local', { liveLocal: undefined }],
  ['mixed offline/live', { offlineScenario: 'proposal' }],
  ['wrong model', { model: 'other/model' }],
  ['missing account', { accountId: undefined }],
  ['invalid account', { accountId: 'A'.repeat(32) }],
  ['account newline', { accountId: `${'a'.repeat(32)}\n` }],
  ['non-loopback', { verifiedPeerAddress: '203.0.113.1' }],
  ['quota disabled', { quota: { enabled: false } }],
  ['synthetic price basis', { quota: { enabled: true, priceBasis: 'synthetic', dailyBudgetMicros: 1_000_000, reservationTtlMs: 60_000 } }],
])('Cloudflare campaign rejects %s before any loader call', async (_name, patch) => {
  const base = campaignContext();
  // Deliberately malformed runtime values exercise the server validator rather
  // than relying only on the TypeScript literal type for the authority marker.
  const context = { ...base, ...patch } as unknown as Exclude<AgentServerContext, { provider: 'fixture' }>;
  await expect(Promise.resolve().then(() => {
    validateAgentContext(context);
    return credential(context, new AbortController().signal);
  })).rejects.toThrow('AGENT_POLICY_DISABLED');
  expect(base.loadCredential).not.toHaveBeenCalled();
});

test('ordinary Cloudflare live workbench remains valid without evaluation', () => {
  const context = { ...campaignContext(), evaluation: undefined };
  expect(() => validateAgentContext(context)).not.toThrow();
  expect(context.loadCredential).not.toHaveBeenCalled();
});

test('synthetic evaluation stays valid but cannot carry live campaign authority', () => {
  const base = campaignContext();
  const offline = { ...base, liveLocal: undefined, offlineScenario: 'proposal' as const,
    quota: { ...base.quota, priceBasis: 'synthetic' as const } };
  expect(() => validateAgentContext({ ...offline, evaluation: { catalog: [], lookupTimeout: true } })).not.toThrow();
  expect(() => validateAgentContext(offline)).toThrow('AGENT_POLICY_DISABLED');
  expect(base.loadCredential).not.toHaveBeenCalled();
});

test('Gemini evaluation remains compatible without a Cloudflare authority marker', () => {
  const context = { ...campaignContext(), provider: 'gemini' as const, model: GEMINI_MODEL, accountId: undefined };
  expect(() => validateAgentContext({ ...context, evaluation: { catalog: [], lookupTimeout: true } })).not.toThrow();
  expect(() => validateAgentContext(context)).toThrow('AGENT_POLICY_DISABLED');
  expect(context.loadCredential).not.toHaveBeenCalled();
});
