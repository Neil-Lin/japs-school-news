#!/usr/bin/env python3
import html, json, re
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
CONFIG = json.loads((ROOT / "config.json").read_text())
OUT = ROOT / "data" / "articles.json"

def clean(value):
    value = html.unescape(value or "")
    value = value.replace("<![CDATA[", "").replace("]]>", "")
    value = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", value, flags=re.I | re.S)
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", value)).strip()

def date_value(raw):
    try: return parsedate_to_datetime(raw).astimezone(timezone.utc).isoformat()
    except Exception: return raw or ""

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
        result.append({"id":source["name"]+":"+source.get("school", "共同")+":"+guid,"schools":source.get("schools", [source.get("school")]),"source":source["name"],"title":val("title") or "未命名公告","published":date_value(val("pubDate")),"url":link,"sourceUrl":source["url"],"siteUrl":"https://" + source["url"].split("/")[2],"attachments":attachments,"summary":val("description")[:360]})
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
        return [{"id":"page:" + source["url"],"schools":source.get("schools", [source.get("school")]),"source":source["name"],"title":source["name"],"published":"","url":source["url"],"summary":clean(body.decode("utf-8", errors="replace"))[:360]}]
    result = []
    for item in root.findall(".//item"):
        def val(name):
            node = item.find(name)
            return node.text.strip() if node is not None and node.text else ""
        link, guid = html.unescape(val("link")), val("guid") or val("link") or val("title")
        attachments=[clean(node.text) for node in item.findall("name") if node.text]
        result.append({"id":source["name"]+":"+source.get("school", "共同")+":"+guid,"schools":source.get("schools", [source.get("school")]),"source":source["name"],"title":clean(val("title")) or "未命名公告","published":date_value(val("pubDate")),"url":link,"sourceUrl":source["url"],"siteUrl":"https://" + source["url"].split("/")[2],"attachments":attachments,"summary":clean(val("description"))[:360]})
    return result

existing = json.loads(OUT.read_text()) if OUT.exists() else {"articles":[]}
by_id = {}
for article in existing.get("articles", []):
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
for source in CONFIG["sources"]:
    try:
        for article in fetch(source): by_id[article["id"]] = article
    except Exception as error: errors.append({"source":source["name"],"error":str(error)})
articles = sorted(by_id.values(), key=lambda a:a.get("published", ""), reverse=True)
OUT.write_text(json.dumps({"updatedAt":datetime.now(timezone.utc).isoformat(),"errors":errors,"articles":articles},ensure_ascii=False,indent=2)+"\n")
print(f"saved {len(articles)} articles; {len(errors)} source errors")
