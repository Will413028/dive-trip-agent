import { createInterface } from 'node:readline';
import { collectCase } from '../../evals/collector.ts';

const lines = createInterface({ input: process.stdin });
const iterator = lines[Symbol.asyncIterator]();
async function rpc(operation, input) {
  process.stdout.write(`${JSON.stringify({ operation, input })}\n`);
  const line = await iterator.next();
  if (line.done) throw new Error('EVALUATION_PROBE_EOF');
  return JSON.parse(line.value);
}
try {
  let replay;
  const result = await collectCase('free-afternoon', {
    model: 'gemini-3.1-flash-lite',
    setup: input => rpc('setup', { before: input.before, catalog: input.catalog, fault: input.fault }),
    request: async (path, body) => {
      const value = await rpc('request', { path, body: body ?? null });
      return new Response(value.body, { status: value.status, headers: { 'content-type': value.contentType } });
    },
    audit: runId => rpc('audit', { runId }),
    captureReplay: value => { replay = value; },
  });
  process.stdout.write(`${JSON.stringify({ operation: 'result', input: { result, replay } })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ operation: 'error', input: { code: error.message } })}\n`);
  process.exitCode = 1;
} finally {
  lines.close();
}
