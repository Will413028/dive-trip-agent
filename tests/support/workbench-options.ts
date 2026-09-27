import { freeModelSchema } from '../../src/agent/openrouter-wire.ts';

export type WorkbenchLiveProvider = 'gemini' | 'openrouter' | 'cloudflare';
export type WorkbenchOptions = {
  e2e: boolean;
  production: boolean;
  liveProvider?: WorkbenchLiveProvider;
  openRouterModel?: string;
  cloudflareAccountId?: string;
  port?: 4318 | 4418;
};

function flagValue(argv: readonly string[], flag: string): string | undefined {
  const values = argv.filter(value => value === flag || value.startsWith(`${flag}=`))
    .map(value => value === flag ? undefined : value.slice(flag.length + 1));
  if (values.length > 1 || values.some(value => !value)) throw new Error('INVALID_WORKBENCH_OPTIONS');
  return values[0];
}

export function parseWorkbenchOptions(argv: readonly string[]): WorkbenchOptions {
  const switches = ['--e2e', '--production', '--live-free', '--live-openrouter-free', '--live-cloudflare-free', '--free-tier-confirmed'];
  const parameters = ['--openrouter-model', '--cloudflare-account-id', '--port'];
  if (argv.some(value => !switches.includes(value) && !parameters.some(flag => value === flag || value.startsWith(`${flag}=`)))
    || switches.some(flag => argv.filter(value => value === flag).length > 1)) throw new Error('INVALID_WORKBENCH_OPTIONS');
  const e2e = argv.includes('--e2e');
  const port = flagValue(argv, '--port');
  if (port !== undefined && (e2e || !['4318', '4418'].includes(port))) throw new Error('INVALID_WORKBENCH_PORT');
  const production = argv.includes('--production');
  const liveGemini = argv.includes('--live-free');
  const liveOpenRouter = argv.includes('--live-openrouter-free');
  const liveCloudflare = argv.includes('--live-cloudflare-free');
  const openRouterModel = flagValue(argv, '--openrouter-model');
  const cloudflareAccountId = flagValue(argv, '--cloudflare-account-id');
  if ([liveGemini, liveOpenRouter, liveCloudflare].filter(Boolean).length > 1) throw new Error('LIVE_LOCAL_PROVIDER_CONFLICT');
  if (openRouterModel && !liveOpenRouter) throw new Error('OPENROUTER_MODEL_NOT_ALLOWED');
  if (cloudflareAccountId && !liveCloudflare) throw new Error('CLOUDFLARE_ACCOUNT_ID_NOT_ALLOWED');
  const liveProvider = liveGemini ? 'gemini' : liveOpenRouter ? 'openrouter' : liveCloudflare ? 'cloudflare' : undefined;
  if (liveProvider && (e2e || !production || !argv.includes('--free-tier-confirmed'))) {
    throw new Error('LIVE_LOCAL_REQUIRES_PRODUCTION_AND_FREE_CONFIRMATION');
  }
  if (liveProvider === 'openrouter' && (!openRouterModel || !freeModelSchema.safeParse(openRouterModel).success)) {
    throw new Error('OPENROUTER_MODEL_REQUIRED');
  }
  if (liveProvider === 'cloudflare' && (!cloudflareAccountId || cloudflareAccountId.length !== 32 || !/^[a-f0-9]{32}$/.test(cloudflareAccountId))) {
    throw new Error('CLOUDFLARE_ACCOUNT_ID_REQUIRED');
  }
  return { e2e, production, ...(liveProvider ? { liveProvider } : {}), ...(openRouterModel ? { openRouterModel } : {}),
    ...(cloudflareAccountId ? { cloudflareAccountId } : {}), ...(port ? { port: Number(port) as 4318 | 4418 } : {}) };
}
