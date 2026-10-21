import copy
import gzip
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import struct
import tarfile
import tempfile
import unittest
from unittest import mock


SPEC = importlib.util.spec_from_file_location('stage_pages_world', Path(__file__).resolve().parents[1] / 'stage-pages-world.py')
pages = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(pages)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def startup_jpeg(metadata=b''):
    def segment(code, payload):
        return b'\xff' + bytes([code]) + struct.pack('>H', len(payload) + 2) + payload
    return b'\xff\xd8' + metadata + segment(0xDB, b'quantization') + segment(0xDA, b'scan') + b'raster\xff\x00stuffed\xff\xd9'


def minimal_glb(document=None):
    """A real GLB envelope, including a padded JSON chunk and embedded BIN chunk."""
    model = {'asset': {'version': '2.0'}, 'scene': 0, 'scenes': [{}],
             'buffers': [{'byteLength': 4}],
             'bufferViews': [{'buffer': 0, 'byteOffset': 0, 'byteLength': 4}]}
    model.update(document or {})
    text = json.dumps(model, separators=(',', ':')).encode()
    text += b' ' * (-len(text) % 4)
    binary = bytes(4)
    total = 12 + 8 + len(text) + 8 + len(binary)
    return (struct.pack('<III', 0x46546c67, 2, total)
            + struct.pack('<II', len(text), 0x4e4f534a) + text
            + struct.pack('<II', len(binary), 0x004e4942) + binary)


def hcol(positions, indices):
    """An HCOL v2 collision bundle with one collider."""
    data = struct.pack(f'<{len(positions)}f', *positions)
    index_offset = len(data)
    data += struct.pack(f'<{len(indices)}I', *indices)
    tag_offset = len(data)
    data += bytes(2 * (len(indices) // 3))
    header = json.dumps({'colliders': [{
        'id': 'g', 'group': 'buildings', 'ref': None, 'positions': {'offset': 0, 'count': len(positions)},
        'indices': {'offset': index_offset, 'count': len(indices)}, 'triangleTags': {'offset': tag_offset, 'count': len(indices) // 3},
    }]}).encode()
    header += b'\0' * (-len(header) % 4)
    return b'HCOL' + struct.pack('<II', 2, len(header)) + header + data


def ktx2(width, height, levels, scheme=2):
    """A KTX2 container laid out like the encoder's: level index, DFD, KVD, then levels smallest first."""
    dfd, kvd = b'DFD-test', b'KVD-'
    dfd_offset = 80 + 24 * len(levels)
    kvd_offset = dfd_offset + len(dfd)
    cursor, index = kvd_offset + len(kvd), [b''] * len(levels)
    for level in reversed(range(len(levels))):
        index[level] = struct.pack('<3Q', cursor, len(levels[level]), 4 * len(levels[level]))
        cursor += len(levels[level])
    header = (pages.KTX2_IDENTIFIER + struct.pack('<9I', 0, 1, width, height, 0, 0, 1, len(levels), scheme)
              + struct.pack('<4I2Q', dfd_offset, len(dfd), kvd_offset, len(kvd), 0, 0))
    return header + b''.join(index) + dfd + kvd + b''.join(reversed(levels))


class PagesWorldTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.output = self.root / 'dist-pages'
        self.output.mkdir()
        for name in ['index.html', 'assets/index-test.js', 'assets/index-test.css',
                     'basis/basis_transcoder.js', 'basis/basis_transcoder.wasm']:
            path = self.output / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b'public shell')
        self.release = 'senate-pages-test'
        self.payloads = {
            'terrain.bin': b'terrain', 'roads.json': b'{}', 'gameplay.json': b'{}',
            'cells/c0.glb': b'visual mesh', 'cells/c0.hcol': b'collision',
            'assets/snow.glb': b'character', 'LICENSE.md': b'Public attribution',
            'sources/osm.json.gz': gzip.compress(b'{"license":"ODbL"}', mtime=0),
        }

        def ref(name):
            return {'path': name, 'bytes': len(self.payloads[name]), 'sha256': sha(self.payloads[name])}

        self.manifest = {
            'schemaVersion': 2, 'worldReleaseId': self.release,
            'terrain': ref('terrain.bin'), 'roads': ref('roads.json'), 'gameplay': ref('gameplay.json'),
            'cells': [{'visual': {'lod0': ref('cells/c0.glb')}, 'collision': ref('cells/c0.hcol')}],
            'assets': [dict(id='character-snow', kind='character', **ref('assets/snow.glb'))],
            'publicationFiles': [ref('LICENSE.md'), ref('sources/osm.json.gz')],
        }
        self.descriptor_path = self.root / 'pages.json'
        self.archive_path = self.root / 'pages-world.tar.gz'
        self.build_inputs()

    def build_inputs(self, extra_members=(), omit=(), manifest_bytes=None):
        manifest_data = manifest_bytes or json.dumps(self.manifest, sort_keys=True).encode()
        files = {'manifest.json': manifest_data, **self.payloads}
        members = [(f'world/{self.release}/{name}', data, tarfile.REGTYPE)
                   for name, data in files.items() if name not in omit]
        members.extend(extra_members)
        stream = io.BytesIO()
        # Content-addressed texture paths exceed the tar name field. USTAR carries
        # them in its fixed prefix field without GNU LongLink or PAX entries.
        with tarfile.open(fileobj=stream, mode='w:gz', format=tarfile.USTAR_FORMAT) as archive:
            for name, data, kind in members:
                info = tarfile.TarInfo(name)
                info.type = kind
                info.size = len(data) if kind == tarfile.REGTYPE else 0
                if kind in {tarfile.SYMTYPE, tarfile.LNKTYPE}:
                    info.linkname = 'terrain.bin'
                archive.addfile(info, io.BytesIO(data) if info.size else None)
        self.archive_path.write_bytes(stream.getvalue())
        self.descriptor = {
            'schemaVersion': 1, 'worldRelease': self.release,
            'manifestSha256': sha(manifest_data), 'worldBaseUrl': pages.WORLD_BASE_URL,
            'archiveUrl': 'https://github.com/MattiTynka/Helsinki-rides/releases/download/pages-test/pages-world.tar.gz',
            'archiveSha256': sha(stream.getvalue()), 'archiveBytes': len(stream.getvalue()),
            'worldBytes': sum(len(data) for name, data, kind in members if kind == tarfile.REGTYPE),
        }
        self.write_descriptor()

    def write_descriptor(self):
        self.descriptor_path.write_text(json.dumps(self.descriptor), encoding='utf-8')

    def stage(self):
        return pages.stage(self.descriptor_path, self.archive_path, self.output, 'a' * 40)

    def assert_refused_without_output(self):
        with self.assertRaises((ValueError, OSError, EOFError)):
            self.stage()
        self.assertFalse((self.output / 'world').exists())
        self.assertFalse((self.output / 'release-info.json').exists())

    def refresh_archive_pin(self):
        data = self.archive_path.read_bytes()
        self.descriptor.update(archiveSha256=sha(data), archiveBytes=len(data))
        self.write_descriptor()

    def set_gameplay(self, gameplay):
        data = json.dumps(gameplay).encode()
        self.payloads['gameplay.json'] = data
        self.manifest['gameplay'] = {'path': 'gameplay.json', 'bytes': len(data), 'sha256': sha(data)}

    def pin_payload(self, name, data):
        self.payloads[name] = data
        return {'path': name, 'bytes': len(data), 'sha256': sha(data)}

    def compress_simulation(self, reference, decoded=None):
        previous = reference['path']
        original = self.payloads.pop(previous)
        decoded = original if decoded is None else decoded
        reference.update(self.pin_payload(previous + '.gz', gzip.compress(decoded, mtime=0)),
                         compression='gzip', decodedBytes=len(decoded), decodedSha256=sha(decoded))
        return decoded

    def optimized_textures(self):
        """Both cell and actor model dependencies exercise the optimized-model boundary."""
        images = [b'\xabKTX 20\xbb\r\n\x1a\nlicensed texture',
                  b'\x89PNG\r\n\x1a\nlicensed texture']
        refs = [self.pin_payload(f'textures/{sha(data)}.{suffix}', data)
                for data, suffix in zip(images, ['ktx2', 'png'])]
        self.manifest['sharedTextures'] = refs
        self.manifest['cells'][0]['visual']['lod0'] = self.pin_payload(
            'cells/c0.glb', minimal_glb({'images': [{'uri': '../' + refs[0]['path']}]}))
        self.manifest['assets'][0].update(self.pin_payload(
            'assets/snow.glb', minimal_glb({'images': [{'uri': '../' + refs[1]['path']}]})))
        return refs

    def assert_optimized_refused(self, message):
        with self.assertRaisesRegex((ValueError, OSError, EOFError), message):
            self.stage()
        self.assertFalse((self.output / 'world').exists())
        self.assertFalse((self.output / 'release-info.json').exists())

    def test_valid_archive_is_staged_with_receipt_and_exact_payloads(self):
        result = self.stage()
        self.assertEqual(result['status'], 'PASS')
        self.assertEqual(result['worldFiles'], len(self.payloads) + 1)
        self.assertEqual(result['sourceCommit'], 'a' * 40)
        for name, data in self.payloads.items():
            self.assertEqual((self.output / 'world' / self.release / name).read_bytes(), data)
        receipt = json.loads((self.output / 'release-info.json').read_bytes())
        self.assertEqual(receipt['descriptorSha256'], sha(self.descriptor_path.read_bytes()))
        self.assertEqual(result['artifactBytes'], sum(path.stat().st_size for path in self.output.rglob('*') if path.is_file()))
        self.assertTrue((self.output / '.nojekyll').is_file())

    def test_descriptor_rejects_unapproved_destinations_fields_and_types(self):
        changes = [
            {'archiveUrl': 'https://example.invalid/pages-world.tar.gz'},
            {'archiveUrl': self.descriptor['archiveUrl'] + '?secret=value'},
            {'archiveUrl': self.descriptor['archiveUrl'].replace('/pages-test/', '/../')},
            {'worldBaseUrl': pages.WORLD_BASE_URL + '../'}, {'schemaVersion': True},
            {'worldRelease': '../escape'}, {'worldRelease': 'unsafe%2fescape'},
            {'worldBytes': pages.MAX_WORLD_BYTES + 1}, {'archiveBytes': False},
            {'manifestSha256': 'A' * 64}, {'unexpected': 'value'},
        ]
        original = copy.deepcopy(self.descriptor)
        for change in changes:
            with self.subTest(change=change):
                self.descriptor = {**original, **change}
                self.write_descriptor()
                with self.assertRaises(ValueError):
                    pages.load_descriptor(self.descriptor_path)

    def test_descriptor_rejects_duplicate_json_keys(self):
        data = self.descriptor_path.read_text(encoding='utf-8')
        self.descriptor_path.write_text('{"schemaVersion":1,' + data[1:], encoding='utf-8')
        self.assert_refused_without_output()

    def test_validated_descriptor_writes_only_allowlisted_runner_variables(self):
        descriptor, _ = pages.load_descriptor(self.descriptor_path)
        environment = self.root / 'runner-env'
        pages.write_github_env(descriptor, environment)
        values = dict(line.split('=', 1) for line in environment.read_text().splitlines())
        self.assertEqual(values['VITE_WORLD_RELEASE'], self.release)
        self.assertEqual(values['PAGES_WORLD_ARCHIVE_URL'], descriptor['archiveUrl'])
        self.assertEqual(len(values), 5)

    def test_compressed_archive_hash_and_size_are_both_pinned(self):
        for field, value in [('archiveSha256', 'b' * 64), ('archiveBytes', self.descriptor['archiveBytes'] + 1)]:
            with self.subTest(field=field):
                original = self.descriptor[field]
                self.descriptor[field] = value
                self.write_descriptor()
                self.assert_refused_without_output()
                self.descriptor[field] = original

    def test_archive_rejects_traversal_wrong_release_and_encoded_paths(self):
        for name in ['world/../escaped.bin', f'world/{self.release}/../escaped.bin',
                     'world/other/terrain.bin', f'world/{self.release}/a%2fb.bin',
                     f'world/{self.release}/a\\b.bin', f'world/{self.release}/.hidden.json']:
            with self.subTest(name=name):
                self.build_inputs(extra_members=[(name, b'bad', tarfile.REGTYPE)])
                self.assert_refused_without_output()

    def test_archive_rejects_links_directories_and_special_entries(self):
        for kind in [tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.DIRTYPE, tarfile.FIFOTYPE, tarfile.CHRTYPE, tarfile.XHDTYPE]:
            with self.subTest(kind=kind):
                self.build_inputs(extra_members=[(f'world/{self.release}/extra.bin', b'bad', kind)])
                self.assert_refused_without_output()

    def test_archive_rejects_duplicate_and_unreferenced_files(self):
        for name in ['terrain.bin', 'extra.bin', 'source.py', 'extra.map']:
            with self.subTest(name=name):
                self.build_inputs(extra_members=[(f'world/{self.release}/{name}', b'bad', tarfile.REGTYPE)])
                self.assert_refused_without_output()

    def test_missing_or_tampered_referenced_file_is_rejected(self):
        self.build_inputs(omit=['terrain.bin'])
        self.assert_refused_without_output()
        self.payloads['terrain.bin'] = b'tampered terrain'
        self.build_inputs()
        self.assert_refused_without_output()

    def test_reference_byte_count_and_digest_are_independently_checked(self):
        for key, value in [('bytes', len(self.payloads['terrain.bin']) + 1), ('sha256', 'd' * 64)]:
            with self.subTest(key=key):
                original = self.manifest['terrain'][key]
                self.manifest['terrain'][key] = value
                self.build_inputs()
                self.assert_refused_without_output()
                self.manifest['terrain'][key] = original

    def test_manifest_hash_release_and_required_references_are_checked(self):
        self.descriptor['manifestSha256'] = 'c' * 64
        self.write_descriptor()
        self.assert_refused_without_output()
        for update in [{'worldReleaseId': 'other'}, {'schemaVersion': 1}, {'terrain': {}},
                       {'assets': ['invalid']}, {'publicationFiles': ['invalid']}, {'cells': []}]:
            with self.subTest(update=update):
                original = copy.deepcopy(self.manifest)
                self.manifest.update(update)
                self.build_inputs()
                self.assert_refused_without_output()
                self.manifest = original

    def test_manifest_rejects_encoded_paths_and_conflicting_references(self):
        self.manifest['terrain']['path'] = '%2e%2e/terrain.bin'
        self.build_inputs()
        self.assert_refused_without_output()
        self.manifest['terrain']['path'] = 'terrain.bin'
        self.manifest['roads'] = {**self.manifest['terrain'], 'sha256': 'b' * 64}
        self.build_inputs()
        self.assert_refused_without_output()

    def test_publication_compression_is_restricted_to_json_gzip_not_runtime_refs(self):
        self.manifest['terrain'] = self.manifest['publicationFiles'][1]
        self.build_inputs()
        self.assert_refused_without_output()
        self.manifest['publicationFiles'][1]['path'] = 'source.tar.gz'
        self.build_inputs()
        self.assert_refused_without_output()

    def test_archive_world_total_is_checked(self):
        self.descriptor['worldBytes'] += 1
        self.write_descriptor()
        self.assert_refused_without_output()

    def test_corrupt_headers_truncation_and_hidden_trailing_data_are_rejected(self):
        original = self.archive_path.read_bytes()
        tar = gzip.decompress(original)
        for malformed in [tar[:512] + tar[512:600], bytes([tar[0] ^ 1]) + tar[1:], tar + b'hidden']:
            with self.subTest(length=len(malformed)):
                self.archive_path.write_bytes(gzip.compress(malformed))
                self.refresh_archive_pin()
                self.assert_refused_without_output()

    def test_shell_refuses_source_maps_review_files_and_existing_world(self):
        for name in ['assets/index.js.map', 'source.ts', 'review/index.html', 'release-info.json', 'world/current.json']:
            with self.subTest(name=name):
                path = self.output / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b'forbidden')
                with self.assertRaises(ValueError):
                    self.stage()
                path.unlink()
        (self.output / 'world').rmdir()

    def test_shell_accepts_the_root_service_worker_and_hashed_wasm(self):
        for name in ['sw.js', 'assets/rapier_wasm3d_bg-Ab12_c.wasm']:
            (self.output / name).write_bytes(b'public shell')
        self.assertEqual(self.stage()['status'], 'PASS')

    def test_shell_accepts_only_the_hashed_metadata_free_startup_jpeg(self):
        path = self.output / 'assets/senate-square-start-C3c2do1Y.jpg'
        path.write_bytes(startup_jpeg())
        self.assertEqual(self.stage()['status'], 'PASS')

    def test_shell_refuses_unreviewed_image_names(self):
        for name in ['photo-C3c2do1Y.jpg', 'senate-square-start.jpg', 'senate-square-start-C3c2do1Y.png']:
            with self.subTest(name=name):
                path = self.output / 'assets' / name
                path.write_bytes(startup_jpeg())
                with self.assertRaises(ValueError):
                    pages._shell_inventory(self.output)
                path.unlink()

    def test_shell_refuses_private_metadata_corrupt_and_oversized_startup_images(self):
        path = self.output / 'assets/senate-square-start-C3c2do1Y.jpg'
        private_app1 = b'\xff\xe1' + struct.pack('>H', 15) + b'Exif\x00private!'
        for payload in [startup_jpeg(private_app1), startup_jpeg() + b'private trailer', b'not-jpeg', b'x' * 1_000_001]:
            with self.subTest(length=len(payload)):
                path.write_bytes(payload)
                with self.assertRaises(ValueError):
                    pages._shell_inventory(self.output)

    def test_invalid_source_commit_is_refused(self):
        with self.assertRaises(ValueError):
            pages.stage(self.descriptor_path, self.archive_path, self.output, 'main')

    def test_restricted_vehicle_asset_ids_cannot_return_from_a_historical_packet(self):
        for identity in ['vehicle-kaamos', 'Kaamos', 'GT40', 'vehicle-GT40-v1']:
            with self.subTest(identity=identity):
                self.manifest['assets'][0]['id'] = identity
                self.build_inputs()
                self.assert_refused_without_output()

    def test_restricted_vehicle_glb_filenames_are_rejected_even_if_the_asset_is_renamed(self):
        original_asset = copy.deepcopy(self.manifest['assets'][0])
        for filename in ['assets/vehicle-kaamos.01d9f51ee1.glb', 'assets/GT40.glb', 'assets/vehicle-gt40-v1.glb']:
            with self.subTest(filename=filename):
                self.payloads[filename] = self.payloads.pop('assets/snow.glb')
                self.manifest['assets'][0] = {**original_asset, 'path': filename}
                self.build_inputs()
                self.assert_refused_without_output()
                self.payloads['assets/snow.glb'] = self.payloads.pop(filename)
        self.manifest['assets'][0] = original_asset

    def test_known_restricted_glb_digest_is_rejected_after_both_asset_identity_and_filename_are_renamed(self):
        self.payloads['assets/renamed.glb'] = self.payloads.pop('assets/snow.glb')
        self.manifest['assets'][0].update(id='vehicle-unrelated', path='assets/renamed.glb',
                                          sha256=pages.RESTRICTED_VEHICLE_SHA256)
        self.build_inputs()
        # The synthetic bytes cannot reproduce a real model digest. Isolate the manifest policy
        # so this regression proves the explicit known-hash guard, rather than an integrity mismatch.
        with self.assertRaisesRegex(ValueError, 'nonredistributable vehicle GLB digest'):
            pages._manifest_refs(json.dumps(self.manifest).encode(), self.descriptor)
        with self.assertRaisesRegex(ValueError, 'nonredistributable vehicle GLB digest'):
            self.stage()
        self.assertFalse((self.output / 'world').exists())
        self.assertFalse((self.output / 'release-info.json').exists())

    def test_restricted_gameplay_definitions_and_spawns_cannot_be_published(self):
        cases = [
            {'vehicleDefinitions': [{'id': 'kaamos', 'assetId': 'renamed'}]},
            {'vehicleDefinitions': [{'id': 'renamed', 'assetId': 'vehicle-kaamos'}]},
            {'vehicleDefinitions': [{'id': 'GT40', 'assetId': 'renamed'}]},
            {'vehicleDefinitions': [{'id': 'renamed', 'label': 'Ford GT40'}]},
            {'vehicleDefinitions': [{'id': 'renamed', 'interaction': {'poses': 'kaamos'}}]},
            {'vehicles': [{'id': 'car-4', 'definition': 'kaamos'}]},
            {'vehicles': [{'id': 'kaamos-parked', 'definition': 'renamed'}]},
            {'vehicles': [{'id': 'car-4', 'definition': 'vehicle-GT40'}]},
        ]
        for gameplay in cases:
            with self.subTest(gameplay=gameplay):
                self.set_gameplay(gameplay)
                self.build_inputs()
                self.assert_refused_without_output()

    def test_revontuli_and_historical_prose_about_excluded_models_remain_allowed(self):
        self.manifest['assets'][0]['id'] = 'vehicle-revontuli'
        self.set_gameplay({'vehicleDefinitions': [{'id': 'revontuli', 'assetId': 'vehicle-revontuli', 'label': 'Revontuli'}],
                           'vehicles': [{'id': 'car-3', 'definition': 'revontuli'}]})
        self.manifest['attribution'] = ['Historical note: GT40-derived Kaamos is excluded.']
        data = b'Historical audit: vehicle-kaamos and GT40.glb were removed; do not redistribute them.'
        self.payloads['LICENSE.md'] = data
        self.manifest['publicationFiles'][0] = {'path': 'LICENSE.md', 'bytes': len(data), 'sha256': sha(data)}
        self.build_inputs()
        self.assertEqual(self.stage()['status'], 'PASS')

    def test_gameplay_boundary_rejects_invalid_shapes_without_staging(self):
        for gameplay in [[], {'vehicleDefinitions': None}, {'vehicles': ['invalid']}, {'vehicles': {'id': 'kaamos'}}]:
            with self.subTest(gameplay=gameplay):
                self.set_gameplay(gameplay)
                self.build_inputs()
                self.assert_refused_without_output()

    def test_gzip_simulation_inputs_validate_decoded_hash_and_size_without_rewriting_stored_bytes(self):
        terrain = self.compress_simulation(self.manifest['terrain'])
        collision = self.compress_simulation(self.manifest['cells'][0]['collision'])
        self.build_inputs()
        result = self.stage()
        self.assertEqual(result['status'], 'PASS')
        for ref, decoded in [(self.manifest['terrain'], terrain),
                             (self.manifest['cells'][0]['collision'], collision)]:
            staged = (self.output / 'world' / self.release / ref['path']).read_bytes()
            self.assertEqual(staged, self.payloads[ref['path']])
            self.assertEqual(gzip.decompress(staged), decoded)
            self.assertEqual(len(decoded), ref['decodedBytes'])
            self.assertEqual(sha(decoded), ref['decodedSha256'])

    def test_compressed_payload_decoded_digest_and_size_are_independently_pinned(self):
        self.compress_simulation(self.manifest['terrain'])
        reference = self.manifest['terrain']
        original = copy.deepcopy(reference)
        for change in [{'decodedSha256': 'd' * 64}, {'decodedBytes': original['decodedBytes'] + 1},
                       {'decodedBytes': original['decodedBytes'] - 1}]:
            with self.subTest(change=change):
                reference.clear()
                reference.update(original, **change)
                self.build_inputs()
                self.assert_optimized_refused('decoded simulation')

    def test_simulation_rejects_corrupt_gzip_even_when_stored_hash_is_correct(self):
        self.compress_simulation(self.manifest['cells'][0]['collision'])
        reference = self.manifest['cells'][0]['collision']
        original = self.payloads[reference['path']]
        corrupt_crc = original[:-8] + bytes([original[-8] ^ 1]) + original[-7:]
        for malformed in [b'not gzip', original[:-3], corrupt_crc]:
            with self.subTest(stored=malformed):
                reference.update(self.pin_payload(reference['path'], malformed))
                self.build_inputs()
                self.assert_refused_without_output()

    def test_simulation_compression_requires_complete_and_supported_metadata(self):
        self.compress_simulation(self.manifest['terrain'])
        original = copy.deepcopy(self.manifest['terrain'])
        cases = [
            ({'compression': 'br'}, ()), ({'compression': 'deflate'}, ()),
            ({'compression': True}, ()), ({'compression': None}, ()),
            ({}, ('compression',)), ({}, ('compression', 'decodedBytes', 'decodedSha256')),
            ({}, ('decodedBytes',)), ({}, ('decodedSha256',)),
            ({'decodedBytes': True}, ()), ({'decodedSha256': 'A' * 64}, ()),
        ]
        for updates, removed in cases:
            with self.subTest(updates=updates, removed=removed):
                self.manifest['terrain'] = {**original, **updates}
                for field in removed:
                    self.manifest['terrain'].pop(field)
                self.build_inputs()
                self.assert_optimized_refused('simulation|compression')

    def test_decoded_simulation_publication_cap_is_enforced_before_decompression(self):
        self.compress_simulation(self.manifest['terrain'])
        self.manifest['terrain']['decodedBytes'] = pages.MAX_SIMULATION_BYTES + 1
        self.build_inputs()
        self.assert_optimized_refused('decoded simulation bytes.*publication limit')

    def test_uncompressed_simulation_cannot_claim_decoded_or_gzip_metadata(self):
        original = copy.deepcopy(self.manifest['terrain'])
        for updates in [{'decodedBytes': len(self.payloads['terrain.bin'])},
                        {'decodedSha256': sha(self.payloads['terrain.bin'])},
                        {'compression': 'gzip', 'decodedBytes': 7, 'decodedSha256': sha(b'terrain')}]:
            with self.subTest(updates=updates):
                self.manifest['terrain'] = {**original, **updates}
                self.build_inputs()
                self.assert_optimized_refused('compression')

    def test_gzip_bomb_stops_at_declared_size_plus_one_byte(self):
        self.compress_simulation(self.manifest['terrain'], bytes(1_048_576))
        reference = self.manifest['terrain']
        reference.update(decodedBytes=8, decodedSha256=sha(bytes(8)))
        self.build_inputs()
        original_open = gzip.open
        requested_reads = []

        class BoundedReader:
            def __init__(self, stream):
                self.stream = stream

            def __enter__(self):
                self.stream.__enter__()
                return self

            def __exit__(self, *args):
                return self.stream.__exit__(*args)

            def read(self, size=-1):
                requested_reads.append(size)
                self_test.assertGreater(size, 0)
                self_test.assertLessEqual(size, 9)
                return self.stream.read(size)

        def observed_open(filename, *args, **kwargs):
            opened = original_open(filename, *args, **kwargs)
            return BoundedReader(opened) if str(filename).endswith('terrain.bin.gz') else opened

        self_test = self
        with mock.patch.object(pages.gzip, 'open', side_effect=observed_open):
            self.assert_optimized_refused('decoded simulation exceeds its declared size')
        self.assertEqual(requested_reads, [9])

    def test_runtime_roads_gzip_requires_complete_simulation_metadata(self):
        self.payloads.pop('roads.json')
        self.manifest['roads'] = self.pin_payload('roads.bin.gz', gzip.compress(b'{}', mtime=0))
        self.build_inputs()
        self.assert_optimized_refused('compression metadata is incomplete')

    def test_packed_roads_are_decoded_and_bounded_before_pages_mutation(self):
        fields = {'nodes': ['id', 'kind'], 'lanes': ['id', 'wayId', 'name', 'highway', 'surface', 'speedLimit', 'width', 'from', 'to', 'length', 'index', 'count'], 'connectors': ['id', 'node', 'from', 'to', 'turn', 'length'], 'parking': ['id', 'kind', 'heading'], 'footways': ['id']}
        header = {'schemaVersion': 1, 'root': {'schemaVersion': 2, 'originId': 'fixture', 'source': dict(id='osm', sha256='a' * 64, attribution='fixture', license='ODbL')}, 'strings': ['footway'], 'groups': {kind: {'fields': names, 'rows': []} for kind, names in fields.items()}}
        header['groups']['footways']['rows'] = [[0, 0, 2]]
        text = json.dumps(header, separators=(',', ':')).encode()
        offset = (32 + len(text) + 7) // 8 * 8
        binary = b'HROADS01' + struct.pack('<6I', 1, len(text), 2, 0, offset, offset + 48) + text + bytes(offset - 32 - len(text)) + struct.pack('<6d', 0, 3.141592653589793, 0, 1, 2.718281828459045, 1)
        pages._validate_packed_roads(binary)
        self.payloads.pop('roads.json')
        compressed = gzip.compress(binary, mtime=0)
        self.manifest['roads'] = {**self.pin_payload('roads.bin.gz', compressed), 'compression': 'gzip', 'decodedBytes': len(binary), 'decodedSha256': sha(binary)}
        self.build_inputs()
        self.assertEqual(self.stage()['status'], 'PASS')

    def test_packed_road_corruption_and_oversized_ranges_are_refused(self):
        for size, count, offset, reserved in [(1, 0xffffffff, 40, 0), (1, 0, 32, 0), (1, 0, 40, 1)]:
            with self.subTest(count=count, offset=offset, reserved=reserved):
                data = b'HROADS01' + struct.pack('<6I', 1, size, count, reserved, offset, 40) + bytes(8)
                with self.assertRaisesRegex(ValueError, 'ranges/version/counts'):
                    pages._validate_packed_roads(data)
        with self.assertRaisesRegex(ValueError, '8MB'):
            pages._validate_packed_roads(b'HROADS01' + bytes(8_000_001))

    def test_shared_texture_inventory_accepts_content_addressed_ktx2_and_png_dependencies(self):
        textures = self.optimized_textures()
        self.build_inputs()
        self.assertEqual(self.stage()['status'], 'PASS')
        for reference in textures:
            data = (self.output / 'world' / self.release / reference['path']).read_bytes()
            self.assertEqual(sha(data), reference['sha256'])
            self.assertEqual(Path(reference['path']).stem, sha(data))

    def test_shared_texture_file_bytes_are_independently_hashed(self):
        textures = self.optimized_textures()
        self.payloads[textures[0]['path']] = b'changed texture'
        self.build_inputs()
        self.assert_optimized_refused('differs from its manifest digest or byte count')

    def test_shared_texture_filename_must_equal_its_pinned_digest(self):
        textures = self.optimized_textures()
        reference = textures[0]
        original = reference['path']
        renamed = 'textures/' + 'a' * 64 + '.ktx2'
        self.payloads[renamed] = self.payloads.pop(original)
        reference['path'] = renamed
        self.manifest['cells'][0]['visual']['lod0'] = self.pin_payload(
            'cells/c0.glb', minimal_glb({'images': [{'uri': '../' + renamed}]}))
        self.build_inputs()
        self.assert_optimized_refused('content-addressed references')

    def test_reduced_textures_must_be_their_source_without_the_top_mip_level(self):
        textures = self.optimized_textures()
        levels = [b'level-zero-largest', b'level-one', b'l2']
        source = ktx2(8, 4, levels)
        self.payloads.pop(textures[0]['path'])
        self.manifest['sharedTextures'][0] = source_ref = self.pin_payload(f'textures/{sha(source)}.ktx2', source)
        self.manifest['cells'][0]['visual']['lod0'] = self.pin_payload(
            'cells/c0.glb', minimal_glb({'images': [{'uri': '../' + source_ref['path']}]}))
        original = copy.deepcopy(self.manifest)
        original_payloads = copy.deepcopy(self.payloads)
        # Staging succeeds only once per output directory, so the accepted case comes last.
        cases = [('changed level', ktx2(4, 2, [b'level-onX', b'l2']), source_ref['path']),
                 ('unhalved size', ktx2(8, 4, levels[1:]), source_ref['path']),
                 ('other supercompression', ktx2(4, 2, levels[1:], scheme=1), source_ref['path']),
                 ('png source', ktx2(4, 2, levels[1:]), textures[1]['path']),
                 ('valid', ktx2(4, 2, levels[1:]), source_ref['path'])]
        for name, data, source_path in cases:
            with self.subTest(case=name):
                self.manifest = copy.deepcopy(original)
                self.payloads = copy.deepcopy(original_payloads)
                reduced = self.pin_payload(f'textures-m1/{sha(data)}.ktx2', data)
                self.manifest['sharedTexturesM1'] = [{**reduced, 'source': source_path}]
                self.build_inputs()
                if name == 'valid':
                    self.assertEqual(self.stage()['status'], 'PASS')
                else:
                    self.assert_optimized_refused('reduced texture')

    def test_collision_bounds_must_contain_every_collision_triangle(self):
        # A wall reaching to x = 200, past its 128 m square; the vertex at 900 is used by no triangle.
        collision = hcol([0, 0, 0, 200, 0, 0, 200, 10, 64, 900, 0, 900], [0, 1, 2])
        original = copy.deepcopy(self.manifest)
        original_payloads = copy.deepcopy(self.payloads)
        # Staging succeeds only once per output directory, so the accepted case comes last.
        cases = [('grid square', [0, 0, 128, 128]), ('three numbers', [0, 0, 200]), ('inverted', [200, 0, 0, 64]),
                 ('valid', [0, 0, 200, 64])]
        for name, bounds in cases:
            with self.subTest(case=name):
                self.manifest = copy.deepcopy(original)
                self.payloads = copy.deepcopy(original_payloads)
                self.manifest['cells'][0]['collision'] = {**self.pin_payload('cells/c0.hcol', collision), 'boundsXZ': bounds}
                self.compress_simulation(self.manifest['cells'][0]['collision'])
                self.build_inputs()
                if name == 'valid':
                    self.assertEqual(self.stage()['status'], 'PASS')
                else:
                    self.assert_optimized_refused('boundsXZ')

    def test_shared_texture_references_require_the_approved_directory_and_image_extensions(self):
        textures = self.optimized_textures()
        original = copy.deepcopy(self.manifest)
        original_payloads = copy.deepcopy(self.payloads)
        for renamed in ['assets/' + textures[0]['sha256'] + '.png',
                        'textures/' + textures[0]['sha256'] + '.json']:
            with self.subTest(path=renamed):
                self.manifest = copy.deepcopy(original)
                self.payloads = copy.deepcopy(original_payloads)
                self.payloads[renamed] = self.payloads.pop(textures[0]['path'])
                self.manifest['sharedTextures'][0]['path'] = renamed
                self.build_inputs()
                self.assert_optimized_refused('invalid shared texture reference')

    def test_external_glb_image_urls_and_traversal_are_rejected_for_cells_and_actors(self):
        textures = self.optimized_textures()
        original = copy.deepcopy(self.manifest)
        original_payloads = copy.deepcopy(self.payloads)
        uri_cases = ['https://example.invalid/image.png', '//example.invalid/image.png',
                     'data:image/png;base64,AAAA', '../../textures/' + Path(textures[0]['path']).name,
                     '../textures/../' + Path(textures[0]['path']).name,
                     '../textures/%2e%2e/image.png', '..\\textures\\image.png']
        for model in ['cells/c0.glb', 'assets/snow.glb']:
            for uri in uri_cases:
                with self.subTest(model=model, uri=uri):
                    self.manifest = copy.deepcopy(original)
                    self.payloads = copy.deepcopy(original_payloads)
                    reference = self.pin_payload(model, minimal_glb({'images': [{'uri': uri}]}))
                    if model.startswith('cells/'):
                        self.manifest['cells'][0]['visual']['lod0'] = reference
                    else:
                        self.manifest['assets'][0].update(reference)
                    self.build_inputs()
                    self.assert_optimized_refused('unapproved external GLB image URI')

    def test_external_image_must_be_manifest_pinned_without_an_embedded_buffer_view(self):
        textures = self.optimized_textures()
        original = copy.deepcopy(self.manifest['cells'][0]['visual']['lod0'])
        cases = [({'uri': '../textures/' + 'b' * 64 + '.png'}, 'not pinned'),
                 ({'uri': '../' + textures[0]['path'], 'bufferView': 0}, 'unapproved external')]
        for image, message in cases:
            with self.subTest(image=image):
                self.manifest['cells'][0]['visual']['lod0'] = self.pin_payload(
                    original['path'], minimal_glb({'images': [image]}))
                self.build_inputs()
                self.assert_optimized_refused(message)

    def test_shared_texture_inventory_rejects_duplicates_unused_files_and_invalid_types(self):
        textures = self.optimized_textures()
        original = copy.deepcopy(self.manifest)
        original_payloads = copy.deepcopy(self.payloads)
        for mode in ['duplicate', 'unused', 'wrong-type', 'invalid-entry']:
            with self.subTest(mode=mode):
                self.manifest = copy.deepcopy(original)
                self.payloads = copy.deepcopy(original_payloads)
                if mode == 'duplicate':
                    self.manifest['sharedTextures'].append(copy.deepcopy(textures[0]))
                elif mode == 'unused':
                    self.manifest['sharedTextures'].append(self.pin_payload(
                        'textures/' + sha(b'unused') + '.png', b'unused'))
                elif mode == 'wrong-type':
                    # Retain every pinned file so archive closure succeeds and the
                    # sharedTextures type check itself rejects this object shape.
                    self.manifest['sharedTextures'] = dict(zip(['first', 'second'], textures))
                else:
                    self.manifest['sharedTextures'].append('invalid')
                self.build_inputs()
                self.assert_optimized_refused('shared texture|sharedTextures')

    def test_shared_texture_mode_requires_real_glb_envelopes_for_every_runtime_model(self):
        self.optimized_textures()
        original = copy.deepcopy(self.manifest)
        original_payloads = copy.deepcopy(self.payloads)
        for model in ['cells/c0.glb', 'assets/snow.glb']:
            with self.subTest(model=model):
                self.manifest = copy.deepcopy(original)
                self.payloads = copy.deepcopy(original_payloads)
                reference = self.pin_payload(model, b'legacy opaque fake GLB')
                if model.startswith('cells/'):
                    self.manifest['cells'][0]['visual']['lod0'] = reference
                else:
                    self.manifest['assets'][0].update(reference)
                self.build_inputs()
                self.assert_optimized_refused('optimized runtime model must be a valid GLB')

    def test_external_glb_buffers_are_rejected_for_cells_and_actors(self):
        self.optimized_textures()
        original = copy.deepcopy(self.manifest)
        original_payloads = copy.deepcopy(self.payloads)
        for model in ['cells/c0.glb', 'assets/snow.glb']:
            with self.subTest(model=model):
                self.manifest = copy.deepcopy(original)
                self.payloads = copy.deepcopy(original_payloads)
                reference = self.pin_payload(model, minimal_glb({'buffers': [{'byteLength': 4, 'uri': '../hidden.bin'}]}))
                if model.startswith('cells/'):
                    self.manifest['cells'][0]['visual']['lod0'] = reference
                else:
                    self.manifest['assets'][0].update(reference)
                self.build_inputs()
                self.assert_optimized_refused('external GLB buffers are not approved')


if __name__ == '__main__':
    unittest.main()
