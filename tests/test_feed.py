import copy
import json
import sys
import tempfile
import unittest
from datetime import datetime, timezone, timedelta
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import update_feed as feed
from feed_contract import make_version, validate_snapshot, validate_school_artifacts

NOW = datetime(2026, 11, 16, 12, tzinfo=timezone.utc)
S1 = {'id': 'renai-news', 'school': '仁愛國小', 'name': '一般消息', 'url': 'https://school.test/feed'}
S2 = {'id': 'boai-news', 'school': '博愛國小', 'name': '一般消息', 'url': 'https://other.test/feed'}
CONFIG = {'schoolMeta': {'仁愛國小': {'slug': 'renai'}, '博愛國小': {'slug': 'boai'}}, 'schools': ['仁愛國小', '博愛國小'], 'sources': [S1, S2], 'categoryIds': {'一般消息': 'news'}}


def article(source=S1, guid='doc-1', title='公告', date='2026-11-15T00:00:00+00:00'):
    return feed.make_article(source, title, date, 'https://school.test/article/' + guid, guid, '內文', ['計畫.pdf'])


def rss(description='正常內文', guid='doc-1'):
    return f'''<rss version="2.0"><channel><title>消息</title><item><title>公告</title><pubDate>Sun, 15 Nov 2026 08:00:00 +0800</pubDate><guid>{guid}</guid><link>https://school.test/article/{guid}</link><description>{description}</description><name>計畫.pdf</name></item></channel></rss>'''.encode()


def existing():
    return feed.build_payload(CONFIG, {'articles': []}, {S1['id']: {'items': [article()], 'warnings': []}, S2['id']: {'items': [article(S2)], 'warnings': []}}, NOW - timedelta(days=1))


class ParsingTests(unittest.TestCase):
    def test_valid_rss_and_valid_empty_are_distinct_from_html(self):
        result = feed.parse_feed(rss(), S1)
        self.assertEqual(len(result['items']), 1)
        self.assertEqual(result['items'][0]['sourceId'], S1['id'])
        self.assertEqual(result['items'][0]['published'], '2026-11-15T00:00:00+00:00')
        self.assertEqual(feed.parse_feed(b'<rss><channel/></rss>', S1)['items'], [])
        for body in [b'<html><body>temporarily unavailable</body></html>', b'<root/>', b'<rss/>', b'not xml']:
            with self.subTest(body=body), self.assertRaises(feed.FeedError):
                feed.parse_feed(body, S1)

    def test_complete_broken_xml_recovers_with_warning(self):
        result = feed.parse_feed(rss('A & B'), S1)
        self.assertEqual(len(result['items']), 1)
        self.assertTrue(result['warnings'])
        self.assertEqual(result['items'][0]['summary'], 'A & B')

    def test_description_controls_use_full_xml_parse_and_preserve_all_article_fields(self):
        body = rss('<![CDATA[<p>輔導室\x0b報到</p><p>攜帶資料\x0b辦理</p>]]>')
        expected = feed.parse_feed(body.replace(b'\x0b', b' '), S1)['items']
        with patch.object(feed, 'recover_items', side_effect=AssertionError('must use full XML validation')):
            actual = feed.parse_feed(body, S1)
        self.assertEqual(actual['items'], expected)
        self.assertEqual(actual['items'][0]['summary'], '輔導室 報到 攜帶資料 辦理')
        self.assertIn('2 個', actual['warnings'][0])
        self.assertIn('U+000B', actual['warnings'][0])

    def test_description_repair_preserves_allowed_whitespace_and_scopes_other_controls(self):
        body = rss('<![CDATA[A\tB\nC\rD\x0bE\x00F]]>').replace(b'<guid>doc-1', b'<guid>doc-\x0b1')
        repaired, warnings = feed.repair_description_controls(body)
        self.assertIn(b'A\tB\nC\rD E F', repaired)
        self.assertIn(b'<guid>doc-\x0b1', repaired)
        self.assertIn('2 個', warnings[0])
        self.assertIn('U+0000、U+000B', warnings[0])
        with self.assertRaises(feed.FeedError):
            feed.parse_feed(body, S1)

    def test_description_repair_does_not_accept_truncated_or_other_invalid_xml(self):
        body = rss('<![CDATA[A\x0bB]]>')
        for malformed in [body.replace(b'</channel></rss>', b''), body.replace('<name>計畫.pdf</name>'.encode(), b'<name>A & B</name>')]:
            with self.subTest(body=malformed), self.assertRaises(feed.FeedError):
                feed.parse_feed(malformed, S1)

    def test_multiple_description_blocks_recover_without_altering_links_or_attachments(self):
        body = rss('<![CDATA[A\x0bB]]>')
        item = body[body.index(b'<item>'):body.index(b'</item>') + len(b'</item>')]
        body = body.replace(b'</channel>', item.replace(b'doc-1', b'doc-2') + b'</channel>')
        result = feed.parse_feed(body, S1)
        expected = feed.parse_feed(body.replace(b'\x0b', b' '), S1)['items']
        self.assertEqual(result['items'], expected)
        self.assertEqual(len(result['items']), 2)
        self.assertIn('2 個', result['warnings'][0])

    def test_truncated_broken_xml_is_not_silently_partially_recovered(self):
        with self.assertRaises(feed.FeedError):
            feed.parse_feed(rss('A & B').replace(b'</channel>', b'<item><title>truncated</channel>'), S1)

    def test_bad_dates_and_urls_fail_source_instead_of_entering_snapshot(self):
        for body in [rss().replace(b'Sun, 15 Nov 2026 08:00:00 +0800', b'bad date'), rss().replace(b'https://school.test/article/doc-1', b'javascript:bad()')]:
            with self.assertRaises(feed.FeedError):
                feed.parse_feed(body, S1)
        with self.assertRaises(feed.FeedError):
            feed.date_value('2026-11-15T08:00:00')

    def test_transport_retries_once_but_parser_failure_is_not_retried(self):
        calls = []
        sleeps = []
        def transport(_source):
            calls.append(1)
            if len(calls) == 1:
                raise OSError('temporary')
            return rss()
        self.assertEqual(len(feed.fetch(S1, fetcher=transport, sleep=sleeps.append)['items']), 1)
        self.assertEqual(len(calls), 2)
        self.assertEqual(sleeps, [0.5])
        calls.clear()
        def invalid(_source):
            calls.append(1)
            return b'<html/>'
        with self.assertRaises(feed.FeedError):
            feed.fetch(S1, fetcher=invalid, sleep=sleeps.append)
        self.assertEqual(len(calls), 1)

    def test_repeated_titles_without_identity_use_date_not_title_alone(self):
        a = feed.make_article(S1, '每月公告', '2026-11-01T00:00:00+00:00', '', '', '', [])
        b = feed.make_article(S1, '每月公告', '2026-11-15T00:00:00+00:00', '', '', '', [])
        self.assertNotEqual(a['id'], b['id'])


class UpdateTests(unittest.TestCase):
    def test_consecutive_failures_accumulate_and_reset_after_recovery(self):
        results = {S1['id']: {'items': [article()]}, S2['id']: {'error': 'timeout'}}
        first = feed.build_payload(CONFIG, existing(), results, NOW)
        second = feed.build_payload(CONFIG, first, results, NOW + timedelta(hours=6))
        status = next(item for item in second['sourceStatus'] if item['id'] == S2['id'])
        self.assertEqual(status['consecutiveFailures'], 2)
        self.assertEqual(status['lastSuccessfulAt'], existing()['updatedAt'])
        results[S2['id']] = {'items': [article(S2)]}
        recovered = feed.build_payload(CONFIG, second, results, NOW + timedelta(hours=12))
        status = next(item for item in recovered['sourceStatus'] if item['id'] == S2['id'])
        self.assertEqual(status['consecutiveFailures'], 0)
        self.assertEqual(status['status'], 'ok')

    def test_partial_failure_retains_articles_and_last_success(self):
        old = existing()
        results = {S1['id']: {'items': [article(guid='new')], 'warnings': []}, S2['id']: {'error': 'timeout'}}
        data = feed.build_payload(CONFIG, old, results, NOW)
        self.assertEqual(len(data['articles']), 3)
        status = next(item for item in data['sourceStatus'] if item['id'] == S2['id'])
        self.assertEqual(status['status'], 'error')
        self.assertEqual(status['lastSuccessfulAt'], old['updatedAt'])
        self.assertEqual(status['lastAttemptAt'], NOW.isoformat())
        self.assertEqual(validate_snapshot(CONFIG, data, make_version(CONFIG, data)), [])

    def test_all_failure_does_not_return_publishable_payload(self):
        with self.assertRaises(feed.AllSourcesFailed):
            feed.build_payload(CONFIG, existing(), {S1['id']: {'error': 'bad'}, S2['id']: {'error': 'bad'}}, NOW)

    def test_empty_feed_warns_and_preserves_history_even_on_repeated_zero_runs(self):
        results = {S1['id']: {'items': [], 'warnings': []}, S2['id']: {'items': [], 'warnings': []}}
        first = feed.build_payload(CONFIG, existing(), results, NOW)
        second = feed.build_payload(CONFIG, first, results, NOW + timedelta(hours=6))
        self.assertEqual(len(second['articles']), 2)
        self.assertTrue(all(item['status'] == 'warning' for item in second['sourceStatus']))

    def test_sudden_drop_is_reported_using_last_feed_count_not_yearly_archive(self):
        old = existing()
        old['sourceStatus'][0]['lastSuccessfulItemCount'] = 100
        results = {S1['id']: {'items': [article()], 'warnings': []}, S2['id']: {'items': [article(S2)], 'warnings': []}}
        data = feed.build_payload(CONFIG, old, results, NOW)
        first = next(item for item in data['sourceStatus'] if item['id'] == old['sourceStatus'][0]['id'])
        self.assertEqual(first['status'], 'warning')

    def test_removed_source_does_not_survive_same_category_at_other_school(self):
        config = {**CONFIG, 'sources': [S2]}
        result = feed.normalize_existing(existing(), config)
        self.assertEqual(len(result), 1)
        self.assertEqual(next(iter(result.values()))['sourceId'], S2['id'])

    def test_legacy_migration_preserves_timestamps_and_all_records(self):
        legacy = existing()
        legacy.pop('schemaVersion')
        legacy.pop('lastSuccessfulAt')
        for item in legacy['articles']:
            item.pop('sourceId')
            guid = item.pop('guid')
            item['id'] = item['source'] + ':' + item['schools'][0] + ':' + guid
        for status in legacy['sourceStatus']:
            status.pop('id')
            status.pop('lastSuccessfulAt')
        data = feed.migrate_payload(CONFIG, legacy)
        self.assertEqual(data['updatedAt'], legacy['updatedAt'])
        self.assertEqual(len(data['articles']), len(legacy['articles']))
        self.assertEqual(validate_snapshot(CONFIG, data, make_version(CONFIG, data)), [])

    def test_data_version_stays_stable_when_only_check_metadata_changes(self):
        results = {S1['id']: {'items': [article()], 'warnings': []}, S2['id']: {'items': [article(S2)], 'warnings': []}}
        a = feed.build_payload(CONFIG, existing(), results, NOW)
        b = feed.build_payload(CONFIG, a, results, NOW + timedelta(hours=6))
        self.assertNotEqual(a['updatedAt'], b['updatedAt'])
        self.assertEqual(make_version(CONFIG, a)['dataVersion'], make_version(CONFIG, b)['dataVersion'])

    def test_publish_validates_before_writes_and_rolls_back_replace_failure(self):
        data = existing()
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            feed.publish(CONFIG, data, directory)
            before = {name: (directory / name).read_bytes() for name in ['articles.json', 'version.json', 'schools/renai.json', 'schools/boai.json']}
            invalid = copy.deepcopy(data)
            invalid['articles'][0]['attachments'] = [{'name': 'bad.pdf', 'url': 'javascript:bad()'}]
            with self.assertRaises(feed.FeedError):
                feed.publish(CONFIG, invalid, directory)
            self.assertEqual((directory / 'articles.json').read_bytes(), before['articles.json'])
            replacement = copy.deepcopy(data)
            replacement['updatedAt'] = NOW.isoformat()
            real_replace = feed.os.replace
            def fail_manifest(source, target):
                if str(source).endswith('/version.json'):
                    raise OSError('simulated manifest failure')
                return real_replace(source, target)
            with patch.object(feed.os, 'replace', side_effect=fail_manifest), self.assertRaises(OSError):
                feed.publish(CONFIG, replacement, directory)
            for name, value in before.items():
                self.assertEqual((directory / name).read_bytes(), value)
            self.assertFalse(list(directory.glob('.feed-stage-*')))

    def test_school_outputs_cover_all_origins_and_detect_tampering(self):
        data = existing()
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            version = feed.publish(CONFIG, data, directory)
            self.assertEqual(validate_school_artifacts(CONFIG, data, version, directory), [])
            path = directory / 'schools' / 'renai.json'
            body = json.loads(path.read_text())
            body['articles'][0]['origins'] = []
            path.write_text(json.dumps(body))
            self.assertTrue(validate_school_artifacts(CONFIG, data, version, directory))

    def test_failed_school_generation_preserves_every_published_file(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            feed.publish(CONFIG, existing(), directory)
            before = {path.relative_to(directory): path.read_bytes() for path in directory.rglob('*.json')}
            invalid_config = copy.deepcopy(CONFIG)
            invalid_config['schoolMeta']['仁愛國小']['slug'] = '../outside'
            with self.assertRaises(feed.FeedError):
                feed.publish(invalid_config, existing(), directory)
            self.assertEqual({path.relative_to(directory): path.read_bytes() for path in directory.rglob('*.json')}, before)

    def test_school_manifest_is_deterministic_and_does_not_change_raw_archive_hash(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            data = existing()
            first = feed.publish(CONFIG, data, directory)
            original = {path.relative_to(directory): path.read_bytes() for path in directory.rglob('*.json')}
            second = feed.publish(CONFIG, data, directory)
            self.assertEqual(first, second)
            self.assertEqual(first['dataVersion'], make_version(CONFIG, data)['dataVersion'])
            self.assertEqual({path.relative_to(directory): path.read_bytes() for path in directory.rglob('*.json')}, original)

    def test_retention_and_sort_use_real_dates_with_offsets(self):
        old = existing()
        old['articles'].append(article(guid='expired', date='2024-01-01T00:00:00+00:00'))
        results = {S1['id']: {'items': [article(guid='newest', date='2026-11-16T08:00:00+08:00')], 'warnings': []}, S2['id']: {'error': 'timeout'}}
        data = feed.build_payload(CONFIG, old, results, NOW)
        self.assertTrue(data['articles'][0]['id'].endswith(':newest'))
        self.assertFalse(any(item['id'].endswith(':expired') for item in data['articles']))


if __name__ == '__main__':
    unittest.main()
