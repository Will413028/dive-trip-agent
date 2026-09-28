import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import AcceptedAnswer from '../../src/features/workbench/AcceptedAnswer';
import { money } from '../../src/lib/presentation';
import { acceptedAnswerSchema, type AcceptedAnswer as Answer, type BudgetPresentation } from '../../src/domain/answer';
import { formatTwd } from '../../src/domain/money';

const amount = (minor: number) => ({ minor, display: formatTwd(minor) });
const source = { id: 'price-source', url: 'https://example.invalid/price', checkedAt: '2026-09-27', kind: 'fact' as const, label: '價格資料' };
const provenance = { id: 'demo-provenance', url: null, checkedAt: '2026-09-26', kind: 'demo' as const, label: '合成行程資料' };
const answer = (body: Answer['body']): Answer => ({
  schemaVersion: 1, templateVersion: 1, answerId: `ans_${'a'.repeat(64)}`,
  runId: '10000000-0000-4000-8000-000000000001', evidenceRefs: [`ev_${'b'.repeat(64)}`], body,
});
const renderRaw = (value: unknown) => renderToStaticMarkup(<AcceptedAnswer answer={value} />);
const render = (body: Answer['body']) => renderRaw(acceptedAnswerSchema.parse(answer(body)));
function budget(scope: 'current' | 'candidate' = 'current'): BudgetPresentation {
  return {
    scope, baseVersion: 3, known: amount(330000), target: amount(100000), withinBudget: null, containsDemo: true,
    unknownCosts: [{ entryId: 'tour', title: '海上活動', reason: '季節價格待詢', source, provenanceSources: [provenance] }],
    exclusions: ['未含船票'], issues: [{ code: 'UNKNOWN_COST', entryId: 'tour' }, { code: 'EXCLUDED_COST' }],
    sources: [{ entryId: 'stay', source, provenanceSources: [provenance] }],
    locked: { status: 'locked-known-cost-exceeds-budget', known: amount(300000), entryIds: ['stay'], unknownEntryIds: ['tour'] },
  };
}

test('clarification uses all nine controlled questions', () => {
  const html = render({ kind: 'clarify', fields: ['destination', 'dates', 'people', 'divers', 'budget', 'lodging', 'rooms', 'pace', 'target-item'] });
  expect(html.match(/<li>/g)).toHaveLength(9);
  for (const text of ['請補充規劃條件', '小琉球', '出發日期', '1–6 人', '幾位會潛水', '目標預算', '住宿偏好', '人數與房間數', '放鬆留白', '哪個行程項目']) {
    expect(html).toContain(text);
  }
  expect(html).toContain('回答版本 1 · 呈現版本 1');
});

test('requirements distinguish the saved target and lodging preference from prices and room selection', () => {
  const requirements = { destinationId: 'green-island' as const, days: 3, people: 2, divers: 1, startDate: null,
    target: amount(100000), lodgingPreference: '雙人房偏好', pace: 'relaxed' as const };
  const html = render({ kind: 'requirements', version: 7, requirements });
  for (const text of ['已保存需求 · 版本 7', '綠島', '日期：未定', '3 天', '旅客：2 人', '潛水：1 人',
    '目標預算：TWD 1000.00', '非服務價格或行程估算', '偏好不代表已選定房型', '放鬆留白']) expect(html).toContain(text);
  const unset = render({ kind: 'requirements', version: 8, requirements: { ...requirements, destinationId: null,
    target: null, lodgingPreference: '', startDate: '2026-10-10', pace: 'balanced' } });
  for (const text of ['目的地：未定', '目標預算：未設定', '住宿偏好：未提供', '2026-10-10', '適度安排']) expect(unset).toContain(text);
});

test('destination counts disclose DEMO without claiming booking availability', () => {
  const html = render({ kind: 'destinations', destinations: [
    { id: 'xiaoliuqiu', itemCount: 3, demoItemCount: 2 }, { id: 'green-island', itemCount: 2, demoItemCount: 1 },
    { id: 'kenting', itemCount: 0, demoItemCount: 0 },
  ] });
  for (const text of ['小琉球', '綠島', '墾丁', '目錄 3 項', 'DEMO 示範資料 2 項', '不代表可訂狀態']) expect(html).toContain(text);
  expect(render({ kind: 'destinations', destinations: [] })).toContain('目前沒有目的地資料');
});

test('catalog options retain exact unit prices, provenance, unknown costs and omitted counts', () => {
  const base = { id: 'activity', title: '目錄活動', audience: 'all' as const, capacityPerRoom: null,
    price: amount(100000), unknownReason: null, containsDemo: true, source, provenanceSources: [provenance] };
  const html = render({ kind: 'items', destinationId: 'kenting', total: 6, omittedCount: 2, items: [
    { ...base, unit: 'person' }, { ...base, id: 'stay', title: '住宿', unit: 'room-night', price: amount(330000), capacityPerRoom: 2 },
    { ...base, id: 'group', unit: 'group', audience: 'non-divers' },
    { ...base, id: 'unknown', unit: 'person', price: null, unknownReason: '請先詢價', audience: 'divers' },
  ] });
  for (const text of ['TWD 1000.00／每人', 'TWD 3300.00／每房每晚', 'TWD 1000.00／每組', '非行程總價',
    '單價：未知／待確認／每人', '請先詢價', '每房容量：2 人', '不潛水者', '潛水者', '目錄共 6 項',
    '本次列出 4 項', '未列出 2 項', 'DEMO 示範估算', 'price-source', 'demo-provenance', '合成行程資料',
    '資料來源（provenance）', '2026-09-27', 'https://example.invalid/price']) expect(html).toContain(text);
  expect(html).not.toContain('TWD 100.00');
  expect(html).not.toContain('TWD 330.00');
  expect(html).not.toContain('TWD 0.00');
  expect(html).not.toContain('<a ');
  expect(render({ kind: 'items', destinationId: 'kenting', total: 0, omittedCount: 0, items: [] })).toContain('目前沒有符合查詢');
});

test.each(['budget', 'conflict', 'proposal'] as const)('%s includes every budget limitation and source', kind => {
  const view = budget(kind === 'budget' ? 'current' : 'candidate');
  const body: Answer['body'] = kind === 'proposal' ? { kind, budget: view, proposalRef: `ev_${'c'.repeat(64)}`, changeCount: 2 }
    : { kind, budget: view };
  const html = render(body);
  for (const text of ['已知小計：TWD 3300.00', '目標預算：TWD 1000.00', '非服務價格或可負擔證據',
    '尚不能確認全程在預算內', '未含未知或排除費用', 'DEMO', '海上活動', '季節價格待詢', '未含船票',
    '鎖定已知下限：TWD 3000.00', '只調整未鎖定項目無法達標', '原始鎖定項目：stay', '費用未知的鎖定項目：tour',
    'price-source', 'demo-provenance', 'UNKNOWN_COST', 'EXCLUDED_COST']) expect(html).toContain(text);
  expect(html).not.toContain('TWD 330.00');
  expect(html).not.toContain('已計入項目在目標預算內');
  expect(html).not.toContain('資料已保存');
  if (kind === 'proposal') {
    expect(html).toContain('待確認提案');
    expect(html).toContain('共 2 項修改');
    expect(html).toContain('接受前尚未套用');
  }
  if (kind === 'conflict') expect(html).toContain('修改存在衝突，暫時無法套用');
});

test('comparison keeps full current and candidate disclosures in separate versioned sections', () => {
  const current = budget(), candidate = budget('candidate');
  candidate.known = amount(200000);
  candidate.exclusions = ['未含裝備'];
  candidate.unknownCosts[0].reason = '候選活動待詢價';
  const html = render({ kind: 'compare-budget', current, candidate });
  expect(html).toContain('目前行程（current）· 版本 3');
  expect(html).toContain('候選修改（candidate）· 以版本 3 為基礎 · 尚未保存');
  const sections = html.split('</section>');
  for (const text of ['TWD 3300.00', '未含船票', '季節價格待詢']) expect(sections[0]).toContain(text);
  for (const text of ['TWD 2000.00', '未含裝備', '候選活動待詢價']) expect(sections[1]).toContain(text);
  for (const section of sections.slice(0, 2)) {
    expect(section).toContain('鎖定已知下限');
    expect(section).toContain('demo-provenance');
    expect(section).toContain('尚不能確認全程在預算內');
  }
});

test.each([
  ['unavailable', '目前無法判定鎖定下限'],
  ['budget-unspecified', '尚未設定目標預算'],
  ['locked-known-cost-exceeds-budget', '已知下限已超過目標預算'],
  ['not-proven-infeasible', '不代表其餘修改足以達標'],
] as const)('locked assessment %s is explicit without converting unknown to zero', (status, message) => {
  const view = budget('candidate');
  view.locked.status = status;
  if (status === 'unavailable') { view.locked.known = null; view.locked.unknownEntryIds = null; }
  if (status === 'budget-unspecified') view.target = null;
  const html = render({ kind: 'budget', budget: view });
  expect(html).toContain(message);
  if (status === 'unavailable') {
    expect(html).toContain('鎖定已知下限：無法計算');
    expect(html).toContain('費用未知的鎖定項目：無法判定');
    expect(html).not.toContain('鎖定已知下限：TWD 0.00');
  }
});

test.each([true, false])('known-only estimates use the server conclusion: withinBudget=%s', withinBudget => {
  const view = budget();
  Object.assign(view, { unknownCosts: [], exclusions: [], issues: [], containsDemo: false,
    known: amount(withinBudget ? 100000 : 200000), withinBudget,
    sources: [{ entryId: 'stay', source, provenanceSources: [] }],
    locked: { status: 'not-proven-infeasible', known: amount(0), entryIds: [], unknownEntryIds: [] } });
  const html = render({ kind: 'budget', budget: view });
  expect(html).toContain(withinBudget ? '已計入項目在目標預算內' : '已知費用超過目標預算');
  expect(html).toContain('估算，非確定報價');
  expect(html).toContain('未安排的餐飲、交通與裝備不代表免費');
});

test('receipts distinguish applied and rejected decisions at their committed versions', () => {
  const applied = render({ kind: 'receipt', status: 'applied', version: 4 });
  expect(applied).toContain('資料已保存：修改已套用，版本 4');
  const rejected = render({ kind: 'receipt', status: 'rejected', version: 3 });
  expect(rejected).toContain('拒絕決定已保存：修改未套用，行程版本 3');
  expect(rejected).not.toContain('修改已套用');
});

test.each(['applied', 'rejected'] as const)('failure preserves the %s receipt independently of turn failure', status => {
  const html = render({ kind: 'failure', reason: 'incomplete-run', committed: { status, version: 4 } });
  expect(html).toContain(status === 'applied' ? '資料已保存' : '拒絕決定已保存');
  expect(html).toContain('版本 4');
  expect(html).toContain('Agent 回合未完成');
  expect(html).toContain('上述已保存結果仍然有效');
  expect(html).not.toContain('回滾');
});

test.each(['invalid-answer', 'incomplete-run', 'unsupported-version'] as const)('failure without a receipt never claims a commit: %s', reason => {
  const html = render({ kind: 'failure', reason, committed: null });
  expect(html).toContain('Agent 回合未完成');
  expect(html).toContain('重新讀取行程狀態');
  expect(html).not.toContain('修改已套用');
  expect(html).not.toContain('決定已保存');
});

test.each([
  ['outside-scope', '1–6 人、2–7 天'], ['booking', '無法代訂'],
  ['payment', '無法付款'], ['safety-guarantee', '無法提供潛水安全背書'],
] as const)('unsupported reason %s has a controlled explanation', (reason, message) => {
  const html = render({ kind: 'unsupported', reason });
  expect(html).toContain('目前不支援這項要求');
  expect(html).toContain(message);
});

test('source titles, reasons, URLs, exclusions and preferences remain inert data', () => {
  const malicious = '<script>DATA_SENTINEL</script> **not-strong** [link](https://example.invalid)';
  const view = budget();
  view.unknownCosts[0].title = malicious;
  view.unknownCosts[0].reason = malicious;
  view.exclusions = [malicious];
  view.sources[0] = { entryId: malicious, source: { ...source, label: malicious,
    url: 'https://example.invalid/<img>?payload=DATA_SENTINEL' }, provenanceSources: [{ ...provenance, label: malicious }] };
  const html = render({ kind: 'budget', budget: view });
  expect(html).toContain('&lt;script&gt;DATA_SENTINEL&lt;/script&gt;');
  expect(html).toContain('**not-strong**');
  expect(html).toContain('&lt;img&gt;');
  expect(html).not.toMatch(/<(?:script|img|a|iframe|svg|link|strong)\b/);
  const requirements = render({ kind: 'requirements', version: 1, requirements: { destinationId: null,
    days: 2, people: 1, divers: 0, startDate: null, target: null, lodgingPreference: malicious, pace: 'balanced' } });
  expect(requirements).toContain('&lt;script&gt;DATA_SENTINEL&lt;/script&gt;');
  expect(requirements).not.toContain('<script>');
});

test('invalid envelopes, prices, URLs and budget claims cannot reach the renderer', () => {
  const valid = answer({ kind: 'budget', budget: budget() });
  const invalidValues: unknown[] = [null, 'RAW_SENTINEL', { ...valid, schemaVersion: 2 }, { ...valid, templateVersion: 2 },
    { ...valid, body: { kind: 'RAW_SENTINEL' } }, { ...valid, text: 'RAW_SENTINEL' },
    answer({ kind: 'budget', budget: { ...budget(), known: { minor: 330000, display: 'TWD 330.00 RAW_SENTINEL' } } }),
    answer({ kind: 'budget', budget: { ...budget(), withinBudget: true } }),
    answer({ kind: 'budget', budget: { ...budget(), sources: [{ entryId: 'entry', source: { ...source, url: 'javascript:RAW_SENTINEL' }, provenanceSources: [] }] } }),
  ];
  for (const value of invalidValues) {
    const html = renderRaw(value);
    expect(html).toContain('無法顯示');
    expect(html).not.toContain('RAW_SENTINEL');
    expect(html).not.toContain('data-answer-id=');
    expect(html).not.toContain('TWD 330.00');
  }
});

test('oversized but otherwise shaped evidence fails closed instead of partially rendering', () => {
  const view = budget();
  view.unknownCosts = Array.from({ length: 10 }, (_, index) => ({ ...view.unknownCosts[0], entryId: `entry-${index}`, title: '字'.repeat(2000) }));
  const value = answer({ kind: 'budget', budget: view });
  expect(new TextEncoder().encode(JSON.stringify(value)).length).toBeGreaterThan(32000);
  expect(renderRaw(value)).toContain('無法顯示');
  expect(renderRaw(value)).not.toContain('已知小計');
});

test('workbench money shares exact domain formatting and retains signed proposal differences', () => {
  for (const value of [0, 1, 99, 100000, 330000, Number.MAX_SAFE_INTEGER]) expect(money(value)).toBe(formatTwd(value));
  expect(money(-330000)).toBe('-TWD 3300.00');
  expect(money(Number.MAX_SAFE_INTEGER)).toBe('TWD 90071992547409.91');
  for (const value of [NaN, Infinity, 0.1, Number.MAX_SAFE_INTEGER + 1]) expect(() => money(value)).toThrow();
});
