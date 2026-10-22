"""Publication must bind each configured pedestrian appearance to an actual character asset."""
import importlib.util
from pathlib import Path
import unittest


SPEC = importlib.util.spec_from_file_location('civilian_pages_validation', Path(__file__).resolve().parents[1] / 'stage-pages-world.py')
pages = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(pages)


class CivilianAssetsTest(unittest.TestCase):
    @staticmethod
    def manifest(*variants):
        return {'assets': [{'id': f'character-civilian-{variant}', 'kind': 'character'} for variant in variants]}

    def test_older_world_without_civilian_configuration_remains_valid(self):
        pages._validate_civilian_assets({}, {'assets': []})
        pages._validate_civilian_assets({'civilianVariants': []}, {'assets': []})

    def test_each_available_civilian_variant_has_its_own_character_identity(self):
        variants = ['rain-black', 'rain-white', 'snow-black']
        pages._validate_civilian_assets({'civilianVariants': variants}, self.manifest(*variants))
        for variant in variants:
            with self.subTest(missing=variant), self.assertRaisesRegex(ValueError, 'no character asset'):
                pages._validate_civilian_assets({'civilianVariants': variants}, self.manifest(*(v for v in variants if v != variant)))

    def test_source_rain_or_snow_asset_cannot_substitute_for_a_declared_civilian(self):
        for variant in ['rain-black', 'rain-white', 'snow-black']:
            with self.subTest(variant=variant), self.assertRaisesRegex(ValueError, 'no character asset'):
                pages._validate_civilian_assets({'civilianVariants': [variant]}, {'assets': [
                    {'id': 'character-rain', 'kind': 'character'}, {'id': 'character-snow', 'kind': 'character'}]})

    def test_matching_noncharacter_asset_does_not_enable_a_civilian(self):
        for kind in ['vehicle', 'prop', 'scenery', None]:
            with self.subTest(kind=kind), self.assertRaisesRegex(ValueError, 'no character asset'):
                pages._validate_civilian_assets({'civilianVariants': ['rain-white']}, {'assets': [
                    {'id': 'character-civilian-rain-white', 'kind': kind}]})

    def test_unavailable_optional_character_cannot_be_declared(self):
        with self.assertRaisesRegex(ValueError, 'no character asset'):
            pages._validate_civilian_assets({'civilianVariants': ['agent47']}, self.manifest('rain-black', 'rain-white', 'snow-black'))
        # A later release can declare it only once its own actual character payload is present.
        pages._validate_civilian_assets({'civilianVariants': ['agent47']}, self.manifest('agent47'))

    def test_invalid_variant_configuration_is_rejected_before_publication(self):
        invalid = [None, 'rain-black', {}, 1, True, ['rain-black', 'rain-black'], ['RAIN-BLACK'],
                   ['unknown'], [None], [4], [{}], [['rain-black']], ['rain-black'] * 5]
        for variants in invalid:
            with self.subTest(variants=variants), self.assertRaisesRegex(ValueError, 'invalid civilian appearances'):
                pages._validate_civilian_assets({'civilianVariants': variants}, self.manifest('rain-black', 'rain-white', 'snow-black', 'agent47'))


if __name__ == '__main__':
    unittest.main()
