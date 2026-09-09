#!/usr/bin/env python3
"""Validate generated data and the static site before publishing."""
import json
import sys
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
errors = []

def load_json(relative):
    try:
        return json.loads((ROOT / relative).read_text(encoding="utf-8"))
    except Exception as error:
        errors.append(f"{relative}: 無法讀取 JSON（{error}）")
        return {}

config = load_json("config.json")
data = load_json("data/articles.json")
version = load_json("data/version.json")
schools = config.get("schools", [])
meta = config.get("schoolMeta", {})
sources = config.get("sources", [])

if set(schools) != set(meta):
    errors.append("config.json: schools 與 schoolMeta 不一致")
if len(schools) != len(set(schools)):
    errors.append("config.json: 學校名稱重複")
for school in schools:
    slug = meta.get(school, {}).get("slug")
    if not slug or not (ROOT / slug / "index.html").exists():
        errors.append(f"{school}: 缺少獨立頁面或 slug")
for source in sources:
    if not source.get("name") or not source.get("url"):
        errors.append("config.json: RSS source 缺少 name 或 url")
    if source.get("school") and source["school"] not in schools:
        errors.append(f"config.json: RSS source 指向未知學校 {source['school']}")

articles = data.get("articles", [])
seen = set()
for index, article in enumerate(articles):
    prefix = f"data/articles.json articles[{index}]"
    article_id = article.get("id")
    if not article_id:
        errors.append(f"{prefix}: 缺少 id")
    elif article_id in seen:
        errors.append(f"{prefix}: id 重複 {article_id}")
    seen.add(article_id)
    if not article.get("title", "").strip():
        errors.append(f"{prefix}: 缺少標題")
    unknown = set(article.get("schools", [])) - set(schools)
    if unknown:
        errors.append(f"{prefix}: 未知學校 {sorted(unknown)}")
    for attachment in article.get("attachments", []):
        if isinstance(attachment, dict):
            if not attachment.get("name") or not attachment.get("url"):
                errors.append(f"{prefix}: 附件缺少名稱或網址")
        elif not isinstance(attachment, str) or not attachment.strip():
            errors.append(f"{prefix}: 附件格式錯誤")
    for field in ("url", "sourceUrl", "siteUrl"):
        value = article.get(field)
        if value and urlparse(value).scheme not in ("http", "https"):
            errors.append(f"{prefix}: {field} 不是有效網址")

if version.get("updatedAt") and data.get("updatedAt") and version["updatedAt"] != data["updatedAt"]:
    errors.append("data/version.json 與 data/articles.json 的 updatedAt 不一致")

for school in schools:
    page = (ROOT / meta[school]["slug"] / "index.html").read_text(encoding="utf-8")
    if 'id="schoolSwitch"' not in page or 'id="pagination"' not in page or 'src="app.js' not in page:
        errors.append(f"{school}: 頁面缺少必要的前端元件")

if errors:
    print("專案驗證失敗：", file=sys.stderr)
    print("\n".join(f"- {error}" for error in errors), file=sys.stderr)
    raise SystemExit(1)

print(f"專案驗證通過：{len(articles)} 筆公告、{len(sources)} 個來源、{len(schools)} 個學校頁面")
