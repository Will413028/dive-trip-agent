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
  - 子步驟2a：獨立hosted config／secret-file邊界；2b1：backend簽章、限流、容量與transactional journal；2b2：獨立recovery副本與restore reconciliation；2b3a：Next可信入口／API代理／SSR分享，驗固定upstream、簽章、body限界、原nonce/期限及實際API路徑重簽；2b3b：API／worker恢復gate、回應前export與maintenance CLI，驗跨程序封鎖與真正Temporal purge；2c：容器／edge、端到端與完整CI。依序各自驗收，不以任何子步驟完成宣稱步驟2完成。
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
| 2b1 | 完成 | 20tests、Ruff、strict mypy89files；簽章mutation3預期失敗／10controls；設計review兩項、安全review一項全部已修，複核無findings | runtime端到端由2b3驗；不是public-ready |
| 2b2 | 完成 | Oracle獨立PostgreSQL完整54tests；Ruff／strict mypy91files；HMAC／epoch mutation各1預期失敗，16／10controls；獨立design／correctness複核無findings；2bbbee2完整CI27步成功 | runtime gate／CLI與真正Temporal purge串接由2b3b驗 |
| 2b3a | 完成 | 固定Node／pnpm下59unit、完整typecheck／lint、hosted production build；HMAC mutation9預期失敗／33controls；實際HTTP三入口503負例；獨立review無findings | backend恢復gate／CLI屬2b3b；實際Edge、container與完整新來源CI待驗，不可部署 |
| 2b3b | 未開始 | 無 | API／worker恢復gate、export與maintenance CLI；被擋於2b3a |
| 2c–5 | 未開始 | 無 | 依前置步驟；最新2bbbee2完整CI成功，新來源仍需自己的完整CI與部署驗收 |

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

### 2b1 backend驗證紀錄

新增獨立hosted bootstrap、HMAC入口、transactional replay／global與client limits、容量trigger及刪除／撤銷journal；共用產品Domain、fixture dispatcher、持久outbox與cleanup，不改local launcher或共用migration。部署SQL只安裝專用空DB；原始評估schema及歷史表數不變。

設計review兩項全部改：獨立hosted migration版本鏈保留checksum與首次空DB guard；五項限額集中於HostedLimits，由migrate發布至單一DB row，admission與trigger共用。第二輪獨立複核兩項已修、無設計回歸。journal與產品決策同交易，counter rollback不留洞，產品purge後保留journal，snapshot拒缺漏、UPDATE／DELETE／TRUNCATE被拒。

初輪17tests完整命令通過，涵蓋簽章竄改、replay、限流、容量、禁止挪用有資料DB、ledger漂移、刪除journal原子與purge後保留。一次限流測試跨分鐘而失敗，改為固定飽和當前與相鄰窗口後重跑；未放寬產品limit。獨立security review P1已修：body讀取上限10秒，body完成及DB admission返回均重驗stamp，新增慢body、讀取期間與admission等待期間過期反例；第二輪複核NO FINDINGS，design B1/B2未回歸。獨立副本export／restore reconcile、Next／Edge簽章consumer、容器與runtime端到端仍未完成；以上不是public-ready。

032a0fe完整CI run36854352037已失敗：production desktop聊天409後送出按鈕未恢復，66browser passed／1failed／5skip；尚未查明根因，不視為flake或通過。該run沒有可下載artifact，已保留failed log；2c須重現、修正或查明原因後重新完整gate，不拼局部pass。

最終完整命令20tests通過，Ruff與strict mypy89files通過。pytest程序內破壞HMAC比對後，路徑／query／body三個反例預期失敗、10個controls通過，tracked source未變。指令檔对帳：AGENTS.md固定fixture／歷史隔離仍成立、ignored pointer指P7／plan，不需變更規則；下一步2b2，不以新bootstrap當runtime已驗證。

### 2b2 recovery契約與沿用盤點

獨立RecoveryStore使用專用64hex key，不借DB／ingress key；受保護目錄0700、檔案0600、owned regular/no-follow/no-hardlink、有界讀取，HMAC封存嚴格schema及連續序號。檔案lock拒並行寫入，temp file fsync→atomic replace→directory fsync；副本不在DB／Temporal備份volume內，不宣稱off-host災難恢復。來源：[Python fsync／replace](https://docs.python.org/3.13/library/os.html)、[PostgreSQL SQL dump](https://www.postgresql.org/docs/18/backup-dump.html)。

受控還原由prepare先凍結DB journal決策，再保存完整外部checkpoint；匯出不得倒退instance／epoch／prefix。reconcile驗證舊DB prefix，補齊immutable journal，重套產品delete/revoke並重新計算絕對TTL；只有現有DeletionWorker完成history查無及內容purge後才finish。副本缺失、損毀或DB啟動epoch變更而無prepare，均拒serving；已消耗checkpoint不能直接重用。API回應前export、worker啟動/背景export、maintenance role與operator CLI由2b3接入，不以本步primitive驗收宣稱已部署。

此恢復格式只適用全新fixture DB：FixtureDispatcher／PlanningService不經model admission；hosted第二個獨立migration拒絕四張模型帳務表新增，所有recovery入口拒絕已有quota_reservations／quota_daily_totals／agent_invocations／model_calls的DB。不得用它恢復live/evaluation資料或以旧空備份減少模型帳務；未能證明fixture-only時維持關閉。原平台migration及第一個hosted migration未改。

| 機制 | 原始必要條件 | 從零設計 | 決定與重評條件 |
| --- | --- | --- | --- |
| PostgreSQL journal／交易trigger | delete/revoke与產品同交易 | 不變序號與產品effect分離保存 | 保留trigger，還原先import決策避免重複序號；產品新增其他撤銷effect時補類型與測試 |
| 專用外部副本 | DB/Temporal可能一起倒退 | 私有簽章檔案、版本/prefix/epoch完整性 | 單機DEMO使用獨立volume與file lock；off-host需另選目的地與成本 |
| restore先maintenance | 其他產品在線、只有自有入口可停 | 先fence產品決策再取live high-water，雙資源錯誤fail closed | 保留DB旗標＋外部phase；新增部署節點時改共享控制authority |
| 既有DeletionWorker | Temporal ACK不等於history已不可讀 | 重用實際history查無與purge用例 | 不以journal聲稱已刪、不回填quota；Temporal retention/archival改動時重驗 |
| deletion intent orchestration | 一般入口驗owner、expiry入口驗TTL、recovery驗checkpoint，三者仍需相同writer fence | application共用接收既有transaction connection的persist_deletion_intent | 抽取既有同一流程、不改入口authorization／expiry判斷；executor／fencing變更時三入口共同驗證 |
| 成本／quota不得倒退 | 舊部署契約有真模型帳務，本DEMO永久禁模型 | fixture-only資料庫拒絕任何模型帳務寫入，recovery拒絕污染DB | 不移植live ledger恢復工具；新增generation能力時須重新設計完整accounting reconciliation |

168e7d0完整CI run36858531004／job110356742107全部27步success；是上一來源的完整證據。032a0fe的409 browser失敗本輪未重現，根因仍未知，不宣稱修好了或標成flake；新來源仍需自己的完整CI。

2b2實際驗收：ARM64 Oracle隔離環境，固定Python3.13.13、uv0.7.2及frozen lock，以自有pytest PostgreSQL跑完整test_hosted_recovery／test_hosted_recovery_file／test_hosted_storage／test_hosted_ingress／test_deletion／test_retention，54passed（19.02s）。實際pg_dump→備份後delete/revoke→pg_restore→reconcile，驗證決策不復活、完整prefix與冪等；DB commit後副本寫入失敗保留maintenance且可受控接續；絕對TTL與pending purge gate均驗證。單案restart使用專屬container並重查ephemeral port，未重啟其他服務。184個允許來源檔hash逐一核對（manifest SHA256 a2b0c8fe8d1355c3b0f9f6b090a940cb2cae7432bd6f4dce9d20e5ecf980b0d4）。

Mutation僅pytest程序內patch：略過HMAC後錯key／篡改反例失敗、16controls通過；忽略DB epoch後未prepare restart錯誤放行反例失敗、10controls通過。Ruff全backend通過、strict mypy91files通過。獨立review先發現刪除orchestration重複，已抽共用transaction primitive；設計複核及包含fixture accounting防線的correctness/security複核無findings。DB tests直接complete僅驗產品purge邊界，不替Temporal history真正不可讀背書；API／worker／Next整合、operator CLI、專用recovery key配置與volume由2b3完成。

### 2b3a Next入口沿用盤點

| 機制 | 原始必要條件 | 從零設計 | 決定與重評條件 |
| --- | --- | --- | --- |
| local loopback backend | 原launcher只在本機服務 | hosted固定api:4320，独立fixture開關及secret loader | 不放寬local origin函式；改容器拓撲時同步改固定配置與反例 |
| Origin／Cookie透傳 | Python HttpBoundary決定CSRF與owner | 只傳allowlist headers，公開origin取顯式config | 保留caller Origin交後端驗，不採Host／forwarded；Auth0啟用時重設身份邊界 |
| HMAC時效與nonce | Backend PostgreSQL持久拒絕重放 | Next驗同一envelope，SSR對實際API path重簽但保留nonce／期限 | 不在Next另建memory replay authority，也不發新nonce延長有效性；一外部請求多API calls時重設dispatch契約 |
| SSR share讀取 | 固定快照不得借owner cookie | Proxy驗原URL、覆寫SSR target；page重驗原簽章後簽署/api/shares/token | 分享fetch不帶Cookie；Next更新／URL normalization變更時跑query／Unicode反例及端到端 |
| Request與SSE streaming | 斷線取消須傳達後端 | 有界body後驗簽，轉送保留AbortSignal及response stream | 原local helper共享forwarding primitive；不buffer SSE，不await tee取消，持久取消由2b3b／2c驗 |

Next使用原生src/proxy.ts Node runtime，保留原path/query、不靠Host選upstream；hosted模式關閉Proxy URL normalization及trailing-slash自動redirect以維持簽章target，local defaults維持原狀。依固定安裝版config型別與[Next Proxy官方契約](https://nextjs.org/docs/app/api-reference/file-conventions/proxy)核對。Backend ingress簽章的UTF-8／IPv6／百分比query向量由Python獨立生成，Node測試對同一固定hex結果。

`pnpm build:hosted`先沿用offlineNextEnvironment檔名拒絕與env allowlist，再給固定synthetic build origin、api:4320、fixture mode；不讀secret／provider、不借ambient origin。專用image在2c須使用此入口，runtime仍提供真正公開origin與owned secret mount；build placeholder不是公開URL。2bbbee2完整CI run36868028745唯一job與全27steps success，是本步之前的基線。

2b3a最終驗收使用Node26.8.1／pnpm11.2.2：`vitest run tests/unit/hosted-ingress.test.ts tests/unit/backend-proxy.test.ts tests/unit/workbench-route.test.ts tests/unit/next-environment.test.ts` 59passed；`pnpm typecheck`（含原生worker graph）／`pnpm lint`／`pnpm build:hosted`全部exit0。產物required-server-files確認兩個target-preservation flags為true，包含Node Proxy。單一unit程序略過timingSafeEqual，method/path/query/body/client/nonce/stamp/mac八個篡改反例及Next入口路徑反例共9failed／33controls passed；產品source未變。

以該production產物在loopback ephemeral port啟動Next，顯式mode0使loader在secret前失敗；首頁、API與SSR分享均實際503／no-store／固定SERVICE_UNAVAILABLE，own process有界SIGTERM退出。此負例只證明framework已接gate，不是signed成功互動或公開驗收；真正Edge簽章、DB持久replay、Temporal／恢復gate由2b3b與2c補驗。獨立design與correctness/security review，以及build入口補查無findings。共用平台migration、backend runtime與model history未改；指令檔產品契約仍成立。

收尾mode parity校正：Node原先只取低九個mode bits，04600會被當成0600；新增該反例後確實先失敗，改取完整permission/special bits，使0400／0600與Python read_secret一致。固定toolchain完整同四檔59unit與affected ESLint通過；之前hosted build／HTTP證據屬9a3f9c2，最新來源完整CI仍需獨立通過。此修正不改secret位置、讀取範圍或normal file的接受條件。
