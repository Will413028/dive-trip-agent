# Release preparation — deployment

平台資料查證日期：2026-09-22。狀態：**未發布**；本機工作台不表示 release gates 已完成。本文件描述尚未配置、驗收的部署候選，沒有 public URL。實際驗證狀態見 [release evidence](release-evidence.md)。

Cloudflare 平台遷移暫停；下方 Render 是歷史候選，尚未選定部署目標。CI 仍 paused、0 runs，workflow 存在不表示可觸發或已通過。CI 防線在 install 前依檔名及 provider/live env namespace 拒絕憑證與 live 設定（包括空值），不讀內容。舊 live 的 retention apply 在 DB 存取前封鎖；這些本機防護不代表公開 startup、backup/restore 或維運驗收完成。

## 現有程式的阻擋項

- `pnpm start` 執行 `tests/support/workbench-dev.ts --production`：仍使用 `testDatabaseUrl()`、專用 `dive_trip_test` DB、loopback 與固定 port。`--production` 僅表示 Next production build，**不是公開環境 launcher**。
- `src/server/local-live-context.ts` 僅接受固定 loopback origin、私有 ingress token 與可信 local peer。不得把 Render proxy 的 forwarding headers 偽裝成 local peer，也不得只把 host 改成 `0.0.0.0` 就宣稱公開 ingress 完成。
- `scripts/expire-data.ts` 僅接受上述本機 DB 的 `workbench_demo`／`workbench_live`，後者只允許dry-run；不能直接作為 hosted DB 的 cron command。
- 公開 launcher、trusted proxy／IP contract、HTTPS cookie／origin、憑證載入與預算／停用設定介面尚待實作。2026-09-27僅補本機retention及fixture CI防護，不實作public runtime或修改`.env.example`，不提供假的可用production start command／deployment manifest。

## 候選平台：Render paid Web Service + Render Postgres

此選型適合常駐 Node server、ADK child process 與 PostgreSQL；屬待驗證候選，尚未購買或配置。官方要求 web service 綁定 `0.0.0.0`，建議使用平台 `PORT`，並由 edge 終止 HTTPS。[Web Services](https://render.com/docs/web-services)

| 項目 | 準備要求與尚待驗證事項 |
| --- | --- |
| Runtime | 固定 Node **26.8.1**、pnpm **11.2.2**，不可依賴平台預設版本。未來以 `NODE_VERSION` 與 package metadata 固定，建置 log 驗證精確版本；官方提供版本覆寫機制，但本專案未在平台驗證此版本。[Node version](https://render.com/docs/node-version) |
| Streaming | 官方描述 web service 支援最長 100 分鐘 HTTP response；這不是本專案 SSE 驗證。仍須實測 60 秒 agent deadline、逐段事件傳送、proxy buffering、斷線取消與 redeploy 中斷；不延長應用程式限制。[官方平台比較](https://render.com/articles/best-railway-alternatives) |
| PostgreSQL | 新建本專案專用 PostgreSQL 16、同區 private connection；不得連測試或其他專案 DB。先檢查目標身分與 schema，再以單一 migration runner 執行既有 migration，不改已套用 checksum。[連線文件](https://render.com/docs/postgresql-creating-connecting) |
| Pooling | 優先 direct internal DB connection；現有產品 pool 上限 5，須另計 ADK workers、排程與部署重疊連線。官方 PgBouncer 採 transaction pooling，不保留 session advisory lock／session state，不能直接套在本專案 ADK schema gate 上。[Pooling](https://render.com/docs/postgresql-connection-pooling) |
| Private cache | 預定關閉 dynamic edge caching；私有 API、SSE、分享／撤銷結果使用 `Cache-Control: no-store`，檢查沒有較高優先的 `CDN-Cache-Control` 覆寫。公開後驗證 cache headers 與撤銷立即失效。[Edge caching](https://render.com/docs/web-service-caching) |
| Scheduled task | 預定每小時 `0 * * * *`（UTC）執行一次有界 cleanup；不是把 `--watch` 放進 cron。Render 保證同一 cron 不重疊，但手動 trigger 會取消既有 run；實作 hosted cleanup adapter 前不可建立 job。[Cron jobs](https://render.com/docs/cronjobs) |

### 費用快照（USD，2026-09-22 官方現價）

Hobby workspace US$0/月，web `0.5c-512mb` US$7/月，Postgres `0.1c-256mb` US$6/月，DB storage US$0.30/GB/月。以 5 GB 儲存估算 web + DB 為 **US$14.50/月**；一個 cron 至少再 US$1/月，合計約 **US$15.50/月起**。這是估算，不是已核准預算或足夠容量的保證；另計超額流量、build minutes、備份匯出儲存、restore 暫時 DB、稅與任何模型費用。[Pricing](https://render.com/pricing)、[Cron billing](https://render.com/docs/cronjobs)

Free web 15 分鐘無流量會休眠；Free Postgres 30 天到期，不提供 recovery，不能作為本案常駐／備份承諾的替代方案。[Free limitations](https://render.com/docs/free)、[Recovery](https://render.com/docs/postgresql-backups)

**目前未付費、未啟用。** 部署資源與模型用量分開取得授權；平台帳單與 Gemini free-tier 狀態不能互相推論。未核准每日模型預算、未驗證 billing-disabled／free-only 政策時，公開模型維持關閉。

## 未來設定途徑（未配置）

在核准後才由 provider 的 Environment／secret 管理介面設定；不得進 Git、build artifact、`NEXT_PUBLIC_*`、client bundle 或 log。

| 名稱／契約 | 狀態 |
| --- | --- |
| `NODE_VERSION=26.8.1`、package `pnpm@11.2.2` | 已固定本機／CI；平台未驗證 |
| `PORT` | 平台提供；公開 launcher 尚未接受 |
| `DATABASE_URL` | 既有 DB 層支援，但目前 workbench launcher 自行覆寫成專用測試 DB；hosted startup 尚未實作 |
| `APP_ORIGIN` | 公開 HTTPS origin 待設定及驗證；不可拿 loopback 值代替 |
| `GEMINI_API_KEY` | 現有 local loader 的憑證名稱；hosted secret loader 未實作、未配置 |
| `DIVE_LOCAL_LIVE`、`DIVE_LOCAL_INGRESS_TOKEN`、`DIVE_LOCAL_IP_KEY` | 僅 local launcher 契約，不可移植為 public activation 設定 |
| 公開模型 enabled／daily budget／可信 IP hashing key | 設定介面未實作；不得虛構可用 env 名稱或把 caller assertion 當帳戶證據 |

## Retention、backup、restore 與 kill-switch gate

下列全部為**待執行 checklist**。既有語意與本機命令以 [retention](retention.md) 為準。

- [ ] 部署前指派 operator，實作 supervised hosted cleanup 與失敗／backlog 告警；預定每小時一次，連續兩次失敗或 backlog 不下降即調查。量測每 pass 最多 100 trips、100 empty owners、1,000 receipts 的吞吐是否足夠。
- [ ] 驗證 creation + 30 days 的 read-time expiry、分享失效與實體清除；busy leases、orphan、停機會延後實體清理，不宣稱第 30 天精準刪完。Quota receipts 從 reservation 起計 30 天且須符合 compaction 條件；identifier-free totals 保存 90 Taipei calendar days。
- [ ] 備份政策：候選 paid Hobby 的 PITR window 為 3 天（Pro 以上 7 天），provider logical exports 保存 7 天。另訂每日 logical backup 排程，匯出副本預定保存 7 天、任何備份不得超過 30 天；限制存取、確認加密與到期刪除，禁止 app 提供下載。以上均未配置。[Backup / recovery](https://render.com/docs/postgresql-backups)
- [ ] Restore 演練：先關閉入口、模型與 cleanup；還原到全新隔離 DB，核對 migration 與產品／ADK 一致性，再重套到期、刪除與分享撤銷決策。須能從 backup 之後的可信記錄重建決策；這套記錄／reconciliation 尚待實作，不能假設只跑 TTL cleanup 就足夠。成本／quota 不得因還原而重置或減少，未知費用保守計算；無法對帳則維持關閉。
- [ ] 記錄 restore 時間、恢復點、資料缺口與實測 RPO／RTO；確認 expired data 不可見、撤銷連結不復活，再驗證隔離 session 與 smoke。成功前不切 traffic，不覆寫原 DB。
- [ ] Kill-switch 演練：先拒絕新的 live start／resume；取消 in-flight workers 並等 bounded accounting 收尾；未知用量保留 reservation，不重試不明 invocation。尚無經驗證的 public switch；若未來 application switch 失效，operator 必須能封鎖入口並停止服務。驗證無新增 model dispatch，保留 DB／audit 證據。
- [ ] Rollback：停用 live、停止 cleanup 排程，再回到與現有 migration 相容的已驗證 fixture binary。保留 quota totals、版本、ADK history，不逆轉 compaction／刪資料／更改 migration checksum；恢復流量前重驗 acceptance。單純環境變數變更或平台 rollback 不代表已停止模型計費。

## Fixture CI 與本機驗證界線

[CI workflow](../.github/workflows/ci.yml) 在 GitHub-hosted ephemeral runner 循序跑 install → lint → typecheck → unit → dedicated Compose DB integration → build → production desktop/mobile E2E。固定 Node／pnpm，沒有 provider secrets、live flags 或 deploy job；live smoke 預設 skip。

`compose.test.yml` 的 `pull_policy: never` 保留不變，因此**未來 CI runner** 明示 pull `postgres:16-alpine`，再以 `--env-file /dev/null` 啟動。此 image tag 不是 immutable digest；這次不修改 Compose。唯一 `COMPOSE_PROJECT_NAME` 同時傳給 startup、test helper 與 teardown，隨機 loopback port、run 專用 volume；helper 只接受 `dive_trip_test`，案例建立隨機 schema。integration 與 E2E 不並行，always teardown 只清該 run 的 disposable DB。

CI 安裝依賴、image 與 Chromium 需要網路，但 fixture 模型不呼叫 provider；fixture-only 不代表完全無網路。Remote CI 暫停且 0 runs；本機結果以 [release evidence](release-evidence.md) 為準。Workflow root 必須是本 repository，release SHA 必須對應實際產品來源。
