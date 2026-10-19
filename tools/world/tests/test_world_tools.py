import json
import math
import unittest

from fetch_footprints import check_gk25


class FootprintTest(unittest.TestCase):
    def test_swapped_axes_are_rejected(self):
        good = {"geometry": {"type": "Polygon", "coordinates": [[[25497300, 6673000], [25497310, 6673000], [25497300, 6673010]]]}}
        check_gk25([good])
        swapped = {"geometry": {"type": "Polygon", "coordinates": [[[6673000, 25497300], [6673000, 25497310], [6673010, 25497300]]]}}
        with self.assertRaises(ValueError):
            check_gk25([swapped])


if __name__ == "__main__":
    unittest.main()
