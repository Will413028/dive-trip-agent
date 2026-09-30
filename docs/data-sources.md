# Task 2 資料與費用依據

`data/catalog.json` 包含 10 筆 **DEMO 示範資料**及 3 筆僅核對名稱／位置的真實景點參考。小琉球、綠島、墾丁各有示範住宿、陸上活動、潛水活動；另有小琉球示範固定費接送。DEMO 名稱不代表真實業者、商品、可訂狀態、現行價格或安全背書。

10 筆 DEMO 的座標與來源 URL 仍是 `null`，沒有替虛構業者套用真實景點位置。其 `checkedAt: 2026-09-19` 是示範資料編製日期，不是外部事實查核日期。價格 `basis` 與來源 `kind` 均為 `demo`，標題與來源標籤明示 DEMO。潛水活動價格為 `null` 並附原因，不能視為免費。

## 景點位置查核（2026-09-22）

| 目錄 ID | 地點與座標（緯度、經度） | 查核來源／範圍 |
| --- | --- | --- |
| vase-rock | 花瓶岩：22.35566, 120.38076 | [大鵬灣國家風景區旅遊資訊](https://www.dbnsa.gov.tw/zh-tw/attraction/AttractionPage?a=222)名稱與明列座標 |
| green-island-lighthouse | 綠島燈塔：22.67664, 121.466101 | [國家文化記憶庫／台東縣政府文化處](https://tcmb.culture.tw/zh-tw/detail?id=274381&indexCode=Culture_Place)名稱與所在地座標 |
| eluanbi-lighthouse | 鵝鑾鼻燈塔：21.902017, 120.852485 | [國家文化記憶庫／國立臺灣師範大學](https://tcmb.culture.tw/zh-tw/detail?id=476239&indexCode=Culture_Place)名稱與所在地座標 |

只採名稱與座標，不轉載描述、照片，不宣稱座標代表入口、集合點或適合下水的位置。文化資料不是即時營運資訊（綠島頁的「是否開放」為否），所以三筆均明示開放／費用待確認；不得據此保證能進入。`price.unitMinor=null`，`estimate` 是既有費用分類，不是已取得價格；`sourceId` 僅連回位置依據，不代表來源提供報價。三筆未自動加入既有行程，也未更動原 DEMO 快照。

## 目錄入口

### 2026-09-30 發布前複核

依上表三個原始官方頁逐項核對，名稱、目的地與緯經度仍與 `data/catalog.json` 相符。文化記憶庫頁是文化紀錄；花瓶岩頁的旅遊資訊也不代表本次造訪、交通或潛水活動的完整報價。三筆價格繼續為 `null`，產品標示開放／費用待確認；未把歷史頁的開放欄位變成即時保證。

其餘 10 筆均為自行編製 DEMO：無真實業者名稱、座標或來源 URL，單價依據為 demo；住宿使用 room-night、活動使用 person／group，3 筆示範潛水價格維持未知及非空原因。沒有現行真實報價可設定有效期，故不提供「價格有效至」主張；DEMO 編製日期與事實查核日期分開。現行 catalog 未重寫舊 bound snapshots。

本次 `pnpm catalog:validate` 回傳 `mechanicallyValid:true`、13 items、10 DEMO、10 without coordinates、6 unknown prices；命令本身仍為 `factVerification:not-performed`，外部名稱／位置驗證由上述官方頁支持。來源、DEMO、單位、unknown 與 exclusions 的呈現邊界依既有 compiler 及產品驗收；本項不證明真模型選擇品質。

`loadCatalog(input: unknown)` 驗證並回傳獨立資料物件；拒絕重複項目 ID、缺來源、無效目的地、價格來源 ID 未對應本項目、重複來源 ID、單邊／越界座標與非 HTTPS URL。`fact` 來源必須有 HTTPS URL；`demo` 可以是 `null`，但仍須有明示標籤。來源日期採 `YYYY-MM-DD`。

未知單價與非空白原因必須成對；已知單價必須是非負安全整數，且原因為 `null`。住宿按 `room-night` 計價，容量必須為正安全整數；活動按 `person` 或 `group` 計價，房間容量為 `null`。`findItems` 按單一目的地篩選並保留原順序。

## 費用語義

全部金額為 **TWD 分**：100 分 = NT$1，不使用浮點元數。

- `person`：`all` 使用旅客數、`divers` 使用潛水人數、`non-divers` 使用兩者差值。
- `room-night`：使用明確的 `rooms × (endDay - day)`；退房日不計住宿晚數。房間總容量須容納該項目 audience，不會自動增加房間或跨住宿項目補容量。
- `group`：固定數量 1，與參與人數無關。
- `person` 的參與人數為 0 時，即使單價未知仍貢獻已知 0；正數數量配未知單價則回傳該 entry ID。
- 所有項目的數量先驗證再計算，包括未知價項目。日期須在行程內，住宿至少一晚且至少一房；活動的 `rooms`、`endDay` 必須為 `null`。非法數量、容量或 unsafe integer 的容量／數量／金額乘積及加總會拋錯。
- `exclusions` 為尚未納入的費用說明，不會從既有費用扣款。預算未定、有未知費用、或 `exclusions` 非空時，`withinBudget` 一律為 `null`。其餘以已知總額小於等於預算判定。

固定 `makeSnapshot()`：2 人（1 人潛水）、4 天、3 晚 1 房，每房晚 100000 分；第 2 天早上全員活動每人 50000 分；同天下午固定費 30000 分。合計 430000 分（NT$4,300），預算 1000000 分，無 exclusions。每次呼叫產生獨立物件，production 不引用 tests。

本階段不加入即時資料、外部查價、預訂或付費呼叫。未來真實來源須逐項查核並更新來源、日期、費用依據；不可直接將 DEMO 改標為事實。

## 機械檢查入口

`pnpm catalog:validate` 重用 `loadCatalog`，拒絕空目錄並輸出DEMO、缺座標與未知價格數量；沒有網路請求，`factVerification` 固定為 `not-performed`。目前13筆中10筆DEMO、10筆沒有座標、6筆價格未知。此結果不是事實、位置或圖片授權驗證；人工核對範圍見上表。地圖接線、自動化降級及真實外網底圖桌面／手機目視驗收已完成，見 [assets-license](assets-license.md)；評估基礎見 [evaluation](evaluation.md)。
