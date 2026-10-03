---
title: 核心辦事回答採型別化事實引用與服務端呈現
date: 2026-09-27
status: superseded
superseded-by: 2026-09-28-python-temporal-core.md
tags: [decision, architecture, ai-agent]
---

# 核心辦事回答採型別化事實引用與服務端呈現

2026-09-28 由[Python／Temporal 核心決策](./2026-09-28-python-temporal-core.md)取代：D1–D4 回答契約持續有效，D5 的 ADK 選型改為 Python／Temporal；以下保留當時的理由與實作證據。

## Context

尚未上線的潛旅接案作品已用程式計價、交易與人工確認，但工具正確的小計3300仍被模型正文說成330。使用者要求可重構的治本方案，並於2026-09-27同意先記決策與計畫；拍板當時尚未實作。截至公開基線已完成離線接線及 demo 切換，真模型品質仍未通過，見 Result。

- `external`：目前無正式上線相容性承諾，使用者允許重構；自然語言調整行程與可展示互動仍是產品要求，不能以全部拒答達標。
- `external`：不能預訂、付款或提供潛水安全／可訂保證；既有免費層授權已消耗，本次不讀憑證、不送模型、不啟用付費。
- `inherited`：Google ADK TypeScript＋AG-UI、單一Agent及Domain交易；現在仍成立因它們分別處理執行／互動與業務規則，換框架不消除正文失真，使用者本次明確保留。
- `inherited`：所有權、版本、鎖定、人工確認、未知價格、用量與留存邊界；現在仍成立因防止越權與虛假完成，不是舊正文設計的相容負擔。
- `inherited`：舊schema／提示／自由正文不是不可改限制；僅保留歷史證據與使用者資料，不能以現有程式碼為拒絕重構的理由。

## Options Considered

- **A．自由正文＋工具資料＋應用驗證**：LLM生成自然語言，再做數字／引用／語意檢查；表達彈性與開放情境較好，但無法以有限掃描證明沒有單價混淆、未知當可負擔或假完成，模型評審也有成本與誤判。
- **B．結構化事實卡片＋自由正文（無舊碼時的通用基準）**：工具與程式負責事實，模型負責解釋，固定元件呈現；依[Google結構化輸出與應用驗證](https://ai.google.dev/gemini-api/docs/structured-output)、[AG-UI結構化狀態](https://docs.ag-ui.com/concepts/state)組合。不是宣稱唯一業界標準；適合容許敘述性誤差的產品，但正確卡片無法阻止旁邊正文說錯。
- **C．核心回答全部使用型別化意圖／引用與服務端呈現（選用）**：模型決定問什麼、查什麼、提出什麼方案；事實、結論與呈現由服務端驗證。可測試發布邊界，代價是封閉回答種類、模板維護與較少自由表達；資料錯誤及需求誤解仍需其他驗收。

- **D．固定workflow＋C的回答組裝層**：明確有限任務的另一baseline，依[Anthropic workflow建議](https://www.anthropic.com/engineering/building-effective-agents)使必要查詢與終態更容易列舉；代價是複合需求的分支與澄清膨脹，需證明其任務完成率優於有界動態Agent。

## Decision

- **D1**：採C而非A/B；核心辦事回合不保留任意text/HTML/Markdown出口，也不靠LLM分類「一般聊天」來豁免。澄清、比較、預算、衝突、提案與結果均有受控回答類型。
- **D2**：分離模型AnswerPlan、服務端Evidence及AcceptedAnswer。模型只交意圖／引用，不提交對外金額或成功結論；引用須綁正確owner/trip/run、版本、項目及current/candidate/committed語義。來源／工具自由文字不是可執行模板或權威指令。每種回答的必要證據及相反限制由服務端要求，不只驗模型挑出的引用。
- **D3**：使用既有Domain與transaction作唯一業務判準；單位、DEMO、來源、未知／排除費用及「是否可負擔」由程式連同內容產生，不給模型省略。完成訊息以committed receipt為準，保存成功與回合失敗可同時成立；回覆遺失從receipt冪等補建，不重做交易。
- **D4**：服務端接受並持久化後才經AG-UI公開；中間訊息、刷新、錯誤及重播同邊界。新寫入只用版本化投影；舊證據隔離唯讀、不重寫成新架構成功，不留舊正文執行fallback。
- **D5**：保留ADK原生工具／確認與AG-UI薄接線，不建自有loop或第二個審判Agent。先以離線探針驗結構化終態與限額；若SDK接線不成立，以可重現證據重評，不能放寬邊界。

## Rationale

- **D1–D2**：相較A/B，C把「模型必須抄對」改為「只能引用通過規則的資料」，也防止數字正確但類型／時點錯誤。代價是核心辦事語言較受控；Agent的價值保留在需求理解、工具選擇與方案互動，而非自由重寫價格。
- **D3**：不選新增獨立計價或文字語意規則庫，避免同一業務規則兩處維護。資料來源可信度與模型是否理解需求仍非schema可保證；Unknown與必要揭露強制呈現，不拿假完整答案換完成率。
- **D4**：不選先串流再撤回，因錯誤已對使用者可見；代價是等待完整驗證及維護投影版本。進度仍可即時顯示。未結案舊run先盤點並阻擋切換，不為清舊碼而刪資料或自動決定提案。
- **D5**：不選換框架、多Agent或強制加A2UI，因這些不替代事實驗證。ADK結構化輸出只是格式渠道，仍需本產品compiler；[Anthropic工作流實務](https://www.anthropic.com/engineering/building-effective-agents)支持按需保留簡單、可檢查的組合。不選D作本次控制流程：3300→330不能證明動態loop有問題，有界探索對複合需求仍有價值；代價是另驗漏查／提前停止。固定workflow若在同情境改善完成率，再重評，不因舊碼而保留。

## Expected Outcome

- 惡意或錯誤模型回應不能把自填金額、錯範圍引用或假完成發布為有效核心回答；每個關鍵欄位可追溯，未知與揭露不會被省略。
- 新回答刷新／跨程序重播保持原版本內容，不重呼模型或以新目錄重算；舊歷史仍可稽核。
- 分開衡量發布邊界與任務品質：安全的拒答不計成功；自然語言澄清、規劃及確認仍需端到端與後續真模型驗收。

## Result

- 公開基線已落地 AnswerPlan → compiler → AcceptedAnswer、同 session 最新成功 validationId gate、交易後固定 receipt／零 generation resume、保存先於 ACK 及不可變 replay；舊 live 仍唯讀。具體契約可取回 `git show f08f075:docs/model-adapter.md`；這是原 D1–D5 的實作，不另立同題 ADR。
- `2a3d3d5` 的同一 [fixture CI](https://github.com/Will413028/dive-trip-agent/actions/runs/36317342675) 記錄 3308 unit、388 integration、63 production browser，另 11 live／5 browser skip；未含專用 ADK／replay suite，不能宣稱目前 revision 重跑全綠。模型語意品質與公開部署仍未通過。

## Followup

- [ ] 依 `docs/release-evidence.md`「執行交接」完成原 Task 11–12 品質／部署／展示；新真模型驗收另定有界授權，原 claim／歷史 unknown 不變。

## Revocation Triggers

- 核心需求轉為開放研究／自由長文，有限回答類型無法支援時，先重評產品與保證範圍，不偷偷新增text出口。
- 來源變成即時價格／庫存或外部交易時，重評證據有效期、授權及交易界線。
- 有限workflow在相同核心情境實測較動態Agent改善任務完成率，或ADK終態／確認／重播無法在固定限額內滿足契約、成本不合理時，以證據重評接線或框架，不以盲目重試補洞。

## Review Notes

## Updates (2026-09-28)

離線重構已落地，修正過期 P0–P6 待辦及 SDD 未版控敘述；[公開文件基線 f08f075](https://github.com/Will413028/dive-trip-agent/commit/f08f0757aa43857fa6a78a1a3c275965e0220785)，品質與部署仍待驗收。

## Related

- **原始來源**：2026-09-27 使用者與 coding agent 當場拍板，本 ADR 即原始決策紀錄；本次另以已版控 SDD 核對實作結果。Will 於 2026-09-28 確認移除兩份 SDD；其完整 Git 取回命令及契約映射見[產品／工作台壓縮 ADR](./2026-09-19-curated-trip-workbench.md)。
- **壓縮對照**：spec §3／6／11、plan Goal／Global Constraints／Task 3／7–9 → 本 ADR D1–D5；提案資料、版本、匿名分享及分層驗收 → 產品／工作台 ADR D3–D7。
- [Google Structured outputs](https://ai.google.dev/gemini-api/docs/structured-output)、[ADK工具邊界](https://adk.dev/safety/)、[AG-UI State](https://docs.ag-ui.com/concepts/state)、[Anthropic Agent evals](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)。
