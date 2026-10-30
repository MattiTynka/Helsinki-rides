import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock
import test_github_raw_world as raw_tests

spec = importlib.util.spec_from_file_location('source_history_test', Path(__file__).resolve().parents[1] / 'audit-source-history.py')
history = importlib.util.module_from_spec(spec)
spec.loader.exec_module(history)
git = raw_tests.prepare.git


class SourceHistoryTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name) / 'source.git'
        subprocess.run(['git', 'init', '--bare', '--object-format=sha1', str(self.repo)], check=True, capture_output=True)
        tree = git(self.repo, 'hash-object', '-t', 'tree', '-w', '--stdin', data=b'').decode().strip()
        def commit(parent, stamp):
            data = (f'tree {tree}\n' + (f'parent {parent}\n' if parent else '') +
                    f'author Test <> {stamp} +0000\ncommitter Test <> {stamp} +0000\n\nFixture\n').encode()
            return git(self.repo, 'hash-object', '-t', 'commit', '-w', '--stdin', data=data).decode().strip()
        self.first = commit(None, 1)
        self.head = commit(self.first, 2)
        git(self.repo, 'update-ref', 'refs/heads/main', self.head)
        git(self.repo, 'symbolic-ref', 'HEAD', 'refs/heads/main')

    def test_audits_exact_full_source_ancestry_and_records_refs(self):
        with mock.patch.object(history.source, 'audit', return_value={'status': 'PASS', 'inventory': []}) as audited:
            result = history.audit(self.repo, self.head)
        audited.assert_called_once_with(self.repo, include_git=True, images=True)
        self.assertEqual(result['selectedAncestorCount'], 2)
        self.assertEqual(result['auditedRefs'], ['refs/heads/main ' + self.head])

    def test_wrong_commit_and_asset_ref_are_rejected_before_audit(self):
        with mock.patch.object(history.source, 'audit') as audited:
            with self.assertRaisesRegex(ValueError, 'selected commit'):
                history.audit(self.repo, self.first)
            git(self.repo, 'update-ref', 'refs/heads/world-assets', self.first)
            with self.assertRaisesRegex(ValueError, 'unrelated ref'):
                history.audit(self.repo, self.head)
            audited.assert_not_called()

    def test_real_shallow_checkout_cannot_claim_full_history(self):
        shallow = Path(self.temp.name) / 'shallow'
        subprocess.run(['git', 'clone', '--depth=1', '--single-branch', '--branch=main', self.repo.as_uri(), str(shallow)],
                       check=True, capture_output=True)
        with self.assertRaisesRegex(ValueError, 'full selected source ancestry'):
            history.audit(shallow, self.head)


if __name__ == '__main__':
    unittest.main()
