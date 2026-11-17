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

    def test_rss_workflow_only_updates_data_and_keeps_taiwan_schedule(self):
        rss = self.workflows['update-feed.yml']
        self.assertEqual({item['cron'] for item in rss['on']['schedule']}, {'30 2 * * *', '30 8 * * *'})
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

    def test_deploy_accepts_main_push_or_successful_same_repository_rss_completion(self):
        deploy = self.workflows['deploy.yml']
        self.assertEqual(deploy['on']['push']['branches'], ['main'])
        trigger = deploy['on']['workflow_run']
        self.assertEqual(trigger['workflows'], [self.workflows['update-feed.yml']['name']])
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
        self.assertEqual(set(self.workflows), {'ci.yml', 'deploy.yml', 'update-feed.yml'})
        for workflow in self.workflows.values():
            for job in workflow['jobs'].values():
                self.assertLessEqual(job['timeout-minutes'], 20)
                if any('checkout' in step.get('uses', '') for step in job['steps']):
                    self.assertTrue(any(step.get('uses') == './.github/actions/setup' for step in job['steps']))


if __name__ == '__main__':
    unittest.main()
