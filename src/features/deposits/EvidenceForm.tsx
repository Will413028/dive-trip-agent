import { useState } from 'react';

// Synthetic sample: the agent can read it, the threshold rules cannot.
export const SAMPLE_NOTICE = 'OPERATOR NOTICE (demo): Day 1 dives went ahead as planned. Due to the northeast '
  + 'swell, all boats are cancelled on Day 2. Day 3 morning dives depend on the 6 pm update; we will post again tonight.';

export default function EvidenceForm({ tripDays, busy, onNotice, onStorm }: {
  tripDays: number; busy: boolean;
  onNotice: (kind: 'notice' | 'alert', body: string) => Promise<boolean>;
  onStorm: (days: number[]) => void;
}) {
  const [kind, setKind] = useState<'notice' | 'alert'>('notice');
  const [body, setBody] = useState('');
  const [days, setDays] = useState<number[]>([2].filter((d) => d <= tripDays));
  return <section className="panel" aria-labelledby="evidence-title">
    <h2 id="evidence-title">Cancellation evidence</h2>
    <form onSubmit={(e) => { e.preventDefault(); void onNotice(kind, body.trim()).then((ok) => { if (ok) setBody(''); }); }}>
      <label htmlFor="evidence-kind">Type</label>
      <select id="evidence-kind" value={kind} onChange={(e) => setKind(e.target.value as 'notice' | 'alert')}>
        <option value="notice">Operator notice</option><option value="alert">Marine or weather alert</option>
      </select>
      <label htmlFor="evidence-body">Text</label>
      <p id="evidence-warning" className="warning" role="note">
        Paste demo text only. It is sent to a free-tier AI model (Gemini or Groq); do not paste personal or real booking data.
      </p>
      <textarea id="evidence-body" aria-describedby="evidence-warning" rows={4} maxLength={4000}
        value={body} onChange={(e) => setBody(e.target.value)} />
      <div className="actions">
        <button type="button" disabled={busy} onClick={() => { setKind('notice'); setBody(SAMPLE_NOTICE); }}>Use sample notice</button>
        <button type="submit" className="primary" disabled={busy || !body.trim()}>Add evidence</button>
      </div>
    </form>
    <fieldset className="storm">
      <legend>Simulated storm (demo only)</legend>
      <p className="muted">Adds synthetic forecast evidence flagged as simulated. The threshold rules read it.</p>
      <div className="days">{Array.from({ length: tripDays }, (_, i) => i + 1).map((day) => <label key={day}>
        <input type="checkbox" checked={days.includes(day)}
          onChange={(e) => setDays(e.target.checked ? [...days, day].sort((a, b) => a - b) : days.filter((d) => d !== day))} />Day {day}
      </label>)}</div>
      <button disabled={busy || days.length === 0} onClick={() => onStorm(days)}>Simulate storm</button>
    </fieldset>
  </section>;
}
