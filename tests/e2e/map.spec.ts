import { test, expect, type Page } from '@playwright/test';

async function addPlace(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: '試玩一般規劃' }).click();
  await expect(page).toHaveURL(/\/trips\//);
  await expect(page.getByRole('region', { name: '每日行程', exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: '移除 tour', exact: true })).toBeEnabled();
  await expect(page.getByTestId('entry-tour')).toBeVisible();
  await page.getByTestId('entry-tour').locator('summary').click();
  await page.getByRole('combobox', { name: '替換項目 · tour', exact: true }).selectOption('vase-rock');
  await page.getByRole('button', { name: '提出替換 tour' }).click();
  await expect(page.getByRole('heading', { name: '位置待確認' })).toBeVisible();
  await page.getByRole('button', { name: '接受修改', exact: true }).click();
  await expect(page.getByRole('heading', { name: '行程地圖', exact: true })).toBeVisible();
}

test('map opt-in, attribution, zoom, restore and mobile layout', async ({ page }, info) => {
  const urls: string[] = [];
  const referers: string[] = [];
  await page.route('https://tile.openstreetmap.org/**', async route => {
    urls.push(route.request().url()); referers.push(route.request().headers().referer ?? '');
    await route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#dce9df"/><path d="M0 160L256 50" stroke="#fff" stroke-width="8"/></svg>' });
  });
  await addPlace(page);
  expect(urls).toHaveLength(0);
  await expect(page.locator('.map-places')).toContainText('22.35566, 120.38076');
  await page.getByRole('button', { name: '載入 OpenStreetMap 底圖' }).click();
  await expect(page.getByText('底圖已載入', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: '© OpenStreetMap contributors' })).toBeVisible();
  expect(referers.every(value => value === 'http://127.0.0.1:4319/')).toBe(true);
  expect(urls.length).toBeGreaterThan(0);
  await page.getByRole('button', { name: '放大地圖', exact: true }).click();
  await expect(page.getByText('底圖已載入', { exact: true })).toBeVisible();
  expect(urls.some(url => url.includes('/15/'))).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.locator('.location-panel').screenshot({ path: info.outputPath('map-mocked.png') });
  await page.getByRole('button', { name: '復原此版本', exact: true }).click();
  await expect(page.getByRole('heading', { name: '位置待確認' })).toBeVisible();
  await expect(page.locator('.trip-map')).toHaveCount(0);
});

test('map network failure preserves sources, coordinates and trip actions', async ({ page }) => {
  await page.route('https://tile.openstreetmap.org/**', route => route.abort('failed'));
  await addPlace(page);
  await page.getByRole('button', { name: '載入 OpenStreetMap 底圖' }).click();
  await expect(page.getByText('底圖無法載入', { exact: false })).toBeVisible();
  await expect(page.getByRole('link', { name: '位置來源', exact: true })).toBeVisible();
  await expect(page.locator('.map-places')).toContainText('22.35566');
  await expect(page.getByRole('button', { name: '移除 tour', exact: true })).toBeEnabled();
});

test('map stalled requests time out without blocking the itinerary', async ({ page }) => {
  await page.route('https://tile.openstreetmap.org/**', () => {});
  await addPlace(page);
  await page.clock.install();
  await page.getByRole('button', { name: '載入 OpenStreetMap 底圖' }).click();
  await expect(page.getByText('正在載入底圖…', { exact: true })).toBeVisible();
  await page.clock.runFor(8001);
  await expect(page.getByText('底圖無法載入', { exact: false })).toBeVisible();
  await expect(page.locator('.map-places')).toContainText('22.35566');
});
