# 仁愛、敦化、建安、博愛、光復國小消息牆

資料來源：仁愛國小、建安國小、敦化國小、博愛國小、光復國小與臺北市教育局。

各校獨立網址：`/renai/`、`/jianan/`、`/dunhua/`、`/boai/`、`/guangfu/`。

以 GitHub Pages 發布的學校消息彙整頁面，每日臺灣時間 10:30、16:30 由 GitHub Actions 更新 RSS 資料。資料保留最近一年，來源錯誤會寫入 `articles.json` 並在 workflow 中顯示。

本機需 Python 3.9+ 與 Node.js 20+。執行 `python3 scripts/update_feed.py` 可更新資料並自動產生分校檔；網站會依學校、分類與關鍵字搜尋顯示發布時間、標題、原文連結或內容摘要，並顯示各校今日新增筆數與來源更新狀態。前端設定集中在 `config.json`，資料版本寫在 `data/version.json`，各校精簡公告位於 `data/schools/<slug>.json`；頁面只下載當校的一年份資料，內容未變時重用快取。

部署前會執行完整離線檢查，包含設定、產生頁面、程式、公告欄位、附件格式、網址與重複 ID；RSS 更新後會再驗證一次，驗證失敗就不會發布新資料。臺北市教育局來源因網站憑證與 Python TLS 相容性問題，使用仍會驗證憑證的 `curl` 抓取，其餘來源維持 Python 抓取。

網站支援 PWA 安裝，設定集中在 `manifest.json` 與 `templates/sw.js`，後者會產生 `sw.js`。公告資料採網路優先策略，離線時才使用上次快取的資料；`scripts/generate_pwa_assets.py` 可重新產生 icon 與 iOS 啟動畫面。

分類支援 checkbox 多選，預設勾選各校分類、不勾選「教育局消息」；「全部」可全選／取消全選，部分選取時顯示半選。分類之間取聯集，再與搜尋條件取交集；未選任何分類時不顯示公告。網址以穩定的分類 ID 記錄 `categories`、`q`、`page`，可分享並還原篩選狀態；`categories=` 代表明確全不選，沒有該參數則使用預設。分類 ID 集中於 `config.json` 的 `categoryIds`，修改分類顯示名稱時應保留 ID。

首次取得專案後，先執行 `python3 scripts/build_site.py` 產生本機資產，再執行 `python3 -m http.server 8000`，開啟 `http://localhost:8000/`。前端使用原生 ES modules，需透過 HTTP 預覽。完整回歸檢查統一使用 `python3 scripts/check_project.py`，不連線抓取 RSS、不提交或部署。它會檢查產生檔是否最新、重建資產、檢查 JavaScript 語法、執行 Node／Python 測試及資料驗證。工作流程 YAML 契約測試使用系統 Ruby/Psych；未安裝 Ruby 時會明確跳過該組測試，其餘檢查照常執行。


公告合併使用正規化原文網址或來源範圍內的 GUID，不以標題合併；同名不同篇公告會分開保留，同篇跨分類公告保留全部來源原文與附件。每個 RSS 來源在 `config.json` 有穩定的 `id`，修改名稱／網址時應保留 ID。

RSS 更新會區分合法空 RSS、可完整復原的格式異常、解析失敗與連線失敗。連線失敗最多重試一次；部分來源失敗時保留歷史資料及各來源最近成功時間，全數失敗不改寫資料檔。零筆或筆數驟減會記錄警告；公告日期必須有時區，原文與附件連結僅接受 HTTP(S)。輸出先暫存及驗證，再依序替換公告與版本清單，版本清單最後更新；替換失敗會回復已更換的公告檔，讀取端也會偵測部署期間的版本不一致。

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

`--output dist` 只打包明確列出的公開檔案，目前為 32 個；不包含 Git、工作流程、腳本、測試或模板。根目錄舊版 JS／CSS 仍保留供部署切換期間的既有客戶端使用。發布資料通過驗證且完整產生後才替換既有產物；輸出含未知檔案、符號連結或指向原始碼目錄時會拒絕覆寫。

## GitHub Actions

三條工作流程共用 `.github/actions/setup/action.yml` 的 Node.js 22／Python 3.12，無須安裝專案套件：

| 工作流程 | 觸發與責任 |
| --- | --- |
| `ci.yml`／Project checks | PR 或手動觸發，以唯讀權限執行完整離線檢查及發布打包。 |
| `update-feed.yml`／Update RSS data | 每日臺灣時間 10:30、16:30 或手動觸發，只抓取、驗證並提交 `data/` 的產生資料。若遠端 main 已前進，正常 push 會失敗並留待重新執行，不強制覆寫。 |
| `deploy.yml`／Deploy Pages | main push、手動觸發，或同儲存庫 main 的 RSS 工作流程成功完成時，檢查目前 main 並上傳 `dist/`，再以獨立 job 部署 Pages。此流程不抓取 RSS。 |

RSS bot 使用的 `GITHUB_TOKEN` 提交不會再觸發 push 工作流程，因此資料更新透過成功的 `workflow_run` 接續部署。部署重新 checkout 可信的目前 main，不使用上游工作流程提供的程式碼或產物。Pages 與 OIDC 寫入權限只授予部署 job，RSS 工作流程沒有 Pages 權限。

正式儲存庫須將 Pages 的建置來源設為 GitHub Actions，並允許 RSS bot 寫入 main（受分支保護規則約束）。本機測試涵蓋 YAML 結構與工作流程契約；實際權限、事件串接及 Pages 發布仍須在 GitHub 上驗收。

完整的本機、跨瀏覽器、PR、排程串接、正式站與失敗處理步驟見 [發布驗收流程](docs/release-checklist.md)。
