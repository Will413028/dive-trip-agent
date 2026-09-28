import assert from 'node:assert/strict';
import { withPythonEvaluation } from '../../evals/python-evaluation.ts';
import { Pool } from 'pg';

let captured;
let dispatches = 0;
let loads = 0;
try {
  await withPythonEvaluation({
    databasePort: Number(process.argv[2]), temporalBinary: process.argv[3],
    accountId: 'a'.repeat(32), priorChargedMicros: 0, synthetic: true,
    loadCredential: async () => { loads += 1; return 'synthetic-not-a-real-key'; },
  }, async ports => {
    const result = await ports.execute('free-afternoon', async signal => {
      signal.throwIfAborted(); dispatches += 1;
    });
    assert.equal(result.evidence.afterVersion, 2);
    assert.equal(result.evidence.modelCalls, 2);
    assert.deepEqual(result.grade.safetyFailures, []);
    captured = await ports.capture();
    assert.equal(captured.privateUsageComplete, true);
    assert.equal(captured.usageKnown, true);
    assert.equal(captured.totalTokens, 4);
    if (process.argv[4] === 'drift') {
      const schema = captured.record.retainedSchema;
      assert.match(schema, /^python_test_[a-f0-9]{32}$/);
      const pool = new Pool({ host: '127.0.0.1', port: Number(process.argv[2]), database: 'dive_trip_test',
        user: 'postgres', password: 'offline-placeholder-not-a-credential', ssl: false,
        connectionTimeoutMillis: 2000, statement_timeout: 2000 });
      try {
        await pool.query(`INSERT INTO "${schema}".sessions(id,token_hash) VALUES(gen_random_uuid(),repeat('f',64))`);
      } finally { await pool.end(); }
    }
    if (process.argv[4] === 'retain') throw new Error('SYNTHETIC_REPORT_STOP');
  });
} catch (error) {
  if (process.argv[4] === 'drift') {
    assert.match(error.message, /EVAL_PYTHON_DRAIN_UNVERIFIED/);
  } else if (process.argv[4] !== 'retain' || error.message !== 'SYNTHETIC_REPORT_STOP') throw error;
}
assert.equal(loads, 1);
assert.equal(dispatches, 2);
process.stdout.write(JSON.stringify({ captured, loads, dispatches }));
