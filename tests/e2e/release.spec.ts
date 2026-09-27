import { test, expect } from '@playwright/test';

test.use({ video: { mode: 'on', size: { width: 1280, height: 900 } } });

test('three demo entry points are isolated and clearly label the static fault fixture', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '試玩預算衝突' }).click();
  await expect(page.getByText('提案無法套用；原行程與住宿鎖定保持不變。', { exact: true })).toBeVisible();
  await page.goto('/');
  await page.getByRole('button', { name: '查看查詢失敗示範' }).click();
  await expect(page.getByText('以下為預先撰寫的示例，並非模型回覆或實際查詢結果。', { exact: true })).toBeVisible();
});

test.describe('portfolio recording (explicit fixture mode)', () => {
  test('record lock, partial change, restore and share', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', 'One desktop portfolio recording');
    await page.goto('/');
    await page.getByRole('button', { name: '試玩一般規劃' }).click();
    await expect(page).toHaveURL(/\/trips\//);
    await page.getByRole('button', { name: '鎖定 stay', exact: true }).click();
    await page.getByRole('button', { name: '接受修改', exact: true }).click();
    await expect(page.locator('.version-box strong')).toHaveText('版本 2');
    await page.getByLabel('想怎麼調整行程？').fill('第二天下午留白');
    await page.getByRole('button', { name: '送出訊息', exact: true }).click();
    await expect(page.getByTestId('proposal-panel')).toBeVisible();
    await page.getByRole('button', { name: '接受修改', exact: true }).click();
    await expect(page.locator('.version-box strong')).toHaveText('版本 3');
    await page.getByLabel('復原目標版本').fill('2');
    await page.getByRole('button', { name: '復原此版本', exact: true }).click();
    await expect(page.locator('.version-box strong')).toHaveText('版本 4');
    await expect(page.getByTestId('entry-transfer')).toBeVisible();
    await page.getByRole('button', { name: '預覽分享內容', exact: true }).click();
    await expect(page.getByRole('button', { name: '確認公開並建立連結', exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath('portfolio-final.png'), fullPage: true });
  });
});
