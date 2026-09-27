import { useState } from 'react';
import type { CatalogItem, Change, Entry, Slot, Snapshot } from '../../domain/types';
import { money } from './client';

const slots: { value: Slot; label: string }[] = [{ value: 'morning', label: '上午' }, { value: 'afternoon', label: '下午' }, { value: 'evening', label: '晚上' }];
type Actions = { disabled: boolean; propose: (changes: Change[]) => void };
function EntryCard({ entry, days, catalog, disabled, propose }: Actions & { entry: Entry; days: number; catalog: CatalogItem[] }) {
  const [day, setDay] = useState(entry.day);
  const [slot, setSlot] = useState(entry.slot);
  const [replacement, setReplacement] = useState(entry.catalogId);
  const [rooms, setRooms] = useState(String(entry.rooms ?? 1));
  const options = catalog.filter(item => item.kind === entry.item.kind && item.destinationId === entry.item.destinationId);
  return <article className={`entry ${entry.locked ? 'locked' : ''}`} data-testid={`entry-${entry.id}`}>
    <div className="entry-heading"><span className="entry-time">{slots.find(s => s.value === entry.slot)?.label}{entry.endDay !== null && ` · 住至第 ${entry.endDay} 天`}</span><span className="badge">{entry.locked ? '已鎖定' : entry.item.price.basis === 'demo' ? 'DEMO' : '估算'}</span></div>
    <h3>{entry.item.title}</h3><p className="muted">{entry.item.price.unitMinor === null ? `費用待確認：${entry.item.price.unknownReason ?? '待報價'}` : `${money(entry.item.price.unitMinor)} / ${entry.item.price.unit === 'person' ? '人' : entry.item.price.unit === 'room-night' ? '房・晚' : '團'}`}{entry.rooms !== null && ` · ${entry.rooms} 房`}</p>
    <div className="actions"><button disabled={disabled} aria-label={`${entry.locked ? '解鎖' : '鎖定'} ${entry.id}`} onClick={() => propose([{ kind: 'lock', entryId: entry.id, locked: !entry.locked }])}>{entry.locked ? '解鎖' : '鎖定'}</button><button className="text-danger" disabled={disabled || entry.locked} aria-label={`移除 ${entry.id}`} onClick={() => propose([{ kind: 'remove', entryId: entry.id }])}>移除</button></div>
    {entry.locked && <p className="field-hint">請先提出解鎖並接受，再修改此項目。</p>}
    <details><summary>移動、替換與詳細資料</summary><fieldset disabled={disabled || entry.locked} className="form-fields compact">
      <div className="field-grid"><label>移動日期 · {entry.id}<select value={day} onChange={e => setDay(Number(e.target.value))}>{Array.from({ length: days }, (_, i) => <option key={i} value={i + 1}>第 {i + 1} 天</option>)}</select></label><label>時段 · {entry.id}<select value={slot} onChange={e => setSlot(e.target.value as Slot)}>{slots.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}</select></label></div>
      <button onClick={() => propose([{ kind: 'move', entryId: entry.id, day, slot }])}>提出移動 {entry.id}</button>
      <label>替換項目 · {entry.id}<select value={replacement} onChange={e => setReplacement(e.target.value)}>{!options.some(item => item.id === replacement) && <option value={replacement}>目前項目</option>}{options.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label><button disabled={!options.some(item => item.id === replacement)} onClick={() => propose([{ kind: 'replace', entryId: entry.id, catalogId: replacement }])}>提出替換 {entry.id}</button>
      {entry.rooms !== null && <form onSubmit={e => { e.preventDefault(); propose([{ kind: 'rooms', entryId: entry.id, rooms: Number(rooms) }]); }}><label>房數 · {entry.id}<input required type="number" min="1" step="1" value={rooms} onChange={e => setRooms(e.target.value)} /></label><button type="submit">提出房數修改 {entry.id}</button></form>}
    </fieldset><ul className="sources">{entry.item.sources.map(source => <li key={source.id}>{source.kind === 'demo' ? 'DEMO · ' : ''}{source.label} · 查核 {source.checkedAt}{source.url && /^https?:\/\//.test(source.url) && <> · <a href={source.url} target="_blank" rel="noreferrer">來源</a></>}</li>)}</ul></details>
  </article>;
}

export default function DayCards({ snapshot, catalog, disabled, propose }: Actions & { snapshot: Snapshot; catalog: CatalogItem[] }) {
  const [catalogId, setCatalogId] = useState('');
  const [day, setDay] = useState(1);
  const [slot, setSlot] = useState<Slot>('afternoon');
  const activities = catalog.filter(item => item.kind === 'activity' && item.destinationId === snapshot.requirements.destinationId);
  return <section aria-label="每日行程"><div className="section-heading"><div><p className="eyebrow">YOUR DAYS BY THE SEA</p><h2>每日行程</h2></div><span className="muted">{snapshot.requirements.days} 天 · 已儲存內容</span></div>
    {Array.from({ length: snapshot.requirements.days }, (_, index) => <section className="day" key={index}><h3 className="day-title"><span>{String(index + 1).padStart(2, '0')}</span> 第 {index + 1} 天</h3><div className="day-entries">{snapshot.entries.filter(entry => entry.day === index + 1).map(entry => <EntryCard key={entry.id} entry={entry} days={snapshot.requirements.days} catalog={catalog} disabled={disabled} propose={propose} />)}{!snapshot.entries.some(entry => entry.day === index + 1) && <p className="empty-day">留白也是行程。這天尚未安排新項目。</p>}</div></section>)}
    <section className="panel"><h3>再加一個活動</h3><p className="muted">只列出已儲存目的地的目錄活動。</p><form onSubmit={e => { e.preventDefault(); if (!activities.some(item => item.id === catalogId)) return; propose([{ kind: 'add', entry: { id: `activity-${crypto.randomUUID()}`, catalogId, day, slot, rooms: null, endDay: null } }]); }}><fieldset disabled={disabled} className="form-fields">
      <label>新增活動<select required value={catalogId} onChange={e => setCatalogId(e.target.value)}><option value="">選擇活動</option>{activities.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
      <div className="field-grid"><label>安排日期<select value={day} onChange={e => setDay(Number(e.target.value))}>{Array.from({ length: snapshot.requirements.days }, (_, i) => <option key={i} value={i + 1}>第 {i + 1} 天</option>)}</select></label><label>安排時段<select value={slot} onChange={e => setSlot(e.target.value as Slot)}>{slots.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}</select></label></div>
      <button disabled={!activities.length} type="submit">提出新增活動</button>{!activities.length && <p className="muted">此目的地目前沒有可用活動。</p>}
    </fieldset></form></section>
  </section>;
}
