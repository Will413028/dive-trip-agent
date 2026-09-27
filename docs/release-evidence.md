# Release evidence

Release acceptance 尚未通過，沒有 public deployment。Public repository 提供去識別化的離線 regression vectors；可重現的數值與交易邊界不證明真模型品質，也不代表已取得模型、CI 或部署授權。

## Latest checkpoint

原始碼 repository 已公開。2026-09-27 第一輪 [Fixture CI](https://github.com/Will413028/dive-trip-agent/actions/runs/36317342675) 在 `2a3d3d5d2db6d13bfad7b7ea77f4f876ccba8d02` 全綠；已核對 run、fixture job 及全部 steps 都為 success，沒有 cancelled 或 failed job。使用標準 Ubuntu 24.04 runner、Node 26.8.1、pnpm 11.2.2 與獨立 disposable PostgreSQL，job 耗時 8 分 58 秒。這不是公開部署或真模型品質驗收。

| 本輪同一 CI run | 結果 | 實際範圍 |
| --- | --- | --- |
| Unit | 3308 passed；47.39 秒 | 104 files，完整 unit 目錄 |
| Integration | 388 passed／11 skipped；317.61 秒 | 41 passed files／11 opt-in live files skipped |
| Production Chromium E2E | 63 passed／5 skipped；1.3 分鐘 | 桌面與 390px viewport，非實體手機 |
| Fixture boundary、lint、strict typecheck、production build | 全部 success | 固定 toolchain、locked dependencies；未啟用模型 |
| Disposable DB teardown 與 post steps | 全部 success | 只清除此 run 的測試容器／volume，未動本機歷史 DB |

Skip 不算 pass：11 項 integration 為真模型 opt-in；5 項 browser 為兩種 opt-in replay 情境各跑兩個 project，加手機錄影一項。獨立 `test:adk` 五項探針及專用 replay suite 不在本次 CI 範圍。另於本機跑 actionlint 與 30 案 domain fixture self-check 通過，後者 `modelCalls:0`、`liveEvidence:false`、`evaluationGatePassed:false`；不混入上述 CI 數量。

本輪沒有修改 source、workflow、timeout 或 assertions。舊失敗所在 `p3-answer-persistence`、`version-store`、`chat`、`release` 測試仍被完整收入並通過；未拼湊選擇性重跑。CI 有非阻擋警告：三個 v4 actions 宣告 Node 20，runner 強制以 Node 24 執行；產品 runtime 仍經驗證為 Node 26.8.1，action runtime 升級留作後續維護，本輪未變更 actions 版本。

### Historical checkpoints

以下保留既有 expanded suite checkpoint；cleanup 的局部驗證另列，不改寫成當時已通過。

| 範圍 | 既有整批 checkpoint | 判讀 |
| --- | --- | --- |
| Unit | 3141 passed | 單元回歸通過，不能替代 integration／browser |
| 整批 unit＋integration | 3519 passed／10 integration timeout／11 live skipped | Integration 部分 378 passed／10 failed；整批未全綠 |
| Production browser | 54 passed／9 failed／5 skipped | 等待提案、版本刷新或回答顯示失敗；不能以 HTTP 200 判成功 |
| Strict typecheck、lint、actionlint、production build | 先前 checkpoint 通過 | 靜態／build 通過不解除執行測試缺口 |
| 新版真模型品質 | 未通過 | 受控 AcceptedAnswer 與 synthetic transport 不等於任務成功 |
| Remote fixture CI | 當時未執行 | 最新完整結果見上方同一 run |
| Public deployment | 未部署 | 無 deployment ID、public URL 或 hosted acceptance |

先前公開文件／source cleanup 完成 **3308 unit、15 affected integration 通過，另 9 live skipped，typecheck／lint 通過**。那次僅驗受影響範圍，沒有完整 integration／build／browser，也未觸發 CI 或部署；後續本頁所列完整 CI 才補上 fixture gate。

先前 2776 項較小範圍通過，以及選擇性重跑的成功，都不能替代最新擴大整批結果。測試 timeout、assertions 與 Agent deadline 未因整理文件而放寬。Storage A/B/A 未顯示穩定 tmpfs 優勢；沒有採用 tmpfs 或降低 durability。主機負載及時間敏感性只是診斷線索，不是全部失敗的已證實根因。

本輪已取得同一版本、原限制下完整 fixture 結果，但舊本機逾時的統一根因仍未證實；再次重現時須分別量測 SQL／lock、native worker 與 browser 階段，不以乾淨環境一次全綠宣稱所有環境穩定。下一個發布阻擋項為新版真模型品質。重現命令與失敗判讀見 [evaluation](evaluation.md#offline-regression-and-diagnostics)。

## Evidence register

| Gate | 狀態 | 證據與缺口 |
| --- | --- | --- |
| 固定 runtime | 已指定版本 | Node 26.8.1、pnpm 11.2.2；hosted runtime 未驗證，見 [toolchain](toolchain.md) |
| 核心回答契約 | 已完成離線接線 | AnswerPlan → compiler → AcceptedAnswer；交易後固定 receipt、零模型 resume、不可變 replay，見 [model adapter](model-adapter.md) |
| 本機展示 | CI 的 production fixture browser 通過 | [Demo 腳本](demo-script.md)；影片／單案 smoke 不作完整品質證明 |
| Fixture CI | Passed at `2a3d3d5` | [Run](https://github.com/Will413028/dive-trip-agent/actions/runs/36317342675) 的 job 及全部 steps 成功；範圍與 skip 見上方 |
| Live quality | Pending | 需要完整 3×10、獨立任務／內容 review、完整 usage 與停止政策，見 [evaluation](evaluation.md#coverage-and-acceptance) |
| Public runtime | Blocker | Hosted startup、可信 ingress/proxy/IP、secret loader、budget、kill-switch 未驗收，見 [deployment](deployment.md) |
| Retention operations | Blocker | 有本機有界 cleanup；hosted adapter、supervised schedule、告警與 backlog 證據不足 |
| Backup / restore | Blocker | 未有公開環境 backup policy、restore 演練及刪除／撤銷／成本 reconciliation 證據 |
| 資料及素材 | 有限查核 | 參考地點僅核對名稱／座標；不保證價格、開放、可訂或安全，見 [資料依據](data-sources.md) |

## Live evidence boundary

目前沒有新版真模型品質通過的證據。已記錄的 provider failure 不足以從固定公開錯誤碼判定根因；controlled failure、snapshot 不變或保守結算也不代表任務回答成功。技術完成仍須核對理解、必要澄清、證據選擇、金額語義、DEMO／未知費用揭露與 committed receipt。

Acceptance 要求同一模型、同一 case 版本的三輪各十例；每輪至少八例成功、零 safety failure、全部已知 cost／latency、每案低於 60 秒且最多六次工具。失敗、timeout、取消、skip 留在分母，不能混入 fixture results。Review pending 或 AI review worksheet 不能自動變成 human approval。

原始 claims、reports、replays、usage 與 retained DB 留於 ignored local storage，保留失敗原貌、unknown 和已消耗 claim，不刪除或改寫。Public docs 不包含私人報告的精確識別、帳戶或實際 ledger 成本歷史；去識別化 regression vectors 只用於離線驗證，不可代替本機原始歷史、remaining quota 或新的發送授權。

真模型入口另需明確、有界授權及本機 closed-world history check；不能刪 report／claim、換 schema／IP identity 或清 quota 重新啟動。新的 unknown usage、限流、技術／安全失敗立即停止。Reference budget（例如 US$3）只是保守政策上限，不是實際帳單、免費餘額或付費許可。詳細方法見 [評估審查指南](evaluation-review.md)。

## Public release 待填欄位

未填項均為 pending，不以本機截圖、fixture movie、skip 或其他 repository 的 commit 代替。

| 欄位 | 現值 |
| --- | --- |
| Release commit / immutable artifact | 未指定 release artifact；checkout 身分可由 `git rev-parse HEAD` 取得 |
| CI run URL / fixture job conclusion / steps | [36317342675](https://github.com/Will413028/dive-trip-agent/actions/runs/36317342675)／job `108614449542`：success，全部 steps success；SHA `2a3d3d5` |
| Deployment ID / region / public HTTPS URL | 未部署 |
| Hosting configuration / daily model budget | 公開環境未配置 |
| 新版 model / 完整 campaign / reviewer evidence | 品質未通過；私有歷史不能改標為新版成功 |
| Public smoke / desktop / 390px mobile | 未執行公開環境驗收 |
| Retention schedule / last success / backlog | 未配置、未量測 |
| Backup / restore / RPO / RTO | 未配置、未演練 |
| Kill-switch / rollback | 公開環境未演練 |

完成阻擋項並取得部署授權後，須記錄 fresh-session A1–A14、fixture／live 模式揭露、SSE 中斷、跨 owner 防護、HTTPS cookie／origin、偽造 forwarding headers、分享撤銷／expiry／cache、cleanup、kill-switch 與 rollback。CI 綠燈本身不能推論這些驗收完成。
