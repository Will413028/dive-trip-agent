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
- [x] CI 通過後取得當次 1 invocation／7 calls 授權，查核當下 Free／完整歷史並執行一次；已停止，品質未通過。

離線驗證：`pnpm test:unit` 為 3480 passed／114 files；修正歷史清單綁定後，以 `pnpm exec vitest run tests/unit/cloudflare-python-quality-carry.test.ts tests/unit/cloudflare-probe-4-campaign.test.ts tests/unit/cloudflare-probe-entry.test.ts tests/unit/cloudflare-revision-claim.test.ts tests/unit/cloudflare-evaluation-authority.test.ts --maxWorkers=1` 同次 632 passed，包含成本正規化、版本／snapshot、skip order、native marker 等反例。`pnpm typecheck`／`pnpm lint` 通過。獨立 Compose PostgreSQL 的 `cloudflare-http.test.ts`、`cloudflare-evaluation-collector.test.ts`、新 opt-in live test 同次 21 passed／1 live skip；未讀憑證或發模型請求。首輪 integration 因尚未啟動該隔離 Compose project 失敗，啟動既有本機 image 後整份命令重跑通過，未變更測試 timeout。

獨立 design-review：1 finding，改 1／記 0／提 0／駁回 0；已將停止當次 schedule 固定，排除與未來 dataset 的耦合並補盤點。後續 correctness/security review 無 findings，確認先前修正未回歸。指令檔對帳未發現需改的 tracked 規則；ignored 本機指標承接 P5 的新入口狀態。原始 13 scopes reader 的雙輪核對也通過；公開合成 vectors 不充當此查核證據。

`0b9ec5c3949b86c63bea0f129a7f624ee44eecf3` 的 [完整 Fixture CI run 36679415004](https://github.com/Will413028/dive-trip-agent/actions/runs/36679415004) 唯一 job `109771388122` 與全部 steps success，包含 integration、backend、production build、桌面／手機 E2E 及 always cleanup。入口準備完成；後續當次授權與執行結果見下段。本段後續純文件更新不改稱新程式驗收。

當次單案執行：使用者明確授權上述上限後，確認 Workers Free Active、當日 164.74／10,000 Neurons，完整 13 scopes preflight 通過，執行一次後按 `UNKNOWN_USAGE_STOP` 停止。結果為 1 invocation／2 model calls；兩筆 call 用量均已知，但 invocation actual cost 仍 null，保守扣帳 183505 reference micros，沒有重試。第一步完成 calculate_budget，第二步失敗，未建立提案或變更行程。固定私有分類為 `AGENT_MODEL_RESPONSE_MIXED_PARTS`，只證明 ToolCallPart 與至少一種非 ToolCallPart 共存，不辨認非工具 part 種類或原值，也不回推舊 P5 的分類。diagnosticComplete／evaluationGatePassed 皆 false。

停止後 `node /tmp/dive-trip-probe4-postrun.mjs` 雙輪唯讀核對 report／replay、22 表、Temporal execution 與 source manifest 全部符合，新增一筆 unknown receipt；`node /tmp/dive-trip-probe4-carry-audit.mjs --verify` 再核對既有 13 scopes 通過。原始 claim／report／replay、DB／Temporal 保留，claim 已消耗；不得重新執行入口。先前同時啟動的唯讀查核遇到 owned lease EEXIST，未清 lock，待持有者完成釋放後順序查核通過。下一步先確認回應結構，再決定修正：先唯讀核對 provider adapter／SDK 的解析路徑，離線驗證固定 part 種類診斷，不改 mixed guard；若現存證據不足，再準備不保存原值的種類／數量診斷，另取當次有界授權執行新單案。確認實際種類及轉換行為後才比較 adapter 修正、輔助 part 過濾或模型選擇，不預先採用過濾。種類資訊不足以判斷內容語義時，明記未知，另定必要且有界的觀察方式；不得由種類推論原文。新實驗需獨立入口與當次有界授權。


### Mixed parts 種類診斷（離線）

依使用者指示先確認回應結構再決定修正。唯讀核對鎖定的 PydanticAI 2.51.0：Cloudflare 走 OpenAIChatModel，SDK 會分別處理 reasoning／reasoning_content、content（含 thinking tags）與 tool_calls。以 synthetic credential＋強制 MockTransport 的六種 wire 回應重現純工具、文字混合、兩種 reasoning 欄位與 content thinking tags；request 保持 tool_choice=required、enable_thinking=false，仍可解析混合回應。這證明可行解析路徑，不證明上一案使用哪個欄位，也不證明 provider 違約。型別定義參照 [PydanticAI messages](https://pydantic.dev/docs/ai/api/pydantic-ai/messages/)，模型參照 [Cloudflare Gemma 4](https://developers.cloudflare.com/workers-ai/models/gemma-4-26b-a4b-it/)；本輪結論以鎖定 SDK 與離線 wire 測試為準。

新私有固定分類區分 MIXED_TEXT、MIXED_THINKING、MIXED_TEXT_THINKING、MIXED_OTHER；其他種類優先 OTHER，不保存內容、metadata、動態型別名或數量。種類已足以區分本輪首要假設，因此先不擴大數量診斷。全部 mixed 仍拒絕，公開錯誤、未知結算、工具／模型上限與重試政策不變。沿用固定私有 failure code：從零設計在現有 Temporal／私有證據邊界下仍採有限枚舉，無需增加原始回應儲存；若種類不能區分下一個假設，再重評必要觀察欄位。

同次完整 affected 命令 `backend/.venv/bin/pytest backend/tests/test_provider_sdk.py backend/tests/test_response_diagnostic.py -q --tb=short` 為48 passed，含8個真實 Temporal／隔離 PostgreSQL案例及6個SDK wire案例。process內把分類退回舊泛碼，以 `pytest.main(['backend/tests/test_response_diagnostic.py','-q','--tb=short','-k','private_response'])` 反轉驗證為4 failed／4 passed／6 deselected，原source不變。Ruff及strict mypy通過。這是小範圍診斷補強，不改儲存／交易／執行機制；未呼叫真模型，舊證據不回填。`bc9446aefa59256e12eed161910b6645ba910ab6` 的 [完整Fixture CI 36685444563](https://github.com/Will413028/dive-trip-agent/actions/runs/36685444563) 唯一job `109790117325` 與全部steps success，含integration、backend、production build、桌面／手機E2E及cleanup。新單案入口及完整14 scopes carry尚未準備；實際觀察需要新入口、CI與當次有界授權。

等待CI期間，`node /tmp/dive-trip-probe4-carry-audit.mjs --verify` 既有13 scopes查核通過；`node /tmp/dive-trip-probe4-original-source-audit.mjs` 對probe-4 report／replay、22表與Temporal雙輪唯讀核對通過，完整source檔案清單及逐檔hash對照原始0b9ec5c（不是今天的source）。兩項依序執行，未清lock／寫入歷史／新增profile，也不宣稱已建立14 scopes完整reader。

- [x] 核對鎖定SDK解析路徑、離線wire重現及私有種類診斷。
- [x] 承接probe-4原始report／replay／完整rows／execution／固定舊碼，建立不可變profile與14 scopes閉世界carry；舊成本null不回填。
- [x] 準備獨立單案入口及永久claim，維持合成unknown-cost、Free-only Gemma 4、最多1 invocation／7 calls、不重試；驗證新增scope及種類碼不洩漏原文、缺漏／額外／漂移仍拒絕，完成必要review與exact完整CI。
- [x] 取得新的當次有界授權、核對當下Free／完整歷史後執行一次；先報告實際種類與觀察限制，再決定修正，不由合成SDK測試宣稱模型已修復。

### 新單案種類診斷入口：沿用盤點

| 機制 | 今天的約束 | 從零設計 | 本次決定及重評條件 |
| --- | --- | --- | --- |
| 固定scope／永久claim | 舊入口消耗，新呼叫另取當次授權 | 一次性capability＋先claim再preflight | 獨立probe-5，不重開舊claim；授權政策改變時重評 |
| Immutable profile與完整rows | 14 scopes、unknown不能歸零或回填 | 封閉inventory、digest及完整run／trip／owner／provider／account綁定 | 新profile承接probe-4，以exclusive create一次保存；證據格式變更另建adapter |
| 雙輪capture及有界helper | 多pool不能假裝原子快照，原始report不可漂移 | 外層兩次完整capture、底層單次 | 沿用bounded reader；新scope另驗workflow／execution成對與固定舊mixed碼；可取得跨schema原子快照時重評 |
| 固定歷史schema與候選驗證 | 歷史replay／原始call用量／未知成本皆不可改寫 | 每個不可變scope獨立比較其原始證據 | 新comparator只接受停止當次單案兩records、2708已知call tokens與null invocation成本；未依今天dataset或新分類回填 |
| 共用technical scheduler／retention | 合成unknown-cost、1 invocation／7 calls，失敗即停 | 有界單案，不以技術probe當品質 | 沿用一案scheduler及retain；實際種類不足時先報限制，不自動再probe |
| 固定私有種類碼 | 不存原值，全部mixed仍拒絕 | 有限enum與通用公開錯誤 | 使用bc9446a已驗證分類，不改runtime guard或結算；得到新實測證據後才定修法 |

新 `cloudflare-probe-5` 準備：14 scopes完整reader雙輪查核通過；profile核對probe-4原始source／完整DB／Temporal／replay後以exclusive create保存，原值與身份不進public fixture。`node /tmp/dive-trip-pin-probe4-history.mjs` 只執行一次，後續不可重跑；唯讀reader驗證命令為 `node /tmp/dive-trip-probe5-carry-audit.mjs --verify`。當次單案入口未建立claim或dispatch。

`pnpm test:unit` 同次3588 passed／116 files；`pnpm exec vitest run tests/unit/cloudflare-python-probe-4-carry.test.ts tests/unit/cloudflare-probe-5-campaign.test.ts tests/unit/cloudflare-probe-entry.test.ts tests/unit/cloudflare-revision-claim.test.ts tests/unit/cloudflare-evaluation-authority.test.ts --maxWorkers=1` 同次718 passed，含missing／extra、row／identity／execution配對／固定mixed marker、unknown正規化、舊grant與永久claim等mutation反例。首輪focused因複製時多帶舊entry測試片段而1 failed／718 passed；移除多帶片段後整份命令通過。`pnpm typecheck`／`pnpm lint` 通過。獨立Compose PostgreSQL的HTTP／retired collector／新live opt-in測試同次22 passed／1 live skip，沒有讀真憑證或模型呼叫；隔離container已停止且volume保留。design-review無findings；correctness/security review發現新campaign inventory漏列既有三個probe profiles，已補齊required／正向fixture及逐檔missing／額外profile反例，全unit／affected／typecheck／lint整份重跑通過。實際inventory dry驗證在候選claim open(wx)前攔截寫入，重用原claim檢查成功，前後確認新claim／report不存在；沒有讀憑證或dispatch。獨立複核確認P1已修、無新findings；累積ledger無open findings。design為0 findings；correctness為1 finding、改1／記0／提0／駁回0。指令檔對帳僅更新ignored本機入口指標，不新增tracked規則。`2f8d77c601bd052966aa66467fdc3045bf5bac6e` 的 [完整來源CI 36689700528](https://github.com/Will413028/dive-trip-agent/actions/runs/36689700528) exact SHA、唯一job `109803714994` 與全部steps success，含integration、backend、production build、桌面／手機E2E與cleanup。

另以 `.artifacts/probe5-profile-omission.config.mts` 在測試程序內移除required的三份既有profiles，`pnpm exec vitest run tests/unit/cloudflare-revision-claim.test.ts --config .artifacts/probe5-profile-omission.config.mts --testNamePattern '(probe5|probe4).*claims once' --maxWorkers=1` 為1 failed／1 passed／611 skipped：新入口正向測試轉紅，舊入口控制組保持綠；tracked source未改。一次性執行wrapper已準備並通過syntax check，尚未執行；需要新的當次有界授權與當下Free／完整歷史preflight。


### probe-5 當次種類診斷結果（2026-09-30）

使用者對明列的單案授權回覆「繼續」。當下Workers Free Active、Workers AI當日190.2／10,000 Neurons；完整14 scopes reader及exact來源CI通過後，固定入口只執行一次。`node /tmp/dive-trip-probe5-once.mjs` 在1 invocation／2 model calls後按UNKNOWN_USAGE_STOP停止，測試exit 1為campaign停止；沒有重試。原生Temporal固定分類為 `AGENT_MODEL_RESPONSE_MIXED_TEXT`：工具與TextPart混合，不保存原值，不能判定文字語義或回推舊probe-4。call tokens1286＋1418＝2704已知，invocation actual cost仍null，保守charge183505reference micros；不以tokens回填unknown。

`node /tmp/dive-trip-probe5-postrun.mjs` 雙輪核對原始report／replay、22表完整rows、paired Temporal execution及當次source全部一致；`node /tmp/dive-trip-probe5-carry-audit.mjs --verify` 既有14 scopes也一致。report、replay、claim、retained DB及SQLite保留，owned lease正常釋放。沒有提案、確認或行程版本變更，quality gate false。這次授權與永久claim已消耗，不可重開。

使用者後續選定「忽略TextPart、僅接受經驗證的結構化ToolCallPart」的離線修正，不另做真模型呼叫。固定種類只證明SDK形狀，不證明文字正文、工具參數或品質正確。

### Mixed Text 相容修正（離線）

今日仍需strict AnswerPlan／Evidence、工具參數與call identity驗證、usage先保存及原生Temporal durability。從零設計採server-owned結構化投影：丟棄模型正文、保留必要typed usage／model／timestamp／finish reason，完整calls在原交易驗證後才交原生迴圈。沿用candidate validator與complete_model交易，不另建平行工具dispatcher；ID、六工具／七模型上限、unknown settlement及無重試保持原契約。只放行ToolCallPart＋TextPart，ThinkingPart／其他種類及純文字仍拒絕；response自由metadata也不帶入投影。停止的原始history不修改，日後新model實驗另需15 scopes carry及當次授權。

- [x] 以離線Temporal／隔離DB驗證：工具與final_answer兩步可完成；正文及metadata不進後續messages／完整history／public events；無提案或版本變更。
- [x] mixed-invalid／duplicate／reused仍經原validator拒絕，thinking／both／other／empty／純文字仍拒絕；accounting與未知政策不變。
- [x] 受影響完整命令、靜態檢查、獨立review與exact完整CI通過，再記錄可用範圍；不宣稱真模型品質已修復。

同次 `DOCKER_CONTEXT=desktop-linux backend/.venv/bin/pytest backend/tests/test_response_diagnostic.py backend/tests/test_provider_sdk.py backend/tests/test_evaluation_generation.py -q --tb=short` 為50 passed，包含9個真實Temporal／隔離DB案例；Ruff／strict mypy通過。擴大至 `DOCKER_CONTEXT=desktop-linux backend/.venv/bin/pytest backend/tests/test_response_diagnostic.py backend/tests/test_provider_sdk.py backend/tests/test_evaluation_generation.py backend/tests/test_temporal_sdk.py -q --tb=short` 同次59 passed，含9個SDK／Temporal provider及failure案例；Ruff通過。原guard下新增行為2 failed／13 passed，證明有效混合回應被拒絕；修正後首輪49 passed／1 failed為測試錯用completed，核對契約狀態succeeded後整份命令50 passed。測試程序內移除projection，單案1 failed／14 deselected，失敗點為第二次請求包含合成正文；tracked source未變。沒有新真模型呼叫／憑證讀取；獨立design-review無findings；correctness/privacy P2發現history.to_json將payload base64而使明文檢查失效，已改查每個event原始protobuf bytes。只略過最後final_answer投影的mutation為1 failed／14 deselected，正確失敗於history檢查；同類掃描 `rg -n 'history.to_json\(|fetch_history' backend/tests` 發現SDK Temporal案例也用此形式，一併修正。複核P2 fixed、無新findings，ledger無open；design 0、correctness 1，改1／記0／提0／駁回0。指令檔對帳無需tracked修改。exact完整CI已在下段attempt2通過，不算品質通過。

完整來源CI run36696730620 attempt1，唯一job109826357055在mobile409送出按鈕等待失敗，browser66 passed／1 failed／5 skipped，其餘integration／backend／build通過。API artifact清單為空，原trace不可取得，未定根因。程式與timeout不變，本機production的409相關整份命令4 passed；以 `COMPOSE_PROJECT_NAME=dive-trip-mixed-text-e2e-20260930-1751 E2E_PRODUCTION=1 pnpm test:e2e` 跑完整browser為67 passed／5 skipped，container停止、volume保留。`eac81dc1bfbcf5eafcbb2555b3bc1d6e02ae3688` 的 [同SHA完整CI attempt2](https://github.com/Will413028/dive-trip-agent/actions/runs/36696730620/attempts/2) 唯一job `109833702532` 與全部27 steps success，含integration／backend／production build／桌面手機E2E／cleanup；以此本次完整結論通過，不拼局部結果。monitor曾因API連線重設exit 1，已改以GitHub job與每個step核對。第一輪mobile409失敗根因仍未證實，不宣稱跨環境穩定。

修正後 `node /tmp/dive-trip-probe5-original-source-audit.mjs` 對原始probe-5做雙輪唯讀核對：原2f8d77c完整source清單／逐檔hash、report／replay、22表及paired Temporal execution全部一致；固定MIXED_TEXT與null成本保留。未讀generation憑證、未dispatch、未改原始歷史，也未建立15 scopes新carry或新claim。

### probe-6 單案入口準備（2026-09-30）

承接已停止的 probe-5，固定合成 unknown-cost、Cloudflare Workers AI Free-only／Gemma 4，最多 1 invocation／7 model calls；新入口準備不授權 dispatch，也不計入 30 案品質驗收。

| 沿用機制 | 今日約束／從零設計 | 決定與重評條件 |
| --- | --- | --- |
| 永久 claim／獨立 grant | 每次呼叫有界、停止不可重開；一次性 capability | 新 probe-6，不重用已停止入口；授權政策改變才重評 |
| 固定 profile／遞迴 carry | 不可變歷史與完整身分綁定；封閉逐次證據核對 | 新 profile-5 接續舊 14 scopes，最外兩次完整 capture；歷史變為可寫或需原子快照時重設計 |
| 原 scheduler／Python runtime | 六工具七模型、usage 保存、未知保守結算仍必要 | 單個固定 slot，不另建 dispatcher／自動重試；runtime 契約改變再評 |

- [x] 原始 probe-5 source、report／replay、22 張表及 paired Temporal execution 雙輪一致後，exclusive create 保存 private profile；舊成本 null／MIXED_TEXT 保留。
- [x] 新十五 scopes reader 整份雙輪核對一致：50 invocations／76 model calls、1500651 charged reference micros、297341 observed tokens、8 unknown；剩餘 reference 1499349／50 invocations。這些不是當下 provider Free 額度。
- [x] 新 grant／claim／server marker 與所有 consumers；inventory 必須含歷代 profiles、claim／report／replay。
- [x] 實際 inventory dry 在 probe-6 claim open(wx) 前攔截：清單接受、claim／report 前後不存在，沒有讀 generation credential。
- [x] focused 806 passed、全 unit 3700 passed／118 files、typecheck／lint 通過；移除 profile-5 required 的程序內 mutation 為 1 failed／11 older controls passed，證明正向清單會辨認漏列。
- [x] 獨立 correctness 複核，無 findings。
- [x] exact source 完整 Fixture CI；本機 integration 的失敗仍保留。
- [x] 取得當次單案授權並查核 Free／完整歷史，執行一次後按 UNKNOWN_USAGE_STOP 停止；claim 已消耗。

本機 integration 三檔首輪為 1 failed／27 passed／1 skip；誤重疊的四檔完整命令為 7 failed／28 passed／1 skip。新獨立 Compose project 串行同一四檔完整命令為 1 failed／34 passed／1 skip，唯一 failure 為既有 Gemini abort 案例在 10 秒內 model_calls 仍為 0（abort 尚未發生）；沒有改程式或 timeout，不能稱本機 integration 通過。當下主機 load 38–81，但不是已證實根因；未修改基線 e6c8bb6 的同一 abort 案例也 30 秒 timeout（1 failed／11 skipped），形狀不同，不足以證實根因或宣稱排除回歸。基線 worktree 的 pnpm 先因無 TTY 的 modules purge 檢查中止，未安裝；改以同版本 Node 直接執行既有 Vitest。完整來源 CI 將獨立驗證，任何局部重跑都不拼成通過。

`7e2287bf998369dbc9773f54df860dd1cf3b8cff` 的 [完整來源 CI 36732864070](https://github.com/Will413028/dive-trip-agent/actions/runs/36732864070) attempt1、唯一 job `109946794987` 及全部 27 steps success，包含完整 integration／backend／production build／桌面手機 E2E／cleanup；exact SHA、必要 gate 名稱及每 step 均已核對。以該次完整命令作本輪來源驗收，不把本機局部或失敗命令拼成通過；本機 failure 根因未證實。隨後依當次明確授權執行 probe-6，結果見下節。

原始 profile bootstrap `node /tmp/dive-trip-pin-probe5-history.mjs` 只執行一次，不可重跑。唯讀完整 reader：`node /tmp/dive-trip-probe6-carry-audit.mjs --verify`。design-review 與 correctness review 均無 findings（各 0；改／記／提／駁回各 0）；指令檔對帳僅更新 ignored 本機入口指標，probe-6 已執行並停止，永久 claim 不重開。

### probe-6 當次單案結果（2026-09-30）

當次明確授權為 Free-only、固定 `@cf/google/gemma-4-26b-a4b-it`、合成 unknown-cost，最多 1 invocation／7 model calls。執行前確認 Workers Free Active、Workers AI 今日 215.62／10000 neurons；完整十五 scopes 雙輪一致，再核對 exact source CI。

一次執行為 **UNKNOWN_USAGE_STOP**：1 invocation／7 calls，前六步完成 `calculate_budget`，第七模型 activity 固定失敗碼 `AGENT_TOOL_LIMIT`。七筆 call usage 共 11595 tokens 已保存；invocation 成本仍 null，保守扣帳 183505 reference micros，不回填。沒有提案、確認、重試或版本變更；diagnosticComplete／evaluationGatePassed 均 false。claim 已消耗，原始 report／replay／22 表與 paired Temporal execution 保留。

當次完整證據雙輪核對 rows／replay／execution／source 一致；再執行原十五 scopes reader，舊歷史仍為 50 invocations／76 calls／8 unknown。含本次累計為 51 invocations／83 calls／9 unknown、1684156 charged reference micros／308936 observed tokens；剩餘 49 invocations／1315844 reference micros，不等於 provider Free 額度。

- [x] 離線重現上限邊界：既有 `test_final_output_counts_as_tool_and_is_exclusive` 明確要求 final_answer 計入六次名額，五次業務工具後接受、六次後拒絕；transaction 的 consume_final_tool 同樣計數，屬既有政策且 already protected。
- [x] 固定 synthetic SDK 查核工具結果與 output tool 曝露；重複 budget 的真模型原因仍未證實。
- [ ] 修正與驗證後才準備新的十六 scopes 有界入口；當次模型授權另取。

離線診斷新增 `test_cloudflare_native_loop_preserves_budget_returns_and_output_tool`，以既有 OfflineSdkGeneration、synthetic credential 與強制 MockTransport 測試一／六次 budget 後回答。逐次檢查 assistant call／tool return 的數量、ID 配對、完整 budget JSON（含 unknown／null／DEMO／evidenceRef）、final_answer schema 與 required tool_choice。59 tests（provider SDK＋tool contract）同次通過，Ruff 通過；沒有 production code／prompt／quota／上限修改、沒有新模型呼叫。

`3147eab88fb5fb20353763321572a8ad33205c40` 的 [完整來源 CI 36740367723](https://github.com/Will413028/dive-trip-agent/actions/runs/36740367723) 唯一 job `109972865901` 與全部27 steps success，exact SHA 與必要 gates 已核對。

這個 native SDK 測試刻意不掛產品 guard：六次工具後的 synthetic final_answer 在 SDK 可解碼，不代表產品允許；產品 guard 的既有拒絕測試也在同次驗證。證據排除固定 synthetic 路徑的工具結果遺失或 output tool 未曝露，不能排除 provider／真模型差異，也不能反推 probe-6 最後候選。下一步先設計不保存原值的固定工具選擇／停止分類，再準備新有界實驗；不先調高上限或對重複呼叫加補丁。

第七候選在解析名稱前被上限拒絕，不能判定它是第七次 budget 或 `final_answer`；本次未保存原始 parts，不能據此聲稱特定 TextPart 形狀或品質已修復。工具上限已有保護，不提高限制或自動重試。

### 工具上限候選分類診斷（2026-10-01）

採固定私有 failure code，不保存原始回覆；相較原值保存，觀察範圍較小但符合目前資料契約。直接改 prompt 或提高上限尚無根因證據。分類在既有 32 KB 輸出檢查之後、工具參數驗證與整批 reservation 之前，只讀候選 name 的已宣告類別。

| `AGENT_TOOL_LIMIT_` suffix | 只表示候選 name 類別 |
| --- | --- |
| `FINAL_ONLY` | 全部為 final_answer，不證明數量／參數合法 |
| `BUDGET_ONLY` | 全部為 calculate_budget |
| `BUSINESS_ONLY` | 全部為其他已宣告業務工具 |
| `MIXED_NAMES` | 混合上述類別 |
| `UNDECLARED_NAME` | 至少一個未宣告名稱 |
| `INVALID_NAME_SHAPE` | 至少一筆不是 object，或 name 缺漏／不是 string |

異常 shape 優先於未宣告名稱，再優先於混合類別，與候選順序無關。exception 只持有固定 code，不保存名稱、args、call IDs、原始值或動態型別名；`FINAL_ONLY` 是名稱分類，不能推定模型已提供有效回答。transaction 防線仍用原 AGENT_TOOL_LIMIT；六工具（含 final_answer）／七模型、整批拒絕、禁止重試、unknown 保守結算、public AGENT_FAILED 與既有成本 null 均不變。

新純分類 tests 修改前 13 failed／23 passed，證明泛碼不足；後續 affected 命令包含 tool contract、provider SDK 與 response diagnostic，涵蓋四種 native Temporal／隔離 PostgreSQL 超限分類，七次 call usage、六筆工具、零提案／版本变更、private history 固定碼與 public 不洩漏。獨立 correctness／privacy review 無阻擋 findings；兩個 coverage 建議（同批跨剩餘名額、超大輸出優先）已補測。最終同次 affected 為 93 passed；Ruff、strict mypy（85 source files）通過，沒有真模型呼叫。

- [x] 固定分類與受控 native failure 傳遞，原值不保存。
- [x] 新分類來源完整 CI：54a1842，run36742545503，唯一job109980378232／27 steps success。
- [ ] 完整十六 scopes carry 與新單案入口；準備不授權模型呼叫。
- [ ] 新當次有界授權與 Free／完整歷史查核後，才觀察真模型候選；停止規則不變。

probe-6 仍只有原 AGENT_TOOL_LIMIT，舊證據不回填，不由 synthetic 結果推定真模型的第七候選。下一次分類結果若仍不足以辨認語義，再重評必要觀察範圍。

### probe-7 單案入口準備（2026-10-01）

目的為使用固定候選分類辨認超限回覆，不預先調高上限或修改 prompt。新範圍仍固定 synthetic unknown-cost、Free-only、Gemma 4，最多 1 invocation／7 calls；完整三十案品質 gate 維持 false。準備不授權 generation；模型實際執行另取當次明確有界授權。

| 沿用機制 | 原始必要條件 | 今日從零設計 | 決定與重評條件 |
| --- | --- | --- | --- |
| 永久 claim／獨立 grant | 每次呼叫有界；停止不可重開 | 固定新 scope 與一次性 server capability | 新 probe-7；授權政策改變才重評 |
| 固定 private profile pin／完整原始 rows | 本機單一信任邊界、retained scopes 不可變 | bounded immutable reads＋固定digest，拒絕缺漏／漂移 | 沿用；來源不可信時改簽章或交易式 provenance |
| 完整兩輪 carry capture／owned lease | 固定歷史、多 pool、合作 writer 鎖 | immutable scopes 採完整雙輪捕捉，不宣稱跨 schema 原子性 | 新十六 scopes；歷史可再次寫入時改一致快照 |
| 固定 policy descriptor／薄 entry／campaign、共用 lifecycle | claim、history、credential 順序不可漂移 | 一個 lifecycle、明確 scope 與固定單案政策 | 沿用共享實作，不另造 dispatcher；增加一般化需求才重評 |
| 歷史版本 adapter／固定 DB 與 Temporal 格式 | 原始 stopped report與22表layout、SQLite history格式不可重新解讀成功 | 固定版本 adapter＋共用 bounded raw capture | 保留專用 comparator；跨工具鏈搬移、DB migration或Temporal格式變更時另定相容性方案，不改舊pin |
| Python／Temporal runtime與quota | 六工具七模型、usage先保存、未知保守結算 | 原生模型工具迴圈與受控失敗分類 | 不新增 retry／formatter／強制去重；runtime契約改變再評 |

- [x] 原始 probe-6 source、report／replay、22 表與 paired Temporal execution 雙輪一致後，exclusive create 保存 ignored profile；原 AGENT_TOOL_LIMIT／null 保留。
- [x] 新十六 scopes reader 完整雙輪一致：51 invocations／83 calls、1684156 charged reference micros／308936 observed tokens、9 unknown，剩餘49 invocations／1315844 reference micros；不等於provider Free額度。
- [x] 新 grant／永久 claim／capability 與所有 consumers；required inventory 包含歷代 profiles、claim／report／replay。
- [x] descriptor修正後actual inventory dry在claim open(wx)前攔截；清單接受，前後claim／report不存在，沒有讀generation credential。
- [x] focused898；descriptor修正後完整 `pnpm test:unit --maxWorkers=1` 為3816 passed／120 files，原timeout不變。typecheck／lint、隔離integration17 passed／1 live skip及獨立design／correctness review通過。
- [x] exact source `6666248a7d4f10ae36f1204d6ad4d226d5b6c640` 完整 Fixture CI `36747798681`／唯一job `109998322207` 全27steps success。
- [x] 取得當次最多1 invocation／7 calls授權，token唯讀Free／完整歷史查核後只執行一次；按UNKNOWN_USAGE_STOP停止，claim已消耗。

新 profile required omission 的程序內 mutation：1 failed／13 controls passed／757 deselected，tracked source未改；新入口會辨認缺少profile-6。首次focused因沿用舊exception assertion而20 failed／878 passed，修正test assertion後同一五檔898 passed。首份全unit為2 failed／3814 passed／120 files：既有SDK子程序命令失敗及tools declaration案5000ms timeout；根因未證實，保留log、不拼成通過。新descriptor完成後，整份unit以原timeout與單一worker重驗為3816 passed／120 files（211.45秒）；不拼湊局部結果，首輪根因未證實。typecheck／lint通過，當次唯一Compose的collector integration 17 passed／1 live skip；容器停止、volumes保留，未觸碰原始history DB。

Design-review累積ledger：B replay kind ladder＝改，以fixed policy／ordered replay descriptors共用bounded reader，所有舊scope仍有正向／缺漏／額外／file-type控制；A歷史格式耦合漏列＝記入盤點表。複查無新findings，改1／記1／提0／駁回0。獨立correctness review無actionable bug；完整raw fingerprint／pins／outer雙輪capture對局部compare欄位已有保護（already protected），不重複造驗證。指令檔對帳只更新ignored新入口current pointer，產品規則不變。

原始 profile bootstrap `node /tmp/dive-trip-pin-probe6-history.mjs` 只執行一次，不可重跑；原始結果以 ignored report定位，不能把public vectors當私有歷史。唯讀完整 reader：`node /tmp/dive-trip-probe7-carry-audit.mjs --verify`。舊claims均不重開；完整carry、inventory、quota保護不因只做一案省略。

### probe-7 當次單案結果（2026-10-01）

使用者授權上述單案上限，另明示以既有token查Free證據。瀏覽器工具故障後改為Cloudflare官方API唯讀查核：完整subscriptions回200，1頁／1筆，只有R2；沒有Workers Paid subscription。這是由完整subscription inventory推論Workers無付費方案，並非dashboard明示Free Active標籤；Workers default_usage_model=standard不能單獨證明Free。GraphQL當日UTC aggregate totalNeurons=315.0977996795655；官方每日免費10,000 Neurons、00:00 UTC重置。證據保存於ignored `provider-free-preflight-probe7.json`，不保存token；當次launcher驗日期／15分鐘時效與exact CI。

來源CI全部27steps成功後，固定入口只執行1 invocation／6 model calls，按UNKNOWN_USAGE_STOP停止，沒有重試。前五次calculate_budget完成，第六模型activity固定碼 `AGENT_MODEL_RESPONSE_NON_TOOL_PARTS`：response.parts非空，但沒有ToolCallPart；尚未到tool-limit候選分類，不能由此反推文字內容或其他parts種類。原始模型內容未保存。六筆call tokens為1290／1417／1528／1653／1778／2007，合計9673；invocation actual cost仍null，保守charged183505reference micros，不回填unknown。

無提案／decision／行程版本或snapshot變更，worker quiescent、evaluation lock釋放，品質gate=false。永久claim／report／replay、retained PostgreSQL22表與Temporal SQLite保留。完整雙輪事後查核raw rows／replay／pairedexecution／exact source相符，原十六scopes reader仍51 invocations／83calls／9unknown。納入本次累計52invocations／89calls／10unknown，charged1867661reference micros、observed318609tokens；剩餘48invocations／1132339reference micros，不能當provider剩餘Free額度。

下一步先離線檢視NON_TOOL_PARTS的可觀測邊界與既有tests，評估是否需要不保存原值的固定parts類別，再決定有界實驗；不自動建下一probe、不放寬strict AnswerPlan或上限、不用已消耗grant重開。

### 非工具 parts 固定分類（2026-10-01）

probe-7舊NON_TOOL_PARTS只證明非空parts且沒有ToolCallPart，不回填其內容種類。原始值保存／固定類別／直接prompt修改三種取捨後，採用SDK型別固定分類：NON_TOOL_TEXT、NON_TOOL_THINKING、NON_TOOL_TEXT_THINKING、NON_TOOL_OTHER。OTHER優先、順序不影響結果；text空字串仍依型別分類，不讀文字、metadata或provider detail。mixed／non-tool共用同一型別分類器，前綴僅由固定boolean分支決定；empty優先、純text仍拒絕，不將文字當final_answer。

新增純分類回歸先7 failed；保留native Temporal／DB整合測試驗證private固定碼、public AGENT_FAILED、不保存原值、未知成本不回填、零提案／版本改動。首份完整affected103案例結果102 passed／1 failed：既有duplicate案Temporal dev server啟動超過原5秒期限，尚未執行Agent，保留log、不宣稱通過。相同完整命令第二輪仍102 passed／1 failed：既有mixed-other案同樣Temporal啟動5秒期限，尚未執行Agent；兩輪完整命令均非通過，不拼湊102+102，新增分類案例均通過，不再重跑或放寬期限。Ruff與strict mypy85source通過；獨立correctness／privacy review無findings，`git grep -n AGENT_MODEL_RESPONSE_NON_TOOL_PARTS -- backend/src backend/tests` 無結果（exit1），tracked source/tests沒有該固定consumer，既有planning DIAGNOSTIC_INVALID守門不受影響。

本輪零真模型呼叫、零新claim。新分類不能證明probe-7舊回覆的語義，也未授權新的dispatch；來源 `0232f21131ba1c0300ada0a741659b23351c006a` 完整CI `36753103333`／唯一job `110016432836` 全27steps success。本機兩輪失敗仍保留，不由CI回填為本機通過。

### probe-8 最後一次單案診斷入口準備（2026-10-01）

使用者選定準備新入口，並確認只再做probe-8；取得結果後停止新增診斷入口，轉向修正prompt／工具策略或評估模型。準備不授權模型／credential呼叫；固定Free-only、Gemma4、synthetic unknown-cost，最多1 invocation／7calls，品質gate維持false。

| 沿用機制 | 原始必要條件 | 今日從零設計 | 決定與重評條件 |
| --- | --- | --- | --- |
| 永久claim／獨立grant與fixed descriptor | 每次授權有界、停止不可重開、封閉inventory | 固定新scope與共用lifecycle | probe-8薄wrapper；不用已消耗claim，授權政策改變才重評 |
| 原始profile pin／22表／Temporal pairedexecution | 本機單一信任邊界、歷史不可變、固定工具鏈 | bounded讀取＋不可變digest與專用版本adapter | 保存probe-7原泛碼；layout或Temporal格式改變需另定相容方案，不改pin |
| 十七scopes兩輪完整capture／owned lease | 多pool、合作writer鎖、原始retained scopes | 全量雙輪核對、逐dispatch重查 | 沿用；不宣稱跨schema原子快照，歷史可寫時重評一致快照 |
| quota與private failure分類 | 六工具七模型、usage先保存、unknown保守 | 原生迴圈＋固定SDK part type分類 | 不新增retry或parser fallback；診斷結果後轉策略，不再加入口 |
| tool_choice required／enable_thinking false | 已固定SDK profile、strict output | 明確request參數與wire regression | already protected：provider_sdk與synthetic native-loop test驗證required；不重複補開關，provider能力改變再評 |

- [x] probe-7 report／replay／raw22表／execution／原始6666248source雙輪一致，exclusive create ignored profile；不讀generation credential。
- [x] 新fixed grant／claim／replay registry與campaign authority consumers；上限1／7，先完整歷史後generation。
- [x] 完整十七scopes reader雙輪一致：52invocations／89calls／10unknown、1867661charged reference micros／318609observed tokens；剩48invocations／1132339reference micros，不是Free餘額。actual inventory dry接受且未建claim/report；profile-7 omission mutation預期1 failed／14 controls passed／841 deselected。
- [x] focused996、完整 `pnpm test:unit --maxWorkers=1` 3938 passed／122files（109.84秒）、typecheck／lint；獨立隔離collector integration18 passed／1 live skip，容器停止、volumes保留。design-review無findings；獨立correctness／privacy review無blocker。
- [ ] 新入口來源完整Fixture CI。
- [ ] 當次模型授權＋當下Free／完整歷史查核後才執行一次；unknown／限流／技術／安全／任務失敗即停。

原始profile bootstrap `/tmp/dive-trip-pin-probe7-history.mjs` exclusive create只執行一次，不可重跑。新reader `/tmp/dive-trip-probe8-carry-audit.mjs --verify`；inventory dry `/tmp/dive-trip-probe8-inventory-dry.mjs` 在候選claim open(wx)前攔截。profile omission在Vite程序內變異，不修改tracked source；rawprofile與身份不搬入public fixture。所有工具／quota／unknown與公開事件契約維持，本輪零generation credential讀取、零真模型呼叫、零新claim/report。

指令檔對帳：`git ls-files '*AGENTS*' '*CLAUDE*'` 僅tracked AGENTS.md，產品規則未變；ignored current context新增1處probe-8準備pointer與停止新增入口規則。design-review：NO DESIGN FINDINGS，改0／記0／提0／駁回0，已檢查固定claim、adapter、完整rawrows、雙輪capture、quota、execution與authority。

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
