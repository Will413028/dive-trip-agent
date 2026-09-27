import { test, expect } from '@playwright/test';

test('preview then publish a private-text-free fixed snapshot; stranger reads, owner revokes', async ({ page, browser }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '試玩一般規劃' }).click();
  await expect(page).toHaveURL(/\/trips\//);
  const origin = new URL(page.url()).origin;
  const tripPath = `/api${new URL(page.url()).pathname}`;
  const privateTrip = await (await page.request.get(tripPath)).json();
  const marker = 'PRIVATE_CONTACT_0912345678';
  const proposal = await (await page.request.post(`${tripPath}/proposals`, { headers: { origin }, data: {
    baseVersion: 1, changes: [{ kind: 'requirements', value: { ...privateTrip.snapshot.requirements,
      lodgingPreference: marker, startDate: '2027-12-31' } }],
  } })).json();
  expect((await page.request.post(`${tripPath}/apply`, { headers: { origin }, data: {
    baseVersion: 1, proposalId: proposal.proposalId, requestId: crypto.randomUUID(),
  } })).ok()).toBe(true);
  await page.reload();
  await expect(page.locator('.version-box strong')).toHaveText('版本 2');
  await page.getByRole('button', { name: '預覽分享內容', exact: true }).click();
  await expect(page.getByTestId('share-preview')).toBeVisible();
  await expect(page.getByTestId('share-preview')).not.toContainText(marker);
  await expect(page.getByTestId('share-preview')).not.toContainText('2027-12-31');
  expect((await (await page.request.get(`${tripPath}/shares`)).json()).shares).toHaveLength(0);
  await page.getByRole('button', { name: '確認公開並建立連結', exact: true }).click();
  const link = page.getByTestId('created-share-link');
  await expect(link).toBeVisible();
  const target = (await link.getAttribute('href'))!;
  const stranger = await browser.newContext();
  try {
    const publicPage = await stranger.newPage();
    const response = (await publicPage.goto(target))!;
    expect(response.status()).toBe(200);
    expect(response.headers()['cache-control']).toContain('no-store');
    expect(response.headers()['referrer-policy']).toBe('no-referrer');
    expect(response.headers()['x-robots-tag']).toContain('noindex');
    const html = await response.text();
    expect(html).not.toContain(marker); expect(html).not.toContain('2027-12-31'); expect(html).not.toContain(privateTrip.id);
    await expect(publicPage.getByRole('heading', { name: '唯讀行程快照', exact: true })).toBeVisible();
    await expect(publicPage.getByTestId('public-trip')).toContainText('TWD 4300.00');
    expect((await stranger.request.get(`${origin}${tripPath}`)).status()).toBe(404);
    // Editing the owned trip must not update its already shared snapshot.
    await page.getByRole('button', { name: '移除 transfer', exact: true }).click();
    await page.getByRole('button', { name: '接受修改', exact: true }).click();
    await expect(page.locator('.version-box strong')).toHaveText('版本 3');
    await publicPage.reload();
    await expect(publicPage.getByTestId('public-trip')).toContainText('TWD 4300.00');
    await page.getByRole('button', { name: '移除 tour', exact: true }).click();
    await expect(page.getByTestId('proposal-panel')).toBeVisible();
    await expect(page.getByRole('button', { name: '預覽分享內容', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: '撤銷分享連結', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '撤銷分享連結', exact: true }).click();
    await expect(page.getByTestId('created-share-link')).toHaveCount(0);
    expect((await publicPage.reload())!.status()).toBe(404);
    await page.reload();
    await expect(page.getByText(/版本 2 · 已撤銷/)).toBeVisible();
  } finally { await stranger.close(); }
});
