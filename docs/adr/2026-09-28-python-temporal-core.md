---
title: Python 與 Temporal 接手核心執行並保留受控回答契約
date: 2026-09-28
status: active
supersedes: 2026-09-27-grounded-answer-presentation.md
tags: [decision, architecture, python, temporal]
---

# Python 與 Temporal 接手核心執行並保留受控回答契約

## Context

2026-09-27 的回答 ADR 選擇 AnswerPlan／Evidence／AcceptedAnswer 並保留 ADK。2026-09-28，Will 要求參考 whisky-discovery-agent，選定「Python 後端＋Temporal，沿用潛旅產品契約」。本決策取代原 ADR 的 D5 執行框架；原 D1–D4 在下列 D2 完整延續。

- `external`：使用者選核心對齊，保留 Next.js／AG-UI；未選帳號／部署平台對齊，下載只授權本輪必要依賴與隔離測試工具。
- `inherited`：限定目的地、匿名 owner、精確 minor units、null 費用、鎖定、人工確認、完整版本與固定分享；仍成立，因這是使用者選擇保留的產品契約。
- `inherited`：受控回答、quota、原始 claims／unknown 與 retained history；仍成立，因換 runtime 不改變事實來源或先前已消耗的授權。
- `inherited`：現行斷線會取消活躍 invocation，期限有界；仍成立，因本次保留產品契約。等待人工確認可持久保存，不延長模型執行期限。
- `inherited`：全 TypeScript、ADK、child-process IPC、原生確認 parser 不再限縮選項；尚未部署，無正式使用者不中斷切換承諾，但本機歷史仍需盤點。
- `external`：參考專案固定 revision 只有 Temporal bootstrap 探針，不能當作業務 Agent 已驗收證據。

## Options Considered

- **基準／A：模組化服務＋有界 Agent，必要時再加 durable orchestration**。沒有舊碼時，短互動可先採簡單服務；已有程式時對應整理現行 TypeScript／ADK。代價低，但自行維護等待／恢復邊界。[業界基準來源](https://www.anthropic.com/engineering/building-effective-agents)主張從簡單組合開始，按需要增加複雜度。
- **B：FastAPI／PydanticAI＋Temporal，保留 Next.js／AG-UI（選用）**。共同採 Python 模組化單體與持久執行，代價是雙語言契約、Temporal 維運與全面等價驗收。
- **C：B 加 Auth0、Workers／vinext、Oracle 部署**。一併規劃帳號與託管，代價是 owner 遷移及平台驗收，超出本次核心對齊。
- **取消語意子選項**：背景研究可採斷線只停止觀察，適合長任務；本案保留斷線取消，代價是須傳遞取消命令、撤銷寫入資格並驗晚到結果。

## Decision

- **D1**：選 B；API 與 worker 共用 Python 套件，按 catalog、trips、planning、sharing、identity、usage 模組劃分；domain 不依賴 framework。PydanticAI 用官方 TemporalDurability，無第二套自製 Agent loop。
- **D2（延續原 D1–D4）**：模型只能提出 strict AnswerPlan 意圖與本回合 Evidence 引用。Evidence 綁 owner／trip／run／baseVersion 及 current／candidate／committed 範圍；正文、金額、HTML、保存結論不由模型提供。Domain 與交易產生費用、單位、DEMO、來源、未知／排除費用及鎖定限制；committed receipt 決定完成。AcceptedAnswer 保存後才發布版本化 AG-UI 投影，相同 answerId 不可改內容；重播不重算新 catalog，未知版本不退回原文。
- **D3**：Temporal history 負責執行位置，PostgreSQL 負責業務與帳本。穩定 workflow ID／request hash 連結非原子的 DB 接受與 workflow start；狀態不明先對帳，不能建立第二個 executor。
- **D4**：模型 activity 設 maximum_attempts=1，SDK／transport／結構修正也禁止自動重送。模型送出前保存 call-start、用量保存後才交出結果；遠端是否完成不明即 fail-stop 並保留預留成本。7 次模型／6 次工具上限不變。
- **D5**：人工 apply／reject 在產品交易內驗 owner、run、proposal、decision、有效期限及版本；單一交易直接完成並編譯固定 receipt，不建立 resume executor lease、不呼 Agent。模型執行 fence、quota reservation 期限、原始 bound snapshot／catalog 與最新成功 validation attempt 規則不變。
- **D6**：斷線撤銷活躍執行的寫入資格並要求有界取消；晚到模型結果不能再入庫。新 runtime 不接續舊 ADK run、不重寫歷史 unknown；同一資料集只允許一個寫入 runtime。
- **D7**：採持久刪除工作。請求先封鎖行程與分享並顯示「刪除中」，清除 Temporal history 與產品內容後才標示「已刪除」；清理中斷可由持久進度重試。Quota receipts 與受保護原始評估證據仍依既有規則保留，不宣稱跨 PostgreSQL／Temporal 原子刪除。

## Rationale

- **D1**：A 是本案較低成本路線，兩份獨立草稿皆指出僅為展示整理時不需 Temporal；本次仍選 B，因 Will 明確選擇核心技術與持久執行對齊，接受重建與營運代價。C 的帳號／部署不是此目標所需，未納入。
- **D2**：換框架不會消除模型誤報金額；保留 compiler 是重新評估後仍需要的產品發布邊界。代價是回答類型與模板維護，不能據此宣稱模型理解或來源品質已通過。
- **D3–D4**：不將 Temporal replay 當外部模型 exactly-once，也不以 history 代替不可刪帳本；模型結果與 activity completion 之間仍可能故障。代價是保守停止及自有產品對帳，不能靠 unlimited retry 補洞。
- **D5–D6**：Whisky 背景任務與長等待後重查資料不適用已確認的潛旅提案；若重查並合併新 catalog，會改掉使用者審閱的方案。保留原始 bound inputs 與斷線取消，代價是更嚴格的 TTL、fence 與過期拒絕。
- 原 ADK parser、schema lock、ReceiptOnlyModel 不照搬；新路徑以有序產品證據、獨立執行儲存與不建立 Agent 的確認用例滿足相同目的。舊證據唯讀相容另依盤點決定。
- **D7**：原 ADK 表可加入產品 DB transaction，Temporal history 不能。Will 在比較同步等待與持久清理後選後者；代價是明確的刪除中狀態、排程與清理故障監控，不能只回成功後依賴記憶體 background task。

## Expected Outcome

- Web 與 Agent 共用 Python 業務權威；既有產品與回答反例在新後端同樣拒絕。
- worker 重啟後能讀回已保存步驟及人工等待，零模型確認不重做版本交易；未知模型呼叫不重送。
- 以完整離線等價、故障測試與獨立 design review 判定切換資格，舊 CI 不當新 runtime 驗收。

## Followup

- [x] 核心遷移已於2026-09-29完成離線驗收、本機切換與新版fixture CI；原demo升020、備份還原及持久重啟通過，受保護歷史不變。核心實作02d461c、CI修正ab80b3f已推送；詳 `docs/architecture-refactor.md`，唯一後續順序仍見release evidence。
- [ ] 模型品質與部署仍依主清單 Task 11–12；本次技術選型不授權 live 呼叫或部署。

## Revocation Triggers

- 官方 durable 整合不能維持有界取消、保存先於公開或零模型確認 → 以重現結果重評接線／架構，不放寬契約。
- 需求變成背景研究、跨裝置帳號或即時價格／庫存 → 分別重評取消、identity 與 evidence 時效。
- 維運成本超出個人作品的可承受範圍 → 比較 A 與實測收益，不因已遷移就繼續追加基礎設施。

## Review Notes

- 2026-09-28 執行切片 fresh review 移除照搬的 ADK resume lease；確認已沒有跨 transaction executor，直接使用 row lock＋原子提交。模型 start lease 保留；這是 D5 的機制落實，非延長模型期限。

- 2026-09-29 整體與切換 fresh design-review均無新發現。Correctness另修舊active run占用新executor位置；新增migration而不改舊rows/events，保留每個executor的active唯一性，UI與應用准入一致。

## Related

- **原始來源**：2026-09-28 使用者與 coding agent 當場拍板；本 ADR 即原始紀錄，無外部來源文件。兩份 fresh 唯讀草稿的基準、取消、retry ambiguity、bound catalog 與單一 executor 論點均已回應。
- [被取代的回答／ADK 決策](./2026-09-27-grounded-answer-presentation.md)；[持續有效的產品契約](./2026-09-19-curated-trip-workbench.md)。
- 參考架構可在 whisky-discovery-agent repo 取回 `git show a9bb3bba7847bc5054d828c73c0936225cdd6b6c:ARCHITECTURE.md`；Dive 遷移前契約可取回 `git show ac21cb2f1478f0f5fcfb69be7aa2adfa90454fdf:AGENTS.md`。
- [PydanticAI Temporal](https://pydantic.dev/docs/ai/capabilities/durable_execution/temporal/)、[Temporal retry policy](https://docs.temporal.io/encyclopedia/retry-policies#maximum-attempts)。切換期另發現 executor 退役與 active slot 的跨層邊界問題：退役 executor 後，舊 active 狀態仍跨 SQL／唯一鍵／UI 阻擋新工作。
