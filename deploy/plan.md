# Oracle 公開 HTTPS DEMO 部署

**Goal：** 在既有Oracle VM提供獨立、明示fixture-only的HTTPS潛旅DEMO，通過公開互動、安全與持久重啟驗證；模型保持關閉。

**上層：** [release completion plan P7](../docs/release-completion-plan.md#p7-公開部署與維運)。
**附件：** [盤點與需求](inventory.md)。基線2537b95。

## 前提（2026-10-01）

- 無既有潛旅部署；首次上線不搬既有產品資料。其他產品在同機在線，禁止重啟、變更或清除其服務／資料。
- 使用者已選公開HTTPS離線DEMO，授權SSH、必要下載、專用Cloudflare資源／secrets及deploy目錄；不授權模型呼叫或新增付費資源。
- 已SSH核對ARM64 VM資源及Docker；詳inventory。Cloudflare既有OAuth已驗Workers／connectivity權限，完整subscription清單只有R2，沒有Workers Paid；此為完整inventory推論。子網域fathompod、dive-trip-agent名稱未用；寫入前仍重查。
- 完整CI基線d5a5ad2成功（run36797284578，27步）；此結果不替新部署revision背書。

## 不變量

| 不變量 | 依賴機制 |
| --- | --- |
| 無模型generation／不載provider credential | hosted bootstrap、FixtureDispatcher、worker bind、Compose mount allowlist |
| 不改受保護歷史／quota | 全新專用DB、Temporal與volume；不掛.artifacts／env／evals |
| 同源與owner為服務端 authority | HttpBoundary、Sessions、Next proxy、固定公開origin |
| 確認後receipt／版本冪等／持久刪除 | PlanningService、TripService、DeletionWorker、Temporal binding |
| 不影響其他產品 | 專用Compose、network、secrets、volumes、limits與具名啟停 |

## 範圍

- 做：fixture-only新hosted入口、Web/API/worker與獨立PostgreSQL／Temporal、Cloudflare固定入口、部署與回復驗證。
- 不做：真模型、會員、跨裝置、現有資料搬移、新VM／付費升配、其他產品改動。
- 延後：live模型（新品質驗收與有界授權後）；多節點高可用（DEMO容量需求改變後）；另訂off-host備份目的地（需選定儲存／成本）。正式RPO承諾前仍需off-host決策。

## 決定

- D1 已決，Will2026-10-01：公開HTTPS DEMO，Cloudflare Worker＋專用Tunnel/VPC到Oracle；私人SSH入口維運較簡單但不滿足公開試玩。禁止Quick Tunnel。
- D2 已決，Will2026-10-01：deploy專用設定與secrets；專用服務較耗資源但保留隔離，不借既有產品DB／Temporal。
- D3 單機DEMO預設可推翻：Compose；systemd較少容器依賴、Kubernetes提供多節點但本案過重。資源上限依基準測試確定，不以重啟其他服務換容量。
- D4 首次公開前：離線DEMO不受P5真模型品質gate阻擋；P5維持未通過，公開介面必須fixture揭露。不能把此部署記為正式live驗收。

## 步驟

- [x] **1. 實況與入口前置**（被擋於：無）
  - 範圍：SSH inventory、Cloudflare whoami／權限與Free查核、name可用性；只讀，不建立遠端服務。
  - 消費端：`rg -n 'P7|hosting|deploy|oracle' docs/deployment.md docs/release-completion-plan.md`；結果是部署文件與唯一P7。
  - 不能動：其他服務、secrets、所有model入口與claims。
  - 驗收：保存去識別inventory；帳戶／Free未知即停止Cloudflare寫入；計畫獨立審查與每項finding處置。
- [ ] **2. 專用runtime與離線驗證**（被擋於：1；此步不需公開入口寫入）
  - 範圍：hosted config／DB secrets／Temporal address與bootstrap、固定backend、容器與edge allowlist／限流／匿名儲存上限；worker監督與有界cleanup；可信IP、備份後決策journal與restore reconciliation依下方補充契約實作。
  - 消費端：`rg -n 'fixture_conninfo|create_app|FixtureDispatcher|proxyBackend|backendShare|APP_ORIGIN|DIVE_BACKEND_ORIGIN' backend/src src tests`，新增hosted consumer與既有local分別驗證。
  - 不能動：local/evaluation授權政策、strict回答、quota、Domain、確認／刪除語義。
  - 驗收：config反例（http origin／任意upstream／provider env／secret mount）拒絕；破壞hosted origin及allowlist的mutation必須失敗；生成契約、lint、typecheck、完整CI；新PostgreSQL／Temporal端到端confirm／restart／delete。獨立design-review。
  - 停止：缺權限、測試失敗、意外generation能力、共享服務漂移。
  - 子步驟2a：獨立hosted config／secret-file邊界；2b：API／worker、可信入口／限流與恢復journal；2c：容器／edge、端到端與完整CI。依序各自驗收，不以2a完成宣稱步驟2完成。
- [ ] **3. 候選部署與維運**（被擋於：1、2；與4必須連著做）
  - 範圍：exact SHA候選images、專用DB/Temporal migration與namespace、專用Worker/Tunnel/VPC、固定HTTPS origin，先維持maintenance入口。
  - 消費端：專用Compose與Worker；`rg -n 'image|volume|secret|ports|binding|origin' deploy`。
  - 驗收：無DB/API/Temporal公網ports、非root app、限額與log rotation、無env/model/artifacts在image；保存版本與binding，DB/Temporal成對備份；隔離restore與刪除／撤銷不復活、RPO/RTO實測；worker失敗有告警證據。
  - 停止：Free無法證明／需付款、已有同名資源、migration目標不符、無法還原或Cloudflare權限不足。
- [ ] **4. 公開驗收與啟用**（被擋於：3）
  - 驗收：HTTPS、fresh-session、Secure/HttpOnly cookie、偽造Origin/forwarded拒絕、cross-owner拒絕、固定scenario確認／拒絕／刷新／復原、SSE flush/斷線取消、share撤銷/no-store、刪除／持久重啟；完整fresh-session A1–A14逐項映射；live理解與模型quota項明記未驗，不以fixture通過live；地圖依使用者點擊才載入，核對origin-only Referer、browser cache、attribution、容量與桌面390px顯示。實際演練maintenance→drain→相容image→重驗→恢復；過程禁止新寫入、保留原DB/history。超量請求被拒、未載provider配置。測試失敗維持maintenance。
  - Rollback：先維持maintenance／停本專案入口，再有界drain自有worker；回相容image，保留DB/Temporal/quota，不逆改migration、不移除volume。
- [ ] **5. 收尾**（被擋於：4）
  - 驗收：獨立設計／correctness review、指令檔對帳、image/commit/URL與每項hosted evidence記release evidence；長期部署檢查接CI。功能概覽明示公開fixture，延後項回唯一主清單；不把P5品質或高可用/RPO宣稱已完成。

## 進度

| 步驟 | 狀態 | 已跑驗收 | 未跑與原因 |
| --- | --- | --- | --- |
| 1 | 完成 | SSH資源／目標路徑、OAuth權限、完整subscription、Worker name，獨立review四項已補契約 | 遠端寫入前須重查當下狀態 |
| 2a | 完成 | 28tests、Ruff、strict mypy86files、mutation11預期失敗／17controls、design與correctness/privacy review無blocker | 完整新來源CI由2c核對；runtime未接 |
| 2b–5 | 未開始 | 無 | 依前置步驟 |

## Review修正契約（四項全部改，駁回0）

1. **Restore決策保全**：worker／API在與刪除、分享撤銷、到期封鎖同一交易中保存不可變recovery journal與單調序號；每日備份外另保留持續決策副本。恢復舊DB前停入口，讀可信副本high-water mark，在隔離DB重套刪除／撤銷／到期決策，重新執行清理，核對序號無缺漏才可恢復。副本無法證明完整時維持maintenance。反例固定為backup→delete/revoke→restore→reconcile→不得復活。產品原始schema／quota不因restore重置；首版完成此機制前不得公開接受持久資料。
2. **可信入口**：Worker只信Cloudflare提供的CF-Connecting-IP，丟棄caller supplied forwarding／內部身份header，以專用secret簽署方法、固定path、timestamp及IP身份；Next／API驗簽與有界時效，重寫header，不能讓Cookie決定upstream。外部無API/DB/Temporal ports，Worker僅固定Web VPC service；直接upstream／偽造簽章拒絕。Edge按可信IP限流；backend按verifiedIP與owner限制並行／建立速率，具全域匿名trip容量上限。限額明確寫config並有兩個不同IP、偽造headers、超量與重播反例；不將所有用戶算同IP。
3. **Hosted驗收映射**：新增逐項A1–A14→測試ID／fixture模式／未驗限制表；不能僅以概括smoke取代。地圖網路測試限制單一viewport，不批量或預抓；桌面與手機核對Referer、cache與attribution。
4. **維運**：operator為使用者Will；專用worker每5秒有界cleanup，100trips／100empty owners／1000receipts每pass；連續兩次失敗、backlog連兩輪不下降須有監督告警證據。每日成對DB/Temporal備份，最多7份／7天、0700目錄／0600檔、加密於本專案專用key，到期刪除不超30天；off-host/RPO承諾另決定，單機副本不稱災難復原。每個run只管自有服務，故障注入驗證告警；kill-switch阻止新start與寫入，再以原run deadline與shutdown20秒有界drain，驗證無新增dispatch，保留帳務與全部資料。rollback演練需保存版本、時間、資料指紋與維持receipt冪等的證據。

四項核對來源：deployment.md Restore與維運gate、backend HttpBoundary、src/server/backend.ts、MapPanel.tsx與assets-license.md。獨立review僅只讀，primary重查引用與shared git scope後補入上述要求，並未宣稱程式已實作。

### 2a沿用盤點

| 沿用機制 | 原始必要條件 | 從零設計 | 決定與重評條件 |
| --- | --- | --- | --- |
| fixture環境deny與顯式設定 | 模型入口有界隔離 | hosted獨立config、先拒generation/ambient env再讀secret | 不共用local CLI、不放寬fixture_conninfo；live另有品質／授權後重評 |
| PostgreSQL conninfo／密碼檔 | 隔離容器網路、專用DB | 固定db/user/port、owned bounded O_NOFOLLOW secret file | 不讀service/passfile；host網路或secret manager變更時重評 |
| 固定Origin | 服務端同源 authority | canonical HTTPS domain，不採Host/forwarded | 保留HTTP boundary契約；公開網址變更同步驗收 |

secret不進repr；固定64hex密碼與入口key不同。此模組尚未被任何runtime使用，沒有產品啟動或遠端寫入。

### 2a驗證紀錄

新模組只接受canonical HTTPS domain與固定專用DB binding。先拒generation／ambient env，再讀owned regular secret file；固定64hex、0400/0600、單一hardlink、O_NOFOLLOW、有界讀取，key不進repr且兩用途不同。本機fixture_conninfo／runtime／schema政策未改，`rg -n 'HostedFixtureConfig|hosted_config' backend/src backend/tests`只有新模組與測試，尚未有runtime consumer。

第一輪27passed／1failed（HTTPS IP origin在讀secret前未被拒），修正後完整28passed。Ruff、strict mypy86source files通過。pytest程序內移除env guard mutation，完整命令預期11failed／17passed；tracked source未變，不能當產品pass。Design-review NO DESIGN FINDINGS，A/B/C均0；獨立correctness/privacy review無blocker。指令檔對帳：tracked AGENTS.md架構與local邊界仍成立，不需改；ignored部署pointer仍指P7/plan。下一步2b仍需hosted API/worker與可信入口、restore journal，2c容器／端到端／新revision完整CI仍待做，不能把config完成當公開runtime可用。

secret file部署注意：Compose bind secret不會透過uid/gid/mode替來源檔案改owner，2c必須先在host設定成runtime UID與0400/0600；單機private network才使用無TLS DB，跨主機重評。
