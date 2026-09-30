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
| P4 依證據修正 | 一般任務指引已修正，待新 CI／模型驗證 | P3 | 必要修正、合成回歸與新 revision gates |
| P5 Task 11 品質驗收 | 待做 | 技術流程可用、當次完整 campaign 授權 | 30 案、內容雙審與品質 gate |
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

- [ ] 核對 tool schema、模型可見指引與 validator 是否一致，測試一個可重現假設。
- [ ] 若有可證明缺陷，做最小修正與有辨別力的合成回歸；保留 strict validation、batch 整體拒絕、無未知重送及私有資料邊界。
- [ ] 檢查所有 consumer，跑 affected checks；大幅修改執行 design-review。
- [ ] 記錄修正後仍未驗證的模型效果。若需新 live，比照 P2／P3 另建 scope 與授權；不設無限 probe 迴圈。

**驗收**：離線證據支持修正，且來源對應的 CI 通過。無可證明缺陷時記錄結論與下一個待決假設，禁止猜值、放寬 gate 或回填歷史。

P4 當次實作：`backend/src/dive_trip/application/agent_runtime.py` 的共用 Agent instructions 補上一般任務選擇：查詢既有行程／費用使用 read tools 與本回合 evidence 的 AnswerPlan；未知費用不能推定預算足夠；只對使用者要求的候選修改／比較驗證，不為查詢捏造修改或建立無差異提案。沒有新增 no-op Domain 拒絕或 case-ID 特例，schema、工具／模型上限與 grade 不變。指引遺漏是可觀察事實，但補指引能否改善模型選擇仍是待驗假設，不宣稱根因已證實。既有 strict AnswerPlan、工具契約及 SDK 合成回歸 59 passed，Ruff／strict mypy 通過；Web typecheck／lint 通過。新的完整 CI 仍待 commit／push 後查核。

P9 案例頁已對齊新架構與三個 probe 的實際結果，移除舊 ADK 成功套用為新版的敘述；隔離 fixture stack 的桌面與 390px 手機呈現已檢查。網站尚未公開，影片與正式驗收仍未完成。

## P5 Task 11 真模型品質驗收

- [ ] 依 [evaluation](evaluation.md#coverage-and-acceptance) 固定 10 情境 × 3 rounds、fixture／model identity、invocation／model call／額度總上限與停止政策，取得新的完整 campaign 授權。
- [ ] 完成新版入口與歷史 preflight；先執行兩案，依 [review 方法](evaluation-review.md) 做 primary／independent 內容與任務審查，通過既有 gate 才繼續。
- [ ] 每案核對 before／proposal／decision／receipt／after、AcceptedAnswer、native tools、用量與目標完成；pending 不當 passed。
- [ ] 保存原始 report、review receipts、replay、帳務與來源；確認 coverage 與所有 gate，再更新品質結論。

**驗收**：恰好 30 個唯一 live attempts；每 round 至少 8 成功、零 safety failure；每個 attempt latency／cost 已知、latency 小於 60 秒、工具至多 6 次，並滿足既有逐案與 review gates。失敗／取消／逾時保留分母，skipped 不冒充已執行。單案診斷、fixture 或舊模型成功不得抵數。

## P6 CI Actions runtime 維護

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
