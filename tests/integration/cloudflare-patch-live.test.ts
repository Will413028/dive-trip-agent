import { historyIdentity, withPrivateCloudflareHistory, assertPrivateCloudflareHistory } from '../../evals/cloudflare-history-profile';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { Pool } from 'pg';
import { test } from 'vitest';
import { runCloudflarePatchCampaign, CLOUDFLARE_PATCH_CAMPAIGN_AUTHORIZATION } from '../../evals/cloudflare-patch-campaign';
import { CARRY_SCHEMA } from '../../evals/cloudflare-carry-forward';
import { readCloudflareSecondCarryForward, SECOND_CARRY_SCHEMA } from '../../evals/cloudflare-carry-forward-2';
import { withEvaluationLock, assertEvaluationLock } from '../../evals/live-evaluation-lock';
import { claimPatchCloudflareCampaign } from '../../evals/cloudflare-patch-claim';
import { cloudflareAccountSchema } from '../../src/agent/cloudflare-wire';
import { loadLocalCredential } from '../../src/server/local-credential';
import { createCloudflareCampaignPorts } from '../support/cloudflare-campaign-ports';
import { testDatabaseUrl, withDatabase } from '../support/database';

const authorized = process.env.DIVE_TRIP_CLOUDFLARE_PATCH_EVAL_AUTHORIZATION === CLOUDFLARE_PATCH_CAMPAIGN_AUTHORIZATION;

/** New one-shot authorization only. Default discovery has no IO/model effects.
 * This is ONE newly authorized post-change case, NOT reopening either old batch. */
test.skipIf(!authorized)('partial-patch Cloudflare verification: locked-budget once',
  { timeout: 180_000, retry: 0, repeats: 0 }, async () => withPrivateCloudflareHistory(async () => {
    const accountId = cloudflareAccountSchema.parse(process.env.DIVE_TRIP_CLOUDFLARE_ACCOUNT_ID);
    if (accountId !== historyIdentity('accountId_1')) throw new Error('EVAL_INVALID_HISTORY');
    await withEvaluationLock(async lease => {
      const save = await claimPatchCloudflareCampaign(lease);
      const startedAt = new Date().toISOString();
      // No connectionString: do not re-enable pg environment/passfile fallback.
      const port = Number(new URL(testDatabaseUrl()).port);
      const pool = (schema: string) => new Pool({ host: '127.0.0.1', port, database: 'dive_trip_test',
        user: 'postgres', password: 'offline-placeholder-not-a-credential', ssl: false,
        connectionTimeoutMillis: 2000, statement_timeout: 2000, max: 1,
        options: `-c search_path=${schema}` });
      const workbench = pool('workbench_live'), retained = pool(CARRY_SCHEMA()), second = pool(SECOND_CARRY_SCHEMA());
      try {
        const prior = await readCloudflareSecondCarryForward(workbench, retained, second, lease);
        const source = createHash('sha256');
        for (const path of ['evals/cases.json', 'evals/fixtures.ts', 'evals/collector.ts', 'evals/evidence.ts',
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
          const current = await readCloudflareSecondCarryForward(workbench, retained, second, lease);
          if (!isDeepStrictEqual(prior, current)) throw new Error('EVAL_HISTORY_CHANGED');
          await assertEvaluationLock(lease);
        };
        await withDatabase(async () => {
          const ports = createCloudflareCampaignPorts({ accountId, priorChargedMicros: prior.chargedMicros,
            loadCredential: async () => {
              if (!authorized) throw new Error('EVAL_AUTHORIZATION_REQUIRED');
              await assertPrivateCloudflareHistory();
              await assertEvaluationLock(lease);
              return loadLocalCredential('cloudflare');
            } });
          const report = await runCloudflarePatchCampaign({ accountId, prior, now: Date.now,
            pause: (ms, signal) => delay(ms, undefined, { signal }),
            checkpoint: report => save({ ...report, startedAt, sourceFingerprint }),
            execute: ports.execute,
            checkDispatch: async signal => {
              await verifyHistory(); // full fixed inventory, not just cached arithmetic
              signal.throwIfAborted();
            },
            capture: ports.capture,
          });
          // Remains within schema lifetime; failed final history audit retains it.
          try { await verifyHistory(); }
          catch {
            await save({ ...report, startedAt, sourceFingerprint, stopped: 'HISTORY_CHANGED_STOP' });
            throw new Error('EVAL_HISTORY_CHANGED');
          }
          if (report.stopped) throw new Error('EVAL_CLOUDFLARE_CAMPAIGN_STOPPED');
        }, { retainOnFailure: true });
      } finally { await Promise.all([workbench.end(), retained.end(), second.end()]); }
    });
  }));
