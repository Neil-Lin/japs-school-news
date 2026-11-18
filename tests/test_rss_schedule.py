import copy
from contextlib import redirect_stdout
from datetime import datetime, timedelta, timezone
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from rss_schedule import assess, coverage, gate, latest_slot, scheduled_slot, watchdog_slot, SCHEDULES
import rss_schedule


def at(value):
    return datetime.fromisoformat(value + '+08:00')


def snapshot(checked='2026-11-18T16:31:00'):
    return {'updatedAt': at(checked).isoformat(), 'dataVersion': 'a' * 64,
            'sourceStatus': [{'id': 'renai', 'status': 'ok', 'lastSuccessfulAt': at(checked).isoformat()}]}


def run(expression='30 8 * * *', created='2026-11-18T16:30:00', event='schedule'):
    return {'id': 123, 'event': event, 'head_branch': 'main', 'display_title': 'RSS · schedule · ' + expression,
            'created_at': at(created).isoformat(), 'status': 'completed', 'conclusion': 'success'}


class ScheduleTests(unittest.TestCase):
    def test_latest_slot_handles_morning_boundary_overnight_and_utc(self):
        self.assertEqual(latest_slot(at('2026-11-18T09:00:00')), at('2026-11-17T16:30:00'))
        self.assertEqual(latest_slot(at('2026-11-18T10:30:00')), at('2026-11-18T10:30:00'))
        self.assertEqual(latest_slot(at('2026-11-18T16:29:59')), at('2026-11-18T10:30:00'))
        self.assertEqual(latest_slot(at('2026-11-18T16:30:00').astimezone(timezone.utc)), at('2026-11-18T16:30:00'))

    def test_delayed_primary_and_fallback_map_to_the_same_expected_slot(self):
        for expression in ('30 8 * * *', '40 9 * * *'):
            self.assertEqual(scheduled_slot(expression, at('2026-11-18T19:00:00'))[0], at('2026-11-18T16:30:00'))
            self.assertEqual(scheduled_slot(expression, at('2026-11-19T01:00:00'))[0], at('2026-11-18T16:30:00'))
        self.assertEqual(set(SCHEDULES), {'30 2 * * *', '30 8 * * *', '40 3 * * *', '40 9 * * *'})

    def test_late_watchdog_still_checks_its_intended_slot(self):
        now = at('2026-11-18T19:00:00')
        morning = watchdog_slot('13 4 * * *', now)
        self.assertEqual(morning, at('2026-11-18T10:30:00'))
        self.assertEqual(watchdog_slot('13 10 * * *', now), at('2026-11-18T16:30:00'))
        self.assertEqual(watchdog_slot('', now), at('2026-11-18T16:30:00'))
        self.assertEqual(watchdog_slot('13 4 * * *', at('2026-11-19T01:00:00')), morning)
        report = assess(snapshot(), snapshot(), [run()], now, slot=morning)
        self.assertIn('primary-run-missing', report['errors'])
        self.assertEqual(report['primarySchedule'], '30 2 * * *')

    def test_fallback_reads_missing_slot_but_skips_after_primary_or_manual_success(self):
        now = at('2026-11-18T17:40:00')
        old = snapshot('2026-11-18T11:55:00')
        self.assertTrue(gate(old, 'schedule', '40 9 * * *', 'manual', now)['runUpdate'])
        fresh = snapshot()
        before = copy.deepcopy(fresh)
        self.assertFalse(gate(fresh, 'schedule', '40 9 * * *', 'manual', now)['runUpdate'])
        self.assertFalse(gate(fresh, 'workflow_dispatch', '', 'fallback-check', now)['runUpdate'])
        self.assertEqual(fresh, before)

    def test_late_primary_skips_after_backup_and_partial_failure_still_gets_backup(self):
        now = at('2026-11-18T19:00:00')
        fresh = snapshot('2026-11-18T17:41:00')
        self.assertFalse(gate(fresh, 'schedule', '30 8 * * *', 'manual', now)['runUpdate'])
        fresh['sourceStatus'][0]['status'] = 'error'
        fresh['sourceStatus'][0]['lastSuccessfulAt'] = at('2026-11-18T10:31:00').isoformat()
        self.assertTrue(gate(fresh, 'schedule', '40 9 * * *', 'manual', now)['runUpdate'])

    def test_explicit_manual_run_remains_a_manual_read_and_unknown_inputs_fail(self):
        now = at('2026-11-18T19:00:00')
        result = gate(snapshot(), 'workflow_dispatch', '', 'manual', now)
        self.assertTrue(result['runUpdate'])
        self.assertEqual(result['kind'], 'manual')
        for event, expression, mode in [('push', '', 'manual'), ('schedule', '* * * * *', 'manual'), ('workflow_dispatch', '', 'unknown')]:
            with self.assertRaises(ValueError):
                gate(snapshot(), event, expression, mode, now)

    def test_no_primary_is_not_hidden_by_manual_success(self):
        report = assess(snapshot(), snapshot(), [run(event='workflow_dispatch')], at('2026-11-18T18:13:00'))
        self.assertEqual(report['errors'], ['primary-run-missing'])
        self.assertTrue(report['committed']['covered'])
        self.assertEqual(report['primaryRuns'], [])

    def test_grace_period_and_late_native_success_are_reported_without_guessing(self):
        old = snapshot('2026-11-18T11:55:00')
        self.assertEqual(assess(old, old, [], at('2026-11-18T17:59:59'))['errors'], [])
        self.assertIn('sources-overdue', assess(old, old, [], at('2026-11-18T18:00:00'))['errors'])
        current = snapshot('2026-11-18T18:25:00')
        late = run(created='2026-11-18T18:25:00')
        report = assess(current, current, [late], at('2026-11-18T19:00:00'))
        self.assertEqual(report['errors'], [])
        self.assertEqual(report['primaryRuns'][0]['created_at'], late['created_at'])

    def test_legacy_runs_are_marked_unattributed_instead_of_claiming_a_primary_slot(self):
        current = snapshot('2026-11-18T18:25:00')
        legacy = {**run(created='2026-11-18T18:25:00'), 'display_title': 'Update RSS data'}
        report = assess(current, current, [legacy], at('2026-11-18T19:00:00'))
        self.assertEqual(report['unattributedLegacyScheduledRuns'], [123])
        self.assertEqual(report['primaryRuns'], [])
        self.assertEqual(report['errors'], [])

    def test_publishing_gets_twenty_minutes_then_alerts_and_newer_public_data_is_valid(self):
        old, new = snapshot('2026-11-18T11:55:00'), snapshot('2026-11-18T18:01:00')
        self.assertNotIn('public-version-mismatch', assess(new, old, [run()], at('2026-11-18T18:10:00'))['errors'])
        report = assess(new, old, [run()], at('2026-11-18T18:21:00'))
        self.assertIn('public-version-mismatch', report['errors'])
        self.assertIn('public-data-overdue', report['errors'])
        self.assertEqual(assess(old, new, [run()], at('2026-11-18T18:21:00'))['errors'], [])

    def test_equal_timestamp_with_different_data_is_a_version_mismatch(self):
        other = {**snapshot(), 'dataVersion': 'b' * 64}
        self.assertIn('public-version-mismatch', assess(snapshot(), other, [run()], at('2026-11-18T18:13:00'))['errors'])

    def test_invalid_missing_and_future_dates_cannot_suppress_a_source_read(self):
        for item in [{'updatedAt': 'invalid', 'sourceStatus': []}, {'updatedAt': at('2026-11-19T10:30:00').isoformat(), 'sourceStatus': []}, {**snapshot(), 'sourceStatus': []}]:
            with self.assertRaises(ValueError):
                coverage(item, at('2026-11-18T16:30:00'), at('2026-11-18T18:00:00'))

    def test_watchdog_failure_leaves_a_report_without_changing_the_snapshot(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'data').mkdir()
            path = root / 'data/version.json'
            old = snapshot('2026-11-18T11:55:00')
            path.write_text(json.dumps(old))
            before = path.read_bytes()
            with patch.object(rss_schedule, 'ROOT', root), patch.dict('os.environ', {'GITHUB_REPOSITORY': 'Neil-Lin/japs-school-news'}, clear=True), patch.object(rss_schedule, 'get_json', side_effect=[{'workflow_runs': []}, old]) as fetch, redirect_stdout(io.StringIO()):
                with self.assertRaises(SystemExit):
                    rss_schedule.main(['--watchdog'], now=at('2026-11-18T18:13:00'))
            report = json.loads((root / 'reports/rss-watchdog.json').read_text())
            self.assertIn('primary-run-missing', report['errors'])
            self.assertIn('sources-overdue', report['errors'])
            self.assertEqual(path.read_bytes(), before)
            self.assertEqual(fetch.call_count, 2)

    def test_check_unavailable_fails_visibly_with_an_artifact(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'data').mkdir()
            (root / 'data/version.json').write_text(json.dumps(snapshot()))
            with patch.object(rss_schedule, 'ROOT', root), patch.dict('os.environ', {'GITHUB_REPOSITORY': 'Neil-Lin/japs-school-news'}, clear=True), patch.object(rss_schedule, 'get_json', side_effect=OSError('API unavailable')), redirect_stdout(io.StringIO()):
                with self.assertRaises(SystemExit):
                    rss_schedule.main(['--watchdog'], now=at('2026-11-18T18:13:00'))
            report = json.loads((root / 'reports/rss-watchdog.json').read_text())
            self.assertEqual(report['errors'], ['check-unavailable'])

    def test_credentials_are_never_sent_to_public_or_redirect_targets(self):
        with self.assertRaises(ValueError):
            rss_schedule.get_json('https://example.test/', 'secret')
        self.assertIsNone(rss_schedule.NoRedirect().redirect_request(None, None, None, None, None, None))


if __name__ == '__main__':
    unittest.main()
