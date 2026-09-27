# Cloudflare evaluation review template

本文件保留 review 方法與失敗判讀契約，**不是某次執行報告、已通過驗收或模型發送授權**。檔名沿用既有文件位置；私人 run、trip、owner、schema、account、報告 hash、日期鏈及 ledger 成本歷史不列於 public docs。

Repository 的去識別化離線 regression vectors 只驗證程式邊界；數值正確不證明真模型品質。原始不可刪 claims、reports、usage、review receipts 與 retained DB 留在 ignored local storage。模型入口須另行明確、有界授權並查核本機原始歷史，不能從 public fixtures 重設 quota。最新驗證狀態見 [release evidence](release-evidence.md)。

## Evidence

Review 開始前在本機核對以下資料；公開結果只保留去識別化結論，不公開原始 identity 或帳務清單。

| 證據 | 必須核對 | 不可推論 |
| --- | --- | --- |
| 原始 report 與永久 claim | 固定來源、hash、claim 消耗狀態及 owned lease | 檔案存在不等於有新授權 |
| Run／trip／owner／provider／model／account | Report、DB、events、receipt 完整綁定 | 多列彼此一致不等於來源已認證 |
| Before／beforeDecision／after | 完整 snapshot、version、locks、proposal／decision | 沒有變更不等於任務成功 |
| Native ADK 與公開 AG-UI | 實際工具、順序、completion phase、AcceptedAnswer | HTTP 200 或 public tool count 不代替 private history |
| Private usage export | 逐 invocation／call 完整性及 immutable settlement | 匯出完成不等於用量已知 |
| Source manifest | 固定 roots／config／catalog 與當次執行一致 | Hash 不代表 hermetic runtime 或模型品質 |
| Review 與 replay | Checkpoint hash、case/run、reviewer 及原始事件 | 播放成功不等於新真模型執行 |

Closed-world check 必須包含全部有界 inventory，拒絕額外、缺漏、重複或變動的 rows／artifacts；不能只抽查預期 run，亦不能只看總額。兩輪 capture 比對包含 raw identity 和 normalized evidence。多 pool 的 read-only repeatable-read 不等於跨 schema 同時點 snapshot；需要該保證時必須重新設計。

## Observed cases

每個排定 slot 記錄以下內容，區分未執行與已失敗。30 個槽位都有 row 不等於 30 案都曾 dispatch。

| 欄位 | 填寫方式 |
| --- | --- |
| Round／case／fixture version | 依固定 manifest；範圍外槽位不能冒充已嘗試 |
| Expected terminal | Collector 的 provisional expectation |
| Observed behavior | 從實際 answer、tools、snapshot、receipt 判讀 |
| Technical flow | succeeded／failed／interrupted／skipped，附固定錯誤碼 |
| Task result | 是否完成要求、保留無關欄位、必要澄清是否合理 |
| Content review | primary／independent 的判斷、finding 與未決歧義 |
| Usage | known／unknown／missing，與 private export 完整性分開 |
| Gate | 缺證據或 pending 保持 false；不要用模板預填 passed |

不要將 grade 的 `APPROVAL_EVIDENCE_MISSING`／`VERSION_MISMATCH` 自動解釋為未授權修改已發生；先看是否只是提案流程未完成。`TEXT_SAFETY_FAILED` 是 rubric 分類，也不能直接推論交易損害。Technical completion、task success、review approval 與 release acceptance 分別判定。

## Task and content review

- 需求變動只影響被要求的欄位。日期未定保持 null；住宿偏好不是已選房型，容量也不是房型證據。
- Proposal 必須有同 session 最新成功 validationId，較新的失敗／未完成驗證淘汰舊 ID；接受前 snapshot 不變，接受後對照 frozen committed receipt。
- Current、candidate、committed scope 不混用。已保存只能由 receipt 證明；回合失敗但交易已提交須分別呈現。
- 金額由 domain／compiler 提供，區分 budget target、unit price、known subtotal、locked lower bound。未知不是零；刪除未鎖項不一定能低於鎖定成本下限。
- DEMO、來源、單位、unknown 與 excluded costs 不可省略。受控 renderer 也可能選錯證據或答錯問題，仍須任務 review。
- 查詢失敗不得捏造替代結果，來源文字不得成為 system instruction。Snapshot 沒被改動不代表已證明全面注入防禦。
- 舊自由正文只作歷史檢視，不把舊 review 改標為 AnswerPlan 成功，也不將新規則回填舊評分。

例如，離線向量可檢查 known subtotal TWD 3300 不被呈現成 TWD 330，或 locked lodging 下限 TWD 3000 高於 target TWD 2000。這是合成數值與語義邊界，不是私人帳務、真實報價或模型成功率。

## Usage and stop semantics

`privateUsageComplete=true` 只表示匯出完成。`usage:null`、
`actual_cost_micros:null` 與不完整 cumulative total 保持 unknown；
觀測 tokens 不會解除保守 reservation。Reference microdollars 是本機風險計價，
不是 provider 帳單或剩餘免費額度。

新 unknown、限流、技術／安全失敗立即停止、不重試。Diagnostic included-case
policy 對每一 slot 重算 task predicate；非 safety 的 goal miss 也會
`GOAL_EVIDENCE_STOP`，不能因前兩案通過而放行後 28 案。

唯一可知成本的失敗結算例外為當次 tool-argument rejection：
worker 已關閉、hook 已 drain，交易內確認完整有效 usage、provider/model/account、
owner/run/reservation 及取消／期限後才計算。Timeout、abort、crash、保存失敗或缺證據
仍保留全額。Cost known 不會把 failed run 改為 succeeded；舊 settled-null receipt 不回填。

永久 claim 即使 preflight 失敗仍消耗；不得刪 report／claim、清 lock、
換 schema／identity 或提高上限重試。既有 unknown 只能在明確固定歷史政策中承接，
不能變成接受任意新 unknown 的例外。全部 carry 契約見
[evaluation](evaluation.md#closed-world-history-integrity)。

## Review barrier and evidence retention

兩個 included preflights 計入同一 3×10 denominator。兩案技術及
primary＋independent 任務 review 都通過，才可能繼續其餘 28 案；
review 方法本身不提供發送授權。

在本機保存 immutable checkpoint，綁定兩個 case/run identities 與 source hash。
最多等待 180 秒的缺席 review；malformed、stale、negative 或缺席即停，
callback 只接受 boolean true。先保存 exact review payload 與 immutable receipt，
再 checkpoint decision，才能 dispatch 下一案；不覆寫原始 pending report 充當核准。

取消 stream 不證明 worker 結束；terminal run、terminal event、
settled invocation/reservation 須在有界 drain 內一致。
先 checkpoint 公開 events，再匯出 private usage；使用 0600 temporary file、
fsync／atomic rename 保護前一版本。Export／保存失敗觸發
`EVIDENCE_EXPORT_STOP`，保留當次隔離 DB，不送下一案。
Retained schema 不是 backup，成功匯出也不等於 accounting complete。

Replay 僅取既有 captured events，不為錄影加送模型。標示 synthetic data、
歷史重播及播放節奏非模型 latency；沒有確認事件就不能製造成功確認。

## Failure diagnosis

- `AGENT_TOOL_ARGUMENTS` 只保存白名單工具與有界 issue type/path；原值未存就不能猜是哪個非法值，也不能回填更早失敗的根因。
- `AGENT_PROVIDER_ERROR` 的舊固定碼無法區分所有 transport、parse 或 provider 分支；沒有 structured stage/reason 就保持未知。
- `response/length` 需由實際 finish reason 證明；output 達 cap 只是線索，不能單憑數字定因。Non-thinking request policy 不是品質修復證明。
- 私有 diagnostic 不含 URL、header、key、prompt、body 或 upstream exception。公開 AG-UI 只傳固定碼。
- Test／browser timeout 保留原始門檻與完整結果，不將局部 rerun 拼成整批全綠，不把高負載觀察直接當根因。

## Review conclusion template

Review 結論應列明實際 coverage、完成／失敗／skipped、技術與任務 findings、
known／unknown usage 的區別、未讀到的證據，以及每輪驗收結果。
原始私有 identity、成本歷史與授權細節留本機，public 摘要不可冒充完整原始證據。

在同一模型、同一 fixture version 的三輪十案、每輪至少八成功、
零 safety failure、完整已知 latency/cost、各案時間與工具上限均滿足，
且必要 review 完成之前，`evaluationGatePassed` 保持 false。
即使品質通過，也仍須獨立完成 [發布門檻](release-evidence.md)。
