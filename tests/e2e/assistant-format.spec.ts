import { expect, test } from '@playwright/test';
import { EventType } from '@ag-ui/core';
import { assistantUnsafeSample } from '../support/assistant-format-fixture';
import { acceptedAnswerFixture, answerFixtureRunId } from '../support/accepted-answer-fixture';
import { ANSWER_EVENT_NAME } from '../../src/domain/answer';

// Browser-only presentation fixture; no product test endpoint or model call.
// The existing launcher still needs its dedicated DB: run serially after DB
// suites, never concurrently with integration/E2E/build or another workbench.
test('grounded budget, inert source data and no legacy text fallback on desktop/mobile', async ({ page }, testInfo) => {
  const external: string[] = [];
  const dialogs: string[] = [];
  let agentRequests = 0;
  let unsupportedVersion = false;
  page.on('dialog', async dialog => { dialogs.push(dialog.type()); await dialog.dismiss(); });
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin !== 'http://127.0.0.1:4319') {
      external.push(route.request().url()); return route.abort();
    }
    return route.fallback();
  });
  await page.route('**/api/agent-mode', route => route.fulfill({ json: { mode: 'cloudflare' } }));
  await page.route('**/api/trips/*/agent', route => { agentRequests++; return route.abort(); });
  await page.route('**/api/trips/*/runs', route => {
    const answer = acceptedAnswerFixture();
    const events = [{ sequence: 1, event: { type: EventType.CUSTOM, name: ANSWER_EVENT_NAME,
      value: unsupportedVersion ? { ...answer, templateVersion: 999, raw: 'RAW_VERSION_ATTACK' } : answer } },
    { sequence: 2, event: { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'legacy', delta: 'RAW_TEXT_ATTACK TWD330' } }];
    return route.fulfill({ json: { runs: [{ id: answerFixtureRunId, tripId: new URL(route.request().url()).pathname.split('/')[3],
      requestId: 'formatting-request', baseVersion: 1, answerContractVersion: 1, message: '**使用者原文** 與 `代碼`', status: 'succeeded',
      events, proposalId: null, interruptId: null }] } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '試玩一般規劃' }).click();
  await expect(page).toHaveURL(/\/trips\//);
  if ((page.viewportSize()?.width ?? 1000) <= 760) await page.getByRole('button', { name: '對話', exact: true }).click();
  const run = page.getByTestId(`chat-run-${answerFixtureRunId}`);
  const formatted = run.locator('.assistant-message').nth(0);
  await expect(formatted).toContainText('目前行程（current）· 版本 1');
  await expect(formatted).toContainText('已知小計：TWD 3300.00');
  await expect(formatted).not.toContainText('TWD 330.00');
  await expect(formatted).toContainText('尚不能確認全程在預算內');
  await expect(formatted).toContainText('DEMO 示範估算，非真實報價');
  await expect(formatted).toContainText('未納入餐食與裝備');
  await expect(formatted).toContainText(assistantUnsafeSample);
  await expect(run).not.toContainText('RAW_TEXT_ATTACK');
  await expect(run).toContainText('舊版文字回答不受支援');
  await expect(run.locator('script, img, a, iframe, svg, link')).toHaveCount(0);
  await expect(run.locator('.chat-user')).toHaveText('**使用者原文** 與 `代碼`');
  await expect(run.locator('.chat-user strong, .chat-user code')).toHaveCount(0);
  expect(await page.evaluate(() => (globalThis as typeof globalThis & { __assistantInjected?: boolean }).__assistantInjected)).toBeUndefined();
  expect(await run.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('assistant-format.png'), fullPage: true });

  unsupportedVersion = true;
  await page.getByRole('button', { name: '重新讀取對話狀態' }).click();
  await expect(run).toContainText('此回答格式或版本不受支援');
  await expect(run).not.toContainText('RAW_VERSION_ATTACK');
  await expect(run).not.toContainText('TWD 3300.00');
  expect(agentRequests).toBe(0);
  expect(external).toEqual([]);
  expect(dialogs).toEqual([]);
});
