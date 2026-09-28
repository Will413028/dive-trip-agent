import { useEffect, useRef } from 'react';
import type { ProposalDraft, TripView } from '../../domain/types';
import type { ProposalReview } from '../../contracts/generated';
import { money } from '../../lib/presentation';

const fields: Record<string, string> = { requirements: '旅行需求', entries: '行程項目', people: '旅客人數', divers: '潛水人數', days: '天數', startDate: '出發日期', budgetMinor: '預算（最小貨幣單位）', destinationId: '目的地', pace: '步調', lodgingPreference: '住宿偏好', day: '日期', slot: '時段', rooms: '房數', locked: '鎖定', endDay: '退房日', item: '目錄資料', price: '價格', unitMinor: '單價（最小貨幣單位）', sources: '來源' };
function show(value: unknown): string {
  if (value === undefined) return '無';
  if (value === null) return '未定／待確認';
  if (value === true) return '是';
  if (value === false) return '否';
  if (typeof value === 'object') {
    if ('item' in value && typeof value.item === 'object' && value.item !== null && 'title' in value.item) return String(value.item.title);
    return JSON.stringify(value);
  }
  const labels: Record<string, string> = { morning: '上午', afternoon: '下午', evening: '晚上', relaxed: '放鬆留白', balanced: '適度安排', xiaoliuqiu: '小琉球', 'green-island': '綠島', kenting: '墾丁' };
  return labels[String(value)] ?? String(value);
}

export default function ProposalPanel({ proposalId, draft, base, review, busy, stale, uncertain, accept, reject }: {
  proposalId: string; draft: ProposalDraft; base: TripView; review: ProposalReview; busy: boolean; stale: boolean; uncertain: boolean; accept: () => void; reject: () => void;
}) {
  const panel = useRef<HTMLElement>(null);
  useEffect(() => { panel.current?.focus(); }, [proposalId]);
  const differences = review.differences;
  return <section ref={panel} tabIndex={-1} className="panel proposal-panel" data-testid="proposal-panel" aria-labelledby="proposal-title">
    <p className="eyebrow">REVIEW BEFORE YOU SAVE</p><h2 id="proposal-title">確認這次修改</h2><p>以版本 {base.version} 為基礎。接受前，原行程保持不變。</p>
    <p className="badge">{stale ? '提案已過期' : draft.canApply ? '等待你的確認' : '有衝突，暫時無法套用'}</p>
    {differences.length ? <ul className="diff-list">{differences.map((diff, index) => <li key={index}><strong>{diff.before === undefined ? '新增' : diff.after === undefined ? '移除' : '修改'} · {diff.path.split('/').slice(1).map(part => { const key = part.replaceAll('~1', '/').replaceAll('~0', '~'); return fields[key] ?? key; }).join(' / ')}</strong><div><span>{show(diff.before)}</span><span aria-hidden="true"> → </span><span>{show(diff.after)}</span></div></li>)}</ul> : <p>沒有內容差異。</p>}
    <div className="proposal-cost"><span>已知小計</span><strong>{money(base.budget.knownMinor)} → {money(draft.budget.knownMinor)}</strong><span>差額 {money(review.knownDeltaMinor)}</span></div>
    <p>{draft.budget.unknownEntryIds.length > 0 ? `另有 ${draft.budget.unknownEntryIds.length} 項費用待確認。` : ''}{draft.budget.withinBudget === null ? '尚不能確認全程在預算內。' : draft.budget.withinBudget ? '已計入項目在預算內。' : '已知費用超過預算。'}</p>
    {draft.issues.length > 0 && <div className="issue-box"><h3>需要留意</h3><ul>{draft.issues.map((issue, index) => <li key={index}>{issue.entryId && <strong>{issue.entryId} · </strong>}{issue.message} <small>({issue.code})</small></li>)}</ul></div>}
    <p className="muted">保留的鎖定項目：{draft.next.entries.filter(entry => entry.locked).map(entry => entry.item.title).join('、') || '無'}</p>
    {uncertain && <p role="status">上次套用結果尚未確認。重試會沿用相同請求，避免重複套用。</p>}
    <div className="actions"><button className="primary" disabled={busy || stale || !draft.canApply} onClick={accept}>{uncertain ? '重試接受修改' : '接受修改'}</button><button disabled={busy || uncertain} onClick={reject}>拒絕修改</button></div>
  </section>;
}
