# 免費模型候選（2026-09-19 查核）

本文件保留早期模型選型的比較依據，不代表現行可用額度、帳戶狀態或發送授權；不得自動 fallback。已實作的 provider 與最新品質缺口見 [model adapter](model-adapter.md) 及 [release evidence](release-evidence.md)。

## 建議：Gemini Flash 免費層

官方價格頁本次列出 `gemini-3.8-flash` 的免費 input/output；工具呼叫與結構化輸出文件也使用該模型。這使它適合當本作第一個待測候選，不代表已驗證本Agent的中文、延遲或正確率。

- [價格與免費層](https://ai.google.dev/gemini-api/docs/pricing)
- [Function calling](https://ai.google.dev/gemini-api/docs/function-calling)
- [Structured output](https://ai.google.dev/gemini-api/docs/structured-output)
- [額度](https://ai.google.dev/gemini-api/docs/rate-limits)：實際配額在AI Studio查看，不寫死網路流傳的RPM/RPD。

免費層內容可用於改善Google產品，不能放客戶秘密、私人行程或識別資料。第一版只送合成示範資料，畫面應告知此資料處理條件。Search／Maps grounding不能因LLM免費就假定免費；本作品先使用自己的精選目錄，不開啟這些服務。

## 備選：Groq hosted GPT-OSS

`openai/gpt-oss-20b` 與 `openai/gpt-oss-120b` 在Groq支援strict structured outputs。官方免費限額表本次列出各30 RPM、1000 RPD、8000 TPM、200000 TPD；token與request限制分別生效，一個Agent回合可能消耗多次request。

- [結構化輸出](https://console.groq.com/docs/structured-outputs)
- [Rate limits](https://console.groq.com/docs/rate-limits)
- [Billing](https://console.groq.com/docs/billing-faqs)
- [資料政策](https://console.groq.com/docs/your-data)

先當文字規劃候選，不推定支援其他多模態需求。工具與JSON schema是否可在同請求組合使用，要在選定adapter時依官方限制驗證。

## 備選：OpenRouter 免費模型（已完成離線接入）

OpenRouter 現在已加入本作品的第二個 provider，但只完成 free-only 的離線接入，不以離線接線宣稱 live 品質通過。Server 必須指定具名 `vendor/model:free`；adapter 固定 HTTPS endpoint、禁止 fallback／重試／付費插件，並把 generation ID、usage、reported cost 放在 private accounting。ADK Runner、人工確認、PostgreSQL admission 與 AG-UI 不改由 provider 接管。

免費帳號的 free-model 使用額度仍可能讓多輪工具迴圈很快耗盡；429、未知用量或非零成本會停止，不自動切付費模型。真正 live 前仍需另行唯讀確認可用模型與帳號額度，再明示授權小量合成 smoke；不把 synthetic model ID 當成可用模型推薦。

- [免費額度說明](https://openrouter.ai/blog/tutorials/how-to-get-the-lowest-cost-llm-inference-on-openrouter/)

## 接入守門

先做本機不需密鑰的功能；provider adapter留可替換介面。啟用時確認account/project確實處於free tier；不可把免費價格寫成0後連到已開billing的帳號。免費模式仍有session／全域request與token限制，429時明確暫停，不自動切付費或換帳號繞限額。

原設計「金額上限未設定則拒絕live」仍適用付費模式。若使用者選定免費模式，需明確增加free-only設定及帳號免費層驗證，不使用0元budget繞過既有安全gate。免費API不等於免費主機、資料庫或無限公開流量。
