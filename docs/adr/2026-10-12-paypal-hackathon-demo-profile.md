---
title: PayPal hackathon 以獨立 demo profile 展示揪團訂金與天候結算
date: 2026-10-12
status: active
tags: [decision, architecture, deployment, payments, ai-agent]
---

# PayPal hackathon 以獨立 demo profile 展示揪團訂金與天候結算

## Context

2026-10-12 Will 決定參加 PayPal AI Hackathon（截止 2026-11-12 12:00 PT，目標 11-10 送件），在本 repo 加入揪團訂金預授權與天候結算模組，設計見 [paypal-group-deposits](../paypal-group-deposits.md)。評審需要可點的公開 demo，且模組需要真模型呼叫與 PayPal sandbox 金流；兩者都與現行 hosted 路徑的設計衝突。

- `external`：PayPal 已停止台灣帳戶之間的境內付款（[The Paypers](https://thepaypers.com/online-payments/paypal-stops-domestic-payments-in-taiwan--761515)），所以敘事改為跨國潛水員預訂海外船家，sandbox 用 USD。
- `external`：Authorization 有效 29 天、honor period 3 天；評審期與截止相距超過 29 天，不能事先建好授權，只能在 workspace 建立時現場授權。
- `external`：Orders v2 的 `PayPal-Request-Id` 預設保存 6 小時，可申請延長到 72 小時（[Orders v2](https://developer.paypal.com/api/orders/v2)）。
- `inherited`：hosted 入口（P7，見 `deploy/plan.md`）刻意只允許 fixture，以 config guard 與 hosted migration trigger 禁止 model config 與 model accounting；P7 後續步驟尚未完成。此限制是為了公開保存使用者資料而設，demo 只用合成資料，所以不適用於 demo，但 P7 本身仍成立、不改。
- `inherited`：既有一次性 claim、closed-world 歷史查核與 quota 帳本，保護的是真模型評估證據；本模組的合成資料 demo 不產生需要保護的評估證據。Will 已選輕規則。
- `external`：Will 使用自己的 VM 部署；兼職約 4 週。

## Options Considered

- **基準／A：走完 P7 hosted 路徑，再以 ADR 放寬 hosted 的模型禁令**。一般 hackathon 是單一容器＋managed DB＋HTTPS；本 repo 的對應做法是完成 P7 並修改 hosted trigger 與 migration 鏈。好處是只有一條部署路徑；代價是 P7 剩餘 gate 可能吃掉兩週以上，而且要改動一個為真實使用者資料設計的不變式。
- **B：VM 上的獨立 demo profile（選用）**。獨立 compose stack、獨立 DB、獨立 hostname，只放合成資料、每晚整庫重建；模型呼叫套用本模組的輕規則。代價是多一套部署設定，且 demo 不能當作 P7 已驗收的證據。
- **C：不提供可點 demo，只交本機錄影**。成本最低，不碰任何部署；代價是評審無法親自付款與觸發 agent，「PayPal 整合深度」與「agentic」兩項都較難被相信。

## Decision

- **D1**：選 B。Demo profile 在 Will 的 VM 上以獨立 compose stack（API、worker、Temporal dev server、PostgreSQL）、獨立 DB 與獨立 hostname（例如自己的 tunnel hostname）運行；只用合成資料，每晚整庫重建。Hosted P7 路徑、其禁止 model config 的 guard 與 trigger、hosted migration 鏈都不改。
- **D2**：金流全部在 PayPal sandbox 真實執行。每位 diver 一張 `intent=AUTHORIZE` 的 Orders v2 order；不需付錢就 void；只需付不退部分就 partial capture＋`final_capture=true`；只有 capture 之後才 refund。每筆 money command 先保存（含 `PayPal-Request-Id` 與 `invoice_id`）才送出；結果不明時在 idempotency window（預設 6 小時）內用同一 key 重送，否則 GET 對帳。Webhook 為 nice-to-have；MVP 用同步回應＋對帳 sweep；每晚 cron void 未 capture 的 demo 授權。
- **D3**：模型只讀非結構化取消證據（船家公告原文、海象警報原文、混合預報），產出附引用的結構化事實；經 server 包裝的 `get_booking`、`get_weather`、`propose_settlement`、`execute_within_mandate` 行動。金額一律由服務端依不可變 policy 版本計算，模型不提供金額；deterministic 門檻規則是 sanity guard，不一致時取消自動執行、交 organizer 核准，不否決提案。超出 mandate 即停下請求核准。全部模型失敗時產生需人工核准的「No AI」提案。
- **D4**：本模組的真模型呼叫採輕規則：只送合成資料、env 設定每日上限（預設 50 live runs/day）到達即自動停、獨立 call log 表（不碰既有 quota 表）；達上限時顯示明確標示為「Recorded」的預錄結果。既有 planning 對話與 quota 契約不變。
- **D5**：砍除 reauthorize、付款即 capture 模式、TWD、CWA 資料、hash-chain 稽核、Payouts、diver 自行取消；稽核只保留 append-only 時間軸。README／AGENTS.md 產品契約（demo 才有訂金、仍無真錢與安全背書）列為後續修改，本次不動。

## Rationale

- **D1**：選 B 而不是 A，因為 A 要在 4 週兼職內先完成 P7 剩餘 gate，並改動保護真實使用者資料的 hosted 不變式；B 以合成資料＋每晚重建取代那些 gate，代價是多一套部署設定、demo 結果不能算 P7 驗收。選 B 而不是 C，因為評審要親自付一筆訂金並看到 agent 行動，代價是 VM 維運與 sandbox 可用性風險（以狀態說明與錄影 fallback 承接）。
- **D2**：用 void 與 final partial capture 取代「先全扣再退款」，換來無退款手續費與「錢只是被凍結」的 UX，代價是受 29 天授權期限限制，只適用近期行程；遠期行程的 reauthorize 或付款即 capture 留作 production extension。金流可在同一 key 下有限重試，不同於模型 activity 不重送的既有規則，因為 PayPal 有官方 idempotency key；代價是 window 過後必須靠 GET 對帳，不能無限重送。
- **D3**：讓模型讀規則無法解析的文字，而不是只分類數值門檻，這才是 AI 的實際價值；代價是要驗證引用、維護工具包裝與 mandate 檢查。門檻規則當 guard 而不是 veto，因為船家公告可以合法取消預報數字沒標出的日子；代價是不一致時一律退回人工。
- **D4**：以輕規則取代 repo 的一次性 claim／closed-world 查核，換來評審期間可用的 live demo，代價是本模組的模型呼叫不再具有既有評估證據的完整性保證，不能拿來宣稱模型品質。
- **D5**：砍除項目都不是評審流程必需，留下來會擠壓 MVP（11-02）。代價是 demo 不能展示遠期行程與台灣在地資料。

## Expected Outcome

- 評審在隔離 workspace 用 sandbox 測試卡付一筆訂金，觸發模擬風暴或貼上船家公告，看到 agent 引用證據、在 mandate 內 void／partial capture／refund，超出時停下請求核准；時間軸與 PayPal sandbox 交易一致。
- Hosted P7 路徑、其 trigger 與 migration 鏈在本模組期間零差異。
- 模型全部失敗或達上限時，demo 仍以 No AI 提案或標示 Recorded 的結果完成流程。

## Followup

- [ ] W1 sandbox spike：guest card AUTHORIZE、server 端 `payment_source.card` 種子授權、partial capture＋`final_capture` 後餘額是否釋放、void、refund、同 key 重送。
- [ ] MVP 2026-11-02；送件 2026-11-10。
- [ ] README／AGENTS.md 產品契約修改（demo 才有訂金、無真錢、無安全背書）。
- [ ] Hackathon 評審結束後決定拆除 demo stack 或保留。

## Revocation Triggers

- 需要保存真實使用者資料（含真實付款人、真實行程）→ 回到 P7 完整路徑，不擴大 demo profile。
- 需要 live PayPal credentials 或真實金流 → 重評金流責任、PCI 範圍（server 端卡號只限 sandbox 測試卡）與合規，不沿用本 ADR。
- 每日上限仍擋不住濫用或費用超出免費層 → 改為只顯示 Recorded 結果或關閉 live 呼叫。
- 行程需要超過 29 天的授權 → 另定 reauthorize 或付款即 capture 的決策。

## Related

- **原始來源**：2026-10-12 Will 核准的設計 review 變更；本 ADR 即原始紀錄。
- [PayPal 揪團訂金設計](../paypal-group-deposits.md)；[Python 與 Temporal 核心](./2026-09-28-python-temporal-core.md)；[產品契約](./2026-09-19-curated-trip-workbench.md)；P7 計畫見 `deploy/plan.md` 與 [release completion plan](../release-completion-plan.md)。
- [PayPal Orders v2](https://developer.paypal.com/api/orders/v2)、[Authorize payment](https://developer.paypal.com/docs/checkout/standard/customize/authorization/)、[Idempotency](https://developer.paypal.com/api/rest/reference/idempotency/)。
