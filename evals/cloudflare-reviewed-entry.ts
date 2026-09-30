import { historyIdentity, withPrivateCloudflareHistory, assertPrivateCloudflareHistory } from './cloudflare-history-profile.ts';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { readCloudflareSourceManifest } from './cloudflare-source';
import { isDeepStrictEqual } from 'node:util';
import { Pool } from 'pg';
import { withEvaluationLock, assertEvaluationLock, type EvaluationLockLease } from './live-evaluation-lock';
import { cloudflareAccountSchema } from '../src/agent/cloudflare-wire';
import { loadLocalCredential } from '../src/server/local-credential';
import type { GroundedCloudflareEvaluationCampaign } from '../src/server/agent-policy';
import { withPythonEvaluation } from './python-evaluation.ts';
import { testDatabaseUrl } from '../tests/support/database';
import { writeAtomicCheckpoint, writeImmutableCheckpoint } from './checkpoint';
import type { ReplayBundle } from './replay-bundle';

import type { FiniteCampaignPorts, runFiniteCloudflareCampaign } from './cloudflare-campaign';
type Report = Parameters<typeof runFiniteCloudflareCampaign>[1];
type BaseEntryPolicy<P extends Report['prior']> = {
  stem: 'cloudflare-revision' | 'cloudflare-recovery' | 'cloudflare-grounded' | 'cloudflare-nonthinking' | 'cloudflare-diagnostic' | 'cloudflare-probe' | 'cloudflare-probe-2' | 'cloudflare-probe-3' | 'cloudflare-python-quality' | 'cloudflare-probe-4';
  liveCampaign?: GroundedCloudflareEvaluationCampaign;
  authorizationEnv: string; authorization: string;
  schemas(): readonly string[]; initialReplays: 1 | 2;
  claim(lease: EvaluationLockLease): Promise<(report: unknown) => Promise<void>>;
  readCarry(pools: Pool[], lease: EvaluationLockLease): Promise<P>;
};
type CampaignEntryPorts<R extends Report, P extends Report['prior']> = FiniteCampaignPorts<R> & {
  accountId: string; prior: P; checkDispatch(signal: AbortSignal): Promise<void>;
};
type EntryPolicy<R extends Report, B extends object, P extends Report['prior']> = BaseEntryPolicy<P> & ({
  mode?: 'reviewed';
  runCampaign(ports: CampaignEntryPorts<R, P> & { reviewPreflight(report: R): Promise<boolean> }): Promise<R>;
  reviewBinding(report: R): B;
  waitReview(serialized: string, binding: B, lease: EvaluationLockLease,
    record: (review: unknown, passed: boolean) => Promise<void>): Promise<boolean>;
} | {
  mode: 'technical';
  runCampaign(ports: CampaignEntryPorts<R, P>): Promise<R>;
});

/** Internal lifecycle shared by fixed one-shot policies, not a public runner or
 * caller-supplied authorization capability. Import alone performs no IO. */
export async function runReviewedCloudflareEntry<R extends Report, B extends object, P extends Report['prior']>(policy: EntryPolicy<R, B, P>) {
    const authorized = process.env[policy.authorizationEnv] === policy.authorization;
    if (!authorized) throw new Error('EVAL_AUTHORIZATION_REQUIRED');
    return withPrivateCloudflareHistory(async () => {
    const accountId = cloudflareAccountSchema.parse(process.env.DIVE_TRIP_CLOUDFLARE_ACCOUNT_ID);
    if (accountId !== historyIdentity('accountId_1')) throw new Error('EVAL_INVALID_HISTORY');
    await withEvaluationLock(async lease => {
      const save = await policy.claim(lease);
      const startedAt = new Date().toISOString();
      const replays: { file: string; sha256: string; runId: string; recordedResume: boolean }[] = [];
      let preflightReviewReceipt: { file: string; sha256: string } | undefined;
      // No connectionString: do not re-enable pg environment/passfile fallback.
      const port = Number(new URL(testDatabaseUrl()).port);
      const pool = (schema: string) => new Pool({ host: '127.0.0.1', port, database: 'dive_trip_test',
        user: 'postgres', password: 'offline-placeholder-not-a-credential', ssl: false,
        connectionTimeoutMillis: 2000, statement_timeout: 2000, max: 1,
        options: `-c search_path=${schema}` });
      const pools: Pool[] = [];
      try {
        for (const schema of policy.schemas()) pools.push(pool(schema));
        const prior = await policy.readCarry(pools, lease);
        const sourceManifest = await readCloudflareSourceManifest();
        const sourceFingerprint = sourceManifest.sha256;
        const verifyHistory = async () => {
          await assertPrivateCloudflareHistory();
          const current = await policy.readCarry(pools, lease);
          if (!isDeepStrictEqual(prior, current)) throw new Error('EVAL_HISTORY_CHANGED');
          if (!isDeepStrictEqual(await readCloudflareSourceManifest(), sourceManifest)) throw new Error('EVAL_SOURCE_CHANGED');
          await assertEvaluationLock(lease);
        };
        let replay: ReplayBundle | undefined;
        await withPythonEvaluation({ accountId, priorChargedMicros: prior.chargedMicros,
            databasePort: port, temporalBinary: process.env.DIVE_TRIP_TEMPORAL_BINARY ?? '',
            retention: policy.mode === 'technical' ? 'retain' : 'cleanup',
            ...(policy.liveCampaign ? { liveCampaign: policy.liveCampaign } : {}),
            captureReplay: bundle => { replay = bundle; },
            loadCredential: async () => {
              if (!authorized) throw new Error('EVAL_AUTHORIZATION_REQUIRED');
              await assertPrivateCloudflareHistory();
              await assertEvaluationLock(lease);
              return loadLocalCredential('cloudflare');
            } }, async ports => {
          const campaignPorts = { accountId, prior, now: Date.now,
            pause: (ms, signal) => delay(ms, undefined, { signal }),
            checkpoint: report => save({ ...report, startedAt, sourceFingerprint, sourceManifest, replays, preflightReviewReceipt }),
            execute: (caseId, beforeDispatch) => { replay = undefined; return ports.execute(caseId, beforeDispatch); },
            checkDispatch: async signal => {
              await verifyHistory(); // full fixed inventory, not just cached arithmetic
              signal.throwIfAborted();
            },
            capture: async () => {
              const captured = await ports.capture();
              // Keep preflight plus the first genuinely captured confirmation.
              // Never manufacture a successful resume or send again for filming.
              if (replay && captured.privateUsageComplete && (replays.length < policy.initialReplays
                || (replay.resumeEvents.length && !replays.some(r => r.recordedResume)))) {
                await assertEvaluationLock(lease);
                const runId = replay.afterStart.runs.runs[0].id;
                const file = `${policy.stem}-${runId}.replay.json`;
                const bytes = JSON.stringify(replay, null, 2);
                await writeAtomicCheckpoint(`.artifacts/${file}`, bytes);
                replays.push({ file, sha256: createHash('sha256').update(bytes).digest('hex'), runId,
                  recordedResume: replay.resumeEvents.length > 0 });
              }
              return captured;
            },
          } satisfies CampaignEntryPorts<R, P>;
          const report = policy.mode === 'technical'
            ? await policy.runCampaign(campaignPorts)
            : await policy.runCampaign({ ...campaignPorts, reviewPreflight: async report => {
              const binding = policy.reviewBinding(report);
              const serialized = JSON.stringify({ ...report, startedAt, sourceFingerprint, sourceManifest, replays, preflightReviewReceipt }, null, 2);
              await assertEvaluationLock(lease);
              await writeImmutableCheckpoint(`.artifacts/${policy.stem}-preflight.json`, serialized);
              return policy.waitReview(serialized, binding, lease, async (review, passed) => {
                await assertEvaluationLock(lease);
                const file = `${policy.stem}-preflight-receipt.json`;
                const receipt = JSON.stringify({ sourceFile: `${policy.stem}-preflight.json`,
                  sourceSha256: createHash('sha256').update(serialized).digest('hex'),
                  ...binding, review, passed, recordedAt: new Date().toISOString() }, null, 2);
                await writeImmutableCheckpoint(`.artifacts/${file}`, receipt);
                preflightReviewReceipt = { file, sha256: createHash('sha256').update(receipt).digest('hex') };
              });
            } });
          // Remains within schema lifetime; failed final history audit retains it.
          try { await verifyHistory(); }
          catch {
            await save({ ...report, startedAt, sourceFingerprint, sourceManifest, replays, preflightReviewReceipt, stopped: 'HISTORY_OR_SOURCE_CHANGED_STOP' });
            throw new Error('EVAL_HISTORY_CHANGED');
          }
          if (report.stopped) throw new Error('EVAL_CLOUDFLARE_CAMPAIGN_STOPPED');
        });
      } finally { await Promise.all(pools.map(pool => pool.end())); }
    });
    });
}
