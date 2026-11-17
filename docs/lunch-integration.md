# 今日午餐：介接驗證與首版規格

2026-11-17 實測。已完成資料層、午餐視窗與手動更新工作流程；午餐與公告資料獨立，固定排程須通過雲端與手機驗收後再啟用。

## 驗證結果

五校的公開當日供餐、菜單與食材查詢均成功，不需帳號或存取碼。這是官方前端目前使用的查詢服務，並非另行登錄取得存取碼的月資料集 OpenAPI；尚無版本相容或服務可用性承諾，應集中在單一資料轉接模組。

| 學校 | SchoolId | 當日供餐商數 | 菜色數（排除調味料） |
| --- | --- | --- | --- |
| 仁愛 | 333605 | 3 | 18 |
| 建安 | 333604 | 2 | 12 |
| 敦化 | 313604 | 1 | 10 |
| 博愛 | 323609 | 1 | 6 |
| 光復 | 323603 | 1 | 9 |

實測共 8 組供餐、55 道菜；每家供餐商抽查一道菜的食材與圖片，共 8 組樣本。不是全校、所有日期、每道菜的完整性保證。

JSON 與圖片樣本均回應 HTTP 200，觀察到 `Access-Control-Allow-Origin: *`。使用 `User-Agent: school-news-data-verification/1.0`；部分未帶此識別的 Python 請求得到 403，不應將單次成功視為所有環境都能直接存取。上線前仍需在 GitHub Actions 實測資料更新。

## 已驗證的請求與欄位

主機為 `https://fatraceschool.k12ea.gov.tw`。僅讀取公開資料，不使用前端程式內其他 API key。

1. `GET /offered/meal?KitchenId=all&MenuType=1&period=2026-11-17&SchoolId=333605`
   - 回應 `{result: 1, message, data: [...]}`。
   - 每組保留 `BatchDataId`、`KitchenId`、`KitchenName`、`SchoolId`、`SchoolName`、`MenuDate`、`MenuType`、`UploadDateTime`。
   - 日期是 `YYYY/MM/DD`；上傳時間是含 `Z` 的時間戳。查詢日以 `Asia/Taipei` 計算。
   - `BatchDataId` 必須保留為字串，不依陣列順序識別供餐商。
2. `GET /dish?BatchDataId=<BatchDataId>`
   - 保留 `DishBatchDataId`、`BatchDataId`、`DishId`、`KitchenId`、`DishName`、`DishType`、`DishOrder`、`UpdateDateTime`。
   - `DishName` 為「調味料」的記錄另存，不列入菜色卡片；它可能沒有 `DishType` 等欄位。
   - 保留 `(素)`、`(素特)` 等原始名稱；樣本未提供獨立的素食餐種欄位，不把名稱推論當成完整素食菜單，也不隱藏未標示菜色。
3. `GET /ingredient?BatchDataId=<BatchDataId>&DishId=<DishId>`
   - 抽樣取得 `IngredientName`、`Manufacturer`、`IngredientSourceNameList`、`SupplierName`、`Certification`、`StockDate` 等欄位。
   - 產地使用 `IngredientSourceNameList`／`IngredientSource`，不可只讀可能空白的 `Origin`。
   - 保留缺值與 `StockDate`；進貨資料未登錄時明確標示，不能聲稱食材已完整確認。驗證回應批次／菜色對應；缺欄位不得混入別餐資料。
4. 官方前端對數字 `DishId` 使用 `GET /dish/pic/<DishId>`。
   - `PicturePath` 空白時，這個圖片路徑仍可能有圖；不能用它判定「無照片」。
   - 官方程式另支援非數字 `DishId` 的 `DishShowName` 圖片路徑，但本次樣本未驗證該分支。
   - 圖片抽樣有 JPEG 與 PNG，大小約 30 KB 至 2.41 MB。不要在公告首屏預先下載整份菜單圖片。
   - 圖片以菜色 ID 對應，沒有當日拍攝時間證據；不得稱為「今天實拍」。圖片重製／縮圖授權尚未確認，不先把官方照片複製進站內資產。

## 官方連結

使用 `https://fatraceschool.k12ea.gov.tw/frontend/search.html?school=<SchoolId>&period=<YYYY-MM-DD>`。

已在瀏覽器確認仁愛 `2026-11-17` 與 `2026-11-16` 都選中正確學校、日期並載入不同菜單。連結標示「查看官方完整資料」，它是學校／日期層級，不承諾直達指定菜色或供餐商。

## 首版資料流程

以排程在伺服端讀取官方服務，產生每校獨立的精簡 JSON 快照，再由 Pages 提供，避免每位家長開啟視窗時重複打數十個官方請求。首版不需要 AI、家長登入或新資料庫。

- 午餐更新獨立於 RSS；只發布通過驗證的資料。每校／每批次核對學校、日期、餐別與 ID。
- 每校 `data/lunch/<slug>.json` 包含 `schemaVersion`、`schoolSlug`、`schoolId`、`schoolName`、`mealDate`、`fetchedAt`、`status`、`sourceUrl` 與 `providers[]`。`data/lunch/status.json` 另外保存 `requestedDate`、`checkedAt`，以及每校的 `status`、`errors`、`lastSuccessAt` 與 `snapshot`（路徑、SHA-256、餐日、抓取時間、資料狀態）。失敗時保留原快照 bytes，不以最新嘗試時間冒充完整成功。每組供餐保留原始 ID、名稱、來源上傳時間、菜色、食材及調味料；快照不含圖片二進位資料。
- 初期工作日於臺灣時間 08:00、10:30、12:30 更新，可手動重跑；先在 Actions 驗證流量與回應，再啟用排程。排程時間不是準時更新保證。
- 請求設定逾時、大小限制、低併發與有上限的重試。單張照片失敗不能讓文字菜單更新失敗。
- 完整有效且非空為 `available`；有效空陣列為 `no-record`；供餐查詢的連線／格式／對應驗證失敗為 `error`。供餐商或菜色明細只完成一部分時為 `partial`，記錄缺少的供餐商／菜色，不發布該校的不完整菜單。食材查詢有效但尚無進貨登錄，則保留內容並以 `ingredientStatus` 標示 `not-registered`／`partial`／`registered`；這不是完整性或安全性的保證。
- 部分學校失敗時，保留其最後成功快照及原始餐日、在狀態清單記錄失敗；舊資料不可改標今天。同一天已取得菜單後出現空回應也保留原菜單。全校皆失敗或不完整時不寫任何公開資料，回傳非零，另以 `--report`／Actions artifact 記錄本輪錯誤；前端需依餐日與檢查時間顯示資料過期。
- `2026-11-15` 仁愛實測為 HTTP 200、`result: 1`、`data: []`；它只證明該查詢無記錄。首版顯示「今日尚無菜單資料」，不自行推斷假日、停課或不供餐。

## 首版畫面與驗收

Hero 加入精簡「今日午餐」按鈕，桌機 dialog、手機全螢幕 dialog。開啟才請求午餐狀態與本校快照，核對原始 bytes 的 SHA-256 再顯示文字菜單與食材。首版照片透過官方完整資料連結查閱；照片展示方式待來源使用條件查核後另行啟用。

按供餐單位分組，顯示日期、官方上傳時間與本站更新時間。食材在菜色下方展開，保留製造商、產地與供應商的區別；官方完整資料連結帶學校與餐日。

實作需涵蓋：多供餐商、名稱含素食標記、調味料缺欄位、沒有菜單、部分失敗、更新失敗、跨日舊快照、缺圖／大圖、鍵盤焦點與 Escape、手機關閉及返回後公告狀態不變。午餐失敗不影響公告閱讀；不根據食材名稱自行推算安全性或過敏原。

## 來源與證據

- [官方查詢頁（仁愛 2026-11-17）](https://fatraceschool.k12ea.gov.tw/frontend/search.html?school=333605&period=2026-11-17)
- [官方資料服務定義](https://fatraceschool.k12ea.gov.tw/frontend/js/app/FoodTraceAPI.js)、[官方菜色圖片程式](https://fatraceschool.k12ea.gov.tw/frontend/js/app/view/FSDishItemView.js)
- [官方月資料集 OpenAPI 文件](https://fatraceschool.k12ea.gov.tw/cateringservice/web/openapi_doc/v1/index.html)
- [政府資料開放平臺資料集](https://data.gov.tw/dataset/98339)：列出政府資料開放授權條款第 1 版；尚未確認涵蓋上述每日查詢服務的圖片。

前期原始 JSON、HTTP 摘要、8 組圖片標頭／檔頭證據與可重跑的 `probe.py` 保存在工作紀錄的 `school-news-lunch-research/api-spike/`，沒有複製圖片資產。

本輪 `scripts/update_lunch.py` 已實際抓取並驗證五校全部菜色與食材：8 組供餐、55 道菜、3 組調味料、157 筆食材記錄，輸出 5 份完整快照與 1 份狀態清單。`scripts/lunch_contract.py` 在更新、讀取舊資料及發布打包時驗證欄位、身份與雜湊；照片只保留受限於官方主機的數字 ID 路徑，未下載或複製圖片。

已接上 Hero 入口、桌機 dialog／手機全螢幕 dialog、食材明細與舊資料提示。`lunch-client.mjs` 獨立處理原始 bytes 雜湊、部署版本重試、本校離線快照與逾時／取消；`lunch-ui.mjs` 處理顯示及焦點／返回／捲動保存。Service worker 保留獨立午餐快取，但不直接快取午餐 JSON，避免資料與狀態混版。

發布時需完成 GitHub Actions 實際連線及正式版手機流程驗收，通過後啟用午餐排程。
