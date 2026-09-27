import { calculateBudget } from '../../src/domain/budget';
import { compileAnswer } from '../../src/agent/answer-compiler';
import { requirementsEvidence, toolEvidence } from '../../src/agent/answer-evidence';
import { makeSnapshot } from './domain-fixtures';
import { assistantUnsafeSample } from './assistant-format-fixture';

// Browser presentation fixture only, not an executed model or quality result.
export const answerFixtureRunId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
export function acceptedAnswerFixture() {
  const snapshot = makeSnapshot();
  const unknown = snapshot.entries.find(entry => entry.id === 'tour')!.item;
  unknown.price = { ...unknown.price, unitMinor: null, unknownReason: '尚待確認費用，不代表零元' };
  unknown.sources[0].label = `DEMO ${assistantUnsafeSample}`;
  snapshot.exclusions = ['未納入餐食與裝備'];
  const binding = { ownerId: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb', tripId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    runId: answerFixtureRunId, baseVersion: 1 };
  const catalog = snapshot.entries.map(entry => entry.item);
  const budget = toolEvidence(binding, snapshot, catalog, { id: 'synthetic-budget', name: 'calculate_budget', args: {},
    result: calculateBudget(snapshot) });
  const context = { binding, eventId: 'synthetic-browser-answer', evidence: [requirementsEvidence(binding, snapshot), budget] };
  return compileAnswer({ version: '1', answer: { kind: 'budget', evidenceRef: budget.id } }, context);
}
