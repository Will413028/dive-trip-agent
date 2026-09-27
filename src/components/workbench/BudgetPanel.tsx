import type { Budget, Snapshot } from '../../domain/types';
import { money } from './client';

export default function BudgetPanel({ budget, snapshot }: { budget: Budget; snapshot: Snapshot }) {
  return <section className="panel budget-panel"><p className="eyebrow">BUDGET NOTES</p><h2>把費用也想清楚</h2>
    <p className="muted">已知項目小計</p><p className="budget-total">{money(budget.knownMinor)}</p>
    <p>預算：{snapshot.requirements.budgetMinor === null ? '未定' : money(snapshot.requirements.budgetMinor)}</p>
    <p className="budget-status">{budget.withinBudget === null ? '尚不能確認全程在預算內' : budget.withinBudget ? '已計入項目在預算內' : '已知費用超過預算'}</p>
    {budget.unknownEntryIds.length > 0 && <div><h3>＋ 待確認費用</h3><ul>{budget.unknownEntryIds.map(id => { const entry = snapshot.entries.find(e => e.id === id); return <li key={id}>{entry?.item.title ?? id}：{entry?.item.price.unknownReason ?? '待確認'}</li>; })}</ul></div>}
    <h3>未納入費用</h3>{snapshot.exclusions.length ? <ul>{snapshot.exclusions.map((text, i) => <li key={i}>{text}</li>)}</ul> : <p className="muted">目前未列額外排除項；未安排的餐飲、交通與裝備不代表免費。</p>}
    <p className="field-hint">DEMO 價格為示範；估算價格不是報價或可訂保證。</p>
  </section>;
}
