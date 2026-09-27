'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import type { ProposalDraft, TripView } from '../domain/types';
import type { DemoScenario } from '../server/demo';
import { errorMessage, request } from '../components/workbench/client';

export default function Home() {
  const router = useRouter();
  const active = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [demo, setDemo] = useState<{ scenario: DemoScenario; trip: TripView; draft?: ProposalDraft } | null>(null);
  async function start(scenario: DemoScenario) {
    if (active.current) return;
    active.current = true; setBusy(true); setError(''); setDemo(null);
    try {
      const trip = await request<TripView>('/api/demo', { scenario });
      if (scenario === 'normal') { router.push(`/trips/${encodeURIComponent(trip.id)}`); return; }
      setDemo({ scenario, trip });
      if (scenario === 'budget-conflict') {
        const { draft } = await request<{ draft: ProposalDraft }>(`/api/trips/${encodeURIComponent(trip.id)}/proposals`, {
          baseVersion: trip.version,
          changes: [{ kind: 'requirements', value: { ...trip.snapshot.requirements, budgetMinor: 250000 } }],
        });
        setDemo({ scenario, trip, draft });
      }
      active.current = false; setBusy(false);
    } catch (e) { setError(errorMessage(e)); active.current = false; setBusy(false); }
  }
  return <main id="main" className="landing">
    <section className="hero">
      <div><p className="eyebrow">A LITTLE ROOM FOR THE SEA</p><h1>把海留進行程，<br />把彈性留給自己。</h1><p className="hero-copy">兩個人、四天、一份還能改變的計畫。<br />從示範行程開始，調整活動、鎖定住宿，確認每個改動再出發。</p>
        <button className="primary large" disabled={busy} onClick={() => void start('normal')}>試玩一般規劃 <span aria-hidden="true">↗</span></button>
        <p className="muted" role="status">{busy ? '正在建立示範行程…' : '不用註冊 · DEMO 合成行程 · 不提供預訂'}</p>
        {error && <p role="alert" className="error">{error}</p>}
      </div>
      <div className="sea-art" aria-hidden="true"><div className="sun" /><div className="island" /><div className="sea-line one" /><div className="sea-line two" /><div className="sea-line three" /><span>22° N<br />留一點時間給海</span><small>ILLUSTRATION · 非地圖</small></div>
    </section>
    <section className="intro-grid" aria-label="示範劇本">
      <article><h2>一般規劃</h2><p>從上方入口建立獨立行程。試試「第二天下午留白」，檢視差異後確認，再復原版本。聊天使用伺服器設定的模型模式，請以工作台標示為準。</p></article>
      <article><h2>住宿鎖定與預算衝突</h2><p>DEMO：住宿三晚 TWD 3,000 已鎖定，已知小計 TWD 4,300。試把預算降到 TWD 2,500，查看程式驗證的衝突；不會套用修改。</p><button disabled={busy} onClick={() => void start('budget-conflict')}>試玩預算衝突</button></article>
      <article><h2>查詢失敗</h2><p>FIXTURE 靜態劇本說明：模擬查不到活動資料時的回應，不執行查詢、不觸發真實故障，也不切換模型。另建獨立行程供後續操作。</p><button disabled={busy} onClick={() => void start('lookup-failure')}>查看查詢失敗示範</button></article>
    </section>
    {demo && <section className="panel" aria-label="示範結果" aria-live="polite">
      <h2>{demo.scenario === 'budget-conflict' ? '預算衝突驗證' : 'FIXTURE：查詢失敗靜態劇本'}</h2>
      {demo.scenario === 'budget-conflict' ? <>
        <p>已建立住宿鎖定的合法版本 1，預算 TWD 4,300。降低至 TWD 2,500 的提案不會改寫行程。</p>
        {demo.draft ? <><p>{demo.draft.canApply ? '驗證未發現衝突；本示範仍未套用提案。' : '提案無法套用；原行程與住宿鎖定保持不變。'}</p><ul>{demo.draft.issues.map((issue, index) => <li key={`${issue.code}-${index}`}>{issue.message}</li>)}</ul></> : <p>尚未取得衝突驗證結果。</p>}
        <p>進入工作台後，可在需求表單調整預算並檢視提案。住宿費已高於目標預算；若要更換住宿，需先由你單獨解鎖。</p>
      </> : <>
        <p>以下為預先撰寫的示例，並非模型回覆或實際查詢結果。</p>
        <blockquote>「這次未能取得活動資料。原行程保持不變，未知費用不能當成零，也不能保證可預訂。你可以稍後重試，或先保留目前安排。」</blockquote>
        <p>本次只建立正常、可驗證的 DEMO 行程。進入工作台後不會延續故障劇本；聊天仍依伺服器設定運作。</p>
      </>}
      <Link href={`/trips/${encodeURIComponent(demo.trip.id)}`}>開啟這份獨立示範行程</Link>
      <p className="muted">每次入口都建立新行程，不重設或刪除既有行程。</p>
    </section>}
    <section className="intro-grid" aria-label="如何使用"><article><span>01 / 想像</span><h2>先有方向，再填細節</h2><p>小琉球、綠島或墾丁；日期未定也可以開始整理需求。</p></article><article><span>02 / 調整</span><h2>保留喜歡的，改變其他</h2><p>鎖定想保留的項目，逐一檢視修改、未知費用與衝突。</p></article><article><span>03 / 確認</span><h2>每一步，都有版本</h2><p>接受提案後才儲存；需要時，可以把舊內容復原成新版本。</p></article></section>
  </main>;
}
