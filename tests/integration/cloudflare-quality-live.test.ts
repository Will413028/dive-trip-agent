import { historyIdentity, withPrivateCloudflareHistory, assertPrivateCloudflareHistory } from '../../evals/cloudflare-history-profile';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { Pool } from 'pg';
import { test } from 'vitest';
import { runCloudflareQualityCampaign, QUALITY_AUTHORIZATION } from '../../evals/cloudflare-quality-campaign';
import { CARRY_SCHEMA } from '../../evals/cloudflare-carry-forward';
import { SECOND_CARRY_SCHEMA } from '../../evals/cloudflare-carry-forward-2';
import { withEvaluationLock, assertEvaluationLock } from '../../evals/live-evaluation-lock';
import { claimCloudflareQualityCampaign } from '../../evals/cloudflare-quality-claim';
import { cloudflareAccountSchema } from '../../src/agent/cloudflare-wire';
import { loadLocalCredential } from '../../src/server/local-credential';
import { createCloudflareCampaignPorts } from '../support/cloudflare-campaign-ports';
import { testDatabaseUrl, withDatabase } from '../support/database';
import { readCloudflarePatchCarry } from '../../evals/cloudflare-patch-carry';
import { awaitCloudflarePreflightReview } from '../../evals/cloudflare-preflight-review';
import { writeAtomicCheckpoint, writeImmutableCheckpoint } from '../../evals/checkpoint';
import type { ReplayBundle } from '../../evals/replay-bundle';

const authorized = process.env.DIVE_TRIP_CLOUDFLARE_QUALITY_AUTHORIZATION === QUALITY_AUTHORIZATION;

/** New one-shot authorization only. Default discovery has no IO/model effects.
 * This is one preflight plus 30 cases, never reopening a consumed batch. */
test.skipIf(!authorized)('budget disclosure preflight followed by 30 Cloudflare cases once',
  { timeout: 2_400_000, retry: 0, repeats: 0 }, async () => withPrivateCloudflareHistory(async () => {
    const accountId = cloudflareAccountSchema.parse(process.env.DIVE_TRIP_CLOUDFLARE_ACCOUNT_ID);
    if (accountId !== historyIdentity('accountId_1')) throw new Error('EVAL_INVALID_HISTORY');
    await withEvaluationLock(async lease => {
      const save = await claimCloudflareQualityCampaign(lease);
      const startedAt = new Date().toISOString();
      const replays: { file: string; sha256: string; runId: string; recordedResume: boolean }[] = [];
      let preflightReviewReceipt: { file: string; sha256: string } | undefined;
      // No connectionString: do not re-enable pg environment/passfile fallback.
      const port = Number(new URL(testDatabaseUrl()).port);
      const pool = (schema: string) => new Pool({ host: '127.0.0.1', port, database: 'dive_trip_test',
        user: 'postgres', password: 'offline-placeholder-not-a-credential', ssl: false,
        connectionTimeoutMillis: 2000, statement_timeout: 2000, max: 1,
        options: `-c search_path=${schema}` });
      const workbench = pool('workbench_live'), retained = pool(CARRY_SCHEMA()), second = pool(SECOND_CARRY_SCHEMA());
      try {
        const prior = await readCloudflarePatchCarry(workbench, retained, second, lease);
        const source = createHash('sha256');
        for (const path of ['src/agent/budget-evidence.ts', 'evals/cloudflare-artifacts.ts', 'evals/pinned-cloudflare-report.ts', 'evals/replay-bundle.ts',
          'evals/cloudflare-quality-campaign.ts', 'evals/cloudflare-quality-claim.ts', 'evals/cloudflare-patch-carry.ts',
          'evals/cloudflare-preflight-review.ts', 'tests/integration/cloudflare-quality-live.test.ts', 'evals/cases.json', 'evals/fixtures.ts', 'evals/collector.ts', 'evals/evidence.ts',
          'evals/cloudflare-campaign.ts', 'evals/cloudflare-patch-campaign.ts', 'evals/cloudflare-carry-forward.ts', 'evals/cloudflare-carry-forward-2.ts',
          'evals/cloudflare-campaign-history.ts', 'evals/cloudflare-campaign-drain.ts', 'evals/cloudflare-patch-claim.ts',
          'evals/live-evaluation-lock.ts', 'evals/checkpoint.ts', 'evals/usage.ts', 'evals/usage-evidence.ts',
          'src/agent/prompt.ts', 'src/agent/tools.ts', 'src/agent/tool-schemas.ts', 'src/agent/worker.ts',
          'src/agent/runtime.ts', 'src/agent/model-guard.ts', 'src/agent/tool-diagnostic.ts',
          'src/agent/unary-rest-model.ts', 'src/agent/cloudflare-provider.ts', 'src/agent/cloudflare-wire.ts',
          'src/server/agent-policy.ts', 'src/server/agent-admission.ts', 'src/server/quota.ts',
          'src/server/chat-http.ts', 'src/server/model-cost.ts', 'tests/support/cloudflare-audit-database.ts',
          'tests/support/cloudflare-smoke-audit.ts', 'tests/support/cloudflare-campaign-ports.ts',
          'tests/integration/cloudflare-patch-live.test.ts']) {
          source.update(path).update(await readFile(path));
        }
        const sourceFingerprint = source.digest('hex');
        const verifyHistory = async () => {
          await assertPrivateCloudflareHistory();
          const current = await readCloudflarePatchCarry(workbench, retained, second, lease);
          if (!isDeepStrictEqual(prior, current)) throw new Error('EVAL_HISTORY_CHANGED');
          await assertEvaluationLock(lease);
        };
        await withDatabase(async () => {
          let replay: ReplayBundle | undefined;
          const ports = createCloudflareCampaignPorts({ accountId, priorChargedMicros: prior.chargedMicros,
            captureReplay: bundle => { replay = bundle; },
            loadCredential: async () => {
              if (!authorized) throw new Error('EVAL_AUTHORIZATION_REQUIRED');
              await assertPrivateCloudflareHistory();
              await assertEvaluationLock(lease);
              return loadLocalCredential('cloudflare');
            } });
          const report = await runCloudflareQualityCampaign({ accountId, prior, now: Date.now,
            pause: (ms, signal) => delay(ms, undefined, { signal }),
            checkpoint: report => save({ ...report, startedAt, sourceFingerprint, replays, preflightReviewReceipt }),
            execute: (caseId, beforeDispatch) => { replay = undefined; return ports.execute(caseId, beforeDispatch); },
            reviewPreflight: async report => {
              const first = report.records.find((r): r is { evidence: { runId: string } } =>
                !!r && typeof r === 'object' && 'evidence' in r);
              if (!first) return false;
              const serialized = JSON.stringify({ ...report, startedAt, sourceFingerprint, replays, preflightReviewReceipt }, null, 2);
              await assertEvaluationLock(lease);
              await writeImmutableCheckpoint('.artifacts/cloudflare-quality-preflight.json', serialized);
              return awaitCloudflarePreflightReview(serialized, first.evidence.runId, lease, async (review, passed) => {
                await assertEvaluationLock(lease);
                const file = 'cloudflare-quality-preflight-receipt.json';
                const receipt = JSON.stringify({ sourceFile: 'cloudflare-quality-preflight.json',
                  sourceSha256: createHash('sha256').update(serialized).digest('hex'),
                  runId: first.evidence.runId, review, passed, recordedAt: new Date().toISOString() }, null, 2);
                await writeImmutableCheckpoint(`.artifacts/${file}`, receipt);
                preflightReviewReceipt = { file, sha256: createHash('sha256').update(receipt).digest('hex') };
              });
            },
            checkDispatch: async signal => {
              await verifyHistory(); // full fixed inventory, not just cached arithmetic
              signal.throwIfAborted();
            },
            capture: async () => {
              const captured = await ports.capture();
              // Keep preflight plus the first genuinely captured confirmation.
              // Never manufacture a successful resume or send again for filming.
              if (replay && captured.privateUsageComplete && (!replays.length
                || (replay.resumeEvents.length && !replays.some(r => r.recordedResume)))) {
                await assertEvaluationLock(lease);
                const runId = replay.afterStart.runs.runs[0].id;
                const file = `cloudflare-quality-${runId}.replay.json`;
                const bytes = JSON.stringify(replay, null, 2);
                await writeAtomicCheckpoint(`.artifacts/${file}`, bytes);
                replays.push({ file, sha256: createHash('sha256').update(bytes).digest('hex'), runId,
                  recordedResume: replay.resumeEvents.length > 0 });
              }
              return captured;
            },
          });
          // Remains within schema lifetime; failed final history audit retains it.
          try { await verifyHistory(); }
          catch {
            await save({ ...report, startedAt, sourceFingerprint, replays, preflightReviewReceipt, stopped: 'HISTORY_CHANGED_STOP' });
            throw new Error('EVAL_HISTORY_CHANGED');
          }
          if (report.stopped) throw new Error('EVAL_CLOUDFLARE_CAMPAIGN_STOPPED');
        }, { retainOnFailure: true });
      } finally { await Promise.all([workbench.end(), retained.end(), second.end()]); }
    });
  }));
