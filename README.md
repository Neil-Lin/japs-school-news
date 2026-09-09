# 仁愛、敦化、建安、博愛、光復國小消息牆

資料來源：仁愛國小、建安國小、敦化國小、博愛國小、光復國小與臺北市教育局。

各校獨立網址：`/renai/`、`/jianan/`、`/dunhua/`、`/boai/`、`/guangfu/`。

以 GitHub Pages 發布的學校消息彙整頁面，每日臺灣時間 10:30、16:30 由 GitHub Actions 更新 RSS 資料。資料保留最近一年，來源錯誤會寫入 `articles.json` 並在 workflow 中顯示。

本機執行 `python3 scripts/update_feed.py` 可更新資料；網站會依學校、分類與關鍵字搜尋顯示發布時間、標題、原文連結或內容摘要，並顯示各校今日新增筆數與來源更新狀態。前端設定集中在 `config.json`，資料版本寫在 `data/version.json`，讓瀏覽器能快取未變動的文章資料。

部署前會執行 `scripts/validate_project.py`，檢查設定、學校頁面、公告欄位、附件格式、網址與重複 ID；RSS 更新後會再驗證一次，驗證失敗就不會部署。
