#!/usr/bin/env python3
"""Update RSS data, retaining the last successful records for failed sources."""
import argparse
import html
import json
import os
import re
import subprocess
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from urllib.error import URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET

from feed_contract import SCHEMA_VERSION, content_hash, make_version, parsed_date, valid_url, validate_snapshot, validate_school_artifacts

ROOT = Path(__file__).resolve().parents[1]
RETENTION_DAYS = 365
MAX_FEED_BYTES = 8 * 1024 * 1024


class FeedError(ValueError):
    pass


class AllSourcesFailed(FeedError):
    def __init__(self, statuses):
        super().__init__("所有來源更新失敗，保留原有資料與版本")
        self.statuses = statuses


def clean(value):
    value = html.unescape(value or "").replace("<![CDATA[", "").replace("]]>", "")
    value = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", value, flags=re.I | re.S)
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", value)).strip()


def date_value(raw):
    try:
        date = parsedate_to_datetime(raw)
        if date.tzinfo is None:
            raise ValueError("日期缺少時區")
    except (ValueError, TypeError, IndexError):
        try:
            date = parsed_date(raw)
        except (ValueError, TypeError) as error:
            raise FeedError(f"公告日期無效：{raw!r}") from error
    return date.astimezone(timezone.utc).isoformat()


def source_schools(source):
    return source.get("schools", [source.get("school")])


def status_name(source):
    return source["name"] + (f"（{source['school']}）" if source.get("school") else "")


def make_article(source, title, raw_date, link, guid, summary, attachments):
    if not title:
        raise FeedError("公告缺少標題")
    published = date_value(raw_date)
    link = html.unescape(link)
    if link and not valid_url(link):
        raise FeedError("公告原文網址無效")
    # Title alone is not an identity: undated/repeated notices must not overwrite each other.
    identity = guid or link or content_hash([title, published, summary])
    parsed = urlsplit(source["url"])
    return {
        "id": source["id"] + ":" + identity,
        "sourceId": source["id"], "guid": guid,
        "schools": source_schools(source), "source": source["name"],
        "title": title, "published": published, "url": link,
        "sourceUrl": source["url"], "siteUrl": f"{parsed.scheme}://{parsed.netloc}",
        "attachments": attachments, "summary": summary[:360],
    }


def fetch_body(source):
    """Use curl's verified TLS stack for the education department feed."""
    if source.get("page"):
        body = subprocess.run(
            ["curl", "--fail", "--location", "--silent", "--show-error", "--max-time", "30",
             "--max-filesize", str(MAX_FEED_BYTES), "-A", "japs-school-news/1.0", source["url"]],
            check=True, capture_output=True, timeout=35,
        ).stdout
    else:
        request = Request(source["url"], headers={"User-Agent": "japs-school-news/1.0"})
        with urlopen(request, timeout=30) as response:
            body = response.read(MAX_FEED_BYTES + 1)
    if len(body) > MAX_FEED_BYTES:
        raise FeedError("來源回應超出大小限制")
    return body


def recover_items(body, source):
    """Recover complete RSS items only; never treat arbitrary HTML as an empty feed."""
    text = body.decode("utf-8", errors="strict")
    if not re.search(r"<rss(?:\s|>)", text, flags=re.I) or not re.search(r"<channel(?:\s|>)", text, flags=re.I):
        raise FeedError("回應不是有效 RSS")
    blocks = re.findall(r"<item\b[^>]*>(.*?)</item>", text, flags=re.I | re.S)
    if not blocks or len(blocks) != len(re.findall(r"<item\b", text, flags=re.I)):
        raise FeedError("RSS XML 損壞且無法完整復原")
    items = []
    for block in blocks:
        def val(name):
            match = re.search(rf"<{name}\b[^>]*>(.*?)</{name}>", block, flags=re.I | re.S)
            return clean(match.group(1)) if match else ""
        attachments = [clean(match) for match in re.findall(r"<name\b[^>]*>(.*?)</name>", block, flags=re.I | re.S) if clean(match)]
        items.append(make_article(source, val("title"), val("pubDate"), val("link"), val("guid"), val("description"), attachments))
    return {"items": items, "warnings": ["來源 XML 格式異常，已復原完整公告；請檢查來源格式。"]}


def repair_description_controls(body):
    """Replace XML 1.0-forbidden controls only in description CDATA text."""
    text = body.decode("utf-8", errors="strict")
    controls = []

    def description(match):
        def whitespace(control):
            controls.append(ord(control[0]))
            return " "
        content = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", whitespace, match[2])
        return match[1] + content + match[3]

    repaired = re.sub(r"(<description\b[^>]*>\s*<!\[CDATA\[)(.*?)(\]\]>\s*</description\s*>)",
                      description, text, flags=re.I | re.S)
    if not controls:
        return body, []
    codes = "、".join(f"U+{code:04X}" for code in sorted(set(controls)))
    warning = f"來源內文含 {len(controls)} 個 XML 不允許的控制字元（{codes}），已轉為空白並通過完整 XML 驗證。"
    return repaired.encode("utf-8"), [warning]


def parse_feed(body, source):
    warnings = []
    try:
        root = ET.fromstring(body)
    except ET.ParseError:
        repaired, warnings = repair_description_controls(body)
        if not warnings:
            return recover_items(body, source)
        try:
            root = ET.fromstring(repaired)
        except ET.ParseError as error:
            raise FeedError("來源內文控制字元轉換後，RSS XML 仍無法完整解析，保留上次成功資料") from error
    local = lambda tag: tag.rsplit("}", 1)[-1].lower()
    if local(root.tag) not in ("rss", "rdf") or not any(local(node.tag) == "channel" for node in root):
        raise FeedError("回應不是有效 RSS（可能為 HTML 錯誤頁）")
    result = []
    for item in root.iter():
        if local(item.tag) != "item":
            continue
        def val(name):
            node = next((child for child in item if local(child.tag) == name.lower()), None)
            return node.text.strip() if node is not None and node.text else ""
        attachments = [clean(node.text) for node in item if local(node.tag) == "name" and clean(node.text)]
        result.append(make_article(source, clean(val("title")), val("pubDate"), val("link"), val("guid"), clean(val("description")), attachments))
    return {"items": result, "warnings": warnings}


def fetch(source, fetcher=fetch_body, sleep=time.sleep):
    if source.get("broken"):
        raise FeedError("來源已標記為故障")
    for attempt in range(2):
        try:
            body = fetcher(source)
            break
        except (OSError, URLError, subprocess.SubprocessError):
            if attempt:
                raise
            sleep(0.5)
    return parse_feed(body, source)


def match_source(article, config):
    sources = config["sources"]
    if article.get("sourceId"):
        return next((source for source in sources if source["id"] == article["sourceId"]), None)
    # Legacy migration is by school + category, not category name alone.
    schools = set(article.get("schools", ["仁愛國小"]))
    candidates = [source for source in sources if source["name"] == article.get("source") and set(source_schools(source)) == schools]
    return candidates[0] if len(candidates) == 1 else None


def normalize_existing(existing, config):
    result = {}
    for original in existing.get("articles", []):
        if original.get("id", "").startswith(("page:", "broken:")):
            continue
        source = match_source(original, config)
        if not source:
            continue
        article = dict(original)
        guid = article.get("guid")
        if guid is None:
            parts = article.get("id", "").split(":", 2)
            guid = parts[2] if len(parts) == 3 else ""
            if guid == article.get("title"):
                guid = ""
        normalized = make_article(source, article["title"], article["published"], article.get("url", ""), guid, article.get("summary", ""), article.get("attachments", []))
        result[normalized["id"]] = normalized
    return result


def previous_statuses(existing, config):
    previous = existing.get("sourceStatus", [])
    return {
        source["id"]: next((item for item in previous if item.get("id") == source["id"] or (not item.get("id") and item.get("name") == status_name(source))), {})
        for source in config["sources"]
    }


def build_payload(config, existing, results, now=None):
    now = now or datetime.now(timezone.utc)
    checked_at = now.isoformat()
    by_id = normalize_existing(existing, config)
    previous = previous_statuses(existing, config)
    statuses = []
    successes = 0
    for source in config["sources"]:
        old = previous[source["id"]]
        last_success = old.get("lastSuccessfulAt") or (existing.get("updatedAt") if old.get("status") in ("ok", "warning") else None)
        previous_count = old.get("lastSuccessfulItemCount", old.get("itemCount", 0))
        status = {"id": source["id"], "name": status_name(source), "schools": source_schools(source), "lastAttemptAt": checked_at, "lastSuccessfulAt": last_success, "previousItemCount": previous_count}
        result = results[source["id"]]
        if "error" in result:
            status.update(status="error", itemCount=0, lastSuccessfulItemCount=previous_count, error=result["error"], warnings=[])
        else:
            items = result["items"]
            # Parsed results are validated; failed sources never enter this branch.
            warnings = list(result.get("warnings", []))
            has_history = any(article["sourceId"] == source["id"] for article in by_id.values())
            if not items and (previous_count > 0 or has_history):
                warnings.append("本次來源回傳 0 筆，保留歷史公告。")
            elif previous_count >= 10 and len(items) < previous_count * 0.25:
                warnings.append(f"來源筆數由 {previous_count} 降至 {len(items)}，請確認來源內容。")
            for article in items:
                by_id[article["id"]] = article
            status.update(status="warning" if warnings else "ok", itemCount=len(items), lastSuccessfulItemCount=len(items), lastSuccessfulAt=checked_at, warnings=warnings)
            successes += 1
        statuses.append(status)
    if not successes:
        raise AllSourcesFailed(statuses)
    cutoff = now - timedelta(days=RETENTION_DAYS)
    articles = [article for article in by_id.values() if parsed_date(article["published"]) >= cutoff]
    articles.sort(key=lambda item: (-parsed_date(item["published"]).timestamp(), item["id"]))
    return {
        "schemaVersion": SCHEMA_VERSION, "updatedAt": checked_at, "lastSuccessfulAt": checked_at,
        "errors": [{"source": item["name"], "sourceId": item["id"], "error": item["error"]} for item in statuses if item["status"] == "error"],
        "sourceStatus": sorted(statuses, key=lambda item: item["id"]), "articles": articles,
    }


def migrate_payload(config, existing):
    articles = list(normalize_existing(existing, config).values())
    articles.sort(key=lambda item: (-parsed_date(item["published"]).timestamp(), item["id"]))
    previous = previous_statuses(existing, config)
    statuses = []
    for source in config["sources"]:
        old = previous[source["id"]]
        ok = old.get("status") in ("ok", "warning")
        statuses.append({
            **old, "id": source["id"], "name": status_name(source), "schools": source_schools(source),
            "status": old.get("status", "error"), "itemCount": old.get("itemCount", 0),
            "lastAttemptAt": old.get("lastAttemptAt", existing["updatedAt"]),
            "lastSuccessfulAt": old.get("lastSuccessfulAt") or (existing["updatedAt"] if ok else None),
            "lastSuccessfulItemCount": old.get("lastSuccessfulItemCount", old.get("itemCount", 0)),
            "warnings": old.get("warnings", []),
        })
    # Migration is not a network check: preserve all recorded timestamps.
    return {**existing, "schemaVersion": SCHEMA_VERSION, "lastSuccessfulAt": existing.get("lastSuccessfulAt", existing["updatedAt"]), "sourceStatus": sorted(statuses, key=lambda item: item["id"]), "articles": articles}


def publish(config, payload, directory):
    version = make_version(config, payload)
    errors = validate_snapshot(config, payload, version)
    if errors:
        raise FeedError("輸出驗證失敗：" + "; ".join(errors[:10]))
    directory.mkdir(parents=True, exist_ok=True)
    outputs = {"articles.json": payload, "version.json": version}
    with tempfile.TemporaryDirectory(prefix=".feed-stage-", dir=directory) as temp:
        staged = Path(temp)
        for name, value in {**outputs, "config.json": config}.items():
            with (staged / name).open("w", encoding="utf-8") as handle:
                json.dump(value, handle, ensure_ascii=False, indent=2, allow_nan=False)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
        try:
            subprocess.run([
                "node", str(ROOT / "scripts" / "build_school_data.mjs"), str(staged / "config.json"),
                str(staged / "articles.json"), str(staged / "version.json"), str(staged),
            ], check=True, capture_output=True, text=True, timeout=60)
        except subprocess.CalledProcessError as error:
            raise FeedError("分校資料產生失敗：" + error.stderr.strip()) from error
        version = json.loads((staged / "version.json").read_text(encoding="utf-8"))
        errors = validate_snapshot(config, payload, version) + validate_school_artifacts(config, payload, version, staged)
        if errors:
            raise FeedError("分校輸出驗證失敗：" + "; ".join(errors[:10]))
        names = [f"schools/{config['schoolMeta'][school]['slug']}.json" for school in config['schools']] + list(outputs)
        previous = {name: (directory / name).read_bytes() if (directory / name).exists() else None for name in names}
        replaced = []
        try:
            # All school bodies and the legacy archive precede the commit manifest.
            for name in names:
                (directory / name).parent.mkdir(parents=True, exist_ok=True)
                os.replace(staged / name, directory / name)
                replaced.append(name)
        except OSError:
            for index, name in enumerate(reversed(replaced)):
                if previous[name] is None:
                    (directory / name).unlink(missing_ok=True)
                else:
                    backup = staged / f"rollback-{index}"
                    backup.write_bytes(previous[name])
                    os.replace(backup, directory / name)
            raise
    return version


def report_statuses(statuses):
    issues = [item for item in statuses if item["status"] != "ok"]
    if not issues:
        return
    lines = [f"- {item['name']}: {item.get('error') or '；'.join(item.get('warnings', []))}" for item in issues]
    print("\n".join(lines), file=os.sys.stderr)
    summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary_path:
        with open(summary_path, "a", encoding="utf-8") as summary:
            summary.write("## RSS source issues\n\n" + "\n".join(lines) + "\n")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--migrate", action="store_true", help="僅轉換既有資料，不抓取來源或更改更新時間")
    args = parser.parse_args(argv)
    config = json.loads((ROOT / "config.json").read_text(encoding="utf-8"))
    out_dir = ROOT / "data"
    existing = json.loads((out_dir / "articles.json").read_text(encoding="utf-8")) if (out_dir / "articles.json").exists() else {"articles": []}
    if args.migrate:
        payload = migrate_payload(config, existing)
    else:
        results = {}
        with ThreadPoolExecutor(max_workers=6) as executor:
            futures = {executor.submit(fetch, source): source for source in config["sources"]}
            for future in as_completed(futures):
                source = futures[future]
                try:
                    results[source["id"]] = future.result()
                except Exception as error:
                    results[source["id"]] = {"error": str(error)}
        try:
            payload = build_payload(config, existing, results)
        except AllSourcesFailed as error:
            report_statuses(error.statuses)
            raise SystemExit(str(error)) from error
    version = publish(config, payload, out_dir)
    report_statuses(payload["sourceStatus"])
    print(f"saved {len(payload['articles'])} articles; {len(payload['errors'])} source errors; version {version['dataVersion'][:12]}")


if __name__ == "__main__":
    main()
