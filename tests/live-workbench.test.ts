import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';

// Explicit opt-in only. Connects to the already running loopback workbench;
// does not load a credential, start services, retry, or fall back to fixtures.
test('live browser proposal, reload, confirmation and persisted version', {
  skip: process.env.DIVE_TRIP_LIVE_BROWSER !== 'free-tier-confirmed', timeout: 150_000,
}, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ baseURL: 'http://127.0.0.1:4318' });
    const mode = await context.request.get('/api/agent-mode');
    assert.equal(mode.status(), 200);
    assert.equal((await mode.json()).mode, 'gemini');
    const page = await context.newPage();
    let requests = 0;
    page.on('request', req => { if (req.method() === 'POST' && req.url().endsWith('/agent')) requests++; });
    await page.goto('/');
    await page.getByRole('button', { name: '試玩一般規劃' }).click();
    await expect(page.getByTestId('chat-panel')).toContainText('真實 Gemini');
    const tripPath = `/api${new URL(page.url()).pathname}`;
    const before = await (await context.request.get(tripPath)).json();
    await page.getByLabel('想怎麼調整行程？').fill('第二天下午留白。請只移除第二天下午的 transfer 行程項目，其他需求與行程保持不變，提出修改供我確認，尚未確認前不要套用。');
    await page.getByRole('button', { name: '送出訊息', exact: true }).click();
    await expect(page.getByTestId('proposal-panel')).toBeVisible({ timeout: 65_000 });
    await expect(page.locator('.version-box strong')).toHaveText('版本 1');
    await expect(page.getByTestId('entry-transfer')).toBeAttached();
    await page.screenshot({ path: '.artifacts/live-workbench-confirmation.png', fullPage: true });
    assert.equal(requests, 1);
    await page.reload();
    await expect(page.getByTestId('proposal-panel')).toBeVisible();
    assert.equal(requests, 1);
    await page.getByRole('button', { name: '接受修改', exact: true }).click();
    await expect(page.locator('.chat-status').last()).toHaveText('此回合已完成', { timeout: 65_000 });
    await expect(page.locator('.version-box strong')).toHaveText('版本 2');
    await expect(page.getByTestId('entry-transfer')).toHaveCount(0);
    const after = await (await context.request.get(tripPath)).json();
    assert.deepEqual(after.snapshot, { ...before.snapshot,
      entries: before.snapshot.entries.filter((entry: { id: string }) => entry.id !== 'transfer') });
    assert.equal(after.budget.knownMinor, 400000);
    assert.equal(requests, 2);
    await page.reload();
    await expect(page.locator('.version-box strong')).toHaveText('版本 2');
    await expect(page.getByTestId('entry-transfer')).toHaveCount(0);
    await page.screenshot({ path: '.artifacts/live-workbench-accepted.png', fullPage: true });
    assert.equal(requests, 2);
    console.info('LIVE_BROWSER_PROPOSAL_RELOAD_CONFIRMATION_PASS');
  } finally { await browser.close(); }
});
