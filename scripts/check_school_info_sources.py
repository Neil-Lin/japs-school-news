#!/usr/bin/env python3
"""Read-only check of the five source rows; conflicting opening hours need review."""
import csv
import io
import json
import os
from pathlib import Path
from urllib.request import Request, urlopen
from school_info import load_info

ROOT = Path(__file__).resolve().parents[1]


def compare_rows(data, directory, campus):
    changes = []
    for slug, school in data['schools'].items():
        for kind, rows, field, value in [('directory', directory, '代碼', school['schoolId']), ('campus', campus, '校名', school['name'])]:
            matches = [row for row in rows if row.get(field) == value]
            if len(matches) != 1 or matches[0] != school['sourceRecords'][kind]:
                changes.append(f'{slug}: {kind} 來源內容已變更或無法唯一比對，請人工核對後再更新。')
    return changes


def main():
    data = load_info(ROOT, json.loads((ROOT / 'config.json').read_text()))
    tables = {}
    failures = []
    for name in ('directory', 'campus'):
        try:
            request = Request(data['sources'][name]['downloadURL'], headers={'User-Agent': 'school-news-public-data/1.0'})
            with urlopen(request, timeout=30) as response:
                raw = response.read(5_000_001)
            if len(raw) > 5_000_000:
                raise ValueError('來源檔案過大')
            tables[name] = list(csv.DictReader(io.StringIO(raw.decode('utf-8-sig'))))
        except Exception as error:
            failures.append(f'{name}: 無法比對來源（{error}），未修改已查核資料。')
    changes = failures or compare_rows(data, tables['directory'], tables['campus'])
    report = '\n'.join(changes) if changes else '五校名錄與市府開放資料未變更；未改寫本站資料或查核日期。校方公告仍須人工核對。'
    path = ROOT / 'reports' / 'school-info-sources.txt'
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(report + '\n', encoding='utf-8')
    if os.environ.get('GITHUB_STEP_SUMMARY'):
        with open(os.environ['GITHUB_STEP_SUMMARY'], 'a', encoding='utf-8') as summary:
            summary.write('## School source comparison\n\n' + report + '\n')
    if changes:
        raise SystemExit('\n'.join(changes))
    print(report)


if __name__ == '__main__':
    main()
