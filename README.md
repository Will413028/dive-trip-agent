# Dive Trip Agent

潛旅行程互動作品，透過對話與卡片編輯行程，提供鎖定、差異確認、復原及唯讀分享。使用 Next.js、TypeScript、PostgreSQL、Google ADK TypeScript＋AG-UI。仍在開發中，尚未公開部署，不提供預訂或潛水安全判斷。

本 repository 提供去識別化的離線 regression vectors。模型提出結構化意圖與證據引用，由服務端計算、驗證及呈現；數值邊界不證明真模型能理解需求或完成任務。原始不可刪 claims、reports、usage 與歷史資料庫留在 ignored local storage，不能從 public fixtures 重建或重設真實 quota。

## 驗證狀態

原始碼 repository 已公開，服務尚未部署。2026-09-27 第一輪 [Fixture CI](https://github.com/Will413028/dive-trip-agent/actions/runs/36317342675) 在 `2a3d3d5` 通過；job 與全部 steps 均成功，耗時 8 分 58 秒，未放寬 timeout 或 assertions。

| 範圍 | 結果 |
| --- | --- |
| Unit | 3308 passed |
| Integration | 388 passed／11 live skipped |
| Production Chromium browser | 63 passed／5 skipped；桌面及 390px viewport，非實體手機 |
| Lint／strict typecheck／production build | Passed |
| 真模型品質 | 新版未通過 |
| Remote fixture CI | Passed；包含 fixture boundary 與 disposable DB teardown |
| Public deployment | 尚未部署 |

上述為同一 CI run，不是拼湊局部重跑。11 項 live skip 不算真模型驗收；5 項 browser skip 為另行啟用的 replay 情境及手機錄影。獨立 `test:adk` 探針與 replay suite 不在此 CI 範圍。本輪乾淨環境通過不證明舊本機逾時的統一根因；歷史失敗與詳細界線見 [release evidence](docs/release-evidence.md)。

## 本機檢查

使用固定 Node 26.8.1、pnpm 11.2.2，從本目錄執行：

```sh
pnpm install --frozen-lockfile --strict-peer-dependencies
pnpm test:unit
pnpm typecheck
pnpm lint
pnpm catalog:validate
pnpm eval:fixture
```

Unit、typecheck、lint 不需要 API key 或資料庫。`eval:fixture` 執行十情境、各三輪的 domain oracle 自我檢查，不呼叫 Agent／LLM，也不提供模型品質分數。相容性見 [toolchain](docs/toolchain.md)，評估契約見 [evaluation](docs/evaluation.md)。

## 本機行程工作台

先準備下節的專用 Compose 資料庫，再執行：

```sh
pnpm dev
# 或先完成 production build：
pnpm build
pnpm start
```

開啟 <http://127.0.0.1:4318/>，點「試玩一般規劃」。一般啟動為固定模型 DEMO，資料保存在 `workbench_demo`，ADK session 在 `workbench_demo_adk`；重啟服務後仍保留。

切至「對話」，輸入「第二天下午留白」，檢視差異後接受／拒絕；待確認時可刷新接續。「人數未定」展示固定追問；「查詢目的地」／「試算目前預算」執行唯讀工具；「把行程改為悠閒」先驗證需求再提案。其他文字只說明支援範圍，不宣稱理解任意自然語言。

每次 start／resume 使用受監管子程序，延續持久化 ADK session。產品交易負責套用；確認後產生固定 receipt，不讀憑證、不再呼叫模型。新核心回答為 AnswerPlan → 服務端 AcceptedAnswer → AG-UI 受控元件，不顯示模型自由正文。詳見 [模型契約](docs/model-adapter.md) 與 [恢復界線](docs/adk-workbench.md)。

若 4318 被占用，可用 `pnpm start --port=4418` 或 `pnpm dev --port=4418`，不要停止其他服務。`dev`／`start`／`build`／E2E 使用同一 Next build 目錄，須序列執行。

```sh
pnpm test:e2e
# 或先 build，再驗 production build：
E2E_PRODUCTION=1 pnpm test:e2e
```

E2E 使用 4319 及當次建立的 `e2e_*` schema，只清理自己的產品與 ADK schema。涵蓋桌面／390px viewport 的確認、刷新、衝突、分享、未知費用與地圖降級；通過證據只適用上列已驗證 revision 與範圍。

離線 launcher 傳入固定 APP_ORIGIN，不信任 Host／Forwarded headers；跳過 `.env.local`，依檔名拒絕其他可載入的 test 環境檔，不讀內容。只傳必要環境變數、停用 telemetry；正式部署不能沿用本機 test mode。

## 專用資料庫與回歸隔離

使用本機已有的 `postgres:16-alpine` image，不自動下載。工作台使用預設 Compose project：

```sh
docker compose --env-file /dev/null -f compose.test.yml up -d --wait --pull never
```

大型離線回歸請另開終端，用唯一 project 隔離，並讓啟動及測試沿用同一變數：

```sh
export COMPOSE_PROJECT_NAME="dive-trip-regression-$(date +%Y%m%d%H%M%S)-$$"
docker compose --env-file /dev/null -f compose.test.yml up -d --wait --pull never
pnpm test:integration
docker compose --env-file /dev/null -f compose.test.yml stop
```

此 override 只用於 disposable 離線 DB，不能用於既有工作台或真模型歷史查核；不得刪預設 `dive-trip-test` 歷史 volume 或 retained schema 來加速測試。ADK SDK 的跨 schema introspection 與共用 DDL gate 使初始化成本受歷史 schema 影響；一個 file worker 不改案例內的競爭測試或 timeout。

測試只連所選 Compose project 的 `dive_trip_test`，逐案建立隨機 schema。不讀環境檔或任意 `DATABASE_URL`，失敗不 fallback memory。loopback／trust authentication 僅供本機合成資料，禁止公開部署。停止容器會保留 volume，不用 `down -v` 清除歷史資料。

`pnpm db:migrate` 只對明確設定的 DATABASE_URL 執行，不自動載入環境檔；執行前確認目標。migration checksum 漂移會拒絕啟動，不修改已套用版本。

## 分享、刪除與留存

分享須先預覽公開欄位，再建立固定版本快照；後續編輯不會同步公開，可撤銷。連結只顯示一次，DB 只存 token hash。公開投影排除對話、日期、住宿偏好及內部 ID；noindex 不等於保密，持有連結者可讀。本機連結不能當成公開服務。

每趟最多 20 個分享連結（含撤銷），有效期不超過原行程與匿名 session，讀取不延長期限。已實作到期拒讀，但不能宣稱到期即已實體清除。

刪除行程須明確確認，由同一交易移除行程、版本、提案、產品與 ADK 對話、分享及修改回執；執行中的 Agent 回 409，沒有自動重試刪除。Quota receipts 不因刪除行程重置；過期且無引用的 receipts 才能壓縮為不含識別碼的每日統計，未知用量仍保守計費。

`pnpm data:expire --schema=workbench_demo` 預設只預覽。永久 apply／前景排程須先確認精確目標及預覽；舊 live 僅允許 dry-run。尚未配置 hosted schedule、backup/restore 與告警。完整界線見 [retention](docs/retention.md)。

## 資料與展示

資料主要為合成 DEMO；另有三筆人工核對名稱／座標的景點參考，價格、開放與可訂狀態仍待確認。未知費用不當成零；所有示範價格保留 DEMO 標示。

在活動詳細資料替換為有座標的參考景點後，可自行點擊載入 OpenStreetMap 底圖；不預抓、不推估路線。無座標項顯示「位置待確認」。外連與素材限制見 [資料依據](docs/data-sources.md) 及 [素材清單](docs/assets-license.md)。

首頁提供一般規劃、預算衝突及明示靜態查詢失敗入口，`/case-study` 為作品案例頁。[Demo 腳本](docs/demo-script.md) 說明操作及措辭；錄影或歷史重播都不能替代最新模型品質與發布驗收。

## ADK 確認探針

首次建立專用 DB 見 [探針重現方式](docs/adk-ag-ui-spike.md#reproduce)。容器已建立時：

```sh
docker start dive-trip-adk-spike
pnpm dev:probe
```

開啟 <http://127.0.0.1:4317/>，可產生合成提案、確認／拒絕及刷新恢復，不呼叫真模型。`pnpm test:adk` 重跑跨程序驗證。Ctrl-C 停止自己啟動的服務，`docker stop dive-trip-adk-spike` 停止 DB 並保留資料。探針不取代產品交易或模型品質測試。

## 真模型與發布邊界

Gemini、OpenRouter、Cloudflare adapter 已接入有界 ADK 工作流；離線測試使用 synthetic credential 及完全攔截的 transport。瀏覽器不能指定 provider、model、account 或 key。Provider 契約見 [Gemini](docs/model-adapter.md)、[OpenRouter](docs/openrouter-adapter.md)、[Cloudflare](docs/cloudflare-adapter.md)。

一般 live launcher 已停用，會在 migration／憑證讀取前回 `WORKBENCH_LIVE_READ_ONLY`；舊 `workbench_live` 與用量保留。真模型評估須另外取得明確、有界授權，先在本機核對不可刪的原始 claims／reports／usage、完整 DB inventory、source manifest 與既有 quota，再經隔離的一次性入口。Public regression vectors、離線通過或未用滿的預算都不能放行模型請求，也不能重設 quota。

新的 unknown usage、限流或技術失敗必須停止、不重試；原始 unknown 保留，reference budget 不等於實際帳單或免費額度。Review 方法見 [評估審查模板](docs/cloudflare-evaluation-1-review.md)。

新版真模型品質尚未通過，第一輪 fixture CI 已通過，沒有 public deployment。Hosted ingress、可信 proxy/IP、secret loading、retention、backup/restore 與 kill-switch 尚需驗收；repository 公開與服務上線是不同交付。產品約束見 [AGENTS.md](AGENTS.md)，發布缺口見 [release evidence](docs/release-evidence.md)。
