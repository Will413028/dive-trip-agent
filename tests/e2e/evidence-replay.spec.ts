import { createHash } from 'node:crypto';
import { expect, test, type Locator } from '@playwright/test';
import { createEvidenceReplay, parseAcceptedAnswers, parseReplayBundle } from '../../evals/replay-bundle';
import { createSyntheticReplayBundle, syntheticReplayScenarios } from '../support/synthetic-replay-fixture';

for (const scenario of syntheticReplayScenarios) test(`synthetic v2 ${scenario}: refresh and fixed confirmation only`, async ({ page, context }, info) => {
  test.skip(info.config.metadata.evidenceReplay !== true, 'Dedicated offline replay config only');
  // This entry accepts only these explicit synthetic v2 fixtures. It has no
  // filesystem/env artifact selector and cannot play or relabel old captures.
  const name = `synthetic-accepted-answer-v2-${scenario}`;
  const text = JSON.stringify(createSyntheticReplayBundle(scenario));
  const expectedHash = createHash('sha256').update(text).digest('hex');
  const bundle = parseReplayBundle(JSON.parse(text));
  expect(bundle.schemaVersion).toBe(2);
  const artifactName = name;
  const replay = createEvidenceReplay(bundle);
  const failures: string[] = [];
  const origin = 'http://127.0.0.1:4330';
  const tripPath = `/trips/${bundle.initial.trip.id}`;
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    try {
      if (url.origin !== origin) throw new Error('EXTERNAL_REQUEST');
      if (url.pathname.startsWith('/api/')) {
        const response = replay.respond(req.method(), url.pathname + url.search,
          req.method() === 'POST' ? req.postDataJSON() : undefined);
        if (response.sse !== undefined) await route.fulfill({ status: response.status,
          contentType: 'text/event-stream', body: response.sse });
        else await route.fulfill({ status: response.status, json: response.json });
        return;
      }
      if (req.method() !== 'GET' || !(url.pathname === tripPath || url.pathname.startsWith('/_next/static/'))) throw new Error('UNEXPECTED_RESOURCE');
      await route.continue();
    } catch {
      failures.push(`${req.method()} ${url.pathname}`);
      await route.abort('blockedbyclient');
    }
  });
  await context.routeWebSocket('**/*', socket => { failures.push('WEBSOCKET'); socket.close(); });
  // Install before application paint, including after reload. Persistent full
  // viewport frame/banner supplies provenance; CSS masks fixture/live wording
  // and unrelated sharing UI without changing captured text or product src.
  await context.addInitScript(({ model, hash }) => {
    const install = () => {
      if (!document.documentElement || document.getElementById('evidence-replay-style')) return;
      const style = document.createElement('style'); style.id = 'evidence-replay-style';
      style.textContent = `html{scroll-padding-top:92px}body{padding-top:88px!important}
        #evidence-replay-overlay{position:fixed;inset:0;z-index:2147483647;pointer-events:none;border:5px solid #153c41}
        #evidence-replay-overlay>div{background:#153c41;color:white;padding:12px 20px;font:16px/1.5 sans-serif}
        .chat-panel>.badge,.chat-panel>p.field-hint,.chat-panel>[aria-live]>[role=status]{display:none!important}
        section[aria-labelledby=share-heading]{display:none!important}`;
      const overlay = document.createElement('aside'); overlay.id = 'evidence-replay-overlay';
      const label = document.createElement('div');
      label.textContent = `SYNTHETIC 錄影管線測試 · 非真模型證據 · 非 LIVE · 本次不呼叫模型 · 合成行程 DEMO\n${model} · fixture SHA-256 ${hash.slice(0, 12)} · 播放節奏不代表模型延遲`;
      label.style.whiteSpace = 'pre-line'; overlay.append(label);
      document.documentElement.append(style, overlay);
    };
    new MutationObserver(install).observe(document, { childList: true, subtree: true }); install();
  }, { model: bundle.model, hash: expectedHash });
  const assertPresentation = async () => {
    const overlay = page.locator('#evidence-replay-overlay');
    await expect(overlay).toBeVisible();
    await expect(overlay).toContainText('非 LIVE');
    await expect(overlay).toHaveCSS('position', 'fixed');
    await expect(overlay).toContainText('SYNTHETIC 錄影管線測試 · 非真模型證據');
    await expect(page.locator('.chat-panel > .badge')).toHaveText('固定模型 DEMO · 非真實 LLM');
    await expect(page.locator('.chat-panel > .badge')).toBeHidden();
  };
  // Recording-only camera movement; never alter captured text or layout.
  // Account for the fixed disclosure banner instead of scrolling beneath it.
  const frameElement = async (locator: Locator) => {
    await locator.evaluate(element => {
      const banner = document.querySelector('#evidence-replay-overlay > div')!.getBoundingClientRect();
      const top = banner.bottom + 24;
      window.scrollTo({ top: Math.max(0, window.scrollY + element.getBoundingClientRect().top - top), behavior: 'instant' });
    });
    await expect(locator).toBeInViewport();
  };
  const screenshot = (stage: string) => page.screenshot({ path: info.outputPath(`${artifactName}-${stage}.png`) });
  await page.goto(tripPath);
  await expect(page.locator('.version-box strong')).toHaveText(`版本 ${bundle.initial.trip.version}`);
  await assertPresentation();
  // Presentation-only probes, hidden before insertion and removed before the
  // scripted interaction. They never enter bundle data or the public API.
  await page.locator('.chat-panel').evaluate(panel => {
    for (const text of ['真實 Gemini · 合成資料 DEMO', 'OpenRouter 免費模型 · 合成資料 DEMO',
      'Cloudflare Workers AI · 合成資料 DEMO']) {
      const badge = document.createElement('span'); badge.className = 'badge';
      badge.dataset.replayMaskProbe = 'true'; badge.textContent = text; panel.append(badge);
    }
    const hint = document.createElement('p'); hint.className = 'field-hint';
    hint.dataset.replayMaskProbe = 'true'; hint.textContent = '資料會送至 Cloudflare Workers AI'; panel.append(hint);
    const live = document.createElement('div'); live.setAttribute('aria-live', 'polite');
    live.dataset.replayMaskProbe = 'true'; const status = document.createElement('p');
    status.setAttribute('role', 'status'); status.textContent = 'Cloudflare 正在處理…'; live.append(status); panel.append(live);
  });
  for (const text of ['真實 Gemini · 合成資料 DEMO', 'OpenRouter 免費模型 · 合成資料 DEMO',
    'Cloudflare Workers AI · 合成資料 DEMO', '資料會送至 Cloudflare Workers AI', 'Cloudflare 正在處理…']) {
    await expect(page.getByText(text, { exact: true })).toBeHidden();
  }
  await page.locator('[data-replay-mask-probe]').evaluateAll(nodes => nodes.forEach(node => node.remove()));
  await page.getByLabel('想怎麼調整行程？').fill(bundle.prompt);
  await page.waitForTimeout(1500); // All holds are reading time, not model latency.
  await page.getByRole('button', { name: '送出訊息', exact: true }).click();
  const captured = bundle.afterStart.runs.runs[0];
  const article = page.getByTestId(`chat-run-${captured.id}`);
  const startAnswers = parseAcceptedAnswers(bundle.startEvents, captured.id);
  const finalAnswers = parseAcceptedAnswers([...bundle.startEvents, ...bundle.resumeEvents], captured.id);
  expect(captured.answerContractVersion).toBe(1);
  const assertAnswers = async (answers: typeof startAnswers) => {
    await expect(article.locator('[data-answer-id]')).toHaveCount(answers.length);
    for (const answer of answers) await expect(article.locator(`[data-answer-id="${answer.answerId}"]`)).toBeVisible();
    await expect(article).not.toHaveAttribute('data-readonly', 'true');
  };
  const frameChat = async (part: 'start' | 'disclosure', stage: string) => {
    const originalText = await article.textContent();
    await article.evaluate((element, part) => {
      const history = element.closest('.chat-history') as HTMLElement | null;
      if (!history) throw new Error('REPLAY_CHAT_HISTORY_MISSING');
      const messages = [...element.querySelectorAll<HTMLElement>('.assistant-message')];
      const message = (part === 'start' ? messages[0] : messages.at(-1)) ?? element;
      let target = (part === 'start' ? message.firstElementChild : message.lastElementChild) ?? message;
      let disclosure: Range | undefined;
      if (part === 'disclosure') {
        // Center the last actual disclosure term even when it sits near the
        // bottom of a long paragraph inside the independently scrolling chat.
        const walker = document.createTreeWalker(message, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          for (const match of (node.textContent ?? '').matchAll(/DEMO|示範|估算/gi)) {
            disclosure = document.createRange();
            disclosure.setStart(node, match.index); disclosure.setEnd(node, match.index + match[0].length);
          }
        }
        if (!disclosure) target = message.lastElementChild ?? message;
      }
      const bounds = disclosure?.getBoundingClientRect() ?? target.getBoundingClientRect();
      const inset = part === 'start' ? 12 : Math.max(12, (history.clientHeight - Math.min(bounds.height, history.clientHeight)) / 2);
      history.scrollTo({ top: Math.max(0, history.scrollTop + bounds.top - history.getBoundingClientRect().top - inset), behavior: 'instant' });
      const banner = document.querySelector('#evidence-replay-overlay > div')!.getBoundingClientRect();
      const top = banner.bottom + 24;
      const available = window.innerHeight - top - 24;
      const centered = top + Math.max(0, (available - history.getBoundingClientRect().height) / 2);
      window.scrollTo({ top: Math.max(0, window.scrollY + history.getBoundingClientRect().top - centered), behavior: 'instant' });
    }, part);
    expect(await article.textContent()).toBe(originalText);
    await expect(article).toBeInViewport();
    await screenshot(stage);
  };
  await expect(article).toBeVisible();
  await expect(page.getByRole('button', { name: '重新讀取對話狀態', exact: true })).toBeEnabled();
  await assertAnswers(startAnswers);
  await frameChat('start', 'assistant-start');
  await page.waitForTimeout(3000);
  await frameChat('disclosure', 'assistant-disclosure');
  await page.waitForTimeout(3000);
  const postsBeforeReload = replay.posts;
  await page.reload();
  await expect(article).toBeVisible();
  await assertPresentation();
  await assertAnswers(startAnswers);
  expect(replay.posts).toBe(postsBeforeReload);
  await expect(page.locator('.version-box strong')).toHaveText(`版本 ${bundle.afterStart.trip.version}`);
  if (bundle.resumeEvents.length) {
    const proposal = page.getByTestId('proposal-panel');
    await expect(proposal).toBeVisible();
    await frameElement(proposal);
    await screenshot('confirmation');
    await page.waitForTimeout(3000);
    await page.getByRole('button', { name: '接受修改', exact: true }).click();
    await expect(page.locator('.version-box strong')).toHaveText(`版本 ${bundle.final.trip.version}`);
    await expect(page.getByRole('button', { name: '重新讀取對話狀態', exact: true })).toBeEnabled();
    await frameElement(page.locator('.version-box'));
    await screenshot('applied-version');
    await page.waitForTimeout(3000);
    await frameChat('disclosure', 'resumed-disclosure');
    await page.waitForTimeout(3000);
    await page.reload();
    await expect(page.locator('.version-box strong')).toHaveText(`版本 ${bundle.final.trip.version}`);
    await assertPresentation();
    await expect(page.getByTestId('proposal-panel')).toHaveCount(0);
    expect(replay.posts).toBe(2);
  } else {
    // A blocked/readonly capture has no manufactured successful confirmation.
    expect(replay.posts).toBe(1);
    await frameChat('disclosure', 'refreshed-disclosure');
    await page.waitForTimeout(3000);
    await frameElement(page.locator('.version-box'));
    await screenshot('unchanged-version');
    await page.waitForTimeout(3000);
  }
  await expect(article).toBeVisible();
  await assertAnswers(finalAnswers);
  expect(failures).toEqual([]);
  await frameChat('disclosure', 'final-viewport');
  await page.screenshot({ path: info.outputPath(`${artifactName}-final.png`), fullPage: true });
  // Fixed reading holds: 15.5s without resume, 18.5s with resume, plus UI work.
  await page.waitForTimeout(2000);
  const video = page.video();
  if (!video) throw new Error('REPLAY_VIDEO_REQUIRED');
  await context.close();
  await video.saveAs(info.outputPath(`${artifactName}.webm`));
  await info.attach('source', { body: JSON.stringify({ bundle: name, sha256: expectedHash,
    schemaVersion: bundle.schemaVersion, answerContractVersion: captured.answerContractVersion,
    caseId: bundle.caseId, runId: captured.id, model: bundle.model, mode: 'synthetic-v2-replay',
    synthetic: true, modelRequests: 0, requestIdsReboundForUI: true,
    textReview: 'pending', taskReview: 'pending', evaluationGatePassed: false,
    fixtureResume: bundle.resumeEvents.length > 0 }), contentType: 'application/json' });
});
