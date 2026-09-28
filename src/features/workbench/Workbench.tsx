'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CatalogItem, Change, ProposalDraft, TripView } from '../../domain/types';
import type { ProposalReview } from '../../contracts/generated';
import { ApiError, errorMessage, request } from '../../lib/api';
import { destinations } from '../../lib/presentation';
import RequirementsForm from './RequirementsForm';
import DayCards from './DayCards';
import BudgetPanel from './BudgetPanel';
import ProposalPanel from './ProposalPanel';
import MapPanel from './MapPanel';
import { tripMarkers } from '../../catalog/map';
import ChatPanel from './ChatPanel';
import SharePanel from '../sharing/SharePanel';
import DeleteTripPanel from './DeleteTripPanel';
import DeletionStatus, { type DeletionState } from './DeletionStatus';

type Pending = { proposalId: string; draft: ProposalDraft; review: ProposalReview; base: TripView; requestId: string };
type Mutation = { kind: 'apply' | 'restore'; body: { baseVersion: number; requestId: string; proposalId?: string; targetVersion?: number } };

export default function Workbench({ tripId }: { tripId: string }) {
  const [trip, setTrip] = useState<TripView | null>(null);
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [notice, setNotice] = useState('');
  const [stale, setStale] = useState(false);
  const [uncertain, setUncertain] = useState<Mutation | null>(null);
  const [tab, setTab] = useState<'chat' | 'requirements' | 'itinerary'>('itinerary');
  const [chatActive, setChatActive] = useState(true);
  const chatActiveRef = useRef(true);
  const onChatActiveChange = useCallback((value: boolean) => { chatActiveRef.current = value; setChatActive(value); }, []);
  const onChatTripChanged = useCallback((view: TripView) => { setTrip(current => !current || view.version >= current.version ? view : current); }, []);
  const [targetVersion, setTargetVersion] = useState('1');
  const active = useRef(false);
  const url = `/api/trips/${encodeURIComponent(tripId)}`;
  const report = useCallback((e: unknown) => {
    setError(errorMessage(e));
    if (e instanceof ApiError && e.status === 409) setStale(true);
  }, []);
  const load = useCallback(async () => {
    if (active.current) return;
    active.current = true; setBusy(true); setError('');
    try {
      const [view, items] = await Promise.all([request<TripView>(url), request<CatalogItem[]>('/api/catalog')]);
      onChatTripChanged(view); setCatalog(items); setPending(null); setStale(false);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        const deletion = await request<DeletionState>(`${url}/deletion`).catch(() => null);
        if (deletion?.status === 'deleting' || deletion?.status === 'deleted') {
          setTrip(null); setDeleting(true); return;
        }
      }
      report(e);
    }
    finally { active.current = false; setBusy(false); }
  }, [url, report, onChatTripChanged]);
  useEffect(() => { void load(); }, [load]);

  async function propose(changes: Change[]) {
    if (!trip || active.current || chatActiveRef.current || pending || uncertain || stale) return;
    active.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const result = await request<{ proposalId: string; draft: ProposalDraft; review: ProposalReview }>(`${url}/proposals`, { baseVersion: trip.version, changes });
      setPending({ ...result, base: trip, requestId: crypto.randomUUID() });
      setTab('itinerary');
    } catch (e) { report(e); }
    finally { active.current = false; setBusy(false); }
  }

  async function mutate(mutation: Mutation) {
    if (active.current || chatActiveRef.current || stale) return;
    active.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const view = await request<TripView>(`${url}/${mutation.kind}`, mutation.body);
      onChatTripChanged(view); setPending(null); setUncertain(null); setStale(false);
      setNotice(`已儲存版本 ${view.version}${mutation.kind === 'restore' ? '，舊版內容已復原成新版本。' : '。'}`);
    } catch (e) {
      report(e);
      // A network / service failure may occur after the transaction committed.
      // Preserve the exact payload and requestId, and freeze competing actions.
      if (!(e instanceof ApiError) || e.status >= 500) setUncertain(mutation);
      else setUncertain(null);
    } finally { active.current = false; setBusy(false); }
  }

  async function reject() {
    if (!pending || active.current || uncertain) return;
    active.current = true; setBusy(true); setError('');
    try { await request(`${url}/proposals/${encodeURIComponent(pending.proposalId)}/reject`, {}); setPending(null); setNotice('已拒絕修改，原行程未變更。'); }
    catch (e) { report(e); }
    finally { active.current = false; setBusy(false); }
  }

  const disabled = busy || chatActive || !!pending || !!uncertain || stale;
  const markers = trip ? tripMarkers(trip.snapshot) : [];
  if (deleting) return <DeletionStatus tripId={tripId} />;
  return <main id="main" className="workbench">
    <div className="trip-heading"><div><p className="eyebrow">A PLAN YOU CAN CHANGE</p><h1>{destinations.find(place => place.id === trip?.snapshot.requirements.destinationId)?.name ?? '我的'}潛旅計畫</h1><p className="muted">{trip ? `${trip.snapshot.requirements.people} 人 · ${trip.snapshot.requirements.days} 天 · ${trip.snapshot.requirements.startDate ?? '日期未定'}` : '讀取行程中…'}</p></div><div className="version-box"><span className="badge">合成資料 DEMO</span>{trip && <strong>版本 {trip.version}</strong>}<button disabled={busy || !!uncertain} onClick={() => void load()}>重新整理行程</button></div></div>
    <div aria-live="polite" role="status">{busy ? <p className="status-note">正在處理，請稍候…</p> : notice && <p className="status-note">{notice}</p>}</div>
    {error && <div className="error" role="alert">{error}{stale && <p>重新整理會取得最新版本並清除目前提案；請重新檢查需求後產生提案。</p>}</div>}
    {uncertain && <div className="issue-box"><p>尚未確認儲存結果。請先重試這次操作，再進行其他修改。</p><button className="primary" disabled={busy} onClick={() => void mutate(uncertain)}>重試{uncertain.kind === 'apply' ? '套用' : '復原'}（同一請求）</button></div>}
    {!trip ? <section className="panel"><h2>{error ? '暫時無法開啟行程' : '正在找回你的海邊日常'}</h2><p>行程存取需要建立示範時的瀏覽器工作階段。</p><a href="/">回首頁</a></section> : <>
      <div className="mobile-tabs" aria-label="工作台區域"><button aria-pressed={tab === 'chat'} aria-controls="chat-pane" onClick={() => setTab('chat')}>對話</button><button aria-pressed={tab === 'requirements'} aria-controls="requirements-pane" onClick={() => setTab('requirements')}>需求</button><button aria-pressed={tab === 'itinerary'} aria-controls="itinerary-pane" onClick={() => setTab('itinerary')}>行程</button></div>
      <div className="workspace-grid"><div className="workspace-left"><div id="chat-pane" className={`chat-pane ${tab === 'chat' ? 'mobile-active' : ''}`}>
        <ChatPanel trip={trip} disabled={busy || !!pending || !!uncertain || stale} onActiveChange={onChatActiveChange} onTripChanged={onChatTripChanged} />
      </div><aside id="requirements-pane" className={`requirements-pane ${tab === 'requirements' ? 'mobile-active' : ''}`}>
        <RequirementsForm key={trip.version} initial={trip.snapshot.requirements} disabled={disabled} propose={propose} />
        <BudgetPanel budget={trip.budget} snapshot={trip.snapshot} />
      </aside></div><div id="itinerary-pane" className={`itinerary-pane ${tab === 'itinerary' ? 'mobile-active' : ''}`}>
        {pending && <ProposalPanel proposalId={pending.proposalId} draft={pending.draft} base={pending.base} review={pending.review} busy={busy} stale={stale || pending.base.version !== trip.version} uncertain={!!uncertain} accept={() => void mutate(uncertain ?? { kind: 'apply', body: { proposalId: pending.proposalId, baseVersion: pending.base.version, requestId: pending.requestId } })} reject={() => void reject()} />}
        <DayCards key={trip.version} snapshot={trip.snapshot} catalog={catalog} disabled={disabled} propose={propose} />
        <MapPanel key={`map:${trip.version}`} markers={markers} unlocated={trip.snapshot.entries.length - markers.length} />
        <SharePanel trip={trip} disabled={disabled} />
        <DeleteTripPanel tripId={trip.id} disabled={busy || !!uncertain} />
        <section className="panel"><h2>回到喜歡的版本</h2><p className="muted">復原會把指定舊版內容存成新版本，保留完整歷史。</p><form onSubmit={e => { e.preventDefault(); if (!disabled) void mutate({ kind: 'restore', body: { targetVersion: Number(targetVersion), baseVersion: trip.version, requestId: crypto.randomUUID() } }); }}><fieldset className="restore-fields" disabled={disabled || trip.version <= 1}><label>復原目標版本<input required type="number" min="1" max={Math.max(1, trip.version - 1)} step="1" value={targetVersion} onChange={e => setTargetVersion(e.target.value)} /></label><button type="submit">復原此版本</button></fieldset></form></section>
      </div></div>
    </>}
  </main>;
}
