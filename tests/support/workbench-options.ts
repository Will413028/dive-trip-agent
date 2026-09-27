export type WorkbenchOptions = {
  e2e: boolean;
  production: boolean;
  port?: 4318 | 4418;
};

function flagValue(argv: readonly string[], flag: string): string | undefined {
  const values = argv.filter(value => value === flag || value.startsWith(`${flag}=`))
    .map(value => value === flag ? undefined : value.slice(flag.length + 1));
  if (values.length > 1 || values.some(value => !value)) throw new Error('INVALID_WORKBENCH_OPTIONS');
  return values[0];
}

export function parseWorkbenchOptions(argv: readonly string[]): WorkbenchOptions {
  // Retired live options must fail before database discovery or environment loading.
  const retired = ['--live-free', '--live-openrouter-free', '--live-cloudflare-free',
    '--free-tier-confirmed', '--openrouter-model', '--cloudflare-account-id'];
  if (argv.some(value => retired.some(flag => value === flag || value.startsWith(`${flag}=`)))) {
    throw new Error('WORKBENCH_LIVE_READ_ONLY');
  }
  const switches = ['--e2e', '--production'];
  const parameters = ['--port'];
  if (argv.some(value => !switches.includes(value) && !parameters.some(flag => value === flag || value.startsWith(`${flag}=`)))
    || switches.some(flag => argv.filter(value => value === flag).length > 1)) throw new Error('INVALID_WORKBENCH_OPTIONS');
  const e2e = argv.includes('--e2e');
  const port = flagValue(argv, '--port');
  if (port !== undefined && (e2e || !['4318', '4418'].includes(port))) throw new Error('INVALID_WORKBENCH_PORT');
  const production = argv.includes('--production');
  return { e2e, production, ...(port ? { port: Number(port) as 4318 | 4418 } : {}) };
}
