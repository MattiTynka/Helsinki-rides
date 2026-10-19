import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import os
import subprocess

SPEC = importlib.util.spec_from_file_location('source_release', Path(__file__).resolve().parents[1] / 'source_release.py')
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)


class SourceReleaseTest(unittest.TestCase):
    def test_upload_allowlist_excludes_private_and_generated_files(self):
        for path in ['.env', '.env.production', '.agents/notes.md', '.aws/config.json',
                     'data/raw/input.json', 'models/hero.glb', 'debug.log',
                     'apps/game/public/world/current.json', 'apps/game/dist-pages/index.html',
                     'tools/node_modules/dependency/index.js', 'content/assets/facades/estates/DSC05064.jpg']:
            self.assertFalse(release.selected(path), path)
        for path in ['tools/world/build_cells.ts', '.github/workflows/source-checks.yml',
                     'packages/sim/src/character.ts', 'apps/game/public/basis/basis_transcoder.wasm']:
            self.assertTrue(release.selected(path), path)

    def test_paths_and_contact_details_are_detected_without_echoing_values(self):
        paths = ['C:' + '/' + 'Users/operator/private', 'D:' + '\\Users\\operator\\private',
                 'C:' + '\\\\Users\\\\operator\\\\private', '/' + 'home/operator/private', '/' + 'Users/operator/private']
        for value in paths:
            findings = release.scan_text('fixture.txt', 'header\n' + value)
            self.assertEqual(findings[0]['rule'], 'personal-home-path')
            self.assertEqual(findings[0]['line'], 2)
            self.assertNotIn(value, json.dumps(findings))
        address = 'person' + '@private-mail.invalid'
        self.assertEqual(release.scan_text('fixture', address)[0]['rule'], 'email')
        self.assertEqual(release.scan_text('fixture', 'demo' + '@example.org'), [])

    def test_provider_tokens_and_private_keys_are_detected(self):
        for value in ['ghp_' + 'a' * 36, 'AKIA' + 'A' * 16, '-----BEGIN ' + 'PRIVATE KEY-----']:
            result = release.scan_text('fixture', value)
            self.assertTrue(result)
            self.assertNotIn(value, json.dumps(result))

    def test_candidate_ignores_private_inputs_without_opening_them(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'README.md').write_text('portable project', encoding='utf8')
            (root / '.env').write_bytes(b'\xff\xfe\x00')
            (root / 'data').mkdir()
            (root / 'data/raw.json').write_text('excluded', encoding='utf8')
            result = release.audit(root)
            self.assertEqual(result['status'], 'PASS')
            self.assertEqual([f['path'] for f in result['inventory']], ['README.md'])

    def test_export_refuses_existing_or_outside_destination(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for destination in [root, root.parent / 'outside-release', root / 'build']:
                with self.assertRaises(ValueError):
                    release.export(root, destination)

    def test_git_history_audit_finds_removed_personal_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            environment = dict(os.environ)
            environment.update(GIT_AUTHOR_NAME=release.PUBLIC_HANDLE, GIT_COMMITTER_NAME=release.PUBLIC_HANDLE,
                               GIT_AUTHOR_EMAIL=release.PUBLIC_EMAIL, GIT_COMMITTER_EMAIL=release.PUBLIC_EMAIL)

            def git(*args):
                subprocess.run(['git', '-c', 'core.excludesFile=' + str(root / '.git/info/exclude'), '-c', 'commit.gpgsign=false',
                                '-C', str(root), *args], check=True, capture_output=True, env=environment)

            git('init', '-b', 'main')
            file = root / 'README.md'
            file.write_text('portable source\n', encoding='utf8')
            git('add', 'README.md')
            git('commit', '-m', 'Initial portable source')
            self.assertEqual(release.audit(root, include_git=True)['status'], 'PASS')
            file.write_text('/' + 'home/operator/private\n', encoding='utf8')
            git('commit', '-am', 'Synthetic history privacy regression')
            file.write_text('portable source\n', encoding='utf8')
            git('commit', '-am', 'Restore portable source')
            self.assertEqual(release.audit(root)['status'], 'PASS')
            report = release.audit(root, include_git=True)
            self.assertEqual(report['commits'], 3)
            self.assertEqual(report['status'], 'FAIL')
            self.assertTrue(any(f['rule'] == 'personal-home-path' for f in report['findings']))


if __name__ == '__main__':
    unittest.main()
