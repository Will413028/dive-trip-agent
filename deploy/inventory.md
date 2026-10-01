# Oracle 部署前盤點

核對：2026-10-01；產品基線2537b95，完整程式gate基線d5a5ad2。

## 新能力與外部介面

| 需求 | 實作與驗收步驟 |
| --- | --- |
| 公開HTTPS固定情境DEMO | 計畫2–4 |
| 專用產品DB與Temporal持久性 | 2–4 |
| Cookie／同源／owner／SSE／分享與刪除 | 2、4 |
| 限制公開請求與匿名儲存成長 | 2–4 |
| 啟停、版本、清理、告警、備份與復原 | 3–5 |
| Cloudflare Worker與專用Tunnel／VPC服務 | 1、3–4 |

## 現況與去向

| 現有機制 | 去向 |
| --- | --- |
| bootstrap.local／runtime 的loopback fixture入口 | 保留本機；新增獨立hosted fixture入口，不放寬local live政策 |
| fixture_conninfo 的test DB／placeholder／trust | 保留離線；hosted用專用DB帳戶與secret file，不搬本機資料 |
| stack.py內Temporal dev SQLite | 保留離線；hosted用獨立Temporal Server與PostgreSQL，禁止借其他專案cluster |
| Next loopback backend proxy | 保留本機模式；hosted只允許固定專用backend，不接受caller URL，兩模式分別回歸 |
| HttpBoundary的固定Origin／Secure cookie | 保留；hosted固定HTTPS origin，不信任Host／Forwarded |
| PlanningService、Domain、receipt、deletion／retention | 保留業務規則；接專用新儲存與worker，不接generation配置 |

產生／重查指令：`rg -n 'fixture_conninfo|LOOPBACK_ORIGIN_REQUIRED|FixtureDispatcher|origin|127.0.0.1' backend/src/dive_trip/bootstrap src/server/backend.ts`。

VM已SSH核對：oci-a1／ubuntu，Ubuntu24.04 ARM64，4CPU／24GB，當下available約17GB、root約100GB可用，Docker Compose5.1.4；目標/home/ubuntu/dive-trip-agent不存在。其他服務同機在線，不改其容器／資料／secret／網路。重查只用uname、free、df與docker stats，不讀service environment。

宿主Node22不符合產品26.8.1；容器固定產品toolchain，禁止升級宿主Node影響其他服務。Cloudflare操作使用既有本機授權，不能從其他產品複製credentials。既有OAuth權限已查；完整subscription僅R2、無Workers Paid，fathompod子網域、dive-trip-agent尚未存在。OAuth無subscription讀權限（403），以本專案既有只讀token核對完整inventory，未發模型；其他專案credentials未讀取。
