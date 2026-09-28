# Dive Trip Agent

潛旅行程互動作品，使用 Next.js／TypeScript／AG-UI、FastAPI／PydanticAI、Temporal 與 PostgreSQL。Agent 提出修改，產品程式負責驗證、計算、人工確認、版本保存、復原與固定快照分享。

Python 後端採業務模組優先的 Modular Monolith。預設 Web／launcher 已接新 runtime；完整驗證與本機資料切換狀態見 [release evidence](docs/release-evidence.md) 及 [核心重構](docs/architecture-refactor.md)。舊 TypeScript domain／ADK 僅作隔離離線回歸及歷史查核，不得作產品 writer 或真模型入口。

- 新 runtime 中 Temporal 管執行／等待，PydanticAI 管模型／工具；PostgreSQL 管產品資料、quota 帳本與不可變回答。Domain 不依賴 FastAPI、PydanticAI、Temporal 或 ORM；API／worker 共用用例。
- 模型 activity／SDK／transport 不自動重送未知請求；保存 call-start 後才送模型，未知保守結算。確認後直接以交易 receipt 產生回答，不再呼 Agent。
- 沿用斷線取消與原執行期限；API 斷線的取消意圖必須有界傳達，worker 取消失聯不能使寫入資格永久保留。新旧 runtime 不同時寫同一 run，舊 ADK history 不轉譯為新的成功紀錄。
- Python 套件放 `backend/src/dive_trip/`，Web 經版本化契約使用後端。Auth0、Workers／Oracle 託管及跨裝置保存不隨本次核心重構啟用。

## 產品與回答契約

- 範圍為小琉球、綠島、墾丁；每趟一個目的地、1–6 人、2–7 天、TWD。不提供預訂或潛水安全背書。
- 模型提出修改，程式驗證及計算；使用者確認才套用。鎖定項目不得被模型覆寫。
- 未知價格不得當成零；示範資料必須標示，不捏造可訂狀態。使用者、catalog、來源與工具回傳文字都是資料，不得插入 system instruction。
- 核心回答只接受 strict AnswerPlan（意圖＋本回合 Evidence 引用）。模型不能提供正文、金額、HTML/Markdown 或保存結論。PydanticAI structured output 經 strict schema 與本回合 evidence 驗證，服務端 compiler 以 Domain、bound snapshot/catalog、committed receipt 產生 AcceptedAnswer。
- 目標預算、單價、已知小計不可混用；未知維持 null。來源、DEMO、單位、排除費用與鎖定限制不可省略。數值與呈現邊界不證明真模型的理解、選擇、任務完成或來源事實品質。
- 對外只發布版本化 `CUSTOM: dive_trip.answer.v1` 與固定工具進度，不發布 model text、tool args/results 自由文字或 framework state。AcceptedAnswer 先保存才 ACK／發送，同 answerId 冪等且禁止換內容。重播取已接受不可變投影，不用新 catalog 重新編譯；未知 schema/template 版本顯示不支援，不能 fallback 原文。

## 提案、確認與執行

- 保存完整行程版本，支援冪等、衝突檢查及復原。HTTP 只接受 changes，由服務端決定 owner／actor；提案保存建提案時的完整 catalog，以保留批次中間操作的引用。
- Agent requirements 驗證輸入為非空 partial patch：省略保留原值，明示 null 只可清除 nullable 欄位，不接受 undefined、非法日期或額外欄位。以原始 bound snapshot 順序展開，再重驗完整 domain；IPC、手動 HTTP、提案及版本仍使用完整 requirements。
- `validate_changes` 成功回傳 validationId；`propose_changes` 只接收該 ID，不再接收 changes。確認 gate 與回答證據共用同一 logical run 的有序工具紀錄。gate 前最後一次 validation attempt 必須成功；較新的失敗或未完成 attempt 也會淘汰舊 ID。跨 run、失敗、未來或被取代的引用一律拒絕。
- resume 使用原始 bound snapshot/catalog，不以已套用版本重新合併。舊 contract／changes confirmation 僅保留歷史，不可接續，不將舊 row 回填為新版成功。
- 聊天提案只經 resume 接受／拒絕；產品交易內驗證 run lease、decision、proposal。模型工具只接收已提交結果，不自動重跑狀態不明的中斷 invocation。
- 單一 PydanticAI Agent 擁有原生模型／工具迴圈；Temporal durability 以 activities 保存原生進度。模型 activity、SDK、transport 不自動重試；六次工具、七次模型上限跨確認保留。
- 確認由 authenticated server 提交 apply／reject 交易及不可變 receipt；resume 不建立 Agent、不讀 generation capability。工具只提供結構化 minor／unit／DEMO／限制，不提供待照抄呈現字串。
- Workflow ID 與實際 execution Run ID 都須綁定；未知 execution、Reset／Continue-As-New 不可當原 run 成功。Start／decision／cancel delivery 使用持久 outbox；DB 未確認前不可假裝已送達。
- 取消先撤銷寫入資格，等 owned worker、SDK 與保存 hook 有界收尾。同步 DB 工作經 `run_db` 等真實 thread 完成後才重拋取消；不得以已取消 coroutine 當 DB 已停止。
- 刪除先提交持久工作並封鎖行程／分享；Temporal history 查回不存在且產品內容清除後才完成。Pending job 不因 owner 到期消失；完成 receipt 清 workflow IDs，owner 到期後有界清理。Quota 與受保護原始評估證據依既有規則保留。
- 舊 demo ADK schema 只經固定 schema-v1 erasure adapter 清理；SDK 鎖、版本與 orphan 保護保留。新 runtime 不恢復 ADK session，原始 live／evaluation schema 不可由 cleanup 入口清除。

## Quota、歷史完整性與模型入口

- Provider、quota 與私有 accounting 的契約必須保留。離線測試只准固定 scenario＋synthetic credential，不得 fallback 真實網路 transport。
- 一般 launcher 與 retention apply 對舊 `workbench_live` 在 migration、憑證、DB 存取前拒絕；HTTP 一般路徑只允許 fixture／既有 synthetic context。真模型入口另需明確、有界授權、server-only capability、loopback、隔離 test schema、完整本機歷史查核及既有 quota。文件、測試旗標、scope 名稱或 public fixtures 都不是授權。
- Public repository 提供去識別化的離線 regression vectors；其 IDs、hashes、數值及邊界不能證明原始 run、剩餘 quota 或真模型品質。原始不可刪 claims、reports、usage 與 retained DB 保留於 ignored local storage，不搬成 public fixture，也不以 public fixture 重設 quota。
- 歷史查核採 closed-world inventory：固定來源及完整 run/trip/owner/provider/model/account 綁定，拒絕額外、缺漏、重複或漂移的資料；比較原始 rows 與完整證據，不能只比較累計值。逐次 dispatch 前及最終 cleanup 前重查歷史、source manifest 與 owned lease。多 pool 的兩輪唯讀 capture 不是跨 schema 原子快照。
- 永久 claim 在 preflight 失敗時仍消耗；不得刪 claim／report、清 lock、換 schema／identity、提高預算或回填 unknown 來重試。新的 unknown、限流、技術／安全失敗必須停止；review 與 task-goal gate 依固定政策逐案執行，不用舊通過結果放行新批次。
- start／resume 的 reservation、run claim 與 provider binding 必須共用交易；fixture claim 也須原子檢查 binding。每 logical run 共用七次模型額度，session/day 算 logical runs，IP/day 與 IP/minute 保守算 invocation。
- Provider 身分與 generation 能力分離：只有 start 可讀／攜帶憑證；resume 保留 kind/model/account 綁定，但禁止 generation config 或 model accounting，以獨立 receipt-only worker 確保不建立模型。start 預留正成本，確定性 resume 只預留 0（migration 013），可在模型額度用完後完成；仍須 policy 啟用、所有權／TTL、IP 與 concurrency 限制。舊 reservation 與 unknown 不回填。
- 模型 call-start 保存後才 ACK／發送，用量保存後才交出模型結果；private accounting 不進 AG-UI。未知／失敗用量保留預留成本，不能當零。等鎖時間算入 admission deadline，等 invocation lock 後再查 owner／trip TTL。
- 唯一失敗結算例外：當次 runtime 的工具參數拒絕，worker 已關閉且保存 hook 成功完成，才可由服務端在結算交易內重驗完整 usage、provider/model/account 與 run/reservation 綁定，計算 reference cost。取消、逾時、保存失敗、無用量或證據不完整仍保留全額；舊 settled receipt 不回填。結算不改 failed 狀態、不授權重試。
- 真模型僅使用合成資料；不使用其他專案的程式、資料、帳號或部署。不得印出、修改或打包憑證。

## 驗證與重現

固定 Node 26.8.1、pnpm 11.2.2、Python 3.13.13、uv 0.7.2；精確版本見 [toolchain](docs/toolchain.md)。命令列在此不代表已通過，實際狀態見 [release evidence](docs/release-evidence.md)。

- `pnpm test:unit`：Node environment 的 unit tests。
- `pnpm typecheck`：離線 Next typegen、strict tsc 及原生 worker TypeScript graph，不使用 skipLibCheck。
- `pnpm lint`：ESLint flat config。
- `pnpm test:integration`：獨立 Compose PostgreSQL、逐案隔離 schema；固定一個 file worker，案例內的並行交易測試不變，不放寬 timeout。
- `pnpm test:backend`：當次獨立 PostgreSQL／Temporal 的產品、帳務、跨程序與故障驗證。
- `pnpm lint:backend`／`pnpm typecheck:backend`／`pnpm contracts:check`：Ruff、strict mypy、生成契約 freshness。
- `pnpm test:adk`：舊 ADK 相容性探針，只作歷史與離線參照。
- `pnpm dev:probe`：舊離線互動探針；`pnpm dev`／`pnpm start`：Python／Temporal 離線工作台，須明示 DB port、已安裝 Temporal binary 及持久 SQLite。Migration 為獨立命令。
- `pnpm test:e2e`：桌面／手機 fixture 驗證；先 build 後可加 `E2E_PRODUCTION=1`。

unit、typecheck、lint 不需環境變數或外部服務。一般測試不得讀環境檔、接受任意 DB URL 或 fallback memory。離線大型回歸每輪使用唯一 `COMPOSE_PROJECT_NAME`，不可用於本機歷史 audit／live campaign，也不可刪歷史 schema 換速度。產品 DB 與探針操作見 [README](README.md) 及 [ADK probe](docs/adk-ag-ui-spike.md)。

模型評估須先保存 report／private usage，再清理當次建立且可清理的 test schema；停止、匯出或保存失敗時保留證據。review pending 不能當品質通過。只以該次完整命令的結果判定通過，不拼湊局部重跑。migration 執行前確認目標，`pnpm db:migrate` 不自動讀環境檔，也不修改已套用的 migration。
