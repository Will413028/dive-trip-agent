# Release evidence

Release acceptance 尚未通過，沒有 public deployment。Public repository 提供去識別化的離線 regression vectors；可重現的數值與交易邊界不證明真模型品質，也不代表已取得模型、CI 或部署授權。

2026-09-28 已選 [Python／Temporal 核心重構](architecture-refactor.md)：FastAPI／PydanticAI＋Temporal，沿用潛旅產品契約、Next.js／AG-UI；Auth0 與託管遷移不在本次範圍。2026-09-29 已完成離線驗收、原專案預設切換、本機 demo migration及新版 Fixture CI；核心實作已提交並推送。

## 執行交接

本節承接原 Task 1–12 主計畫，為剩餘工作的唯一排序；各項證據在本頁及其連結維護，不新增平行 roadmap。使用者新選核心重構，先完成下列 0，再回到新版真模型品質；託管平台遷移維持暫停。文件本身不攜帶模型或部署授權。

剩餘工作的執行步驟、相依、驗收及 rollback 見 [真模型驗收與公開發布計畫](release-completion-plan.md)；本節維持唯一優先清單，細部進度在該計畫維護。

0. **Python／Temporal 核心重構：已完成本機切換與遠端 Fixture CI。** 產品等價、帳務／歷史、跨程序故障、完整離線gates及獨立review已通過；原demo備份還原演練、migration與持久重啟已驗證。精確範圍見 [核心重構](architecture-refactor.md)。新版CI同SHA完整gate通過，不代表真模型品質。

1. **Fixture 穩定性：新版指定版本完整 gate 已通過。** `44e0ae9` 同次 CI 的唯一 job 與全部 steps success，見 Latest checkpoint；舊本機逾時根因及跨環境穩定性未證實。Action runtime deprecation 仍待維護升級與重新驗證；後續程式修改須跑 affected checks，不能沿用舊測試數當新 revision 通過。
2. **新版真模型品質（Task 11）：未完成，新的 Python quality campaign 也已停止。** 一般任務指引與新入口完成 exact CI 後，另獲當次 Free-only 30 案有界授權；首案兩次 call 有完整 token 用量，但第二個模型 activity 為 `AGENT_MODEL_RESPONSE` 失敗，invocation 結算成本仍 unknown，按 `UNKNOWN_USAGE_STOP` 停止，其餘 29 案未 dispatch。沒有提案、確認或行程變更，未進入雙審。原 diagnostic、三次 probe 與本次五個 Python claims／完整證據保留。下一步先唯讀及離線判讀固定失敗碼的多個分支，另定後續品質路線；不得重開 claim、回填 unknown 或降低 gate。
3. **獨立版控與遠端 CI：新版基線已完成。** Repository 已公開，`bfaafdc` 的 [fixture job 及全部 steps](https://github.com/Will413028/dive-trip-agent/actions/runs/36610177552) success；公開原始碼與 CI 不代表部署。維持 [public fixture／私有歷史契約](evaluation.md#closed-world-history-integrity)，原始證據仍在 ignored local storage。
4. **公開部署與維運（Task 12）：未完成。** 完成下方 Public release 待填欄位：正式啟動、public URL、可信 ingress/proxy/IP、secret／預算設定、清理排程／告警、備份還原、kill-switch／rollback，取得部署授權後才開放。來源真實性、價格有效期、素材授權及 hosted runtime 須另驗，不能以本機腳本或景點座標查核代替。
5. **新版真模型展示（Task 12）：未完成。** 沿用同次有界驗收證據，不為影片額外發送，不把 fixture／舊 replay 改標 live。維持一般規劃、鎖住宿但預算不足、查詢失敗／費用待確認三組 demo；重設只影響目前展示 session。案例頁說明本人貢獻、系統界線、示範資料、架構、測試與失敗處理，影片不取代公開 demo。

**已建立的基礎與依賴**：M1（Task 1–3）toolchain、catalog、精確費用與 domain／patch／鎖定；M2（4–5）PostgreSQL、匿名 ownership、完整版本／冪等／復原；M3（6–7）工作台、ADK confirmation／AG-UI、持久化接續；M4（8–9）三種 provider adapter、有界模型與 quota admission；M5（10）分享／撤銷／TTL／有界 retention；M6（11–12）資料、品質、展示與發布。順序仍為 M1→M2→M3→M4→M5→M6；基礎已實作不代表所有 hosted 操作或真模型品質已通過。

現行規則、strict schemas、交易及 runtime 位於 `backend/src/dive_trip/`；`src/contracts/` 保存生成型別與公開事件驗證，`src/features/`／`src/app/` 負責呈現及薄 proxy。既有 `src/domain/`／`src/server/`／`src/agent/` 保留離線差分 oracle 與歷史查核，不是產品寫入入口。開工讀 [AGENTS.md](../AGENTS.md) 與受影響契約；離線回歸用獨立 Compose project，不清歷史資料、不加 timeout 或降門檻換綠燈。

## 產品驗收矩陣

以下承接原設計 A1–A14，描述應觀察的行為；通過範圍以本頁指定 revision／實際 evidence 為準。操作契約見 [README](../README.md#產品與互動契約)。

| ID | 情境與必要結果 | 原 Task |
| --- | --- | --- |
| A1 | 模糊需求只收必要條件，產生可操作方案，不強迫無關資料 | 3、6、7、8、11 |
| A2 | 鎖住宿後降預算，住宿／引用價格不改，無解時解釋衝突 | 3、6、7、8、11 |
| A3 | 第二天下午留白，只改受影響項並列出連帶差異，確認前原行程不變 | 3、6、7、8、11 |
| A4 | 兩人改四人，依人／房／固定費用重算，容量衝突明示 | 2、3、6、11 |
| A5 | 缺費用顯示已知小計＋待確認，不能宣稱預算達標 | 2、3、6、11 |
| A6 | 行程先更新後，舊提案拒絕套用並要求重算 | 5、6、7、9 |
| A7 | 套用後斷線重送只建一版，回傳既有結果 | 5、6、7、9 |
| A8 | 復原時條件、鎖定、活動、地圖與費用一致還原 | 5、6、7、9 |
| A9 | 查詢／模型逾時保留行程，明示錯誤及符合授權／停止政策的重試入口；live 停止不授權自動重試 | 6、7、8、11 |
| A10 | 刷新恢復最後保存狀態，未完成執行不偽裝成功 | 6、7、8、11 |
| A11 | 分享為脫敏唯讀快照，撤銷後不可讀、不可反查私人對話 | 4、6、10、12 |
| A12 | 其他 session 即使得知 tripId，讀寫都拒絕且不洩內容 | 4、6、10、12 |
| A13 | 外部惡意內容不能突破工具 allowlist、鎖定與寫入確認 | 3、8、9、11、12 |
| A14 | 用量耗盡停止新模型執行，已有行程仍可讀取／刪除 | 3、8、9、11、12 |

Domain unit tests 驗費用與規則；真 PostgreSQL integration tests 驗交易、並行與冪等；固定模型 browser E2E 驗互動。真模型的理解、任務完成率、延遲、工具次數、成本及內容 review 另驗：十情境為模糊需求、非潛水同行、降預算鎖住宿、下午留白、改人數、未知費用、日期未定、來源注入、查詢逾時、無法滿足條件。Fixture grader／domain oracle 及 synthetic transport 不冒充模型表現。

## Latest checkpoint

### 2026-09-30：新 Python quality campaign 首案失敗，完整證據保留

`44e0ae9f9d6d050140d4a7298655244db6339092` 的 [Fixture CI run 36672253529](https://github.com/Will413028/dive-trip-agent/actions/runs/36672253529) 唯一 job `109749572996` 與全部 steps success，包含 integration、backend、production build 及桌面／手機 E2E。一般任務指引、完整 12 scopes carry 與新固定 `cloudflare-python-quality` 入口已完成離線驗證及獨立 design／correctness review；不是模型品質通過。

當次新授權為 Workers AI Free-only、固定 Gemma 4、合成 30 案／39 invocations／210 model calls，先兩案雙審。當下 Workers Free Active、139.42／10,000 Neurons 與完整舊歷史雙輪 preflight 通過後，只執行首案 `unknown-cost`。1 invocation／2 model calls 的 token evidence 都已保存；第一步完成 `calculate_budget`，第二步 native activity 失敗，固定碼為 `AGENT_MODEL_RESPONSE`。未產生 AcceptedAnswer 或提案、沒有 resume，內容與版本保持不變。Invocation 的 `actual_cost_micros=null`、保守 reservation 保留，整批 `UNKNOWN_USAGE_STOP`；29 案 skipped，未建立兩案 preflight review，品質 gate=false。匯出完整與成本可知分別判定。

本輪沒有自動重送。Owned worker 已收尾，永久 claim、report／replay、隔離 PostgreSQL 及 Temporal SQLite 保留。事後完整舊 12 scopes 雙輪 audit 一致；本次雙輪比對 22 表 raw rows／fingerprint、bounded artifacts／digests、正式 replay schema／phase、實際 execution 與來源相符。保留 stack location 對照當次 source，將失敗定位於 `agent_runtime.py:340` 的 parts guard；原始 parts 未保存，不能區分空、純非工具或混合 parts。一般指引效果仍未證明，新的失敗結算不回填。

使用者選定先補固定 response 分類，當次離線實作及驗證見 [P5](release-completion-plan.md#p5-task-11-真模型品質驗收)，代碼邊界見 [Failure diagnosis](evaluation-review.md#failure-diagnosis)。`29cb24e` 的 [完整來源 CI](https://github.com/Will413028/dive-trip-agent/actions/runs/36675629436) 唯一 job 與全部 steps success。本輪未再讀模型憑證或 dispatch；新分類不回填舊 history，品質 gate 仍 false。停止後 dashboard 當日 Neurons 164.74／10,000，是 account 用量，不解除未知結算。

使用者後續選定準備 `cloudflare-probe-4` 單案診斷入口；完整 13 scopes carry、獨立永久 claim、1 invocation／7 calls 上限已實作，3480 unit、632 affected、21 integration／1 live skip 與靜態檢查通過，design／correctness review 完成。`0b9ec5c` 的 [完整來源 CI](https://github.com/Will413028/dive-trip-agent/actions/runs/36679415004) 唯一 job `109771388122` 與全部 steps success；後續已取得當次單案授權並執行：1 invocation／2 calls 後按 `UNKNOWN_USAGE_STOP` 停止，固定分類 `AGENT_MODEL_RESPONSE_MIXED_PARTS`；兩筆 call tokens 已知、invocation 成本 null，未重試、品質未通過。停止後新證據與既有 13 scopes 唯讀查核通過，原始證據保留且 claim 已消耗。詳細步驟見 [新單案 response 診斷入口](release-completion-plan.md#新單案-response-診斷入口)。

依使用者指示先確認回覆再定修正，`bc9446a` 補固定 mixed 種類診斷，仍全部拒絕、不保存原值；SDK synthetic wire及Temporal／隔離DB同次48 tests、Ruff／strict mypy通過，泛碼mutation4 failed／4 passed。[完整來源CI 36685444563](https://github.com/Will413028/dive-trip-agent/actions/runs/36685444563) 的exact SHA、唯一job `109790117325` 及全部steps success；本輪沒有真模型呼叫，probe-4舊泛碼不回填。後續 `2f8d77c` 已準備probe-5入口及14 scopes carry：3588 unit、718 affected、22 integration／1 live skip與靜態檢查通過；design無findings，correctness漏列profiles已修並經mutation與實際inventory dry驗證。其 [完整來源CI 36689700528](https://github.com/Will413028/dive-trip-agent/actions/runs/36689700528) exact SHA、唯一job `109803714994` 及全部steps success。probe-5後續取得當次單案授權並執行：1 invocation／2 calls後UNKNOWN_USAGE_STOP，原生固定分類MIXED_TEXT，確認工具與TextPart混合；2704 call tokens已知、invocation成本null，未重試。完整新證據及既有14 scopes查核一致，claim已消耗、原始DB／Temporal／report／replay保留；無提案或版本變更、品質gate仍false。後續依使用者選定完成離線TextPart投影修正：有效tool＋text及final_answer＋text可經原candidate驗證完成，正文／response metadata不進後續messages、原始Temporal payload或public events；ThinkingPart、未知種類及純文字仍拒絕。59 affected tests、Ruff／strict mypy通過，兩種projection移除mutation各轉紅；獨立design無findings，privacy P2的base64盲點已修並複核無新findings。exact來源CI待完成，不由離線結果推定真模型品質已修復。步驟見 [Mixed parts 種類診斷](release-completion-plan.md#mixed-parts-種類診斷離線)。

### 2026-09-30：第三次 Free-only 單案技術結果與任務失敗

`c0c1012` 的 [Fixture CI](https://github.com/Will413028/dive-trip-agent/actions/runs/36664639005) 唯一 job 及全部 steps success。probe-3 另獲當次 1 invocation／7 calls 的明確授權；Workers Free active 與當下用量查核、完整 11 scopes 歷史／來源／quota 雙輪 preflight 通過後才 dispatch。

本案 1 invocation／2 model calls，2,617 tokens，reference cost 288 microdollars；當次用量完整，沒有新增 unknown。兩個原生模型步驟都完成且無參數拒絕，`validate_changes`、`propose_changes` 完成。原始評估預期澄清未知費用，卻得到無實際差異的提案；grade 為 `RUN_NOT_SUCCEEDED`、`UNEXPECTED_SIDE_EFFECT`、`TEXT_REVIEW_REQUIRED`，其中 side-effect 是建立不必要提案，不是套用行程。產品為 `awaiting_confirmation`，未送 resume，版本與內容未變；評估器按 `FAILED_RUN_STOP` 結束，`diagnosticComplete=false`、品質 gate=false。不能宣稱新 kind 診斷已證明模型行為改善，也不回填前兩案原因。

永久 claim／report／replay 與當次 PostgreSQL、Temporal SQLite 保留。事後 owned lease 下兩輪唯讀 audit 核對完整原始 22 表、report／replay digest、execution binding、來源及舊歷史，全部一致；owned worker 已收尾。歷史 unknown 仍原樣保留，整體 accountingComplete=false。私有實體及原始資料不搬入公開 fixture。來源命令為新單案 live test；單案停止不重試，後續指引修正仍須新 revision checks 與新的有界實驗授權。

### 2026-09-30 Offline change kind diagnostic

後續 exact SHA `b00e9701285e08865911aabb09b5e08a793fb4f1` 的 [Fixture CI run 36661012219](https://github.com/Will413028/dive-trip-agent/actions/runs/36661012219) 已完成：唯一 job `lint-typecheck-unit-integration-build-e2e` 及 27 steps 均 success。這是該 revision 的離線驗證，不是新的 live 執行或品質通過。

私有診斷新增 `kind_missing`／`kind_invalid`，只依 `validate_changes` 變更項目的 Pydantic discriminator 錯誤型別與位置分類，不保存原值或錯誤正文；其他分類與舊證據維持原樣。合成契約及 evaluation generation 測試同次 **22 passed**，Ruff、strict mypy **85 source files** 通過；將新分類改回泛碼的反轉驗證為 **4 failed／17 passed**。本輪沒有真模型呼叫，也沒有完整 backend／CI 或品質通過結論。下一次實驗可沿用單案 `unknown-cost`、1 invocation／7 calls 的診斷範圍，但須另建完整歷史 carry 與永久 claim，重新確認 Free 狀態並取得當次有界授權後才可 dispatch。

2026-09-29 Python／Temporal重構及後續 timeout 分類修正在 `f171ac6` 的 [新版Fixture CI](https://github.com/Will413028/dive-trip-agent/actions/runs/36477194214) 通過：唯一job及所有steps success，Web unit **3036 passed／103 files**、integration **388 passed／11 live skipped**、backend **266 passed**、production E2E **67 passed／5 skipped**；typecheck、lint、mypy、contracts、production build及disposable DB清理全部成功。這是同一CI run，不將首兩次Python安裝前失敗的run當測試結果。獨立設計／正確性複查已收口，原專案預設與demo migration020已切換，既有資料及受保護歷史指紋不變。本機命令、耗時、logs與重啟證據見 [最終驗收](architecture-refactor.md#2026-09-29-最終驗收與本機切換)。尚無真模型品質或public deployment驗收。

後續單案 probe 修正於 `09d339b` 的 [Fixture CI](https://github.com/Will413028/dive-trip-agent/actions/runs/36488396679) 通過：唯一 job 及全部 steps success，Web unit **3121 passed／106 files**、integration **389 passed／12 live skipped**、backend **267 passed**、production E2E **67 passed／5 skipped**；lint、typecheck、backend 靜態檢查、build 與 disposable DB 清理均成功。這一 run 的 live test 是 skipped；真模型結果另列如下。

### 2026-09-29 Python diagnostic live stop

同一程式來源的離線 fixture、固定原始歷史與 quota 雙輪唯讀查核通過後，按一次性 diagnostic 入口執行。首案 `unknown-cost` 失敗，其餘 29 案未 dispatch；首案兩次模型呼叫中，第一次有完整用量並完成 `validate_changes`，第二次約 30 秒後沒有可結算用量，native model activity 失敗，公開事件為 `AGENT_INTERRUPTED`。整批依 `UNKNOWN_USAGE_STOP` 停止，`evaluationGatePassed=false`；首兩案未完成，沒有 preflight 內容審查或後續案的品質結論。

保留的 Temporal history 有固定 `AGENT_PROVIDER_TIMEOUT` 失敗分類；程式對本地逾時及上游 HTTP 408／504 都使用此代碼。第二次呼叫約 30 秒，但原始 HTTP 狀態與例外未保存，尚不能判定哪一種觸發或上游根因。行程 snapshot 未變，未建立提案或確認；原始受保護歷史及來源在事後重查仍一致。一次性 claim、完整私有報告、保守帳務、隔離 PostgreSQL schema 與 Temporal 儲存已保留；精確身份與 ledger 留在 ignored local storage，不以公開摘要重建或重跑本次結果。

### 2026-09-29 Offline timeout diagnostic follow-up

合成 `MockTransport` 重現 `httpx.ReadTimeout` 經 PydanticAI 包裝後被誤列為 `AGENT_PROVIDER_INVALID_RESPONSE`。後端 SDK 現以固定私有活動失敗碼區分本地 30 秒 deadline、SDK／transport timeout、已觀察到的 HTTP 408／504；只比對例外型別，不保存上游文字。公開錯誤、單次 dispatch、未知用量保守結算、停止規則與 30 秒上限均未改。受影響的 provider／evaluation generation 測試 **29 passed**、Ruff 通過、strict mypy **84 source files** 通過；未執行新的 live 呼叫，當次已停止證據不重新分類。

### 2026-09-29 Free-only one-case probe stop

獨立授權的 `unknown-cost` 技術 probe 以固定上限 **1 invocation／7 model calls** 執行。首個啟動嘗試在 claim 前發現舊 diagnostic 合法 replay sidecar 未納入唯一檔案清單，未送模型；修正並經 `09d339b` 完整 CI 後才建立新 claim。Free 方案查核及完整舊九範圍歷史、來源指紋、quota 的雙輪唯讀 preflight 通過。

實際只送 **1 invocation／4 model calls**，四筆用量均完整，沒有新增 unknown；前三次 `validate_changes` 完成，第四個模型步驟的工具參數被拒。Temporal 固定失敗碼為 `AGENT_TOOL_ARGUMENTS_REJECTED`，公開 run 為 `AGENT_INTERRUPTED`，單案約 **25.1 秒**，停於 `FAILED_RUN_STOP`；`diagnosticComplete=false`、`evaluationGatePassed=false`，不代表模型品質通過。沒有提案或確認，行程版本未變。原始參數值未保存，不能由固定失敗碼判定是哪個欄位或模型選擇的根因。

新 claim、私有報告、22 張表的隔離 PostgreSQL schema 與 Temporal SQLite history 均保留；四筆當次帳務與 provider binding 完整，既有 unknown 仍保守保留。執行後舊歷史與來源重查相符，owned lease 已釋放。不得重送這個已停止的 probe；完整 30 案及獨立內容審查仍缺，新的真模型 dispatch 須另定範圍與授權。

### 2026-09-29 Offline tool argument diagnostic follow-up

Python runtime 新增有界私有工具參數診斷：Pydantic 拒絕時只保留固定工具名、批次內序位、去重後的 issue code 與白名單 path；與 `arguments_rejected` 同交易記入 model step journal，私有 usage evidence 可讀。公開事件、Temporal 固定失敗碼、整批拒絕與帳務結算規則維持原契約。migration021 為 nullable 新欄位，歷史列不回填；前述停止案例沒有原始參數或此新增診斷，不能倒推根因。本次只使用合成資料驗證，沒有新真模型 dispatch。

本機最後同次 `pnpm test:backend` **272 passed**；Ruff、strict mypy（85 個 source files）、`contracts:check` 與 `git diff --check` 通過。整合反例確認同交易保存的診斷不含模型值、任意欄位名或公開事件，既有未知用量結算仍保守。獨立設計複查的兩項發現已修正：安全投影先去重再截斷，並加候選工具序位。執行前核對 `dive_trip_test.workbench_demo` 為 migration020、無活動 writer，完成 ignored local custom dump 並驗證 archive 可讀，才套 migration021；事後 ledger 為 21 筆、欄位為 nullable JSONB，demo model step 為 0 筆。這是本機離線驗證，固定版本遠端 Fixture CI 結果另列。

程式 SHA `a4fc385` 的 [Fixture CI run 36590117428](https://github.com/Will413028/dive-trip-agent/actions/runs/36590117428) 唯一 job 及全部 steps success：**3121 unit／106 files、389 integration／12 live skipped、272 backend、67 production browser／5 skipped**；固定工具鏈、Ruff、mypy、contracts、前端 lint／typecheck、build 與當次 disposable DB 清理也成功。這輪沒有 live 模型測試或品質通過結論。

### 2026-09-30 第二次 Free-only 單案技術 probe（已停止）

本輪授權範圍固定為合成 `unknown-cost`，最多 **1 invocation／7 model calls**，只用 Cloudflare Workers AI Free 額度；不算 Task 11 的 30 案品質通過。新入口 `cloudflare-probe-2` 使用獨立永久 claim，先對帳原九範圍與已停止的第一個 probe、source manifest、quota、owned lease，再讀 generation capability。舊 claim、report、unknown、schema 與 Temporal history 不回填或重試。

程式 `bfaafdc` 的 [Fixture CI run 36610177552](https://github.com/Will413028/dive-trip-agent/actions/runs/36610177552) 唯一 job 與 **27 steps 全 success**：3196 unit／108 files、390 integration／13 live skipped、272 backend、67 production browser／5 skipped；靜態檢查、build 與 CI disposable DB 清理成功。本機受影響 integration 11 passed／1 live skipped；完整本機 integration 曾因 5 秒期限逾時，沒有拿局部重跑冒充整批通過。正式 dispatch 前兩輪唯讀查核第一個 probe 的完整 22 表及 Temporal 歷史，累計 **45 invocations／67 model calls／5 historical unknown receipts**；source manifest、owned lease 與新 claim 空缺查核通過。Cloudflare 帳戶顯示 Workers Free active，dispatch 前今日用量 **801.11／10,000 Neurons**；[官方 Free 規則](https://developers.cloudflare.com/workers-ai/platform/pricing/) 超額會拒絕而非計費。

實際只送 **1 invocation／1 model call**，用量完整（**1313 tokens**、帳本參考成本 **165 micros**），沒有新增 unknown；當次累計變為 **46 invocations／68 model calls**，原有 5 筆 unknown 仍保守保留。第一個 model step 的 `validate_changes` 候選 1 在接受工具前被拒：私有固定診斷為 `invalid_value`、白名單路徑 `changes.*`，不保存原始參數；Temporal 保留 `AGENT_TOOL_ARGUMENTS_REJECTED`，工具完成數為 0。run 失敗並停於 `FAILED_RUN_STOP`，`diagnosticComplete=false`、`evaluationGatePassed=false`；診斷只能定位到變更項目，不能倒推出模型產生的值或根因。Cloudflare 事後 dashboard 為 **816.06／10,000 Neurons**，仍在 Free 額度內。

事後只用合成參數重現同一個固定診斷：`changes` 項目缺 `kind` 與 `kind` 不受支援都會落在 `invalid_value changes.*`；空的 requirements patch 則有更深的路徑。因此可把離線檢查聚焦在 change kind 辨識，仍無法判定這次模型實際輸出哪一種，也不能回填舊證據。

新永久 claim、私有 report／replay、隔離 PostgreSQL schema 與 Temporal SQLite 均保留；事後在 owned lease 下兩輪唯讀重查：舊歷史一致，新 run 的 **22 表完整 row fingerprint**、replay hash、Temporal execution Run ID 與拒絕 marker 均相符，source manifest 未漂移。這個 claim 已消耗，不再重送；完整 30 案與獨立內容審查仍缺。來源／沿用判斷見 [evaluation](evaluation.md#closed-world-history-integrity)。

### 2026-09-27 Historical ADK fixture CI

原始碼 repository 已公開。2026-09-27 第一輪 [Fixture CI](https://github.com/Will413028/dive-trip-agent/actions/runs/36317342675) 在 `2a3d3d5d2db6d13bfad7b7ea77f4f876ccba8d02` 全綠；已核對 run、fixture job 及全部 steps 都為 success，沒有 cancelled 或 failed job。使用標準 Ubuntu 24.04 runner、Node 26.8.1、pnpm 11.2.2 與獨立 disposable PostgreSQL，job 耗時 8 分 58 秒。這不是公開部署或真模型品質驗收。

| 本輪同一 CI run | 結果 | 實際範圍 |
| --- | --- | --- |
| Unit | 3308 passed；47.39 秒 | 104 files，完整 unit 目錄 |
| Integration | 388 passed／11 skipped；317.61 秒 | 41 passed files／11 opt-in live files skipped |
| Production Chromium E2E | 63 passed／5 skipped；1.3 分鐘 | 桌面與 390px viewport，非實體手機 |
| Fixture boundary、lint、strict typecheck、production build | 全部 success | 固定 toolchain、locked dependencies；未啟用模型 |
| Disposable DB teardown 與 post steps | 全部 success | 只清除此 run 的測試容器／volume，未動本機歷史 DB |

Skip 不算 pass：11 項 integration 為真模型 opt-in；5 項 browser 為兩種 opt-in replay 情境各跑兩個 project，加手機錄影一項。獨立 `test:adk` 五項探針及專用 replay suite 不在本次 CI 範圍。另於本機跑 actionlint 與 30 案 domain fixture self-check 通過，後者 `modelCalls:0`、`liveEvidence:false`、`evaluationGatePassed:false`；不混入上述 CI 數量。

本輪沒有修改 source、workflow、timeout 或 assertions。舊失敗所在 `p3-answer-persistence`、`version-store`、`chat`、`release` 測試仍被完整收入並通過；未拼湊選擇性重跑。CI 有非阻擋警告：三個 v4 actions 宣告 Node 20，runner 強制以 Node 24 執行；產品 runtime 仍經驗證為 Node 26.8.1，action runtime 升級留作後續維護，本輪未變更 actions 版本。

### Historical checkpoints

以下保留既有 expanded suite checkpoint；cleanup 的局部驗證另列，不改寫成當時已通過。

| 範圍 | 既有整批 checkpoint | 判讀 |
| --- | --- | --- |
| Unit | 3141 passed | 單元回歸通過，不能替代 integration／browser |
| 整批 unit＋integration | 3519 passed／10 integration timeout／11 live skipped | Integration 部分 378 passed／10 failed；整批未全綠 |
| Production browser | 54 passed／9 failed／5 skipped | 等待提案、版本刷新或回答顯示失敗；不能以 HTTP 200 判成功 |
| Strict typecheck、lint、actionlint、production build | 先前 checkpoint 通過 | 靜態／build 通過不解除執行測試缺口 |
| 新版真模型品質 | 未通過 | 受控 AcceptedAnswer 與 synthetic transport 不等於任務成功 |
| Remote fixture CI | 當時未執行 | 最新完整結果見上方同一 run |
| Public deployment | 未部署 | 無 deployment ID、public URL 或 hosted acceptance |

先前公開文件／source cleanup 完成 **3308 unit、15 affected integration 通過，另 9 live skipped，typecheck／lint 通過**。那次僅驗受影響範圍，沒有完整 integration／build／browser，也未觸發 CI 或部署；後續本頁所列完整 CI 才補上 fixture gate。

先前 2776 項較小範圍通過，以及選擇性重跑的成功，都不能替代最新擴大整批結果。測試 timeout、assertions 與 Agent deadline 未因整理文件而放寬。Storage A/B/A 未顯示穩定 tmpfs 優勢；沒有採用 tmpfs 或降低 durability。主機負載及時間敏感性只是診斷線索，不是全部失敗的已證實根因。

本輪已取得同一版本、原限制下完整 fixture 結果，但舊本機逾時的統一根因仍未證實；再次重現時須分別量測 SQL／lock、native worker 與 browser 階段，不以乾淨環境一次全綠宣稱所有環境穩定。下一個發布阻擋項為新版真模型品質。重現命令與失敗判讀見 [evaluation](evaluation.md#offline-regression-and-diagnostics)。

## Evidence register

| Gate | 狀態 | 證據與缺口 |
| --- | --- | --- |
| 固定 runtime | 已指定版本 | Node 26.8.1、pnpm 11.2.2；hosted runtime 未驗證，見 [toolchain](toolchain.md) |
| 核心回答契約 | 已完成離線接線 | AnswerPlan → compiler → AcceptedAnswer；交易後固定 receipt、零模型 resume、不可變 replay，見 [model adapter](model-adapter.md) |
| 本機展示 | CI 的 production fixture browser 通過 | [Demo 腳本](demo-script.md)；影片／單案 smoke 不作完整品質證明 |
| Fixture CI | Passed at `bfaafdc` | [本輪 Run](https://github.com/Will413028/dive-trip-agent/actions/runs/36610177552) 的唯一 job 及全部 27 steps 成功；範圍與 skip 見上方 |
| Live quality | 未通過；原入口與兩次單案 probe 均已停止 | 原 30 案入口首案新增未知用量；兩次單案 probe 用量已知但工具參數被拒。三個 claim 均已消耗；仍需完整 3×10、獨立任務／內容 review 與已知 usage，見 [evaluation](evaluation.md#coverage-and-acceptance) |
| Public runtime | Blocker | Hosted startup、可信 ingress/proxy/IP、secret loader、budget、kill-switch 未驗收，見 [deployment](deployment.md) |
| Retention operations | Blocker | 有本機有界 cleanup；hosted adapter、supervised schedule、告警與 backlog 證據不足 |
| Backup / restore | Blocker | 未有公開環境 backup policy、restore 演練及刪除／撤銷／成本 reconciliation 證據 |
| 資料及素材 | 有限查核 | 參考地點僅核對名稱／座標；不保證價格、開放、可訂或安全，見 [資料依據](data-sources.md) |

## Live evidence boundary

目前沒有新版真模型品質通過的證據。已記錄的 provider failure 不足以從固定公開錯誤碼判定根因；controlled failure、snapshot 不變或保守結算也不代表任務回答成功。技術完成仍須核對理解、必要澄清、證據選擇、金額語義、DEMO／未知費用揭露與 committed receipt。

Acceptance 要求同一模型、同一 case 版本的三輪各十例；每輪至少八例成功、零 safety failure、全部已知 cost／latency、每案低於 60 秒且最多六次工具。失敗、timeout、取消、skip 留在分母，不能混入 fixture results。Review pending 或 AI review worksheet 不能自動變成 human approval。

原始 claims、reports、replays、usage 與 retained DB 留於 ignored local storage，保留失敗原貌、unknown 和已消耗 claim，不刪除或改寫。Public docs 不包含私人報告的精確識別、帳戶或實際 ledger 成本歷史；去識別化 regression vectors 只用於離線驗證，不可代替本機原始歷史、remaining quota 或新的發送授權。

真模型入口另需明確、有界授權及本機 closed-world history check；不能刪 report／claim、換 schema／IP identity 或清 quota 重新啟動。新的 unknown usage、限流、技術／安全失敗立即停止。Reference budget（例如 US$3）只是保守政策上限，不是實際帳單、免費餘額或付費許可。詳細方法見 [評估審查指南](evaluation-review.md)。

## Public release 待填欄位

未填項均為 pending，不以本機截圖、fixture movie、skip 或其他 repository 的 commit 代替。

| 欄位 | 現值 |
| --- | --- |
| Release commit / immutable artifact | 未指定 release artifact；checkout 身分可由 `git rev-parse HEAD` 取得 |
| CI run URL / fixture job conclusion / steps | [36488396679](https://github.com/Will413028/dive-trip-agent/actions/runs/36488396679)／job `109150793583`：success，全部 steps success；SHA `09d339b` |
| Deployment ID / region / public HTTPS URL | 未部署 |
| Hosting configuration / daily model budget | 公開環境未配置 |
| 新版 model / 完整 campaign / reviewer evidence | 品質未通過；私有歷史不能改標為新版成功 |
| Public smoke / desktop / 390px mobile | 未執行公開環境驗收 |
| Retention schedule / last success / backlog | 未配置、未量測 |
| Backup / restore / RPO / RTO | 未配置、未演練 |
| Kill-switch / rollback | 公開環境未演練 |

完成阻擋項並取得部署授權後，須記錄 fresh-session A1–A14、fixture／live 模式揭露、SSE 中斷、跨 owner 防護、HTTPS cookie／origin、偽造 forwarding headers、分享撤銷／expiry／cache、cleanup、kill-switch 與 rollback。CI 綠燈本身不能推論這些驗收完成。
