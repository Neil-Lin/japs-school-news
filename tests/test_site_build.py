import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import build_site as site
import lunch_contract as lunch

ROOT = Path(__file__).resolve().parents[1]


class SiteBuildTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / 'source'
        self.root.mkdir()
        for name in [*site.MODULES, 'styles.css', 'config.json', 'manifest.json', 'templates/page.html', 'templates/sw.js', *['assets/' + name for name in site.IMAGES]]:
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / name, target)

    def tearDown(self):
        self.temp.cleanup()

    def with_data(self):
        for relative in ['data/articles.json', 'data/version.json', *['data/schools/' + path.name for path in (ROOT / 'data/schools').glob('*.json')]]:
            target = self.root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / relative, target)

    def with_lunch(self):
        shutil.copyfile(ROOT / 'lunch-schools.json', self.root / 'lunch-schools.json')
        shutil.copytree(ROOT / 'data/lunch', self.root / 'data/lunch')

    def test_template_build_is_deterministic_and_check_is_read_only(self):
        first = site.build_workspace(self.root)
        self.assertEqual(site.check_workspace(self.root), [])
        before = {path.relative_to(self.root): path.read_bytes() for path in self.root.rglob('*') if path.is_file()}
        self.assertEqual(site.check_workspace(self.root), [])
        second = site.build_workspace(self.root)
        self.assertEqual(first, second)
        self.assertEqual({path.relative_to(self.root): path.read_bytes() for path in self.root.rglob('*') if path.is_file()}, before)
        self.assertEqual(len(first['metadata']['pages']), 6)

    def test_new_school_requires_only_configuration_for_page_and_offline_route(self):
        path = self.root / 'config.json'
        config = json.loads(path.read_text())
        name = '新學校<&>'
        config['schools'].append(name)
        config['schoolMeta'][name] = {'slug': 'new-school', 'site': 'https://school.test/?a=1&b=2'}
        path.write_text(json.dumps(config, ensure_ascii=False))
        plan = site.build_workspace(self.root)
        page = (self.root / 'new-school/index.html').read_text()
        self.assertIn('data-school="new-school"', page)
        self.assertIn('新學校&lt;&amp;&gt;', page)
        self.assertIn('a=1&amp;b=2', page)
        self.assertIn('"./new-school/"', (self.root / 'sw.js').read_text())
        self.assertIn('data-lunch-school-id=""', page)
        self.assertIn('aria-expanded="false" hidden', page)
        self.assertEqual(len(plan['metadata']['pages']), 7)

    def test_lunch_entries_on_every_school_page_use_their_own_official_school_id(self):
        self.with_lunch()
        site.build_workspace(self.root)
        for slug, school in lunch.load_settings(self.root).items():
            page = (self.root / slug / 'index.html').read_text()
            self.assertIn('data-lunch-school-id="' + school['schoolId'] + '"', page)
            self.assertIn('aria-controls="lunchDialog"', page)
            self.assertIn('aria-modal="true"', page)
        self.assertIn('data-lunch-school-id="333605"', (self.root / 'index.html').read_text())

    def test_dependency_change_updates_all_dependent_asset_names_and_shell(self):
        before = site.build_workspace(self.root)
        path = self.root / 'news-core.mjs'
        path.write_text(path.read_text() + '\n// changed leaf module\n')
        self.assertTrue(site.check_workspace(self.root))
        after = site.build_workspace(self.root)
        for name in ('news-core.mjs', 'school-data.mjs', 'data-client.mjs', 'app.js'):
            self.assertNotEqual(before['metadata']['assets'][name], after['metadata']['assets'][name])
        for name in ('lunch-client.mjs', 'lunch-ui.mjs'):
            self.assertEqual(before['metadata']['assets'][name], after['metadata']['assets'][name])
        self.assertNotEqual(before['metadata']['shellVersion'], after['metadata']['shellVersion'])
        self.assertEqual(site.check_workspace(self.root), [])
        for name, old in before['metadata']['assets'].items():
            if old != after['metadata']['assets'][name]:
                self.assertFalse((self.root / old).exists())

    def test_css_change_does_not_recompile_js_but_updates_pages_and_shell(self):
        before = site.build_workspace(self.root)
        path = self.root / 'styles.css'
        path.write_text(path.read_text() + '\n/* changed styles */\n')
        after = site.build_workspace(self.root)
        for name in site.MODULES:
            self.assertEqual(before['metadata']['assets'][name], after['metadata']['assets'][name])
        self.assertNotEqual(before['metadata']['assets']['styles.css'], after['metadata']['assets']['styles.css'])
        self.assertNotEqual(before['metadata']['shellVersion'], after['metadata']['shellVersion'])

    def test_data_only_changes_do_not_bust_shell_assets(self):
        before = site.plan_site(self.root)
        (self.root / 'data').mkdir()
        (self.root / 'data/version.json').write_text('{"updatedAt":"new check"}')
        after = site.plan_site(self.root)
        self.assertEqual(before, after)

    def test_cyclic_or_unknown_module_dependencies_fail_before_output(self):
        path = self.root / 'news-core.mjs'
        original = path.read_text()
        path.write_text("import './app.js';\n" + original)
        with self.assertRaisesRegex(site.BuildError, '循環'):
            site.plan_site(self.root)
        path.write_text("import './unknown.mjs';\n" + original)
        with self.assertRaisesRegex(site.BuildError, '未列入'):
            site.plan_site(self.root)

    def test_edited_generated_page_is_detected(self):
        site.build_workspace(self.root)
        path = self.root / 'renai/index.html'
        path.write_text(path.read_text().replace('搜尋公告', '手改頁面'))
        self.assertTrue(any('renai/index.html' in error for error in site.check_workspace(self.root)))

    def test_package_contains_only_public_files_and_no_repository_tools_or_symlinks(self):
        self.with_data()
        (self.root / 'private.txt').write_text('not public')
        output = Path(self.temp.name) / 'dist'
        plan = site.package_site(output, self.root)
        files = {path.relative_to(output).as_posix() for path in output.rglob('*') if path.is_file()}
        self.assertEqual(files, set(plan['metadata']['publicFiles']))
        self.assertNotIn('private.txt', files)
        self.assertFalse(any(path.startswith(('scripts/', 'tests/', '.github/', 'templates/')) for path in files))
        self.assertFalse(any(path.is_symlink() for path in output.rglob('*')))
        before = {path: (output / path).read_bytes() for path in files}
        site.package_site(output, self.root)
        self.assertEqual({path: (output / path).read_bytes() for path in files}, before)

    def test_lunch_package_includes_only_validated_public_snapshots(self):
        self.with_data()
        self.with_lunch()
        output = Path(self.temp.name) / 'dist'
        site.package_site(output, self.root)
        paths = {p.relative_to(output).as_posix() for p in output.rglob('*') if p.is_file()}
        self.assertNotIn('lunch-schools.json', paths)
        self.assertEqual({p for p in paths if p.startswith('data/lunch/')},
                         {'data/lunch/status.json', *['data/lunch/' + slug + '.json'
                          for slug in lunch.load_settings(self.root)]})
        before = {p: (output / p).read_bytes() for p in paths}
        (self.root / 'data/lunch/renai.json').write_text('{}')
        with self.assertRaisesRegex(site.BuildError, '午餐快照驗證失敗'):
            site.package_site(output, self.root)
        self.assertEqual({p: (output / p).read_bytes() for p in paths}, before)

    def test_lunch_check_metadata_updates_do_not_change_shell_or_public_file_list(self):
        self.with_lunch()
        before = site.build_workspace(self.root)
        path = self.root / 'data/lunch/status.json'
        manifest = json.loads(path.read_bytes())
        # A failed attempt keeps all content hashes and dates while updating diagnostics.
        manifest['checkedAt'] = '2099-01-01T00:00:00+00:00'
        for entry in manifest['schools'].values():
            entry['status'] = 'error'
            entry['errors'] = [{'scope': 'meal', 'code': 'connection-error', 'message': 'timeout'}]
        path.write_bytes(lunch.encode(manifest))
        after = site.plan_site(self.root)
        self.assertEqual(before['metadata'], after['metadata'])
        self.assertEqual(before['generated'], after['generated'])
        self.assertEqual(site.check_workspace(self.root), [])

    def test_invalid_school_data_does_not_replace_a_good_package(self):
        self.with_data()
        output = Path(self.temp.name) / 'dist'
        site.package_site(output, self.root)
        before = (output / 'data/schools/renai.json').read_bytes()
        (self.root / 'data/schools/renai.json').write_text('{}')
        with self.assertRaisesRegex(site.BuildError, '驗證'):
            site.package_site(output, self.root)
        self.assertEqual((output / 'data/schools/renai.json').read_bytes(), before)

    def test_unknown_output_files_and_regular_files_are_not_deleted(self):
        self.with_data()
        output = Path(self.temp.name) / 'dist'
        site.package_site(output, self.root)
        private = output / 'private.txt'
        private.write_text('keep')
        with self.assertRaisesRegex(site.BuildError, '額外'):
            site.package_site(output, self.root)
        self.assertEqual(private.read_text(), 'keep')
        file_output = Path(self.temp.name) / 'file.txt'
        file_output.write_text('keep file')
        with self.assertRaisesRegex(site.BuildError, '已是檔案'):
            site.package_site(file_output, self.root)
        self.assertEqual(file_output.read_text(), 'keep file')

    def test_package_replace_failure_restores_the_previous_directory(self):
        self.with_data()
        output = Path(self.temp.name) / 'dist'
        site.package_site(output, self.root)
        previous = (output / 'index.html').read_bytes()
        path = self.root / 'templates/page.html'
        path.write_text(path.read_text().replace('校內公告、家長資訊', '更改介紹、家長資訊'))
        real_replace = site.os.replace
        def fail_install(source, target):
            if Path(source).name == 'site' and Path(target) == output.resolve():
                raise OSError('simulated output rename failure')
            return real_replace(source, target)
        with patch.object(site.os, 'replace', side_effect=fail_install), self.assertRaises(OSError):
            site.package_site(output, self.root)
        self.assertEqual((output / 'index.html').read_bytes(), previous)

    def test_packaging_source_root_is_rejected(self):
        with self.assertRaisesRegex(site.BuildError, '原始碼'):
            site.package_site(self.root, self.root)


if __name__ == '__main__':
    unittest.main()
