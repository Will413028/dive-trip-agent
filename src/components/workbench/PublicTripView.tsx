import type { PublicTrip } from '../../domain/public-trip';
import { destinations, money } from './client';

export default function PublicTripView({ trip }: { trip: PublicTrip }) {
  const slots = { morning: '上午', afternoon: '下午', evening: '晚上' };
  return <div data-testid="public-trip">
    <h2>{destinations.find(item => item.id === trip.destinationId)?.name ?? '目的地待確認'} · {trip.days} 天 · {trip.people} 人</h2>
    <p>已知小計 {money(trip.budget.knownMinor)} · 預算 {trip.budget.limitMinor === null ? '未定' : money(trip.budget.limitMinor)}</p>
    <p>未知費用 {trip.budget.unknownCount} 項，排除費用 {trip.budget.exclusionsCount} 項；未安排項目不代表免費。</p>
    <p className="field-hint">示範／估算價格不是報價或可訂保證，亦非潛水安全背書。</p>
    {trip.entries.map((entry, index) => <article className="chat-run" key={index}>
      <h3>第 {entry.day} 天 {slots[entry.slot]} · {entry.title}</h3>
      {entry.demo && <span className="badge">DEMO</span>}
      {entry.endDay !== null && <p>住至第 {entry.endDay} 天 · {entry.rooms} 房</p>}
      <p>{entry.price.unitMinor === null ? '價格待確認' : money(entry.price.unitMinor)} / {entry.price.unit === 'group' ? '團' : entry.price.unit === 'person' ? '人' : '房晚'}</p>
      {!entry.sourceVerified && <p>此封存項目的來源待重新確認，未公開其原始文字。</p>}
      {entry.sources.map((source, i) => <p className="field-hint" key={i}>
        {source.url ? <a href={source.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{source.label}</a> : source.label}
        {' · '}查核 {source.checkedAt}
      </p>)}
    </article>)}
  </div>;
}
