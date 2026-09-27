import { useState } from 'react';
import type { Change, Requirements } from '../../domain/types';
import DestinationCards from './DestinationCards';

export default function RequirementsForm({ initial, disabled, propose }: { initial: Requirements; disabled: boolean; propose: (changes: Change[]) => void }) {
  const [fields, setFields] = useState({ ...initial, people: String(initial.people), divers: String(initial.divers), days: String(initial.days), startDate: initial.startDate ?? '', budget: initial.budgetMinor === null ? '' : String(initial.budgetMinor / 100) });
  const [error, setError] = useState('');
  const update = (key: string, value: string) => setFields(current => ({ ...current, [key]: value }));
  return <section className="panel"><p className="eyebrow">YOUR PREFERENCES</p><h2>這趟旅行，想怎麼過？</h2><p className="muted">調整後先產生提案，不會直接更改行程。</p>
    <form onSubmit={event => {
      event.preventDefault();
      const budgetMinor = fields.budget === '' ? null : Math.round(Number(fields.budget) * 100);
      if (budgetMinor !== null && (!Number.isSafeInteger(budgetMinor) || budgetMinor < 0)) { setError('請填入有效的 TWD 預算。'); return; }
      if (Number(fields.divers) > Number(fields.people)) { setError('潛水人數不能超過總人數。'); return; }
      setError('');
      propose([{ kind: 'requirements', value: { destinationId: fields.destinationId, people: Number(fields.people), divers: Number(fields.divers), days: Number(fields.days), startDate: fields.startDate || null, budgetMinor, pace: fields.pace, lodgingPreference: fields.lodgingPreference } }]);
    }}><fieldset disabled={disabled} className="form-fields">
      <DestinationCards value={fields.destinationId} onChange={destinationId => setFields(current => ({ ...current, destinationId }))} />
      <div className="field-grid"><label>旅客人數<input required type="number" min="1" max="6" step="1" value={fields.people} onChange={e => update('people', e.target.value)} /></label><label>潛水人數<input required type="number" min="0" max={fields.people} step="1" value={fields.divers} onChange={e => update('divers', e.target.value)} /></label></div>
      <div className="field-grid"><label>天數<input required type="number" min="2" max="7" step="1" value={fields.days} onChange={e => update('days', e.target.value)} /></label><label>出發日期<input type="date" value={fields.startDate} onChange={e => update('startDate', e.target.value)} /></label></div>
      <p className="field-hint">{fields.startDate ? '日期僅作規劃，不保證當日開放或可訂。' : '日期未定 · 可先留白'}</p>
      <label>整趟預算（TWD）<input type="number" min="0" step="0.01" placeholder="預算未定" value={fields.budget} onChange={e => update('budget', e.target.value)} /></label>
      <label>住宿偏好<input maxLength={500} value={fields.lodgingPreference} onChange={e => update('lodgingPreference', e.target.value)} /></label>
      <label>旅行步調<select value={fields.pace} onChange={e => setFields(current => ({ ...current, pace: e.target.value as Requirements['pace'] }))}><option value="relaxed">放鬆留白</option><option value="balanced">適度安排</option></select></label>
      {error && <p className="error" role="alert">{error}</p>}
      <button className="primary full" type="submit">產生需求提案</button>
    </fieldset></form>
  </section>;
}
