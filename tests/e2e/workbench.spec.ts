import { test, expect, type Page } from '@playwright/test';

async function tab(page: Page, name: '需求' | '行程') {
  const button = page.getByRole('button', { name, exact: true });
  if (await button.isVisible()) await button.click();
}
async function start(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: '試玩一般規劃' }).click();
  await expect(page).toHaveURL(/\/trips\//);
  await expect(page.getByTestId('entry-stay')).toBeVisible();
}
async function accept(page: Page) {
  const button = page.getByRole('button', { name: '接受修改', exact: true });
  await expect(button).toBeEnabled();
  await button.focus(); await page.keyboard.press('Enter');
  await expect(page.getByTestId('proposal-panel')).toHaveCount(0);
}

test('接受之前不修改行程，重整後版本一致', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '試玩一般規劃' }).click();
  await expect(page).toHaveURL(/\/trips\//);
  const itineraryTab = page.getByRole('button', { name: '行程', exact: true });
  if (await itineraryTab.isVisible()) await itineraryTab.click();
  await page.getByRole('button', { name: '移除 transfer', exact: true }).click();
  await expect(page.getByTestId('proposal-panel')).toBeVisible();
  await expect(page.getByTestId('entry-transfer')).toBeAttached();
  await page.getByRole('button', { name: '接受修改', exact: true }).click();
  await expect(page.getByTestId('entry-transfer')).toHaveCount(0);
  await page.reload();
  if (await itineraryTab.isVisible()) await itineraryTab.click();
  await expect(page.getByTestId('entry-tour')).toBeVisible();
  await expect(page.getByTestId('entry-transfer')).toHaveCount(0);
});

test('拒絕保持原版；中間刪除只顯示受影響活動並移動焦點', async ({ page }) => {
  await start(page);
  await page.getByRole('button', { name: '移除 tour', exact: true }).click();
  const panel = page.getByTestId('proposal-panel');
  await expect(panel).toBeFocused();
  await expect(panel.locator('.diff-list li')).toHaveCount(1);
  await expect(panel.locator('.diff-list')).toContainText('tour');
  await expect(panel.locator('.diff-list')).not.toContainText('transfer');
  await page.getByRole('button', { name: '拒絕修改' }).click();
  await expect(panel).toHaveCount(0);
  await expect(page.getByTestId('entry-tour')).toBeVisible();
  await expect(page.locator('.version-box strong')).toHaveText('版本 1');
});

test('鎖住宿後容量衝突不可套用；手機切換保留未送出輸入', async ({ page }) => {
  await start(page);
  await page.getByRole('button', { name: '鎖定 stay', exact: true }).click();
  await accept(page);
  await expect(page.getByTestId('entry-stay')).toContainText('已鎖定');
  await expect(page.getByRole('button', { name: '移除 stay', exact: true })).toBeDisabled();
  await tab(page, '需求');
  await page.getByLabel('旅客人數', { exact: true }).fill('4');
  await tab(page, '行程'); await tab(page, '需求');
  await expect(page.getByLabel('旅客人數', { exact: true })).toHaveValue('4');
  await page.getByRole('button', { name: '產生需求提案' }).click();
  await expect(page.getByTestId('proposal-panel')).toContainText('CAPACITY');
  await expect(page.getByRole('button', { name: '接受修改', exact: true })).toBeDisabled();
  await expect(page.locator('.version-box strong')).toHaveText('版本 2');
});

test('復原完整舊內容成新版且刷新後仍存在', async ({ page }) => {
  await start(page);
  await page.getByRole('button', { name: '移除 transfer', exact: true }).click();
  await accept(page);
  await page.getByLabel('復原目標版本').fill('1');
  await page.getByRole('button', { name: '復原此版本' }).click();
  await expect(page.locator('.version-box strong')).toHaveText('版本 3');
  await expect(page.getByTestId('entry-transfer')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('entry-transfer')).toBeVisible();
  await expect(page.locator('.version-box strong')).toHaveText('版本 3');
});

test('移動、替換、解鎖與新增皆需確認，使用伺服器總額', async ({ page }) => {
  await start(page);
  await page.getByRole('button', { name: '鎖定 stay', exact: true }).click(); await accept(page);
  await page.getByRole('button', { name: '解鎖 stay', exact: true }).click(); await accept(page);
  await expect(page.getByRole('button', { name: '移除 stay', exact: true })).toBeEnabled();
  const transfer = page.getByTestId('entry-transfer');
  await transfer.locator('summary').click();
  await page.getByRole('combobox', { name: '移動日期 · transfer', exact: true }).selectOption('3');
  await page.getByRole('button', { name: '提出移動 transfer' }).click(); await accept(page);
  await expect(page.locator('.day').filter({ has: page.getByTestId('entry-transfer') }).locator('.day-title')).toContainText('第 3 天');
  const tour = page.getByTestId('entry-tour'); await tour.locator('summary').click();
  await page.getByRole('combobox', { name: '替換項目 · tour', exact: true }).selectOption('dive');
  await page.getByRole('button', { name: '提出替換 tour' }).click(); await accept(page);
  await expect(page.getByTestId('entry-tour')).toContainText('示範潛水活動');
  await page.getByRole('combobox', { name: '新增活動', exact: true }).selectOption('tour');
  await page.getByRole('combobox', { name: '安排日期', exact: true }).selectOption('4');
  await page.getByRole('button', { name: '提出新增活動' }).click(); await accept(page);
  await expect(page.locator('[data-testid^="entry-activity-"]')).toHaveCount(1);
  await expect(page.locator('.version-box strong')).toHaveText('版本 6');
});

test('兩個tab保有各自baseVersion，舊版修改明確409且可刷新', async ({ page, context }) => {
  await start(page);
  const other = await context.newPage();
  await other.goto(page.url()); await expect(other.getByTestId('entry-transfer')).toBeVisible();
  await page.getByRole('button', { name: '移除 transfer', exact: true }).click(); await accept(page);
  await other.getByRole('button', { name: '移除 tour', exact: true }).click();
  await expect(other.getByRole('alert').filter({ hasText: '行程已更新' })).toBeVisible();
  await expect(other.getByTestId('entry-transfer')).toBeVisible();
  await other.getByRole('button', { name: '重新整理行程' }).click();
  await expect(other.locator('.version-box strong')).toHaveText('版本 2');
  await expect(other.getByTestId('entry-transfer')).toHaveCount(0);
  await other.close();
});

test('提交成功但回應遺失時以同ID重試，不建立第三版', async ({ page }) => {
  await start(page);
  const requests: string[] = [];
  await page.route('**/apply', async route => {
    requests.push(route.request().postDataJSON().requestId);
    const response = await route.fetch();
    if (requests.length === 1) await route.abort('failed');
    else await route.fulfill({ response });
  });
  await page.getByRole('button', { name: '移除 transfer', exact: true }).click();
  await page.getByRole('button', { name: '接受修改', exact: true }).click();
  await expect(page.getByRole('button', { name: '重試套用（同一請求）' })).toBeVisible();
  await page.getByRole('button', { name: '重試套用（同一請求）' }).click();
  await expect(page.locator('.version-box strong')).toHaveText('版本 2');
  await expect(page.getByTestId('entry-transfer')).toHaveCount(0);
  expect(requests).toHaveLength(2); expect(requests[0]).toBe(requests[1]);
  await page.reload(); await expect(page.locator('.version-box strong')).toHaveText('版本 2');
});

test('其他瀏覽器session不可讀取，cookie不暴露給JavaScript', async ({ page, browser }) => {
  await start(page);
  expect(await page.evaluate(() => document.cookie)).not.toContain('dive_trip_session');
  const other = await browser.newContext();
  try {
    const otherPage = await other.newPage(); await otherPage.goto(page.url());
    await expect(otherPage.getByRole('alert').filter({ hasText: '找不到可存取' })).toBeVisible();
    await expect(otherPage.getByTestId('entry-stay')).toHaveCount(0);
  } finally { await other.close(); }
});

test('未知費用與地圖降級明示，不宣稱可負擔', async ({ page }) => {
  await start(page);
  // UI-only unknown-cost fixture; persistence behavior has separate real-DB tests.
  await page.route(/\/api\/trips\/[^/]+$/, async route => {
    const response = await route.fetch(); const trip = await response.json();
    trip.snapshot.entries[1].item.price.unitMinor = null;
    trip.snapshot.entries[1].item.price.unknownReason = '待業者確認';
    trip.budget = { knownMinor: 330000, unknownEntryIds: ['tour'], withinBudget: null };
    await route.fulfill({ response, json: trip });
  });
  await page.reload();
  await expect(page.getByTestId('entry-tour')).toContainText('待業者確認');
  await expect(page.getByRole('heading', { name: '位置待確認' })).toBeVisible();
  await tab(page, '需求');
  await expect(page.locator('.budget-panel')).toContainText('尚不能確認全程在預算內');
  await expect(page.locator('.budget-panel')).toContainText('待確認費用');
  await page.unrouteAll({ behavior: 'wait' });
});

test('展示視窗無水平溢出並保留桌面／手機截圖', async ({ page }, info) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.screenshot({ path: info.outputPath('landing.png'), fullPage: true });
  await page.getByRole('button', { name: '試玩一般規劃' }).click();
  await expect(page.getByTestId('entry-stay')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('workbench.png'), fullPage: true });
});
