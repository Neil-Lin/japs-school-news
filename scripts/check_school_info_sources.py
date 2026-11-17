#!/usr/bin/env python3
"""Read-only check of the five source rows; conflicting opening hours need review."""
import csv
import io
import json
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
    for name in ('directory', 'campus'):
        request = Request(data['sources'][name]['downloadURL'], headers={'User-Agent': 'school-news-public-data/1.0'})
        with urlopen(request, timeout=30) as response:
            raw = response.read(5_000_001)
        if len(raw) > 5_000_000:
            raise ValueError('來源檔案過大')
        tables[name] = list(csv.DictReader(io.StringIO(raw.decode('utf-8-sig'))))
    changes = compare_rows(data, tables['directory'], tables['campus'])
    if changes:
        raise SystemExit('\n'.join(changes))
    print('五校名錄與市府開放資料未變更；未改寫本站資料或查核日期。校方公告仍須人工核對。')


if __name__ == '__main__':
    main()
