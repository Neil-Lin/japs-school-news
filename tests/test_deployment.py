import hashlib
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from verify_deployment import verify


class DeploymentTests(unittest.TestCase):
    def expected(self, content=b'current build'):
        return {'shellVersion': 'abc', 'files': {'index.html': {'bytes': len(content), 'sha256': hashlib.sha256(content).hexdigest()}}}

    def test_old_bytes_and_missing_files_are_not_successful_deployments(self):
        self.assertTrue(verify('https://example.test/', self.expected(), lambda name, limit: b'current build')[0]['ok'])
        self.assertFalse(verify('https://example.test/', self.expected(), lambda name, limit: b'previous build')[0]['ok'])
        def fail(name, limit):
            raise OSError('404')
        self.assertFalse(verify('https://example.test/', self.expected(), fail)[0]['ok'])

    def test_unsafe_expected_paths_are_rejected_before_any_request(self):
        expected = self.expected()
        expected['files']['../secrets'] = expected['files'].pop('index.html')
        def unexpected(*args):
            self.fail('Unsafe path was fetched')
        self.assertFalse(verify('https://example.test/', expected, unexpected)[0]['ok'])
        with self.assertRaises(ValueError):
            verify('http://public.test/', self.expected())
