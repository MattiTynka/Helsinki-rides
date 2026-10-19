import unittest

import numpy as np

import geom2d as g


def square(size=10.0):
    return np.array([[0.0, 0.0], [size, 0.0], [size, size], [0.0, size]])


class PolygonTest(unittest.TestCase):
    def test_orientation_and_holes(self):
        outer, hole = square(10)[::-1], np.array([[4.0, 4.0], [6.0, 4.0], [6.0, 6.0], [4.0, 6.0]])
        rings = g.orient_polygon([outer, hole])
        self.assertGreater(g.signed_area(rings[0]), 0)  # outer counter-clockwise
        self.assertLess(g.signed_area(rings[1]), 0)  # hole clockwise
        inside = g.points_in_polygon(np.array([[1.0, 1.0], [5.0, 5.0], [11.0, 5.0]]), rings)
        self.assertEqual(inside.tolist(), [True, False, False])

    def test_weighted_offset_keeps_zero_weight_edges(self):
        ring = g.orient_polygon([square(10)])[0]
        inset = g.offset_ring_weighted(ring, -1.0 * np.array([1.0, 0.0, 1.0, 1.0]))
        lo, hi = inset.min(axis=0), inset.max(axis=0)
        self.assertAlmostEqual(lo[1], 1.0)  # edge 0 (south) moved in
        self.assertAlmostEqual(hi[0], 10.0)  # edge 1 (east, weight 0) stayed on the footprint
        self.assertAlmostEqual(hi[1], 9.0)
        self.assertAlmostEqual(lo[0], 1.0)

    def test_safe_inset_backs_off_before_a_ring_inverts(self):
        thin = g.orient_polygon([np.array([[0.0, 0.0], [10.0, 0.0], [10.0, 1.0], [0.0, 1.0]])])
        d, inset = g.safe_inset(thin, 2.0, minimum=0.1)
        self.assertGreater(d, 0.0)
        self.assertLess(d, 0.5)
        self.assertTrue(g.rings_are_simple(inset))
        self.assertGreater(g.signed_area(inset[0]), 0)


if __name__ == "__main__":
    unittest.main()
