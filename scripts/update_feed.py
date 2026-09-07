#!/usr/bin/env python3
import html, json, os, re
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.parse import urlsplit
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
CONFIG = json.loads((ROOT / "config.json").read_text())
OUT = ROOT / "data" / "articles.json"
VERSION = ROOT / "data" / "version.json"
RETENTION_DAYS = 365

def clean(value):
    value = html.unescape(value or "")
    value = value.replace("<![CDATA[", "").replace("]]>", "")
    value = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", value, flags=re.I | re.S)
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", value)).strip()

def date_value(raw):
    try: return parsedate_to_datetime(raw).astimezone(timezone.utc).isoformat()
    except Exception: return raw or ""

def site_url(raw):
    parsed = urlsplit(raw)
    return f"{parsed.scheme}://{parsed.netloc}"

def fetch_items_from_broken_xml(body, source):
    """Recover RSS items when a school's descriptions contain invalid XML."""
    text = body.decode("utf-8", errors="replace")
    blocks = re.findall(r"<item\b[^>]*>(.*?)</item>", text, flags=re.I | re.S)
    result = []
    for block in blocks:
        def val(name):
            match = re.search(rf"<{name}\b[^>]*>(.*?)</{name}>", block, flags=re.I | re.S)
            return clean(match.group(1)) if match else ""
        link = html.unescape(val("link"))
        guid = val("guid") or link or val("title")
        attachments=[value for value in (clean(match.group(1)) for match in re.finditer(r"<name\b[^>]*>(.*?)</name>", block, flags=re.I | re.S)) if value]
        result.append({"id":source["name"]+":"+source.get("school", "共同")+":"+guid,"schools":source.get("schools", [source.get("school")]),"source":source["name"],"title":val("title") or "未命名公告","published":date_value(val("pubDate")),"url":link,"sourceUrl":source["url"],"siteUrl":site_url(source["url"]),"attachments":attachments,"summary":val("description")[:360]})
    return result

def fetch(source):
    if source.get("broken"):
        return [{"id":"broken:" + source["school"] + ":" + source["name"],"schools":[source["school"]],"source":source["name"],"title":"RSS 發生錯誤，無法搜集資料","published":"","url":"","summary":"此分類目前 RSS 發生錯誤，暫時無法搜集資料。"}]
    request = Request(source["url"], headers={"User-Agent":"japs-school-news/1.0"})
    with urlopen(request, timeout=30) as response: body = response.read()
    try: root = ET.fromstring(body)
    except ET.ParseError:
        recovered = fetch_items_from_broken_xml(body, source)
        if recovered: return recovered
        return []
    result = []
    for item in root.findall(".//item"):
        def val(name):
            node = item.find(name)
            return node.text.strip() if node is not None and node.text else ""
        link, guid = html.unescape(val("link")), val("guid") or val("link") or val("title")
        attachments=[clean(node.text) for node in item.findall("name") if node.text]
        result.append({"id":source["name"]+":"+source.get("school", "共同")+":"+guid,"schools":source.get("schools", [source.get("school")]),"source":source["name"],"title":clean(val("title")) or "未命名公告","published":date_value(val("pubDate")),"url":link,"sourceUrl":source["url"],"siteUrl":site_url(source["url"]),"attachments":attachments,"summary":clean(val("description"))[:360]})
    return result

existing = json.loads(OUT.read_text()) if OUT.exists() else {"articles":[]}
by_id = {}
active_source_names = {source["name"] for source in CONFIG["sources"]}
for article in existing.get("articles", []):
    if article.get("id", "").startswith("page:"):
        continue
    if article.get("source") and article["source"] not in active_source_names:
        continue
    # Remove placeholder records when a previously broken source is repaired.
    if article.get("id", "").startswith("broken:"):
        _, school, name = article["id"].split(":", 2)
        repaired = any(source.get("school") == school and source["name"] == name and not source.get("broken") for source in CONFIG["sources"])
        # The old category was labelled "音樂班招生鑑定"; keep its placeholder from resurfacing after the label is corrected.
        repaired = repaired or (school == "敦化國小" and name == "音樂班招生鑑定" and any(source.get("school") == school and source["name"] == "音樂班招生" and not source.get("broken") for source in CONFIG["sources"]))
        if repaired:
            continue
    article.setdefault("schools", ["仁愛國小"])
    if article.get("source") == "教育局消息":
        article["schools"] = CONFIG["schools"]
        if ":共同:" not in article["id"]:
            article["id"] = "教育局消息:共同:" + article["id"].split(":", 1)[-1]
    by_id[article["id"]] = article
errors = []
with ThreadPoolExecutor(max_workers=6) as executor:
    futures = {executor.submit(fetch, source): source for source in CONFIG["sources"]}
    for future in as_completed(futures):
        source = futures[future]
        try:
            for article in future.result(): by_id[article["id"]] = article
        except Exception as error:
            errors.append({"source":source["name"],"error":str(error)})

cutoff = datetime.now(timezone.utc) - timedelta(days=RETENTION_DAYS)
def keep_article(article):
    raw = article.get("published", "")
    if not raw: return True
    try: return datetime.fromisoformat(raw.replace("Z", "+00:00")) >= cutoff
    except ValueError: return True

articles = sorted((article for article in by_id.values() if keep_article(article)), key=lambda a:a.get("published", ""), reverse=True)
updated_at = datetime.now(timezone.utc).isoformat()
payload = {"updatedAt":updated_at,"errors":errors,"articles":articles}
OUT.write_text(json.dumps(payload,ensure_ascii=False,indent=2)+"\n")
VERSION.write_text(json.dumps({"updatedAt":updated_at},ensure_ascii=False)+"\n")
if errors:
    print("source errors:", file=os.sys.stderr)
    for error in errors: print(f"- {error['source']}: {error['error']}", file=os.sys.stderr)
    summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary_path:
        with open(summary_path, "a", encoding="utf-8") as summary:
            summary.write("## RSS source errors\n\n")
            summary.writelines(f"- {error['source']}: {error['error']}\n" for error in errors)
print(f"saved {len(articles)} articles; {len(errors)} source errors")
if len(errors) == len(CONFIG["sources"]): raise SystemExit("all sources failed")
