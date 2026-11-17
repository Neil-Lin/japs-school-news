"""Validated, independent school lunch snapshots (no network requests)."""
import hashlib
import json
import re
from datetime import date, datetime
from pathlib import Path
from urllib.parse import urlencode

BASE_URL = 'https://fatraceschool.k12ea.gov.tw'
SCHEMA_VERSION = 1
COMPLETE_STATUSES = {'available', 'no-record'}
ATTEMPT_STATUSES = COMPLETE_STATUSES | {'partial', 'error'}


class LunchError(ValueError):
    def __init__(self, code, message):
        self.code = code
        super().__init__(message)


def require(condition, message):
    if not condition:
        raise LunchError('invalid-data', message)


def text(value, label, required=False):
    require(value is None or isinstance(value, str), label + ' must be text')
    value = value.strip() if value is not None else None
    require(not required or bool(value), label + ' is required')
    require(value is None or len(value) <= 2000, label + ' is too long')
    return value


def identifier(value, label, numeric=False):
    if type(value) is int and value > 0:
        value = str(value)
    value = text(value, label, required=True)
    require(len(value) <= 100 and (not numeric or bool(re.fullmatch(r'[0-9]+', value))),
            label + ' has invalid format')
    return value


def timestamp(value, label, required=True):
    if value in (None, '') and not required:
        return None
    value = text(value, label, required=True)
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
        require(parsed.tzinfo is not None and parsed.utcoffset() is not None,
                label + ' needs a timezone')
    except ValueError as error:
        raise LunchError('invalid-data', label + ' must be an ISO timestamp with timezone') from error
    return value


def meal_date(value):
    require(isinstance(value, str) and bool(re.fullmatch(r'\d{4}-\d{2}-\d{2}', value)),
            'mealDate must be YYYY-MM-DD')
    try:
        date.fromisoformat(value)
    except ValueError as error:
        raise LunchError('invalid-data', 'invalid mealDate') from error
    return value


def source_url(school_id, day):
    return BASE_URL + '/frontend/search.html?' + urlencode({'school': school_id, 'period': day})


def encode(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'),
                       allow_nan=False) + '\n').encode('utf-8')


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def load_settings(root):
    root = Path(root)
    raw = json.loads((root / 'lunch-schools.json').read_text(encoding='utf-8'))
    config = json.loads((root / 'config.json').read_text(encoding='utf-8'))
    require(isinstance(raw, dict) and type(raw.get('schemaVersion')) is int and raw['schemaVersion'] == SCHEMA_VERSION,
            'unsupported lunch school configuration')
    schools = raw.get('schools')
    require(isinstance(schools, dict) and bool(schools), 'lunch schools must be configured')
    slugs = {meta['slug'] for meta in config['schoolMeta'].values()}
    seen = set()
    for slug, school in schools.items():
        require(bool(re.fullmatch(r'[a-z][a-z0-9-]*', slug)) and slug in slugs,
                'unknown lunch school slug')
        require(isinstance(school, dict), 'school configuration must be an object')
        school_id = identifier(school.get('schoolId'), 'schoolId', numeric=True)
        require(school_id == school.get('schoolId') and school_id not in seen,
                'schoolId must be a unique string')
        text(school.get('schoolName'), 'schoolName', required=True)
        seen.add(school_id)
    return schools


def validate_snapshot(snapshot, slug, school):
    require(isinstance(snapshot, dict), 'snapshot must be an object')
    require(type(snapshot.get('schemaVersion')) is int and snapshot['schemaVersion'] == SCHEMA_VERSION,
            'unsupported lunch snapshot schema')
    require(snapshot.get('schoolSlug') == slug and snapshot.get('schoolId') == school['schoolId']
            and snapshot.get('schoolName') == school['schoolName'], 'snapshot school mismatch')
    day = meal_date(snapshot.get('mealDate'))
    timestamp(snapshot.get('fetchedAt'), 'fetchedAt')
    require(snapshot.get('sourceUrl') == source_url(school['schoolId'], day), 'source URL mismatch')
    status = snapshot.get('status')
    require(isinstance(status, str) and status in COMPLETE_STATUSES, 'only complete snapshots can be published')
    providers = snapshot.get('providers')
    require(isinstance(providers, list) and len(providers) <= 20, 'invalid providers')
    require(bool(providers) == (status == 'available'), 'providers/status mismatch')
    batches = set()
    for provider in providers:
        require(isinstance(provider, dict), 'invalid provider')
        batch_id = identifier(provider.get('batchId'), 'batchId', numeric=True)
        require(isinstance(provider.get('batchId'), str) and isinstance(provider.get('kitchenId'), str),
                'provider IDs must be strings')
        require(batch_id not in batches, 'duplicate meal batch')
        batches.add(batch_id)
        identifier(provider.get('kitchenId'), 'kitchenId', numeric=True)
        text(provider.get('name'), 'provider name', required=True)
        timestamp(provider.get('uploadedAt'), 'uploadedAt', required=False)
        dishes, seasonings = provider.get('dishes'), provider.get('seasonings')
        require(isinstance(dishes, list) and 0 < len(dishes) <= 100, 'invalid dishes')
        require(isinstance(seasonings, list) and len(seasonings) <= 100, 'invalid seasonings')
        dish_ids = set()
        for dish in dishes + seasonings:
            require(isinstance(dish, dict), 'invalid dish')
            record_id = identifier(dish.get('id'), 'dish record ID', numeric=True)
            require(isinstance(dish.get('id'), str) and isinstance(dish.get('dishId'), str),
                    'dish IDs must be strings')
            require(record_id not in dish_ids, 'duplicate dish record')
            dish_ids.add(record_id)
            dish_id = identifier(dish.get('dishId'), 'dishId')
            name = text(dish.get('name'), 'dish name', required=True)
            require((name == '調味料') == (dish in seasonings), 'seasoning classification mismatch')
            text(dish.get('type'), 'dish type')
            order = dish.get('order')
            require(order is None or (type(order) is int and 0 <= order <= 10000), 'invalid dish order')
            timestamp(dish.get('updatedAt'), 'dish updatedAt', required=False)
            expected_photo = BASE_URL + '/dish/pic/' + dish_id if dish_id.isascii() and dish_id.isdigit() else None
            require(dish.get('photoUrl') == expected_photo, 'untrusted dish photo URL')
            ingredients = dish.get('ingredients')
            require(isinstance(ingredients, list) and len(ingredients) <= 2000, 'invalid ingredients')
            ids = set()
            for ingredient in ingredients:
                require(isinstance(ingredient, dict), 'invalid ingredient')
                ingredient_id = identifier(ingredient.get('id'), 'ingredient record ID', numeric=True)
                require(isinstance(ingredient.get('id'), str), 'ingredient IDs must be strings')
                require(ingredient_id not in ids, 'duplicate ingredient record')
                ids.add(ingredient_id)
                text(ingredient.get('name'), 'ingredient name', required=True)
                for field in ('manufacturer', 'origin', 'supplier'):
                    text(ingredient.get(field), field)
                timestamp(ingredient.get('stockDate'), 'stockDate', required=False)
                certifications = ingredient.get('certifications')
                require(isinstance(certifications, list) and len(certifications) <= 30,
                        'invalid certifications')
                for cert in certifications:
                    require(isinstance(cert, dict), 'invalid certification')
                    text(cert.get('name'), 'certification name')
                    text(cert.get('id'), 'certification ID')
            require(dish.get('ingredientStatus') == ingredient_status(ingredients),
                    'ingredient registration status mismatch')
    return snapshot


def ingredient_status(ingredients):
    registered = sum(bool(item.get('stockDate')) for item in ingredients)
    if not ingredients or not registered:
        return 'not-registered'
    return 'registered' if registered == len(ingredients) else 'partial'


def snapshot_reference(slug, snapshot, raw):
    return {'path': slug + '.json', 'sha256': digest(raw), 'mealDate': snapshot['mealDate'],
            'fetchedAt': snapshot['fetchedAt'], 'status': snapshot['status']}


def validate_bundle(schools, manifest, files):
    require(isinstance(manifest, dict) and type(manifest.get('schemaVersion')) is int
            and manifest['schemaVersion'] == SCHEMA_VERSION,
            'unsupported lunch status schema')
    requested = meal_date(manifest.get('requestedDate'))
    checked_at = timestamp(manifest.get('checkedAt'), 'checkedAt')
    entries = manifest.get('schools')
    require(isinstance(entries, dict) and set(entries) == set(schools), 'lunch status school mismatch')
    expected = set()
    for slug, school in schools.items():
        entry = entries[slug]
        require(isinstance(entry, dict) and entry.get('schoolId') == school['schoolId'],
                'status school mismatch')
        require(isinstance(entry.get('status'), str) and entry['status'] in ATTEMPT_STATUSES,
                'invalid update status')
        errors = entry.get('errors')
        require(isinstance(errors, list) and len(errors) <= 2100, 'invalid update errors')
        require(bool(errors) == (entry['status'] in {'partial', 'error'}), 'status/errors mismatch')
        for error in errors:
            require(isinstance(error, dict) and isinstance(error.get('scope'), str)
                    and error['scope'] in {'meal', 'dish', 'ingredient'},
                    'invalid error scope')
            text(error.get('code'), 'error code', required=True)
            text(error.get('message'), 'error message', required=True)
            for key in ('batchId', 'dishId', 'providerName', 'dishName'):
                text(error.get(key), 'error ' + key)
        ref = entry.get('snapshot')
        last_success = timestamp(entry.get('lastSuccessAt'), 'lastSuccessAt', required=False)
        if ref is None:
            require(last_success is None and entry['status'] not in COMPLETE_STATUSES,
                    'successful update must have a snapshot')
            continue
        require(isinstance(ref, dict) and ref.get('path') == slug + '.json', 'invalid snapshot path')
        expected.add(ref['path'])
        raw = files.get(ref['path'])
        require(isinstance(raw, bytes) and digest(raw) == ref.get('sha256'), 'snapshot hash mismatch')
        snapshot = validate_snapshot(json.loads(raw), slug, school)
        require(ref == snapshot_reference(slug, snapshot, raw), 'snapshot reference mismatch')
        require(last_success == snapshot['fetchedAt'], 'lastSuccessAt mismatch')
        require(snapshot['mealDate'] <= requested, 'snapshot is newer than requested date')
        require(datetime.fromisoformat(last_success.replace('Z', '+00:00')) <=
                datetime.fromisoformat(checked_at.replace('Z', '+00:00')), 'update time precedes snapshot')
        if entry['status'] in COMPLETE_STATUSES:
            require(snapshot['status'] == entry['status'] and snapshot['mealDate'] == requested
                    and snapshot['fetchedAt'] == checked_at, 'successful attempt/snapshot mismatch')
    require(set(files) == expected, 'unexpected or missing lunch snapshot files')


def read_bundle(directory, schools):
    directory = Path(directory)
    require(not directory.is_symlink(), 'lunch directory cannot be a symlink')
    status_path = directory / 'status.json'
    if not status_path.exists():
        require(not directory.exists() or not any(directory.iterdir()),
                'lunch files exist without status.json')
        return None, {}
    require(not status_path.is_symlink(), 'status file cannot be a symlink')
    manifest = json.loads(status_path.read_bytes())
    files = {}
    # Only read known school filenames; never follow paths from unvalidated JSON.
    for slug in schools:
        path = directory / (slug + '.json')
        if path.exists():
            require(not path.is_symlink(), 'snapshot cannot be a symlink')
            files[path.name] = path.read_bytes()
    validate_bundle(schools, manifest, files)
    return manifest, files


def public_files(root):
    """Return a validated allowlist; no lunch config means an announcements-only site."""
    root = Path(root)
    if not (root / 'lunch-schools.json').exists():
        return []
    schools = load_settings(root)
    manifest, files = read_bundle(root / 'data/lunch', schools)
    require(manifest is not None, 'lunch configuration requires an initial validated snapshot')
    return ['data/lunch/status.json'] + ['data/lunch/' + path for path in sorted(files)]
