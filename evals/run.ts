import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import cases from './cases.json' with { type: 'json' };
import { evaluationInput, fixtureCase } from './fixtures.ts';
import { summarize, type Attempt } from './grade.ts';

export function runFixtureEvaluation() {
  if (cases.length !== 10 || new Set(cases.map(c => c.id)).size !== 10) throw new Error('INVALID_EVAL_MANIFEST');
  const records: Attempt[] = [1, 2, 3].flatMap(round => cases.map(spec => {
    const start = performance.now();
    const { grade } = fixtureCase(spec.id);
    return { round, caseId: spec.id, inputFixture: `${spec.id}:${evaluationInput(spec.id).fixtureVersion}`, runId: `fixture:${round}:${spec.id}`, mode: 'fixture',
      model: 'domain-oracle-v1', latencyMs: performance.now() - start, toolCount: 0, costMicros: 0,
      outcome: 'completed', grade };
  }));
  return { kind: 'domain-fixture-self-check', modelCalls: 0, liveEvidence: false,
    warning: 'No Agent or LLM executed; these results cannot authorize release.',
    records, summary: summarize(records) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3 || process.argv[2] !== '--fixture') throw new Error('FIXTURE_FLAG_REQUIRED');
    const result = runFixtureEvaluation();
    console.log(JSON.stringify(result, null, 2));
    if (result.records.some(record => !record.grade.pass)) process.exitCode = 1;
  } catch { console.error('EVALUATION_FAILED'); process.exitCode = 1; }
}
