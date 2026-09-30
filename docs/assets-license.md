# 展示素材與地圖授權清單

查核日期：2026-09-22。本輪沒有下載、熱連結或加入外部照片。

- 花瓶岩官方頁照片：未取得逐張商業展示授權，未使用。
- 綠島燈塔、鵝鑾鼻燈塔的國家文化記憶庫數位物件標示 CC BY-NC 3.0 TW +；不納入接案作品。來源連結見 [data-sources](data-sources.md)。描述文字與數位物件授權不同，不能以文字可用推論照片可用；本作品未轉載兩者。
- 地點名称與座標為人工核對的事實欄位，不代表照片／整頁內容的使用許可。
- MapPanel 使用 OpenStreetMap standard raster 底圖；照片仍未使用，沒有本地保存瓦片資產。

## 地圖供應與隱私

依 [OpenStreetMap raster tile 使用政策](https://operations.osmfoundation.org/policies/tiles/)使用 `https://tile.openstreetmap.org/{z}/{x}/{y}.png`，可見歸屬連到 [ODbL 說明](https://www.openstreetmap.org/copyright)。OSM 資料開放不代表公共瓦片伺服器是無限制免費 CDN；服務無 SLA，可能被封鎖。未下載 SDK，未啟用付費。

使用者點擊後才載入目前選定景點的 viewport（最多9張，zoom 12–16），不預抓其他景點／縮放層，不提供離線下載，不代理或繞過瀏覽器快取。img 明設 `referrerPolicy="origin"`，只傳 origin，不傳 `/trips/<id>`；API／分享頁的 no-referrer 保護不變。外部來源連結用 noreferrer。IP、瀏覽器資訊與目前瓦片區域仍會傳往 OSM，UI 在連線前明示。

位置必須是已套用行程、且與隨程式發行的已查核目錄 ID／目的地／座標一致；標籤與來源取可信目錄，不使用模型文字。未核對項目顯示計數，不給假位置。一次聚焦一個景點，可切換／縮放，不支援拖曳、路線或時間推估。版本變更會關閉底圖；需重新點擊才連線。

單張載入錯誤或8秒未完成即移除底圖，保留座標、來源、手動重試與行程操作。自動化回歸驗證一律攔截外部瓦片，以本地合成 SVG 測成功、abort 測失敗、掛起測 timeout；不把 mock 截圖當真實底圖或服務可用性證據。公開部署前重新檢查服務政策與容量。

## 真實網路目視驗收

### 2026-09-30 發布前素材與政策複核

再次閱讀 [OSM raster tile 政策](https://operations.osmfoundation.org/policies/tiles/)：正常互動 viewport 可使用，需可見 attribution、有效 Referer、遵守瀏覽器快取，不可批量下載、預抓或離線保存。`MapPanel.tsx` 仍只有使用者點擊後載入當前 viewport，img 明示 `referrerPolicy="origin"`，attribution 可見並提供回報問題連結；沒有瓦片代理或預抓工作。本次沒有發送真實瓦片請求，hosted Referer／快取／容量與桌面手機顯示在部署階段另驗。

兩個文化記憶庫原始頁的數位物件仍標示 CC BY-NC 3.0 TW +；它們與花瓶岩頁的圖片均未納入作品。盤點 `git ls-files '*.png' '*.jpg' '*.jpeg' '*.webp' '*.gif' '*.svg' '*.woff' '*.woff2' '*.ttf' '*.mp4' '*.ico'` 未列出追蹤素材檔；再用 `rg -n 'https://|url\(|<img|next/font|<Image' src/app src/features src/components package.json` 核對產品引用，圖片入口是上述 OSM viewport，無外部照片或字型載入。此結論限當次程式來源；將來新增素材須重做盤點。CSS／文字介面與地圖標記由本專案程式產生，不轉載官方描述。

2026-09-22另以headed Chromium開啟本機production工作台，經使用者操作路徑建立驗收DEMO、替換花瓶岩並接受，點擊後才載入真實OSM底圖。單一zoom14視窗共6張瓦片，全HTTP200；沒有攔截、背景預抓、拖曳或縮放掃描。桌面1100×900、手機390×844沿用同一底圖，已目視位置標記、來源、座標與可見attribution，手機無水平溢出。這是當次連通與顯示證據，不是SLA或精確入口／安全認證。未送出模型請求。
