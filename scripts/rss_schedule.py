#!/usr/bin/env python3
"""Gate redundant RSS reads and report overdue data without changing public snapshots."""
import argparse
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import re
from urllib.error import HTTPError
from urllib.request import HTTPRedirectHandler, Request, build_opener

from taipei_time import TAIPEI

ROOT = Path(__file__).resolve().parents[1]
# Workflow cron (timezone: Asia/Taipei) -> trigger time, data slot, kind.
SCHEDULES = {
    '30 10 * * *': ((10, 30), (10, 30), 'primary'),
    '30 16 * * *': ((16, 30), (16, 30), 'primary'),
    '40 11 * * *': ((11, 40), (10, 30), 'fallback'),
    '40 17 * * *': ((17, 40), (16, 30), 'fallback'),
}
PRIMARY = {(10, 30): '30 10 * * *', (16, 30): '30 16 * * *'}
WATCHDOGS = {'13 12 * * *': ((12, 13), (10, 30)), '13 18 * * *': ((18, 13), (16, 30))}
GRACE = timedelta(minutes=90)
PUBLISH_GRACE = timedelta(minutes=20)


def timestamp(value):
    if not isinstance(value, str):
        raise ValueError('Missing timestamp')
    result = datetime.fromisoformat(value)
    if result.tzinfo is None:
        raise ValueError('Timestamp must contain a timezone')
    return result


def latest_slot(now):
    local = now.astimezone(TAIPEI)
    candidates = [local.replace(hour=h, minute=m, second=0, microsecond=0) for h, m in PRIMARY]
    return max(slot if slot <= local else slot - timedelta(days=1) for slot in candidates)


def slot_for_clock(trigger_time, data_time, now):
    local = now.astimezone(TAIPEI)
    trigger = local.replace(hour=trigger_time[0], minute=trigger_time[1], second=0, microsecond=0)
    if trigger > local:
        trigger -= timedelta(days=1)
    return trigger.replace(hour=data_time[0], minute=data_time[1])


def scheduled_slot(expression, now):
    trigger_time, data_time, kind = SCHEDULES[expression]
    return slot_for_clock(trigger_time, data_time, now), kind


def watchdog_slot(expression, now):
    if not expression:
        return latest_slot(now)
    if expression not in WATCHDOGS:
        raise ValueError('Unrecognized watchdog schedule')
    return slot_for_clock(*WATCHDOGS[expression], now)


def coverage(version, slot, now):
    checked = timestamp(version['updatedAt'])
    if checked > now + timedelta(minutes=5):
        raise ValueError('Snapshot timestamp is in the future')
    statuses = version.get('sourceStatus')
    if not isinstance(statuses, list) or not statuses:
        raise ValueError('Missing source status records')
    missing = []
    for source in statuses:
        success = timestamp(source['lastSuccessfulAt']) if source.get('lastSuccessfulAt') else None
        if success and success > now + timedelta(minutes=5):
            raise ValueError('Source timestamp is in the future')
        if source.get('status') == 'error' or not success or success < slot:
            missing.append(source['id'])
    return {'checkedAt': version['updatedAt'], 'covered': checked >= slot and not missing, 'missingSources': missing}


def gate(version, event, expression, mode, now):
    if event == 'schedule':
        if expression not in SCHEDULES:
            raise ValueError('Unrecognized RSS schedule')
        slot, kind = scheduled_slot(expression, now)
    elif event == 'workflow_dispatch' and mode == 'fallback-check':
        slot, kind = latest_slot(now), 'manual-fallback-check'
    elif event == 'workflow_dispatch' and mode == 'manual':
        return {'kind': 'manual', 'event': event, 'runUpdate': True, 'reason': 'Explicit manual source read; not evidence of a scheduled run.'}
    else:
        raise ValueError('Unsupported update trigger or mode')
    state = coverage(version, slot, now)
    return {'event': event, 'schedule': expression, 'kind': kind, 'slot': slot.isoformat(),
            'runUpdate': not state['covered'], **state,
            'reason': 'Slot already covered; skip redundant source requests.' if state['covered'] else 'Read sources for this slot; preserve existing publishing safeguards.'}


def assess(version, public, runs, now, slot=None):
    slot = slot or latest_slot(now)
    committed = coverage(version, slot, now)
    published = coverage(public, slot, now)
    expected_title = 'RSS · schedule · ' + PRIMARY[(slot.hour, slot.minute)]
    primary = [run for run in runs if run.get('event') == 'schedule' and run.get('head_branch') == 'main'
               and run.get('display_title') == expected_title and timestamp(run['created_at']) >= slot]
    errors, warnings, notes = [], [], []
    overdue = now >= slot + GRACE
    if overdue and not committed['covered'] and not published['covered']:
        errors.append('sources-overdue')
    if not committed['covered'] and not overdue:
        notes.append('Within the 90-minute grace period; source check may still be pending.')
    if not primary:
        notes.append('No identified primary schedule run for this slot. Fresh data alone does not prove native scheduling is on time.')
        if overdue:
            warnings.append('primary-run-missing')
    elif any(run.get('conclusion') == 'success' for run in primary):
        notes.append('An identified primary run succeeded; actual creation time is recorded separately from the planned slot.')
    else:
        notes.append('Primary schedule was observed but has not completed successfully.')
        if overdue:
            warnings.append('primary-run-incomplete')
    if primary and all(timestamp(run['created_at']) > slot + GRACE for run in primary):
        warnings.append('primary-start-delayed')
    local_time, public_time = timestamp(version['updatedAt']), timestamp(public['updatedAt'])
    same = public == version
    if public_time > local_time:
        notes.append('Public data is newer than this checkout; do not flag newer data as deployment lag.')
    elif not same and (public_time == local_time or now - local_time >= PUBLISH_GRACE):
        errors.append('public-version-mismatch')
    elif not same:
        notes.append('Publication is within the 20-minute grace period.')
    if overdue and not published['covered'] and (not committed['covered'] or now - local_time >= PUBLISH_GRACE):
        errors.append('public-data-overdue')
    status = 'error' if errors else 'warning' if warnings else 'pending' if not published['covered'] else 'ok'
    if warnings and not errors:
        notes.append('Schedule timing needs review; no current data or publication outage was detected.')
    return {'checkedAt': now.isoformat(), 'status': status, 'slot': slot.isoformat(), 'deadline': (slot + GRACE).isoformat(),
            'committed': committed, 'public': published, 'publicMatchesCheckout': same,
            'primarySchedule': PRIMARY[(slot.hour, slot.minute)],
            'primaryRuns': [{**{key: run.get(key) for key in ('id', 'created_at', 'run_started_at', 'run_attempt', 'status', 'conclusion')},
                             'creationDelayMinutes': round((timestamp(run['created_at']) - slot).total_seconds() / 60, 2)} for run in primary],
            'errors': sorted(set(errors)), 'warnings': sorted(set(warnings)), 'notes': notes}


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def get_json(url, token=None):
    headers = {'Accept': 'application/json', 'Cache-Control': 'no-cache', 'User-Agent': 'school-news-schedule-check/1.0'}
    if token:
        if not url.startswith('https://api.github.com/repos/'):
            raise ValueError('Refusing to send GitHub credentials to another host')
        headers['Authorization'] = 'Bearer ' + token
        headers['X-GitHub-Api-Version'] = '2022-11-28'
    with build_opener(NoRedirect).open(Request(url, headers=headers), timeout=20) as response:
        raw = response.read(2_000_001)
    if len(raw) > 2_000_000:
        raise ValueError('Metadata response exceeds size limit')
    return json.loads(raw)


def save(report, filename):
    path = ROOT / 'reports' / filename
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    lines = ['## RSS schedule', '', '```json', json.dumps(report, ensure_ascii=False, indent=2), '```', '']
    markdown = '\n'.join(lines)
    path.with_suffix('.md').write_text(markdown, encoding='utf-8')
    if os.environ.get('GITHUB_STEP_SUMMARY'):
        with open(os.environ['GITHUB_STEP_SUMMARY'], 'a', encoding='utf-8') as summary:
            summary.write(markdown)
    print(markdown)


def main(argv=None, now=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--gate', action='store_true')
    parser.add_argument('--watchdog', action='store_true')
    args = parser.parse_args(argv)
    if args.gate == args.watchdog:
        parser.error('Choose exactly one operation')
    now = now or datetime.now(timezone.utc)
    filename = 'rss-update-plan.json' if args.gate else 'rss-watchdog.json'
    try:
        version = json.loads((ROOT / 'data/version.json').read_text())
        if args.gate:
            report = gate(version, os.environ.get('RSS_EVENT', ''), os.environ.get('RSS_CRON', ''), os.environ.get('RSS_MODE', 'manual'), now)
            if os.environ.get('GITHUB_OUTPUT'):
                with open(os.environ['GITHUB_OUTPUT'], 'a', encoding='utf-8') as output:
                    output.write('run_update=' + str(report['runUpdate']).lower() + '\n')
        else:
            repository = os.environ.get('GITHUB_REPOSITORY', '')
            if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repository):
                raise ValueError('Missing or invalid repository')
            history = get_json(f'https://api.github.com/repos/{repository}/actions/workflows/update-feed.yml/runs?event=schedule&per_page=100', os.environ.get('GH_TOKEN'))
            if not isinstance(history.get('workflow_runs'), list):
                raise ValueError('Missing scheduled execution history')
            public = get_json('https://neil-lin.github.io/japs-school-news/data/version.json?watchdog=' + now.strftime('%Y%m%d%H%M'))
            slot = watchdog_slot(os.environ.get('RSS_WATCHDOG_CRON', ''), now)
            report = assess(version, public, history['workflow_runs'], now, slot=slot)
        save(report, filename)
        for warning in report.get('warnings', []):
            print('::warning title=RSS schedule timing::' + warning)
        if report.get('errors'):
            print('::error title=RSS schedule/data alert::' + ', '.join(report['errors']))
            raise SystemExit('RSS schedule/data alert; see rss-watchdog report. No source reads were triggered by the watchdog.')
    except (OSError, ValueError, KeyError, TypeError, HTTPError) as error:
        # Fail visibly with an artifact even when the API/public site cannot be checked.
        save({'checkedAt': now.isoformat(), 'status': 'error', 'errors': ['check-unavailable'], 'warnings': [], 'detail': str(error)}, filename)
        raise SystemExit('RSS schedule check unavailable; see report.') from error


if __name__ == '__main__':
    main()
