import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: '作品案例 · 潛旅筆記',
  description: '個人潛旅規劃作品：以 FastAPI／PydanticAI、Temporal、AG-UI 與人工確認，連接對話、行程卡片及持久化版本。',
};

export default function CaseStudy() {
  return <main id="main" className="landing">
    <section className="hero" aria-labelledby="case-study-title">
      <div>
        <p className="eyebrow">DIVE TRIP / PERSONAL CASE STUDY</p>
        <h1 id="case-study-title">讓對話提出可能，<br />讓人決定行程。</h1>
        <p className="hero-copy">潛旅筆記是一件個人作品：把自然語言需求與行程卡片放在同一個工作台，讓每次調整都有差異可看、有版本可回。</p>
        <p><a href="/">前往互動 demo ↗</a></p>
        <p className="muted">本機展示，未公開部署。一般啟動使用固定模型 DEMO；Cloudflare Workers AI 已用於另行授權的本機真模型驗證。</p>
      </div>
      <div className="sea-art" aria-hidden="true">
        <div className="sun" /><div className="island" />
        <div className="sea-line one" /><div className="sea-line two" /><div className="sea-line three" />
        <span>一份計畫<br />保留改變的餘地</span><small>ILLUSTRATION · 非地圖</small>
      </div>
    </section>

    <section className="panel" aria-labelledby="contribution-title">
      <p className="eyebrow">01 / PROBLEM & CONTRIBUTION</p>
      <h2 id="contribution-title">問題與本人貢獻</h2>
      <p>同行者可能不潛水、住宿已決定、下午又想留白。單次生成整份行程很難保留這些選擇；這件作品聚焦於可檢查的局部修改。</p>
      <p>我負責需求與互動設計、Next.js／TypeScript 工作台、domain 規則、PostgreSQL 版本交易，以及 FastAPI／PydanticAI、Temporal 與 AG-UI 整合、quota 帳務、持久刪除及故障驗證。這是個人作品，沒有客戶上線案例或實際營運成效可宣稱。</p>
      <p className="muted">範圍限定小琉球、綠島、墾丁；每趟一個目的地、1–6 人、2–7 天，以 TWD 計價。</p>
    </section>

    <section aria-label="架構與確認流程" className="intro-grid">
      <article>
        <span>02 / 提案</span><h2>對話與卡片共用行程</h2>
        <p>Next.js 呈現需求、對話及活動卡片，經 AG-UI 連接 FastAPI 後端。PydanticAI 管模型與工具迴圈，Temporal 保存執行與等待狀態，PostgreSQL 保存行程、回答與帳務。真模型經獨立 Cloudflare Workers AI evaluator 做有界驗證；預設固定模型僅支援指定劇本。</p>
      </article>
      <article>
        <span>03 / 驗證</span><h2>程式計算，人來確認</h2>
        <p>模型只提出修改及結構化的證據引用，伺服器產生回答；domain 驗證鎖定、容量與日期，並計算費用。未知價格不當成零；提案先顯示差異，接受前原行程保持不變，衝突提案不能套用。</p>
      </article>
      <article>
        <span>04 / 保存</span><h2>每次接受，都有版本</h2>
        <p>人工接受後，伺服器交易才保存完整行程新版本與 receipt 至 PostgreSQL；確認接續不再呼叫模型。刷新可接續待確認提案；復原將舊內容存成新版。分享固定於建立時的版本，後續修改不會改寫分享快照。</p>
      </article>
    </section>

    <section className="panel" aria-labelledby="data-title">
      <p className="eyebrow">05 / DATA & LIMITS</p>
      <h2 id="data-title">示範資料與真實參考的界線</h2>
      <p>行程與價格使用合成資料，目錄保留 10 筆 DEMO。另有 3 筆景點參考：花瓶岩、綠島燈塔、鵝鑾鼻燈塔，僅人工核對名稱與座標；開放狀態與費用仍待確認。</p>
      <p>參考座標不代表入口、集合點或下水位置；沒有為虛構業者配置真實位置。地圖底圖需由使用者選擇載入，沒有座標時明示位置待確認。</p>
      <p>不提供即時報價、空房、預約名額或預訂服務，也不提供潛水安全背書。這是規劃互動展示，不能取代業者確認與專業潛水判斷。</p>
    </section>

    <section className="panel" aria-labelledby="evidence-title">
      <p className="eyebrow">06 / EVIDENCE & FAILURE HANDLING</p>
      <h2 id="evidence-title">驗證結果與尚未完成的事</h2>
      <p>Python／Temporal 核心重構已通過離線產品、帳務與跨程序故障驗證，並完成本機切換。固定版本的遠端 Fixture CI 驗證靜態檢查、unit、PostgreSQL integration、backend、production build 及桌面／手機互動；live 入口預設跳過。Fixture CI 通過不代表真模型品質或公開部署驗收。</p>
      <p>新版真模型品質尚未通過：完整 30 案入口在未知用量時停止，後續兩次獨立單案診斷在工具參數被拒時停止；第三次工具成功，卻在只應澄清費用的案例建立不必要提案，任務品質仍失敗。原始失敗與保守帳務保留，不重送已停止的執行。私有診斷只保存固定分類與白名單路徑，不保存模型產生的原值。</p>
      <p>10 情境 × 3 輪 fixture 僅檢查 domain oracle；單案技術診斷也不能抵完整真模型驗收。歷史 ADK 成功或重播不改標為新版成功；重播明示非 LIVE，播放節奏不代表模型延遲。</p>
      <p>失敗時保留可辨識的狀態：舊版本衝突要求刷新，套用回應遺失以同一請求重試，未知費用保持待確認。狀態不明的模型 invocation 不自動重跑，避免重複副作用。</p>
      <p>目前未公開部署；公開環境驗證、備份／還原驗收及留存排程仍待啟用。首頁提供一般規劃、預算衝突，以及明示的查詢失敗靜態劇本；後者不是即時模型故障。完整發布驗收尚未通過，不宣稱 Task12 或 M6 已全部完成。</p>
    </section>

    <section className="panel" aria-labelledby="demo-title">
      <h2 id="demo-title">從一份可修改的計畫開始</h2>
      <p>回首頁選「試玩一般規劃」，先鎖定住宿，再在對話輸入「第二天下午留白」。檢視差異、接受修改，刷新確認版本，再試著復原與預覽分享。</p>
      <p><a href="/">回首頁開始示範</a></p>
    </section>
  </main>;
}
