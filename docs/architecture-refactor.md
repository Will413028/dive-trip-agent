# Python／Temporal 核心重構

狀態：**2026-09-29 已完成 B 的核心重構、離線驗收、本機 demo 切換與新版 Fixture CI**。基線 `ac21cb2`；參考專案的架構／T00 骨架提供設計參照，其業務 Agent、帳號與部署並非已驗收範本。本頁記本次重構細項，主優先順序仍在 [release evidence](release-evidence.md)。使用者選擇「核心架構對齊：Python 後端＋Temporal，沿用潛旅產品契約」，並授權本輪必要依賴與隔離測試工具下載。

## 選擇與前提

| 路線 | 收益 | 代價 |
| --- | --- | --- |
| A：維持 TypeScript／ADK，借用模組組織 | 保留現有執行環境與多數測試，先降低跨層耦合 | 仍維護 ADK session、child-process IPC 及目前恢復機制 |
| B：FastAPI／PydanticAI＋Temporal，Next.js／AG-UI | Agent、持久執行、產品交易有明確分工，可與參考作品採相同開發方式 | Python／TS 契約、Temporal 維運、後端規則移植與故障測試；不能保證模型品質提升 |
| C：B 加帳號及部署平台對齊 | 一併規劃跨裝置保存及雲端入口 | 新增登入與 owner 遷移、託管相容性及容量驗收，超出單純後端重構 |

**已選 B**。使用者希望採用參考專案的核心技術，接受跨語言契約與 Temporal 執行層；沒有聲稱 B 能直接改善模型品質。若目標只在完成目前展示，A 的工作量較小，兩份獨立草稿亦指出此取捨。現有 ADK 是可重評的選型；未部署不代表沒有須保留的資料及歷史。

| 前提 | 本案判定 |
| --- | --- |
| 潛旅範圍、精確費用、鎖定、人工確認、版本與固定分享 | 真正產品契約，重構仍須驗收 |
| AnswerPlan → compiler → AcceptedAnswer、保存先於公開、不可變重播 | 真正回答契約；以 Python 重建時仍須等價 |
| 私有歷史、claims、unknown 與 quota | 真正完整性邊界，不因換 runtime 重設 |
| 全 TypeScript、Google ADK、Node child worker、MikroORM | 現行技術選型，B 會替換；不是產品必需 |
| Auth0、Cloudflare Workers、Oracle VM、vinext | 參考專案的選型，不自動變成本案約束 |
| 舊正式使用者的不中斷切換 | 尚無公開部署；仍須在遷移前盤點實際本機資料與未完成工作 |

取消語意依使用者「沿用潛旅產品契約」保留：現行 `src/server/chat-http.ts` 將 request abort／SSE cancel 接到執行取消，新 API 也必須將斷線轉成有界取消命令，並處理取消訊息未送達。若從背景研究重新設計，斷線只中斷觀察會更適合，但那是產品行為變更；本次沒有採用。等待確認可持久保存，活躍模型執行仍受原期限限制，不能將取消或 unknown 重新包裝成背景恢復。

## B 的責任分工

```text
Next.js／AG-UI
    │ commands、queries、已保存的回答／進度
FastAPI ───────────────────────── PostgreSQL
    │ 接受／查回相同 workflow ID       ↑ 業務交易、用量、版本、公開投影
Temporal workflow ── activities ──────┘
    │
PydanticAI：模型與工具協調
```

前端以功能組織為 `features/workbench`、`features/sharing`，`app` 保持路由組合；後端採 Modular Monolith，模組依實際用例建立：`catalog`、`trips`、`planning`、`sharing`、`identity`、`usage`。API 與 worker 共用一個 Python 套件，domain 不依賴 FastAPI、PydanticAI、Temporal 或 ORM。模組經公開用例合作；跨模組交易由 application 用例管理。

私有 evidence auditor 是明確的唯讀例外：application 在同一 caller-owned `REPEATABLE READ READ ONLY` snapshot 直接查 planning／trips／usage 原始 rows，以獨立核對帳本與 receipts。它不得寫入、呼叫 settlement／mutation，或作一般產品查詢捷徑；資料表、receipt 編碼或 executor schema 變更時必須重驗。

- `trips` 擁有需求、鎖定、完整版本、proposal／apply／reject／restore。
- `planning` 擁有有界 Agent 回合、證據、確認狀態及回答 compiler。
- `usage` 擁有 reservation、call-start、usage、結算及 provider binding；Temporal history 不代替帳本。
- `sharing` 擁有固定公開快照、撤銷與 expiry；`identity` 第一階段仍服務既有匿名 owner 契約。
- PostgreSQL 保存產品資料與可公開投影；Temporal history 保存執行位置、等待與 activity 結果；Web 僅保存 UI 狀態。
- Pydantic／OpenAPI 生成 Web types；AG-UI／AcceptedAnswer 另外做 runtime schema 與跨語言 round-trip，不能以 TypeScript 型別取代輸入驗證。

## 消費端與遷移對照

以 repo root 執行下列搜尋核對入口；實作前重跑，避免清單落後：

```sh
git ls-tree -d --name-only HEAD
rg -l '@google/adk|executeAgent|agent/runtime|agent/worker' src tests evals -g '*.ts' -g '*.tsx'
rg -n 'from .*domain|from .*server|from .*agent' src/app src/features -g '*.ts' -g '*.tsx'
rg -n 'request.signal|AbortSignal|abort\(|cancel\(' src/server/chat-http.ts src/features/workbench/ChatPanel.tsx
```

| 現行消費端／機制 | 從今天需求重新設計 | B 的處理與必要驗證 |
| --- | --- | --- |
| `src/app/api/[...segments]/route.ts`、`src/server/http.ts` | 薄 Web proxy、FastAPI typed commands／queries | 搬移 HTTP 權威；保持 owner、origin、錯誤、冪等及方法限制 |
| `src/app/share/[token]/page.tsx` 直接讀 share store | Web 讀後端公開 projection | 改 API，驗撤銷、expiry、cache 與資料脫敏 |
| `src/features/workbench/` 的 domain imports | 後端計算規則，Web 使用契約與純格式化 | `ProposalPanel` 的 diff 改取權威結果；`ChatPanel`／`AcceptedAnswer` 維持嚴格事件驗證；移植其餘卡片／表單型別 |
| `src/domain/`、`src/catalog/` | 純業務規則，與 framework 分離 | Python 單一權威；以共同 vectors 對照費用、null、日期、patch、鎖定與版本，不長期雙寫兩份規則 |
| `src/server/chat-http.ts`、`run-store.ts` | API 接受 command、workflow 協調、產品用例交易、SSE 讀投影 | 拆除同一串流函式內的執行／結算／確認耦合；驗 DB commit 與 workflow start 回應遺失 |
| `src/agent/runtime.ts`、`worker.ts`、ADK session／confirmation／model guard | 官方 durable Agent 整合＋顯式產品確認與限制 | 替換 child-process IPC／ADK callback／原生 session parser；不能同時讓兩套 runtime 恢復同一 run |
| `src/agent/*provider*`、wire／REST adapters、fixture | framework provider 接合＋產品呼叫帳本與離線 transport | 逐項驗 provider/model/account、用量完整性、timeout 與零網路 fixture；不因 SDK 自帶 adapter 刪掉帳務約束 |
| `agent-admission.ts`、`quota.ts`、`model-cost.ts` | 交易式 admission 與可稽核結算 | 保留行為；移植原始 regression vectors，unknown 不當零 |
| `trip-store.ts`、`version-store.ts`、`share-store.ts`、`session.ts`、`retention.ts`、SQL migrations | PostgreSQL 單一寫入權威、業務唯一鍵與交易 | 保留 UUID／minor units／完整快照等經重新評估仍合適的資料語意；ORM 與 migration 工具另換，已套用 SQL 不重寫 |
| `tests/support/` worker／launcher／campaign ports、unit／integration／browser、`evals/` | 同一產品契約下分層驗證 | 重接 fixture 與 collector；ADK 專屬測試改為新 runtime 證據，A1–A14、帳務與失敗反例仍須覆蓋 |
| Active run 唯一性與 UI 可操作狀態 | 舊單一 executor 時 status 即可代表目前資格；退役後舊未完成 status 只是歷史 | migration020以trip＋executor維持各自active唯一性；新start/UI只授予temporal-v1資格，舊rows/events不改。若未來允許跨executor接續，須先重設同trip准入及history轉移契約 |

`src/agent/answer-compiler.ts` 的確定性呈現從零設計仍合理；保留其行為並移植語言，不讓 PydanticAI 自由正文取代。ADK `_adk` schema lock 與 `ReceiptOnlyModel` 屬舊 runtime 機制：新路徑以獨立 Temporal schema 管理與完全不呼叫 Agent 的確認用例取代；舊歷史讀取需要的相容邊界須經盤點後保留。

Provider wire 重新評估（2026-09-28）：

| 機制 | 舊必要條件／今天是否成立 | 今天從零設計 | 決定與重評條件 |
| --- | --- | --- | --- |
| OpenRouter 自組 routing／token payload | ADK 的 REST adapter 沒有原生 OpenRouter mapper；新 PydanticAI 2.51 已有 OpenRouterModel／Provider 與 typed routing settings，該前提不成立 | 原生 SDK 生成 request，transport 只驗證政策／捕捉 raw accounting | 移除重組 payload，保留 free-only、無 fallback／BYOK 的契約；SDK 升級時跑 wire regression |
| Cloudflare `/ai/run` endpoint 與 envelope bridge | 舊 adapter 以 REST model path 固定 account/model；官方 Gemma 頁已明列 OpenAI-compatible endpoint 與 model／tools／chat_template_kwargs／usage schema，新路徑不需改寫 SDK request | 直接固定 account-scoped `/ai/v1/chat/completions`，model 與 non-thinking extra_body 由 server 設定；仍無 Gateway | 刪除 endpoint/envelope bridge；完整 raw usage 缺漏即 unknown／拒絕，實際 provider 品質仍須 Task11 授權驗證，不將文件或 mock 當 live 通過 |
| 原始 usage 查核、單次 transport、固定 endpoint、大小／期限 | SDK 仍可能將缺漏用量正規化成0，且會有重試預設；產品帳務與 bounded dispatch 約束仍成立 | SDK 轉換模型協定，獨立薄 transport 捕捉原始 evidence；application 保存帳本後才交結果 | 保留；只有 SDK 提供可證明完整性且不預設0的原始 response API，才重評 capture 層 |

依據：[PydanticAI OpenRouter](https://pydantic.dev/docs/ai/api/models/openrouter/)、[Cloudflare direct OpenAI-compatible API](https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/)、[固定 Gemma 模型契約](https://developers.cloudflare.com/workers-ai/models/gemma-4-26b-a4b-it/)。新 SDK 切片目前只提供強制 MockTransport＋synthetic credential 的離線 capability；真模型入口仍须完整歷史查核接線。

## Durable 執行必須滿足的契約

原生執行證據重新評估（2026-09-28）：

| 機制 | 舊必要條件／今天是否成立 | 今天從零設計 | 決定與重評條件 |
| --- | --- | --- | --- |
| logical run 與原生 execution 身分 | ADK session 綁定不能辨識 Temporal 同 Workflow ID 的不同 execution；帳本歸屬約束仍成立 | 由首個 bound activity 交易保存實際 Run ID，後續 activity 與 collector 使用同一 pin | migration018 不回填既有 execution；拒絕不同 Run ID／Reset／Continue-As-New。若將來允許 execution chain，需重設完整對帳契約 |
| PostgreSQL snapshot 與 Temporal history | 舊同庫 ADK audit 的原子讀取不能延伸到跨服務 | DB 使用 REPEATABLE READ READ ONLY；閉合 history 以 pinned Run ID 分頁讀取並核對 activity IDs、attempt 與事件關係 | 新 v3 不冒充跨服務原子快照或 remote worker drained；接入 settlement／cleanup 前另驗 worker 收尾及資料穩定性 |
| 原生 model activity 名稱 | SDK 將名稱保存為 compatibility data；精確辨識模型執行仍必要 | 固定 SDK／agent contract 的精確名稱查核，不以模糊 model 子字串接受任意活動 | SDK／agent name 升級必須重驗 native history，未知名稱拒絕；不轉譯成舊 ADK v1/v2 證據 |
| 私有 auditor 跨模組讀取原始 rows | 舊 evals/usage.ts 獨立核對產品與帳本；closed-world 與 immutable receipt 約束仍成立，同一 PostgreSQL 可提供一致 snapshot | 同庫獨立 read/audit model；依 [Microsoft CQRS](https://learn.microsoft.com/en-us/azure/architecture/patterns/cqrs#separate-models-in-a-single-data-store) 的同庫讀寫模型分離，應用於本案是設計推論 | 保留窄的 application 唯讀 SQL auditor，不經 command projection 隱藏原始證據；同一 caller-owned snapshot、不寫入、不呼 settlement、不供一般產品查詢。資料表、receipt 編碼或 executor schema 變更時重驗 |

**已決定的刪除調整（2026-09-28）**：Temporal history 不參加產品 DB 交易；使用者選持久刪除工作。先封鎖行程／分享並回刪除中，清理 history 與產品內容後才回已刪除；重送和 worker 重啟由持久進度恢復。Quota receipts／受保護原始評估證據保留。原 README 的同交易 ADK 刪除只描述舊 executor，不能照搬為跨服務原子保證。

刪除 job 只保存必要身份與進度，pending 不因 owner 過期或 cascade 消失；完成時立即清空 workflow IDs，完成 receipt 在 owner 仍有效時提供狀態／重送。owner 已過期或不存在後可由 bounded retention 清除，沒有永久保留新識別碼的例外。清理排程每輪最多處理100個到期 pending job，失敗持久退避；完成 receipt 每轮至多1000個，活躍 owner 的下次檢查排至固定 expiry，避免飢餓。

1. 一個 logical run 綁定穩定 workflow ID；產品 DB 的 request key＋payload hash、owner、trip、baseVersion、provider binding 與 reservation 共同驗證。DB 寫入和 Temporal start 不是同一交易，未確認 start 維持待對帳，HTTP 重送查回原工作。
2. 使用 PydanticAI `TemporalDurability`；模型／工具 I/O 由 activities 執行，不把整個 Agent 再包成一個普通 activity，也不自建另一套通用工具迴圈。
3. **模型 activity、provider SDK、HTTP transport 與結構修正重試要一起設限**。第一個等價版本禁止自動重送模型請求；原七次模型／六次工具上限仍是產品政策。call-start 必須先持久化；結果未明即停止、保留預留成本。`maximum_attempts=1` 本身不證明 exactly-once，須注入遠端可能完成、local receipt 尚未完成的故障。
4. 只對已證明冪等且符合停止政策的本機保存／對帳操作考慮有限重試；每次重入先查既有 receipt 與寫入資格。Temporal 能 replay 已保存步驟，不代表可以重跑未知模型 I/O。
5. proposal 保留原始 snapshot／catalog。最新成功 validation attempt 才能產生有效 ID，後續失敗／未完成 attempt 淘汰舊 ID；以新 runtime 的有序證據實作，不將 ADK parser 原封移植。
6. 確認命令驗 owner、run、proposal、decision、baseVersion 及 TTL；apply／reject transaction 提交後編譯固定 receipt，不再呼模型。DB 已提交但 activity completion 遺失時，讀回相同 receipt；不能建立第二版或重算新 catalog。
7. `CUSTOM: dive_trip.answer.v1` 的已接受投影保存後才公開；相同 answerId 禁止換內容。SSE 從產品投影讀取，不直接轉送 framework model text、tool results 或 Temporal history。
8. 取消／過期／superseded 先撤銷 DB 寫入資格，再要求停止 worker；晚到結果不能入庫。活動執行期限、人工等待 TTL 與觀察連線期限分開，具體數值沿用既有政策，未核定前不延長。
9. 新 runtime 不續跑舊 ADK 中斷 session、不改寫原始歷史或 unknown。舊 AcceptedAnswer 保持原投影；ADK native-event 帳務證據與新的 Temporal 證據分版本查核，不偽造格式轉換成功。

官方文件確認可分別設定 model activity 的 retry policy；Temporal 預設 activity 重試無次數上限，設 1 才是不重試。此處的保守政策來自潛旅既有契約，並非 framework 的預設保證：[PydanticAI Temporal](https://pydantic.dev/docs/ai/capabilities/durable_execution/temporal/#activity-configuration)、[Temporal Retry Policy](https://docs.temporal.io/encyclopedia/retry-policies#maximum-attempts)。

## 實作切片與出口

以下是本次重構的相依設計，由 release evidence 的重構項連入，詳細進度只記本頁。

1. **契約與故障樣本**：固化現行 HTTP／AcceptedAnswer／A1–A14 與 quota vectors，盤點實際需遷移資料、schema、未完成 run 及 retained history；未盤點不設計破壞性 migration。確認斷線／取消行為及第一個 provider 的範圍。
2. **第一條完整切片**：Python domain／交易、FastAPI、PydanticAI synthetic model、Temporal，完成「需求→提案→人工確認→固定 receipt→重播」。含真 PostgreSQL、獨立 worker crash 及零模型 resume；尚不切換 Web 預設後端。
3. **Web 與其餘用例**：生成契約，接工作台、手動編輯、復原、分享、刪除／TTL；完成讀寫 owner 負例與 desktop／mobile journey。確認 schema 在跨語言輸入時拒絕同一批非法值。
4. **完整等價 gate**：既有 A1–A14、離線 quota／歷史邊界、舊投影讀取與新 workflow replay 通過；fresh design review 重新評估沿用機制，再做正確性／安全檢查。最後才選擇新預設 backend 並退役舊可寫入口。
5. **品質與部署**：真模型另依同一專案的有界授權及完整歷史 preflight；沿用主清單 Task 11–12，舊 fixture CI 不當新 backend 的通過證據。Auth0／Workers／Oracle 僅在選定 C 或另定範圍後納入。

必要 fault／mutation 包含：去掉 owner filter、撤掉取消 fence、改錯 null／費用規則、重送不同 payload、沿用已淘汰 validationId、模型送出後 worker 崩潰、DB 已套用但 activity 未完成、resume 意外呼模型、持久化失敗仍發回答，以及不相容 workflow 對舊 history replay。每項應由對應測試失敗，不能用行數或 mock 呼叫數代替行為。

切換前允許兩套離線測試環境比較，但同一資料集同時只有一個產品寫入 runtime。切換後回退不能把新 Temporal run 交給舊 ADK，或還原整庫抹掉新資料；使用版本化 executor／相容 API artifact，故障時停止新 start 並保留已保存結果與帳務證據。具體本機命令與成對備份／回復界線見 README；本次新增 migration014–020，不修改001–013。舊未完成 ADK run 保留status/events，新executor的active slot獨立，UI只讀而不提供resume。

## 本次核對範圍

已讀現行產品契約、release evidence、回答與帳務契約、主要 API／worker／Web imports；核對參考專案架構、T00 計畫、套件宣告與 Temporal bootstrap。參考工作樹另有 identity 施工變更，未修改或當成已驗收成果。兩份 fresh 唯讀草稿分別核對前提；共同提出的取消語意、retry ambiguity、原始 bound catalog、單一 executor 及 receipt-only 邊界已納入本頁。

## 進度與驗證證據

### 2026-09-29 最終驗收與本機切換

- 核心 commit `02d461c` 與 CI 工具鏈修正 `c4c1ddb`／`ab80b3f` 已正常 fast-forward 推送到 `main`。新版 [Fixture CI run 36460356520](https://github.com/Will413028/dive-trip-agent/actions/runs/36460356520) 在 `ab80b3f` 的唯一 job 與全部步驟 success（15分50秒）：3036 unit／103 files、388 integration／11 live skip、262 backend、67 browser／5 skip，另有lint／typecheck／mypy／contracts／build及disposable DB清理。首兩次CI只在Python安裝前失敗；setup-uv的`python-version`只設定`UV_PYTHON`，固定uv0.7.2也沒有3.13.13的Linux下載清單。最終以固定`setup-python` commit安裝Python並確認uv可找到，沒有修改Python、uv、lockfile或測試門檻。CI不驗真模型品質。
- 核心實作已同步回原專案；以 `git diff --name-only -z HEAD` 加 `git ls-files --others --exclude-standard -z` 建立轉移清單，238個路徑逐檔比對一致。同步當時只覆蓋本輪既有草稿；後續commit／push見上列CI證據。
- 最終完整命令：`pnpm test:backend` **262 passed（182.71秒）**；`pnpm test:unit` **3036 passed／103 files（75.68秒）**；`pnpm test:integration` **388 passed／11 live skipped（487.10秒）**；`E2E_PRODUCTION=1 pnpm test:e2e` **67 passed／5既有skip（3.0分鐘）**。使用固定toolchain、Docker colima及獨立Compose project；沒有提高timeout或合併局部重跑。Logs分別為`/tmp/dive-trip-backend-checkpoint-29.log`、`/tmp/dive-trip-final-unit.log`、`/tmp/dive-trip-final-integration.log`、`/tmp/dive-trip-final-browser.log`。
- Web typecheck／ESLint／production build、Python Ruff／strict mypy（84 source files）、contracts freshness、fixture boundary及actionlint通過；primary另做frozen uv sync與production build通過。完整核心及切換fresh design-review均無finding；最後correctness finding已修復並複查解除。
- 原demo先custom dump，再於owned隔離PostgreSQL成功還原及升級。實際只對`workbench_demo`套014–020；migration前無其他DB連線。唯讀完整表指紋確認**354張既有表的原欄位rows不變，其中337張非產品demo表（含受保護原始歷史）完全不變**。新表與新欄位依migration新增，ledger由13變20；原live不套migration。
- 原專案已以同一PostgreSQL及持久Temporal SQLite啟動、停止再啟動成功；`GET /api/agent-mode`為fixture，新用例可讀3趟既有行程／4個舊run。初次啟動收尾後再次核對原資料指紋不變。舊ADK run唯讀，不可接續；新runtime只接受temporal-v1。
- 備份、表指紋、source transfer與runtime查核結果保存於ignored本機storage。回滾須遵守[README備份與回復界線](../README.md#備份與回復界線)的停止writer、成對保存DB／Temporal程序，不可直接讓ADK寫入已切換資料。真模型品質與public deployment仍由Task11–12另驗。

以下checkpoint按當時狀態保留，不能把較早的「待接線／未切換」當成目前狀態。

### 2026-09-29 預設切換驗證

- `dev/start/db:migrate/data:expire` 改 Python；Web 缺 backend 回503、不退ADK，分享只读Python projection；刪除UI／E2E移除舊同步成功分支。
- 舊launcher、migration CLI、retention apply拒絕；舊chat拒絕所有live context，native ADK執行拒絕demo/live schema及非synthetic generation。舊程式僅保留隔離離線回歸／歷史查核。
- 新CI接固定uv／Python、frozen dependencies、backend lint/mypy/contracts/tests；未執行遠端CI。官方setup-uv固定commit來源见toolchain；actionlint本機通過。
- Backend完整checkpoint28 **261passed（112.86秒）**，log `/tmp/dive-trip-backend-checkpoint-28.log`。Web unit完整 **3036passed／103files（87.49秒）**，log `/tmp/dive-trip-cutover-unit.log`；build／ESLint／strict Web typecheck通過。Strict mypy最初抓到IPC Future及Pydantic dump回傳Any，補明確型別後84source files通過；未改行為或降低strict。
- Launcher拒絕受保護schema／舊live flags／隱式Temporal的11項通過；Web退役入口affected28項通過。獨立切換design-review NO DESIGN FINDINGS（改0／記0／提0／駁回0）；正確性複查、完整legacy integration及production browser接續，不拼湊較早结果宣稱完成。

- 最後correctness review發現舊ADK active status會同時卡住SQL檢查、唯一鍵及UI。兩種status反例先2failed（6.67秒），log `/tmp/dive-trip-legacy-active-before-2.log`；migration020改active唯一鍵為trip＋executor，新start只檢查temporal-v1，UI用executor判斷可執行性。舊rows/events不改、AcceptedAnswer仍原樣顯示；affected12passed（9.99秒），log `/tmp/dive-trip-legacy-active-after.log`，最後只讀複查CLOSED。Browser補兩種歷史status的新聊天反例，待整批驗證。
- 本機demo切換前再次唯讀核對：001–013、3sessions／3trips／7versions／4succeeded runs，其他連線0。命令為固定desktop-linux容器內`psql -X -A -t`查上述表與`pg_stat_activity`；demo＋demo_adk custom dump已存ignored storage並以pg_restore --list驗證。尚未套新migration；受保護原始live／evaluation未寫入。

- 最後backend checkpoint29 **262passed（182.71秒）**，log `/tmp/dive-trip-backend-checkpoint-29.log`，包含migration020。完整production browser **67passed／5既有skip（3.0分鐘）**，log `/tmp/dive-trip-final-browser.log`；命令 `DOCKER_CONTEXT=colima COMPOSE_PROJECT_NAME=dive-trip-python-web-20260928-a E2E_PRODUCTION=1 pnpm test:e2e`，不再需要E2E_PYTHON。四個新桌面／手機舊status案例均通過；build／typecheck／Ruff／ESLint／mypy／contracts／actionlint皆通過。
- 原demo backup隔離還原演練通過：新PostgreSQL容器還原後套001–020，22張既有表的原欄位完整row指紋不變，3趟行程／4個舊run可由新用例讀取。命令 `uv run --frozen --no-sync --project backend python backend/tests/cutover_restore_probe.py --backup <private-demo-before.dump>`，log `/tmp/dive-trip-cutover-restore-probe.log`。當次容器已清理；原desktop-linux DB停止，未套新migration。

### 2026-09-29 evaluator 接線切片

- `EvaluationDispatcher` 擁有每一個 worker phase 與 SDK 關閉；同一 operation lock 保護 start／decide／capture，admission 提交後才呼叫 generation factory。resume 使用 receipt-only worker，沒有 factory／generation。這不是一般 HTTP 的 live 設定開關。
- 獨立 correctness review 的並行 start 覆寫 phase、cancel 失敗跳過 SDK close 兩項，修前反例共 2 failed；已序列化 phase 轉移、以 finally 執行有界 close，清理不明時禁止宣稱 drain。三 provider 的 transport close 原先 3 failed，新增 wrapper 的 `aclose` delegation 後 24 passed。後續同批 runtime／SDK／HTTP／delivery **40 passed（26.23 秒）**，log `/tmp/dive-trip-evaluation-ownership-tests-2.log`；review 最後複查解除。
- 私有 loopback peer 沿用 Taipei 每日 HMAC 與跨午夜前一分鐘 key，與現行 TS `quotaIpKeys` differential 比對；受影響 peer／runtime **8 passed（10.64 秒）**，log `/tmp/dive-trip-evaluation-peer-tests.log`。header／URL／任意 IP 不進此私有 adapter。
- 新 `EvaluationSession` 在程序內走真 FastAPI 產品 routes，限定當次 owner／trip 的 GET trip、GET runs 與 POST agent。既有 TS `collectCase`／ReplayBundle v2 已跑完 free-afternoon 的 start→accept→receipt，確認前後版本 1／2、start generation 一次、private evidence v3 與 native history 保存；重複 capture 不累加 tokens，額外 trip 不因總額相同而放行。單項整合 **1 passed（10.77 秒）**，log `/tmp/dive-trip-evaluation-capture-tests.log`；其後修正 probe model pin 並加入 safetyFailures assertion，由 checkpoint27 全套接續驗證。
- Catalog fault 最後獨立 correctness review 無 findings。完整 checkpoint27 **238 passed（215.67秒）**，log `/tmp/dive-trip-backend-checkpoint-27.log`；包含最後 probe model pin／safetyFailures assertion，尚未包含後續 private IPC 與 cleanup gate。
- Capture state gate 的獨立 finding：POST 或 capture 失敗後不能沿用舊成功旗標放行下一 case。修前2個反例均 DID NOT RAISE，log `/tmp/dive-trip-evaluation-capture-gate-before.log`；修後 affected **10 passed（24.35秒）**，log `/tmp/dive-trip-evaluation-capture-gate-after.log`，最後唯讀複查解除。
- 私有父子程序通道使用 inherited duplex，不開 listener；stdout／stderr 不承載 protocol。每次 start admission 後才向父程序請求一次 credential，resume 不授予 generation；普通 fixture 固定 SyntheticGeneration／MockTransport，沒有網路 fallback。既有 reviewed controller 的永久 claim、原始 history／source／lease beforeDispatch 與 final check 保留，改接 Python 子程序。
- 新 SDK common core／通道 affected **30 passed（9.77秒）**，log `/tmp/dive-trip-private-channel-tests-2.log`；完整 owned child 成功清理／報告失敗保留 PostgreSQL＋SQLite及受限factory **3 passed（16.63秒）**，log `/tmp/dive-trip-private-process-tests.log`。Controller gate/source **117 passed（5.44秒）**，log `/tmp/dive-trip-python-controller-gates.log`。
- 另外修正 response 已可讀但 write drain 未返回時的新 command race：修前1failed／5passed，log `/tmp/dive-trip-channel-drain-before.log`；handler 完成先釋放 command，另追蹤 response task 至收尾，修後7passed（11.95秒），log `/tmp/dive-trip-channel-drain-after.log`。
- Cleanup correctness review 發現最後 capture 後新 schema 漂移仍可被刪除。第一次反例碰 PostgreSQL 啟動／Docker stop 逾時，不能算行為證據；第二輪確實發現新增 session 後 schema 被刪，1failed（28.93秒），log `/tmp/dive-trip-cleanup-drift-before-2.log`。已保存全 schema 固定 table inventory 的資料指紋；worker／Temporal 停止後取同 migration lock 與全部表鎖，同交易比對已匯出的指紋再 DROP，漂移保留 schema／SQLite。修後process／session／channel整批12passed（162.86秒），log `/tmp/dive-trip-cleanup-drift-after.log`；獨立correctness複查CLOSED。
- 未讀模型憑證、發真模型請求或寫原始歷史 DB；整體 fresh design-review NO DESIGN FINDINGS（改0／記0／提0／駁回0）。預設切換已實作，最後gates及本機demo切換接續。

| 切片 | 狀態 | 證據 |
| --- | --- | --- |
| 1 契約與環境 | 完成 | 固定環境、原始資料盤點、TS／Python差分與產品契約已驗收 |
| 2 提案／確認垂直切片 | 完成離線驗收 | PydanticAI／Temporal、provider accounting、零模型確認、私有collector與reviewed controller已接線 |
| 3 Web 與完整用例 | 完成 | generated contracts、後端proposal review、features、分享／持久刪除／TTL；production browser67passed／5既有skip |
| 4 等價與切換 | 完成 | 完整gates、獨立review、backup還原演練、原demo migration、primary持久重啟與資料核對通過 |
| 5 模型品質與部署 | 未完成 | 沿用既有Task11–12 gate，本輪無live或deployment驗收 |

### 2026-09-28 實作 checkpoint（不是整體完成）

- 新程式位於 `backend/src/dive_trip`，開發分支 `codex/python-temporal-core`，base `ac21cb2`；既有 Web／ADK runtime 未切換。
- Python domain：requirements／catalog／budget／proposal／locked entries／stable-ID diff／agent partial patch。`tests/test_domain_parity.py` 直接呼叫現行 TypeScript proposal oracle 比對，不把新實作當自己的預期值。
- PostgreSQL repository 使用 psycopg 明確交易，沿用不可變 SQL migration 001–013 與既有資料契約。從零設計仍採 PostgreSQL 約束、row lock、receipt 唯一鍵與交易內重驗；此階段不加入 ORM identity map，因用例主要依賴多表交易與條件 SQL，ORM 不消除這些規則。代價是手寫 SQL／row mapping；若 domain 成為大量聚合載入或關聯查詢，重新評估 ORM。
- 所有 DB 測試由 fixture 建立唯一 Docker container＋schema，不接受外部 DB URL／環境檔；只清理由當次 fixture 建立的資源。尚未讀寫原 retained DB。
- 單獨命令：`uv run --project backend pytest backend/tests/test_trip_transactions.py -q` → 4 passed（首輪）；`uv run --project backend pytest backend/tests/test_http.py -q` → 2 passed；`uv run --project backend pytest backend/tests/test_answers.py -q` → 10 passed。後續新增案例以最後完整命令為準。
- Temporal：`uv run --project backend pytest backend/tests/test_temporal_contract.py -q` → 1 passed，實際 history 確認只有一次 model activity、retry maximum_attempts=1；同 process 更換 worker，不是 OS process crash／外部 provider ambiguous outcome 的完整驗收。
- 全部 backend suite 曾為 57 passed／1 failed：Temporal dev server 未於 SDK 固定 5 秒內啟動。相同單案其後 1 passed；不能拼湊成全套通過。當時主機 load average 60.58／94.33／64.94，尚未證實根因，完整 suite 仍待重跑。
- 同一完整命令第二輪 `uv run --project backend pytest backend/tests -q --tb=short` → 60 passed（26.33 秒）；其後繼續新增 quota 與反例。這是當時的新 backend checkpoint，尚非全產品等價 gate。
- 新增 migration 014 的 Temporal executor、model dispatch journal 與有序 tool calls；001–013 不改。舊 runs 預設保持 `adk`，新執行標成 `temporal-v1`；新 executor 不接續舊 runs。切換仍要求單一 runtime writer，不能把 additive migration 當雙 runtime 並寫的授權。
- 後續完整 backend 命令 `uv run --project backend pytest backend/tests -q --tb=short` → 89 passed（8.79 秒），包括新的產品 Temporal workflow、啟動 ACK 遺失仍只建一個 workflow、worker 更換後讀取已提交 receipt、並行確認只建一版、validation mutation 與取消 fence。此結果在新增 provider accounting 模組之前；不是新增模組或原 Node／browser gate 的通過證據。
- Product workflow 的測試使用固定 FunctionModel scenario，沒有 network fallback。同 process 停／啟 worker 的 history 驗證 model activity 兩次、全部 activity 最大嘗試一次；OS process crash、provider ambiguous outcome、SSE disconnect 與完整 Web 接線仍須後續驗收。
- 私有 accounting 的 provider identity、usage schema 與 reference cost 已移植；`test_provider_accounting.py` → 10 passed，使用實際 TypeScript cost function 作跨語言對照。價基保持既有 pinned risk accounting，不把移植當重新查價或帳單證明。Admission／usage callbacks 與 Temporal 模型 activity 尚未整合。
- 加入 provider admission、不可變 call-start／usage、unknown 保守 settlement 及零模型 resume 後，同一完整 backend 命令 → **109 passed（33.98 秒）**；strict mypy → **44 source files 無錯誤**，Ruff → **All checks passed**。Resume 測試含模型7次與日預算耗盡後完成確認、policy disabled 全部回滾，不另建 resume executor lease。這些交易尚未接到真／synthetic provider 的 Temporal 模型 transport。
- Fresh design-review 檢查 domain／compiler／手動交易／HTTP：2 findings，改 2／記 0／提 0／駁回 0，唯讀複查兩項均解除。修正為 `application/trips.py` 在同一 transaction 協調 identity／planning 公開 gate；`trips/transactions.py` 不查其他模組的私有 table。新提案只用完整 persisted catalog 重建，缺 catalog 拒絕；不從提案前後資料補值。舊資料例外須明確識別與唯讀策略，不能混入新寫入。
- 第二位 fresh design-review 檢查執行／確認切片：1 finding，改 1／記 0／提 0／駁回 0，唯讀複查解除。新確認已無跨 transaction 的 ADK resume executor，因此移除其新建 `running`＋60 秒 lease 步驟；同一交易直接 `awaiting_confirmation`→`succeeded`，保留 owner／trip TTL、版本與 proposal 驗證。模型執行的 start lease 仍用來拒絕晚到結果。`test_confirmation_commits_without_a_new_executor_lease` 用隔離 DB trigger 觀察中間 UPDATE；執行／確認 affected command 共 9 passed（7.45 秒）。
- 模組間公開入口為 `public.py`（domain／gate）與 `transactions.py`（接受 caller-owned connection）；application 持有 commit 邊界。SQL 仍由資料所屬模組執行，domain 入口不隱含開 DB。
- Quota 的 global gate 仍符合全服務 concurrency=3、跨午夜與跨 bucket 原子 admission；從零設計無須在已序列化的全域 gate 後再取得 day／IP／session bucket row locks，新實作移除冗餘鎖與空 bucket 寫入，保留舊表／歷史。只有已核對所有 writer 都先取 global gate 的單 writer runtime 才可切換；若日後分片／去除 global gate，須重設計 lock ordering 與並行測試。
- 後續 checkpoint：完整 backend command → **114 passed（58.42秒）**，再加入指定工具參數拒絕結算與原始 invocation deadline → **119 passed（26.62秒）**。固定 Gemini／OpenRouter／Cloudflare synthetic transport 全程無網路；private usage 保存失敗不執行工具並保留全額，取消／逾時／缺 completed activity 證據亦保留全額。只有當次 model activity 回報指定拒絕、保存 hook 完成且交易內證據／期限完整，才可 reference-cost settlement。
- 第三位 fresh design-review 檢查 admission／accounting／failure settlement：**NO DESIGN FINDINGS**，改0／記0／提0／駁回0；有序執行 journal 與財務 ledger 分工、provider capability 分離、零模型 resume、global gate、Temporal activity terminal marker 均逐項核對。非 whole migration review，也非正確性證明。
- HTTP 提案／確認／重播、owner 與 private event 拒絕接上後，完整 backend command → **122 passed（26.70秒）**。額外以真正 `@ag-ui/client` 讀 SSE 發現確認 receipt 前缺少新的 RUN_STARTED；consumer test 先1failed／2passed，補上交易內 lifecycle 後3passed（6.11秒）。確認仍沒有 resume model lease，且模型步數保持2。
- 持久刪除新增 migration015，使用者已選新D7語意。tombstone先封鎖存取／模型寫入，持久job控制清理；start/delete共用無產品row lock的有界outbound RPC鎖，避免在途start晚於清除。清除前拒絕archival，delete後確認describe/history不可讀，才清產品資料；不將Temporal非原子RPC當同庫transaction。ACK遺失可用同job續作，unknown quota receipt保留。
- 分享保存明列脫敏projection；historical catalog不相符時不帶封存原文／來源。preview hash、token hash、20筆上限、owner／trip expiry、撤銷與固定快照測試已接HTTP。
- 完整 backend command → **128 passed（60.71秒）**，log `/tmp/dive-trip-backend-checkpoint-9.log`；在後續demo、cursor／receipt保留修正之前。其後affected HTTP＋deletion命令 → **8passed（7.52秒）**，log `/tmp/dive-trip-review-tests.log`；不將局部結果拼成新全套數字。Node `pnpm typecheck`及新Web檔案ESLint通過；尚未build/browser。
- 第四位fresh design-review指出單run查詢重建全history及完成刪除receipt缺保留期限。已改為run_id＋after_sequence投影查詢，完成receipt只保留至owner過期／不存在，pending不受TTL清除；唯讀複查兩項均解除，改2／記0／提0／駁回0。舊lifecycle invocation ID原樣讀取，舊run拒絕新resume；受保護原始歷史拒絕purge，非保護legacy demo由退役storage adapter清理。
- 已生成`src/contracts/generated.ts`，frontend domain types改為re-export；freshness gate保留。新proxy只轉發origin／cookie／content-type／accept，保留stream取消與response set-cookie；權威／body上限／abort／public share四項測試通過。Web typecheck及production build通過。
- OS程序故障命令`pytest backend/tests/test_worker_process.py -q` → 2 passed（42.86秒）：kill當次worker後在離線時提交確認，再啟新process恢復receipt，模型steps維持2；背景durable delete也完成。migration runner接上原checksum ledger、未知migration拒絕與startup readonly檢查後，backend checkpoint11 → 134 passed（136.08秒）。後續fixture與retention修改另行驗證；該輪Node parity不當固定工具鏈的最終證據。
- Python browser launcher只接受唯一Compose project、當次e2e schema與loopback；不讀env檔，API／worker分開OS process。Node舊Homebrew路徑在本輪消失，已依下載授權取得官方26.8.1並核對SHASUMS；驗證使用獨立`/tmp/dive-trip-node-toolchain/node-v26.8.1-darwin-arm64/bin`，沒有改全域Node。Docker目前預設colima；fixture／launcher會捕捉context並固定命令，避免中途查到另一engine。
- 真browser抓到AG-UI client會送`protocolVersion:"1.0"`，新API已明確接收固定版本，HTTP regression帶同欄位。原fixture自然語句已移植；聊天9項先全過。完整production browser首輪62passed／1failed／5skip，失敗是前案route callback尚未收尾；加`unrouteAll({behavior:'wait'})`後完整重跑 → **63 passed／5既有skip（1.3分鐘）**，log `/tmp/dive-trip-python-browser-all-2.log`。命令：`DOCKER_CONTEXT=colima COMPOSE_PROJECT_NAME=dive-trip-python-web-20260928-a E2E_PYTHON=1 E2E_PRODUCTION=1 pnpm exec playwright test --max-failures=3`，PATH使用上述固定Node。沒有放寬test deadline或忽略callback錯誤。
- 原資料庫唯讀盤點於desktop-linux context進行，READ ONLY／REPEATABLE READ只查metadata與count；原容器開啟後停回，沒有套migration或改rows。完整私有inventory另存ignored artifacts；demo在001–013、live仍001–011，不能套同一升級假設。詳細數字與查核指令只記local日誌。
- 新TTL清理共用durable deletion intent，過期owner不阻止已授權purge；quota沿用30天詳細receipt／90天去識別化總額、unknown保守計數。加入TTL反例後checkpoint12為137passed／1failed，完成job沿用retry時間造成receipt延後清理；完成時改為立即排保留檢查，affected5passed後完整checkpoint13 → **138passed（116.54秒）**，log `/tmp/dive-trip-backend-checkpoint-13.log`，固定獨立Node26.8.1＋Docker colima；strict mypy61files、Ruff與Web typecheck通過。
- Legacy demo仍須履行原本刪除／TTL契約；從零設計採窄的退役storage erasure adapter，不恢復ADK agent。固定schema-v1、原SDK鎖與同庫最終transaction保留，因歷史儲存格式及晚到舊worker防護仍存在；原始live／evaluation schema在cleanup constructor前拒絕，未知schema與孤兒sessions/events保護，不因migration擅自清原始歷史。實際ADK2.1 SDK在隔離schema產生session/event，Python adapter驗鎖衝突、版本拒絕、原子清除及orphan保護；affected7passed（8.10秒），全套與獨立複核接續。
- 第五位fresh design-review核對bootstrap／程序生命週期、migration runner、proxy與share API：**NO DESIGN FINDINGS**，改0／記0／提0／駁回0；retention業務未涵蓋，不代替whole migration review。
- 第六位fresh design-review核對retention／legacy erasure：改1／記0／提0／駁回0，複查解除。到期資格、產品表、排序／limit及row lock由application擁有，legacy adapter只提供ADK orphan保護predicate與固定storage清除。affected7passed（6.66秒）。
- Proposal diff與knownDeltaMinor改由後端以persisted base／draft計算；Web只呈現generated ProposalReview，features/workbench與features/sharing搬移完成，共用API及格式化移至lib。歷史replay v1不改寫，讀投影才補review；新projection必須與bound base／draft一致。HTTP affected9passed、replay／proxy63passed；Node完整unit **3027passed**，typecheck／lint／production build通過。
- Checkpoint14完整backend **138passed／2failed**：TTL單次sweep假設同步刪除，及OS worker刪除20秒期限碰到Temporal close-task ACK預設30秒。核對[固定server版本原始碼](https://github.com/temporalio/temporal/blob/v1.32.0/service/history/transfer_queue_task_executor_base.go#L240-L246)後，只縮短隔離測試server的ACK更新間隔至1秒，不停用close-task保護；測試改驗pending→deleted，原20秒deadline保持。新增ACK成功但execution／history仍可讀的反例，不能提早清產品內容。
- 修正後完整backend checkpoint15 **141passed（50.94秒）**，log `/tmp/dive-trip-backend-checkpoint-15.log`；完整production browser **63passed／5既有skip（1.2分鐘）**，log `/tmp/dive-trip-python-browser-features.log`。命令與固定PATH／Docker context同前。此checkpoint在新增native SDK provider transport之前。
- Native SDK離線切片：固定MockTransport驗三provider request、raw usage／cost、429／503不重試、缺用量及ReadError保守保留全額。Affected27passed（7.67秒），完整checkpoint16 **168passed（77.09秒）**。第七位fresh review提出OpenRouter payload重組與CF舊envelope bridge兩項，已改用原生支援並複查解除；改2／記0／提0／駁回0。不是live入口／品質通過證據。
- PostgreSQL明列loopback authority、placeholder password／`/dev/null` passfile、TLS／GSS與timeout；拒絕PGSERVICE／PGSERVICEFILE。空service參數仍觸發libpq lookup，故在IO前拒絕；8項DBconfig反例通過。
- migration016綁定Temporal cluster／namespace UUID；首次已有execution而無binding拒絕，SQLite重啟同identity可用，換空server拒絕。`db:migrate:python`與`dev:python`分離，serve不自動遷移；API／worker／Web共用supervisor，依Web→API→worker→Temporal停止，demo DB＋SQLite保留。
- 第八位fresh review檢查persistent launcher／binding／DBconfig：改1／記0／提0／駁回0；serve改為必填已安裝`--temporal-binary`，在DB／SQLite IO前驗CLI1.9.1／server1.32.0／UI2.54.1，不再隱式下載，複查解除。從零仍採本機CLI＋SQLite，因尚無部署；provisioning與runtime分離，SDK／CLI升級須重跑持久重啟驗收。
- 完整`pnpm test:backend` checkpoint17 **178passed（119.59秒）**，log `/tmp/dive-trip-backend-checkpoint-17.log`；shared supervisor後production browser完整 **63passed／5既有skip（2.7分鐘）**，log `/tmp/dive-trip-python-browser-stack.log`。該backend命令在migration017之前。
- `uv run --frozen --no-sync --project backend python backend/tests/local_launcher_probe.py --temporal-binary <已驗CLI路徑>`在當次owned PostgreSQL／SQLite兩輪完整啟停：原提案重播不變、確認version2、model_steps2；修binary後再次整輪通過，log `/tmp/dive-trip-local-restart-probe-2.log`。沒有遷移原demo／live。
- migration017以產品execution作持久outbox，保存start／decision delivery ACK與下次重試時間，worker bounded sweep送同workflow ID／無payload wake-up，不重試模型invocation。新增commit後未RPC／未signal、ACK遺失、過期start不啟模型反例；affected delivery＋Temporal planning＋OS worker命令 **7passed（34.42秒）**，log `/tmp/dive-trip-delivery-tests.log`。Strict mypy69files通過。第九位fresh review改1：decision ACK狀態轉移移回planning.transactions，application只持交易與協調。
- Outbox第九位review的ACK所有權修正已複查解除；取消intent／ACK、同步DB drain、WAIT_CANCELLATION_COMPLETED後續設計複查NO DESIGN FINDINGS。`run_db`保留task至DB收尾後重拋取消，outbound lock也歸還取消時已取得的connection。原to_thread mutation為2failed／1passed，兩種取消測試均攔下提早返回，log `/tmp/dive-trip-db-drain-mutation.log`。
- checkpoint18為182passed／2failed／1teardown error（worker啟動與Docker stop逾時，當時host load213.45，根因未證實）；不放寬deadline。Worker focused2passed後，完整checkpoint19 **187passed（134.08秒）**，log `/tmp/dive-trip-backend-checkpoint-19.log`，不拼湊第18輪。
- 獨立正確性review修2項：ASGI在StreamingResponse前收斷線並取消／fence已commit start；query及新start交易回收已ACK但expired的temporal-v1 run，保存失敗投影和cancel intent，provider unknown全額保留。Affected24passed（21.94秒）；複查新增parent取消落在command已完成／wrapper未取結果的窗口，已補shield fence，focused6passed（9.12秒）。修正後browser整輪 **63passed／5既有skip（1.9分鐘）**，log `/tmp/dive-trip-python-browser-disconnect.log`。Backend完整重跑另記，不將focused結果加總。
- 接續：server-only真模型能力／完整歷史與新collector接線、剩餘故障與整體review，最後才切換Web default。新刪除頁及browser測試暫接舊`ok:true`／新status的分支須在切換退役舊入口時一起移除，不長期保留雙runtime。
- 正確性review三項修正複查解除後，完整checkpoint20 **193passed（74.56秒）**，log `/tmp/dive-trip-backend-checkpoint-20.log`。
- 新私有v3 accounting projection保留unknown、原始provider／owner／reservation綁定與超額拒絕，舊v1/v2 auditor不變。JSON往返最初3項失敗：optional token欄位被dump為null但strict input拒絕；改為省略未提供欄位，明示null仍拒絕。Affected21passed（8.01秒）。
- migration018由首個bound activity保存實際Temporal execution Run ID，後續worker與native evidence均比較pin；collector有界讀閉合history，對scheduled／started／terminal、attempt1、DB call／step順序，拒絕chain或不同execution。三provider真SDK＋MockTransport的成功／未知各一案，含retry／identity／missing-call／event-sequence／未閉合history mutation。完整`pnpm test:backend` checkpoint21 **204passed（69.41秒）**，log `/tmp/dive-trip-backend-checkpoint-21.log`。不是live generation或worker drain授權。
- 新證據切片fresh design-review **NO DESIGN FINDINGS**（改0／記0／提0／駁回0）；execution pin、跨服務snapshot界線與SDK名稱補入上方盤點。獨立正確性review改2：獨立讀quota reservation inventory防止orphan帳本被join漏掉；對已started但call-start前的確定性拒絕，保存固定native `ModelDispatchNotStarted` failure，與未知／取消／commit錯誤區分；此marker若仍有call一樣拒絕。兩項唯讀複查解除。
- Extra-ledger regression在修前確實`DID NOT RAISE`（`/tmp/dive-trip-extra-ledger-before.log`），修後通過。新增三provider原生activity dispatch前deadline拒絕，零transport／零call但unknown仍保留50；第一輪affected20passed／1Temporal server固定5秒啟動逾時，不算通過。未改deadline，再次整輪affected **21passed（16.11秒）**（`/tmp/dive-trip-evidence-review-fixes-2.log`）。完整checkpoint22接續重驗，不能把checkpoint21的204項當作修後全套證據。
- Source manifest納入`backend/src`、pyproject／uv.lock／Python pin，排除venv與pycache；23項unit通過，log `/tmp/dive-trip-python-source-tests.log`。實際`node --input-type=module`呼叫`readCloudflareSourceManifest()`讀到335檔，其中76個backend檔；此為來源邊界，非hermetic installed-runtime證明。
- 修正兩項private evidence findings後，完整checkpoint22 **208passed（76.16秒）**，log `/tmp/dive-trip-backend-checkpoint-22.log`。其後新增receipt-only worker與awaiting native checkpoint，affected31passed（36.36秒）；模型工具清單對帳與mutation正接續，不沿用208作這些新變更的整批通過。
- Read-only control-plane盤點：既有`beforeDispatch/checkDispatch`位於每次`POST /agent`（start／resume），不是每個model call。重用TS原始carry／claim／review／lease controller及產品`RecordedEvaluationV2/ReplayBundle`；runtime ports／private UsageAudit／drain必須換Python／Temporal，新私有usage v3不需要將產品report一律升版。此為接線邊界，不是舊grant或新live授權。

- 完整 checkpoint23 **209passed（83.05秒）**，log `/tmp/dive-trip-backend-checkpoint-23.log`。先前一次 native-tools affected 為30pass／1個 EVIDENCE_INVALID，原因未證實；safe ValidationError diagnostic 的單案通過不能當根因證據。
- Waiting／tool inventory correctness review再改2並獨立複查解除：propose_changes 的completed=false/result=NULL不得通過成功證據；已commit proposal後activity失敗、workflow recovery回到等待的原生history應可查核。修前各一個反例失敗，修後整批32passed（26.58秒），log `/tmp/dive-trip-waiting-review-fixes.log`。validate_changes的同型mutation原有DB constraint保護，無需修改。
- AG-UI修正每次request ID與logical run ID的邊界，resume只送確認階段；完整GET replay仍含兩階段。重複start／decision重播第一次保存的phase，不改寫原request ID。實際Python HTTP由既有TS validateAnswerStream／validateAnswerPhase驗證，含前後行程；nativeNode匯入proposal-review的runtime imports補.ts副檔名。最初probe因import解析失敗，不能算契約反例；第二次啟動中已載入新實作，失敗的是舊full-replay assertion，也不標成修前證據。
- 修正後完整`pnpm test:backend` checkpoint24 **210passed（93.59秒）**，log `/tmp/dive-trip-backend-checkpoint-24.log`。其後新增私有product decision evidence與collector UsageAudit：獨立查immutable apply receipt／rejection_version、原版本snapshot、固定事件與native workflow結果，resume比較先前awaiting checkpoint的call／step／tool／native model inventory；不將closed history當physical worker drain。Affected46passed（36.88秒），log `/tmp/dive-trip-decision-evidence-tests-3.log`，strict mypy75files通過，獨立review進行中。此新切片不包含在210項全套結果中。

- 確認查核切片fresh design review：改0／記1／提0／駁回0。私有auditor跨模組SQL已明列為同庫獨立read/audit model例外，限定caller-owned readonly snapshot、不得mutation／settlement或供一般產品查詢；schema／receipt編碼變更須重驗。
- 正確性複查改2：native結果須先strict CommittedDecision解析，拒絕Python boolean==integer混同；UsageAudit.faultObserved沿用catalog-timeout/null契約。完整checkpoint25 **224passed（84.58秒）**，log `/tmp/dive-trip-backend-checkpoint-25.log`，含三provider接受／拒絕、immutable receipt後續版本與native boolean mutation；兩項最後唯讀複查接續。尚未接fault capture／live controller／physical worker drain，未切Web default。

- 確認證據兩項correctness findings最後唯讀複查解除。Web affected replay/source兩檔82passed、typecheck／lint通過；Python strict mypy75files通過。Scope複查：本worktree與primary仍ac21cb2無新commit；second-brain仍89ea9641且有他session改動；參考專案並行前進到72cabcb，未改其檔案。
- migration019保存server-selected catalog-timeout情境；只允許新隔離python_test schema選定，HTTP無欄位，重送不得改fault。Worker由execution讀原值，故障工具回固定不可重試error，不產生items Evidence。私有v3查核DB結果與固定SDK tool activity Binding／call ID／attempt／completed結果，輸出既有catalog-timeout/null；原始歷史不套migration。
- Native fault第一輪affected37passed（78.45秒），log `/tmp/dive-trip-native-fault-tests.log`；含fault參數／boolean retryable／native binding等後續修改的完整checkpoint26 **225passed（104.84秒）**，log `/tmp/dive-trip-backend-checkpoint-26.log`。其後將fault IDs改exact-set排序，避免並行完成順序影響查核，新增雙工具case後focused2passed（5.50秒），log `/tmp/dive-trip-parallel-fault-tests.log`；225不含最後這個新增case。mypy76files通過，fault切片獨立review進行中。
