import json
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(shutil.which('ruby'), 'Optional workflow YAML parsing requires the system Ruby/Psych parser')
class WorkflowContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.workflows = {}
        for path in sorted((ROOT / '.github/workflows').glob('*.yml')):
            result = subprocess.run(['ruby', '-rjson', '-ryaml', '-e', 'puts JSON.generate(YAML.load_file(ARGV[0]))', str(path)], capture_output=True, text=True, check=True)
            cls.workflows[path.name] = json.loads(result.stdout)

    def test_pull_requests_have_readonly_checks_and_build_no_deploy(self):
        ci = self.workflows['ci.yml']
        self.assertIn('pull_request', ci['on'])
        self.assertEqual(ci['permissions'], {'contents': 'read'})
        steps = ci['jobs']['checks']['steps']
        self.assertTrue(any(step.get('run') == 'python scripts/check_project.py' for step in steps))
        self.assertTrue(any(step.get('run') == 'python scripts/build_site.py --output dist' for step in steps))
        self.assertFalse(any('deploy-pages' in step.get('uses', '') for step in steps))
        self.assertFalse(steps[0]['with']['persist-credentials'])

    def test_pull_requests_compare_screenshots_without_blocking(self):
        job = self.workflows['ci.yml']['jobs']['visual']
        self.assertEqual(job['if'], "github.event_name == 'pull_request'")
        self.assertFalse(job['steps'][0]['with']['persist-credentials'])
        commands = '\n'.join(step.get('run', '') for step in job['steps'])
        self.assertIn('node tests/visual/capture.mjs reports/visual/head', commands)
        self.assertIn('cp -R data ../visual-base/data', commands)
        report = next(step for step in job['steps'] if 'tests/visual/compare.mjs' in step.get('run', ''))
        self.assertNotIn('--strict', report['run'])
        self.assertTrue(any('upload-artifact' in step.get('uses', '') and step.get('if') == 'always()' for step in job['steps']))

    def test_rss_workflow_only_updates_data_and_keeps_taiwan_schedule(self):
        rss = self.workflows['update-feed.yml']
        self.assertEqual({item['cron'] for item in rss['on']['schedule']}, {'30 10 * * *', '30 16 * * *', '40 11 * * *', '40 17 * * *'})
        self.assertNotIn('push', rss['on'])
        self.assertEqual(rss['permissions'], {'contents': 'write'})
        self.assertEqual(rss['jobs']['update']['if'], "github.ref == 'refs/heads/main'")
        steps = rss['jobs']['update']['steps']
        self.assertEqual(steps[0]['with']['ref'], 'main')
        commands = '\n'.join(step.get('run', '') for step in steps)
        self.assertIn('python scripts/update_feed.py', commands)
        self.assertIn('git add data/articles.json data/version.json data/schools', commands)
        self.assertIn('git push origin HEAD:main', commands)
        self.assertNotIn('--force', commands)
        self.assertFalse(any('pages' in step.get('uses', '') for step in steps))
        plan = next(step for step in steps if step.get('id') == 'plan')
        self.assertEqual(plan['env']['RSS_CRON'], '${{ github.event.schedule }}')
        guarded = [step for step in steps if step.get('name') in ('Fetch RSS and publish a validated snapshot', 'Validate the new snapshot and school artifacts', 'Save only generated data')]
        self.assertEqual(len(guarded), 3)
        self.assertTrue(all(step['if'] == "steps.plan.outputs.run_update == 'true'" for step in guarded))
        # rss_schedule.py identifies primary runs only by this title prefix.
        self.assertTrue(rss['run-name'].startswith('RSS · ${{ github.event_name }} · ${{ github.event.schedule'))
        self.assertIn('github.event_name', rss['run-name'])
        self.assertIn('github.event.schedule', rss['run-name'])

    def test_deploy_accepts_main_push_or_successful_same_repository_rss_completion(self):
        deploy = self.workflows['deploy.yml']
        self.assertEqual(deploy['on']['push']['branches'], ['main'])
        trigger = deploy['on']['workflow_run']
        self.assertEqual(trigger['workflows'], [self.workflows['update-feed.yml']['name'], self.workflows['update-lunch.yml']['name']])
        self.assertEqual(trigger['types'], ['completed'])
        self.assertEqual(trigger['branches'], ['main'])
        build = deploy['jobs']['build']
        self.assertIn("conclusion == 'success'", build['if'])
        self.assertIn('head_repository.full_name == github.repository', build['if'])
        self.assertEqual(build['steps'][0]['with']['ref'], 'main')
        self.assertFalse(build['steps'][0]['with']['persist-credentials'])
        steps = build['steps']
        self.assertFalse(any('update_feed.py' in step.get('run', '') for step in steps))
        upload = next(step for step in steps if 'upload-pages-artifact' in step.get('uses', ''))
        self.assertEqual(upload['with']['path'], 'dist')
        self.assertEqual(deploy['jobs']['deploy']['needs'], 'build')
        self.assertEqual(deploy['jobs']['deploy']['permissions'], {'contents': 'read', 'pages': 'write', 'id-token': 'write'})
        self.assertNotIn('pages', deploy['permissions'])

    def test_every_workflow_uses_shared_runtimes_and_explicit_timeouts(self):
        self.assertEqual(set(self.workflows), {'ci.yml', 'deploy.yml', 'update-feed.yml', 'update-lunch.yml', 'maintenance.yml', 'rss-watchdog.yml'})
        for workflow in self.workflows.values():
            for job in workflow['jobs'].values():
                self.assertLessEqual(job['timeout-minutes'], 20)
                if any('checkout' in step.get('uses', '') for step in job['steps']):
                    self.assertTrue(any(step.get('uses') == './.github/actions/setup' for step in job['steps']))

    def test_lunch_starts_manual_only_and_cannot_publish_rss_or_force_push(self):
        workflow = self.workflows['update-lunch.yml']
        self.assertEqual(set(workflow['on']), {'workflow_dispatch'})
        self.assertEqual(workflow['permissions'], {'contents': 'write'})
        self.assertEqual(workflow['jobs']['update']['if'], "github.ref == 'refs/heads/main'")
        steps = workflow['jobs']['update']['steps']
        self.assertEqual(steps[0]['with']['ref'], 'main')
        commands = '\n'.join(step.get('run', '') for step in steps)
        self.assertIn('python scripts/update_lunch.py', commands)
        self.assertIn('git add data/lunch assets-manifest.json', commands)
        self.assertIn('git push origin HEAD:main', commands)
        self.assertNotIn('--force', commands)
        self.assertNotIn('update_feed.py', commands)
        self.assertNotIn('data/articles.json', commands)
        self.assertFalse(any('pages' in step.get('uses', '') for step in steps))
        diagnostics = next(step for step in steps if 'upload-artifact' in step.get('uses', ''))
        self.assertEqual(diagnostics['if'], 'always()')

    def test_maintenance_is_readonly_and_deployment_verifies_the_exact_build(self):
        maintenance = self.workflows['maintenance.yml']
        self.assertEqual(maintenance['permissions'], {'contents': 'read'})
        self.assertEqual({s['cron'] for s in maintenance['on']['schedule']}, {'15 8 * * *', '45 8 * * 1'})
        for job in maintenance['jobs'].values():
            commands = '\n'.join(s.get('run', '') for s in job['steps'])
            self.assertNotIn('git push', commands)
            self.assertNotIn('update_lunch.py', commands)
        deploy = self.workflows['deploy.yml']
        self.assertEqual(deploy['jobs']['verify']['needs'], ['build', 'deploy'])
        self.assertEqual(deploy['jobs']['verify']['steps'][0]['with']['ref'], '${{ needs.build.outputs.source_sha }}')
        self.assertTrue(any('verify_deployment.py --expected' in s.get('run', '') for s in deploy['jobs']['verify']['steps']))
        self.assertTrue(any(s.get('run') == 'npm run test:browser' for s in self.workflows['ci.yml']['jobs']['browsers']['steps']))

    def test_watchdog_checks_twice_daily_with_readonly_permissions_and_no_recovery_loop(self):
        watcher = self.workflows['rss-watchdog.yml']
        self.assertEqual(set(watcher['on']), {'schedule', 'workflow_dispatch'})
        self.assertEqual({s['cron'] for s in watcher['on']['schedule']}, {'13 12 * * *', '13 18 * * *'})
        self.assertEqual(watcher['permissions'], {'contents': 'read'})
        job = watcher['jobs']['check']
        self.assertEqual(job['if'], "github.ref == 'refs/heads/main'")
        self.assertEqual(job['permissions'], {'contents': 'read', 'actions': 'read'})
        self.assertEqual(job['steps'][0]['with']['ref'], 'main')
        self.assertFalse(job['steps'][0]['with']['persist-credentials'])
        commands = '\n'.join(step.get('run', '') for step in job['steps'])
        self.assertIn('python scripts/rss_schedule.py --watchdog', commands)
        self.assertNotIn('update_feed.py', commands)
        self.assertNotIn('git push', commands)
        self.assertNotIn('continue-on-error', next(step for step in job['steps'] if step.get('run') == 'python scripts/rss_schedule.py --watchdog'))
        self.assertEqual(job['steps'][-1]['if'], 'always()')

    def test_all_schedules_declare_taipei_timezone_and_match_the_guard_policy(self):
        import sys
        sys.path.insert(0, str(ROOT / 'scripts'))
        from rss_schedule import SCHEDULES, WATCHDOGS
        for workflow in self.workflows.values():
            for schedule in workflow['on'].get('schedule', []):
                self.assertEqual(schedule['timezone'], 'Asia/Taipei')
        for schedule in self.workflows['update-feed.yml']['on']['schedule']:
            minute, hour, *_ = schedule['cron'].split()
            self.assertEqual(SCHEDULES[schedule['cron']][0], (int(hour), int(minute)))
        for schedule in self.workflows['rss-watchdog.yml']['on']['schedule']:
            minute, hour, *_ = schedule['cron'].split()
            self.assertEqual(WATCHDOGS[schedule['cron']][0], (int(hour), int(minute)))

    def test_schedule_guards_accept_only_crons_the_workflows_declare(self):
        import re
        import sys
        sys.path.insert(0, str(ROOT / 'scripts'))
        from rss_schedule import SCHEDULES, WATCHDOGS
        declared = lambda name: {s['cron'] for s in self.workflows[name]['on']['schedule']}
        message = '排程判斷不得保留工作流程未宣告的 cron：舊 cron 相容碼會一直留著被照抄。切換排程後請刪除舊表示法。'
        self.assertEqual(set(SCHEDULES), declared('update-feed.yml'), message)
        self.assertEqual(set(WATCHDOGS), declared('rss-watchdog.yml'), message)
        for name, workflow in self.workflows.items():
            for job in workflow['jobs'].values():
                used = set(re.findall(r"github\.event\.schedule == '([^']+)'", job.get('if', '')))
                self.assertLessEqual(used, declared(name) if used else set(), f'{name}: {message}')


if __name__ == '__main__':
    unittest.main()
