---
title: 精選潛旅資料與可確認、復原的互動工作台
date: 2026-09-19
status: active
tags: [decision, architecture, ai-agent]
---

# 精選潛旅資料與可確認、復原的互動工作台

## Context

2026-09-19 核准獨立潛旅互動作品，展示需求變動如何可靠保存；2026-09-28 壓縮現存設計與主計畫。作品可操作不等於市場成立、真模型品質通過或服務已部署。

- `external`：本輪是文件壓縮，未授權模型發送、付費、部署或擴大產品；第三方資料與素材仍需合法使用來源。
- `inherited`：小琉球／綠島／墾丁、每趟一地、1–6 人、2–7 天、TWD、匿名體驗及不預訂／不背書安全；核准的第一版展示範圍未變，因此仍成立，不是正式用戶的相容性限制。
- `inherited`：鎖定、人工確認、完整版本、未知費用、固定分享與有限用量；仍防止越權、誤導及意外公開，不能因清理文件而解除。
- `inherited`：Next.js／TypeScript／PostgreSQL 與 ADK／AG-UI 是已採用技術；本次未改執行模型。來源沒有 Web stack 的完整比較，不補造選型史；有界單 Agent／固定 workflow／多 Agent 的理由沿用[回答 ADR](./2026-09-27-grounded-answer-presentation.md) D5。

## Options Considered

原文明示精選／即時探索、單／多 Agent、明確操作／拖曳的取捨；其餘以下標為回溯分析，不冒充原作者已逐項比較。

- **資料 A（選用）／B**：人工精選結構化目錄便於查核與重現，但覆蓋窄且需維護；即時全網探索更廣，卻增加外部依賴、資訊新鮮度及價格／庫存的不確定性。
- **流程基準**：無舊碼時，明確任務可先用固定 workflow，複合需求再考慮有界單 Agent，多 Agent 用於可分拆任務；[Anthropic 的 workflow／agent 比較](https://www.anthropic.com/engineering/building-effective-agents)支持按需求增加複雜度。本文不另推翻既有回答 ADR 的有界單 Agent 決定。
- **操作 A（選用）／B**：對話加明確移日／替換／移除／鎖定，易支援手機與無障礙；拖曳較自由但增加互動成本。兩種入口共用狀態，不能各存一份行程。
- **保存（回溯分析）**：只改目前資料最省，但不能完整復原；差分／event log 可追溯但需重播；完整快照直接保存當時依據，代價是重複儲存。[node-postgres transaction](https://node-postgres.com/features/transactions)支持單一 client 內交易，不自行保證跨服務 exactly-once。
- **權限／分享（回溯分析）**：會員利於跨裝置但提高試用門檻；匿名 session 易開始但不保證找回編輯權。即時分享自動更新，固定快照則需重建連結，換得後續編輯不意外公開。
- **驗收（回溯分析）**：fixture-only 便宜可重現但不證明模型理解；live-only 接近模型行為但昂貴且難穩定重現交易反例；分層驗收多維護一套情境與 review，能分別回答軟體、模型與營運是否合格。

## Decision

- **D1 = spec §1–3、§8；plan Goal／範圍**：精選目錄與獨立 Web 作品；不先建共享平台，不使用其他專案程式／資料／帳號／部署。超界需求明示；不做預訂、付款、代寄、保證名額、跨地最佳化、無限制爬取、多人同步、正式會員、語音、原生 app 或適潛／醫療／保險／安全決策。
- **D2 = spec §2、§4／4.1；plan Task 6**：桌面對話／工作台並列，手機切換保留草稿；同一結構化行程含需求、比較、每日卡、地圖、預算及提案。只追問影響下一步的條件；日期未定明示，經驗只是自述；地圖只用核對座標，不造路線／時間。第一版採明確操作，不拖曳。
- **D3 = spec §4.2、§5–6；plan 共用契約／Task 1–3**：Domain 驗規則、鎖定與容量並按人／房晚／固定單位及整數 TWD 分計算。未知為 null＋原因，只給已知小計與待確認；來源 URL／查核時間、DEMO／事實／估算、排除費用不得省略。圖片需授權，外部正文是資料；Agent 不可藉父項移除、改日期／天數／人數繞鎖。
- **D4 = spec §4.2–4.4、§6.1；plan Task 4–5／7**：提案列全量連帶差異、費差、鎖定與未解問題，明確確認才套用，拒絕不改。交易核對 owner、baseVersion、proposal、requestId 及 run lease；stale 要重算，重送取既有結果。TripVersion 保存需求、活動、鎖定、費用及引用完整快照；復原建立新版本，地圖／預算一致恢復且對話留復原事件。
- **D5 = spec §4.4、§6.1、§7；plan Task 4／10**：server-issued session＋HttpOnly cookie，每次讀寫驗 owner／同源／輸入；不保證跨裝置匿名恢復。分享先預覽白名單脫敏固定快照，以不可猜測 token 唯讀存取、可撤銷、不隨後續編輯更新；不含對話、session、聯絡與工具日誌。持有連結者可讀，noindex 非保密。匿名預設 30 天、告知期限及刪除入口、到期分享失效；技術日誌不複製完整私人輸入或內部思考。
- **D6 = spec §6.2–7／11；plan Global Constraints／Task 7–9**：以已保存工具事件呈現進度，刷新依最後保存狀態，中斷不得偽裝成功；寫入回應不明查 committed result。初始 session 每日 20 回合、最多 6 工具／60 秒；現行 logical run 另限 7 次模型，resume 零 generation。並用 IP／concurrency／全站預算防線，未核准預算不開 public LLM；未知用量保留預留成本。原 spec 的唯讀重試許可已受現行 fail-stop 約束，不能據此重啟停止 claim 或不明 invocation。
- **D7 = spec §1／9–11；plan Task 1／6／8／11–12、驗收／交接**：domain unit、真 PostgreSQL integration、fixture browser、真模型品質與 hosted acceptance 分別驗收；固定回應、review pending、skip 不冒充模型成功。Public vectors 不代表私有歷史或剩餘 quota，原始 claims／reports／usage／retained DB 不刪改。M1→M6 依賴與 Task 編號保留；剩餘工作的唯一順序移入 release evidence，平台遷移仍暫停。三組 demo 只重設目前 session，影片／案例頁不代替可操作公開 demo。

核心 AnswerPlan／Evidence／AcceptedAnswer、validationId、receipt-only resume、save-before-ACK、不可變 replay 與原生 ADK 由[既有回答 ADR](./2026-09-27-grounded-answer-presentation.md) D1–D5 承接，沒有第二份同題決策。

## Rationale

- **D1–D2**：相較即時探索，有限目錄先驗證「理解需求並可靠操作」；代價是覆蓋及自由度較小，且尚需證明真模型能完成任務。單 Agent 不把協調成本帶進第一版，並未因框架存在就排除固定 workflow。
- **D3**：不選讓模型自行加總或用自然語言判鎖；單位、未知及來源可機械驗證，代價是 catalog／schema／查核維護。來源真實性、自述資格及需求理解仍不能由型別保證。
- **D4**：確認、版本衝突、冪等與復原各解不同問題，不能只留下「可 undo」。短行程的完整快照相較差分重播容易維持跨畫面一致，代價是重複資料；這是本輪回溯設計推論，非捏造原始選型辯論。
- **D5**：匿名降低試玩成本，代價是無跨裝置編輯恢復承諾；固定分享避免新內容隨編輯外流，代價是新版需再分享。期限與可撤銷不把 bearer link 變成秘密，也不證明 hosted 清理已部署。
- **D6–D7**：不選只依 cookie 或供應商事後帳單控費；保守預留會讓失敗也消耗可用額度，但不把未知當免費。分層驗收增加維護，換得技術通過、語意成功、資料品質及營運完成不互相冒充。

## Result

- 可用 `git log --oneline 2a3d3d5..f08f075` 查公開初始基線後的實作／文件沿革；不從檔名推定完成。現行產品契約在 README，完整 A1–A14、Task／M 階段及五項交接在 release evidence。
- Release evidence 記錄 `2a3d3d5` 的同一次 [CI](https://github.com/Will413028/dive-trip-agent/actions/runs/36317342675)：3308 unit、388 integration、63 browser，另 11 live／5 browser skip；不能推為 `f08f075` 或本次壓縮重新跑過全套。真模型品質與公開部署仍待驗，本輪僅整理文件。

## Followup

- [ ] 接續 release evidence 的唯一交接順序：真模型品質、CI action runtime 維護、公開環境／維運及新版展示；不另開 roadmap，不從壓縮取得執行授權。

## Revocation Triggers

- 擴為即時報價／庫存、跨地規劃或外部預訂交易時，重評資料新鮮度、授權、計價及交易邊界。
- 需要跨裝置／協作、長期保存或即時共享時，重評匿名身份、完整快照成本與分享語義。
- 相同情境證據顯示固定 workflow 更能完成任務，依回答 ADR 重評；不以正文錯誤單獨推翻動態工具選擇。

## Review Notes

## Related

- [核心回答架構](./2026-09-27-grounded-answer-presentation.md)。
- **Provenance**：兩份來源均已追蹤；2026-09-28 fetch 後 `origin/main=f08f0757aa43857fa6a78a1a3c275965e0220785`。Will 明確確認移除上述兩檔；移除後 `git status --porcelain --untracked-files=all -- docs/superpowers` 只列兩筆 D，目錄已刪除且無倖存副本（限目前 repo 工作樹）。Git 固定 SHA 仍可取回原文；ignored 本機備份未觸動。
- Spec 取回：`git show f08f0757aa43857fa6a78a1a3c275965e0220785:docs/superpowers/specs/2026-09-19-dive-trip-agent-design.md`。
- Plan 取回：`git show f08f0757aa43857fa6a78a1a3c275965e0220785:docs/superpowers/plans/2026-09-19-dive-trip-agent.md`。
- 來源無獨立編號 ADR 清單；以上 D1–D7 按原章節映射。Spec §1–11 含 §4.1–4.4／6.1–6.2、A1–A14、plan Task 1–12 與五項交接已逐項對照落點；A／Task 為驗收與實作編號，不假裝成額外架構選擇。
