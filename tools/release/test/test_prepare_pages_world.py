import copy
import gzip
import importlib.util
import json
from pathlib import Path
import struct
import tarfile
import tempfile
import unittest


SPEC = importlib.util.spec_from_file_location('prepare_pages_world', Path(__file__).resolve().parents[1] / 'prepare-pages-world.py')
pack = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(pack)


def texture(width=16, height=8, scheme=0, count=None, kvd=None):
    count = count or max(width, height).bit_length()
    dfd = bytearray(44)
    struct.pack_into('<IHHHH', dfd, 0, 44, 0, 0, 2, 40)
    dfd[12:20] = bytes((166, 1, 2, 0, 3, 3, 0, 0))
    dfd[20] = 16
    if kvd is None:
        field = b'KTXwriter\0Synthetic public fixture\0'
        kvd = struct.pack('<I', len(field)) + field
        kvd += b'\0' * (-len(kvd) % 4)
    out = bytearray(80 + count * 24)
    do = len(out)
    out.extend(dfd)
    ko = len(out)
    out.extend(kvd)
    levels = [None] * count
    for i in reversed(range(count)):
        raw = ((max(1, width >> i) + 3) // 4) * ((max(1, height >> i) + 3) // 4) * 16
        out.extend(b'\0' * (-len(out) % (16 if scheme == 0 else 1)))
        payload = bytes((32 + i,)) * (raw if scheme == 0 else raw // 2 + 5)
        levels[i] = (len(out), len(payload), raw)
        out.extend(payload)
    out[:12] = pack.KTX2
    struct.pack_into('<13I2Q', out, 12, 0, 1, width, height, 0, 0, 1, count, scheme, do, 44, ko, len(kvd), 0, 0)
    for i, level in enumerate(levels):
        struct.pack_into('<3Q', out, 80 + 24 * i, *level)
    return bytes(out)


def glb(doc, binary):
    doc = copy.deepcopy(doc)
    doc['buffers'][0]['byteLength'] = len(binary)
    data = pack.json_bytes(doc).rstrip(b'\n')
    data += b' ' * (-len(data) % 4)
    binary += b'\0' * (-len(binary) % 4)
    return struct.pack('<III', 0x46546c67, 2, 28 + len(data) + len(binary)) + struct.pack('<II', len(data), 0x4e4f534a) + data + struct.pack('<II', len(binary), 0x004e4942) + binary


def fixture_glb(two_images=False):
    image = texture()
    binary = b'HEAD' + image
    binary += b'\0' * (-len(binary) % 4)
    geometry_offset = len(binary)
    binary += b'EXACT-MESHOPT-BYTES!!'
    binary += b'\0' * (-len(binary) % 4)
    second_offset = len(binary)
    if two_images:
        binary += texture(8, 8)
    doc = {'asset': {'version': '2.0', 'extras': {'attribution': 'Public photographer, CC BY4.0'}},
           'buffers': [{'byteLength': len(binary)}, {'byteLength': 9999, 'extensions': {'EXT_meshopt_compression': {'fallback': True}}}],
           'bufferViews': [{'buffer': 0, 'byteOffset': 4, 'byteLength': len(image)},
                           {'buffer': 1, 'byteOffset': 123, 'byteLength': 456,
                            'extensions': {'EXT_meshopt_compression': {'buffer': 0, 'byteOffset': geometry_offset, 'byteLength': 20, 'count': 5, 'byteStride': 4, 'mode': 'ATTRIBUTES'}}},
                           {'buffer': 0, 'byteOffset': 0, 'byteLength': 4}],
           'images': [{'mimeType': 'image/ktx2', 'bufferView': 0}],
           'meshes': [{'primitives': [{'attributes': {'POSITION': 0}}]}],
           'accessors': [{'bufferView': 1, 'componentType': 5126, 'count': 5, 'type': 'SCALAR'}],
           'nodes': [{'mesh': 0, 'translation': [1, 2, 3]}]}
    if two_images:
        doc['bufferViews'].append({'buffer': 0, 'byteOffset': second_offset, 'byteLength': len(texture(8, 8))})
        doc['images'].append({'mimeType': 'image/ktx2', 'bufferView': 3})
    return glb(doc, binary)


class KtxTest(unittest.TestCase):
    def test_retains_original_mips_metadata_and_index_for_both_supported_schemes(self):
        for scheme in (0, 2):
            with self.subTest(scheme=scheme):
                original = texture(32, 16, scheme)
                result, resident, dropped = pack.trim_ktx2(original, 8)
                before, after = pack.ktx_info(original), pack.ktx_info(result)
                self.assertEqual((dropped, after['width'], after['height']), (2, 8, 4))
                self.assertEqual(before['dfd'], after['dfd'])
                self.assertEqual(before['kvd'], after['kvd'])
                for old, new in zip(before['levels'][2:], after['levels']):
                    self.assertEqual(original[old[0]:sum(old[:2])], result[new[0]:sum(new[:2])])
                    if scheme == 0:
                        self.assertEqual(new[0] % 16, 0)
                self.assertEqual(resident, 80)

    def test_small_texture_is_byte_exact(self):
        original = texture(8, 8)
        self.assertEqual(pack.trim_ktx2(original, 8), (original, 112, 0))

    def test_unchanged_etc1s_zero_uncompressed_sizes_are_valid(self):
        original = bytearray(texture(8, 8, scheme=1))
        info = pack.ktx_info(original)
        original[info['header'][9] + 12] = 163
        for i in range(len(info['levels'])):
            struct.pack_into('<Q', original, 96 + 24 * i, 0)
        original = bytes(original)
        self.assertEqual(pack.trim_ktx2(original, 8), (original, 56, 0))

    def test_missing_required_mips_and_unsupported_resize_fail(self):
        for original in (texture(16, 8, count=1), texture(16, 8, scheme=1)):
            with self.assertRaises(ValueError):
                pack.trim_ktx2(original, 4)
        original = bytearray(texture())
        struct.pack_into('<Q', original, 80, len(original) + 100)
        with self.assertRaises(ValueError):
            pack.trim_ktx2(original, 4)

    def test_unsafe_metadata_is_rejected_without_secret_echo(self):
        field = b'KTXwriter\0' + b'C:' + b'/' + b'Users/operator/private\0'
        kvd = struct.pack('<I', len(field)) + field
        kvd += b'\0' * (-len(kvd) % 4)
        with self.assertRaisesRegex(ValueError, '^Private metadata detected in KTX2 key/value$'):
            pack.trim_ktx2(texture(kvd=kvd), 4)


class GlbTest(unittest.TestCase):
    def test_multiple_replacements_preserve_meshopt_fallback_and_geometry(self):
        original = fixture_glb(True)
        result, resident, changes = pack.trim_glb(original, 4)
        before, oldbin = pack.read_glb(original)
        after, newbin = pack.read_glb(result)
        self.assertEqual(len(changes), 2)
        self.assertEqual(resident, 96)
        for key in ('meshes', 'nodes', 'accessors', 'asset', 'images'):
            self.assertEqual(before[key], after[key])
        self.assertEqual(before['buffers'][1], after['buffers'][1])
        self.assertEqual(before['bufferViews'][1]['byteOffset'], after['bufferViews'][1]['byteOffset'])
        old = before['bufferViews'][1]['extensions']['EXT_meshopt_compression']
        new = after['bufferViews'][1]['extensions']['EXT_meshopt_compression']
        self.assertEqual(oldbin[old['byteOffset']:old['byteOffset'] + 20], newbin[new['byteOffset']:new['byteOffset'] + 20])
        self.assertEqual(newbin[:4], b'HEAD')
        self.assertLess(new['byteOffset'], old['byteOffset'])
        self.assertEqual(pack.trim_glb(result, 4)[0], result)

    def test_overlapping_unrelated_buffer_range_rejected(self):
        doc, binary = pack.read_glb(fixture_glb())
        doc['bufferViews'].append({'buffer': 0, 'byteOffset': 8, 'byteLength': 16})
        with self.assertRaisesRegex(ValueError, 'overlaps replaced image'):
            pack.trim_glb(glb(doc, binary), 4)

    def test_external_image_and_invalid_glb_fail(self):
        doc, binary = pack.read_glb(fixture_glb())
        doc['images'][0] = {'uri': 'https://example.org/image.ktx2'}
        with self.assertRaises(ValueError):
            pack.trim_glb(glb(doc, binary), 4)
        with self.assertRaises(ValueError):
            pack.trim_glb(fixture_glb()[:-4], 4)


class ReleaseTest(unittest.TestCase):
    def source(self, root):
        source = root / 'source'
        source.mkdir()
        items = {'detailed.glb': fixture_glb(), 'distant.glb': b'UNCHANGED DISTANT', 'hero.glb': b'UNCHANGED HERO',
                 'collision.hcol': b'UNCHANGED COLLISION', 'roads.json': b'{"nodes":[]}'}
        file = {}
        for name, data in items.items():
            (source / name).write_bytes(data)
            file[name] = {'path': name, 'bytes': len(data), 'sha256': pack.sha(data)}
        manifest = {'schemaVersion': 2, 'worldReleaseId': 'source-v1', 'builtAt': '2000-01-01', 'boundsRuntimeXZ': [-1, -1, 1, 1],
                    'cells': [{'id': 'first', 'boundsXZ': [-1, -1, 1, 1], 'visual': {
                        'lod0': {**file['detailed.glb'], 'textureBytesEstimate': 777, 'triangles': 123},
                        'lod2': file['distant.glb']}, 'collision': file['collision.hcol']}],
                    'assets': [file['hero.glb']], 'roads': file['roads.json'],
                    'sources': [{'url': 'https://example.org', 'attribution': 'Public Creator, CC BY4.0'}]}
        (source / 'manifest.json').write_bytes(pack.json_bytes(manifest))
        return source, manifest

    def test_deterministic_complete_world_and_regular_only_archive(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source, original = self.source(root)
            pub = root / 'notices'
            pub.mkdir()
            (pub / 'credits.md').write_text('Public license credit', encoding='utf8')
            (pub / 'roads.json.gz').write_bytes(gzip.compress(b'{"nodes":[]}', mtime=0))
            first = pack.prepare(source, root / 'a', 4, 'test-pages-v1', publication_dir=pub)
            second = pack.prepare(source, root / 'b', 4, 'test-pages-v1', publication_dir=pub)
            self.assertEqual(first['archiveSha256'], second['archiveSha256'])
            self.assertEqual(first['manifestSha256'], second['manifestSha256'])
            self.assertEqual(first['sourceBytes'], sum(f.stat().st_size for f in source.iterdir()))
            dest = root / 'a/world/test-pages-v1'
            final = json.loads((dest / 'manifest.json').read_bytes())
            for name in ('hero.glb', 'distant.glb', 'collision.hcol', 'roads.json'):
                self.assertEqual((source / name).read_bytes(), (dest / name).read_bytes())
            self.assertEqual(final['cells'][0]['boundsXZ'], original['cells'][0]['boundsXZ'])
            self.assertEqual(final['cells'][0]['visual']['lod0']['triangles'], 123)
            self.assertEqual([f['path'] for f in final['publicationFiles']], ['publication/credits.md', 'publication/roads.json.gz'])
            for ref in pack.refs(final):
                self.assertEqual(ref['sha256'], pack.file_sha(dest / ref['path']))
                self.assertEqual(ref['bytes'], (dest / ref['path']).stat().st_size)
            with tarfile.open(root / 'a.tar.gz', 'r:gz') as archive:
                members = archive.getmembers()
                self.assertTrue(all(m.isreg() and not m.pax_headers for m in members))
                self.assertEqual(first['worldBytes'], sum(m.size for m in members))
                self.assertTrue(all(m.name.startswith('world/test-pages-v1/') for m in members))
                self.assertEqual(len(members), first['files'])
            self.assertEqual(json.loads((source / 'manifest.json').read_bytes()), original)

    def test_unsafe_paths_hash_mismatch_and_missing_files_fail_before_output(self):
        for case in ('path', 'hash', 'missing'):
            with tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                source, manifest = self.source(root)
                if case == 'path':
                    manifest['roads']['path'] = '../escape.json'
                elif case == 'hash':
                    manifest['roads']['sha256'] = '0' * 64
                else:
                    (source / 'roads.json').unlink()
                (source / 'manifest.json').write_bytes(pack.json_bytes(manifest))
                with self.assertRaises(ValueError):
                    pack.prepare(source, root / 'out', 4)
                self.assertFalse((root / 'out').exists())

    def test_refuses_existing_output(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source, _ = self.source(root)
            out = root / 'out'
            out.mkdir()
            (out / 'keep.txt').write_text('preserve')
            with self.assertRaises(ValueError):
                pack.prepare(source, out, 4)
            self.assertTrue((out / 'keep.txt').is_file())


if __name__ == '__main__':
    unittest.main()
