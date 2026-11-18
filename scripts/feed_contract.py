"""Shared, offline validation and canonical versioning for feed snapshots."""
import hashlib
import json
from datetime import datetime
from urllib.parse import urlsplit

SCHEMA_VERSION = 2


def content_hash(value):
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def valid_url(value):
    if not isinstance(value, str):
        return False
    try:
        parsed = urlsplit(value)
        return parsed.scheme in ("http", "https") and bool(parsed.hostname)
    except ValueError:
        return False


def parsed_date(value):
    if not isinstance(value, str) or not value:
        raise ValueError("缺少日期")
    date = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if date.tzinfo is None or date.utcoffset() is None:
        raise ValueError("日期缺少時區")
    return date


def make_version(config, payload):
    return {
        "schemaVersion": SCHEMA_VERSION,
        "dataVersion": content_hash(payload["articles"]),
        "configVersion": content_hash(config),
        **{key: payload[key] for key in ("updatedAt", "lastSuccessfulAt", "sourceStatus", "errors")},
    }


def validate_snapshot(config, data, version):
    """Return errors without network access or filesystem writes."""
    errors = []
    if not isinstance(data, dict) or not isinstance(version, dict) or not isinstance(config, dict):
        return ["設定、資料與版本必須是 JSON 物件"]
    schools = set(config.get("schools", []))
    sources = {source.get("id"): source for source in config.get("sources", [])}
    if None in sources or len(sources) != len(config.get("sources", [])):
        errors.append("來源 ID 缺少或重複")
    articles = data.get("articles")
    if not isinstance(articles, list):
        return errors + ["articles 必須是陣列"]
    seen = set()
    for index, article in enumerate(articles):
        prefix = f"articles[{index}]"
        if not isinstance(article, dict):
            errors.append(f"{prefix}: 公告必須是物件")
            continue
        article_id = article.get("id")
        if not isinstance(article_id, str) or not article_id or article_id in seen:
            errors.append(f"{prefix}: 公告 ID 缺少或重複")
        else:
            seen.add(article_id)
        if not isinstance(article.get("title"), str) or not article["title"].strip():
            errors.append(f"{prefix}: 缺少標題")
        try:
            parsed_date(article.get("published"))
        except (ValueError, TypeError):
            errors.append(f"{prefix}: 發布日期無效或缺少時區")
        targets = article.get("schools")
        if not isinstance(targets, list) or not targets or any(school not in schools for school in targets):
            errors.append(f"{prefix}: 學校欄位無效")
        source = sources.get(article.get("sourceId"))
        if not source or article.get("source") != source.get("name"):
            errors.append(f"{prefix}: 未知來源 ID 或名稱不符")
        elif isinstance(targets, list) and set(targets) != set(source.get("schools", [source.get("school")])):
            errors.append(f"{prefix}: 學校與來源不符")
        for field in ("url", "sourceUrl", "siteUrl"):
            if article.get(field) and not valid_url(article[field]):
                errors.append(f"{prefix}: {field} 網址無效")
        attachments = article.get("attachments", [])
        if not isinstance(attachments, list):
            errors.append(f"{prefix}: attachments 必須是陣列")
        else:
            for attachment in attachments:
                if isinstance(attachment, str) and attachment.strip():
                    continue
                if not isinstance(attachment, dict) or not isinstance(attachment.get("name"), str) or not attachment["name"].strip() or not valid_url(attachment.get("url")):
                    errors.append(f"{prefix}: 附件名稱或網址無效")
    if version.get("schemaVersion") != SCHEMA_VERSION or data.get("schemaVersion") != SCHEMA_VERSION:
        errors.append("不支援的資料格式版本")
    if version.get("dataVersion") != content_hash(articles):
        errors.append("公告內容與 dataVersion 不符")
    if version.get("configVersion") != content_hash(config):
        errors.append("設定與 configVersion 不符")
    for key in ("updatedAt", "lastSuccessfulAt", "sourceStatus", "errors"):
        if version.get(key) != data.get(key):
            errors.append(f"資料與版本的 {key} 不一致")
    for key in ("updatedAt", "lastSuccessfulAt"):
        try:
            parsed_date(version.get(key))
        except (ValueError, TypeError):
            errors.append(f"{key} 日期無效")
    statuses = version.get("sourceStatus")
    if not isinstance(version.get("errors"), list):
        errors.append("errors 必須是陣列")
    if not isinstance(statuses, list) or {item.get("id") for item in statuses if isinstance(item, dict)} != set(sources) or len(statuses) != len(sources):
        errors.append("來源狀態未完整對應設定來源")
    else:
        for status in statuses:
            if 'consecutiveFailures' in status and (type(status['consecutiveFailures']) is not int or status['consecutiveFailures'] < 0):
                errors.append('來源連續失敗次數無效')
            if status.get("status") not in ("ok", "warning", "error"):
                errors.append("來源狀態值無效")
            if not isinstance(status.get("itemCount"), int) or isinstance(status.get("itemCount"), bool) or status["itemCount"] < 0:
                errors.append("來源筆數無效")
            for key in ("lastAttemptAt", "lastSuccessfulAt"):
                if status.get(key) is None and (key == "lastAttemptAt" or status.get("status") != "error"):
                    errors.append(f"來源 {status.get('id')} 缺少 {key}")
                if status.get(key) is not None:
                    try:
                        parsed_date(status[key])
                    except (ValueError, TypeError):
                        errors.append(f"來源 {status.get('id')} 的 {key} 日期無效")
    return errors


def validate_school_artifacts(config, data, version, directory):
    """Validate content hashes and lossless origin coverage for per-school outputs."""
    import re
    errors = []
    entries = version.get("schools")
    slugs = {config.get("schoolMeta", {}).get(school, {}).get("slug"): school for school in config["schools"]}
    if version.get("schoolDataSchemaVersion") != 1 or not isinstance(entries, dict) or set(entries) != set(slugs):
        return ["分校版本清單缺少學校或格式版本不符"]
    sources = {source["id"]: source for source in config["sources"]}
    for slug, school in slugs.items():
        if not isinstance(slug, str) or not re.fullmatch(r"[a-z][a-z0-9-]*", slug):
            errors.append("學校 slug 格式無效")
            continue
        entry = entries[slug]
        if not isinstance(entry, dict) or entry.get("school") != school or entry.get("path") != f"data/schools/{slug}.json":
            errors.append(f"{school}: 分校資料路徑或學校不符")
            continue
        try:
            body = json.loads((directory / "schools" / f"{slug}.json").read_text(encoding="utf-8"))
        except (OSError, ValueError) as error:
            errors.append(f"{school}: 分校資料無法讀取（{error}）")
            continue
        if not isinstance(body, dict) or body.get("kind") != "school-news" or body.get("schemaVersion") != 1 or body.get("school") != school or not isinstance(body.get("articles"), list):
            errors.append(f"{school}: 分校資料格式無效")
            continue
        articles = body["articles"]
        if entry.get("articleCount") != len(articles) or entry.get("dataVersion") != content_hash(articles):
            errors.append(f"{school}: 分校筆數或內容雜湊不符")
        originals = {article["id"]: article for article in data["articles"] if school in article["schools"]}
        covered = []
        seen = set()
        for article in articles:
            if not isinstance(article, dict) or not isinstance(article.get("id"), str) or article["id"] in seen:
                errors.append(f"{school}: 公告 ID 無效或重複")
                continue
            seen.add(article["id"])
            if not isinstance(article.get("title"), str) or not article["title"].strip() or not isinstance(article.get("summary"), str):
                errors.append(f"{school}: 公告標題或摘要格式無效")
            try:
                parsed_date(article.get("published"))
            except (ValueError, TypeError):
                errors.append(f"{school}: 分校公告日期無效")
            if article.get("url") and not valid_url(article["url"]):
                errors.append(f"{school}: 分校公告網址無效")
            source_ids = article.get("sourceIds")
            origins = article.get("origins")
            if not isinstance(source_ids, list) or not source_ids or not isinstance(origins, list) or not origins:
                errors.append(f"{school}: 公告缺少原始來源")
                continue
            for source_id in source_ids:
                source = sources.get(source_id)
                if not source or school not in source.get("schools", [source.get("school")]):
                    errors.append(f"{school}: 混入其他學校或未知來源")
            origin_sources = set()
            for origin in origins:
                raw = originals.get(origin.get("id")) if isinstance(origin, dict) else None
                if not raw or origin.get("sourceId") != raw["sourceId"] or origin.get("url", "") != raw.get("url", ""):
                    errors.append(f"{school}: 原始公告對應錯誤")
                    continue
                covered.append(raw["id"])
                origin_sources.add(origin["sourceId"])
                for original in raw.get("attachments", []):
                    name = original if isinstance(original, str) else original["name"]
                    link = None if isinstance(original, str) else original.get("url")
                    for attachment_list in (origin.get("attachments", []), article.get("attachments", [])):
                        if not any((item if isinstance(item, str) else item.get("name")) == name and (not link or isinstance(item, dict) and item.get("url") == link) for item in attachment_list):
                            errors.append(f"{school}: 合併後遺失附件 {name}")
            if set(source_ids) != origin_sources:
                errors.append(f"{school}: 分類與原始來源不一致")
        if set(covered) != set(originals) or len(covered) != len(set(covered)):
            errors.append(f"{school}: 分校輸出遺失或重複原始公告")
    return errors
