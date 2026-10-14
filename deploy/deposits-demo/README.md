# PayPal 揪團訂金 demo profile 部署

決策：[ADR 2026-10-12](../../docs/adr/2026-10-12-paypal-hackathon-demo-profile.md)；設計：[paypal-group-deposits](../../docs/paypal-group-deposits.md)。本目錄與 hosted P7（[plan](../plan.md)）完全分開：不同 compose project、image、DB、Temporal、secrets 與 hostname，不改 P7 的 guard、trigger 或 migration 鏈。

## 組成

| Service | 內容 | 對外 |
| --- | --- | --- |
| `db` | PostgreSQL 18，專用帳號 `deposits` | 無 |
| `temporal` | Temporal dev server（SQLite volume） | 無 |
| `migrate` | 一次性 migration，`api`／`worker` 等它成功才啟動 | 無 |
| `api` | deposits HTTP API，只聽 `127.0.0.1:4420` | 無 |
| `web` | Next production server，共用 `api` 的 network namespace，聽 `:3000` | 只經 tunnel |
| `worker` | Temporal worker、結算 agent（唯一讀模型 key 的容器） | 無 |
| `tunnel` | cloudflared named tunnel → `http://api:3000` | Cloudflare |
| `void-holds` | maintenance profile：釋放全部 sandbox 預授權 | 無 |

不發布任何 host port。容器 read-only、drop all capabilities、no-new-privileges、有記憶體與 CPU 上限、log 輪替。

## 主機檔案（不進 Git）

`/home/ubuntu/dive-deposits-demo/` 放 repo checkout（exact SHA）與 `demo.env`：

```sh
DEMO_SECRETS_DIR=/home/ubuntu/.secrets/dive-deposits-demo
DEMO_REVISION=<git short SHA>
DEMO_ORIGIN=https://<demo hostname>
```

`DEMO_SECRETS_DIR` 目錄 `chmod 700`：

| 檔案 | 權限 | 內容 |
| --- | --- | --- |
| `db_password` | 644（容器內非 root 使用者要讀；目錄 700 擋其他主機使用者） | 隨機密碼 |
| `tunnel_token` | 644 | Cloudflare named tunnel token |
| `paypal.env` | 600 | `PAYPAL_CLIENT_ID`、`PAYPAL_CLIENT_SECRET`（sandbox app） |
| `models.env` | 600 | `GEMINI_API_KEY`、`GROQ_API_KEY`；可留空，留空即 No AI |

## 建置與啟動

```sh
cd /home/ubuntu/dive-deposits-demo
docker build -f deploy/deposits-demo/backend.Dockerfile -t dive-deposits-backend:$DEMO_REVISION .
docker build -f deploy/deposits-demo/web.Dockerfile -t dive-deposits-web:$DEMO_REVISION .
cd deploy/deposits-demo
set -a; . ../../demo.env; set +a
docker compose -f compose.yaml up -d
```

`.dockerignore` 是 allowlist：image 只含原始碼、lockfile 與 migrations；env 檔、`.artifacts`、`evals` 不進 build context。

## 每晚重建

`deposits-demo-nightly.timer`（10:00 UTC）執行 `nightly-rebuild.sh`：先停 tunnel／web／api／worker，跑 `void-holds` 釋放所有預授權，再 `down --volumes` 清空 DB 與 Temporal，最後 `up -d`。void 失敗仍會重建（sandbox 授權 29 天後自行失效），但以非零結束讓 timer 顯示失敗。

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

再刪除 Cloudflare tunnel 與 DNS record。同機其他服務不受影響：本 stack 只動 `dive-deposits-demo` project 的容器、network 與 volume。
