# Toolchain

## Python／Temporal toolchain

Web固定Node26.8.1／pnpm11.2.2。新backend使用Python3.13.13與uv0.7.2；`backend/uv.lock`固定本次解析結果，主要版本為FastAPI0.141.1、Pydantic2.13.5、PydanticAI2.51.0、Temporal SDK1.33.0、psycopg3.3.6／pool3.3.3、httpx2 2.13.1。SDK使用的httpx2與FastAPI測試用httpx分開，不能任意互換型別。

```sh
# 僅依賴準備步驟可能下載；日常命令使用 --frozen --no-sync。
uv sync --frozen --project backend
pnpm lint:backend
pnpm typecheck:backend
pnpm contracts:check
pnpm test:backend
```

DB測試使用已備妥的`postgres:18-alpine`、固定Docker context、當次唯一container／schema；不接受任意DB URL或環境檔。Temporal測試SDK可能在cache缺少時下載隔離測試工具；persistent launcher則必須明確提供已安裝的CLI1.9.1（server1.32.0／UI2.54.1），缺少或版本不符即拒絕，不下載。SQLite及產品DB须一起保留；任一重置不能靠修改binding接回。SDK／CLI升級須重跑跨程序重啟、history replay與刪除故障驗證。

CI 使用 [官方 setup-uv action](https://github.com/astral-sh/setup-uv/blob/main/README.md) 的固定 commit 安裝 uv 0.7.2；`python-version` 只設定 `UV_PYTHON`，所以另以 `uv python install 3.13.13` 安裝固定 Python，再以 frozen lockfile 安裝依賴。CI workflow 已接 backend lint／mypy／contracts／tests；實際結果見 [release evidence](release-evidence.md)。

本節不是整體切換完成宣告；新舊驗證證據依[遷移計畫](architecture-refactor.md)分開記錄。

## 2026-09-27 Native worker TypeScript 檢查

- `pnpm typecheck` 在 Next typegen／完整 strict typecheck 後，再以 `tsconfig.worker.json` 檢查 production worker 與 offline worker 的 dependency graph，啟用 `erasableSyntaxOnly:true`。共用 transport 的 parameter property 曾通過 Vitest transpilation 與原有 tsc，卻使 Node 原生 `.ts` worker 無法載入；已改為明確 field declaration／constructor assignment。
- 此限制只作用於兩個原生 Node worker 及其 import graph，不套用到由 Next／Vitest 編譯的無關程式碼；不使用 transform loader、不增加依賴，也不改原有 runtime deadline。新 config 已納入 evaluation source manifest，修改或缺檔都會改變／拒絕來源指紋。
- 這項 compiler guard 防止不可擦除的 TypeScript 語法；不能取代 native import、跨程序 integration、build 或 browser 驗證。此次 transport 診斷的實際驗證結果見 [evaluation](evaluation.md#offline-regression-and-diagnostics)。

## 2026-09-22 有限工具與 provider 補充

- 不新增相依或下載；ADK 2.1.0 內實際使用的 transitive GenAI SDK 為 2.23.0（lockfile 另一個 1.52.0 屬 vertexai dependency，不能混用）。
- Worker 採 Node 原生 TypeScript；domain/catalog import 閉包使用明確 `.ts`，provider 不用 parameter properties 或依賴測試 transpiler 才能載入。native import／實際 SDK endpoint 經乾淨子程序、假 transport 驗證。
- 310 unit、141 integration、38 production browser E2E、5 ADK 探針與 build／typecheck／lint 通過。Gemini adapter 與 quota 模組尚未接 HTTP；詳見 [model adapter](model-adapter.md)。

## 2026-09-21 對話整合補充

- 沿用 ADK 2.1.0／AG-UI 1.0.0，未新增套件或下載。執行方式與限制見 [工作台整合](adk-workbench.md)。
- 直接使用 MikroORM PostgreSQL driver 型別後，transitive `postgres-interval` 宣告引用 Temporal；使用既有 TypeScript 6 的 `ESNext.Temporal` lib，保留 `skipLibCheck:false`，未下載 polyfill。此專案固定 Node 26，不藉此承諾其他 runtime 相容性。

## 2026-09-21 產品資料層補充

- 前端新增 `@types/react@19.3.0`、`@types/react-dom@19.3.0`、`@playwright/test@1.63.0`；browser 測試需要對應的 Chromium。
- Next.js production build、20個production E2E通過。App Router採薄catch-all adapter保留各API URL契約，安全與domain流程集中於`src/server/http.ts`。
- 本機launcher使用官方 [test environment load order](https://nextjs.org/docs/app/guides/environment-variables#test-environment-variables) 跳過`.env.local`，並以檔名拒絕`.env`／`.env.test`／`.env.test.local`；不讀secrets。這只是離線demo環境，不是正式部署模式。
- `typecheck` 先跑 Next typegen，lib提升ES2024以支援Next宣告的PromiseWithResolvers。Next dev會額外生成dev types，檢查排除`.next/dev/**`避免與production declarations重複；保留`skipLibCheck:false`，不靠跳過型別驗證解決問題。
- 交易與HTTP回歸共62項，包含APP_ORIGIN內外host不同、實際鎖等待跨TTL、凍結catalog重播。003 migration新增catalog_snapshot，不改已套用的001／002 checksum。
- 增加直接依賴 `pg@8.23.0`（原已為 transitive dependency）與 `@types/pg@8.23.1`。
- `pnpm db:migrate` 使用既有 Node 原生 TypeScript 支援，不另下載 `tsx`；CLI 的本機 PostgreSQL 子程序測試已覆蓋。
- 所有交易使用同一個 checked-out client 執行 BEGIN／COMMIT／ROLLBACK，pool 上限 5；遵循 [node-postgres transactions](https://node-postgres.com/features/transactions) 與 [Pool API](https://node-postgres.com/apis/pool)。
- `compose.test.yml` 使用本機既有 PostgreSQL 16 image、獨立 volume 與 loopback 隨機 port；不是正式部署設定。`pnpm test:integration` 以每案例 schema 隔離，禁止連其他專案 DB。
- 後續 ADK 探針已加入 `pnpm-workspace.yaml`，明確禁止其列出的 dependency build scripts；下方「沒有 workspace 檔」是 Task 1 當時狀態，不是現況。ADK 與 AG-UI 版本／限制見 [探針報告](adk-ag-ui-spike.md)。

## Task 1 選型紀錄（歷史）

查證日期：2026-09-19。此階段提供 domain 型別、需求驗證及離線 unit tests，尚無頁面、資料庫連線或部署。Node 與 pnpm 使用本機既有版本，沒有安裝 global tooling。

## 固定版本與相容性

`package.json` 的直接依賴全部固定精確版本；`engines` 固定 Node 26.8.1、pnpm 11.2.2，`packageManager` 為 `pnpm@11.2.2`。`pnpm-lock.yaml` 由本專案獨立解析產生。

| 套件 | 固定版本 | Registry engines／必要 peer dependencies |
| --- | --- | --- |
| Node.js | 26.8.1 | 本機 `node --version` 為 `v26.8.1`；官方標示 Current |
| pnpm | 11.2.2 | Node `>=22.13` |
| Next.js | 16.3.5 | Node `>=20.9.0`；React／React DOM `^18.2.0 \|\| 19.0.0-rc-de68d2f4-20241204 \|\| ^19.0.0` |
| React | 19.3.0 | Node `>=0.10.0` |
| React DOM | 19.3.0 | React `^19.3.0` |
| TypeScript | 6.0.2 | Node `>=14.17` |
| Zod | 4.6.5 | 未宣告 engines 或 peers；官方要求 TypeScript strict，測試基準為 TypeScript 5.5 以上 |
| Vitest | 5.0.1 | Node `^22.12.0 \|\| ^24.0.0 \|\| >=26.0.0`；Vite `^6.4.0 \|\| ^7.0.0 \|\| ^8.0.0` |
| Vite | 8.3.0 | Node `^20.19.0 \|\| >=22.12.0` |
| ESLint | 10.10.0 | Node `^20.19.0 \|\| ^22.13.0 \|\| >=24` |
| @eslint/js | 10.0.1 | 同 ESLint Node 範圍；optional ESLint peer `^10.0.0` |
| typescript-eslint | 8.70.0 | Node `^18.18.0 \|\| ^20.9.0 \|\| >=21.1.0`；ESLint `^8.57.0 \|\| ^9.0.0 \|\| ^10.0.0`；TypeScript `>=4.8.4 <6.1.0` |
| @types/node | 26.6.1 | 無 engines 限制或必要 peers |

Vitest 的 optional `@types/node` peer 為 `^22.0.0 || >=24.0.0`；Vite 的為 `^20.19.0 || >=22.12.0`，所選版本皆符合。未使用的 optional peers（browser runners、coverage、Sass 等）未加進專案。

Registry 的 TypeScript latest 為 7.0.2，但超過 typescript-eslint 的支援範圍，因此固定 6.0.2。初次選用 ESLint 10.11.0 與 @types/node 26.6.2 時，pnpm 自動加入 minimumReleaseAgeExclude；已移除例外，改採 10.10.0 與 26.6.1，清除本次生成的 node_modules／lockfile 後重新解析。最終不含 pnpm-workspace.yaml 或 release-age 政策例外。

Node 26.8.1 是本機可用且通過所有套件 engines 的 Current 版本，並非 LTS 選型承諾；正式部署環境留待後續任務確認。本次只驗證 domain 開發工具，尚未驗證 Next.js build／頁面 runtime。

## 可重現命令

在專案目錄、使用上述 Node／pnpm 版本執行：

```sh
pnpm install --frozen-lockfile --strict-peer-dependencies
pnpm test:unit
pnpm typecheck
pnpm lint
```

`test:unit` 執行 `vitest run tests/unit`，test environment 為 `node`；不依賴 Next.js 頁面、瀏覽器或環境變數。TypeScript 啟用 strict；ESLint 使用 flat config 與 typescript-eslint recommended rules。

## 服務前置

Unit、typecheck、lint 需要固定 Node／pnpm 與已安裝依賴，不需要外部帳號、provider、資料庫或密鑰。Integration 另需專用 Docker PostgreSQL，browser 測試另需 Chromium；重現方式見 [README](../README.md)。CLI 或工具可用不代表模型、付費或部署已獲授權。

## 查證來源

- [Node 26.8.1 官方 release](https://nodejs.org/en/blog/release/v26.8.1)
- [Next.js 安裝條件](https://nextjs.org/docs/app/getting-started/installation)
- [pnpm 安裝與相容性](https://pnpm.io/installation)：線上文件已顯示較新主線；11.2.2 的精確 engines 以版本化 registry metadata 為準。
- [Vitest 安裝條件](https://vitest.dev/guide/)
- [Zod TypeScript／strict 要求](https://zod.dev/)
- [Zod schema API](https://zod.dev/api)：使用 strictObject、iso.date 與 refine。
- [typescript-eslint 支援版本](https://typescript-eslint.io/users/dependency-versions/)
- Registry 精確版本：[pnpm](https://registry.npmjs.org/pnpm/11.2.2)、[Next.js](https://registry.npmjs.org/next/16.3.5)、[React](https://registry.npmjs.org/react/19.3.0)、[React DOM](https://registry.npmjs.org/react-dom/19.3.0)、[TypeScript](https://registry.npmjs.org/typescript/6.0.2)、[Zod](https://registry.npmjs.org/zod/4.6.5)、[Vitest](https://registry.npmjs.org/vitest/5.0.1)、[Vite](https://registry.npmjs.org/vite/8.3.0)、[ESLint](https://registry.npmjs.org/eslint/10.10.0)、[@eslint/js](https://registry.npmjs.org/@eslint/js/10.0.1)、[typescript-eslint](https://registry.npmjs.org/typescript-eslint/8.70.0)、[@types/node](https://registry.npmjs.org/@types/node/26.6.1)。
