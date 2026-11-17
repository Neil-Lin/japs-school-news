import copy
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from school_info import load_info, render_info
from check_school_info_sources import compare_rows
import build_site


class SchoolInfoTests(unittest.TestCase):
    def setUp(self):
        self.config = json.loads((ROOT / 'config.json').read_text())
        self.data = load_info(ROOT, self.config)

    def test_five_schools_match_official_codes_and_have_independent_provenance(self):
        self.assertEqual(set(self.data['schools']), {meta['slug'] for meta in self.config['schoolMeta'].values()})
        for slug, item in self.data['schools'].items():
            rendered = render_info(self.data, slug)
            self.assertIn(item['address'], rendered)
            self.assertIn('tel:' + item['phone'].replace('-', ''), rendered)
            self.assertIn('並非即時開放狀態', rendered)
            self.assertIn('2026/11/18', rendered)
            self.assertIn('schoolOpeningNotices', rendered)
        self.assertIn('18:30–21:30', render_info(self.data, 'renai'))
        self.assertIn('因施工未開放', render_info(self.data, 'dunhua'))
        self.assertEqual(render_info(self.data, 'unknown'), '')

    def test_source_comparison_requires_exact_school_matches_without_overwriting(self):
        records = [school['sourceRecords'] for school in self.data['schools'].values()]
        directory, campus = ([item[kind] for item in records] for kind in ('directory', 'campus'))
        self.assertEqual(compare_rows(self.data, directory, campus), [])
        changed = copy.deepcopy(campus)
        changed[0]['校園場地開放時間'] = '新的時段'
        self.assertEqual(len(compare_rows(self.data, directory, changed)), 1)
        self.assertEqual(len(compare_rows(self.data, directory + [directory[0]], campus)), 1)
        self.assertEqual(len(compare_rows(self.data, [], campus)), 5)

    def test_invalid_sources_and_school_identity_fail_before_rendering(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for mutate in [
                lambda data: data['schools']['renai'].update(website='javascript:alert(1)'),
                lambda data: data['schools']['renai']['sourceRecords']['campus'].update(校名='另一所學校'),
                lambda data: data['schools']['renai'].update(phone='not-a-phone'),
            ]:
                data = copy.deepcopy(self.data)
                mutate(data)
                (root / 'school-info.json').write_text(json.dumps(data))
                with self.assertRaises(ValueError):
                    load_info(root, self.config)

    def test_build_embeds_escaped_school_specific_info_in_offline_pages(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            files = [*build_site.MODULES, 'school-info.json', 'styles.css', 'config.json', 'manifest.json', 'templates/page.html', 'templates/sw.js', *['assets/' + name for name in build_site.ASSETS]]
            for name in files:
                target = root / name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(ROOT / name, target)
            data = copy.deepcopy(self.data)
            data['schools']['renai']['address'] = '<img src=x onerror=alert(1)>'
            (root / 'school-info.json').write_text(json.dumps(data))
            plan = build_site.build_workspace(root)
            renai = (root / 'renai/index.html').read_text()
            self.assertIn('&lt;img src=x onerror=alert(1)&gt;', renai)
            self.assertNotIn('<img src=x', renai)
            self.assertNotIn(self.data['schools']['boai']['phone'], renai)
            self.assertIn('school-info-ui.mjs', plan['metadata']['assets'])
            self.assertNotIn('school-info.json', plan['metadata']['publicFiles'])
            self.assertIn('./assets/info.svg', (root / 'sw.js').read_text())


if __name__ == '__main__':
    unittest.main()
