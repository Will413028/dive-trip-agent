# Dive Trip Agent Implementation Plan

## Goal and architecture

交付可互動的潛旅規劃作品：對話與卡片修改、鎖定、差異確認、重新整理後接續、復原及唯讀分享。

Next.js／TypeScript／PostgreSQL 承擔 UI、權限與交易；Google ADK TypeScript 執行單一 Agent，AG-UI 傳遞受控事件。模型提出結構化意圖，Domain 決定規則與費用；使用者確認後才由應用服務修改版本。

[產品設計](../specs/2026-09-19-dive-trip-agent-design.md)、[共享開發約束](../../../AGENTS.md)及目前程式 schema 為實作依據。以下是唯一主清單；細節計畫只展開其子項，不另設進度主表。

## Global Constraints

- 單一目的地：小琉球、綠島或墾丁；1–6 人、2–7 天、TWD。
- 日期未定與費用未知保持明示；未知不當零、不捏造預訂狀態或安全背書。
- 模型不能覆寫鎖定項目；局部 requirements patch 與完整 HTTP／持久化契約分開驗證。
- `validate_changes` 產生 session-bound `validationId`；`propose_changes` 只引用最新成功驗證，不能重新產生 changes 繞過驗證。
- 核心回答只接受 strict AnswerPlan，由服務端 Evidence compiler 產生 AcceptedAnswer。對外不發布 raw model text、private accounting、工具參數或 ADK state。
- 提案接受、版本保存、receipt 與冪等結果由交易決定；resume 只讀 committed result，不再產生模型回答。
- 固定工具、模型、deadline 及預算邊界；未知用量保留預留成本。失敗、限流或未知用量停止，不自動重試。
- fixture、歷史 replay 與 live evidence 分開；舊 contract 不回填成新版驗收。
- 不做付款、預訂、代寄訊息、潛水剖面、安全背書或醫療建議。不引用未授權素材或第三方私人資料。
- 實作、公開原始碼、模型測試及公開部署是不同授權範圍。

## 執行前置與工作區

讀取 repository instructions、受影響 source schema 與對應文件後才修改。保留並行工作，使用精確路徑提交；不得以清空歷史資料、提高 timeout 或關掉驗證換取綠燈。離線大型回歸使用獨立 Compose project，不與保留評估歷史的資料庫混用。

一般 unit／typecheck／lint 不讀憑證。live 測試預設 skip，必須由另行明確授權的入口、固定本機歷史綁定、不可刪 claim 與用量檢查共同放行。公開 fixture 不能建立新的歷史基線或重設額度。

## 檔案結構與責任

| 路徑 | 責任 |
| --- | --- |
| `src/domain/`、`src/catalog/`、`data/` | 型別、strict schema、金額、鎖定、來源與資料目錄 |
| `src/server/`、`migrations/` | 匿名所有權、交易、版本、執行狀態、配額、分享、留存 |
| `src/agent/` | ADK runtime、受控工具、provider adapters、AnswerPlan／Evidence |
| `src/components/workbench/`、`src/app/` | 受控呈現、對話／提案 UI、薄 HTTP adapters |
| `tests/`、`evals/` | 離線反例、整合／瀏覽器驗證、獨立的有界模型評估 |

## 共用契約（Task 1–3 產出，其後不可自行改名）

金額為整數 TWD 分，所有外部 JSON 使用 runtime strict schema。共用資料型別以 `src/domain/types.ts`、`schemas.ts` 為準，不在計畫複製可能落後的型別定義。帳務及未知費用、引用來源與 DEMO 標示均為行為契約，不只是提示詞。

## Task 1 — Domain 基礎與可重現測試（M1）

已建立精確版本 toolchain、TypeScript strict configuration 與 domain tests；命令和相容性見 [toolchain](../../toolchain.md)。後續變更仍須跑 affected tests，不沿用舊版測試數作為新 revision 通過證據。

## Task 2 — 資料目錄與精確費用（M1）

已建立來源白名單、DEMO 標示、單位／房晚／人數計算與未知費用傳遞；來源真實性、價格有效期與素材授權需獨立查核。

## Task 3 — 提案、鎖定及可解釋衝突（M1）

已建立完整 domain validation、nonempty partial requirements patch、鎖定與預算衝突。Agent 不可自行解鎖；不能用自行計算的文字結論取代 domain 結果。

## Task 4 — PostgreSQL 與匿名所有權（M2）

已建立 migrations、匿名 session、行程／版本與 ownership checks。測試每案隔離 schema，不使用 memory fallback 冒充持久化。

## Task 5 — 原子套用、復原與冪等（M2）

已建立交易套用、版本衝突、request 冪等與復原新版本；確認／run lease／proposal 必須在同一產品交易內核對。

## Task 6 — HTTP 入口與可操作工作台（M3）

已建立正式 Next.js 工作台與桌面／手機測試；目前擴大 browser 回歸仍有等待失敗，不標全綠。

## Task 7 — 對話、執行事件與中斷恢復（M3）

已用原生 ADK confirmation、PostgreSQL Session 與 AG-UI 完成受控接線。accepted answer 先保存再 ACK，重新整理／重播讀不可變投影；不重跑狀態不明的 invocation。詳 [ADK 工作台](../../adk-workbench.md)。

## Task 8 — 有限工具與真實模型 adapter（M4）

已有 Gemini、OpenRouter、Cloudflare adapters 與 synthetic transport 測試；一般 launcher 保持離線。新版 AnswerPlan、validationId、receipt-only resume 與 provider failure-stage 診斷已實作；不代表真模型品質通過。

## Task 9 — 額度、成本預留與濫用控制（M4）

已有原子 admission、provider/model/account binding、模型用量持久化、未知保留與 session/IP/global 限額。正式可信 proxy、預算設定、kill-switch 與監控仍屬發布驗收。

## Task 10 — 分享快照、刪除與30天期限（M5）

已有固定版本白名單分享、canonical preview、撤銷、read-time TTL 及有界 retention 程序。系統排程、備份保存期與正式清理驗收尚未完成；不可將本機腳本存在當成已部署。詳 [retention](../../retention.md)。

## Task 11 — 資料、地圖與真模型評估（M6）

- [x] 離線 grader、10 情境 manifest 與 domain oracle 反例；fixture 結果永不授權發布。
- [x] 來源目錄、座標、地圖降級與素材授權邊界。
- [ ] 新版完整 30 案真模型品質驗收，以及逐案 primary／independent 內容審查。

10 情境涵蓋模糊需求、非潛水同行、降預算鎖住宿、下午留白、改人數、未知費用、日期未定、來源注入、查詢逾時與無法滿足條件。技術終態、任務目標、核准／版本、帳務和內容品質分別判斷。未達離線 gate 不開 live；新授權不能重開已停止的 claim。詳 [evaluation](../../evaluation.md)。

## Task 12 — 展示包與發布驗收（M6）

- [x] 案例頁、三組展示入口、fixture／歷史 replay 影片及明示標籤。
- [ ] 原門檻下完整回歸與 browser 綠燈。
- [ ] 獨立程式版控及實際遠端 fixture CI 的各 job 結論。
- [ ] 正式啟動、公開 URL、可信 ingress、secret／預算設定、清理／告警、備份還原及 kill-switch／rollback 演練。
- [ ] 新版真模型穩定完成任務的可核對展示成果。

CI 僅使用 fixture 與專用 PostgreSQL，不讀本機環境檔或消費模型。無公開部署時必須寫明未發布；舊 replay 不充作新版本驗收。詳 [release evidence](../../release-evidence.md)。

## 自審與驗收追蹤

| Spec 驗收 | 責任 task |
| --- | --- |
| A1 模糊需求、A2 鎖定、A3 局部修改 | 3、6、7、8、11 |
| A4 人數計算、A5 未知費用 | 2、3、6、11 |
| A6 stale proposal、A7 冪等、A8 復原 | 5、6、7、9 |
| A9 錯誤、A10 接續 | 6、7、8、11 |
| A11 分享、A12 所有權 | 4、6、10、12 |
| A13 注入、A14 額度 | 3、8、9、11、12 |

## 執行交接

依序完成以下五項；平台遷移暫停，不新增平行 roadmap：

1. **收尾測試穩定性。** 舊範圍曾在原門檻下 2776／2776 通過，但擴大最新 suite 為 3519 pass／10 integration timeout／11 live skip，其中 unit 3141 通過；browser 54 pass／9 fail／5 skip。typecheck／lint／actionlint／build 通過。尚未證實統一根因；先定位階段耗時，再取同一 revision 的原門檻全套結果，不能拼湊跨輪成功。
2. **新版真模型品質驗收。** 最新單案失敗；diagnostic 入口已準備，但須離線 gate、新一輪有效授權、本機歷史承接與逐案內容審查共同通過。完整 30 案未過，不提高預算、不抹除 unknown、不自動重試。
3. **獨立版控與遠端 CI。** 私人 remote 已建立，fixture workflow 尚未實跑，CI 仍暫停。當前先依 [public-source preparation](2026-09-27-public-source-preparation.md) 清理原始碼及準備乾淨本機歷史；不在清理時自動改 public、push 或觸發 CI。
4. **公開部署與維運。** 尚無公開 URL；完成 Task 12 的發布清單並獲部署授權後才開放。
5. **新版真模型展示。** 沿用同次有界驗收的真實證據，不為影片額外發送；不能把 fixture 或舊 replay 改標 live。

公開文件不保存個人授權日誌、真實帳戶／run／trip／owner／retained-schema 識別資料或私人帳務流水。原始證據仍保留在 ignored 本機資料；任何公開數值回歸向量均不代表目前帳號用量或模型品質。操作本機歷史前須查本機 context，而不是從公開文件推定授權。

## 官方參考與環境選型邊界

- [Next.js 安裝](https://nextjs.org/docs/app/getting-started/installation)
- [Vitest](https://vitest.dev/guide/)
- [node-postgres transactions](https://node-postgres.com/features/transactions)
- [Playwright assertions](https://playwright.dev/docs/test-assertions)

官方文件僅支持設計／操作方式，不是此 checkout 已執行成功的證據。
