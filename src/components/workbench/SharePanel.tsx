'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { TripView } from '../../domain/types';
import type { PublicTrip } from '../../domain/public-trip';
import { errorMessage, request } from './client';
import PublicTripView from './PublicTripView';

type Preview = { preview: PublicTrip; previewHash: string; version: number; expiresAt: string };
type Share = { id: string; version: number; expiresAt: string; revoked: boolean };
export default function SharePanel({ trip, disabled }: { trip: TripView; disabled: boolean }) {
  const url = `/api/trips/${encodeURIComponent(trip.id)}/shares`;
  const [preview, setPreview] = useState<Preview | null>(null);
  const [shares, setShares] = useState<Share[]>([]);
  const [link, setLink] = useState<{ id: string; url: string } | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const inFlight = useRef(false);
  const refresh = useCallback(async () => { setShares((await request<{ shares: Share[] }>(url)).shares); }, [url]);
  useEffect(() => { setPreview(null); void refresh().catch(e => setError(errorMessage(e))); }, [refresh, trip.version]);
  async function act(work: () => Promise<void>, allowWhileEditing = false) {
    if ((!allowWhileEditing && disabled) || inFlight.current) return;
    inFlight.current = true; setBusy(true); setError('');
    try { await work(); } catch (e) { setError(`${errorMessage(e)} 建立分享不會自動重試；若結果不明，先重新讀取清單並撤銷不需要的連結。`); }
    finally { inFlight.current = false; setBusy(false); }
  }
  return <section className="panel" aria-labelledby="share-heading">
    <p className="eyebrow">A SNAPSHOT TO SHARE</p><h2 id="share-heading">分享這份行程</h2>
    <p>先預覽公開欄位，再建立唯讀連結。持有連結者可讀取；不索引不代表保密。連結固定在建立當時的版本，最晚隨匿名資料 30 天期限失效。</p>
    <p className="field-hint">不公開對話、日期、住宿偏好或內部 ID。每趟最多建立 20 個連結（含已撤銷）；連結只顯示一次，請自行保存。</p>
    {error && <p role="alert" className="error">{error}</p>}
    <button disabled={disabled || busy} onClick={() => void act(async () => {
      setPreview(await request<Preview>(`${url}/preview`, { version: trip.version }));
    })}>預覽分享內容</button>
    {preview && <div className="issue-box" data-testid="share-preview">
      <p>將公開版本 {preview.version} · 有效至 {new Date(preview.expiresAt).toLocaleString('zh-TW')}</p>
      <PublicTripView trip={preview.preview} />
      <button className="primary" disabled={disabled || busy || preview.version !== trip.version} onClick={() => void act(async () => {
        const selected = preview;
        setPreview(null); // A lost response must not silently retry the same publish action.
        const created = await request<{ id: string; token: string }>(url, { version: selected.version, previewHash: selected.previewHash });
        setLink({ id: created.id, url: `${window.location.origin}/share/${created.token}` });
        await refresh();
      })}>確認公開並建立連結</button>
      <button disabled={busy} onClick={() => setPreview(null)}>取消分享預覽</button>
    </div>}
    {link && <p><a href={link.url} target="_blank" rel="noreferrer" data-testid="created-share-link">開啟剛建立的唯讀分享</a><br />
      <input aria-label="分享連結" readOnly value={link.url} onFocus={e => e.target.select()} /></p>}
    <button disabled={busy} onClick={() => void refresh().catch(e => setError(errorMessage(e)))}>重新讀取分享清單</button>
    {shares.map(share => <div className="chat-run" key={share.id}>
      <p>版本 {share.version} · {share.revoked ? '已撤銷' : '已建立'} · 到期 {new Date(share.expiresAt).toLocaleString('zh-TW')}</p>
      {!share.revoked && <button disabled={busy} onClick={() => void act(async () => {
        await request(`${url}/${share.id}/revoke`, {}); if (link?.id === share.id) setLink(null); await refresh();
      }, true)}>撤銷分享連結</button>}
    </div>)}
  </section>;
}
