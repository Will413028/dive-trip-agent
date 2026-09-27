# 核心回答事實邊界重構計畫

狀態：此處保留 P0–P6 離線重構里程碑，P4 真模型語意品質仍未通過。既有擴大回歸為 3141 unit passed、整批 3519 passed／10 integration timeout／11 live skipped，browser 54 passed／9 failed／5 skipped；本輪 cleanup 的 unit／affected integration／static 通過不能替代完整缺口。CI paused、0 runs、未公開部署，各次驗證分列於 [release evidence](../../release-evidence.md)。舊 live 維持唯讀。

本計畫是 [既有主計畫](2026-09-19-dive-trip-agent.md#執行交接) Task 11 品質缺口的子計畫，不另建專案 roadmap。主計畫保留優先順序；本文件只追蹤本次重構的步驟與驗收。

## 目標與邊界

消除「工具算對、模型改寫後對外說錯」的路徑，並涵蓋同類的單價／總價混淆、偏好當事實、未知費用當可負擔、候選修改當已保存。

- 保留單一 Google ADK TypeScript Agent、AG-UI、Next.js、PostgreSQL；不自建 Agent loop，不引入第二個審判模型或通用 Agent/UI 平台。
- Domain 計算、所有權、鎖定、版本、原生人工確認及帳務仍使用既有實作；不複製第二套業務規則。
- 核心辦事回答採結構化意圖／引用與服務端呈現。模型不產生對外金額、業務結論或任意正文；提示只教模型怎麼用契約，不作保證。
- 本計畫描述離線架構與驗證，沒有模型或部署授權。真模型入口另需明確有界授權、本機原始歷史查核及既有 quota。
- 不宣稱資料來源一定正確、推薦一定合意或模型永不誤解；來源治理、模型能力與發布仍由原主清單驗收。

## 決策摘要與現況

採「有型別的事實引用＋服務端驗證／呈現」，而非自由正文後檢查，或正確卡片旁仍保留任意正文。代價是回答類型、模板與版本需要維護，開放式表達範圍較窄；收益是關鍵事實不用依賴模型複述正確。

控制流程另是一個維度：固定workflow加同一回答compiler也能成立。本次保留有界ADK動態工具選擇，不把一次正文失真擴大成必須重寫Agent控制權的證據；複合需求仍需探索能力。代價是必須另驗漏查、錯選證據與提前停止；若主要任務實測固定workflow更好，再以相同情境重評，而非因現有程式碼難改而保留。

重構前 `worker.ts` 將 `part.text` 直接投影成公開 AG-UI text；`ChatPanel.tsx` 直接顯示。`model-guard.ts` 僅驗工具參數、限額與模型格式。此次正在移除此公開路徑，不能用尚未完成的接線代表已驗收。

離線反例保留「工具已知小計 TWD3300 被模型說成330」的失敗模式，不公開私人 campaign 日期鏈、帳務或識別。原始不可刪 claims／reports／usage 留在 ignored local storage，不回改失敗、不從 public fixtures 重設 quota。

## 目標資料流

```text
自然語言 → ADK 理解／工具選擇 → 既有 Domain 與交易
                                  ↓
                        服務端產生有範圍的證據
                                  ↓
模型 AnswerPlan（意圖＋引用）→ 驗證／編譯 → AcceptedAnswer
                                              ↓
                                 持久化 → AG-UI → 受控元件
```

### 三個不同信任層的契約

| 契約 | 產生者與允許內容 | 必要限制 |
| --- | --- | --- |
| Evidence | 執行過的工具、固定 snapshot/catalog、已提交的交易；型別化事實與來源 | 私有綁定 owner/trip/run、snapshot/version、current/candidate/committed scope、tool call/validation；不是模型或前端可自行註冊 |
| AnswerPlan | 模型選擇回答類型、項目／證據引用、有限的說明代碼 | strict schema；不接受 amount、成功狀態、任意 text/HTML/Markdown/URL；引用 ID 不是授權 |
| AcceptedAnswer | 服務端驗證並解析引用後的公開投影 | schemaVersion、answerId、內容與必備揭露；不含 token、owner、私有帳務或原始 ADK state |

第一版回答類型覆蓋：必要條件澄清、既有需求確認、目錄選項／比較、目前／候選預算、衝突說明、待確認提案、已套用／拒絕 receipt、不可支援與失敗。實作以 discriminated union 與純函式 renderer 表達，不做任意可執行模板語言。

澄清以 field/question code 選擇受控問句，事實以 reference 顯示，差異來自 proposal。即使模型把意圖誤分類到另一回答類型，也沒有自由正文出口；不得僅依 LLM 的「這是一般聊天」分類解除限制。全新的開放旅遊聊天不在此次範圍。

### 必須成立的不變量

1. 所有對外的關鍵值與結論來自服務端；模型只提引用或方案。單價、目標預算、已知小計、鎖定下限不能互換。
2. 金額沿用安全整數 minor／TWD domain；未知維持 null，DEMO、來源、單位、排除費用與未知限制不可由模型選擇省略。
3. 有未知／排除費用不能呈現全程可負擔；鎖定下限超預算時的結論由既有規則決定，而非模型的 rationale。
4. 證據必須屬於正確 owner/trip/run 與版本／候選；跨使用者、跨run、過期或被新驗證取代的引用拒絕。歷史顯示可保留舊版本，但不可當作現在的證據或寫入授權。
5. 「已保存」只能來自 committed receipt。transaction已成功但後續回合失敗時，分別顯示「資料已保存」與「Agent回合未完成」，不得假裝回滾或全部成功。
6. raw model text／tool自由文字不進新核心 UI、公開 SSE、刷新 API 或新重播。未驗證結果不先串流再撤回；只有可信進度事件可先顯示。
7. 持久化成功才 ACK／公開；同一 answerId 冪等，重播使用已接受投影，不重呼模型或用新catalog重算舊答案。
8. 引用或 schema 錯誤顯示固定未完成訊息，不修補數字、不退回原文、不自動重試。UI 防護不能替代服務端邊界。
9. 每種回答的必要資訊由服務端規則決定，不只核對模型挑出的引用；預算／比較須保留同scope的未知、排除及相反限制。不得以部分候選推論「最便宜」；沒有比較集合與成立條件就不用該結論。數字正確但答錯問題，仍由獨立任務品質評估判失敗。

## 執行順序與驗收

### P0 — 基線與 ADK 結構化終態探針

- [x] 核對主計畫、source manifest 與本機原始歷史，保留精確修改範圍的可回復基線及平行變更；public vectors 不代替私有 provenance。
- [x] 以現有 native ADK＋synthetic BaseLlm 測試 `outputSchema` 搭配工具及原生確認，禁止fetch／環境檔loader。查核本機 `@google/adk@2.1.0` 的 `set_model_response` fallback與skipSummarization，不照抄Python能力。
- [x] 優先使用框架既有結構化終態；完成格式化不能多加一次修正文案的模型呼叫。內部final-response tool也須納入allowlist、strict schema及既有工具／模型限額，不偷偷排除計數。
- [x] 先驗start澄清、read→answer、validate→confirm→resume、已保存終態重播。若原生路徑與契約不相容，停止該接線並在本節記具體證據與替代方案，不暗加第二套loop或raise限額。

改動定位：`src/agent/model-guard.ts`、`src/agent/worker.ts`、`tests/unit/agent-policy.test.ts`、`tests/integration/agent-runtime.test.ts`；新增探針測試只在既有tests目錄。

出口：離線證據證明工具限制、確認與結構化終態能共存；若有會改架構的真trade-off，先回到決策，不能勾後續完成。

### P1 — 純資料契約與回答編譯

- [x] 在既有 `src/domain/` 增加 shared answer contract；在 `src/agent/` 增加 evidence resolver／answer compiler。DOM／React與ADK不進domain，契約不import供應商。
- [x] 定義上述三契約；renderer從Evidence產生數字、語意標籤及必備限制，不讓AnswerPlan自帶呈現數值或切換單位。
- [x] 以既有calculateBudget、buildProposal與budget evidence helpers供值；合併重複formatting，不另寫價格計算。每種回答定義必要證據與揭露集合，不能讓模型只挑有利項。
- [x] 先寫3300→330及1000→100的回歸；加入跨範圍引用、合法ID錯類型、未知／排除費用、DEMO、目標預算、偏好非房型、鎖定下限及惡意來源反例。

出口：對任何可接受AnswerPlan，所有關鍵顯示欄位均能追溯到相符Evidence；拒絕不等於任務成功。證據來源的原始標題／label是資料，只以受控文字顯示，不可變成模板或結論。

### P2 — 工具證據與單一執行路徑

- [x] 工具執行後建立型別化Evidence；只接受真實執行結果，不能從模型傳入的同名JSON或使用者訊息建證據。
- [x] 在綁定的ADK session中保存／還原必需的Evidence；優先利用既有durable tool事件，不同時維護兩份可變事實帳本。無法從事件可靠重建時，先用測試證明缺口再決定最小持久化變更。
- [x] `worker.ts` 接收結構化AnswerPlan，經compiler才產生公開回答；移除直接project模型正文的路徑，包含工具前中間文字及error/replay分支。
- [x] 提案與決定訊息由產品proposal／receipt建立；保留原生confirmation及產品交易責任，不讓完成文案決定run/transaction狀態。

改動定位：`src/agent/tools.ts`、`budget-evidence.ts`、`prompt.ts`、`model-guard.ts`、`confirmation.ts`、`worker.ts`、`fixture.ts`。

出口：固定fixture與各provider adapter都走同一輸出契約；沒有provider特例或默默回傳舊文字的fallback；7 calls／6 tools與deadline不放寬。

### P3 — 持久化、公開投影與重播

- [x] 擴充 `runtime.ts` IPC及 `chat-http.ts` 服務端接收端，驗證schema／run binding後才保存與發送；私有Evidence／accounting不進AG-UI。
- [x] 新回答用單一版本化公開事件 `CUSTOM: dive_trip.answer.v1` 承載AcceptedAnswer；沿用run event順序、lease及ACK。不得同時維護一份可分歧的模型text答案。
- [x] 優先在既有 `agent_run_events` 保存不可變投影（含template/schema版本），不為純顯示另建event sourcing平台。證明必要才新增最小migration；舊row不自動蓋新驗證章。
- [x] 覆蓋保存前／後中斷、ACK遺失、重複事件、晚到worker、renderer升版與重啟接續；交易成功但AcceptedAnswer未保存時，從既有receipt冪等補建，不重新套用或讓模型宣告。新renderer不得以現在資料悄悄改寫既有回答。

改動定位：`src/server/run-store.ts`、`src/server/chat-http.ts`、`src/agent/runtime.ts`及受影響integration tests。

出口：重播零模型呼叫、同answer只保存一次、舊證據不漂移，成功與已提交／回合失敗可分辨。

### P4 — 工作台與呈現一致性

- [x] `ChatPanel.tsx`只接收版本已知且schema合法的AcceptedAnswer，新增受控回答元件；沿用既有ProposalPanel與Domain資料，不以LLM生成HTML／React。
- [x] 聊天與行程預算使用同一格式化／語意函式；候選與目前版本標籤必須可見。分享仍只引用經確認脫敏快照，不加入對話或內部Evidence。
- [x] 明確顯示「查詢中／待確認／已套用／拒絕／回合未完成」，未知event版本顯示不支援且不降級顯示raw內容。
- [x] 桌面／手機離線驗收費用、比較、澄清、人工確認、拒絕、刷新與錯誤；新回答／刷新還原會定位最新已接受回答，不把藏在scroll容器外的receipt算可見。fixture只有明示有限腳本，不宣稱任意自然語言能力。
- [ ] 真模型語意品質仍沿用主計畫Task 11，非本次offline切換的通過項：驗證使用者能自然語言改需求，不能以全面拒答通過；固定模糊／複合需求分開記任務完成、不必要或重複澄清、延遲及呼叫數。renderer安全不能抵銷錯解「兩人／兩房」；未啟用真模型、不把synthetic結果算完成。
  - 真模型品質仍未通過，provider failure／unknown usage 不因 offline compiler 安全而解除。後繼入口的技術上限為30 starts＋9 proposal-only resumes＝39 invocations、最多210 calls，先兩案技術及雙審通過才接28案；這是政策，不是發送授權。詳見 [evaluation](../../evaluation.md#real-model-entry-requirements)。

改動定位：`src/components/workbench/ChatPanel.tsx`、`AcceptedAnswer.tsx`及既有budget/proposal元件；`tests/e2e/chat.spec.ts`等既有工作台測試。舊`AssistantMessage.tsx`已於P5刪除。

### P5 — 評估相容與舊路徑退場

切換契約：舊 `workbench_live` 保留為唯讀歷史，離線 `workbench_demo` 使用新版；不得自動接受、拒絕或接續舊提案，也不改寫歷史用量。切換前核對未完成 run 與 pending confirmation；保留舊狀態，不以新 schema 重設 quota。

- [x] 新collector／review packet加入AcceptedAnswer與引用一致性檢查；語意任務完成率另判，不能因renderer安全就自動把textReview／quality gate設passed。
- [x] `evals/replay-bundle.ts`為新格式明確版本化；舊report、receipt、claim、replay與歷史unknown不改寫、不轉成新架構成功證據。舊錄影證據維持原文與失敗標示，不作新核心UI的fallback。
- [x] 切換前唯讀盤點未完成舊run與pending confirmation；舊 live 保留，僅切換無未結案 run 的 demo，不自動完成／取消／刪除。
- [x] 新writes只走新契約；舊資料僅隔離唯讀，不保留可執行舊Agent分支。移除失去用途的提示補丁與模型text投影測試，改測真正的邊界；保留仍必要的來源不可信與工具限制。
- [x] B3清理：移除已無產品 caller 的舊檔`src/components/workbench/AssistantMessage.tsx`及其專屬測試引用；原始文字不外洩的回歸改測產品實際使用的`EventMessages`，保留plain text／Markdown／HTML／長文字反例。程式與測試已無舊元件引用；基線備份保留，不動歷史資料。

出口：沒有可繞過新compiler的runtime、public event或恢復路徑；舊資料仍可稽核；未變更歷史評分或帳務。

### P6 — 整合驗證與交付

- [x] 跑完整unit、完整offline integration、typecheck、lint、production build、離線ADK確認／恢復及桌面／手機E2E；synthetic provider固定且禁外網模型。
- [x] 加入結構化schema錯誤、串流早洩漏、tool自由文字注入、外來／過期引用及金額標籤互換的對抗案例，完整記錄失敗而非只報最後通過數。
- [x] 重構的 correctness／design review 與重大 finding 修正已完成；B3 舊 renderer 清理以產品實際邊界取代其專屬回歸。既有里程碑審查不代表後續每個版本再次完整審查。
- [x] 更新AGENTS契約、model-adapter、evaluation與release evidence；本計畫勾選附本次證據，主計畫更新下一項。真模型品質仍另行驗收，不建立新live入口或消耗舊授權。

## 驗證命令與執行政策

```sh
pnpm test:unit --maxWorkers=2
pnpm typecheck
pnpm lint
pnpm exec vitest run tests/integration/agent-runtime.test.ts tests/integration/agent-recovery.test.ts tests/integration/chat-http.test.ts tests/integration/run-store.test.ts --maxWorkers=1
pnpm test:adk
pnpm build
E2E_PRODUCTION=1 pnpm exec playwright test tests/e2e/chat.spec.ts
```

以上為實作後的最小命令，另補P0–P5新增測試及受影響provider/evaluation/replay測試；不得把它當全integration已通過。測試輸出有界，pipeline保留原exit code。只用現有本機依賴與test DB；缺依賴／服務時回報，不自行下載或開付費。不能設定任何live opt-in。

## 切換與回退

- 實作階段保持公開／真模型入口停用；功能齊備再一次切換核心回答，不讓同一run跨契約。
- P0建立可回復基線後，回退只限本次精確變更範圍；保留既有dirty edits，不用hard reset／stash／clean。schema變更若有採additive方式，失敗不刪舊資料或倒灌未知欄位。
- 可回復基線留在 ignored local storage，只含所需程式／測試／文件，不含憑證；暫存副本不是永久版控或跨主機備份保證。
- 新契約出錯時關閉新Agent執行，既有行程維持唯讀或已驗證手動操作；不得回退成未驗證LLM正文對外服務。
- 上線驗收前不宣稱零技術債、零幻覺、正式可訂或品質全過；本次可保證的目標僅是關閉未驗證事實的發布路徑。

## 決策與審閱紀錄

私人執行時間線、原始報告／source hashes、臨時路徑、reviewer 身分與 session
授權留在本機；公開文件保留以下可重驗的設計結論，不能作為最新整批通過證明。

- 固定 receipt 不需要生成能力。單用 skipSummarization 不足以阻止 ADK 2.1
  confirmation preprocessing 再呼模型；callback 須編譯並保存 receipt，再設定
  InvocationContext.endInvocation。Resume 使用 ReceiptOnlyModel、reserve=0，
  仍驗 owner／TTL／IP／concurrency／provider binding。
- Usage reconciliation 共用純核心，以明確版本 policy 驗證零呼叫 resume。
  Native／public／product proof 缺一即 unknown；不同唯讀 transaction 不冒稱單一快照。
- 最新失敗／未完成 validation 必須淘汰舊引用；prototype tool ID 不能成為 gate。
  Proposal truth 在 append 前驗證，不允許先公開再於 finish 拒絕。
- 跨 phase 舊 proposal 不能充當 resume receipt；receipt version 依 committed SSOT，
  原始 model text、Markdown、HTML 與長字串不能經其他元件繞過 compiler。
- 手機／桌面需驗可見的 receipt，不能只看 DOM 有文字。定位最新 answerId 一次，
  同 ID reread 保留手動 scroll，隱藏面板等 layout 可見才定位。
- Fixture UUID、DEMO provenance、native FunctionTool schema 也要合法；
  修測試資料不代表放寬產品契約。SDK init／subprocess／browser timeout 保留原門檻，
  局部重跑不拼成整批全綠。最新完整結果見 [release evidence](../../release-evidence.md)。

### 沿用盤點與收尾決定

| 機制 | 原因與舊約束 | 現在是否成立／證據 | 從零設計依據 | 決定與重評條件 |
| --- | --- | --- | --- | --- |
| 確認後模型ack／保留名額 | 舊正文由模型產生 | 不成立：receipt只有transaction的status/version，compiler不允許其他內容 | 本機ADK `InvocationContext.endInvocation`公開callback API與native/cross-process probes；固定transaction結果不需生成 | 退場；原生確認工具完成即保存固定receipt。若未來決定後有真正新探索任務，另設新run並重評，不偷偷重開舊回合 |
| resume憑證／生成成本 | 舊resume需要模型續寫，provider identity與API key綁在同一config | 不成立：receipt是確定性原生工具處理；身分仍須匹配，生成能力不再需要 | 本計畫的生成能力／身分責任分離；runtime在parent/worker拒絕resume generation，ReceiptOnlyModel本機fail-closed，migration013只開放zero-cost continuation | start才載入key；resume reserve=0且不可account model call，保留IP／concurrency／TTL／idempotency。未來若新增真正生成階段必須另定新run能力，不以receipt路徑偷偷啟用 |
| usage對帳版本 | 舊report的空invocation必須unknown，新resume可在完整證據下為0 | 版本差異仍成立，重複成本迴圈不成立 | 共享pure reconciliation core＋明確legacy/current policy；current須native／public／product SSOT proof，歷史不回填 | 單一成本計算，只由版本policy決定已證明的空resume；新增報告版本時重評policy而非再複製帳務邏輯 |
| 工具呈現字串 | 舊prompt要求照抄格式化金額避免3300→330 | 不成立：AnswerPlan不能帶正文／金額，renderer已有唯一formatTwd | 本計畫的型別化資料與呈現分離；tools的numeric minor、unit、source、DEMO、unknown仍需用於方案選擇 | 移除knownTwdDisplay／priceEvidence.display／鎖定與target display及照抄指令；保留結構化資訊。未來若評估證明模型需要輔助表示，改私有決策資料契約，不增加公開正文出口 |
| validation歷史解析 | 舊confirmation需恢復tool call/response | 仍必要，但confirmation與answer不得分別解釋取代關係 | 同一durable事件來源共用pure parser＋domain重建；不同信任邊界保留獨立驗證 | 合併配對、最新attempt與domain validation。pending／failed較新attempt也淘汰舊引用；不新增可變帳本 |
| ID／索引／交易／lease | ACK遺失、併發、版本／所有權及晚到worker | 仍成立：run-store、version-store及故障注入回歸 | PostgreSQL唯一約束、同client transaction與明確冪等身份；不需要新event-sourcing平台 | 保留UUID、request hash、answerId唯一索引、每trip lock／lease／TTL。外部副作用加入時重評transaction／outbox，不宣稱任意副作用exactly-once |
| 子程序／ADK schema隔離／DDL鎖 | SDK持有pool且ORM跨schema introspection | 仍成立：固定ADK2.1／ORM7.2與並行啟停測試 | 支援公開API內的監督退出、bounded hooks、隔離DB；不用私有pool欄位 | 保留；SDK升版或正式部署worker packaging時重驗，不為此次呈現改寫整個runtime |
| 雙層不可變投影／公開固定事件 | native恢復與產品SSE各有保存責任 | 仍成立：stateDelta保存compiled answer，product event保存同投影，沒有第二份可變Evidence | 本計畫的 persist-before-ACK 契約；目前沒有跨服務queue需求 | 保留；replay不重編，未知版本拒絕。未來跨服務部署才重評交付機制 |
| 舊contract／歷史報告 | 不可刪未決提案或重寫品質／用量 | 仍成立：live 歷史唯讀，原始報告及 pending 狀態不可回改 | versioned contracts，歷史讀取與新write隔離 | contract0不可resume，v1eval只供歷史檢視；只有明確使用者處置才能動舊資料 |

目前評估仍需另驗真模型意圖理解、選擇與任務完成。原始失敗及不可刪本機歷史不變；
public regression vectors 僅證明離線數值與機制邊界。這份子計畫不攜帶新模型或部署授權。
