"""Offline tests for tm3d_lib (numpy only, no Blender): python -m unittest discover -s tests -v"""
import sys
import unittest
from pathlib import Path

import numpy as np

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import tm3d_lib as L  # noqa: E402


class RasterizeTest(unittest.TestCase):
    def test_coverage_matches_area(self):
        tri = np.array([[[2.0, 3.0], [60.0, 10.0], [20.0, 50.0]]])
        r = L.rasterize(tri, 64, 64)
        area = 0.5 * abs((60 - 2) * (50 - 3) - (10 - 3) * (20 - 2))
        self.assertAlmostEqual(len(r['x']) / area, 1.0, delta=0.05)
        np.testing.assert_allclose(r['bary'].sum(1), 1.0, atol=1e-5)

    def test_big_and_small_triangles_and_clipping(self):
        tris = np.array([[[-10, -10], [300, -10], [-10, 300]], [[5.2, 5.2], [5.8, 5.2], [5.2, 5.8]]], float)
        r = L.rasterize(tris, 100, 100)
        self.assertTrue((r['x'] >= 0).all() and (r['x'] < 100).all() and (r['y'] < 100).all())
        self.assertEqual(int((r['tri'] == 0).sum()), 100 * 100)  # big triangle covers the whole clipped image
        self.assertEqual(int((r['tri'] == 1).sum()), 0)  # contains no pixel centre

    def test_quad_split_has_no_gaps(self):
        quad = np.array([[[0, 0], [31, 0], [31, 31]], [[0, 0], [31, 31], [0, 31]]], float)
        r = L.rasterize(quad, 32, 32)
        self.assertEqual(len(np.unique(r['y'] * 32 + r['x'])), 32 * 32)

    def test_nearest_fragments(self):
        pix = np.array([5, 5, 7, 5])
        depth = np.array([3.0, 1.0, 2.0, 2.0])
        keep = L.nearest_fragments(pix, depth)
        self.assertEqual(sorted(keep.tolist()), [1, 2])


class ColourAndFillTest(unittest.TestCase):
    def test_srgb_roundtrip(self):
        x = np.linspace(0, 1, 101, dtype=np.float32)
        np.testing.assert_allclose(L.linear_to_srgb(L.srgb_to_linear(x)), x, atol=2e-6)

    def test_push_pull_fills_holes_with_neighbour_colour(self):
        img = np.zeros((33, 47, 3), np.float32)
        img[..., 0] = 0.8
        known = np.zeros((33, 47), bool)
        known[10:20, 5:15] = True
        out = L.push_pull_fill(img * known[..., None], known)
        np.testing.assert_allclose(out[..., 0], 0.8, atol=1e-5)

    def test_tone_gains_recolour_unseen_parts_to_the_seen_tone(self):
        rng = np.random.default_rng(1)
        orig = np.zeros((64, 64, 3), np.float32)
        orig[:, :32] = [0.20, 0.10, 0.05]  # brown skin
        orig[:, 32:] = [0.05, 0.10, 0.30]  # denim
        orig *= rng.uniform(0.9, 1.1, (64, 64, 1)).astype(np.float32)  # shading
        proj = np.zeros_like(orig)
        proj[:, :32] = [0.60, 0.40, 0.30]  # light skin in the images
        proj[:, 32:] = [0.01, 0.02, 0.06]  # navy
        proj[5:12, 5:12] = [0.9, 0.9, 0.9]  # a badge painted over seen skin
        conf = np.zeros((64, 64), np.float32)
        conf[:20] = 1.0  # only the top rows were seen
        g = L.tone_gains([orig], [proj], [conf], [np.ones((64, 64), bool)])[0]
        np.testing.assert_allclose((orig * g)[50:, 4:28].mean((0, 1)), [0.60, 0.40, 0.30], rtol=0.1)
        np.testing.assert_allclose((orig * g)[50:, 36:60].mean((0, 1)), [0.01, 0.02, 0.06], rtol=0.1)

    def test_palette_merges_shades_of_one_colour_and_keeps_other_hues(self):
        rng = np.random.default_rng(1)
        navy, skin = np.array([0.02, 0.03, 0.10]), np.array([0.60, 0.40, 0.30])
        px = np.concatenate([navy * rng.uniform(0.4, 1.6, (3000, 1)), skin * rng.uniform(0.8, 1.2, (1500, 1))]).astype(np.float32)
        cent, group, n = L.palette(px, 4)
        lab = group[L.nearest_centre(L.chroma_features(np.array([navy * 0.5, navy * 1.5, skin], np.float32)), cent)]
        self.assertEqual(lab[0], lab[1])  # light and dark navy: one region
        self.assertNotEqual(lab[0], lab[2])
        self.assertGreaterEqual(n, 2)

    def test_palette_of_several_views_keeps_the_first_views_colours_and_adds_only_new_ones(self):
        rng = np.random.default_rng(3)
        navy, skin, white, red = (np.array(c) for c in ([0.02, 0.03, 0.10], [0.60, 0.40, 0.30], [0.80, 0.80, 0.78], [0.60, 0.04, 0.03]))
        front = np.concatenate([navy * rng.uniform(0.6, 1.4, (6000, 1)), skin * rng.uniform(0.8, 1.2, (2500, 1)), np.tile(white, (800, 1))])
        back = np.concatenate([navy * rng.uniform(0.6, 1.4, (9000, 1)), np.tile(red, (2000, 1))])
        cent, group, n = L.palette([front.astype(np.float32), back.astype(np.float32)], 7)
        lab = group[L.nearest_centre(L.chroma_features(np.array([navy, skin, white, red], np.float32)), cent)]
        self.assertEqual(len(set(lab.tolist())), 4)  # the back-only red is added; the back's navy joins the front's
        self.assertEqual(n, L.palette(front.astype(np.float32), 7)[2] + 1)
        np.testing.assert_array_equal(cent[:7], L.palette(front.astype(np.float32), 7)[0])

    def test_tone_step_holds_brightness_when_shine_keeps_the_render_too_light(self):
        photo, spec = np.array([0.02, 0.03, 0.09]), np.array([0.07, 0.075, 0.08])
        render = lambda s: 4.0 * photo * s + spec  # noqa: E731  lit diffuse plus shine the base colour can't remove
        s1, floor1 = L.tone_step(photo, render(np.ones(3)), np.ones(3))
        self.assertFalse(floor1)
        s2, floor2 = L.tone_step(photo, render(s1), s1, render(np.ones(3)), np.ones(3), damping=0.5)
        self.assertTrue(floor2)
        lum = np.array([0.2126, 0.7152, 0.0722])
        self.assertAlmostEqual((photo * s2) @ lum / ((photo * s1) @ lum), 1.0, delta=0.15)  # not driven to black
        reachable = lambda s: 4.0 * photo * s + 0.1 * photo  # noqa: E731
        s1, _ = L.tone_step(photo, reachable(np.ones(3)), np.ones(3))
        s2, floor2 = L.tone_step(photo, reachable(s1), s1, reachable(np.ones(3)), np.ones(3), damping=0.5)
        self.assertFalse(floor2)
        np.testing.assert_allclose(reachable(s2), photo, rtol=0.05)

    def test_tone_step_solves_dark_channels_alone_so_grey_shine_does_not_wash_out_navy(self):
        photo, spec = np.array([0.022, 0.033, 0.109]), np.array([0.023, 0.027, 0.020])
        render = lambda s: 2.6 * photo * s + spec  # noqa: E731  navy cloth with neutral shine
        s1, _ = L.tone_step(photo, render(np.ones(3)), np.ones(3))
        s2, floor2 = L.tone_step(photo, render(s1), s1, render(np.ones(3)), np.ones(3), damping=0.5)
        self.assertFalse(floor2)
        r2 = render(s2)
        self.assertAlmostEqual(r2[2], photo[2], delta=0.1 * photo[2])  # the channel the cloth carries lands
        self.assertGreater(r2[2] / r2[0], 0.8 * photo[2] / photo[0])  # and stays as blue as the photo

    def test_log_mode_finds_the_dominant_colour_despite_shading_and_specks(self):
        rng = np.random.default_rng(2)
        main = np.array([0.5, 0.3, 0.2]) * rng.uniform(0.9, 1.1, (4000, 1))
        specks = rng.uniform(0, 1, (1500, 3))
        m = L.log_mode(np.concatenate([main, specks]).astype(np.float32))
        np.testing.assert_allclose(m, [0.5, 0.3, 0.2], rtol=0.2)

    def test_bilinear_centres_and_wrap(self):
        img = np.arange(12, dtype=np.float32).reshape(3, 4, 1)
        self.assertAlmostEqual(float(L.bilinear(img, np.array([1.0]), np.array([2.0]))[0, 0]), 9.0)
        self.assertAlmostEqual(float(L.bilinear(img, np.array([1.5]), np.array([0.0]))[0, 0]), 1.5)
        self.assertAlmostEqual(float(L.bilinear(img, np.array([3.5]), np.array([0.0]), wrap=True)[0, 0]), 1.5)

    def test_foreground_mask_border_key_keeps_inner_background_colour(self):
        img = np.ones((80, 80, 3), np.float32)
        img[20:60, 20:60] = [0.2, 0.3, 0.9]
        img[35:45, 35:45] = 1.0  # white patch inside the figure is not background
        mask, how = L.foreground_mask(img)
        self.assertEqual(how, 'backdrop-key')
        self.assertTrue(mask[40, 40] and mask[25, 25] and not mask[5, 5])

    def test_foreground_mask_gradient_backdrop_and_floor_shadow(self):
        h, w = 120, 100
        ramp = np.linspace(0.45, 0.85, h, dtype=np.float32)[:, None, None]
        img = np.broadcast_to(ramp * np.array([0.95, 0.97, 1.0], np.float32), (h, w, 3)).copy()
        img[20:95, 35:65] = [0.08, 0.1, 0.3]  # navy figure
        img[95:105, 25:75] *= 0.6  # neutral contact shadow under it
        img[45:60, 25:36] *= 0.6  # grey holster on the hip, as dark as the shadow: not a shadow up there
        mask, how = L.foreground_mask(img)
        self.assertEqual(how, 'backdrop-key')
        self.assertTrue(mask[50, 50] and not mask[100, 30] and not mask[5, 5] and not mask[110, 90])
        self.assertTrue(mask[52, 28])

    def test_erode_and_feather(self):
        m = np.zeros((20, 20), bool)
        m[5:15, 5:15] = True
        self.assertEqual(int(L.erode(m, 2).sum()), 36)
        f = L.edge_feather(m, 3)
        self.assertEqual(float(f[10, 10]), 1.0)
        self.assertLess(float(f[5, 10]), float(f[7, 10]))


class CameraAndFitTest(unittest.TestCase):
    def test_ortho_projection_axes(self):
        f, r, u = L.AXIS_VIEWS['front']
        cam = L.Camera({'kind': 'ORTHO', 'width': 101, 'height': 101, 'forward': f, 'right': r, 'up': u,
                        'center': [0, 0, 1], 'pixels_per_metre': 100})
        x, y, _ = cam.project(np.array([[0.1, 0, 1.2]]))
        self.assertAlmostEqual(float(x[0]), 60.0)
        self.assertAlmostEqual(float(y[0]), 30.0)  # +Z is up the image

    def test_side_cameras_are_mirrors(self):
        p = np.array([[0.0, -0.3, 1.0]])  # a nose in front of the character
        for key, sign in (('cam+x', -1), ('cam-x', 1)):
            f, r, u = L.AXIS_VIEWS[key]
            cam = L.Camera({'kind': 'ORTHO', 'width': 101, 'height': 101, 'forward': f, 'right': r, 'up': u,
                            'center': [0, 0, 1], 'pixels_per_metre': 100})
            x, _, _ = cam.project(p)
            self.assertEqual(np.sign(float(x[0]) - 50), sign)

    def test_fit_ortho_recovers_scale_and_offset(self):
        # model silhouette: an L shape in metres, extent a in [0, 1], b in [0, 2]
        hm, wm = 400, 200
        sil = np.zeros((hm, wm), bool)
        sil[40:360, 30:80] = True
        sil[300:360, 30:170] = True
        ext = (0.0, 1.0, 0.0, 2.0)
        # reference: same shape at 150 px/m with the image centre at plane point (0.45, 1.1)
        ppm, ac, bc, w, h = 150.0, 0.45, 1.1, 260, 330
        ys, xs = np.mgrid[0:h, 0:w]
        a = ac + (xs - (w - 1) / 2) / ppm
        b = bc - (ys - (h - 1) / 2) / ppm
        col = np.floor(a * wm).astype(int)
        row = np.floor((2.0 - b) / 2.0 * hm).astype(int)
        ok = (col >= 0) & (col < wm) & (row >= 0) & (row < hm)
        ref = np.zeros((h, w), bool)
        ref[ok] = sil[row[ok], col[ok]]
        fit = L.fit_ortho(sil, ext, ref)
        self.assertGreater(fit['iou'], 0.97)
        self.assertAlmostEqual(fit['ppm'] / ppm, 1.0, delta=0.02)
        self.assertAlmostEqual(fit['a_center'], ac, delta=0.01)
        self.assertAlmostEqual(fit['b_center'], bc, delta=0.01)

    def test_look_basis_matches_axis_views(self):
        for (az, el), key in (((0, 0), 'front'), ((90, 0), 'cam+x'), ((180, 0), 'back'), ((270, 0), 'cam-x'),
                              ((0, 90), 'top'), ((0, -90), 'bottom')):
            f, r, u, out = L.look_basis(az, el)
            for got, want in zip((f, r, u), L.AXIS_VIEWS[key]):
                np.testing.assert_allclose(got, want, atol=1e-9, err_msg=key)
            np.testing.assert_allclose(out, -f)

    def test_view_coords_perspective_shrinks_with_depth(self):
        f, r, u, _ = L.look_basis(0, 0)
        pts = np.array([[0.1, -0.5, 0.0], [0.1, 0.5, 0.0]])  # same lateral offset, nearer and farther
        a, _, ok = L.view_coords(pts, f, r, u, [0, 0, 0], distance=2.0)  # metres at the target's depth
        self.assertTrue(ok.all())
        self.assertAlmostEqual(float(a[0]), 0.1 * 2.0 / 1.5)
        self.assertAlmostEqual(float(a[1]), 0.1 * 2.0 / 2.5)
        a_o, _, _ = L.view_coords(pts, f, r, u, [0, 0, 0])
        np.testing.assert_allclose(a_o, 0.1)

    def test_distance_transform_is_exact_within_cap(self):
        rng = np.random.default_rng(3)
        m = rng.random((40, 50)) > 0.97
        d = L.distance_to(m, 30)
        ys, xs = np.nonzero(m)
        gy, gx = np.mgrid[0:40, 0:50]
        brute = np.sqrt(((gy[..., None] - ys) ** 2 + (gx[..., None] - xs) ** 2).min(axis=-1))
        np.testing.assert_allclose(d, np.minimum(brute, 30), atol=1e-5)

    def test_warp_aligns_shifted_and_scaled_silhouette(self):
        gy, gx = np.mgrid[0:200, 0:160]
        model = ((gx - 80) / 35.0) ** 2 + ((gy - 100) / 60.0) ** 2 <= 1
        model |= (np.abs(gx - 80) < 70) & (np.abs(gy - 70) < 6)  # arms
        ref = ((gx - 86) / 40.0) ** 2 + ((gy - 96) / 66.0) ** 2 <= 1
        ref |= (np.abs(gx - 86) < 72) & (np.abs(gy - 64) < 7)
        before = L.iou(model, ref)
        u = L.warp_masks(model, ref)
        after = L.iou(model, L.pull_back(ref, u))
        self.assertLess(before, 0.85)
        self.assertGreater(after, 0.95)
        self.assertAlmostEqual(float(u[100, 80, 0]), 6.0, delta=2.0)  # centre follows the outline

    def test_similarity_transform(self):
        rng = np.random.default_rng(1)
        src = rng.normal(size=(50, 3))
        c, s = np.cos(0.3), np.sin(0.3)
        rot = np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])
        dst = 1.7 * src @ rot.T + [0.2, -1, 3]
        k, r, t = L.similarity_transform(src, dst)
        np.testing.assert_allclose(k * src @ r.T + t, dst, atol=1e-9)

    def test_accumulate(self):
        sw, swv, mw = L.accumulate(3, np.array([0, 0, 2]), np.array([1.0, 3.0, 2.0]), np.array([[1.0], [2.0], [5.0]]))
        np.testing.assert_allclose(sw, [4, 0, 2])
        np.testing.assert_allclose(swv[:, 0], [7, 0, 10])
        np.testing.assert_allclose(mw, [3, 0, 2])


if __name__ == '__main__':
    unittest.main()
