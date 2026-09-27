import { historyIdentity, withPrivateCloudflareHistory } from '../evals/cloudflare-history-profile.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';
import { makePool } from '../src/server/db.ts';
import { CLOUDFLARE_MODEL, cloudflareAccountSchema } from '../src/agent/cloudflare-wire.ts';
import { testDatabaseUrl } from './support/database.ts';
import { writeAtomicCheckpoint } from '../evals/checkpoint.ts';
import { auditCloudflareSmoke } from './support/cloudflare-smoke-audit.ts';
import { allowedSmokeRequest, cloudflareSmokePrompt, type SmokeConfirmation } from './support/cloudflare-smoke-gate.ts';
import { observeSmokePost } from './support/smoke-browser-observer.ts';

async function bounded<T>(work: Promise<T>, milliseconds = 70_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('CLOUDFLARE_SMOKE_TIMEOUT')), milliseconds);
  })]); } finally { clearTimeout(timer); }
}

// One explicit authorization, one persistent claim. Never delete the claim to retry.
// Connects only to an operator-started production Cloudflare loopback workbench.
test('single Cloudflare browser proposal, reload, approval and durable usage', {
  skip: process.env.DIVE_TRIP_CLOUDFLARE_SMOKE !== 'third-run-seven-calls-authorized', timeout: 240_000,
}, async () => withPrivateCloudflareHistory(async () => {
  const accountId = cloudflareAccountSchema.parse(process.env.CLOUDFLARE_ACCOUNT_ID);
  if (accountId !== historyIdentity('accountId_1')) throw new Error('EVAL_INVALID_HISTORY');
  const baseURL = 'http://127.0.0.1:4418';
  const artifactStem = '.artifacts/cloudflare-product-smoke-3';
  const reportPath = `${artifactStem}.json`;
  const pool = makePool(testDatabaseUrl(), 'workbench_live');
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let claim: Awaited<ReturnType<typeof open>> | undefined;
  let tripId = '', requests = 0, blocked = false;
  let phase = 'preflight';
  let confirmation: SmokeConfirmation | undefined;
  const report: Record<string, unknown> = { provider: 'cloudflare', model: CLOUDFLARE_MODEL,
    attempt: 3, startedAt: new Date().toISOString(), status: 'pending', maxModelCalls: 7,
    modelQualityAccepted: false, privateUsageComplete: false };
  const save = () => writeAtomicCheckpoint(reportPath, JSON.stringify({ ...report, phase, tripId, agentPosts: requests, blocked }, null, 2));
  try {
    const location = (await pool.query('SELECT current_database() AS db,current_schema() AS schema')).rows[0];
    assert.deepEqual(location, { db: 'dive_trip_test', schema: 'workbench_live' });
    // Do not erase/ignore a previous Cloudflare unknown reservation by making a new trip.
    const unknown = await pool.query(`SELECT i.id FROM agent_invocations i JOIN quota_reservations q
      ON q.id=i.reservation_id WHERE i.provider='cloudflare' AND
      (i.status<>'settled' OR q.actual_cost_micros IS NULL)`);
    assert.equal(unknown.rowCount, 0);
    const prior = await open('.artifacts/cloudflare-gemma26b-smoke.json', constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await prior.stat();
      assert.ok(stat.isFile() && stat.size <= 65536);
      const evidence = JSON.parse(await prior.readFile('utf8'));
      assert.equal(evidence.status, 'tool-call-passed');
      assert.equal(evidence.model, CLOUDFLARE_MODEL);
      assert.equal(evidence.calls, 1);
      assert.deepEqual(evidence.usage, { prompt_tokens: 160, completion_tokens: 229, total_tokens: 389 });
      report.priorDirectSmoke = { modelCalls: 1, totalTokens: 389 };
    } finally { await prior.close(); }
    // Carry forward both prior attempts, including their complete private usage.
    // Its report/claim/quota are never overwritten, deleted or treated as zero.
    const previousFile = await open('.artifacts/cloudflare-product-smoke.json', constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await previousFile.stat();
      assert.ok(stat.isFile() && stat.size <= 65536);
      const source = await previousFile.readFile('utf8');
      const previous = JSON.parse(source);
      assert.equal(previous.provider, 'cloudflare'); assert.equal(previous.model, CLOUDFLARE_MODEL);
      assert.equal(previous.status, 'stopped'); assert.equal(previous.phase, 'proposal');
      assert.equal(previous.privateUsageComplete, true);
      const previousAudit = await auditCloudflareSmoke(pool, previous.tripId, accountId);
      assert.deepEqual(previousAudit, previous.audit);
      assert.equal(previousAudit.complete, true); assert.equal(previousAudit.modelCalls, 2);
      assert.equal(previousAudit.tokens?.totalTokens, 8871);
      assert.equal(previous.cumulativeModelCallsIncludingDirectSmoke, 3);
      assert.equal(previous.cumulativeTokensIncludingDirectSmoke, 9260);
      report.priorProductSmoke = { reportPath: '.artifacts/cloudflare-product-smoke.json',
        sha256: createHash('sha256').update(source).digest('hex'), modelCalls: 2, totalTokens: 8871 };
      report.priorCumulative = { modelCalls: 3, totalTokens: 9260 };
    } finally { await previousFile.close(); }
    const secondFile = await open('.artifacts/cloudflare-product-smoke-2.json', constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await secondFile.stat();
      assert.ok(stat.isFile() && stat.size <= 65536);
      const source = await secondFile.readFile('utf8');
      const previous = JSON.parse(source);
      assert.equal(previous.provider, 'cloudflare'); assert.equal(previous.model, CLOUDFLARE_MODEL);
      assert.equal(previous.attempt, 2); assert.equal(previous.status, 'passed');
      assert.equal(previous.phase, 'complete'); assert.equal(previous.privateUsageComplete, true);
      const previousAudit = await auditCloudflareSmoke(pool, previous.tripId, accountId);
      assert.deepEqual(previousAudit, previous.audit);
      assert.equal(previousAudit.complete, true); assert.equal(previousAudit.modelCalls, 3);
      assert.equal(previousAudit.tokens?.totalTokens, 13603);
      assert.equal(previous.cumulativeModelCallsIncludingDirectSmoke, 6);
      assert.equal(previous.cumulativeTokensIncludingDirectSmoke, 22863);
      report.priorSecondProductSmoke = { reportPath: '.artifacts/cloudflare-product-smoke-2.json',
        sha256: createHash('sha256').update(source).digest('hex'), modelCalls: 3, totalTokens: 13603 };
      report.priorCumulative = { modelCalls: 6, totalTokens: 22863 };
    } finally { await secondFile.close(); }
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ baseURL, serviceWorkers: 'block' });
    context.setDefaultTimeout(10_000);
    const mode = await context.request.get('/api/agent-mode', { timeout: 10_000 });
    assert.equal(mode.status(), 200);
    assert.equal((await mode.json()).mode, 'cloudflare');
    // Claim is durable before creating the synthetic trip or sending a model request.
    claim = await open(`${artifactStem}.claim`, 'wx', 0o600);
    await claim.writeFile(JSON.stringify({ startedAt: report.startedAt, maxModelCalls: 7 }));
    await claim.sync();
    await save();
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== baseURL) { blocked = true; await route.abort(); return; }
      if (request.method() === 'POST' && url.pathname.endsWith('/agent')) {
        let body: unknown;
        try { body = request.postDataJSON(); } catch { /* Rejected below. */ }
        if (!tripId || url.pathname !== `/api/trips/${tripId}/agent` || blocked
          || !allowedSmokeRequest(body, tripId, requests, phase, confirmation)) {
          blocked = true; await route.abort(); return;
        }
        requests++;
      }
      await route.continue();
    });
    const page = await context.newPage();
    const getTrip = async () => {
      const response = await context.request.get(`/api/trips/${tripId}`, { timeout: 10_000 });
      assert.equal(response.status(), 200); return response.json();
    };
    const check = async (expectedPosts: number) => {
      assert.equal(blocked, false); assert.equal(requests, expectedPosts);
      const audit = await auditCloudflareSmoke(pool, tripId, accountId);
      report.audit = audit; report.privateUsageComplete = audit.complete;
      report.cumulativeModelCallsIncludingDirectSmoke = 6 + audit.modelCalls;
      report.cumulativeTokensIncludingDirectSmoke = audit.tokens ? 22863 + audit.tokens.totalTokens : null;
      await save(); assert.equal(audit.complete, true); return audit;
    };
    await page.goto('/');
    await page.getByRole('button', { name: '試玩一般規劃' }).click();
    await page.waitForURL(/\/trips\/[a-f0-9-]+$/);
    tripId = new URL(page.url()).pathname.split('/').at(-1)!;
    const before = await getTrip();
    assert.equal(before.version, 1);
    const expectedSnapshot = { ...before.snapshot,
      entries: before.snapshot.entries.filter((entry: { id: string }) => entry.id !== 'transfer') };
    phase = 'proposal'; await save();
    await page.getByLabel('想怎麼調整行程？').fill(cloudflareSmokePrompt);
    await observeSmokePost(page, tripId, () => page.getByRole('button', { name: '送出訊息', exact: true }).click(), '待確認');
    await page.getByTestId('proposal-panel').waitFor();
    const first = await check(1);
    assert.ok(first.modelCalls < 7, 'CLOUDFLARE_SMOKE_NO_RESUME_BUDGET');
    assert.deepEqual((await getTrip()).snapshot, before.snapshot);
    assert.equal((await getTrip()).version, 1);
    // The test operator approves only the exact synthetic change requested above.
    const proposals = await pool.query(`SELECT p.draft,r.id,r.interrupt_id FROM proposals p JOIN agent_runs r
      ON r.proposal_id=p.id AND r.trip_id=p.trip_id WHERE r.trip_id=$1 AND r.status='awaiting_confirmation'`, [tripId]);
    assert.equal(proposals.rowCount, 1);
    assert.equal(proposals.rows[0].draft.canApply, true);
    assert.deepEqual(proposals.rows[0].draft.changes, [{ kind: 'remove', entryId: 'transfer' }]);
    assert.deepEqual(proposals.rows[0].draft.next, expectedSnapshot);
    assert.equal(first.runId, proposals.rows[0].id);
    assert.ok(typeof proposals.rows[0].interrupt_id === 'string' && proposals.rows[0].interrupt_id.length > 0);
    confirmation = { runId: proposals.rows[0].id, interruptId: proposals.rows[0].interrupt_id };
    phase = 'reload-before-confirmation';
    await page.reload(); await page.getByTestId('proposal-panel').waitFor();
    assert.deepEqual(await check(1), first);
    await page.screenshot({ path: `${artifactStem}-confirmation.png`, fullPage: true });
    phase = 'confirmation'; await save();
    await observeSmokePost(page, tripId, () => page.getByRole('button', { name: '接受修改', exact: true }).click(), '回合處理已結束');
    await expect(page.locator('.chat-status').last()).toHaveText('此回合已完成', { timeout: 10_000 });
    const after = await getTrip();
    assert.equal(after.version, 2);
    assert.deepEqual(after.snapshot, expectedSnapshot);
    assert.equal(after.budget.knownMinor, 400000);
    const finalAudit = await check(2);
    const terminal = await pool.query('SELECT status,decision FROM agent_runs WHERE trip_id=$1', [tripId]);
    assert.deepEqual(terminal.rows, [{ status: 'succeeded', decision: true }]);
    phase = 'reload-after-confirmation';
    await page.reload();
    assert.deepEqual(await getTrip(), after);
    assert.deepEqual(await check(2), finalAudit);
    await page.screenshot({ path: `${artifactStem}-accepted.png`, fullPage: true });
    report.status = 'passed'; phase = 'complete'; await save();
  } catch {
    report.status = 'stopped';
    blocked = true;
    let browserClosed = !browser;
    if (browser) {
      try { await bounded(browser.close(), 10_000); browserClosed = true; browser = undefined; }
      catch { /* Cannot claim quiescence if browser cancellation did not complete. */ }
    }
    // Never copy raw provider/browser errors into logs or reports.
    if (claim) {
      if (tripId) {
        try {
          const deadline = Date.now() + 65_000;
          let audit = await auditCloudflareSmoke(pool, tripId, accountId);
          while (requests > 0 && Date.now() < deadline && (audit.invocations.length < requests
            || audit.invocations.some(invocation => !invocation.settled))) {
            await delay(500); audit = await auditCloudflareSmoke(pool, tripId, accountId);
          }
          report.audit = audit;
          report.privateUsageComplete = browserClosed && audit.complete && audit.invocations.length === requests;
          report.cumulativeModelCallsIncludingDirectSmoke = 6 + audit.modelCalls;
          report.cumulativeTokensIncludingDirectSmoke = audit.tokens ? 22863 + audit.tokens.totalTokens : null;
        } catch { report.privateUsageComplete = false; }
      }
      await save();
    }
    throw new Error('CLOUDFLARE_PRODUCT_SMOKE_STOPPED');
  } finally {
    if (browser) await bounded(browser.close(), 10_000).catch(() => undefined);
    await claim?.close(); await pool.end();
  }
}));
