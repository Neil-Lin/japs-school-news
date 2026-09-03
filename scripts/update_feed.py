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
    value = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", value, flags=re.I | re.S)
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", value)).strip()

def date_value(raw):
    try: return parsedate_to_datetime(raw).astimezone(timezone.utc).isoformat()
    except Exception: return raw or ""

def fetch(source):
    request = Request(source["url"], headers={"User-Agent":"japs-school-news/1.0"})
    with urlopen(request, timeout=30) as response: body = response.read()
    try: root = ET.fromstring(body)
    except ET.ParseError:
        return [{"id":"page:" + source["url"],"schools":source.get("schools", [source.get("school")]),"source":source["name"],"title":source["name"],"published":"","url":source["url"],"summary":clean(body.decode("utf-8", errors="replace"))[:360]}]
    result = []
    for item in root.findall(".//item"):
        def val(name):
            node = item.find(name)
            return node.text.strip() if node is not None and node.text else ""
        link, guid = html.unescape(val("link")), val("guid") or val("link") or val("title")
        result.append({"id":source["name"]+":"+source.get("school", "共同")+":"+guid,"schools":source.get("schools", [source.get("school")]),"source":source["name"],"title":clean(val("title")) or "未命名公告","published":date_value(val("pubDate")),"url":link,"summary":clean(val("description"))[:360]})
    return result

existing = json.loads(OUT.read_text()) if OUT.exists() else {"articles":[]}
by_id = {}
for article in existing.get("articles", []):
    article.setdefault("schools", ["仁愛國小"])
    if article.get("source") == "教育局消息": article["schools"] = ["仁愛國小", "建安國小"]
    by_id[article["id"]] = article
errors = []
for source in CONFIG["sources"]:
    try:
        for article in fetch(source): by_id[article["id"]] = article
    except Exception as error: errors.append({"source":source["name"],"error":str(error)})
articles = sorted(by_id.values(), key=lambda a:a.get("published", ""), reverse=True)
OUT.write_text(json.dumps({"updatedAt":datetime.now(timezone.utc).isoformat(),"errors":errors,"articles":articles},ensure_ascii=False,indent=2)+"\n")
print(f"saved {len(articles)} articles; {len(errors)} source errors")
