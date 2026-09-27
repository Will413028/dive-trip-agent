import { test, expect as baseExpect, type Page } from '@playwright/test';

// Each start/resume boots a real ADK child process and PostgreSQL session.
// UI polling needs a bounded worker-start window, not the default 5s DOM budget.
// Keep the 30s test deadline; this neither retries requests nor extends agent timeouts.
const expect = baseExpect.configure({ timeout: 10_000 });

async function tab(page: Page, name: '對話' | '行程') {
  const button = page.getByRole('button', { name, exact: true });
  if ((page.viewportSize()?.width ?? 1000) <= 760) {
    await expect(button).toBeVisible(); await button.click();
  }
}
async function start(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: '試玩一般規劃' }).click();
  await expect(page).toHaveURL(/\/trips\//);
  await tab(page, '對話');
  await expect(page.getByTestId('chat-panel')).toBeVisible();
}
async function propose(page: Page) {
  await page.getByLabel('想怎麼調整行程？').fill('第二天下午留白');
  await page.getByRole('button', { name: '送出訊息', exact: true }).click();
  await expect(page.getByTestId('proposal-panel')).toBeVisible();
  await expect(page.getByRole('button', { name: '接受修改', exact: true })).toBeEnabled();
}

test('聊天提案確認只經 resume，接受前不改行程', async ({ page }) => {
  const bodies: Record<string, unknown>[] = [];
  let cardWrites = 0;
  page.on('request', request => {
    if (request.method() !== 'POST') return;
    if (/\/agent$/.test(request.url())) bodies.push(request.postDataJSON());
    if (/\/(apply|reject)$/.test(request.url())) cardWrites++;
  });
  await start(page); await propose(page);
  await expect(page.locator('.version-box strong')).toHaveText('版本 1');
  await expect(page.getByTestId('entry-transfer')).toBeAttached();
  await page.getByRole('button', { name: '接受修改', exact: true }).click();
  await expect(page.locator('.version-box strong')).toHaveText('版本 2');
  await expect(page.getByTestId('entry-transfer')).toHaveCount(0);
  await expect(page.getByTestId('chat-panel')).toContainText('資料已保存：修改已套用，版本 2。');
  await page.locator('.chat-history').scrollIntoViewIfNeeded();
  await expect(page.getByText('資料已保存：修改已套用，版本 2。', { exact: true })).toBeInViewport();
  expect(cardWrites).toBe(0);
  expect(bodies).toHaveLength(2);
  expect(bodies[0]).toMatchObject({ messages: [{ role: 'user', content: '第二天下午留白' }], state: {}, tools: [], context: [], forwardedProps: { baseVersion: 1 } });
  expect((bodies[0].messages as unknown[])).toHaveLength(1);
  expect(bodies[1]).toMatchObject({ messages: [], resume: [{ status: 'resolved', payload: { confirmed: true } }] });
  await page.locator('.chat-history').evaluate(element => { element.scrollTop = 0; });
  const reread = page.waitForResponse(response => response.url().endsWith('/runs') && response.request().method() === 'GET');
  await page.getByRole('button', { name: '重新讀取對話狀態', exact: true }).click();
  await reread;
  await expect(page.getByRole('button', { name: '重新讀取對話狀態', exact: true })).toBeEnabled();
  await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  expect(await page.locator('.chat-history').evaluate(element => element.scrollTop)).toBe(0);
  await page.reload();
  await expect(page.locator('.chat-history [data-answer-id]')).toHaveCount(2);
  if ((page.viewportSize()?.width ?? 1000) <= 760) await expect(page.locator('.chat-history')).not.toBeVisible();
  await tab(page, '對話');
  await page.locator('.chat-history').scrollIntoViewIfNeeded();
  await expect(page.getByText('資料已保存：修改已套用，版本 2。', { exact: true })).toBeInViewport();
  await tab(page, '行程');
  await expect(page.getByTestId('entry-transfer')).toHaveCount(0);
  await expect(page.locator('.version-box strong')).toHaveText('版本 2');
});

test('拒絕聊天提案維持原版', async ({ page }) => {
  await start(page); await propose(page);
  await page.getByRole('button', { name: '拒絕修改', exact: true }).click();
  await expect(page.getByTestId('proposal-panel')).toHaveCount(0);
  await expect(page.getByTestId('chat-panel')).toContainText('拒絕決定已保存：修改未套用，行程版本 1。');
  await expect(page.locator('.version-box strong')).toHaveText('版本 1');
  await tab(page, '行程'); await expect(page.getByTestId('entry-transfer')).toBeVisible();
  await page.reload(); await tab(page, '對話');
  await expect(page.getByTestId('chat-panel')).toContainText('第二天下午留白');
  await expect(page.getByTestId('proposal-panel')).toHaveCount(0);
});

test('唯讀工具顯示真實結果並可刷新還原，不產生版本', async ({ page }) => {
  await start(page);
  await page.getByLabel('想怎麼調整行程？').fill('查詢目的地');
  await page.getByRole('button', { name: '送出訊息', exact: true }).click();
  await expect(page.locator('.chat-status').last()).toHaveText('回合處理已結束');
  await expect(page.getByTestId('chat-panel')).toContainText('查詢目的地：已收到工具結果');
  await expect(page.locator('.version-box strong')).toHaveText('版本 1');
  await expect(page.getByTestId('proposal-panel')).toHaveCount(0);
  await page.reload(); await tab(page, '對話');
  await expect(page.getByTestId('chat-panel')).toContainText('查詢目的地：已收到工具結果');
});

test('需求修改先驗證再等待確認，接受後保存並可刷新', async ({ page }) => {
  await start(page);
  await page.getByLabel('想怎麼調整行程？').fill('把行程改為悠閒');
  await page.getByRole('button', { name: '送出訊息', exact: true }).click();
  await expect(page.getByTestId('proposal-panel')).toBeVisible();
  await expect(page.getByTestId('chat-panel')).toContainText('驗證修改：已收到工具結果');
  await expect(page.getByTestId('chat-panel')).toContainText('提出修改：待確認');
  await expect(page.locator('.version-box strong')).toHaveText('版本 1');
  await page.getByRole('button', { name: '接受修改', exact: true }).click();
  await expect(page.locator('.version-box strong')).toHaveText('版本 2');
  await page.reload();
  await expect(page.locator('.version-box strong')).toHaveText('版本 2');
});

test('待確認刷新還原提案，不重新啟動模型', async ({ page }, testInfo) => {
  await start(page); await propose(page);
  let starts = 0;
  page.on('request', request => { if (request.method() === 'POST' && /\/agent$/.test(request.url())) starts++; });
  await page.reload(); await tab(page, '對話');
  await expect(page.getByTestId('proposal-panel')).toBeVisible();
  await expect(page.getByRole('button', { name: '接受修改', exact: true })).toBeEnabled();
  expect(starts).toBe(0);
  await page.screenshot({ path: testInfo.outputPath('chat-confirmation.png'), fullPage: true });
  await tab(page, '行程'); await expect(page.getByRole('button', { name: '移除 transfer', exact: true })).toBeDisabled();
  await tab(page, '對話');
  await page.getByRole('button', { name: '接受修改', exact: true }).click();
  await expect(page.locator('.version-box strong')).toHaveText('版本 2');
});

test('未知訊息回覆說明而不產生修改', async ({ page }) => {
  await start(page);
  await page.getByLabel('想怎麼調整行程？').fill('請幫我安排火星旅行');
  await page.getByRole('button', { name: '送出訊息', exact: true }).click();
  await expect(page.locator('.chat-assistant').first()).toBeVisible();
  await expect(page.locator('.chat-status').last()).toHaveText('回合處理已結束');
  await expect(page.getByTestId('proposal-panel')).toHaveCount(0);
  await expect(page.locator('.version-box strong')).toHaveText('版本 1');
  await expect(page.getByLabel('想怎麼調整行程？')).toHaveValue('');
  await tab(page, '行程'); await expect(page.getByTestId('entry-transfer')).toBeVisible();
});

test('明確409後保留可編輯草稿，不困在同一請求重試', async ({ page }) => {
  await start(page);
  await page.route('**/agent', route => route.fulfill({ status: 409, contentType: 'application/json', body: '{"error":"STALE_VERSION"}' }), { times: 1 });
  await page.getByLabel('想怎麼調整行程？').fill('人數未定');
  await page.getByRole('button', { name: '送出訊息', exact: true }).click();
  await expect(page.getByTestId('chat-panel').getByRole('alert')).toBeVisible();
  await expect(page.getByRole('button', { name: '重試同一聊天請求' })).toHaveCount(0);
  await expect(page.getByLabel('想怎麼調整行程？')).toHaveValue('人數未定');
  await expect(page.getByRole('button', { name: '送出訊息', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '送出訊息', exact: true }).click();
  await expect(page.locator('.chat-assistant').last()).toContainText('幾位旅客');
});

test('聊天草稿跨手機分頁及刷新保留，不自動送出', async ({ page }) => {
  await start(page);
  await page.getByLabel('想怎麼調整行程？').fill('尚未送出的調整');
  await tab(page, '行程'); await tab(page, '對話');
  await expect(page.getByLabel('想怎麼調整行程？')).toHaveValue('尚未送出的調整');
  await page.reload(); await tab(page, '對話');
  await expect(page.getByLabel('想怎麼調整行程？')).toHaveValue('尚未送出的調整');
  await expect(page.locator('.chat-run')).toHaveCount(0);
});

test('聊天不能移除鎖定活動，驗證失敗不產生提案', async ({ page }) => {
  await start(page); await tab(page, '行程');
  await page.getByRole('button', { name: '鎖定 transfer', exact: true }).click();
  await page.getByRole('button', { name: '接受修改', exact: true }).click();
  await expect(page.locator('.version-box strong')).toHaveText('版本 2');
  await tab(page, '對話');
  await page.getByLabel('想怎麼調整行程？').fill('第二天下午留白');
  await page.getByRole('button', { name: '送出訊息', exact: true }).click();
  await expect(page.locator('.chat-assistant').last()).toContainText('鎖定項目');
  await expect(page.locator('.chat-status').last()).toHaveText('回合處理已結束');
  await expect(page.getByTestId('proposal-panel')).toHaveCount(0);
  await expect(page.locator('.version-box strong')).toHaveText('版本 2');
});
