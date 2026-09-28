# Dive Trip Agent

潛旅行程互動作品，透過對話與卡片編輯行程，提供鎖定、差異確認、復原及唯讀分享。使用 Next.js／AG-UI、FastAPI／PydanticAI、Temporal 與 PostgreSQL。仍在開發中，尚未公開部署，不提供預訂或潛水安全判斷。

本 repository 提供去識別化的離線 regression vectors。模型提出結構化意圖與證據引用，由服務端計算、驗證及呈現；數值邊界不證明真模型能理解需求或完成任務。原始不可刪 claims、reports、usage 與歷史資料庫留在 ignored local storage，不能從 public fixtures 重建或重設真實 quota。

## 產品與互動契約

作品服務想體驗互動規劃的潛在委託者與休閒潛旅者，不需註冊；市場需求尚未驗證。範圍為小琉球、綠島、墾丁，每趟一個目的地、1–6 人、2–7 天、TWD；超出範圍明示，不截斷需求。程式、資料、帳號及部署獨立，不先建跨專案平台。

- **精選目錄與單一 Agent**：有限資料便於來源查核、重現及成本控制，代價是覆蓋較窄；即時全網探索與多 Agent 的外部依賴、協調及新鮮度成本先不引入。PydanticAI 選工具，Temporal 保存執行進度，Domain 驗證／計價，應用服務在人工確認後保存；受控回答取捨見 [model adapter](docs/model-adapter.md#answer-design-and-rollback)。
- **同一份行程**：桌面對話／工作台並列，手機切換時保留草稿與操作狀態；需求卡、目的地比較、每日活動、地圖、預算與提案共用結構化狀態。先提供移日、替換、移除、鎖定，不做拖曳排序。
- **漸進確認**：只追問影響下一步的人數及潛水／非潛水分配、日期或天數、預算、住宿偏好、步調。日期未定可規劃，須標示未定，不保證當日天氣、開放、價格或可訂；潛水經驗只是自述。地圖只用可核對座標，不假造路線或交通時間。
- **鎖定與差異**：鎖定涵蓋內容、日期與費用依據，不能藉刪父日期或縮天數繞過；移動／替換前由使用者解鎖。局部修改列出所有連帶影響；改人數重算每人／房晚／固定費用，鎖定住宿容量不足時顯示衝突。提案列出增刪改、費差、鎖定與未解問題，確認前不改行程，拒絕不變更；baseVersion 過期須重算。
- **費用與來源**：費用使用整數 TWD 分、單位、數量、來源與 DEMO／估算標記，由程式加總；未知維持 null＋原因，顯示已知小計與待確認項，明列排除的交通／裝備／餐飲等費用，不據缺漏宣稱預算達標。目錄保存來源網址、查核時間、真實／示範分類；圖片須有授權，外部正文不能變成指令。
- **版本與接續**：TripVersion 保存需求、活動、鎖定、費用與引用的完整不可變快照；ownership、baseVersion、proposal、requestId 與 run lease 由交易核對。重送取既有結果，復原建立等同舊內容的新版本，地圖與預算同步；對話保留復原事件。刷新依最後成功保存內容，執行中斷顯示真實終態，不假裝背景仍在跑或盲目重送寫入。
- **匿名公開邊界**：server-issued session／HttpOnly cookie，每次讀寫驗 ownership、同源及輸入；不承諾跨裝置恢復。預設匿名期限 30 天，告知期限及刪除入口；分享須預覽、脫敏、固定快照、可撤銷、不可編輯，期限不超過原行程，持有連結者可讀。技術日誌避免複製完整私人輸入，不保存／展示模型內部思考。
- **明確不做**：預訂、付款、代寄訊息、保證名額、全球／跨目的地最佳化、無限制爬取、多人同步編輯、正式會員、語音、原生 app、適潛／醫療／保險建議或潛水剖面。安全、資格、健康與是否下水交由教練／業者；未核對的時間限制標待確認，不背書整份行程安全。

產品驗收目標及剩餘工作的唯一順序見 [release evidence](docs/release-evidence.md#執行交接)。以上為契約，不代表全部模型品質或 hosted 情境已驗收。

## 驗證狀態

Python／Temporal 已在 `ab80b3f` 通過 [新版 Fixture CI](https://github.com/Will413028/dive-trip-agent/actions/runs/36460356520)：3036 unit、388 integration／11 live skip、262 backend、67 production browser／5 skip；lint、typecheck、contracts、build 與測試資料庫清理亦通過。範圍見 [核心重構](docs/architecture-refactor.md)。下表保留切換前 ADK 的歷史 CI 基線。

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

預設命令已接 Python／Temporal；完整切換驗收進度見 [核心重構](docs/architecture-refactor.md)。一般工作台只提供固定 scenario 的離線 DEMO，不是 live 模型入口。Web 未配置 backend 時回服務不可用，不會退回 ADK。

備妥 [固定 toolchain](docs/toolchain.md)、專用 `dive_trip_test` PostgreSQL 與已安裝 Temporal CLI 後，明確指定 loopback port 及持久 SQLite 路徑：

```sh
# 先停止同資料集的舊 writer、核對目標並備份；只允許 workbench_demo。
pnpm db:migrate --database-port <專用PostgreSQL埠>
pnpm dev --database-port <同一埠> \
  --temporal-binary <已安裝CLI的絕對路徑> \
  --temporal-storage <持久SQLite檔案的絕對路徑>
# production Web：先 pnpm build，再將 dev 換成 start，保留以上三個參數。
```

遷移與 serve 分離，不讀環境檔或任意 DB URL。服務綁定 PostgreSQL 與 Temporal cluster／namespace 身份；停止保留兩份儲存，更換空 Temporal 不會自動重新綁定。`workbench_live` 與原始評估 schema 不在此入口的允許範圍。

開啟 <http://127.0.0.1:4318/>，點「試玩一般規劃」。對話輸入「第二天下午留白」，檢視差異後接受／拒絕；待確認時可刷新接續。確認後直接保存固定 receipt，不再呼模型。其他固定情境包括「人數未定」、「查詢目的地」、「試算目前預算」及「把行程改為悠閒」；不宣稱理解任意自然語言。

資料與不可變回答保存在 PostgreSQL，執行／等待在 Temporal。舊 ADK session 只保留歷史，不轉譯或接續；既有 AcceptedAnswer 仍讀原投影。`tests/support/workbench-dev.ts` 已退役，原 ADK runtime 只供隔離的離線回歸與歷史查核。

若 4318 被占用，可在相同命令加 `--port 4418`，不要停止其他服務。`dev`／`start`／`build`／E2E 共用 Next build 目錄，須序列執行。

```sh
pnpm test:e2e
# 或先 build，再驗 production build：
E2E_PRODUCTION=1 pnpm test:e2e
```

E2E 一律使用 Python backend、4319 及當次建立的 `e2e_*` schema／Temporal；只清理自身資源。涵蓋桌面／390px viewport 的確認、刷新、衝突、分享、持久刪除、未知費用與地圖降級。

離線 launcher 傳入固定 APP_ORIGIN，不信任 Host／Forwarded headers；跳過 `.env.local`，依檔名拒絕其他可載入的 test 環境檔，不讀內容。只傳必要環境變數、停用 telemetry；正式部署不能沿用本機 test mode。

### 備份與回復界線

停入口與 worker、等有界收尾後，成對保存產品 PostgreSQL、Temporal SQLite 與固定版本／migration 清單。首次切換前另保存 demo 的舊 ADK schema，保留原始歷史。備份不可放進 public Git。

新 runtime 尚未寫入前，可在全部 writer 停止時還原完整切換前 demo 備份及對應舊 artifact。已有新版本、刪除或 quota 紀錄後，不可直接還原舊 DB 或啟動舊 ADK writer；須使用相容的新 artifact，並先對帳刪除／撤銷／quota。不可清 binding 或重建空 Temporal 來繞過配對檢查。公開環境的 restore／RPO／RTO 仍是部署 gate。

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

`pnpm db:migrate --database-port <埠>` 只接受專用 loopback DB 的 `workbench_demo`，不自動載入環境檔；執行前確認目標。migration checksum 漂移會拒絕啟動，不修改已套用版本。

## 分享、刪除與留存

分享須先預覽公開欄位，再建立固定版本快照；後續編輯不會同步公開，可撤銷。連結只顯示一次，DB 只存 token hash。公開投影排除對話、日期、住宿偏好及內部 ID；noindex 不等於保密，持有連結者可讀。本機連結不能當成公開服務。

每趟最多 20 個分享連結（含撤銷），有效期不超過原行程與匿名 session，讀取不延長期限。已實作到期拒讀，但不能宣稱到期即已實體清除。

刪除行程須明確確認；先提交持久刪除工作、立即封鎖行程與分享，顯示「刪除中」。Worker 撤銷執行資格、清除 Temporal history 及產品內容，全部完成才顯示「已刪除」；失敗保存進度並有界重試，刷新可查回狀態。Quota receipts 不因刪除行程重置；過期且無引用的 receipts 才能壓縮為不含識別碼的每日統計，未知用量仍保守計費。

`pnpm data:expire --database-port <埠>` 只讀取 demo 的過期與待刪除數量。運行中的 Python worker 每輪有界處理 TTL、刪除及帳務壓縮；舊 retention apply／watch 已退役。尚未配置 hosted schedule、backup/restore 與告警。完整界線見 [retention](docs/retention.md)。

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

新的 unknown usage、限流或技術失敗必須停止、不重試；原始 unknown 保留，reference budget 不等於實際帳單或免費額度。Review 方法與離線反例見 [評估審查指南](docs/evaluation-review.md)。

新版真模型品質尚未通過，第一輪 fixture CI 已通過，沒有 public deployment。Hosted ingress、可信 proxy/IP、secret loading、retention、backup/restore 與 kill-switch 尚需驗收；repository 公開與服務上線是不同交付。產品約束見 [AGENTS.md](AGENTS.md)，發布缺口見 [release evidence](docs/release-evidence.md)。
