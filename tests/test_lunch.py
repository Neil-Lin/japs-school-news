import copy
import io
import json
import sys
import tempfile
import unittest
import urllib.error
from datetime import datetime, timedelta, timezone
from email.message import Message
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import lunch_contract as contract
import update_lunch as lunch

NOW = datetime(2026, 11, 17, 2, tzinfo=timezone.utc)
DAY = '2026-11-17'
SCHOOLS = {'renai': {'schoolId': '333605', 'schoolName': '臺北市大安區仁愛國小'},
           'boai': {'schoolId': '323609', 'schoolName': '臺北市信義區博愛國小'}}


def meal(school, batch='100', kitchen=12):
    return {'BatchDataId': batch, 'KitchenId': kitchen, 'KitchenName': '供餐商 ' + str(kitchen),
            'SchoolId': int(school['schoolId']), 'SchoolName': school['schoolName'],
            'MenuDate': DAY.replace('-', '/'), 'MenuType': 1,
            'UploadDateTime': NOW.isoformat()}


def dish(batch='100', kitchen=12, record='101', name='(素)蔬菜飯', dish_id='102'):
    return {'DishBatchDataId': record, 'BatchDataId': batch, 'KitchenId': kitchen,
            'DishId': dish_id, 'DishName': name, 'DishType': '主食', 'DishOrder': 10,
            'PicturePath': '', 'UpdateDateTime': NOW.isoformat()}


def ingredient(batch='100', dish_id='102'):
    return {'IngredientBatchId': '103', 'BatchDataId': batch, 'DishId': dish_id,
            'IngredientName': '白米', 'Manufacturer': '製造商', 'SupplierName': '供應商',
            'Origin': '', 'IngredientSourceNameList': '臺灣',
            'StockDate': NOW.isoformat(), 'Certification': [{'SourceCertification': '有機', 'CertificationId': 'ORG-1'}]}


class FakeClient:
    def __init__(self, handler=None):
        self.calls = []
        self.handler = handler

    def get(self, path, params):
        self.calls.append((path, params))
        if self.handler:
            result = self.handler(path, params)
            if result is not None:
                return copy.deepcopy(result)
        if path == '/offered/meal':
            school = next(s for s in SCHOOLS.values() if s['schoolId'] == params['SchoolId'])
            row = meal(school)
            row['MenuDate'] = params['period'].replace('-', '/')
            return [row]
        if path == '/dish':
            return [dish(batch=params['BatchDataId'])]
        return [ingredient(batch=params['BatchDataId'], dish_id=params['DishId'])]


def prepare(client=None, previous=None, files=None, day=DAY, now=NOW):
    return lunch.prepare_update(SCHOOLS, previous, files or {}, client or FakeClient(), day, now)


def fail(_path, _params):
    raise contract.LunchError('connection-error', 'timeout')


class LunchDataTests(unittest.TestCase):
    def test_complete_menus_preserve_school_provider_dish_origin_and_photo_identity(self):
        manifest, files, complete = prepare()
        self.assertEqual(complete, 2)
        contract.validate_bundle(SCHOOLS, manifest, files)
        snap = json.loads(files['renai.json'])
        self.assertEqual(snap['mealDate'], DAY)
        provider = snap['providers'][0]
        self.assertIsInstance(provider['batchId'], str)
        self.assertEqual(provider['dishes'][0]['name'], '(素)蔬菜飯')
        self.assertEqual(provider['dishes'][0]['photoUrl'], contract.BASE_URL + '/dish/pic/102')
        row = provider['dishes'][0]['ingredients'][0]
        self.assertEqual((row['manufacturer'], row['supplier'], row['origin']), ('製造商', '供應商', '臺灣'))
        self.assertEqual(snap['sourceUrl'], contract.BASE_URL + '/frontend/search.html?school=333605&period=' + DAY)

    def test_multiple_providers_remain_separate_and_seasoning_can_omit_type(self):
        def handler(path, params):
            if path == '/offered/meal':
                school = next(s for s in SCHOOLS.values() if s['schoolId'] == params['SchoolId'])
                return [meal(school, '200', 21), meal(school)]
            if path == '/dish':
                batch = params['BatchDataId']
                kitchen = 21 if batch == '200' else 12
                seasoning = dish(batch, kitchen, '105', '調味料', '106')
                seasoning.pop('DishType')
                return [seasoning, dish(batch, kitchen)]
        manifest, files, _ = prepare(FakeClient(handler))
        contract.validate_bundle(SCHOOLS, manifest, files)
        providers = json.loads(files['renai.json'])['providers']
        self.assertEqual(len(providers), 2)
        self.assertEqual([p['batchId'] for p in providers], ['100', '200'])
        self.assertTrue(all(len(p['dishes']) == len(p['seasonings']) == 1 for p in providers))
        self.assertIsNone(providers[0]['seasonings'][0]['type'])

    def test_empty_meal_is_no_record_but_empty_dish_is_incomplete(self):
        m, files, count = prepare(FakeClient(lambda path, _: [] if path == '/offered/meal' else None))
        self.assertEqual(count, 2)
        self.assertTrue(all(e['status'] == 'no-record' for e in m['schools'].values()))
        self.assertEqual(json.loads(files['renai.json'])['providers'], [])
        m, files, count = prepare(FakeClient(lambda path, _: [] if path == '/dish' else None))
        self.assertEqual(count, 0)
        self.assertFalse(files)
        self.assertTrue(all(e['status'] == 'partial' for e in m['schools'].values()))

    def test_empty_and_unregistered_ingredients_are_explicit_not_connection_errors(self):
        for rows, expected in [([], 'not-registered'), ([{**ingredient(), 'StockDate': None}], 'not-registered'),
                               ([ingredient(), {**ingredient(), 'IngredientBatchId': '104', 'StockDate': None}], 'partial')]:
            with self.subTest(expected=expected):
                _, files, count = prepare(FakeClient(lambda path, _: rows if path == '/ingredient' else None))
                self.assertEqual(count, 2)
                d = json.loads(files['renai.json'])['providers'][0]['dishes'][0]
                self.assertEqual(d['ingredientStatus'], expected)

    def test_foreign_school_date_meal_type_batch_kitchen_and_ingredient_are_rejected(self):
        cases = [('/offered/meal', 'SchoolId', 1), ('/offered/meal', 'MenuDate', '2026/11/16'),
                 ('/offered/meal', 'MenuType', 2), ('/dish', 'BatchDataId', '999'),
                 ('/dish', 'KitchenId', 999), ('/ingredient', 'BatchDataId', '999'),
                 ('/ingredient', 'DishId', '999')]
        for route, key, value in cases:
            def handler(path, params):
                if path != route:
                    return None
                school = next(s for s in SCHOOLS.values() if s['schoolId'] == params.get('SchoolId', '333605'))
                row = meal(school) if path == '/offered/meal' else dish() if path == '/dish' else ingredient()
                return [{**row, key: value}]
            with self.subTest(route=route, key=key):
                manifest, files, count = prepare(FakeClient(handler))
                self.assertEqual(count, 0)
                self.assertFalse(files)
                self.assertTrue(all(e['errors'] for e in manifest['schools'].values()))

    def test_partial_school_update_keeps_previous_snapshot_and_original_date(self):
        previous, old, _ = prepare(day='2026-11-16', now=NOW - timedelta(days=1))
        def handler(path, params):
            if path == '/offered/meal' and params['SchoolId'] == SCHOOLS['renai']['schoolId']:
                return fail(path, params)
        manifest, files, count = prepare(FakeClient(handler), previous, old)
        self.assertEqual(count, 1)
        self.assertEqual(files['renai.json'], old['renai.json'])
        self.assertEqual(manifest['schools']['renai']['status'], 'error')
        self.assertEqual(manifest['schools']['renai']['snapshot']['mealDate'], '2026-11-16')
        self.assertEqual(manifest['schools']['renai']['lastSuccessAt'], (NOW - timedelta(days=1)).isoformat())
        self.assertEqual(json.loads(files['boai.json'])['mealDate'], DAY)

    def test_ingredient_failure_does_not_replace_complete_school_or_advance_success_time(self):
        previous, old, _ = prepare(now=NOW - timedelta(hours=1))
        client = FakeClient(lambda path, params: fail(path, params) if path == '/ingredient' else None)
        manifest, files, count = prepare(client, previous, old)
        self.assertEqual(count, 0)
        self.assertEqual(files, old)
        self.assertEqual(manifest['schools']['renai']['status'], 'partial')
        error = manifest['schools']['renai']['errors'][0]
        self.assertEqual((error['scope'], error['providerName'], error['dishName']), ('ingredient', '供餐商 12', '(素)蔬菜飯'))

    def test_repeated_empty_response_cannot_erase_known_same_day_menu(self):
        previous, old, _ = prepare(now=NOW - timedelta(hours=1))
        client = FakeClient(lambda path, _: [] if path == '/offered/meal' else None)
        first, files, count = prepare(client, previous, old)
        self.assertEqual(count, 0)
        second, files2, _ = prepare(client, first, files, now=NOW + timedelta(hours=1))
        self.assertEqual(files2, old)
        self.assertEqual(second['schools']['renai']['errors'][0]['code'], 'unexpected-empty')

    def test_previous_snapshot_tampering_and_regressive_updates_are_rejected(self):
        previous, old, _ = prepare()
        damaged = {**old, 'renai.json': old['renai.json'] + b' '}
        with self.assertRaisesRegex(contract.LunchError, 'hash'):
            prepare(previous=previous, files=damaged, now=NOW + timedelta(hours=1))
        with self.assertRaisesRegex(contract.LunchError, 'older query'):
            prepare(previous=previous, files=old, day='2026-11-16', now=NOW + timedelta(hours=1))
        with self.assertRaisesRegex(contract.LunchError, 'precedes'):
            prepare(previous=previous, files=old, now=NOW - timedelta(hours=1))

    def test_output_validation_rejects_bad_paths_foreign_photo_and_bad_timestamps(self):
        manifest, files, _ = prepare()
        changed = copy.deepcopy(manifest)
        changed['schools']['renai']['snapshot']['path'] = '../secret.json'
        with self.assertRaises(contract.LunchError):
            contract.validate_bundle(SCHOOLS, changed, files)
        snapshot = json.loads(files['renai.json'])
        for key, value in [('photoUrl', 'javascript:bad()'), ('updatedAt', '2026-11-17T10:00:00')]:
            candidate = copy.deepcopy(snapshot)
            candidate['providers'][0]['dishes'][0][key] = value
            with self.assertRaises(contract.LunchError):
                contract.validate_snapshot(candidate, 'renai', SCHOOLS['renai'])

    def test_publish_is_idempotent_validates_before_writing_and_rolls_back_failure(self):
        manifest, files, _ = prepare()
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            lunch.publish(SCHOOLS, manifest, files, directory)
            before = {p.name: p.read_bytes() for p in directory.iterdir()}
            lunch.publish(SCHOOLS, manifest, files, directory)
            self.assertEqual({p.name: p.read_bytes() for p in directory.iterdir()}, before)
            next_manifest, next_files, _ = prepare(now=NOW + timedelta(hours=1))
            replace = lunch.os.replace
            def fail_manifest(source, target):
                if Path(source).name == 'status.json':
                    raise OSError('disk error')
                return replace(source, target)
            with patch.object(lunch.os, 'replace', side_effect=fail_manifest), self.assertRaises(OSError):
                lunch.publish(SCHOOLS, next_manifest, next_files, directory)
            self.assertEqual({p.name: p.read_bytes() for p in directory.iterdir()}, before)
            with self.assertRaises(contract.LunchError):
                lunch.publish(SCHOOLS, manifest, {**files, 'renai.json': b'{}'}, directory)
            self.assertEqual({p.name: p.read_bytes() for p in directory.iterdir()}, before)
            loaded, actual = contract.read_bundle(directory, SCHOOLS)
            self.assertEqual((loaded, actual), (manifest, files))

    def test_all_failure_cli_writes_diagnostics_without_changing_public_files(self):
        previous, old, _ = prepare(now=NOW - timedelta(hours=1))
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / 'public'
            report = Path(temp) / 'attempt.json'
            lunch.publish(SCHOOLS, previous, old, output)
            before = {p.name: p.read_bytes() for p in output.iterdir()}
            with patch.object(lunch, 'load_settings', return_value=SCHOOLS), \
                    patch.object(lunch, 'OfficialClient', return_value=FakeClient(fail)), \
                    patch.object(lunch, 'datetime', wraps=datetime) as clock, \
                    patch('sys.stdout', new_callable=io.StringIO):
                clock.now.return_value = NOW
                result = lunch.main(['--date', DAY, '--output', str(output), '--report', str(report)])
            self.assertEqual(result, 1)
            self.assertEqual({p.name: p.read_bytes() for p in output.iterdir()}, before)
            self.assertTrue(all(s['status'] == 'error' for s in json.loads(report.read_text())['schools'].values()))


class Response(io.BytesIO):
    def __init__(self, raw=b'{"result":1,"data":[]}', mime='application/json', path='/dish'):
        super().__init__(raw)
        self.headers = Message()
        self.headers['Content-Type'] = mime
        self.url = contract.BASE_URL + path

    def geturl(self):
        return self.url


class LunchTransportTests(unittest.TestCase):
    def test_timeout_and_transient_http_retry_once_but_invalid_json_and_403_do_not(self):
        for first in [TimeoutError(), urllib.error.HTTPError('url', 503, 'unavailable', {}, io.BytesIO())]:
            with self.subTest(error=first):
                calls, sleeps = [], []
                def opener(request, timeout):
                    calls.append((request, timeout))
                    if len(calls) == 1:
                        raise first
                    return Response()
                self.assertEqual(lunch.OfficialClient(opener, sleeps.append, interval=0).get('/dish', {}), [])
                self.assertEqual(len(calls), 2)
                self.assertEqual(sleeps, [1])
                self.assertEqual(calls[0][1], 15)
                self.assertIn('school-news', calls[0][0].get_header('User-agent'))
        for bad in [Response(b'not json'), Response(mime='text/html')]:
            opener = unittest.mock.Mock(return_value=bad)
            with self.assertRaises(contract.LunchError):
                lunch.OfficialClient(opener, interval=0).get('/dish', {})
            self.assertEqual(opener.call_count, 1)
        opener = unittest.mock.Mock(side_effect=urllib.error.HTTPError('url', 403, 'forbidden', {}, io.BytesIO()))
        with self.assertRaisesRegex(contract.LunchError, '403'):
            lunch.OfficialClient(opener, interval=0).get('/dish', {})
        self.assertEqual(opener.call_count, 1)

    def test_repeated_connection_failure_is_bounded_and_oversize_is_rejected(self):
        opener = unittest.mock.Mock(side_effect=TimeoutError())
        with self.assertRaises(contract.LunchError):
            lunch.OfficialClient(opener, lambda _: None, interval=0).get('/dish', {})
        self.assertEqual(opener.call_count, 2)
        with self.assertRaisesRegex(contract.LunchError, 'size limit'):
            lunch.OfficialClient(lambda *a, **kw: Response(b' ' * (lunch.MAX_RESPONSE_BYTES + 1)), interval=0).get('/dish', {})

    def test_service_errors_and_wrong_record_containers_are_not_valid_empty_data(self):
        for value in [{'result': 0, 'data': []}, {'result': True, 'data': []},
                      {'result': 1}, {'result': 1, 'data': {}}, {'result': 1, 'data': [None]}]:
            with self.subTest(value=value), self.assertRaises(contract.LunchError):
                lunch.envelope(value)

    def test_request_spacing_and_total_request_budget_are_enforced(self):
        sleeps = []
        client = lunch.OfficialClient(lambda *a, **kw: Response(), sleeps.append,
                                      clock=lambda: 0, interval=0.25, max_requests=2)
        client.get('/dish', {})
        client.get('/dish', {})
        self.assertEqual(sleeps, [0.25])
        with self.assertRaisesRegex(contract.LunchError, 'request limit'):
            client.get('/dish', {})
        self.assertEqual(client.request_count, 2)

    def test_query_day_uses_taiwan_date_across_utc_midnight_boundary(self):
        self.assertEqual(lunch.taipei_day(datetime(2026, 11, 16, 18, tzinfo=timezone.utc)).isoformat(), DAY)


if __name__ == '__main__':
    unittest.main()
