import { ACTION_LABEL, REASON_LABEL, sourceLabel, usd } from './format';
import type { Diver, Evidence, Settlement } from './types';

export default function SettlementCard({ settlement, divers, evidence, busy, onDecide }: {
  settlement: Settlement; divers: Diver[]; evidence: Evidence[]; busy: boolean;
  onDecide?: (decision: 'approve' | 'reject') => void;
}) {
  const names = new Map(divers.map((d) => [d.id, d.name]));
  const kinds = new Map(evidence.map((e) => [e.id, e.kind]));
  const agent = settlement.agent;
  const days = settlement.facts.cancelledDays.map((d) => `Day ${d}`).join(', ');
  return <article className="panel settlement" aria-label={`Settlement ${settlement.status}`}>
    <header className="settlement-head">
      <span className={`badge ${settlement.source === 'ai' ? 'ai' : ''}`}>{sourceLabel(settlement)}</span>
      <span className={`status ${settlement.status}`}>{settlement.status}</span>
    </header>
    <h3>{settlement.facts.cause === 'weather' ? 'Weather' : 'Operator'} cancellation · {days}</h3>
    {agent && settlement.source === 'ai' && <>
      <p className="muted">Confidence: {agent.confidence ?? 'n/a'} · {agent.executionRequested ? 'agent asked to execute within the mandate' : 'agent asked for organizer review'}</p>
      {agent.citations.length > 0 && <ul className="citations" aria-label="Evidence the agent cited">
        {agent.citations.map((c, i) => <li key={`${c.evidenceId}-${i}`}>
          <small>{kinds.get(c.evidenceId) ?? 'evidence'}</small><q>{c.quote}</q>
        </li>)}
      </ul>}
    </>}
    {agent && settlement.source === 'no_ai' && agent.mode === 'capped' && <p className="muted">The daily AI limit was reached and no recorded result matches this evidence.</p>}
    <table className="plan">
      <caption>Server-computed from the refund policy</caption>
      <thead><tr><th scope="col">Diver</th><th scope="col">PayPal action</th><th scope="col">Diver pays</th><th scope="col">Released or refunded</th></tr></thead>
      <tbody>{settlement.plan.map((item) => <tr key={item.diverId}>
        <th scope="row">{names.get(item.diverId) ?? 'Diver'}</th>
        <td>{ACTION_LABEL[item.action]}</td><td>{usd(item.owedMinor)}</td><td>{usd(item.returnedMinor)}</td>
      </tr>)}</tbody>
    </table>
    {settlement.reasons.length > 0
      ? <><p><strong>{settlement.status === 'proposed' ? 'Needs organizer approval:' : 'Why it went to the organizer:'}</strong></p><ul className="reasons">{settlement.reasons.map((r) => <li key={r}>{REASON_LABEL[r] ?? r}</li>)}</ul></>
      : <p className="muted">Inside the mandate; the agent executed it without approval.</p>}
    {settlement.status === 'proposed' && onDecide && <div className="actions">
      <button className="primary" disabled={busy} onClick={() => onDecide('approve')}>Approve and execute</button>
      <button disabled={busy} onClick={() => onDecide('reject')}>Reject</button>
    </div>}
  </article>;
}
