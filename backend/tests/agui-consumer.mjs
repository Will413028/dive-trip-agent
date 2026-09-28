import { HttpAgent } from '@ag-ui/client';
import { validateAnswerPhase, validateAnswerStream } from '../../evals/replay-bundle.ts';

let input = '';
for await (const chunk of process.stdin) input += chunk;
const { threadId, runId, stream, phase } = JSON.parse(input);
const agent = new HttpAgent({
  url: 'http://fixture.invalid/agent', threadId,
  fetch: async () => new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream' },
  }),
});
const events = [];
try {
  await agent.runAgent({ runId, tools: [], context: [] }, {
    onEvent: ({ event }) => { events.push(event); },
  });
  const logicalRunId = events.find(event => event.type === 'CUSTOM')?.value.runId;
  validateAnswerStream(events, { tripId: threadId, requestId: runId, runId: logicalRunId });
  if (phase) validateAnswerPhase(events, phase);
  process.stdout.write(JSON.stringify({ ok: true, events }));
} catch {
  process.stdout.write(JSON.stringify({ ok: false }));
}
