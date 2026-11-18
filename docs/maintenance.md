# 維護工程與驗收

## 畫面範圍

家長沿用既有「最近檢查／更新詳情」：來源成功復原完整 XML 時顯示正常，格式修復說明留在來源紀錄；零筆、筆數驟降、超過24小時未成功、抓取失敗仍提醒。歷史公告不會因來源失敗而清除。來源的最近成功時間與整體檢查時間分開。原始抓取錯誤留在維護報告，畫面使用簡短說明。

「基本資訊」底部的資料來源區顯示該校的聯絡資訊、開放資訊各自查核日期；超過各自週期（目前30天）時，在該區摘要及對應日期旁顯示「待重新查核」。開啟燈箱會依當天重新判斷，離線或未重新部署也會顯示到期狀態。沒有新增首頁卡片、按鈕或維護儀表板。

## 自動檢查與報告位置

| 檢查 | 時間／觸發 | 結果 |
| --- | --- | --- |
| RSS 每來源狀態 | 原有每日10:30、16:30更新 | Update RSS data 的摘要及 `rss-health` artifact，保留30天 |
| 快照新鮮度與逐校查核期限 | 每日08:15臺灣時間或手動 | Maintenance health 的摘要及 `maintenance-health` artifact |
| 教育部名錄／市府開放資料比對 | 每週一08:45臺灣時間或手動 | `school-source-comparison` artifact；不覆寫資料 |
| 瀏覽器操作 | PR 或手動 Project checks | Chromium、手機 WebKit，HTML報告、失敗截圖及trace保留14天 |
| 效能預算與回復相容性演練 | PR 或手動 Project checks | `performance` artifact及摘要 |
| 正式站發布檔案核對 | 每次Pages部署後 | `deploy-verification` artifact保留30天 |

GitHub排程可能延遲；本表是排程時間，並非準時完成保證。來源比對只比較兩份官方CSV；校方PDF、電話及不同版本時段的採用依據仍須人工核對，不會把「下載成功」當成「人工確認正確」。

來源分類共用 `news-health.mjs`。首次失敗為warning；已提交的來源連續失敗達3次、或失敗且上次成功超過24小時為error。零筆及大幅減少為warning。修復後完整驗證通過的XML屬正常。`consecutiveFailures` 自新版本開始計算，來源恢復時歸零；全來源失敗不發布快照，因此全失敗嘗試只留在Actions報告，次數不跨這類失敗累計。超過24小時未成功仍會升級。既有版本沒有次數時不虛構歷史。

健康檢查只對維護工作標記失敗，不會撤下仍可用的公告。RSS流程保留健康報告但繼續發布通過契約驗證的部分成功結果；全來源失敗仍保留全部公開檔案。沒有自動開issue或寄送額外通知；提醒依GitHub既有Actions通知設定。原始錯誤在 `feed-attempt.json`，健康分類在 `health.json`。

午餐使用瀏覽器直接讀官方API，發布的備援菜單日期不能代表即時瀏覽器狀態。GitHub伺服器被官方拒絕時，不推論家長端故障，也不啟用雲端午餐抓取排程。

## 本機與CI

CI固定使用Node22、Python3.12，定義在 `.github/actions/setup/action.yml`。網站執行不依賴npm套件；只有瀏覽器測試需安裝鎖定版本的開發依賴。Dependabot每月提供npm與Actions更新PR，仍須通過檢查再合併。

```sh
python3 scripts/build_site.py
python3 scripts/check_project.py
python3 scripts/build_site.py --output dist
npm ci --ignore-scripts
npx playwright install chromium webkit
npm run test:browser
node scripts/health_report.mjs
node scripts/performance_budget.mjs
node scripts/measure_performance.mjs
node scripts/recovery_drill.mjs
```

一般瀏覽器案例停用worker，攔截官方API並使用固定資料；PWA離線案例才啟用worker，不呼叫官方API。涵蓋預設分類、多選、搜尋／分頁分享及重載、燈箱Escape／返回／前進、焦點、菜色展開、錯校／錯日、320／390px及離線重開。這些是自動瀏覽器驗證，不替代iPhone／iPad Safari實機手勢及輔助使用驗收。

午餐與基本資訊共用 `dialog-controller.mjs` 管理返回、鎖住背景捲動、焦點循環及關閉；資料讀取／取消仍由午餐模組負責。焦點排除收合details內的隱藏連結，避免WebKit落入不可見內容。

`performance-baseline.json`記錄打包後JS／CSS、離線預載（含五校HTML及圖片）、逐校資料位元組。程式與離線檔案允許15%加1KiB成長；逐校資料按公告數同比成長並加20%與16KiB餘裕，另有10MB原始／2MBgzip上限。gzip是估算壓縮大小，實際傳輸視主機設定。Node處理時間獨立記錄，不當手機速度門檻。新增功能確需改預算時，先檢查原因，再執行 `node scripts/performance_budget.mjs --record` 並審查baseline差異。

## 發布與回復

發布時由實際 `dist/` 記錄每個公開檔案的SHA-256與位元組數，並保存建置的精確commit。部署後由唯讀job核對正式站的所有公開檔案（`.nojekyll`除外），含頁面、版本、分校資料、午餐備援、樣式與模組；最多6次重試，容許CDN傳播。舊頁、缺檔、內容不同或HTTP錯誤都算失敗，原始碼成功建置不等於已部署驗證成功。不自動回退，避免恢復程式時連帶覆蓋更新的公告。

回復演練會在暫存目錄載入 `maintenance/recovery-baseline.json` 指定的已知舊版讀取程式，逐校驗證它可讀取目前線上資料及相同的離線快照；不切換工作目錄、不寫入正式站。CI保留Git歷史供演練使用。這驗證讀取格式相容性，並未在正式站切換版本。worker清理／跨版本快取另外由既有單元測試驗證。

正式故障處理：

1. 保存失敗的部署驗證報告，先判斷CDN傳播、檔案缺少、資料契約或畫面問題。
2. 從最新main開修復分支；回復有問題的程式、模板、樣式，保留目前一致的 `data/`。若資料schema真的不相容，先做遷移／相容性修復，不套用單檔回退。
3. 重新產生頁面、shell與manifest，執行完整離線、瀏覽器、效能及回復演練。
4. PR檢查通過後合併，由正常Pages流程部署，等部署核對成功。不要直接重跑一個舊artifact覆蓋較新資料。
