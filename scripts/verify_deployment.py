#!/usr/bin/env python3
"""Compare the actual public response bytes to a manifest prepared from the deployed artifact."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path, PurePosixPath
import time
from urllib.parse import urlparse
from urllib.request import Request, urlopen


def prepare(directory):
    root = Path(directory)
    manifest = json.loads((root / 'assets-manifest.json').read_text())
    files = {}
    for name in manifest['publicFiles']:
        path = PurePosixPath(name)
        if path.is_absolute() or '..' in path.parts:
            raise ValueError('Unsafe public path')
        if name == '.nojekyll':
            continue
        content = (root / name).read_bytes()
        files[name] = {'bytes': len(content), 'sha256': hashlib.sha256(content).hexdigest()}
    return {'schemaVersion': 1, 'shellVersion': manifest['shellVersion'], 'files': files}


def verify(base, expected, fetch=None, deadline=None):
    parsed = urlparse(base)
    if parsed.scheme != 'https' and not (parsed.scheme == 'http' and parsed.hostname in ('127.0.0.1', 'localhost')):
        raise ValueError('Expected HTTPS deployment or a local test server')
    def download(name, limit):
        request = Request(base.rstrip('/') + '/' + name + '?release=' + expected['shellVersion'], headers={'Cache-Control': 'no-cache', 'User-Agent': 'school-news-deployment-check/1.0'})
        timeout = min(25, max(1, deadline - time.monotonic())) if deadline else 25
        with urlopen(request, timeout=timeout) as response:
            if urlparse(response.url).netloc != parsed.netloc:
                raise ValueError('Unexpected redirect host')
            return response.read(limit + 1)
    fetch = fetch or download
    def check(entry):
        name, record = entry
        path = PurePosixPath(name)
        if path.is_absolute() or '..' in path.parts or not 0 <= record['bytes'] <= 12_000_000:
            return {'path': name, 'ok': False, 'reason': 'Invalid expected path/size'}
        try:
            if deadline and time.monotonic() >= deadline:
                raise TimeoutError('Deployment verification time budget exhausted')
            body = fetch(name, record['bytes'])
            ok = len(body) == record['bytes'] and hashlib.sha256(body).hexdigest() == record['sha256']
            return {'path': name, 'ok': ok, 'reason': '' if ok else 'Public bytes differ from deployed artifact'}
        except Exception as error:
            return {'path': name, 'ok': False, 'reason': str(error)}
    with ThreadPoolExecutor(max_workers=4) as pool:
        return list(pool.map(check, sorted(expected['files'].items())))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--prepare', type=Path)
    parser.add_argument('--expected', type=Path)
    parser.add_argument('--base-url')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--attempts', type=int, default=6)
    parser.add_argument('--delay', type=int, default=10)
    parser.add_argument('--max-seconds', type=int, default=360)
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    if args.prepare:
        result = prepare(args.prepare)
    else:
        expected = json.loads(args.expected.read_text())
        if not 1 <= args.attempts <= 6 or not 0 <= args.delay <= 30 or not 30 <= args.max_seconds <= 480:
            parser.error('Retry bounds exceeded')
        deadline = time.monotonic() + args.max_seconds
        for attempt in range(args.attempts):
            rows = verify(args.base_url, expected, deadline=deadline)
            result = {'shellVersion': expected['shellVersion'], 'attempt': attempt + 1, 'files': rows, 'ok': all(row['ok'] for row in rows)}
            args.output.write_text(json.dumps(result, indent=2) + '\n')
            if result['ok']:
                break
            print(f"Attempt {attempt + 1}: " + ', '.join(row['path'] for row in rows if not row['ok']))
            if time.monotonic() >= deadline:
                break
            if attempt + 1 < args.attempts:
                time.sleep(args.delay)
        if not result['ok']:
            raise SystemExit('Public deployment verification failed; see report. No rollback was performed automatically.')
        print(f"Verified {len(rows)} public files; shell {expected['shellVersion']}")
    args.output.write_text(json.dumps(result, indent=2) + '\n')


if __name__ == '__main__':
    main()
