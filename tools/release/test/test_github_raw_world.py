import copy
import gzip
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import unittest
from unittest import mock
import urllib.error
from email.message import Message

import test_external_world as fixtures


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).resolve().parents[1] / filename)
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


prepare = module('test_raw_prepare', 'prepare-github-raw-world.py')
verify = module('test_raw_verify', 'verify-github-raw-world.py')
pages, raw = prepare.pages, prepare.raw
BASE = raw.ORIGIN + '/MattiTynka/Helsinki-rides/' + 'a' * 40 + '/world/'


class Response(io.BytesIO):
    def __init__(self, url, name, data, encoding=None, headers=None):
        super().__init__(data)
        self.status, self.url = 200, url
        self.headers = Message()
        values = {'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff',
                  'Content-Type': raw.content_types(name)[0], 'Cache-Control': 'max-age=300'}
        if encoding:
            values['Content-Encoding'] = encoding
        values.update(headers or {})
        for key, value in values.items():
            self.headers[key] = value

    def geturl(self):
        return self.url


class GithubRawWorldTest(unittest.TestCase):
    def setUp(self):
        owner = fixtures.ExternalWorldTest(methodName='runTest')
        owner.setUp()
        self.addCleanup(owner.doCleanups)
        self.owner, self.f = owner, owner.fixture
        self.source = owner.extract_source()
        self.packet = self.f.root / 'packet'
        prepare.external.prepare(self.source, self.packet, self.f.descriptor['manifestSha256'], 2_000_000_000, 1_500_000_000)
        self.f.descriptor.update(schemaVersion=3, deliveryProvider='github-raw', worldOrigin=raw.ORIGIN, worldBaseUrl=BASE)
        self.f.write_descriptor()

    def local_prepare(self, out=None, **kwargs):
        return prepare.prepare(self.source, self.packet, out or self.f.root / 'assets',
                               self.f.descriptor['manifestSha256'], 2_000_000_000, 4_000_000_000, 'fixture-world', **kwargs)

    def test_descriptor_narrow_commit_profile_and_generic_contract(self):
        valid = copy.deepcopy(self.f.descriptor)
        self.assertEqual(pages.load_descriptor(self.f.descriptor_path)[0], valid)
        for mutation in [{'schemaVersion': 2}, {'deliveryProvider': 'other'}, {'corsOrigin': '*'},
                         {'worldBaseUrl': BASE.replace('a' * 40, 'main')},
                         {'worldBaseUrl': BASE.replace('a' * 40, 'a' * 39)},
                         {'worldBaseUrl': BASE.replace('MattiTynka', 'another')},
                         {'worldBaseUrl': BASE.replace('/world/', '/source/')},
                         {'worldBaseUrl': BASE + '../'}, {'worldBaseUrl': BASE + '?x=1'},
                         {'worldBaseUrl': BASE.replace('a' * 40, 'A' * 40)}]:
            with self.subTest(mutation=mutation):
                self.f.descriptor = {**valid, **mutation}
                self.f.write_descriptor()
                with self.assertRaises(ValueError):
                    pages.load_descriptor(self.f.descriptor_path)
        inventory, descriptor = prepare.external.inventory_world(self.source, valid['manifestSha256'], 2_000_000_000)
        generic = pages.upload_inventory(inventory, descriptor)
        self.assertEqual(generic['requiredHeaders']['Access-Control-Allow-Origin'], pages.GAME_ORIGIN)
        self.assertIn('Content-Encoding', generic['forbiddenHeaders'])
        profiled = pages.upload_inventory(inventory, valid)
        self.assertEqual(profiled['requiredHeaders']['Access-Control-Allow-Origin'], '*')
        self.assertEqual(profiled['assetCommit'], 'a' * 40)
        self.assertEqual(profiled['requestCredentials'], 'omit')

    def test_local_git_commit_preserves_all_blobs_and_reuses_previous_objects(self):
        result = self.local_prepare()
        root = self.f.root / 'assets'
        self.assertEqual(result['externalWrites'], 0)
        self.assertEqual(result['status'], 'LOCAL_ASSET_COMMIT_NOT_PUBLISHED')
        self.assertLess(result['pushPack']['bytes'], raw.MAX_PUSH_BYTES)
        descriptor, _ = pages.load_descriptor(root / 'descriptor.local-not-published.json')
        self.assertIn(result['assetCommit'], descriptor['worldBaseUrl'])
        self.assertEqual(prepare.git(root / 'assets.git', 'remote').strip(), b'')
        for item in json.loads((root / 'upload-inventory.json').read_text())['objects']:
            blob = prepare.git(root / 'assets.git', 'show', result['assetCommit'] + ':world/' + item['key'])
            self.assertEqual(blob, (self.source / item['path']).read_bytes())
        previous_inventory = prepare.git(root / 'assets.git', 'for-each-ref')
        next_result = self.local_prepare(self.f.root / 'next-assets', previous_repo=root / 'assets.git', previous_commit=result['assetCommit'])
        old_blobs = {x['oid'] for x in result['allRefs']['objects'] if x['kind'] == 'blob'}
        new_blobs = {x['oid'] for x in next_result['allRefs']['objects'] if x['kind'] == 'blob'}
        self.assertEqual(old_blobs, new_blobs)
        self.assertEqual(next_result['previousAncestorCount'], 1)
        self.assertEqual(prepare.git(root / 'assets.git', 'for-each-ref'), previous_inventory)
        self.assertEqual(prepare.git(self.f.root / 'next-assets/assets.git', 'show', result['assetCommit'] + ':world/' + self.f.release + '/manifest.json'), (self.source / 'manifest.json').read_bytes())

    def test_wrong_source_and_oversize_fail_before_output(self):
        out = self.f.root / 'refused'
        with mock.patch.object(raw, 'MAX_FILE_BYTES', 8), self.assertRaisesRegex(ValueError, '100 MiB'):
            self.local_prepare(out)
        self.assertFalse(out.exists())
        (self.source / 'roads.json').write_bytes(b'{"changed":true}')
        with self.assertRaisesRegex(ValueError, 'digest|byte count'):
            self.local_prepare(out)
        self.assertFalse(out.exists())

    def test_source_previous_and_case_alias_output_guards_precede_mkdir(self):
        with self.assertRaisesRegex(ValueError, 'overlap'):
            self.local_prepare(self.source / 'nested')
        if os.name == 'nt':
            with self.assertRaisesRegex(ValueError, 'overlap'):
                self.local_prepare(Path(str(self.source).upper()) / 'nested')
        result = self.local_prepare()
        previous = self.f.root / 'assets/assets.git'
        before = prepare.git(previous, 'for-each-ref')
        with self.assertRaisesRegex(ValueError, 'overlap'):
            self.local_prepare(previous / 'nested', previous_repo=previous, previous_commit=result['assetCommit'])
        self.assertFalse((previous / 'nested').exists())
        self.assertEqual(prepare.git(previous, 'for-each-ref'), before)

    def test_wrong_blob_and_push_overflow_do_not_produce_success_receipt(self):
        result = self.local_prepare()
        repo = self.f.root / 'assets/assets.git'
        blob = next(x for x in result['allRefs']['objects'] if x['kind'] == 'blob')
        with self.assertRaisesRegex(ValueError, 'changed payload'):
            prepare.check_stored_blobs(repo, [(blob['oid'], {'bytes': blob['bytes'], 'sha256': '0' * 64})])
        out = self.f.root / 'overflow'
        with mock.patch.object(raw, 'MAX_PUSH_BYTES', 10), self.assertRaisesRegex(ValueError, 'push pack'):
            self.local_prepare(out)
        self.assertFalse((out / 'preparation-receipt.json').exists())

    def test_http_gzip_and_stored_gzip_have_different_byte_contracts(self):
        value = b'{"public":true}\n'
        item = {'bytes': len(value), 'sha256': hashlib.sha256(value).hexdigest()}
        url = BASE + 'fixture/data.json'
        result = verify.verify_response(Response(url, 'data.json', gzip.compress(value), 'gzip'), url, 'data.json', item)
        self.assertEqual(result['sha256'], item['sha256'])
        encoded = gzip.compress(value)
        compressed = {'bytes': len(encoded), 'sha256': hashlib.sha256(encoded).hexdigest()}
        verify.verify_response(Response(url, 'data.json.gz', encoded), url, 'data.json.gz', compressed)
        with self.assertRaisesRegex(ValueError, 'Content-Encoding'):
            verify.verify_response(Response(url, 'data.json.gz', gzip.compress(encoded), 'gzip'), url, 'data.json.gz', compressed)
        for data in [gzip.compress(value * 100), gzip.compress(value)[:-4], gzip.compress(value) + b'junk']:
            with self.subTest(data=data[:8]), self.assertRaises(ValueError):
                verify.verify_response(Response(url, 'data.json', data, 'gzip'), url, 'data.json', item)

    def test_remote_digest_redirect_headers_and_cache_changes_fail_closed(self):
        data, url = b'{}', BASE + 'fixture/data.json'
        item = {'bytes': 2, 'sha256': hashlib.sha256(data).hexdigest()}
        for headers in [{'Access-Control-Allow-Origin': pages.GAME_ORIGIN}, {'Access-Control-Allow-Credentials': 'true'},
                        {'Content-Type': 'text/html'}, {'Cache-Control': 'private, max-age=300'}, {'Cache-Control': 'max-age=600'}]:
            with self.subTest(headers=headers), self.assertRaises(ValueError):
                verify.verify_response(Response(url, 'data.json', data, headers=headers), url, 'data.json', item)
        with self.assertRaisesRegex(ValueError, 'digest'):
            verify.verify_response(Response(url, 'data.json', b'[]'), url, 'data.json', item)
        with self.assertRaisesRegex(ValueError, 'URL'):
            verify.verify_response(Response(url + 'other', 'data.json', data), url, 'data.json', item)
        with self.assertRaisesRegex(ValueError, 'redirect'):
            verify.NoRedirect().redirect_request(None, None, 302, '', {}, 'https://example.org/')

    def test_whole_world_served_gate_and_shell_identity(self):
        pages.stage(self.f.descriptor_path, self.f.archive_path, self.f.output, 'b' * 40, self.f.root / 'upload')
        calls = []
        def served(url, method):
            calls.append((url, method))
            self.assertTrue(url.startswith(BASE + self.f.release + '/'))
            name = url.removeprefix(BASE + self.f.release + '/')
            if name.startswith('missing-object-probe-'):
                raise urllib.error.HTTPError(url, 404, 'not found', {}, None)
            data = (self.source / name).read_bytes()
            transport = 'gzip' if name.endswith('.json') else None
            return Response(url, name, gzip.compress(data) if transport else data, transport)
        with mock.patch.object(verify, 'request', side_effect=served):
            proof = verify.verify(self.f.descriptor_path, self.source, self.f.root / 'served')
        self.assertEqual(len(calls), proof['worldFiles'] * 2 + 1)
        self.assertFalse((self.f.output / 'world').exists())
        verify.record_shell_verification(self.f.output, self.f.descriptor_path, proof)
        self.assertIn('ALL_SERVED_OBJECTS_VERIFIED', json.loads((self.f.output / 'release-info.json').read_text())['hostingStatus'])
        wrong = {**proof, 'descriptorSha256': '0' * 64}
        with self.assertRaisesRegex(ValueError, 'descriptor'):
            verify.record_shell_verification(self.f.output, self.f.descriptor_path, wrong)
        script = self.f.output / 'assets/index-test.js'
        original = script.read_bytes()
        script.write_bytes(bytes([original[0] ^ 1]) + original[1:])
        with self.assertRaisesRegex(ValueError, 'payload bytes changed'):
            verify.record_shell_verification(self.f.output, self.f.descriptor_path, proof)

    def test_no_network_before_descriptor_and_source_validation(self):
        self.f.descriptor['worldBaseUrl'] = BASE.replace('a' * 40, 'main')
        self.f.write_descriptor()
        with mock.patch.object(verify, 'request') as request, self.assertRaises(ValueError):
            verify.verify(self.f.descriptor_path, self.source, self.f.root / 'served')
        request.assert_not_called()


if __name__ == '__main__':
    unittest.main()
