import { expect, test } from '@playwright/test';

// Presentation-only fixture: server remains offline. This does NOT validate live transport.
test('Cloudflare mode shows the synthetic-data disclosure without exposing account or token', async ({ page }) => {
  await page.route('**/api/agent-mode', route => route.fulfill({ json: { mode: 'cloudflare' } }));
  await page.goto('/');
  await page.getByRole('button', { name: '試玩一般規劃' }).click();
  await expect(page).toHaveURL(/\/trips\//);
  if ((page.viewportSize()?.width ?? 1000) <= 760) await page.getByRole('button', { name: '對話', exact: true }).click();
  const panel = page.getByTestId('chat-panel');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('Cloudflare Workers AI · 合成資料 DEMO');
  await expect(panel).toContainText('請勿輸入個資或機密');
  await expect(panel).not.toContainText('CLOUDFLARE_API_TOKEN');
  await expect(panel).not.toContainText('CLOUDFLARE_ACCOUNT_ID');
  await expect(page.getByLabel('想怎麼調整行程？')).toBeEnabled();
});
