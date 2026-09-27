import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork, execFileSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { HttpAgent } from '@ag-ui/client';
import { EventType, type BaseEvent, type ResumeEntry } from '@ag-ui/core';

const port = execFileSync('docker', ['port', 'dive-trip-adk-spike', '5432'], { encoding: 'utf8' }).trim().split(':').at(-1);
const db = `postgresql://postgres@127.0.0.1:${port}/dive_trip_adk_spike`;
async function start(): Promise<{ child: ChildProcess; url: string }> {
  const child = fork(new URL('./support/adk-spike-worker.ts', import.meta.url), [db], {
    env: { PATH: process.env.PATH, NODE_ENV: 'test', OTEL_SDK_DISABLED: 'true' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  return new Promise((resolve, reject) => {
    let logs = '';
    child.stdout?.on('data', chunk => { logs += chunk; });
    child.stderr?.on('data', chunk => { logs += chunk; });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Startup timeout: ${logs}`)); }, 20_000);
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Worker exit ${code}: ${logs}`)); });
    child.once('message', (message: { port: number }) => {
      clearTimeout(timer); resolve({ child, url: `http://127.0.0.1:${message.port}/agent` });
    });
  });
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  child.kill('SIGKILL');
  await exited;
}

test('AG-UI rejects missing-session and unknown confirmations', { timeout: 30_000 }, async () => {
  const worker = await start();
  try {
    const threadId = randomUUID();
    const invalid = { threadId, runId: randomUUID(), messages: [], state: {}, tools: [],
      context: [], forwardedProps: {}, resume: [{ interruptId: 'unknown', status: 'resolved', payload: { confirmed: true } }] };
    const post = () => fetch(worker.url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(invalid), signal: AbortSignal.timeout(5000) });
    assert.equal((await post()).status, 400);
    const pending = await run(worker.url, threadId);
    assert.equal(snapshot(pending).snapshot.applications, 0);
    assert.equal((await post()).status, 400);
    invalid.resume[0].interruptId = gate(pending);
    const response = await post();
    assert.equal(response.status, 200);
    await response.text();
  } finally { await stop(worker.child); }
});
async function run(url: string, threadId: string, resume?: ResumeEntry[]) {
  const events: BaseEvent[] = [];
  const client = new HttpAgent({ url, threadId });
  await client.runAgent({ runId: randomUUID(), resume }, { onEvent: ({ event }) => { events.push(event); } });
  assert(!events.some(e => e.type === EventType.RUN_ERROR), JSON.stringify(events));
  return events;
}
async function restore(url: string, threadId: string) {
  const response = await fetch(`${url.replace('/agent', '/session')}?threadId=${threadId}`, {
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  return response.json();
}
const snapshot = (events: BaseEvent[]) => [...events].reverse().find(e => e.type === EventType.STATE_SNAPSHOT) as
  BaseEvent & { snapshot: { applications: number } };
const gate = (events: BaseEvent[]) => {
  const event = events.find(e => e.type === EventType.RUN_FINISHED) as
    BaseEvent & { outcome: { type: string; interrupts: { id: string }[] } };
  assert.equal(event.outcome.type, 'interrupt');
  return event.outcome.interrupts[0].id;
};

for (const confirmed of [true, false]) {
  test(`ADK + AG-UI: restart, ${confirmed ? 'approve' : 'reject'}, duplicate`, { timeout: 60_000 }, async () => {
    const threadId = randomUUID();
    let worker = await start();
    try {
      const pending = await run(worker.url, threadId);
      assert.equal(snapshot(pending).snapshot.applications, 0);
      assert(pending.some(e => e.type === EventType.TOOL_CALL_START));
      const resume: ResumeEntry[] = [{ interruptId: gate(pending), status: 'resolved', payload: { confirmed } }];
      const firstPid = worker.child.pid;
      await stop(worker.child);
      worker = await start();
      assert.notEqual(worker.child.pid, firstPid);
      assert.deepEqual(await restore(worker.url, threadId), {
        status: 'pending', applications: 0, interruptId: resume[0].interruptId,
      });
      const resumed = await run(worker.url, threadId, resume);
      assert.equal(snapshot(resumed).snapshot.applications, confirmed ? 1 : 0);
      await stop(worker.child);
      worker = await start();
      assert.deepEqual(await restore(worker.url, threadId), {
        status: confirmed ? 'approved' : 'rejected', applications: confirmed ? 1 : 0, interruptId: null,
      });
      const repeated = await run(worker.url, threadId, resume);
      assert.equal(snapshot(repeated).snapshot.applications, confirmed ? 1 : 0);
      if (!confirmed) {
        await stop(worker.child);
        worker = await start();
        const lateApproval = await run(worker.url, threadId, [{
          interruptId: resume[0].interruptId, status: 'resolved', payload: { confirmed: true },
        }]);
        assert.equal(snapshot(lateApproval).snapshot.applications, 0,
          'A rejected confirmation must not become approved after restart');
      }
    } finally { await stop(worker.child); }
  });
}

test('probe rejects foreign browser origins and invalid session ids', { timeout: 30_000 }, async () => {
  const worker = await start();
  try {
    const url = worker.url.replace('/agent', '/session');
    const foreign = await fetch(`${url}?threadId=${randomUUID()}`, {
      headers: { Origin: 'https://untrusted.example' }, signal: AbortSignal.timeout(5000),
    });
    assert.equal(foreign.status, 403);
    assert.equal((await fetch(`${url}?threadId=invalid`, { signal: AbortSignal.timeout(5000) })).status, 400);
  } finally { await stop(worker.child); }
});
