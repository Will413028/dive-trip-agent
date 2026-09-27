import { expect, test, vi } from 'vitest';
import { localLiveContext, INGRESS_HEADER, PEER_HEADER } from '../../src/server/local-live-context';
import { credential, validateAgentContext } from '../../src/server/agent-policy';
import { parseLocalCredential } from '../../src/server/local-credential';
import { CLOUDFLARE_MODEL } from '../../src/agent/cloudflare-wire';

const token = 'a'.repeat(64);
const env = { DIVE_LOCAL_LIVE: 'free-tier-confirmed', APP_ORIGIN: 'http://127.0.0.1:4318',
  DIVE_LOCAL_INGRESS_TOKEN: token, DIVE_LOCAL_IP_KEY: 'b'.repeat(64) };
const request = () => new Request('http://127.0.0.1:4320/api/agent-mode', {
  headers: { [INGRESS_HEADER]: token, [PEER_HEADER]: '127.0.0.1' },
});
test('ordinary Next stays fixture and never loads a credential', () => {
  const load = vi.fn();
  expect(localLiveContext(request(), {}, load)).toEqual({ provider: 'fixture' });
  expect(load).not.toHaveBeenCalled();
});
test('alternate port preserves loopback and ingress requirements', () => {
  const load = vi.fn();
  expect(localLiveContext(request(), { ...env, APP_ORIGIN: 'http://127.0.0.1:4418' }, load).provider).toBe('gemini');
  for (const origin of ['http://0.0.0.0:4418', 'http://localhost:4418', 'http://127.0.0.1:4320', 'http://127.0.0.1:4418/']) {
    expect(() => localLiveContext(request(), { ...env, APP_ORIGIN: origin }, load)).toThrow('AGENT_POLICY_DISABLED');
  }
  const forged = request(); forged.headers.delete(INGRESS_HEADER);
  expect(() => localLiveContext(forged, { ...env, APP_ORIGIN: 'http://127.0.0.1:4418' }, load)).toThrow('AGENT_POLICY_DISABLED');
  expect(load).not.toHaveBeenCalled();
});
test('live local ingress authenticates before lazy credential loading', async () => {
  const load = vi.fn(async () => 'synthetic-local-credential');
  const context = localLiveContext(request(), env, load);
  expect(context.provider).toBe('gemini'); expect(load).not.toHaveBeenCalled();
  validateAgentContext(context);
  if (context.provider !== 'gemini') throw new Error('TEST_MODE');
  expect(await credential(context, new AbortController().signal)).toBe('synthetic-local-credential');
  expect(load).toHaveBeenCalledTimes(1);
  expect(context.offlineScenario).toBeUndefined();
});
test('live local ingress can select a server-configured OpenRouter free model', async () => {
  let selected: string | undefined;
  const context = localLiveContext(request(), { ...env, DIVE_LOCAL_PROVIDER: 'openrouter', OPENROUTER_MODEL: 'example/synthetic:free' }, async provider => {
    selected = provider;
    return 'synthetic-openrouter-key';
  });
  expect(context).toMatchObject({ provider: 'openrouter', model: 'example/synthetic:free', liveLocal: true });
  validateAgentContext(context);
  if (context.provider !== 'openrouter') throw new Error('TEST_MODE');
  expect(await credential(context, new AbortController().signal)).toBe('synthetic-openrouter-key');
  expect(selected).toBe('openrouter');
});
test('Cloudflare context fixes the model and keeps credentials lazy through validation', async () => {
  const load = vi.fn(async () => 'synthetic-cloudflare-token');
  const context = localLiveContext(request(), { ...env, DIVE_LOCAL_PROVIDER: 'cloudflare', CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32) }, load);
  expect(context).toMatchObject({ provider: 'cloudflare', model: CLOUDFLARE_MODEL, accountId: 'a'.repeat(32), liveLocal: true });
  validateAgentContext(context);
  expect(load).not.toHaveBeenCalled();
  if (context.provider !== 'cloudflare') throw new Error('TEST_MODE');
  await expect(credential(context, AbortSignal.abort())).rejects.toThrow();
  expect(load).not.toHaveBeenCalled();
  expect(await credential(context, new AbortController().signal)).toBe('synthetic-cloudflare-token');
  expect(load).toHaveBeenCalledExactlyOnceWith('cloudflare');
});
test('Cloudflare rejects invalid account, model and ingress configuration before loading', () => {
  const load = vi.fn();
  const cloudflare = { ...env, DIVE_LOCAL_PROVIDER: 'cloudflare', CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32) };
  for (const accountId of [undefined, '', 'a'.repeat(31), 'a'.repeat(33), 'A'.repeat(32), 'g'.repeat(32), ` ${'a'.repeat(32)}`, `${'a'.repeat(32)}\n`]) {
    expect(() => localLiveContext(request(), { ...cloudflare, CLOUDFLARE_ACCOUNT_ID: accountId }, load)).toThrow('AGENT_POLICY_DISABLED');
  }
  for (const patch of [{ CLOUDFLARE_MODEL: 'another/model' }, { CLOUDFLARE_MODEL: '' },
    { OPENROUTER_MODEL: 'example/synthetic:free' }, { DIVE_LOCAL_PROVIDER: 'gemini' },
    { DIVE_LOCAL_LIVE: 'true' }, { DIVE_LOCAL_INGRESS_TOKEN: '' }]) {
    expect(() => localLiveContext(request(), { ...cloudflare, ...patch }, load)).toThrow('AGENT_POLICY_DISABLED');
  }
  const forged = request(); forged.headers.set(PEER_HEADER, '8.8.8.8');
  expect(() => localLiveContext(forged, cloudflare, load)).toThrow('AGENT_POLICY_DISABLED');
  expect(localLiveContext(request(), { DIVE_LOCAL_PROVIDER: 'cloudflare', CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32) }, load))
    .toEqual({ provider: 'fixture' });
  expect(load).not.toHaveBeenCalled();
});
test('forged ingress, peer or activation fail closed without credentials', () => {
  const load = vi.fn();
  for (const patch of [{ DIVE_LOCAL_LIVE: 'true' }, { DIVE_LOCAL_PROVIDER: 'unknown' }, { APP_ORIGIN: 'https://example.com' },
    { DIVE_LOCAL_INGRESS_TOKEN: '' }, { DIVE_LOCAL_IP_KEY: '' }]) {
    expect(() => localLiveContext(request(), { ...env, ...patch }, load)).toThrow('AGENT_POLICY_DISABLED');
  }
  for (const [header, value] of [[INGRESS_HEADER, 'c'.repeat(64)], [PEER_HEADER, '8.8.8.8'], [INGRESS_HEADER, '']]) {
    const req = request(); req.headers.set(header, value); req.headers.set('x-forwarded-for', '127.0.0.1');
    expect(() => localLiveContext(req, env, load)).toThrow('AGENT_POLICY_DISABLED');
  }
  expect(load).not.toHaveBeenCalled();
});
test('live and offline modes cannot mix; synthetic key never escapes to live', async () => {
  const context = localLiveContext(request(), env, async () => 'offline-placeholder-not-a-credential');
  if (context.provider !== 'gemini') throw new Error('TEST_MODE');
  expect(() => validateAgentContext({ ...context, offlineScenario: 'clarify' })).toThrow('AGENT_POLICY_DISABLED');
  await expect(credential(context, new AbortController().signal)).rejects.toThrow('AGENT_PROVIDER_CONFIG');
});
test('live credential guards accept opaque normal characters and reject control characters', async () => {
  expect(parseLocalCredential('GEMINI_API_KEY=synthetic-rn0')).toBe('synthetic-rn0');
  expect(parseLocalCredential('OPENROUTER_API_KEY=synthetic-rn0', 'OPENROUTER_API_KEY')).toBe('synthetic-rn0');
  for (const control of ['\r', '\n', '\0']) {
    const value = `synthetic${control}key`;
    const context = localLiveContext(request(), env, async () => value);
    if (context.provider !== 'gemini') throw new Error('TEST_MODE');
    await expect(credential(context, new AbortController().signal)).rejects.toThrow('AGENT_PROVIDER_CONFIG');
    // Node parseEnv normalizes CR before validation (including CRLF files).
    if (control === '\r') expect(parseLocalCredential(`GEMINI_API_KEY="${value}"`)).toBe('synthetickey');
    else expect(() => parseLocalCredential(`GEMINI_API_KEY="${value}"`)).toThrow('LIVE_CREDENTIAL_UNAVAILABLE');
  }
});
