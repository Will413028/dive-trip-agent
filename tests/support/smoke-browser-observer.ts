import assert from 'node:assert/strict';
import { expect, type Page } from '@playwright/test';

/** SSE request EOF is not a reliable Playwright completion signal with this client.
 * Observe the UI's persisted terminal status; callers must separately audit the DB.
 */
export async function observeSmokePost(page: Page, tripId: string, action: () => Promise<void>,
  terminal: '待確認' | '回合處理已結束'): Promise<void> {
  const pending = page.waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).pathname === `/api/trips/${tripId}/agent`, { timeout: 70_000 });
  const [response] = await Promise.all([pending, action()]);
  assert.equal(response.status(), 200);
  const status = page.locator('.chat-status').last();
  await expect(status).toHaveText(new RegExp(`^(${terminal}|執行失敗|執行已中斷)$`), { timeout: 65_000 });
  assert.equal(await status.textContent(), terminal, 'CLOUDFLARE_SMOKE_PROVIDER_STOP');
}
