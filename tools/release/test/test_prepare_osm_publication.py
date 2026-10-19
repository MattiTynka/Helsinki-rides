import copy
import gzip
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('osm_publication', Path(__file__).resolve().parents[1] / 'prepare-osm-publication.py')
publication = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(publication)


class OsmPublicationTest(unittest.TestCase):
    def fixture(self):
        address = 'public-business' + '@' + 'mail.invalid'
        return {'copyright': 'OpenStreetMap contributors', 'license': 'ODbL 1.0', 'elements': [
            {'type': 'node', 'id': 1, 'lat': 60.17, 'lon': 24.95, 'user': 'contributor', 'uid': 123,
             'tags': {'highway': 'crossing', 'email': address, 'contact:phone': '+000',
                      'Contact:Website': 'https://example.org/', 'note': address.replace('@', '%40')}},
            {'type': 'way', 'id': 2, 'nodes': [1, 3], 'tags': {'highway': 'service', 'name': 'Street',
             'access': 'yes', 'lanes:forward': '1', 'bridge': 'yes'}},
            {'type': 'relation', 'id': 4, 'members': [{'type': 'way', 'ref': 2, 'role': 'from'}],
             'tags': {'type': 'restriction', 'restriction': 'no_left_turn'}},
        ]}

    def test_minimization_preserves_geometry_routing_and_source_notices(self):
        original = self.fixture()
        before = copy.deepcopy(original)
        result, removed = publication.minimize(original)
        self.assertEqual(original, before)
        self.assertEqual(result['elements'][0], {'type': 'node', 'id': 1, 'lat': 60.17, 'lon': 24.95,
                                                'tags': {'highway': 'crossing'}})
        self.assertEqual(result['elements'][1:], original['elements'][1:])
        self.assertEqual(result['copyright'], original['copyright'])
        self.assertEqual(result['license'], original['license'])
        self.assertEqual(removed, {'user': 1, 'uid': 1, 'contactTags': 3, 'emailValueTags': 1})

    def test_publication_is_deterministic_and_hashes_describe_actual_transformation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, ledger = root / 'input.json', root / 'ledger.json'
            original = publication.encoded(self.fixture())
            source.write_bytes(original)
            ledger.write_text(json.dumps({'source': {'id': 'osm'}, 'snapshots': {'test': {
                'sha256': hashlib.sha256(original).hexdigest()}}}), encoding='utf8')
            first = publication.prepare(source, ledger, root / 'public')
            compressed = (root / 'public/osm-source.json.gz').read_bytes()
            ledger_bytes = (root / 'public/osm-source-ledger.json').read_bytes()
            second = publication.prepare(source, ledger, root / 'public')
            self.assertEqual(first, second)
            self.assertEqual(compressed, (root / 'public/osm-source.json.gz').read_bytes())
            self.assertEqual(ledger_bytes, (root / 'public/osm-source-ledger.json').read_bytes())
            decoded = gzip.decompress(compressed)
            self.assertEqual(hashlib.sha256(decoded).hexdigest(), first['publication']['uncompressedSha256'])
            self.assertNotEqual(first['publication']['uncompressedSha256'], first['originalInput']['sha256'])
            self.assertEqual(source.read_bytes(), original)
            self.assertNotIn(str(root), ledger_bytes.decode('utf8'))

    def test_source_hash_mismatch_and_input_output_overlap_fail(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, ledger = root / 'input.json', root / 'ledger.json'
            source.write_bytes(publication.encoded(self.fixture()))
            ledger.write_text(json.dumps({'snapshots': {'test': {'sha256': '0' * 64}}}), encoding='utf8')
            with self.assertRaises(ValueError):
                publication.prepare(source, ledger, root / 'public')
            with self.assertRaises(ValueError):
                publication.prepare(source, ledger, root)

    def test_existing_publication_hardlink_cannot_mutate_original_source(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, ledger, output = root / 'input.json', root / 'ledger.json', root / 'public'
            original = publication.encoded(self.fixture())
            source.write_bytes(original)
            ledger.write_text(json.dumps({'source': {'id': 'osm'}, 'snapshots': {'test': {
                'sha256': hashlib.sha256(original).hexdigest()}}}), encoding='utf8')
            output.mkdir()
            os.link(source, output / 'osm-source.json.gz')
            publication.prepare(source, ledger, output)
            self.assertEqual(source.read_bytes(), original)
            self.assertEqual(json.loads(gzip.decompress((output / 'osm-source.json.gz').read_bytes())),
                             publication.minimize(self.fixture())[0])


if __name__ == '__main__':
    unittest.main()
