#!/usr/bin/env python3
"""Run the same offline checks locally and in every CI workflow."""
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main():
    commands = [
        [sys.executable, "scripts/build_site.py", "--check"],
        [sys.executable, "scripts/build_site.py"],
        ["node", "--input-type=module", "--check"],
        ["node", "--check", "sw.js"],
        ["node", "--test", *[str(path.relative_to(ROOT)) for path in sorted((ROOT / "tests").glob("*.test.mjs"))]],
        [sys.executable, "-m", "unittest", "discover", "-s", "tests", "-p", "test_*.py"],
        [sys.executable, "scripts/validate_project.py"],
    ]
    for command in commands:
        kwargs = {"cwd": ROOT, "check": True}
        if command[:3] == ["node", "--input-type=module", "--check"]:
            kwargs["input"] = (ROOT / "app.js").read_bytes()
        subprocess.run(command, **kwargs)
    print("所有離線檢查通過；未抓取 RSS、提交或部署。")


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as error:
        raise SystemExit(error.returncode) from error
