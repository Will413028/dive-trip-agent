import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { Duplex } from 'node:stream';
import { z } from 'zod';
import { CAMPAIGN_BUDGET_MICROS } from './campaign-policy.ts';
import { collectCase, type UsageAudit } from './collector.ts';
import type { CampaignCapture } from './cloudflare-campaign.ts';
import { CLOUDFLARE_MODEL, cloudflareAccountSchema } from '../src/agent/cloudflare-wire.ts';
import type { TripView } from '../src/domain/types.ts';
import type { GroundedCloudflareEvaluationCampaign } from '../src/server/agent-policy.ts';
import { PythonEvaluationChannel } from './python-evaluation-channel.ts';

export type PythonEvaluationOptions = {
  databasePort: number; temporalBinary: string;
  accountId: string; priorChargedMicros: number;
  loadCredential(): Promise<string>;
  liveCampaign?: GroundedCloudflareEvaluationCampaign;
  captureReplay?: Parameters<typeof collectCase>[1]['captureReplay'];
  /** Private harness selection only; always uses SyntheticGeneration and key. */
  synthetic?: boolean;
};
type Ports = {
  execute(caseId: string, beforeDispatch: (signal: AbortSignal) => Promise<void>): ReturnType<typeof collectCase>;
  capture(): Promise<CampaignCapture>;
};
const responseSchema = z.strictObject({ status: z.number().int().min(100).max(599),
  contentType: z.string(), body: z.string() });
const captureSchema = z.object({ chargedMicros: z.number().int().nonnegative(), modelCalls: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative().nullable(), usageKnown: z.boolean(), privateUsageComplete: z.boolean(),
  record: z.record(z.string(), z.unknown()) });

/** Called inside the existing reviewed entry's claim/history/lease lifetime.
 * Failure retains both the uniquely owned schema and persistent Temporal file.
 * No auth, credential discovery, campaign scheduling or history bypass here. */
export async function withPythonEvaluation<T>(options: PythonEvaluationOptions,
  work: (ports: Ports) => Promise<T>): Promise<T> {
  cloudflareAccountSchema.parse(options.accountId);
  const budget = CAMPAIGN_BUDGET_MICROS - options.priorChargedMicros;
  if (!Number.isSafeInteger(budget) || budget <= 0 || !Number.isInteger(options.databasePort)
    || options.databasePort < 1 || options.databasePort > 65535 || !options.temporalBinary) {
    throw new Error('EVAL_PYTHON_CONTEXT_INVALID');
  }
  const root = resolve('.');
  const schema = `python_test_${randomUUID().replaceAll('-', '')}`;
  await mkdir(join(root, '.artifacts'), { recursive: true });
  const storage = await mkdtemp(join(root, '.artifacts/python-evaluation-'));
  await writeFile(join(storage, 'context.json'), JSON.stringify({ schema, databasePort: options.databasePort }), {
    flag: 'wx', mode: 0o600,
  });
  const child = spawn(join(root, 'backend/.venv/bin/python'), [
    '-m', 'dive_trip.bootstrap.evaluation_child', '--database-port', String(options.databasePort),
    '--schema', schema, '--storage', storage, '--temporal-binary', resolve(options.temporalBinary),
    '--account-id', options.accountId, '--budget-micros', String(budget),
    ...(options.synthetic ? ['--synthetic'] : []),
  ], { cwd: root, env: { NODE_ENV: 'test', PATH: process.env.PATH ?? '', PYTHONUNBUFFERED: '1' },
    stdio: ['ignore', 'ignore', 'ignore', 'pipe'] });
  const exited = new Promise<boolean>(resolveExit => {
    child.once('error', () => resolveExit(false));
    child.once('exit', (code, signal) => resolveExit(code === 0 && signal === null));
  });
  const pipe = child.stdio[3];
  if (!(pipe instanceof Duplex)) throw new Error('EVAL_PYTHON_CHANNEL_REQUIRED');
  const channel = new PythonEvaluationChannel(pipe, options.loadCredential);
  let completed = false;
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    const ports: Ports = {
      execute: (caseId, beforeDispatch) => collectCase(caseId, {
        model: CLOUDFLARE_MODEL, faultSupported: true, captureReplay: options.captureReplay,
        setup: async (input, signal) => await channel.call('setup', {
          before: input.before, catalog: input.catalog, fault: input.fault,
        }, { signal }) as TripView,
        request: async (path, body, signal) => {
          const agent = path.endsWith('/agent');
          if (agent) await beforeDispatch(signal);
          signal.throwIfAborted();
          const start = agent && typeof body === 'object' && body !== null && !('resume' in body);
          const response = responseSchema.parse(await channel.call('request', { path, body: body ?? null }, {
            signal, generation: start,
          }));
          return new Response(response.body, { status: response.status, headers: { 'content-type': response.contentType } });
        },
        audit: async (runId, signal) => await channel.call('audit', { runId }, { signal }) as UsageAudit,
      }),
      capture: async () => {
        const captured = captureSchema.parse(await channel.call('capture', {}));
        return { ...captured, record: { ...captured.record, retainedSchema: schema,
          temporalStorage: relative(root, join(storage, 'temporal.sqlite')) } };
      },
    };
    const result = await work(ports);
    await channel.call('finish', { cleanup: true });
    completed = true;
    outcome = { ok: true, value: result };
  } catch (error) {
    outcome = { ok: false, error };
  } finally {
    if (!completed) {
      try { await channel.call('finish', { cleanup: false }); } catch { /* Preserve owned storage. */ }
    }
    channel.close();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const stopped = await Promise.race([exited, new Promise<false>(resolveStop => {
      deadline = setTimeout(() => { child.kill('SIGTERM'); resolveStop(false); }, 115_000);
    })]);
    clearTimeout(deadline);
    if (!completed || !stopped) console.error('EVALUATION_STORAGE_CHECK_REQUIRED', schema, relative(root, storage));
    if (!stopped) outcome = { ok: false, error: new Error('EVAL_PYTHON_DRAIN_UNVERIFIED') };
  }
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}
