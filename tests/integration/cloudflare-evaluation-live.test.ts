import { historyIdentity, withPrivateCloudflareHistory } from '../../evals/cloudflare-history-profile';
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, readdir, unlink } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'vitest';
import { runCloudflareCampaign, CLOUDFLARE_CAMPAIGN_AUTHORIZATION } from '../../evals/cloudflare-campaign';
import { readCloudflareCampaignBaseline } from '../../evals/cloudflare-campaign-history';
import { writeAtomicCheckpoint } from '../../evals/checkpoint';
import { campaignPreflight } from '../../evals/campaign-policy';
import { maximumProviderModelCost } from '../../src/server/model-cost';
import { CLOUDFLARE_MODEL, cloudflareAccountSchema } from '../../src/agent/cloudflare-wire';
import { makePool } from '../../src/server/db';
import { loadLocalCredential } from '../../src/server/local-credential';
import { testDatabaseUrl, withDatabase } from '../support/database';
import { createCloudflareCampaignPorts } from '../support/cloudflare-campaign-ports';

const authorized = process.env.DIVE_TRIP_CLOUDFLARE_EVAL_AUTHORIZATION === CLOUDFLARE_CAMPAIGN_AUTHORIZATION;

/** First campaign only. Default discovery must not access credentials, DB or artifacts.
 * A retained claim is single-use even if preflight fails; never delete it to retry.
 * Authorization must be newly granted for this batch, not inherited from a smoke. */
test.skipIf(!authorized)('first bounded Cloudflare HTTP evaluation with pending human review',
  { timeout: 1_800_000, retry: 0, repeats: 0 }, async () => withPrivateCloudflareHistory(async () => {
    const accountId = cloudflareAccountSchema.parse(process.env.DIVE_TRIP_CLOUDFLARE_ACCOUNT_ID);
    if (accountId !== historyIdentity('accountId_1')) throw new Error('EVAL_INVALID_HISTORY');
    const binding = { provider: 'cloudflare', model: CLOUDFLARE_MODEL, accountId } as const;
    await mkdir('.artifacts', { recursive: true });
    const lockPath = '.artifacts/live-evaluation.lock';
    const lock = await open(lockPath, 'wx', 0o600);
    const reportPath = '.artifacts/cloudflare-evaluation-1.json';
    try {
      if ((await readdir('.artifacts')).some(name => /^cloudflare-evaluation-.*\.(claim|json)$/.test(name))) {
        throw new Error('EVAL_CLOUDFLARE_CAMPAIGN_ALREADY_CLAIMED');
      }
      const claim = await open('.artifacts/cloudflare-evaluation-1.claim', 'wx', 0o600);
      try { await claim.sync(); } finally { await claim.close(); }
      const startedAt = new Date().toISOString();
      await writeAtomicCheckpoint(reportPath, JSON.stringify({ ...binding, startedAt,
        stopped: 'PREFLIGHT_PENDING', textReview: 'pending', evaluationGatePassed: false, records: [] }));
      const baselinePool = makePool(testDatabaseUrl(), 'workbench_live');
      const baseline = await readCloudflareCampaignBaseline(baselinePool, accountId)
        .finally(() => baselinePool.end());
      campaignPreflight(baseline, maximumProviderModelCost('cloudflare'));
      const source = createHash('sha256');
      for (const path of ['evals/cases.json', 'evals/fixtures.ts', 'evals/collector.ts', 'evals/evidence.ts',
        'evals/cloudflare-campaign.ts', 'evals/cloudflare-campaign-history.ts', 'evals/cloudflare-campaign-drain.ts',
        'evals/usage.ts', 'evals/usage-evidence.ts',
        'src/agent/prompt.ts', 'src/agent/tools.ts', 'src/agent/tool-schemas.ts', 'src/agent/worker.ts',
        'src/agent/runtime.ts', 'src/agent/unary-rest-model.ts', 'src/agent/cloudflare-provider.ts',
        'src/agent/cloudflare-wire.ts', 'src/server/agent-policy.ts',
        'src/server/chat-http.ts', 'src/server/model-cost.ts', 'tests/support/cloudflare-audit-database.ts',
        'tests/support/cloudflare-smoke-audit.ts', 'tests/support/cloudflare-campaign-ports.ts',
        'tests/integration/cloudflare-evaluation-live.test.ts']) {
        source.update(path).update(await readFile(path));
      }
      const sourceFingerprint = source.digest('hex');
      await withDatabase(async () => {
        const ports = createCloudflareCampaignPorts({ accountId, priorChargedMicros: baseline.chargedMicros,
          loadCredential: () => {
            if (!authorized) throw new Error('EVAL_AUTHORIZATION_REQUIRED');
            return loadLocalCredential('cloudflare');
          },
        });
        const report = await runCloudflareCampaign({ accountId, prior: baseline, now: Date.now,
          ...ports,
          pause: (ms, signal) => delay(ms, undefined, { signal }),
          checkpoint: report => writeAtomicCheckpoint(reportPath, JSON.stringify({ ...report, startedAt,
            sourceFingerprint, history: baseline.history }, null, 2)),
        });
        // All stopped batches retain their isolated schema, including exported
        // unknown usage. Never let a cancelled worker race successful cleanup.
        if (report.stopped) throw new Error('EVAL_CLOUDFLARE_CAMPAIGN_STOPPED');
      }, { retainOnFailure: true });
    } finally {
      await lock.close();
      await unlink(lockPath); // Only the lock opened above; persistent claim/report remain.
    }
  }));
