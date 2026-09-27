import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { withDatabase, testDatabaseUrl } from '../support/database';
import { database } from '../../src/server/db';

type Probe = { pid: number; modelCalls: number; applications: number; answer: unknown;
  interruptId: string | null; eventId: string | null; skipSummarization: boolean;
  restoredCounts: { modelCalls: number; toolCalls: number } | null };
function probe(config: { databaseUrl: string; schema: string; sessionId: string; confirmed: boolean;
  readCalls?: number; resumeExtraRead?: boolean; repeatId?: boolean }, phase: 'start' | 'resume' | 'replay') {
  return new Promise<Probe>((resolve, reject) => {
    const child = fork(new URL('../support/structured-output-worker.ts', import.meta.url), [], {
      env: { PATH: process.env.PATH, NODE_ENV: 'test', OTEL_SDK_DISABLED: 'true' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    let result: Probe | undefined;
    let failure = 'STRUCTURED_OUTPUT_PROBE_FAILED';
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
    child.on('message', (message: { ok: boolean; result?: Probe; code?: string }) => {
      if (message.ok) result = message.result;
      else if (message.code && /^AGENT_[A-Z_]+$/.test(message.code)) failure = message.code;
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => {
      clearTimeout(timer);
      if (code === 0 && result) resolve(result); else reject(new Error(failure));
    });
    child.send({ ...config, phase });
  });
}
test.each([true, false])('PostgreSQL + fresh child: validate → confirm (%s) → structured answer → zero-model replay', confirmed => withDatabase(async () => {
  const schema = (await database().query('SELECT current_schema() AS name')).rows[0].name;
  const config = { databaseUrl: testDatabaseUrl(), schema: `${schema}_adk`, sessionId: randomUUID(), confirmed };
  const started = await probe(config, 'start');
  expect(started).toMatchObject({ modelCalls: 2, applications: 0, answer: null });
  expect(started.interruptId).toBeTruthy();
  const resumed = await probe(config, 'resume');
  expect(resumed).toMatchObject({ modelCalls: 1, applications: confirmed ? 1 : 0,
    answer: { intent: 'receipt', references: ['proposal'] }, skipSummarization: true });
  expect(resumed.pid).not.toBe(started.pid);
  const replayed = await probe(config, 'replay');
  expect(replayed).toMatchObject({ ...resumed, pid: expect.any(Number), modelCalls: 0, restoredCounts: null });
  expect(replayed.pid).not.toBe(resumed.pid);
  expect((await database().query('SELECT * FROM proposals')).rowCount).toBe(0);
}), 45000);

test.each(['last-slot', 'over-limit', 'repeat-id'] as const)('fresh child restores durable policy history: %s', mode => withDatabase(async () => {
  const schema = (await database().query('SELECT current_schema() AS name')).rows[0].name;
  const config = { databaseUrl: testDatabaseUrl(), schema: `${schema}_adk`, sessionId: randomUUID(), confirmed: true, readCalls: 3 };
  expect(await probe(config, 'start')).toMatchObject({ modelCalls: 5, applications: 0, answer: null });
  if (mode === 'last-slot') expect(await probe(config, 'resume')).toMatchObject({ modelCalls: 1, applications: 1,
    restoredCounts: { modelCalls: 5, toolCalls: 5 }, skipSummarization: true });
  else await expect(probe({ ...config, resumeExtraRead: mode === 'over-limit', repeatId: mode === 'repeat-id' }, 'resume'))
    .rejects.toThrow(mode === 'over-limit' ? 'AGENT_TOOL_LIMIT' : 'AGENT_MODEL_RESPONSE');
}), 45000);
