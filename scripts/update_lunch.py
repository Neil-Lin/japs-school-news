#!/usr/bin/env python3
"""Fetch public lunch data independently of RSS; publish only complete school snapshots."""
import argparse
import copy
import json
import tempfile
import time
import urllib.error
import urllib.request
from datetime import date, datetime, timezone
from pathlib import Path
from urllib.parse import urlencode

from atomic_files import replace_files
from lunch_contract import (BASE_URL, LunchError, encode, identifier,
                            ingredient_status, load_settings, meal_date, read_bundle,
                            require, snapshot_reference, source_url, text, timestamp,
                            validate_bundle, validate_snapshot)
from taipei_time import TAIPEI

ROOT = Path(__file__).resolve().parents[1]
MAX_RESPONSE_BYTES = 2_000_000


def envelope(raw):
    require(isinstance(raw, dict) and type(raw.get('result')) is int and raw['result'] == 1,
            'official service returned an unsuccessful response')
    rows = raw.get('data')
    require(isinstance(rows, list) and all(isinstance(row, dict) for row in rows),
            'official response must contain a list of records')
    return rows


class OfficialClient:
    """Sequential requests with spacing, bounded reads and at most one transient retry."""
    def __init__(self, opener=urllib.request.urlopen, sleep=time.sleep, clock=time.monotonic,
                 timeout=15, interval=0.25, max_requests=200):
        self.opener, self.sleep, self.clock = opener, sleep, clock
        self.timeout, self.interval = timeout, interval
        self.last_request = None
        self.request_count, self.max_requests = 0, max_requests

    def get(self, path, params):
        require(path in {'/offered/meal', '/dish', '/ingredient'}, 'unsupported API route')
        url = BASE_URL + path + '?' + urlencode(params)
        for attempt in range(2):
            if self.request_count >= self.max_requests:
                raise LunchError('request-limit', 'lunch update request limit reached')
            if self.last_request is not None:
                delay = self.interval - (self.clock() - self.last_request)
                if delay > 0:
                    self.sleep(delay)
            self.last_request = self.clock()
            self.request_count += 1
            request = urllib.request.Request(url, headers={
                'User-Agent': 'school-news-data-verification/1.0', 'Accept': 'application/json'})
            try:
                with self.opener(request, timeout=self.timeout) as response:
                    require(response.geturl().split('?', 1)[0] == BASE_URL + path,
                            'unexpected API redirect')
                    require(response.headers.get_content_type() == 'application/json',
                            'official response is not JSON')
                    raw = response.read(MAX_RESPONSE_BYTES + 1)
                    require(len(raw) <= MAX_RESPONSE_BYTES, 'official response exceeds size limit')
                try:
                    value = json.loads(raw)
                except (ValueError, UnicodeError) as error:
                    raise LunchError('invalid-data', 'official response is invalid JSON') from error
                return envelope(value)
            except urllib.error.HTTPError as error:
                transient = error.code in {429, 500, 502, 503, 504}
                error.close()
                if transient and attempt == 0:
                    self.sleep(1)
                    continue
                raise LunchError('http-error', 'official service HTTP ' + str(error.code)) from error
            except (OSError, TimeoutError) as error:
                if attempt == 0:
                    self.sleep(1)
                    continue
                raise LunchError('connection-error', 'official service connection failed') from error


def normalize_ingredients(rows, batch_id, dish_id):
    require(len(rows) <= 2000, 'too many ingredients')
    result = []
    seen = set()
    for row in rows:
        require(identifier(row.get('BatchDataId'), 'ingredient batch', numeric=True) == batch_id
                and identifier(row.get('DishId'), 'ingredient dish') == dish_id,
                'ingredient belongs to another meal or dish')
        record_id = identifier(row.get('IngredientBatchId'), 'IngredientBatchId', numeric=True)
        require(record_id not in seen, 'duplicate ingredient batch')
        seen.add(record_id)
        origin = text(row.get('IngredientSourceNameList'), 'ingredient origin')
        if not origin:
            sources = row.get('IngredientSource') or []
            require(isinstance(sources, list) and all(isinstance(s, dict) for s in sources),
                    'invalid ingredient origins')
            origin = '、'.join(filter(None, (text(s.get('name'), 'origin name') for s in sources))) or None
        certs = row.get('Certification') or []
        require(isinstance(certs, list) and len(certs) <= 30, 'invalid ingredient certifications')
        certifications = []
        for cert in certs:
            require(isinstance(cert, dict), 'invalid certification')
            certifications.append({'name': text(cert.get('SourceCertification'), 'certification'),
                                   'id': text(cert.get('CertificationId'), 'certification ID')})
        result.append({'id': record_id, 'name': text(row.get('IngredientName'), 'IngredientName', True),
                       'manufacturer': text(row.get('Manufacturer'), 'Manufacturer'),
                       'origin': origin, 'supplier': text(row.get('SupplierName'), 'SupplierName'),
                       'stockDate': timestamp(row.get('StockDate'), 'StockDate', required=False),
                       'certifications': certifications})
    return result


def normalize_dish(row, batch_id, kitchen_id):
    require(identifier(row.get('BatchDataId'), 'dish batch', numeric=True) == batch_id
            and identifier(row.get('KitchenId'), 'dish kitchen', numeric=True) == kitchen_id,
            'dish belongs to another meal or kitchen')
    dish_id = identifier(row.get('DishId'), 'DishId')
    order = row.get('DishOrder')
    require(order is None or (type(order) is int and 0 <= order <= 10000), 'invalid DishOrder')
    return {'id': identifier(row.get('DishBatchDataId'), 'DishBatchDataId', numeric=True),
            'dishId': dish_id, 'name': text(row.get('DishName'), 'DishName', True),
            'type': text(row.get('DishType'), 'DishType'), 'order': order,
            'updatedAt': timestamp(row.get('UpdateDateTime'), 'dish update', required=False),
            'photoUrl': BASE_URL + '/dish/pic/' + dish_id if dish_id.isascii() and dish_id.isdigit() else None}


def failure(error, scope, **context):
    return {'scope': scope, 'code': error.code, 'message': str(error), **context}


def fetch_school(client, slug, school, day, checked_at):
    errors = []
    snapshot = {'schemaVersion': 1, 'schoolSlug': slug, **school, 'mealDate': day,
                'fetchedAt': checked_at, 'sourceUrl': source_url(school['schoolId'], day),
                'status': 'available', 'providers': []}
    try:
        meals = client.get('/offered/meal', {'KitchenId': 'all', 'MenuType': 1,
                                            'period': day, 'SchoolId': school['schoolId']})
        require(len(meals) <= 20, 'too many meal providers')
        seen = set()
        # Validate all meal identities before accepting any provider data.
        for meal in meals:
            require(identifier(meal.get('SchoolId'), 'meal school', numeric=True) == school['schoolId']
                    and meal.get('SchoolName') == school['schoolName'], 'meal school mismatch')
            raw_day = text(meal.get('MenuDate'), 'MenuDate', True).replace('/', '-')
            require(meal_date(raw_day) == day and type(meal.get('MenuType')) is int
                    and meal['MenuType'] == 1, 'meal date or type mismatch')
            batch_id = identifier(meal.get('BatchDataId'), 'BatchDataId', numeric=True)
            require(batch_id not in seen, 'duplicate meal batch')
            seen.add(batch_id)
    except LunchError as error:
        return {'status': 'error', 'errors': [failure(error, 'meal')], 'snapshot': None}

    for meal in meals:
        context = {'batchId': str(meal['BatchDataId'])}
        try:
            provider = {'batchId': context['batchId'],
                        'kitchenId': identifier(meal.get('KitchenId'), 'KitchenId', numeric=True),
                        'name': text(meal.get('KitchenName'), 'KitchenName', True),
                        'uploadedAt': timestamp(meal.get('UploadDateTime'), 'UploadDateTime', False),
                        'dishes': [], 'seasonings': []}
            context['providerName'] = provider['name']
            rows = client.get('/dish', {'BatchDataId': provider['batchId']})
            require(0 < len(rows) <= 100, 'meal has no dishes or too many dishes')
            normalized = [normalize_dish(row, provider['batchId'], provider['kitchenId']) for row in rows]
            require(len({d['id'] for d in normalized}) == len(normalized), 'duplicate dish records')
            require(any(d['name'] != '調味料' for d in normalized), 'meal contains only seasonings')
        except LunchError as error:
            errors.append(failure(error, 'dish', **context))
            continue
        for dish in normalized:
            try:
                ingredients = client.get('/ingredient', {'BatchDataId': provider['batchId'],
                                                         'DishId': dish['dishId']})
                dish['ingredients'] = normalize_ingredients(ingredients, provider['batchId'], dish['dishId'])
                dish['ingredientStatus'] = ingredient_status(dish['ingredients'])
            except LunchError as error:
                errors.append(failure(error, 'ingredient', **context,
                                      dishId=dish['dishId'], dishName=dish['name']))
                continue
            target = 'seasonings' if dish['name'] == '調味料' else 'dishes'
            provider[target].append(dish)
        for key in ('dishes', 'seasonings'):
            provider[key].sort(key=lambda dish: (dish['order'] if dish['order'] is not None else 10001, dish['id']))
        snapshot['providers'].append(provider)
    if errors:
        # Partial data never replaces the last complete snapshot.
        return {'status': 'partial', 'errors': errors, 'snapshot': None}
    snapshot['providers'].sort(key=lambda provider: (provider['kitchenId'], provider['batchId']))
    if not meals:
        snapshot['status'] = 'no-record'
    validate_snapshot(snapshot, slug, school)
    return {'status': snapshot['status'], 'errors': [], 'snapshot': snapshot}


def prepare_update(schools, previous, old_files, client, day, now):
    day = meal_date(day)
    checked_at = timestamp(now.isoformat(), 'checkedAt')
    if previous:
        validate_bundle(schools, previous, old_files)
        require(day >= previous['requestedDate'], 'refusing to replace newer lunch data with an older query')
        require(now >= datetime.fromisoformat(previous['checkedAt']),
                'update time precedes previous attempt')
    manifest = {'schemaVersion': 1, 'requestedDate': day, 'checkedAt': checked_at, 'schools': {}}
    files = dict(old_files)
    complete_count = 0
    for slug, school in schools.items():
        old_entry = previous['schools'][slug] if previous else {}
        result = fetch_school(client, slug, school, day, checked_at)
        candidate = result['snapshot']
        # A transient empty response must not erase a known menu for the same date.
        ref = old_entry.get('snapshot')
        if candidate and candidate['status'] == 'no-record' and ref and ref['mealDate'] == day and ref['status'] == 'available':
            result = {'status': 'error', 'errors': [failure(LunchError('unexpected-empty',
                      'empty response after a menu was already registered for this date'), 'meal')], 'snapshot': None}
            candidate = None
        if candidate:
            raw = encode(candidate)
            files[slug + '.json'] = raw
            ref = snapshot_reference(slug, candidate, raw)
            complete_count += 1
        manifest['schools'][slug] = {'schoolId': school['schoolId'], 'status': result['status'],
                                    'errors': result['errors'], 'snapshot': copy.deepcopy(ref),
                                    'lastSuccessAt': ref['fetchedAt'] if ref else None}
    validate_bundle(schools, manifest, files)
    return manifest, files, complete_count


def publish(schools, manifest, files, directory):
    validate_bundle(schools, manifest, files)
    directory = Path(directory)
    require(not directory.is_symlink(), 'lunch directory cannot be a symlink')
    directory.mkdir(parents=True, exist_ok=True)
    contents = {**files, 'status.json': encode(manifest)}
    for name in contents:
        require(not (directory / name).is_symlink(), 'lunch output cannot be a symlink')
    # Snapshot files first, status/hash manifest last. Roll back all replaced files on error.
    with tempfile.TemporaryDirectory(prefix='.lunch-stage-', dir=directory) as temp:
        stage = Path(temp)
        changed = {}
        for name, raw in contents.items():
            target = directory / name
            old = target.read_bytes() if target.exists() else None
            if raw != old:
                changed[name] = old
                (stage / name).write_bytes(raw)
        replace_files(stage, directory, changed)


def taipei_day(now):
    return now.astimezone(TAIPEI).date()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--date', type=date.fromisoformat, help='Query day; defaults to today in Asia/Taipei')
    parser.add_argument('--output', type=Path, default=ROOT / 'data/lunch')
    parser.add_argument('--report', type=Path, help='Write attempt diagnostics, including all-failure runs, outside public data')
    args = parser.parse_args(argv)
    now = datetime.now(timezone.utc)
    day = (args.date or taipei_day(now)).isoformat()
    schools = load_settings(ROOT)
    previous, old_files = read_bundle(args.output, schools)
    manifest, files, complete = prepare_update(schools, previous, old_files, OfficialClient(), day, now)
    if args.report:
        require(not args.report.resolve().is_relative_to(args.output.resolve()),
                'diagnostic report must be outside the public lunch directory')
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_bytes(encode(manifest))
    for slug, entry in manifest['schools'].items():
        print(slug + ': ' + entry['status'] + '; errors=' + str(len(entry['errors'])))
        for error in entry['errors']:
            print('  ' + error['scope'] + ': ' + error['message'])
    if not complete:
        print('All schools failed or were incomplete; no public files changed.')
        return 1
    publish(schools, manifest, files, args.output)
    print('Published ' + str(complete) + ' complete school snapshots; retained other schools unchanged.')
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (LunchError, OSError, ValueError) as error:
        raise SystemExit('Lunch update failed: ' + str(error)) from error
