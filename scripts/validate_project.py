#!/usr/bin/env python3
"""Validate generated data and the static site before publishing."""
import json
import re
import sys
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin, urlparse
from feed_contract import validate_snapshot, validate_school_artifacts
from build_site import check_workspace

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
manifest = load_json("manifest.json")
asset_manifest = load_json("assets-manifest.json")
errors.extend(check_workspace(ROOT))
assets = asset_manifest.get("assets", {})
schools = config.get("schools", [])
meta = config.get("schoolMeta", {})
sources = config.get("sources", [])
category_ids = config.get("categoryIds", {})
errors.extend(validate_snapshot(config, data, version))
errors.extend(validate_school_artifacts(config, data, version, ROOT / "data"))
if len(set(category_ids.values())) != len(category_ids):
    errors.append("config.json: categoryIds 必須唯一")
for name, category_id in category_ids.items():
    if not isinstance(category_id, str) or not re.fullmatch(r"[a-z0-9-]+", category_id):
        errors.append(f"config.json: 分類 {name} 的 ID 格式錯誤")

for required in ("id", "name", "short_name", "start_url", "scope", "display", "icons"):
    if not manifest.get(required):
        errors.append(f"manifest.json: 缺少 {required}")
if not (ROOT / "sw.js").exists():
    errors.append("缺少 sw.js")
for icon in manifest.get("icons", []):
    icon_path = icon.get("src", "").split("/japs-school-news/", 1)[-1]
    if icon_path and not (ROOT / icon_path).exists():
        errors.append(f"manifest.json: 找不到 icon {icon.get('src')}")

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
    if source.get("name") not in category_ids:
        errors.append(f"config.json: 分類 {source.get('name')} 缺少穩定 ID")

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
    for source in article.get("sources", [article.get("source")]):
        if source and source not in category_ids:
            errors.append(f"{prefix}: 分類 {source} 缺少穩定 ID")
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

class PageAssets(HTMLParser):
    def __init__(self):
        super().__init__()
        self.base = ""
        self.assets = []
        self.title = ""
        self.in_title = False
        self.ids = set()
        self.school_slug = None

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if attrs.get("id"):
            self.ids.add(attrs["id"])
        if tag == "base":
            self.base = attrs.get("href", "")
        if tag == "body":
            self.school_slug = attrs.get("data-school")
        if tag == "title":
            self.in_title = True
        if tag == "script" and attrs.get("src"):
            self.assets.append(attrs["src"])
        if tag == "link" and attrs.get("href"):
            self.assets.append(attrs["href"])

    def handle_endtag(self, tag):
        if tag == "title":
            self.in_title = False

    def handle_data(self, data):
        if self.in_title:
            self.title += data


pages = [("首頁", "index.html")] + [
    (school, f"{meta[school]['slug']}/index.html")
    for school in schools if meta.get(school, {}).get("slug")
    and (ROOT / meta[school]["slug"] / "index.html").exists()
]
required_ids = {"schoolSwitch", "pagination", "search", "filters", "feed", "resultStatus", "resetFilters"}
project_url = "https://example.test/japs-school-news/"
for name, relative in pages:
    page = (ROOT / relative).read_text(encoding="utf-8")
    parsed = PageAssets()
    parsed.feed(page)
    if not required_ids <= parsed.ids or assets.get("app.js") not in parsed.assets:
        errors.append(f"{name}: 頁面缺少必要的前端元件")
    if not parsed.title.strip() or (name != "首頁" and name not in parsed.title):
        errors.append(f"{name}: 頁面缺少正確標題")
    expected_school = schools[0] if name == "首頁" else name
    if parsed.school_slug != meta[expected_school]["slug"]:
        errors.append(f"{name}: data-school 必須對應分校資料 slug")
    page_url = urljoin(project_url, relative)
    base_url = urljoin(page_url, parsed.base) if parsed.base else page_url
    for asset in parsed.assets:
        resolved = urlparse(urljoin(base_url, asset))
        if resolved.netloc != "example.test":
            continue
        prefix = "/japs-school-news/"
        if not resolved.path.startswith(prefix) or not (ROOT / resolved.path[len(prefix):]).is_file():
            errors.append(f"{name}: 資源 {asset} 解析到無效位置 {resolved.path}")

sw = (ROOT / "sw.js").read_text(encoding="utf-8")
shell = re.search(r"const SHELL = (\[.*?\]);", sw, flags=re.S)
if shell:
    shell_assets = set(json.loads(shell.group(1)))
    for name, relative in pages:
        parsed = PageAssets()
        parsed.feed((ROOT / relative).read_text(encoding="utf-8"))
        for asset in parsed.assets:
            if asset.startswith("static/") and "./" + asset not in shell_assets:
                errors.append(f"{name}: {asset} 與 service worker 預快取版本不一致")
    for source, compiled in assets.items():
        path = ROOT / compiled
        if "./" + compiled not in shell_assets or not path.is_file():
            errors.append(f"{source}: 產物 {compiled} 未納入有效預快取")
            continue
        if path.suffix not in (".js", ".mjs"):
            continue
        for module in re.findall(r"from ['\"](\./[^'\"]+\.mjs)['\"]", path.read_text(encoding="utf-8")):
            dependency = "static/" + module[2:]
            if "./" + dependency not in shell_assets or not (ROOT / dependency).is_file():
                errors.append(f"{source}: 模組 {module} 未納入有效預快取")
else:
    errors.append("sw.js: 缺少有效的 SHELL 清單")

if errors:
    print("專案驗證失敗：", file=sys.stderr)
    print("\n".join(f"- {error}" for error in errors), file=sys.stderr)
    raise SystemExit(1)

print(f"專案驗證通過：{len(articles)} 筆公告、{len(sources)} 個來源、{len(schools)} 個學校頁面")
