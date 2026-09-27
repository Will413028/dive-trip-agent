'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { HttpAgent } from '@ag-ui/client';
import { EventType, type BaseEvent } from '@ag-ui/core';
import { ANSWER_EVENT_NAME, acceptedAnswerSchema, type AcceptedAnswer as Answer } from '../../domain/answer';
import type { ProposalDraft, TripView } from '../../domain/types';
import ProposalPanel from './ProposalPanel';
import AcceptedAnswer, { AnswerUnavailable, answerRejectionReason, type AnswerNoticeReason } from './AcceptedAnswer';
import { ApiError, errorMessage, request } from './client';

type ChatRun = {
  id: string; tripId: string; requestId: string; baseVersion: number; message: string;
  answerContractVersion: number;
  status: 'running' | 'awaiting_confirmation' | 'succeeded' | 'failed' | 'interrupted';
  events: { sequence: number; event: BaseEvent }[];
  proposalId: string | null; interruptId: string | null;
  proposal?: { draft: ProposalDraft; base: TripView };
};
type Attempt = { requestId: string; message: string; baseVersion: number; run?: ChatRun; confirmed?: boolean };
function supportsAnswerContract(run: ChatRun): boolean {
  return run.answerContractVersion === 1;
}
function findAttempt(runs: ChatRun[], attempt: Attempt) {
  return runs.find(run => attempt.run ? run.id === attempt.run.id : run.requestId === attempt.requestId || run.events.some(({ event }) =>
    event.type === EventType.RUN_STARTED && (event as BaseEvent & { runId?: string }).runId === attempt.requestId));
}
const labels: Record<ChatRun['status'], string> = {
  running: '查詢中', awaiting_confirmation: '待確認', succeeded: '回合處理已結束', failed: '執行失敗', interrupted: '執行已中斷',
};

const toolLabels = new Map([
  ['find_destinations', '查詢目的地'], ['find_items', '查詢活動與住宿'], ['calculate_budget', '計算行程預算'],
  ['validate_changes', '驗證修改'], ['propose_changes', '提出修改'],
]);

export function EventMessages({ events, status, runId }: { events: BaseEvent[]; status?: ChatRun['status']; runId?: string }) {
  const answers = new Map<string, Answer>();
  const notices = new Set<AnswerNoticeReason>();
  const tools = new Map<string, { label: string; proposal: boolean; phase: 'started' | 'ended' | 'result' }>();
  let failed = status === 'failed' || status === 'interrupted';
  let finished = status === 'succeeded';
  for (const raw of events) {
    const event = raw as BaseEvent & { name?: string; value?: unknown; toolCallId?: string; toolCallName?: string; content?: unknown };
    if (event.type === EventType.CUSTOM) {
      if (event.name !== ANSWER_EVENT_NAME) { notices.add('unsupported-version'); continue; }
      const parsed = acceptedAnswerSchema.safeParse(event.value);
      if (!parsed.success) { notices.add(answerRejectionReason(event.value)); continue; }
      const answer = parsed.data;
      if (runId && answer.runId !== runId) { notices.add('invalid-answer'); continue; }
      const previous = answers.get(answer.answerId);
      if (previous) {
        if (JSON.stringify(previous) !== JSON.stringify(answer)) notices.add('invalid-answer');
      } else answers.set(answer.answerId, answer);
    }
    if (event.type.startsWith('TEXT_MESSAGE_')) notices.add('legacy-text');
    if (event.type === EventType.RUN_ERROR) failed = true;
    if (event.type === EventType.RUN_FINISHED && status !== 'awaiting_confirmation') finished = true;
    if (typeof event.toolCallId !== 'string' || !event.toolCallId) continue;
    if (event.type === EventType.TOOL_CALL_START && !tools.has(event.toolCallId)) {
      tools.set(event.toolCallId, { label: toolLabels.get(event.toolCallName ?? '') ?? '行程工具',
        proposal: event.toolCallName === 'propose_changes', phase: 'started' });
    }
    if (event.type === EventType.TOOL_CALL_END || event.type === EventType.TOOL_CALL_RESULT) {
      if (event.type === EventType.TOOL_CALL_RESULT && event.content !== '{}') { notices.add('invalid-answer'); continue; }
      const tool = tools.get(event.toolCallId) ?? { label: '行程工具', proposal: false, phase: 'started' as const };
      tools.set(event.toolCallId, { ...tool, phase: event.type === EventType.TOOL_CALL_RESULT || tool.phase === 'result' ? 'result' : 'ended' });
    }
  }
  const accepted = [...answers.values()];
  return <>{accepted.map(answer => <AcceptedAnswer answer={answer} key={answer.answerId} />)}
    {[...notices].map(reason => <AnswerUnavailable reason={reason} key={reason} />)}
    {failed && !accepted.some(answer => answer.body.kind === 'failure') && <p role="status">Agent 回合未完成；已保存的結果以回執為準。</p>}
    {finished && !failed && !accepted.length && <p role="status">未收到可顯示的受控回答，本回合未完成。</p>}
    {[...tools].map(([id, tool]) => <p className="field-hint" key={id}>{`${tool.label}：${status === 'awaiting_confirmation' && tool.proposal
      ? '待確認' : tool.phase === 'result' ? '已收到工具結果' : failed ? '未完整完成，請確認已保存的行程'
        : tool.phase === 'ended' ? '已送出，等待工具結果' : '處理中'}`}</p>)}
  </>;
}

export default function ChatPanel({ trip, disabled, onActiveChange, onTripChanged }: {
  trip: TripView; disabled: boolean; onActiveChange: (active: boolean) => void; onTripChanged: (view: TripView) => void;
}) {
  const url = `/api/trips/${encodeURIComponent(trip.id)}`;
  const storageKey = `dive-trip-chat-draft:${trip.id}`;
  const [draft, setDraft] = useState('');
  const draftRef = useRef('');
  const [runs, setRuns] = useState<ChatRun[]>([]);
  const [mode, setMode] = useState<'fixture' | 'gemini' | 'openrouter' | 'cloudflare' | null>(null);
  const [liveEvents, setLiveEvents] = useState<BaseEvent[]>([]);
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [unresolved, setUnresolved] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState<Attempt | null>(null);
  const historyRef = useRef<HTMLDivElement | null>(null);
  const revealedAnswerId = useRef<string | null>(null);
  const inFlight = useRef(false);
  const readSequence = useRef(0);
  const agentRef = useRef<HttpAgent | null>(null);
  const mounted = useRef(true);
  const currentRuns = runs.filter(supportsAnswerContract);
  const awaiting = currentRuns.find(run => run.status === 'awaiting_confirmation');
  const running = currentRuns.some(run => run.status === 'running');
  const retryRun = retry ? findAttempt(runs, retry) ?? retry.run : undefined;
  const retryable = retry && (!retryRun || supportsAnswerContract(retryRun)) ? retry : null;
  const blocked = loading || sending || unresolved || !!retryable || running || !!awaiting;

  const saveDraft = useCallback((value: string) => {
    draftRef.current = value; setDraft(value);
    try { if (value) sessionStorage.setItem(storageKey, value); else sessionStorage.removeItem(storageKey); } catch { /* Tab-local draft still works. */ }
  }, [storageKey]);

  useEffect(() => {
    try { const value = sessionStorage.getItem(storageKey) ?? ''; draftRef.current = value; setDraft(value); } catch { /* Storage may be unavailable. */ }
    mounted.current = true;
    return () => { mounted.current = false; agentRef.current?.abortRun(); };
  }, [storageKey]);
  useEffect(() => { onActiveChange(blocked); }, [blocked, onActiveChange]);

  // Reveal each newly accepted answer once, including restored history. Keep
  // immutable earlier proposals intact and do not reset a user's history scroll
  // on repeated reads. Hidden mobile tabs wait until they have a visible layout.
  useEffect(() => {
    const history = historyRef.current;
    if (!history) return;
    const reveal = () => {
      if (!history.clientHeight) return;
      const answers = history.querySelectorAll<HTMLElement>('[data-answer-id]');
      const latest = answers.item(answers.length - 1);
      if (!latest || latest.dataset.answerId === revealedAnswerId.current) return;
      history.scrollTop += latest.getBoundingClientRect().top - history.getBoundingClientRect().top;
      revealedAnswerId.current = latest.dataset.answerId ?? null;
    };
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(history);
    return () => observer.disconnect();
  }, [runs]);

  const refresh = useCallback(async () => {
    const sequence = ++readSequence.current;
    const [result, view, provider] = await Promise.all([request<{ runs: ChatRun[] }>(`${url}/runs`), request<TripView>(url),
      request<{ mode: 'fixture' | 'gemini' | 'openrouter' | 'cloudflare' }>('/api/agent-mode')]);
    if (!['fixture', 'gemini', 'openrouter', 'cloudflare'].includes(provider.mode)) throw new Error('MODE_UNAVAILABLE');
    if (!mounted.current || sequence !== readSequence.current) return result.runs;
    setMode(provider.mode); setRuns(result.runs); onTripChanged(view); setUnresolved(false);
    return result.runs;
  }, [url, onTripChanged]);

  useEffect(() => {
    if (sending || !retry) return;
    const saved = findAttempt(runs, retry) ?? retry.run;
    if (!saved) return;
    if (!supportsAnswerContract(saved)) { setRetry(null); setLiveEvents([]); return; }
    if (saved.status === 'running' || (retry.run && saved.status === 'awaiting_confirmation')) return;
    // Persisted terminal state now owns the display, including failed turns
    // with saved receipts. Do not retain a second live copy after polling.
    setRetry(null); setLiveEvents([]);
    if (saved.status === 'succeeded' || saved.status === 'awaiting_confirmation') {
      setError('');
      if (!retry.run && draftRef.current === retry.message) saveDraft('');
    }
  }, [runs, retry, sending, saveDraft]);

  useEffect(() => {
    let cancelled = false;
    void refresh().catch(e => { if (!cancelled) { setError(errorMessage(e)); setUnresolved(true); } }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [refresh]);
  // Only read persisted state while a server run is active; never restart it.
  useEffect(() => {
    if (!running || sending || loading) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { await refresh(); }
      catch (e) { if (!cancelled) { setError(errorMessage(e)); setUnresolved(true); } }
      finally { if (!cancelled) timer = setTimeout(() => void poll(), 3000); }
    };
    timer = setTimeout(() => void poll(), 3000);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [running, sending, loading, refresh]);

  async function execute(attempt: Attempt) {
    if (inFlight.current || disabled) return;
    const existing = findAttempt(runs, attempt) ?? attempt.run;
    if (existing && !supportsAnswerContract(existing)) { setRetry(null); return; }
    ++readSequence.current;
    inFlight.current = true; setSending(true); setError(''); setLiveEvents([]); setRetry(attempt);
    onActiveChange(true);
    let definitivelyRejected = false;
    const agent = new HttpAgent({
      url: `${url}/agent`, threadId: trip.id, initialState: {},
      initialMessages: attempt.run ? [] : [{ id: attempt.requestId, role: 'user', content: attempt.message }],
      fetch: async (target, init) => {
        if (typeof init.body === 'string' && new TextEncoder().encode(init.body).length >= 32 * 1024) {
          definitivelyRejected = true; throw new ApiError(400, 'REQUEST_TOO_LARGE');
        }
        const response = await fetch(target, { ...init, cache: 'no-store', credentials: 'same-origin',
          signal: AbortSignal.any([...(init.signal ? [init.signal] : []), AbortSignal.timeout(65_000)]),
        });
        if (!response.ok) {
          definitivelyRejected = response.status >= 400 && response.status < 500;
          throw new ApiError(response.status, 'CHAT_REQUEST_FAILED');
        }
        return response;
      },
    });
    agentRef.current = agent;
    let finished = false;
    let failed = false;
    try {
      await agent.runAgent({ runId: attempt.requestId, tools: [], context: [],
        forwardedProps: attempt.run ? { runId: attempt.run.id } : { baseVersion: attempt.baseVersion },
        ...(attempt.run ? { resume: [{ interruptId: attempt.run.interruptId!, status: 'resolved' as const, payload: { confirmed: attempt.confirmed! } }] } : {}),
      }, { onEvent: ({ event }) => {
        if (!mounted.current) return;
        setLiveEvents(events => [...events, event]);
        if (event.type === EventType.RUN_FINISHED) finished = true;
        if (event.type === EventType.RUN_ERROR) failed = true;
      } });
      if (!finished || failed) throw new Error('Stream incomplete');
    } catch (e) {
      if (mounted.current) setError(errorMessage(e));
    } finally {
      // Validation/conflict responses did not launch this invocation. Preserve
      // the editable draft, not an unrecoverable retry of the rejected payload.
      if (mounted.current && definitivelyRejected) setRetry(null);
      try {
        const saved = await refresh();
        const run = findAttempt(saved, attempt);
        if (mounted.current && run && (!supportsAnswerContract(run)
          || (attempt.run ? run.status !== 'awaiting_confirmation' && run.status !== 'running' : run.status !== 'running'))) {
          setRetry(null); setLiveEvents([]);
          if (supportsAnswerContract(run) && (run.status === 'succeeded' || run.status === 'awaiting_confirmation')) {
            setError('');
            if (!attempt.run && draftRef.current === attempt.message) saveDraft('');
          }
        }
      } catch (e) { if (mounted.current) { setError(errorMessage(e)); setUnresolved(true); } }
      inFlight.current = false; agentRef.current = null;
      if (mounted.current) setSending(false);
    }
  }

  async function reload() {
    if (inFlight.current) return;
    setLoading(true); setError('');
    try {
      await refresh();
    } catch (e) { setError(errorMessage(e)); setUnresolved(true); }
    finally { setLoading(false); }
  }

  return <section className="panel chat-panel" data-testid="chat-panel" aria-labelledby="chat-heading">
    <p className="eyebrow">MAKE ROOM FOR YOUR IDEAS</p><h2 id="chat-heading">聊聊這趟旅行</h2><span className="badge">{mode === 'gemini'
      ? '真實 Gemini · 合成資料 DEMO' : mode === 'openrouter' ? 'OpenRouter 免費模型 · 合成資料 DEMO'
        : mode === 'cloudflare' ? 'Cloudflare Workers AI · 合成資料 DEMO'
        : mode === 'fixture' ? '固定模型 DEMO · 非真實 LLM' : '正在確認模型模式'}</span>
    {(mode === 'gemini' || mode === 'openrouter') && <p className="field-hint">僅供本機試玩，請勿輸入個資或機密；免費端點不代表即時價格、可訂狀態或長期可用性。</p>}
    {mode === 'cloudflare' && <p className="field-hint">僅供本機合成資料試玩，請勿輸入個資或機密；資料會送至 Cloudflare Workers AI，免費層設定不保證帳號不產生費用。</p>}
    <p className="muted">試試「查詢目的地」、「試算目前預算」或「第二天下午留白」。修改前會請你確認。</p>
    <div className="chat-history" ref={historyRef} aria-label="對話紀錄">{runs.map(run => {
      const current = supportsAnswerContract(run);
      return <article className="chat-run" key={run.id} data-testid={`chat-run-${run.id}`} data-readonly={current ? undefined : 'true'}>
        <p className="chat-user">{run.message}</p>
        {current ? <><EventMessages runId={run.id} status={run.status} events={[...new Map(run.events.map(item => [item.sequence, item])).values()].sort((a, b) => a.sequence - b.sequence).map(item => item.event)} /><p className="chat-status">{labels[run.status]}</p></>
          : <><p className="chat-status">唯讀歷史 · 基礎版本 {run.baseVersion}</p>
            <p className="field-hint">舊版或不支援的回合僅保留歷史紀錄，無法接續、接受或拒絕提案。</p>
            {!run.proposal && <p className="field-hint">此歷史紀錄未提供提案詳細資料。</p>}</>}
      </article>;
    })}</div>
    {(sending || liveEvents.length > 0) && <div aria-live="polite">{sending && <p role="status">{mode === 'gemini' ? 'Gemini 查詢中…' : mode === 'openrouter' ? 'OpenRouter 查詢中…' : mode === 'cloudflare' ? 'Cloudflare 查詢中…' : '正在執行示範流程…'}</p>}
      <EventMessages events={liveEvents} runId={retry?.run?.id} status={sending ? 'running' : error ? 'failed' : undefined} /></div>}
    {error && <p role="alert" className="error">{error} 請重新讀取行程狀態，並核對保存回執。</p>}
    <button disabled={sending || loading || disabled} onClick={() => void reload()}>重新讀取對話狀態</button>
    {retryable && !sending && <div className="issue-box"><p>上次請求結果尚待確認。重試會沿用相同請求編號與決定。</p><button disabled={disabled || loading} onClick={() => void execute(retryable)}>重試同一聊天請求</button></div>}
    {awaiting?.proposal && awaiting.proposalId && awaiting.interruptId && <ProposalPanel
      proposalId={awaiting.proposalId} draft={awaiting.proposal.draft} base={awaiting.proposal.base}
      busy={sending || loading || disabled || unresolved || !!retryable} stale={awaiting.baseVersion !== trip.version} uncertain={false}
      accept={() => void execute({ requestId: crypto.randomUUID(), message: '', baseVersion: awaiting.baseVersion, run: awaiting, confirmed: true })}
      reject={() => void execute({ requestId: crypto.randomUUID(), message: '', baseVersion: awaiting.baseVersion, run: awaiting, confirmed: false })}
    />}
    <form className="chat-compose" onSubmit={e => { e.preventDefault(); if (!blocked && !disabled && draft.trim()) void execute({ requestId: crypto.randomUUID(), message: draft, baseVersion: trip.version }); }}>
      <label htmlFor="chat-message">想怎麼調整行程？</label><textarea id="chat-message" maxLength={4000} rows={3} value={draft} onChange={e => saveDraft(e.target.value)} placeholder="例如：第二天下午留白" />
      <button className="primary" disabled={disabled || blocked || !draft.trim()} type="submit">送出訊息</button>
    </form>
  </section>;
}
