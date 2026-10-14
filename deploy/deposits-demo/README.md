# PayPal 揪團訂金 demo profile 部署

決策：[ADR 2026-10-12](../../docs/adr/2026-10-12-paypal-hackathon-demo-profile.md)；設計：[paypal-group-deposits](../../docs/paypal-group-deposits.md)。本目錄與 hosted P7（[plan](../plan.md)）完全分開：不同 compose project、image、DB、Temporal、secrets 與 hostname，不改 P7 的 guard、trigger 或 migration 鏈。

## 組成

| Service | 內容 | 對外 |
| --- | --- | --- |
| `db` | PostgreSQL 18，專用帳號 `deposits` | 無 |
| `temporal` | Temporal dev server（SQLite volume） | 無 |
| `migrate` | 一次性 migration，`api`／`worker` 等它成功才啟動 | 無 |
| `net` | 只持有 network namespace（`sleep infinity`），api 與 web 加入；api 重啟不會讓 web 斷線 | 無 |
| `api` | deposits HTTP API，只聽 `127.0.0.1:4420` | 無 |
| `web` | Next production server，與 api 共用 `net` 的 namespace，聽 `:3000` | 只經 `ts` |
| `worker` | Temporal worker、結算 agent（唯一讀模型 key 的容器） | 無 |
| `ts` | 專用 Tailscale node（`tag:dive-demo`），Funnel 只轉送 `https://dive-deposits.<tailnet>.ts.net` → `http://net:3000`；不參與每晚重建，網址固定 | Tailscale Funnel |
| `void-holds` | maintenance profile：釋放全部 sandbox 預授權 | 無 |

不發布任何 host port。容器 read-only、drop all capabilities、no-new-privileges、有記憶體與 CPU 上限、log 輪替。

## 主機檔案（不進 Git）

`/home/ubuntu/dive-deposits-demo/` 只放本目錄的部署檔（`deploy/deposits-demo/`）與 `demo.env`，不放原始碼：

```sh
DEMO_SECRETS_DIR=/home/ubuntu/.secrets/dive-deposits-demo
DEMO_REVISION=<git short SHA>
DEMO_ORIGIN=https://dive-deposits.<tailnet>.ts.net
```

`DEMO_SECRETS_DIR` 目錄 `chmod 700`：

| 檔案 | 權限 | 內容 |
| --- | --- | --- |
| `db_password` | 644（容器內非 root 使用者要讀；目錄 700 擋其他主機使用者） | 隨機密碼 |
| `paypal.env` | 600 | `PAYPAL_CLIENT_ID`、`PAYPAL_CLIENT_SECRET`（sandbox app） |
| `models.env` | 600 | `GEMINI_API_KEY`、`GROQ_API_KEY`；可留空，留空即 No AI |

## 建置與啟動

Mac 與 oci-a1 同為 ARM64：在本機以 exact SHA 建置，再載入 VM，VM 不需原始碼與 pnpm／uv。

```sh
REV=$(git rev-parse --short HEAD)
docker build -f deploy/deposits-demo/backend.Dockerfile -t dive-deposits-backend:$REV .
docker build -f deploy/deposits-demo/web.Dockerfile -t dive-deposits-web:$REV .
docker save dive-deposits-backend:$REV dive-deposits-web:$REV | gzip | ssh oci-a1 'gunzip | docker load'
```

VM 上：

```sh
cd /home/ubuntu/dive-deposits-demo/deploy/deposits-demo
set -a; . ../../demo.env; set +a
docker compose -f compose.yaml up -d
```

`.dockerignore` 是 allowlist：image 只含原始碼、lockfile 與 migrations；env 檔、`.artifacts`、`evals` 不進 build context。

## 公開入口（第一次）

tailnet policy 需有 `tagOwners` 的 `tag:dive-demo` 與對它開 `funnel` 的 `nodeAttrs`，DNS 頁開啟 MagicDNS 與 HTTPS Certificates。第一次 `up` 後，`docker compose -f compose.yaml logs ts` 會印出登入網址，由擁有該 tag 的 admin 核准；不使用 auth key。身分存於 `ts-state` volume，每晚重建不動它；若 volume 遺失，重新核准一次即可。

## 每晚重建

`deposits-demo-nightly.timer`（10:00 UTC）執行 `nightly-rebuild.sh`：先停 web／api／worker，跑 `void-holds` 釋放所有預授權，再移除 app、DB 與 Temporal 容器及其 volume，最後 `up -d`。`ts` 與其 state 不動，公開網址不變。void 失敗仍會重建（sandbox 授權 29 天後自行失效），但以非零結束讓 timer 顯示失敗。

```sh
sudo cp deposits-demo-nightly.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now deposits-demo-nightly.timer
```

## 停用與移除

```sh
docker compose -f compose.yaml --profile maintenance run --rm void-holds
docker compose -f compose.yaml --profile maintenance down --volumes
sudo systemctl disable --now deposits-demo-nightly.timer
```

再到 Tailscale 後台移除 `dive-deposits` 裝置與 auth key。同機其他服務不受影響：本 stack 只動 `dive-deposits-demo` project 的容器、network 與 volume。
