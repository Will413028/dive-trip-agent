import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Duplex } from 'node:stream';
import { PythonEvaluationChannel } from '../../evals/python-evaluation-channel.ts';

const child = spawn(process.argv[2], ['backend/tests/evaluation_channel_probe.py'], {
  stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
});
const exited = once(child, 'exit');
const pipe = child.stdio[3];
assert(pipe instanceof Duplex);
let loads = 0;
let abort;
const channel = new PythonEvaluationChannel(pipe, async () => {
  loads += 1;
  if (abort) setTimeout(() => abort.abort(), 10);
  return 'synthetic-not-a-real-key';
});
try {
  assert.deepEqual(await channel.call('request', {}, { generation: true }), { synthetic: true });
  assert.equal(loads, 1);
  abort = new AbortController();
  await assert.rejects(channel.call('request', { wait: true }, {
    generation: true, signal: abort.signal,
  }), /EVAL_PYTHON_ABORTED/);
  assert.deepEqual(await channel.call('audit', {}), { cleaned: true });
  assert.equal(loads, 2);
  // A child cannot ask the parent for generation in a receipt-only phase.
  await assert.rejects(channel.call('request', {}), /EVAL_PYTHON_PROTOCOL_INVALID/);
  assert.equal(loads, 2);
  process.stdout.write(JSON.stringify({ ok: true }));
} finally {
  channel.close();
  const timer = setTimeout(() => child.kill(), 5000);
  await exited;
  clearTimeout(timer);
}
