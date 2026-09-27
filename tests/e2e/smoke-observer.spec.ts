import { expect, test } from '@playwright/test';
import { allowedSmokeRequest, cloudflareSmokePrompt } from '../support/cloudflare-smoke-gate';
import { observeSmokePost } from '../support/smoke-browser-observer';

test('smoke observer receives the real browser agent response through a guarded route', async ({ page, context }) => {
  let tripId = '', posts = 0;
  await context.route('**/*', async route => {
    const request = route.request();
    if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/agent')) {
      expect(allowedSmokeRequest(request.postDataJSON(), tripId, posts, 'proposal')).toBe(true);
      posts++;
    }
    await route.continue();
  });
  await page.goto('/');
  await page.getByRole('button', { name: '試玩一般規劃' }).click();
  await page.waitForURL(/\/trips\/[a-f0-9-]+$/);
  tripId = new URL(page.url()).pathname.split('/').at(-1)!;
  if ((page.viewportSize()?.width ?? 1000) <= 760) await page.getByRole('button', { name: '對話', exact: true }).click();
  await page.getByLabel('想怎麼調整行程？').fill(cloudflareSmokePrompt);
  // The long live-only prompt intentionally gets a completed fixture explanation.
  // This test proves terminal observation, not Cloudflare proposal semantics.
  await observeSmokePost(page, tripId, () => page.getByRole('button', { name: '送出訊息', exact: true }).click(), '回合處理已結束');
  expect(posts).toBe(1);
});

test('smoke observer follows fixture proposal, reload and confirmation without resending', async ({ page }) => {
  // Two ADK child-process turns plus two reloads; per-turn production limits stay unchanged.
  test.setTimeout(60_000);
  let posts = 0;
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/agent')) posts++; });
  await page.goto('/');
  await page.getByRole('button', { name: '試玩一般規劃' }).click();
  await page.waitForURL(/\/trips\/[a-f0-9-]+$/);
  const tripId = new URL(page.url()).pathname.split('/').at(-1)!;
  const chatTab = async () => {
    if ((page.viewportSize()?.width ?? 1000) <= 760) await page.getByRole('button', { name: '對話', exact: true }).click();
  };
  await chatTab();
  await page.getByLabel('想怎麼調整行程？').fill('第二天下午留白');
  await observeSmokePost(page, tripId, () => page.getByRole('button', { name: '送出訊息', exact: true }).click(), '待確認');
  await expect(page.getByTestId('proposal-panel')).toBeVisible();
  await page.reload(); await chatTab();
  await expect(page.getByTestId('proposal-panel')).toBeVisible();
  expect(posts).toBe(1);
  await observeSmokePost(page, tripId, () => page.getByRole('button', { name: '接受修改', exact: true }).click(), '回合處理已結束');
  await expect(page.locator('.version-box strong')).toHaveText('版本 2');
  await page.reload(); await expect(page.locator('.version-box strong')).toHaveText('版本 2');
  expect(posts).toBe(2);
});
