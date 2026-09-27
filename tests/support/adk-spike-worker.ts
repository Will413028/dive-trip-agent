// Local capability probe only: fixed model, no credentials, no public endpoint.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { App, BaseLlm, LlmAgent, FunctionTool, Runner, DatabaseSessionService,
  type LlmRequest, type LlmResponse, type BaseLlmConnection } from '@google/adk';
import { EventType, type BaseEvent, type Interrupt } from '@ag-ui/core';
import { RunAgentInputSchema, EventSchemas } from '@ag-ui/core/schemas';
import { z } from 'zod';

const dbUrl = new URL(process.argv[2]);
if (dbUrl.hostname !== '127.0.0.1' || dbUrl.pathname !== '/dive_trip_adk_spike') {
  throw new Error('Only the dedicated local spike database is allowed');
}
const sessions = new DatabaseSessionService(dbUrl.href);
const appName = 'dive_trip_adk_spike';
const userId = 'synthetic_operator';

class FixedModel extends BaseLlm {
  constructor() { super({ model: 'offline-fixture' }); }
  async *generateContentAsync(request: LlmRequest): AsyncGenerator<LlmResponse> {
    const hasCall = request.contents.some(c => c.parts?.some(p => p.functionCall));
    yield { content: { role: 'model', parts: hasCall
      ? [{ text: 'Fixture turn finished.' }]
      : [{ functionCall: { id: randomUUID(), name: 'apply_demo_change', args: { amount: 100 } } }] } };
  }
  async connect(): Promise<BaseLlmConnection> { throw new Error('Network disabled'); }
}

const apply = new FunctionTool({
  name: 'apply_demo_change', description: 'Apply a synthetic change after approval.',
  parameters: z.object({ amount: z.literal(100) }).strict(),
  requireConfirmation: true,
  execute: ({ amount }, context) => {
    if (!context) throw new Error('Missing tool context');
    context.state.set('applications', Number(context.state.get('applications') ?? 0) + 1);
    return { applied: amount };
  },
});
const runner = new Runner({
  app: new App({ name: appName, rootAgent: new LlmAgent({ name: 'probe',
    model: new FixedModel(), tools: [apply] }), resumabilityConfig: { isResumable: true } }),
  sessionService: sessions,
});

// This is a deliberately small application adapter, not a replacement ADK loop.
const server = createServer(async (req, res) => {
  const host = req.headers.host ?? '';
  if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host) ||
    (req.headers.origin && req.headers.origin !== `http://${host}` &&
      req.headers.origin !== 'http://127.0.0.1:4317')) {
    res.writeHead(403).end(); return;
  }
  const send = (event: BaseEvent) => {
    const parsed = EventSchemas.parse(event);
    res.write(`data: ${JSON.stringify(parsed)}\n\n`);
  };
  try {
    const url = new URL(req.url ?? '/', `http://${host}`);
    if (req.method === 'GET' && url.pathname === '/session') {
      const sessionId = z.uuid().parse(url.searchParams.get('threadId'));
      const saved = await sessions.getSession({ appName, userId, sessionId });
      if (!saved) { res.writeHead(404).end(); return; }
      const calls = saved.events.flatMap(e => e.content?.parts ?? [])
        .flatMap(p => p.functionCall?.name === 'adk_request_confirmation' ? [p.functionCall] : []);
      const gate = calls.at(-1);
      const original = gate?.args?.originalFunctionCall as { id?: string } | undefined;
      const responses = saved.events.flatMap(e => e.content?.parts ?? [])
        .flatMap(p => p.functionResponse ? [p.functionResponse] : []);
      const result = original?.id ? responses.find(r => r.id === original.id &&
        (r.response?.applied === 100 || r.response?.error === 'This tool call is rejected.')) : undefined;
      const status = result ? (result.response?.applied === 100 ? 'approved' : 'rejected') : gate ? 'pending' : 'idle';
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ status, applications: saved.state.applications ?? 0,
        interruptId: status === 'pending' ? gate?.id : null }));
      return;
    }
    if (req.method !== 'POST' || url.pathname !== '/agent') { res.writeHead(404).end(); return; }
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 32_768) throw new Error('Input too large');
    }
    const input = RunAgentInputSchema.parse(JSON.parse(body));
    z.uuid().parse(input.threadId);
    const identity = { appName, userId, sessionId: input.threadId };
    let session = await sessions.getSession(identity);
    if (!session) {
      if (input.resume?.length) throw new Error('Cannot resume a missing session');
      session = await sessions.createSession({ ...identity, state: { applications: 0 } });
    }
    const answer = input.resume?.[0];
    if ((input.resume?.length ?? 0) > 1) throw new Error('Probe accepts one confirmation');
    if (answer) {
      const known = session.events.some(e => e.content?.parts?.some(p =>
        p.functionCall?.name === 'adk_request_confirmation' && p.functionCall.id === answer.interruptId));
      if (!known) throw new Error('Unknown confirmation');
      z.object({ confirmed: z.boolean() }).strict().parse(answer.payload);
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
    send({ type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId });
    const interrupts: Interrupt[] = [];
    const parts = answer ? [{ functionResponse: { id: answer.interruptId,
      name: 'adk_request_confirmation', response: {
        confirmed: answer.status === 'resolved' && answer.payload.confirmed === true,
      } } }] : [{ text: 'Propose one synthetic change.' }];
    for await (const event of runner.runAsync({ userId, sessionId: input.threadId,
      newMessage: { role: 'user', parts }, abortSignal: AbortSignal.timeout(15_000),
      runConfig: { maxLlmCalls: 3 } })) {
      for (const part of event.content?.parts ?? []) {
        const call = part.functionCall;
        if (call?.id && call.name) {
          send({ type: EventType.TOOL_CALL_START, toolCallId: call.id, toolCallName: call.name });
          send({ type: EventType.TOOL_CALL_ARGS, toolCallId: call.id, delta: JSON.stringify(call.args ?? {}) });
          send({ type: EventType.TOOL_CALL_END, toolCallId: call.id });
          if (call.name === 'adk_request_confirmation') interrupts.push({
            id: call.id, toolCallId: call.id, reason: 'approval',
            message: '套用合成資料修改？（非真實 Gemini）', metadata: { request: call.args },
          });
        }
        if (part.text) {
          const messageId = randomUUID();
          send({ type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant' });
          send({ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: part.text });
          send({ type: EventType.TEXT_MESSAGE_END, messageId });
        }
      }
    }
    const saved = await sessions.getSession(identity);
    send({ type: EventType.STATE_SNAPSHOT, snapshot: saved?.state ?? {} });
    send({ type: EventType.RUN_FINISHED, threadId: input.threadId, runId: input.runId,
      outcome: interrupts.length ? { type: 'interrupt', interrupts } : { type: 'success' } });
    res.end();
  } catch (error) {
    if (res.headersSent) {
      send({ type: EventType.RUN_ERROR, message: error instanceof Error ? error.message : 'Probe failed' });
      res.end();
    } else { res.writeHead(400).end('Probe request rejected'); }
  }
});
await sessions.init();
server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (address && typeof address !== 'string') process.send?.({ port: address.port });
});
