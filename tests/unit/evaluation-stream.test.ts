import { expect, test } from 'vitest';
import { collectEvents } from '../../evals/collector';

function stream(text: string, end = true) {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({ start(controller) {
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    if (end) controller.close();
  } }), { headers: { 'content-type': 'text/event-stream' } });
}
test('collector preserves UTF8 across chunks and ignores heartbeat frames', async () => {
  const events = await collectEvents(stream(': ping\r\n\r\ndata:{"type":"RUN_STARTED","threadId":"t","runId":"r"}\r\n\r\ndata: {"type":"RUN_ERROR","message":"中文"}\r\n\r\n'), AbortSignal.timeout(1000));
  expect(events).toHaveLength(2);
  expect(events[1]).toMatchObject({ message: '中文' });
});

test.each([
  { type: 'TEXT_MESSAGE_START', messageId: 'm', role: 'assistant' },
  { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: 'raw answer' },
  { type: 'TEXT_MESSAGE_END', messageId: 'm' },
  { type: 'TOOL_CALL_ARGS', toolCallId: 't', delta: 'raw args' },
  { type: 'TOOL_CALL_RESULT', messageId: 'm', toolCallId: 't', content: 'raw tool prose' },
  { type: 'CUSTOM', name: 'dive_trip.answer.v1', value: { body: { kind: 'clarify', fields: ['people'] } } },
  { type: 'CUSTOM', name: 'dive_trip.answer.v2', value: {} },
  { type: 'RUN_STARTED', threadId: 't', runId: 'r', rawEvent: { text: 'raw answer' } },
])('new collector rejects raw or unvalidated event %#', async event => {
  await expect(collectEvents(stream(`data: ${JSON.stringify(event)}\n\ndata: {"type":"RUN_FINISHED","threadId":"t","runId":"r"}\n\n`),
    AbortSignal.timeout(1000))).rejects.toThrow();
});

test('empty public tool result is a progress placeholder, never raw fault evidence', async () => {
  const event = { type: 'TOOL_CALL_RESULT', messageId: 'm', toolCallId: 't', role: 'tool', content: '{}' };
  expect(await collectEvents(stream(`data: ${JSON.stringify(event)}\n\ndata: {"type":"RUN_FINISHED","threadId":"t","runId":"r"}\n\n`),
    AbortSignal.timeout(1000))).toHaveLength(2);
  await expect(collectEvents(stream(`data: ${JSON.stringify({ ...event, content: '{"error":"CATALOG_TIMEOUT"}' })}\n\n`),
    AbortSignal.timeout(1000))).rejects.toThrow();
});
test('collector rejects incomplete EOF, HTTP errors and pending streams', async () => {
  await expect(collectEvents(stream('data: {}'), AbortSignal.timeout(1000))).rejects.toThrow('EVAL_TRUNCATED_STREAM');
  await expect(collectEvents(stream(': ping\n\n'), AbortSignal.timeout(1000))).rejects.toThrow('EVAL_INCOMPLETE_STREAM');
  await expect(collectEvents(new Response('', { status: 429 }), AbortSignal.timeout(1000))).rejects.toThrow('EVAL_RATE_LIMIT');
  await expect(collectEvents(stream(': ping\n\n', false), AbortSignal.timeout(10))).rejects.toThrow();
});
