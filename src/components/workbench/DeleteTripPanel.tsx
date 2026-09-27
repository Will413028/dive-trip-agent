'use client';
import { useRef, useState } from 'react';
import { request, errorMessage } from './client';

export default function DeleteTripPanel({ tripId, disabled }: { tripId: string; disabled: boolean }) {
  const [confirming, setConfirming] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const inFlight = useRef(false);
  async function remove() {
    if (disabled || inFlight.current) return;
    inFlight.current = true; setBusy(true); setError('');
    try {
      await request(`/api/trips/${encodeURIComponent(tripId)}`, {}, 'DELETE');
      try { sessionStorage.removeItem(`dive-trip-chat-draft:${tripId}`); } catch { /* Storage may be unavailable. */ }
      window.location.assign('/');
    } catch (e) {
      setError(`${errorMessage(e)} 刪除不會自動重試；若回應遺失，可重新讀取行程確認。`);
    } finally { inFlight.current = false; setBusy(false); }
  }
  return <section className="panel" aria-labelledby="delete-heading">
    <h2 id="delete-heading">刪除此行程</h2>
    <p>永久移除行程、版本、提案與對話，所有分享連結一併失效，不能復原。防濫用的配額紀錄仍保留，不包含對話內容。</p>
    {error && <p role="alert" className="error">{error}</p>}
    {!confirming ? <button disabled={disabled || busy} onClick={() => setConfirming(true)}>刪除此行程</button>
      : <div className="issue-box"><p>確定永久刪除這份行程及所有對話嗎？</p>
        <button disabled={disabled || busy} onClick={() => void remove()}>確認永久刪除</button>
        <button disabled={busy} onClick={() => setConfirming(false)}>取消刪除</button></div>}
  </section>;
}
