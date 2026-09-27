import { test, expect } from '@playwright/test';

test('delete requires confirmation, invalidates shares and returns home', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '試玩一般規劃' }).click();
  await expect(page).toHaveURL(/\/trips\//);
  const tripPath = `/api${new URL(page.url()).pathname}`;
  await page.getByRole('button', { name: '預覽分享內容', exact: true }).click();
  await page.getByRole('button', { name: '確認公開並建立連結', exact: true }).click();
  const share = page.getByTestId('created-share-link');
  await expect(share).toBeVisible();
  const link = (await share.getAttribute('href'))!;
  await page.getByRole('button', { name: '刪除此行程', exact: true }).click();
  expect((await page.request.get(tripPath)).status()).toBe(200);
  await page.getByRole('button', { name: '取消刪除', exact: true }).click();
  await expect(page.getByRole('button', { name: '確認永久刪除', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '刪除此行程', exact: true }).click();
  await page.getByRole('button', { name: '確認永久刪除', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  expect((await page.request.get(tripPath)).status()).toBe(404);
  expect((await page.request.get(link)).status()).toBe(404);
});
