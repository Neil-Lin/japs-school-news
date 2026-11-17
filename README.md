# 仁愛、敦化、建安、博愛、光復國小消息牆

資料來源：仁愛國小、建安國小、敦化國小、博愛國小、光復國小與臺北市教育局。

各校獨立網址：`/renai/`、`/jianan/`、`/dunhua/`、`/boai/`、`/guangfu/`。

以 GitHub Pages 發布的學校消息彙整頁面，每日臺灣時間 10:30、16:30 由 GitHub Actions 更新 RSS 資料。資料保留最近一年，來源錯誤會寫入 `articles.json` 並在 workflow 中顯示。

本機需 Python 3.9+ 與 Node.js 20+。執行 `python3 scripts/update_feed.py` 可更新資料並自動產生分校檔；網站會依學校、分類與關鍵字搜尋顯示發布時間、標題、原文連結或內容摘要，並顯示各校今日新增筆數與來源更新狀態。前端設定集中在 `config.json`，資料版本寫在 `data/version.json`，各校精簡公告位於 `data/schools/<slug>.json`；頁面只下載當校的一年份資料，內容未變時重用快取。

部署前會執行完整離線檢查，包含設定、產生頁面、程式、公告欄位、附件格式、網址與重複 ID；RSS 更新後會再驗證一次，驗證失敗就不會發布新資料。臺北市教育局來源因網站憑證與 Python TLS 相容性問題，使用仍會驗證憑證的 `curl` 抓取，其餘來源維持 Python 抓取。

網站支援 PWA 安裝，設定集中在 `manifest.json` 與 `templates/sw.js`，後者會產生 `sw.js`。公告資料採網路優先策略，離線時才使用上次快取的資料；`scripts/generate_pwa_assets.py` 可重新產生 icon 與 iOS 啟動畫面。

分類支援 checkbox 多選，預設不勾選「教育局消息」「研習資訊」「教師研習及活動」，其餘分類預設勾選；使用者仍可手動選取或按「全部」全選／取消全選，部分選取時顯示半選。預設排除以穩定分類 ID 定義，分類改名仍維持原設定；不依公告標題猜測受眾。分類之間取聯集，因此同篇若也出現在已選的親職資訊等分類，仍會顯示。搜尋條件再取交集；未選任何分類時不顯示公告。網址以分類 ID 記錄 `categories`、`q`、`page`，可分享並還原明確選擇；`categories=` 代表全不選，沒有該參數才使用預設。分類 ID 集中於 `config.json` 的 `categoryIds`，修改顯示名稱時應保留 ID。

首次取得專案後，先執行 `python3 scripts/build_site.py` 產生本機資產，再執行 `python3 -m http.server 8000`，開啟 `http://localhost:8000/`。前端使用原生 ES modules，需透過 HTTP 預覽。完整回歸檢查統一使用 `python3 scripts/check_project.py`，不連線抓取 RSS、不提交或部署。它會檢查產生檔是否最新、重建資產、檢查 JavaScript 語法、執行 Node／Python 測試及資料驗證。工作流程 YAML 契約測試使用系統 Ruby/Psych；未安裝 Ruby 時會明確跳過該組測試，其餘檢查照常執行。


公告合併使用正規化原文網址或來源範圍內的 GUID，不以標題合併；同名不同篇公告會分開保留，同篇跨分類公告保留全部來源原文與附件。每個 RSS 來源在 `config.json` 有穩定的 `id`，修改名稱／網址時應保留 ID。

RSS 更新會區分合法空 RSS、可完整復原的格式異常、解析失敗與連線失敗。連線失敗最多重試一次；部分來源失敗時保留歷史資料及各來源最近成功時間，全數失敗不改寫資料檔。零筆或筆數驟減會記錄警告；公告日期必須有時區，原文與附件連結僅接受 HTTP(S)。輸出先暫存及驗證，再依序替換公告與版本清單，版本清單最後更新；替換失敗會回復已更換的公告檔，讀取端也會偵測部署期間的版本不一致。

部分敦化 RSS 的 description CDATA 內含 XML 1.0 不允許的 U+000B 控制字元。解析器只在這類內文區塊將不允許的控制字元轉成空白，再重新解析完整 XML；保留警告並記錄數量與字元碼，不改寫原文網址、GUID、日期或附件。替換後仍無法完整解析時視為來源失敗，保留上次成功資料；合法的 tab、換行與其他文字不會被清除。

`data/version.json` 維持 `schemaVersion: 2`，保留原始公告內容雜湊 `dataVersion`、設定雜湊 `configVersion`、來源時間與狀態；另以 `schoolDataSchemaVersion: 1` 及 `schools` 記錄每校檔案路徑、內容雜湊與合併後筆數，讓舊版讀取端仍相容。`data/articles.json` 保留作 RSS 歷史狀態與舊版相容用途，新版頁面不會下載完整檔。

分校檔於產生階段使用同一套公告合併規則，預先合併、排序，省略可由設定還原的來源網址、學校及分類名稱。`school-data.mjs` 共用序列化／還原邏輯；`scripts/build_school_data.mjs` 由 Python 發布流程在暫存目錄呼叫，全部檔案驗證成功才發布，版本清單最後替換，任何替換失敗會回復已更換的分校檔與原始檔。驗證會核對每校全部原始公告及附件皆有對應，防止分檔時遺失資料或混入其他學校。

前端以每頁 `<body data-school="slug">` 選擇資料，設定與當校內容通過雜湊驗證才儲存。其他學校有新公告不會讓當校重下載資料；無變更重開僅重新檢查小型版本清單。版本不一致最多重試一次，8 秒逾時後使用該校上次成功快照，超過 24 小時未檢查亦提示。快取按網站路徑隔離，每校只保留一份完整快照；已連線看過的學校可離線閱讀，尚未儲存的學校會提示先連線並保留切校導航，不會顯示其他學校的資料。原有跨校完整快照可在離線時逐校轉換，直到所有學校的替代快照均驗證保存成功才清除舊檔。頁面資源仍預快取五校 HTML。

使用 `node scripts/measure_performance.mjs` 重現公告檔與首次資料請求（含設定、版本清單）的大小、gzip 試算，以及本機 Node JSON 解析／資料準備與篩選時間；時間不包含網路、雜湊及 DOM 渲染，不等同真實手機的頁面載入時間。

舊資料或既有快照可用 `python3 scripts/update_feed.py --migrate` 重新產生完整與分校資料，不連線抓 RSS，也不更改原檢查時間。資料格式轉換、程式、設定與版本清單須一起發布；讀取端保留舊版 timestamp-only 清單的相容處理。

## 修改版型與建置

共用頁面請修改 `templates/page.html`，學校名稱、slug、官網、來源與分類則修改 `config.json`。根頁與五校的 `index.html`、`sw.js`、`assets-manifest.json` 都是產生檔，請勿直接編輯。新增學校需要補齊設定與 RSS 來源、產生資料，再產生頁面，不必複製 HTML。

```sh
python3 scripts/build_site.py
python3 scripts/check_project.py
python3 scripts/build_site.py --output dist
python3 -m http.server 8000 --directory dist
```

修改 JS、CSS、模板、學校設定或 PWA 圖示後，重新建置並連同產生檔提交。`python3 scripts/build_site.py --check` 只檢查，不寫檔；可攔截漏建置或手改產生頁面的情況。`static/` 與 `dist/` 忽略版控，CI 會重建；乾淨 checkout 缺少 `static/` 屬正常，完整檢查會先還原它。

建置器依內容產生帶雜湊的 JS／CSS 檔名，並同步改寫模組 import、HTML、service worker 預快取與 `assets-manifest.json`。底層模組變動會更新相依模組版本，無須手動修改 `?v=`。只有資料快照變動時不會更換頁面資源快取版本。

`--output dist` 只打包明確列出的公開檔案，目前為 48 個（含 6 個午餐資料檔）；不包含 Git、工作流程、腳本、測試或模板。根目錄舊版 JS／CSS 仍保留供部署切換期間的既有客戶端使用。發布資料通過驗證且完整產生後才替換既有產物；輸出含未知檔案、符號連結或指向原始碼目錄時會拒絕覆寫。

## 學校基本資訊

「最近檢查」下方的 info 圖示與「基本資訊」文字開啟五校各自的聯絡資訊與校園開放燈箱，提供電話、地址導航、官網、一般開放時段、來源與獨立查核日期。近期場地公告不受公告搜尋或分類影響；不推算即時開放狀態。關閉、Escape與返回保留公告狀態，手機為全螢幕視窗。

`school-info.json` 保存人工核對的教育部名錄、市府開放資料及校方來源，建置時驗證並只將該校內容嵌入HTML，可隨PWA離線讀取。每月以 `python3 scripts/check_school_info_sources.py` 檢查五校來源列是否變更，再人工核對校方公告；工具不覆寫資料或查核日期。來源差異與維護方式見 [基本資訊說明](docs/school-info.md)。

## 午餐資料

已完成資料層與「今日午餐」閱讀視窗。五校官方代碼集中在 `lunch-schools.json`，與公告設定、RSS 更新分開。更新器使用公開查詢服務，免登入、不需 API key；不下載照片，也不推算素食完整性或過敏原。

```sh
python3 scripts/update_lunch.py --report /tmp/lunch-attempt.json
python3 scripts/build_site.py
python3 scripts/check_project.py
python3 scripts/build_site.py --output dist
```

預設查詢臺灣當天；`--date YYYY-MM-DD --output /tmp/lunch-preview` 可在獨立目錄驗證指定日期，不允許用較舊日期覆蓋已有較新查詢的目錄。請求循序發送、最少間隔 0.25 秒、15 秒逾時，暫時連線錯誤／429／部分 5xx 最多重試一次；每輪上限 200 次 HTTP 請求，每個 JSON 回應最多 2 MB。403、非 JSON、格式或學校／日期／批次不符都不當作空菜單。

`data/lunch/<slug>.json` 僅保存該校最後一次完整驗證的資料，按供餐單位分開，菜色與調味料分開；每道菜保存食材名稱、製造商、產地、供應商及進貨登錄狀態。`data/lunch/status.json` 記錄本輪餐日、檢查時間、各校更新狀態、缺少項目、最近完整成功時間與快照 SHA-256。前端會核對原始 UTF-8 bytes 的雜湊後使用資料，不以更新狀態的查詢日取代快照原有餐日。

部分學校失敗時保留其快照原始 bytes，更新狀態為 `error` 或 `partial`；不發布不完整菜單。有效空回應為 `no-record`，代表尚無資料，同一天已取得菜單後出現空回應則保留原菜單並記錄異常。全校皆失敗或不完整時回傳非零、不更改任何公開檔案，細節留在 `--report` 與 Actions artifact。資料先驗證及暫存，快照先替換、狀態清單最後替換，寫檔失敗回復已替換檔案。

Hero 的「今日午餐」開啟桌機視窗／手機全螢幕視窗，依供餐商分組。各尺寸皆使用固定單欄菜色列，菜名與右側明細箭頭同列，展開不改欄寬或位置；食材、製造商、產地與供應商在原列下方顯示。關閉／Escape／返回保留公告網址、搜尋、分類、頁碼與捲動位置，焦點回到午餐按鈕。照片透過官方完整資料連結查閱。

`lunch-live.mjs` 只在開啟時向官方公開 API 查詢本校當天午餐，核對學校、餐日、供餐商、批次與菜色，全部完成才保存。最多 3 個同時請求、每輪上限 150 次、整輪 8 秒逾時，不下載照片、不傳送登入憑證。當日完整菜單 30 分鐘內重用，無菜單時 5 分鐘後重查，跨臺灣日期重新查詢；失敗後同頁面 2 分鐘內不重複打官方。按網站路徑隔離的 `lunch-v1` 每校最多保存一份官方查詢與一份本站發布快照，不與公告快取混用。官方查詢失敗時使用餐日／取得時間較新的完整資料並提示，尚無資料則提供重試與官方入口；不把舊資料標成今天。

2026-11-17 雲端實跑確認：官方服務對 GitHub hosted runner 回傳 HTTP 403，五校皆失敗且沒有修改公開資料；瀏覽器公開 CORS 查詢實測可用。因此正式版以瀏覽器查詢為主，不啟用 GitHub 午餐抓取排程。Python／手動工作流程保留作維護快照與來源診斷。完整欄位、官方來源及畫面規格見 [午餐介接規格](docs/lunch-integration.md)。

## GitHub Actions

四條工作流程共用 `.github/actions/setup/action.yml` 的 Node.js 22／Python 3.12，無須安裝專案套件：

| 工作流程 | 觸發與責任 |
| --- | --- |
| `ci.yml`／Project checks | PR 或手動觸發，以唯讀權限執行完整離線檢查及發布打包。 |
| `update-feed.yml`／Update RSS data | 每日臺灣時間 10:30、16:30 或手動觸發，只抓取、驗證並提交 `data/` 的產生資料。若遠端 main 已前進，正常 push 會失敗並留待重新執行，不強制覆寫。 |
| `update-lunch.yml`／Update lunch data | 目前只手動觸發，驗證並提交 `data/lunch/` 與必要的公開檔案清單，不修改 RSS。全校失敗不提交，保留診斷 artifact。 |
| `deploy.yml`／Deploy Pages | main push、手動觸發，或同儲存庫 main 的 RSS／午餐工作流程成功完成時，檢查目前 main 並上傳 `dist/`，再以獨立 job 部署 Pages。此流程不抓取外部資料。 |

資料 bot 使用的 `GITHUB_TOKEN` 提交不會再觸發 push 工作流程，因此資料更新透過成功的 `workflow_run` 接續部署。部署重新 checkout 可信的目前 main，不使用上游工作流程提供的程式碼或產物。Pages 與 OIDC 寫入權限只授予部署 job，RSS／午餐工作流程沒有 Pages 權限。兩種資料更新各自提交限定路徑；遠端 main 前進造成 push 失敗時需重跑，不強制推送或覆蓋其他更新。

正式儲存庫須將 Pages 的建置來源設為 GitHub Actions，並允許 RSS bot 寫入 main（受分支保護規則約束）。本機測試涵蓋 YAML 結構與工作流程契約；實際權限、事件串接及 Pages 發布仍須在 GitHub 上驗收。

完整的本機、跨瀏覽器、PR、排程串接、正式站與失敗處理步驟見 [發布驗收流程](docs/release-checklist.md)。
