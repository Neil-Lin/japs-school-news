#!/usr/bin/env python3
"""Render shared pages and content-hashed native modules; package only public files."""
import argparse
import hashlib
import html
import json
import os
import re
import tempfile
from pathlib import Path, PurePosixPath
from string import Template
from lunch_contract import public_files as lunch_public_files, load_settings as lunch_settings

ROOT = Path(__file__).resolve().parents[1]
MODULES = ("news-core.mjs", "school-data.mjs", "data-client.mjs", "lunch-client.mjs", "lunch-ui.mjs", "app.js")
IMAGES = ("icon-192.png", "icon-512.png", "splash-750x1334.png", "splash-1170x2532.png")
IMPORT = re.compile(r"(?P<lead>\b(?:from|import)\s*['\"])(?P<path>\./[^'\"]+\.(?:mjs|js))(?:\?[^'\"]*)?(?P<quote>['\"])")
STATIC = re.compile(r"static/(?:app|news-core|data-client|school-data|lunch-client|lunch-ui|styles)\.[a-f0-9]{12}\.(?:mjs|js|css)")


def public_path(path):
    fixed = {"index.html", "sw.js", "assets-manifest.json", "config.json", "manifest.json", "styles.css", ".nojekyll", "data/articles.json", "data/version.json", *MODULES, *["assets/" + name for name in IMAGES]}
    return isinstance(path, str) and (path in fixed or bool(STATIC.fullmatch(path))
        or bool(re.fullmatch(r"[a-z][a-z0-9-]*/index\.html", path))
        or bool(re.fullmatch(r"data/schools/[a-z][a-z0-9-]*\.json", path))
        or bool(re.fullmatch(r"data/lunch/[a-z][a-z0-9-]*\.json", path)))


class BuildError(ValueError):
    pass


def read_source(root, relative):
    path = root / relative
    if path.is_symlink() or root.resolve() not in path.resolve().parents:
        raise BuildError(f"拒絕讀取專案外或符號連結檔案：{relative}")
    try:
        return path.read_bytes()
    except OSError as error:
        raise BuildError(f"無法讀取建置來源 {relative}：{error}") from error


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def plan_site(root=ROOT):
    root = Path(root)
    config = json.loads(read_source(root, "config.json"))
    manifest = json.loads(read_source(root, "manifest.json"))
    schools = config["schools"]
    if not schools or set(schools) != set(config["schoolMeta"]):
        raise BuildError("學校與 metadata 不一致")
    slugs = [config["schoolMeta"][name]["slug"] for name in schools]
    lunch_schools = lunch_settings(root) if (root / 'lunch-schools.json').exists() else {}
    if len(set(slugs)) != len(slugs) or any(not re.fullmatch(r"[a-z][a-z0-9-]*", slug) for slug in slugs):
        raise BuildError("學校 slug 必須唯一且只能包含小寫英文字母、數字與連字號")
    generated = {}
    assets = {}
    visiting = set()

    def compile_module(name):
        if name in assets:
            return assets[name]
        if name not in MODULES:
            raise BuildError(f"未列入發布清單的瀏覽器模組：{name}")
        if name in visiting:
            raise BuildError(f"瀏覽器模組有循環相依：{name}")
        visiting.add(name)
        source = read_source(root, name).decode("utf-8")
        def dependency(match):
            path = match["path"][2:]
            built = compile_module(path)
            return match["lead"] + "./" + PurePosixPath(built).name + match["quote"]
        compiled = IMPORT.sub(dependency, source).encode("utf-8")
        digest = hashlib.sha256(compiled).hexdigest()[:12]
        path = PurePosixPath(name)
        target = f"static/{path.stem}.{digest}{path.suffix}"
        assets[name] = target
        generated[target] = compiled
        visiting.remove(name)
        return target

    for module in MODULES:
        compile_module(module)
    stylesheet = read_source(root, "styles.css")
    assets["styles.css"] = "static/styles." + hashlib.sha256(stylesheet).hexdigest()[:12] + ".css"
    generated[assets["styles.css"]] = stylesheet
    template = Template(read_source(root, "templates/page.html").decode("utf-8"))
    pages = []
    for school in [None] + schools:
        name = school or schools[0]
        meta = config["schoolMeta"][name]
        relative = f"{meta['slug']}/index.html" if school else "index.html"
        values = {
            "base_tag": '  <base href="../">\n' if school else "",
            "page_title": school + "消息牆" if school else manifest["name"],
            "description": school + "校內公告、家長資訊與教育消息，支援分類多選與關鍵字搜尋。" if school else "、".join(schools) + "公告彙整，支援分類多選與關鍵字搜尋。",
            "style_asset": assets["styles.css"], "app_asset": assets["app.js"],
            "school_slug": meta["slug"], "school_name": name,
            "lunch_school_id": lunch_schools.get(meta['slug'], {}).get('schoolId', ''),
            "lunch_hidden": '' if meta['slug'] in lunch_schools else 'hidden',
            "official_site": meta["site"], "skip_href": f"{meta['slug']}/#main" if school else "#main",
            "source_labels": "、".join(schools + ["臺北市教育局"]),
        }
        values = {key: value if key == "base_tag" else html.escape(value, quote=True) for key, value in values.items()}
        generated[relative] = template.substitute(values).encode("utf-8")
        pages.append(relative)
    shell = ["./"] + [f"./{slug}/" for slug in slugs] + ["./" + path for path in sorted(assets.values())]
    shell += ["./manifest.json"] + ["./assets/" + name for name in IMAGES]
    shell_inputs = {path: generated[path] for path in generated}
    shell_inputs.update({"manifest.json": read_source(root, "manifest.json"), "templates/sw.js": read_source(root, "templates/sw.js")})
    shell_inputs.update({"assets/" + name: read_source(root, "assets/" + name) for name in IMAGES})
    digest = hashlib.sha256()
    for path, content in sorted(shell_inputs.items()):
        digest.update(path.encode("utf-8") + b"\0" + content + b"\0")
    shell_version = digest.hexdigest()[:16]
    generated["sw.js"] = read_source(root, "templates/sw.js").decode("utf-8").replace("__SHELL_VERSION__", shell_version).replace("__SHELL__", json.dumps(shell, ensure_ascii=False, indent=2)).encode("utf-8")
    public = set(generated) | {"assets-manifest.json", "config.json", "manifest.json", "styles.css", ".nojekyll", "data/articles.json", "data/version.json"}
    public.update(MODULES)
    public.update("assets/" + name for name in IMAGES)
    public.update(f"data/schools/{slug}.json" for slug in slugs)
    try:
        public.update(lunch_public_files(root))
    except (ValueError, OSError, TypeError, KeyError) as error:
        raise BuildError(f"午餐快照驗證失敗：{error}") from error
    metadata = {"schemaVersion": 1, "assets": dict(sorted(assets.items())), "shellVersion": shell_version, "pages": pages, "publicFiles": sorted(public)}
    generated["assets-manifest.json"] = json_bytes(metadata)
    return {"generated": generated, "metadata": metadata, "tracked": pages + ["sw.js", "assets-manifest.json"]}


def check_workspace(root=ROOT):
    root = Path(root)
    plan = plan_site(root)
    errors = []
    for path in plan["tracked"]:
        if not (root / path).is_file() or (root / path).read_bytes() != plan["generated"][path]:
            errors.append(f"產生檔案未更新：{path}")
    for path, data in plan["generated"].items():
        if path.startswith("static/") and (root / path).exists() and (root / path).read_bytes() != data:
            errors.append(f"靜態產物被修改：{path}")
    return errors


def write_atomic(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = tempfile.NamedTemporaryFile(prefix=".site-", dir=path.parent, delete=False)
    pending = Path(handle.name)
    try:
        with handle:
            handle.write(data)
        os.replace(pending, path)
    finally:
        pending.unlink(missing_ok=True)


def build_workspace(root=ROOT):
    root = Path(root)
    plan = plan_site(root)
    previous = {}
    try:
        previous = json.loads((root / "assets-manifest.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        pass
    for path, data in plan["generated"].items():
        write_atomic(root / path, data)
    old_assets = previous.get("assets", {}) if isinstance(previous, dict) else {}
    for path in old_assets.values() if isinstance(old_assets, dict) else []:
        if isinstance(path, str) and STATIC.fullmatch(path) and path not in plan["generated"]:
            (root / path).unlink(missing_ok=True)
    return plan


def package_site(output, root=ROOT):
    root, output = Path(root).resolve(), Path(output)
    if output.is_symlink() or output.resolve() == root or output.resolve() in root.parents:
        raise BuildError("發布目錄不得是原始碼目錄、其父目錄或符號連結")
    output = output.resolve()
    plan = plan_site(root)
    contents = {}
    for relative in plan["metadata"]["publicFiles"]:
        contents[relative] = plan["generated"].get(relative)
        if contents[relative] is None:
            contents[relative] = b"" if relative == ".nojekyll" else read_source(root, relative)
    from feed_contract import validate_snapshot, validate_school_artifacts
    config = json.loads(contents["config.json"])
    data = json.loads(contents["data/articles.json"])
    version = json.loads(contents["data/version.json"])
    errors = validate_snapshot(config, data, version) + validate_school_artifacts(config, data, version, root / "data")
    if errors:
        raise BuildError("發布資料驗證失敗：" + "; ".join(errors[:5]))
    if output.exists():
        if not output.is_dir():
            raise BuildError("發布目錄已是檔案，拒絕覆寫")
        files = list(output.rglob("*"))
        if any(path.is_symlink() for path in files):
            raise BuildError("發布目錄含符號連結，拒絕覆寫")
        existing = {path.relative_to(output).as_posix() for path in files if path.is_file()}
        if existing:
            try:
                previous = json.loads((output / "assets-manifest.json").read_text(encoding="utf-8"))
                owned = set(previous["publicFiles"])
            except (OSError, ValueError, KeyError, TypeError) as error:
                raise BuildError("發布目錄不是已知網站產物；請使用空目錄") from error
            if previous.get("schemaVersion") != 1 or not existing <= owned or not all(public_path(path) for path in owned):
                raise BuildError("發布目錄含額外檔案，拒絕覆寫")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="." + output.name + "-stage-", dir=output.parent) as temp:
        stage = Path(temp) / "site"
        stage.mkdir()
        for path, data in contents.items():
            target = stage / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        backup = Path(temp) / "old"
        if output.exists():
            os.replace(output, backup)
        try:
            os.replace(stage, output)
        except OSError:
            if backup.exists():
                os.replace(backup, output)
            raise
    return plan


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="檢查已提交的產生檔案是否最新，不寫入檔案")
    parser.add_argument("--output", type=Path, help="只打包公開網站檔案到指定目錄，例如 dist")
    args = parser.parse_args()
    try:
        if args.check:
            if args.output:
                raise BuildError("--check 與 --output 不可同時使用")
            errors = check_workspace()
            if errors:
                raise BuildError("\n".join(errors) + "\n請執行 python3 scripts/build_site.py 後提交產生檔案。")
            print("共用模板與資產版本檢查通過")
        else:
            plan = package_site(args.output) if args.output else build_workspace()
            print(f"已產生 {len(plan['metadata']['pages'])} 個頁面；資產版本 {plan['metadata']['shellVersion']}")
    except (BuildError, KeyError, ValueError) as error:
        raise SystemExit(str(error)) from error


if __name__ == "__main__":
    main()
