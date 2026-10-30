import copy
import importlib.util
import json
from pathlib import Path
import tarfile
import unittest
from unittest import mock

import test_stage_pages_world as fixtures


SPEC = importlib.util.spec_from_file_location('prepare_external_world', Path(__file__).resolve().parents[1] / 'prepare-external-world.py')
external = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(external)
pages = external.pages


class ExternalWorldTest(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.PagesWorldTest(methodName='runTest')
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        f = self.fixture
        f.manifest['cells'][0]['visual']['lod0'] = f.pin_payload('cells/c0.glb', fixtures.minimal_glb())
        f.manifest['assets'][0].update(f.pin_payload('assets/snow.glb', fixtures.minimal_glb()))
        f.build_inputs()
        self.pages_descriptor = copy.deepcopy(f.descriptor)
        f.descriptor.update(schemaVersion=2, deliveryMode='external', worldOrigin='https://assets.example.org',
                            worldBaseUrl='https://assets.example.org/world/', corsOrigin=pages.GAME_ORIGIN,
                            worldBudgetBytes=2_000_000_000, archiveBudgetBytes=1_500_000_000,
                            shellBudgetBytes=20_000_000)
        f.write_descriptor()
        self.upload = f.root / 'upload'

    def stage(self):
        f = self.fixture
        return pages.stage(f.descriptor_path, f.archive_path, f.output, 'a' * 40, self.upload)

    def extract_source(self):
        f = self.fixture
        scratch = f.root / 'source'
        scratch.mkdir()
        pages._unpack(f.archive_path, scratch, f.descriptor)
        return scratch / 'world' / f.release

    def test_external_stage_separates_shell_and_verified_upload_objects(self):
        f = self.fixture
        result = self.stage()
        self.assertEqual(result['deliveryMode'], 'external')
        self.assertEqual(result['hostingStatus'], 'LOCAL_VALIDATED_NOT_PUBLISHED')
        self.assertFalse((f.output / 'world').exists())
        self.assertEqual(result['artifactBytes'], sum(p.stat().st_size for p in f.output.rglob('*') if p.is_file()))
        inventory = json.loads((self.upload / 'upload-inventory.json').read_text())
        self.assertEqual(inventory['worldFiles'], len(f.payloads) + 1)
        self.assertEqual(inventory['requiredHeaders']['Access-Control-Allow-Origin'], pages.GAME_ORIGIN)
        self.assertIn('Content-Encoding', inventory['forbiddenHeaders'])
        compressed = next(item for item in inventory['objects'] if item['path'].endswith('.gz'))
        self.assertEqual(compressed['contentType'], 'application/gzip')
        for name, data in f.payloads.items():
            self.assertEqual((self.upload / 'world' / f.release / name).read_bytes(), data)

    def test_external_requires_explicit_fresh_separate_upload_destination(self):
        f = self.fixture
        for output in [None, f.output, f.output / 'nested', f.output.parent]:
            with self.subTest(output=output), self.assertRaises(ValueError):
                pages.stage(f.descriptor_path, f.archive_path, f.output, 'a' * 40, output)
        self.assertFalse((f.output / 'release-info.json').exists())

    def test_external_descriptor_is_explicit_and_bounded(self):
        f = self.fixture
        valid = copy.deepcopy(f.descriptor)
        mutations = [{'schemaVersion': 1}, {'worldBudgetBytes': True}, {'worldBudgetBytes': 4_000_000_001},
                     {'archiveBudgetBytes': 2_000_000_001}, {'shellBudgetBytes': 20_000_001},
                     {'worldBudgetBytes': f.descriptor['worldBytes'] - 1}, {'corsOrigin': '*'},
                     {'worldOrigin': 'https://wrong.example.org'}, {'unknown': 'field'},
                     {'worldBaseUrl': 'https://127.0.0.1/world/', 'worldOrigin': 'https://127.0.0.1'},
                     {'worldBaseUrl': 'https://localhost/world/', 'worldOrigin': 'https://localhost'},
                     {'worldBaseUrl': 'https://assets.example.org:443/world/'},
                     {'worldBaseUrl': 'https://assets.example.org/world/../'},
                     {'worldBaseUrl': 'https://assets.example.org/world/%2e%2e/'},
                     {'worldBaseUrl': 'https://user:password@assets.example.org/world/'},
                     {'worldBaseUrl': 'https://assets.example.org/world/?token=secret'},
                     {'worldBaseUrl': 'https://assets.example.org/world/#fragment'}]
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                f.descriptor = {**valid, **mutation}
                f.write_descriptor()
                with self.assertRaises(ValueError):
                    pages.load_descriptor(f.descriptor_path)

    def test_external_budget_does_not_raise_pages_budget(self):
        f = self.fixture
        f.descriptor['worldBytes'] = pages.MAX_WORLD_BYTES + 1
        f.write_descriptor()
        self.assertEqual(pages.load_descriptor(f.descriptor_path)[0]['worldBytes'], pages.MAX_WORLD_BYTES + 1)
        f.descriptor = {**self.pages_descriptor, 'worldBytes': pages.MAX_WORLD_BYTES + 1}
        f.write_descriptor()
        with self.assertRaises(ValueError):
            pages.load_descriptor(f.descriptor_path)

    def test_external_reuses_payload_integrity_and_closure_checks(self):
        f = self.fixture
        f.payloads['roads.json'] = b'{"tampered": true}'
        original = copy.deepcopy(f.descriptor)
        f.build_inputs()
        original.update(archiveSha256=f.descriptor['archiveSha256'], archiveBytes=f.descriptor['archiveBytes'],
                        worldBytes=f.descriptor['worldBytes'])
        f.descriptor = original
        f.write_descriptor()
        with self.assertRaisesRegex(ValueError, 'digest or byte count'):
            self.stage()
        self.assertFalse(self.upload.exists())
        self.assertFalse((f.output / 'release-info.json').exists())

    def test_external_stage_enforces_shell_budget_including_receipt(self):
        f = self.fixture
        f.descriptor['shellBudgetBytes'] = sum(p.stat().st_size for p in f.output.rglob('*') if p.is_file())
        f.write_descriptor()
        with self.assertRaisesRegex(ValueError, 'byte limit'):
            self.stage()
        self.assertFalse(self.upload.exists())

    def test_provider_neutral_preparation_preserves_every_byte(self):
        f = self.fixture
        source = self.extract_source()
        out = f.root / 'prepared'
        receipt = external.prepare(source, out, f.descriptor['manifestSha256'], 2_000_000_000, 1_500_000_000)
        self.assertIsNone(receipt['provider'])
        self.assertIsNone(receipt['worldBaseUrl'])
        self.assertEqual(receipt['assetTransformation'], 'none')
        self.assertEqual(receipt['status'], 'LOCAL_VALIDATED_NOT_PUBLISHED')
        with tarfile.open(out / receipt['archiveFile'], 'r:gz') as archive:
            for member in archive.getmembers():
                relative = member.name.split('/', 2)[2]
                self.assertEqual(archive.extractfile(member).read(), (source / relative).read_bytes())
        with self.assertRaisesRegex(ValueError, 'fresh'):
            external.prepare(source, out, f.descriptor['manifestSha256'], 2_000_000_000, 1_500_000_000)

    def test_provider_neutral_preparation_rejects_over_budget_and_unpinned_files(self):
        f = self.fixture
        source = self.extract_source()
        out = f.root / 'prepared'
        with self.assertRaisesRegex(ValueError, 'budget|file size'):
            external.prepare(source, out, f.descriptor['manifestSha256'], f.descriptor['worldBytes'] - 1, 1_000_000)
        self.assertFalse(out.exists())
        (source / 'extra.json').write_text('{}')
        with self.assertRaisesRegex(ValueError, 'exactly match'):
            external.prepare(source, out, f.descriptor['manifestSha256'], 2_000_000_000, 1_000_000)
        self.assertFalse(out.exists())

    def test_provider_neutral_preparation_rejects_private_metadata(self):
        f = self.fixture
        source = self.extract_source()
        with self.assertRaisesRegex(ValueError, 'private metadata'):
            pages._privacy_text(json.dumps({'path': 'C:' + '/Us' + 'ers/private-person/document'}).encode(), 'metadata.json')
        with self.assertRaisesRegex(ValueError, 'private metadata'):
            pages._privacy_text(b'{"path":"C\\u003a/Us' + b'ers/private-person/document"}', 'metadata.json')
        with mock.patch.object(pages, 'validate_privacy', side_effect=ValueError('private metadata')):
            with self.assertRaisesRegex(ValueError, 'private metadata'):
                external.prepare(source, f.root / 'prepared', f.descriptor['manifestSha256'], 2_000_000_000, 1_000_000)

    def test_archive_writer_stops_at_explicit_limit(self):
        f = self.fixture
        source = self.extract_source()
        with self.assertRaisesRegex(ValueError, 'archive exceeds'):
            external.prepare(source, f.root / 'prepared', f.descriptor['manifestSha256'], 2_000_000_000, 100)


if __name__ == '__main__':
    unittest.main()
