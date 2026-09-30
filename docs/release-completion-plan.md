# 真模型驗收與公開發布執行計畫

本計畫細化 [release evidence「執行交接」](release-evidence.md#執行交接) 的剩餘工作。該清單仍是優先順序與專案狀態的唯一主表；本頁保存執行步驟、相依與驗收紀錄。更新日期：2026-09-30。

## 基線與範圍

- Python／FastAPI／PydanticAI＋Temporal 核心重構與本機切換已完成，保留 Next.js／AG-UI 及產品契約。
- `b00e970` 已新增不保存原值的 `kind_missing`／`kind_invalid` 私有診斷；舊證據不回填。
- 原 30 案入口及兩個單案 probe 已停止，claims 與完整證據保留。Task 11 品質驗收及公開部署尚未完成。
- 模型操作維持 Free-only。既有一次性授權已消耗；本 plan 不提供新的模型 dispatch、讀憑證或部署授權。
- Auth0、跨裝置保存及託管平台遷移仍在核心重構範圍之外；公開部署階段另定 hosting 方案。

## 開工對帳

每階段先讀本頁對應步驟及主清單，再核對當下來源與執行證據。

```sh
git status --short
git rev-parse HEAD
git log -5 --oneline
rg -n '執行交接|Latest checkpoint|Public release' docs/release-evidence.md
rg -n 'Coverage and acceptance|Closed-world history integrity' docs/evaluation.md
```

GitHub 操作依適用的本機身份指令逐命令限定帳號。核對 CI 的 exact SHA、每個 job 與 steps；不把 run 層級成功、skip 或舊 revision 結果當新來源驗收。Private 歷史核對使用現行受控 reader、固定 inventory、source manifest 與 owned lease；指紋不符先查差集，不 dispatch。

## 執行順序與相依

| 步驟 | 狀態 | 相依 | 交付 |
| --- | --- | --- | --- |
| P1 最新 Fixture CI | 已完成 | `b00e970` | exact SHA 的完整 CI 證據 |
| P2 新單案診斷入口 | 已完成，CI 全綠 | P1；新入口若改程式需新 CI | 新 carry、永久 claim 政策與離線驗證 |
| P3 單案 live 診斷 | 已執行並保存；任務品質失敗 | P2、當次有界授權、Free／歷史 preflight | 完整 report、usage、診斷與事後 audit |
| P4 依證據修正 | 一般任務指引與 exact CI 完成；效果未證明 | P3 | 必要修正、合成回歸與新 revision gates |
| P5 Task 11 品質驗收 | 新 campaign 首案停止；品質未通過 | 技術流程可用、當次完整 campaign 授權 | 30 案、內容雙審與品質 gate |
| P6 CI Actions runtime 維護 | 待做 | P5 後、公開 release 前 | 升級與完整 Fixture CI |
| P7 部署與維運 | 待做 | P5、P6、P8；另定 hosting 與部署授權 | public artifact、環境與演練證據 |
| P8 資料與素材驗證 | 已完成當次來源盤點 | 可在 CI 等待期間獨立進行 | 來源、價格有效期、授權與揭露 |
| P9 作品展示 | 待做 | P5、P7、P8 | 三組 demo、案例頁與影片 |

P4 不預設模型犯了哪一種錯，也不要求每次 live 後一定修改程式。P8 可提早進行；hosted runtime 的驗證仍在 P7。共用 CI／部署資源一次只觸發一個序列化工作。

## P1 最新 Fixture CI

- [x] 核對 `b00e9701285e08865911aabb09b5e08a793fb4f1` 的 [CI run 36661012219](https://github.com/Will413028/dive-trip-agent/actions/runs/36661012219)。
- [x] 唯一 job `lint-typecheck-unit-integration-build-e2e` 與 27 steps 均 success。
- [x] 區分 fixture 驗收與真模型品質；這個結果不證明 Task 11 通過。

證據命令：`gh run view 36661012219 --repo Will413028/dive-trip-agent --json headSha,status,conclusion,jobs,url`，逐項檢查 job／steps。後续程式變更須取得當次來源的驗證結果。

## P2 新單案診斷入口

- [x] 定義新 scope：固定合成 `unknown-cost`、最多 1 invocation／7 model calls、技術診斷模式、Free-only，品質 gate 固定 false。
- [x] 新增完整歷史 carry，納入原歷史、停止的 Python diagnostic 及兩個 probe：原 reports／replays、完整 retained DB rows、Temporal execution 與固定診斷證據；舊 unknown 保留。
- [x] 定義新永久 claim、server-only capability、閉世界 inventory 及 source manifest；不得沿用已停止入口作重試。
- [x] 驗證缺漏、額外檔案、digest／row 漂移、execution 不符、重複 claim、上限、未授權 dispatch 等反例；公開診斷隔離及七次上限維持既有共同 gates。
- [x] 按影響範圍跑測試與靜態檢查；獨立 design-review 無 findings。
- [x] Commit／push 後核對該程式 SHA 的完整 Fixture CI，再進 P3。

當次實作入口：`evals/cloudflare-probe-3-entry.ts`、`cloudflare-probe-3-campaign.ts`；新增 carry：`cloudflare-python-probe-2-carry.ts`。同次 `pnpm test:unit` **3282 passed／110 files**，`pnpm typecheck`、`pnpm lint` 通過，獨立 design-review 無 findings。`c0c1012` 的 [CI run 36664639005](https://github.com/Will413028/dive-trip-agent/actions/runs/36664639005) 唯一 job 與全部 steps success，包含 integration、backend、production build、桌面／手機 E2E。實際唯讀雙輪查核確認完整 11 scopes 一致；原始 profile／private identities 仍在 ignored local storage。

**驗收**：新入口可離線證明有界、失敗即停、完整承接歷史；合成測試不讀真憑證、不 fallback 網路。公開文件只放方法與去識別化結論。

## P3 單案 live 診斷

- [x] 取得明確的當次 scope 授權；唯讀確認 Workers Free 狀態與當日額度，不能以本機 reference cost 代替 provider 餘額。
- [x] 在 owned lease 下完整雙輪 preflight；核對來源、provider binding、quota 與 claim 政策，再由受控入口讀 generation capability。
- [x] 執行一次固定單案；記錄技術結果、工具完成數、私有固定診斷、逐 call 用量與 terminal 狀態。
- [x] 等 owned worker／SDK／保存 hook 收尾，保存完整 report／replay、PostgreSQL 與 Temporal 證據，執行事後完整 audit。
- [x] 更新 release evidence，分別判定 diagnostic completion、accounting completeness 與 quality gate。

**停止**：新的 unknown、限流、工具參數拒絕、技術或安全失敗立即停止，不自動重送。永久 claim 即使 preflight 失敗仍消耗；失敗、保存不完整或未知 drain 均保留證據。

**驗收**：即使單案成功，也只完成技術診斷。失敗則依固定碼定位可驗證的問題，不由未保存原值推論模型實際輸出。

2026-09-30 probe-3 在 `c0c1012` 執行一次 start、2 次模型呼叫，完整用量已保存，沒有新的 unknown 或參數拒絕。`validate_changes`／`propose_changes` 均完成，但 `unknown-cost` 預期澄清，卻收到無實際差異的提案；原始 grade 包含 `UNEXPECTED_SIDE_EFFECT`，產品停在 `awaiting_confirmation`，評估依 `FAILED_RUN_STOP` 停止，沒有 resume，行程／版本未變。`diagnosticComplete=false`、`evaluationGatePassed=false`；當次用量完整與歷史 accounting completeness（仍有舊 unknown）分別判定。永久 claim、report、replay、PostgreSQL 及 Temporal 證據保留，完整雙輪事後 audit 通過。Free active 已查核，dashboard 今日 Neurons 執行前 113.39／10,000、執行後 139.42／10,000；這是 account 的當下用量，不把差額直接等同本案帳務。

下一步 P4：現行工具 schema 與 validator 在本案一致，沒有證據支持放寬 change kind；模型指引未明訂查詢／澄清不得建提案。已提出一般任務指引、no-op 拒絕與換模型三種選項；未收到方向補充後，先依建議實作可逆的一般任務指引。此案不通過品質，不由未保存原始參數反推模型的意圖。

## P4 依證據修正

- [x] 核對 tool schema、模型可見指引與 validator 是否一致，測試一個可重現假設。
- [x] 若有可證明缺陷，做最小修正與有辨別力的合成回歸；保留 strict validation、batch 整體拒絕、無未知重送及私有資料邊界。
- [x] 檢查所有 consumer，跑 affected checks；大幅修改執行 design-review。
- [x] 記錄修正後仍未驗證的模型效果。若需新 live，比照 P2／P3 另建 scope 與授權；不設無限 probe 迴圈。

**驗收**：離線證據支持修正，且來源對應的 CI 通過。無可證明缺陷時記錄結論與下一個待決假設，禁止猜值、放寬 gate 或回填歷史。

P4 當次實作：`backend/src/dive_trip/application/agent_runtime.py` 的共用 Agent instructions 補上一般任務選擇：查詢既有行程／費用使用 read tools 與本回合 evidence 的 AnswerPlan；未知費用不能推定預算足夠；只對使用者要求的候選修改／比較驗證，不為查詢捏造修改或建立無差異提案。沒有新增 no-op Domain 拒絕或 case-ID 特例，schema、工具／模型上限與 grade 不變。指引遺漏是可觀察事實，但補指引能否改善模型選擇仍是待驗假設，不宣稱根因已證實。既有 strict AnswerPlan、工具契約及 SDK 合成回歸 59 passed，Ruff／strict mypy 通過；Web typecheck／lint 通過。`857133a` 的 CI run `36667675006` 靜態／unit／integration／backend／production build 通過，但兩個案例頁 E2E 還斷言舊 ADK 架構與歷史成功而失敗；已更新該 consumer 至現行 Python／Temporal 與任務失敗證據，後續 `44e0ae9` 的完整 CI 唯一 job 與全部 steps success，結果見 P5。

P9 案例頁已對齊新架構與三個 probe 的實際結果，移除舊 ADK 成功套用為新版的敘述；隔離 fixture stack 的桌面與 390px 手機呈現已檢查。網站尚未公開，影片與正式驗收仍未完成。

## P5 Task 11 真模型品質驗收

新固定 scope `cloudflare-python-quality` 承接第三案在內完整 12 scopes，最多 30 案／39 invocations／210 model calls。新入口、capture／comparator、claim／review 機制已獨立設計及 correctness review，均無 findings。全 unit 3383 passed／112 files、typecheck／lint 通過；隔離 PostgreSQL 的 HTTP／retired collector 邊界 13 passed，新 live test 預設 skip；案例頁 consumer 更新後桌面／手機 4 E2E 通過。`44e0ae9` 的 [完整 CI](https://github.com/Will413028/dive-trip-agent/actions/runs/36672253529) 唯一 job 與全部 steps success。

另獲當次完整上限授權、當下 Free 與完整歷史 preflight 通過後，首案 `unknown-cost` 執行 1 invocation／2 model calls。兩次 token 用量都已保存，第一步完成 calculate_budget，第二步 `AGENT_MODEL_RESPONSE` activity failure；invocation 結算成本 null，保守 reservation 保留，按 `UNKNOWN_USAGE_STOP` 停止。其餘 29 案未 dispatch，沒有提案／確認／行程變更，未進入兩案雙審，品質 gate=false。永久 claim 已消耗，完整 report／replay／DB／Temporal 保留；事後舊歷史及本次 22 表、artifacts／execution／來源雙輪核對相符。新的固定碼有多個分支，尚不能反推原始 response parts 或 call 值。下一步先唯讀／離線釐清可觀測邊界，再決定後續品質路線；不自動建下一個 probe。

使用者選定先補固定 response 分類診斷，未授權新模型呼叫。保留的 stack location 對照 `44e0ae9` 指向 `agent_runtime.py:340` 的 parts guard；只能定位 guard，不能分辨原始 parts。已把既有拒絕分支拆成不保存原值的固定私有代碼，見 [Failure diagnosis](evaluation-review.md#failure-diagnosis)。隔離 PostgreSQL／Temporal 與工具契約同次 **28 passed**；將新代碼在測試 process 內退回舊泛碼的反轉驗證為 **8 failed／20 passed**，未修改原始 source 或歷史。Ruff／strict mypy 通過，公開錯誤、無重送、工具／模型上限及成本結算規則不變。`29cb24e3ae8003a4e7c74491fbb8e7909866a72e` 的 [完整 CI run 36675629436](https://github.com/Will413028/dive-trip-agent/actions/runs/36675629436) 唯一 job `109759850131` 及全部 steps success；這項改動只改善可觀測性，尚未證明模型品質。停止後 dashboard 當日用量 164.74／10,000 Neurons，帳號總額不代替本機未知結算。

- [x] 依 [evaluation](evaluation.md#coverage-and-acceptance) 固定 10 情境 × 3 rounds、fixture／model identity、invocation／model call／額度總上限與停止政策，取得新的完整 campaign 授權。
- [ ] 完成新版入口與歷史 preflight；先執行兩案，依 [review 方法](evaluation-review.md) 做 primary／independent 內容與任務審查，通過既有 gate 才繼續。
- [ ] 每案核對 before／proposal／decision／receipt／after、AcceptedAnswer、native tools、用量與目標完成；pending 不當 passed。
- [ ] 保存原始 report、review receipts、replay、帳務與來源；確認 coverage 與所有 gate，再更新品質結論。

**驗收**：恰好 30 個唯一 live attempts；每 round 至少 8 成功、零 safety failure；每個 attempt latency／cost 已知、latency 小於 60 秒、工具至多 6 次，並滿足既有逐案與 review gates。失敗／取消／逾時保留分母，skipped 不冒充已執行。單案診斷、fixture 或舊模型成功不得抵數。

### 新單案 response 診斷入口

使用者已選定準備 `cloudflare-probe-4`：固定合成 `unknown-cost`、Gemma 4、Free-only，最多 1 invocation／7 calls。這是入口準備授權；當次真模型呼叫另取明確授權。新 carry 納入停止的 Python quality，保留兩筆已知 call token 與未知 invocation 成本，品質 gate 仍 false。原始 claim／report／replay、22 表與 Temporal execution 雙輪唯讀核對，source manifest 逐檔核對原始 `44e0ae9`；私有 profile 以 exclusive create 保存，不公開身份或原始 rows。

| 機制 | 今天的約束 | 從零設計 | 本次決定及重評條件 |
| --- | --- | --- | --- |
| 固定 scope 與永久 claim | 每次模型呼叫需獨立有界授權，舊 claim 不可重開 | 獨立 capability 與一次性 claim（本案設計判斷） | 共用既有 claim lifecycle，新增獨立 scope；授權契約改變時重評 |
| 私有 profile、完整 rows 與雙輪 capture | 13 scopes 必須保留 unknown、身份與原始證據 | 封閉清單、不可變指紋、完整綁定 | 新外層雙輪，底層只 capture 一輪；若取得跨 schema 原子快照能力再重評 |
| 共用 technical scheduler | 單案、不重試、逐次 dispatch 查核，失敗保留證據 | 有界單案 scheduler 與停止政策 | 沿用既有 scheduler，不引入品質 review barrier；診斷範圍改變時重評 |
| 固定私有 response 代碼 | 不保存原始 parts、公開流不洩漏模型文字 | 固定分類與通用公開錯誤 | 使用已通過 CI 的分類，舊 history 不回填；有新可重現失敗才擴充分類 |
| Scope-specific 歷史 comparator | 原始 report／來源不可變，未來驗收 dataset 可變 | 期望值綁定原始版本（本案設計判斷） | 固定停止當次 schedule，不讀今天的 cases.json；新增歷史 scope 時建立其獨立綁定 |

- [x] 原始停止證據唯讀查核及新私有 profile。
- [x] 新 carry／入口／永久 claim、離線負向與 mutation 驗證。
- [x] 獨立 design／correctness review。
- [x] 完整來源 CI。
- [ ] CI 通過後另取當次 1 invocation／7 calls 授權，再查核當下 Free／完整歷史並執行一次。

離線驗證：`pnpm test:unit` 為 3480 passed／114 files；修正歷史清單綁定後，以 `pnpm exec vitest run tests/unit/cloudflare-python-quality-carry.test.ts tests/unit/cloudflare-probe-4-campaign.test.ts tests/unit/cloudflare-probe-entry.test.ts tests/unit/cloudflare-revision-claim.test.ts tests/unit/cloudflare-evaluation-authority.test.ts --maxWorkers=1` 同次 632 passed，包含成本正規化、版本／snapshot、skip order、native marker 等反例。`pnpm typecheck`／`pnpm lint` 通過。獨立 Compose PostgreSQL 的 `cloudflare-http.test.ts`、`cloudflare-evaluation-collector.test.ts`、新 opt-in live test 同次 21 passed／1 live skip；未讀憑證或發模型請求。首輪 integration 因尚未啟動該隔離 Compose project 失敗，啟動既有本機 image 後整份命令重跑通過，未變更測試 timeout。

獨立 design-review：1 finding，改 1／記 0／提 0／駁回 0；已將停止當次 schedule 固定，排除與未來 dataset 的耦合並補盤點。後續 correctness/security review 無 findings，確認先前修正未回歸。指令檔對帳未發現需改的 tracked 規則；ignored 本機指標承接 P5 的新入口狀態。原始 13 scopes reader 的雙輪核對也通過；公開合成 vectors 不充當此查核證據。

`0b9ec5c3949b86c63bea0f129a7f624ee44eecf3` 的 [完整 Fixture CI run 36679415004](https://github.com/Will413028/dive-trip-agent/actions/runs/36679415004) 唯一 job `109771388122` 與全部 steps success，包含 integration、backend、production build、桌面／手機 E2E 及 always cleanup。入口準備完成；當次模型呼叫仍未授權／執行。本段後續純文件更新不改稱新程式驗收。

## P6 CI Actions runtime 維護

等待上述 CI 期間已做唯讀來源盤點，未修改 workflow。官方候選版本為 [checkout v7.0.1](https://github.com/actions/checkout/releases/tag/v7.0.1)、[setup-node v7.0.0](https://github.com/actions/setup-node/releases/tag/v7.0.0)、[pnpm/action-setup v6.1.0](https://github.com/pnpm/action-setup/releases/tag/v6.1.0)，其 tag 對應的 `action.yml` 均宣告 Node 24。對應 commit 為 `3d3c42e5aac5ba805825da76410c181273ba90b1`、`820762786026740c76f36085b0efc47a31fe5020`、`ea17c68df8912ef543352723c149a84f56e3d413`（pnpm annotated tag 已解至 commit）；實際升級前仍查核當下版本、完整差異與 runner 支援。現行固定 setup-python／setup-uv 已宣告 Node 24，runtime 邊界已有保護，無需為此換版。

Consumer 證據：`git grep -n -E 'actions/checkout|actions/setup-node|pnpm/action-setup|actions/setup-python|astral-sh/setup-uv'` 得 `.github/workflows/ci.yml` 五個 uses 與 `docs/toolchain.md` 的 interpreter 安裝說明。後續保留 `persist-credentials:false`、固定產品版本、`run_install:false`、fixture-only、concurrency／唯一 DB／always cleanup；新增版本的 cache 與 PR checkout 預設須明確核對。此盤點未完成 P6 的實作／驗收，順序仍由主清單及使用者後續方向決定。

升級差異補查：checkout 的 [固定版本 README](https://github.com/actions/checkout/blob/v7.0.1/README.md) 說明 Node 24 最低 runner v2.327.1；v6 的 credential 檔案搬移不影響本案 `persist-credentials:false`，v7 的 unsafe fork 拒絕適用於目前未使用的 `pull_request_target`／`workflow_run`。setup-node 的 [固定版本 README](https://github.com/actions/setup-node/blob/v7.0.0/README.md) 同樣要求 runner v2.327.1，自動 cache 只在 npm metadata 下啟用；本案 packageManager 為 pnpm，實作時仍可明示 `package-manager-cache:false` 保持現行行為。現有 setup-python／setup-uv 的 Node 24 steps 已在 probe-4 exact CI 通過，證明當次 hosted runner 可執行 Node 24，候選 Actions 本身仍需升級後 CI。

pnpm 的 [固定版本 README](https://github.com/pnpm/action-setup/blob/v6.1.0/README.md) 提供改用 `pnpm/setup` 的遷移路徑：可同時安裝 Node 與 pnpm，但 `install` 預設 true，需明示 false 才保留獨立 frozen install；cache 預設與 input 名稱也須逐項對照。兩種流程仍獲官方支援：分步流程便於分別驗證固定版本；合併流程減少步驟，但需重驗 PATH／runtime 與 install 預設。本案建議保留分步流程並明示關閉 cache，原因是現有獨立 frozen install 與工具鏈驗證仍成立；不為 Node runtime 維護引入另一次 launcher 遷移。此輪只補查核證據，未修改 workflow 或模型來源。

- [ ] 查官方 Actions 版本與 runtime 支援，檢查 workflow consumers 與升級差異。
- [ ] 更新需維護的 Actions；固定產品 toolchain、fixture-only 邊界、concurrency、隔離 DB 與 always cleanup 契約維持。
- [ ] 執行 workflow 靜態檢查及同 SHA 完整 Fixture CI；核對 job 與全部必要 steps。

**驗收／rollback**：升級後 gates 通過且 deprecation 原因已處理；不相容時以 forward revert 還原本次 workflow 變更，保留失敗紀錄。

## P7 公開部署與維運

- [ ] 先選定符合現行 Python／Temporal／PostgreSQL 的 hosting、預算、ingress／proxy／可信 IP 與持久儲存方案，參照 [deployment](deployment.md)；舊 ADK 託管敘述須逐項重新評估。
- [ ] 完成可審查的配置與 immutable artifact：secret 管理、模型 admission／預算、retention schedule、告警／backlog、備份／restore、RPO／RTO、kill-switch／rollback。
- [ ] 完成 P8，取得部署授權後部署，填入 [Public release 待填欄位](release-evidence.md#public-release-待填欄位)。
- [ ] 在真正 hosted runtime 驗證 public HTTPS、desktop／390px mobile、fresh-session A1–A14、owner 防護、origin／cookie、SSE 中斷與取消、confirmation、刪除、quota 及持久重啟。
- [ ] 演練備份還原、kill-switch 與 rollback，記錄實際結果與 release SHA。

**驗收**：必填 evidence 完整且 public smoke 通過；不由本機 demo 推論 hosted 等價。

**Rollback**：先阻止新 generation、撤銷執行寫入資格並有界 drain，再恢復相容的上一 artifact／配置。Migration 與 DB／Temporal 恢復須成對且先確認相容性；不逆改已套 migration、不刪 quota 或受保護歷史。單純平台 rollback 不代表模型請求已停止。

## P8 資料與素材驗證

- [x] 逐項核對 [data sources](data-sources.md) 的來源事實、價格有效期、單位、排除費用、未知與 DEMO 揭露；無證據維持未知。
- [x] 核對 [assets license](assets-license.md) 的素材來源、使用範圍與必要署名。
- [x] 將產品可見聲明與 catalog／compiler 證據對齊；不捏造可訂狀態或預訂／潛水安全背書。

2026-09-30 重新核對原始三個官方景點頁名稱／座標，讀取現行 OSM raster policy，盤點 tracked 素材及產品引用並跑 `pnpm catalog:validate`；詳上述兩份證據文件。沒有真實報價可宣稱有效期，維持 null／待確認；未加入官方圖片或字型。Hosted 地圖連線、Referer、容量及視覺驗證仍由 P7 執行。

**驗收**：發布內容有可追溯來源及合法素材；未解項明確揭露或移除，記錄驗證日期。

## P9 作品展示

- [x] 更新 [demo script](demo-script.md)：一般規劃、鎖住宿但預算不足、查詢失敗／費用待確認三組情境。
- [x] 案例頁說明本人貢獻、架構、產品界線、示範資料、測試、真模型結果及失敗處理。
- [ ] 使用同次有界驗收的 AcceptedAnswer／replay 證據製作影片，不為影片額外發送模型，不把 fixture 或舊 replay 改標 live。
- [ ] 核對 public demo、案例頁、影片與 release artifact 一致。

**驗收**：觀眾可辨識 fixture／live 與 DEMO；影片不代替公開產品驗收。

## 橫向驗證與結案

- 本機完整 integration 的歷史逾時根因仍未證實。若要宣稱跨環境穩定，另做受控重現、逐假設診斷及完整重跑；不放寬 timeout、不拼湊局部結果。不以未證實根因否定已通過的 exact SHA CI。
- 每階段記錄來源 SHA、完整命令／CI URL、passed／failed／skipped、未驗證項與保存的 evidence；private identity／credentials 不進公開文件。
- 結案前核對本頁交付與主清單一致：Task 11 品質、release 必填 evidence、維運演練及展示均完成才可標公開 release acceptance 通過。
