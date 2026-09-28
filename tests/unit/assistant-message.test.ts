import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EventType, type BaseEvent } from '@ag-ui/core';
import { expect, test } from 'vitest';
import { EventMessages } from '../../src/features/workbench/ChatPanel';
import { ANSWER_EVENT_NAME, type AcceptedAnswer } from '../../src/domain/answer';
import { acceptedAnswerFixture } from '../support/accepted-answer-fixture';

const runId = '10000000-0000-4000-8000-000000000001';
const answer = (body: AcceptedAnswer['body'], digit = 'a'): AcceptedAnswer => ({
  schemaVersion: 1, templateVersion: 1, answerId: `ans_${digit.repeat(64)}`, runId, evidenceRefs: [], body,
});
const event = (type: EventType, fields: Record<string, unknown> = {}): BaseEvent => ({ type, ...fields });
const custom = (value: unknown, name = ANSWER_EVENT_NAME) => event(EventType.CUSTOM, { name, value });
const render = (events: BaseEvent[], status?: 'running' | 'awaiting_confirmation' | 'succeeded' | 'failed' | 'interrupted') =>
  renderToStaticMarkup(createElement(EventMessages, { events, status }));

test('browser presentation fixture compiles against real binding and renders required disclosures', () => {
  const compiled = acceptedAnswerFixture();
  const html = render([custom(compiled)]);
  expect(html).toContain('TWD 3300.00');
  expect(html).toContain('尚不能確認全程在預算內');
  expect(html).toContain('DEMO');
  expect(html).not.toContain('<script>');
});

test('legacy text events never reveal model text, including plain text and Markdown', () => {
  for (const text of ['RAW_SENTINEL 已保存 TWD 330', '**RAW_SENTINEL**', '<script>RAW_SENTINEL</script>', 'RAW_SENTINEL'.repeat(4000)]) {
    const html = render([event(EventType.TEXT_MESSAGE_CONTENT, { messageId: 'legacy', delta: text })]);
    expect(html).toContain('舊版文字回答不受支援');
    expect(html).not.toContain('RAW_SENTINEL');
  }
});

test('live and saved events render the same accepted answer once per answerId without raw deltas', () => {
  const accepted = custom(answer({ kind: 'receipt', status: 'applied', version: 2 }));
  const events = [event(EventType.TEXT_MESSAGE_CONTENT, { messageId: 'm', delta: 'RAW_SENTINEL TWD 330' }), accepted, accepted];
  const live = render(events);
  expect(live).toContain('資料已保存');
  expect(live).toContain('版本 2');
  expect(live).not.toContain('RAW_SENTINEL');
  expect(live.match(/data-answer-id=/g)).toHaveLength(1);
  expect(render(events, 'succeeded')).toBe(live);
});

test.each([
  ['unknown custom event', custom({ text: 'RAW_SENTINEL' }, 'dive_trip.answer.v2')],
  ['unrelated custom event', custom({ text: 'RAW_SENTINEL' }, 'RAW_SENTINEL')],
  ['schema version', custom({ ...answer({ kind: 'clarify', fields: ['dates'] }), schemaVersion: 2, text: 'RAW_SENTINEL' })],
  ['template version', custom({ ...answer({ kind: 'clarify', fields: ['dates'] }), templateVersion: 2, text: 'RAW_SENTINEL' })],
  ['invalid body', custom({ ...answer({ kind: 'clarify', fields: ['dates'] }), body: { kind: 'RAW_SENTINEL' } })],
  ['extra prose', custom({ ...answer({ kind: 'clarify', fields: ['dates'] }), text: 'RAW_SENTINEL' })],
  ['JSON string', custom(JSON.stringify(answer({ kind: 'clarify', fields: ['dates'] })))],
  ['null', custom(null)],
])('rejects %s with a fixed notice and no fallback', (_name, incoming) => {
  const html = render([incoming]);
  expect(html).toContain('無法顯示');
  expect(html).not.toContain('RAW_SENTINEL');
  expect(html).not.toContain('請提供出發日期');
  expect(html).not.toContain('data-answer-id=');
});

test('an answer bound to another persisted run is not rendered', () => {
  const html = renderToStaticMarkup(createElement(EventMessages, {
    events: [custom(answer({ kind: 'receipt', status: 'applied', version: 99 }))],
    runId: '20000000-0000-4000-8000-000000000002',
  }));
  expect(html).toContain('無法顯示');
  expect(html).not.toContain('版本 99');
});

test('a duplicate ID cannot overwrite an already accepted projection', () => {
  const html = render([
    custom(answer({ kind: 'receipt', status: 'applied', version: 2 })),
    custom(answer({ kind: 'receipt', status: 'applied', version: 99 })),
  ]);
  expect(html.match(/data-answer-id=/g)).toHaveLength(1);
  expect(html).toContain('版本 2');
  expect(html).not.toContain('版本 99');
  expect(html).toContain('無法顯示');
});

test('tool progress uses only fixed labels and sanitized result markers', () => {
  const start = event(EventType.TOOL_CALL_START, { toolCallId: 't', toolCallName: 'find_items' });
  const end = event(EventType.TOOL_CALL_END, { toolCallId: 't' });
  expect(render([start])).toContain('查詢活動與住宿：處理中');
  expect(render([start, end])).toContain('查詢活動與住宿：已送出，等待工具結果');
  const html = render([start, end, event(EventType.TOOL_CALL_RESULT, { toolCallId: 't', content: '{}' }),
    event(EventType.TOOL_CALL_ARGS, { toolCallId: 't', delta: 'RAW_SENTINEL' }),
    event(EventType.TOOL_CALL_START, { toolCallId: 'u', toolCallName: 'RAW_SENTINEL' }),
    event(EventType.RUN_ERROR, { message: 'RAW_SENTINEL', code: 'RAW_SENTINEL' })]);
  expect(html).toContain('查詢活動與住宿：已收到工具結果');
  expect(html).toContain('行程工具：');
  expect(html).toContain('Agent 回合未完成');
  expect(html).not.toContain('RAW_SENTINEL');
  expect(html).not.toContain('{}');
  expect(html).not.toContain('資料已保存');
});

test('raw tool results are rejected even when they claim to be saved receipts', () => {
  const html = render([event(EventType.TOOL_CALL_RESULT, { toolCallId: 't', content: '{"message":"RAW_SENTINEL 已保存"}' })]);
  expect(html).toContain('無法顯示');
  expect(html).not.toContain('RAW_SENTINEL');
  expect(html).not.toContain('已收到工具結果');
});

test('awaiting confirmation stays pending after a sanitized proposal tool result', () => {
  const html = render([
    event(EventType.TOOL_CALL_START, { toolCallId: 't', toolCallName: 'propose_changes' }),
    event(EventType.TOOL_CALL_END, { toolCallId: 't' }),
    event(EventType.TOOL_CALL_RESULT, { toolCallId: 't', content: '{}' }),
  ], 'awaiting_confirmation');
  expect(html).toContain('提出修改：待確認');
  expect(html).not.toContain('資料已保存');
});

test.each(['failed', 'interrupted'] as const)('a committed receipt remains visible in a %s turn', status => {
  const html = render([custom(answer({ kind: 'receipt', status: 'applied', version: 2 }))], status);
  expect(html).toContain('資料已保存');
  expect(html).toContain('版本 2');
  expect(html).toContain('Agent 回合未完成');
  expect(html).not.toContain('回滾');
});

test('a finished stream with no accepted answer is explicitly incomplete', () => {
  expect(render([event(EventType.RUN_FINISHED)], 'succeeded')).toContain('未收到可顯示的受控回答');
  expect(render([], 'running')).toBe('');
});
