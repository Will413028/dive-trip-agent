import { test, expect } from '@playwright/test';

test('案例頁明示個人貢獻、確認架構與資料及驗證邊界', async ({ page }) => {
  await page.goto('/case-study');
  await expect(page).toHaveTitle('作品案例 · 潛旅筆記');
  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { level: 1 })).toHaveText('讓對話提出可能，讓人決定行程。');
  await expect(main.getByRole('heading', { name: '問題與本人貢獻' })).toBeVisible();
  await expect(main).toContainText('FastAPI／PydanticAI、Temporal 與 AG-UI');
  await expect(main).toContainText('Cloudflare Workers AI 已用於另行授權的本機真模型驗證');
  await expect(main).toContainText('接受前原行程保持不變');
  await expect(main).toContainText('保存完整行程新版本與 receipt 至 PostgreSQL');
  await expect(main).toContainText('復原將舊內容存成新版');
  await expect(main).toContainText('10 筆 DEMO');
  await expect(main).toContainText('花瓶岩、綠島燈塔、鵝鑾鼻燈塔');
  await expect(main).toContainText('僅人工核對名稱與座標');
  await expect(main).toContainText('開放狀態與費用仍待確認');
  await expect(main).toContainText('確認接續不再呼叫模型');
  await expect(main).toContainText('新版真模型品質尚未通過');
  await expect(main).toContainText('完整 30 案入口在未知用量時停止');
  await expect(main).toContainText('第三次工具成功');
  await expect(main).toContainText('建立不必要提案，任務品質仍失敗');
  await expect(main).toContainText('原始失敗與保守帳務保留，不重送已停止的執行');
  await expect(main).toContainText('重播明示非 LIVE');
  await expect(main).toContainText('未公開部署');
  await expect(main).toContainText('不提供潛水安全背書');
});

test('案例頁鍵盤入口、demo 導航與桌面／手機版面', async ({ page }, info) => {
  await page.goto('/case-study');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: '跳至主要內容' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/case-study#main$/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('case-study.png'), fullPage: true });

  const demo = page.getByRole('link', { name: '前往互動 demo ↗', exact: true });
  await expect(demo).toHaveAttribute('href', '/');
  await expect(page.getByRole('link', { name: '回首頁開始示範' })).toHaveAttribute('href', '/');
  await demo.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('button', { name: '試玩一般規劃' })).toBeVisible();
});
