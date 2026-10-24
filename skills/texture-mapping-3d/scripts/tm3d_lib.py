"""Pure-numpy algorithms for texture-mapping-3d. No bpy import: unit-testable with any Python that has numpy.

Conventions
- Texture arrays are float32 (H, W, C) with row 0 at the BOTTOM (Blender image.pixels order, UV v=0 at row 0).
- Screen/reference arrays are float32 (H, W, C) with row 0 at the TOP (image-file order).
- Pixel centres sit at integer coordinates; a texel (x, y) covers [x-0.5, x+0.5].
- Colour blending happens in linear light; files are stored sRGB-encoded.
"""
from __future__ import annotations

import math
import numpy as np

# ---------------------------------------------------------------- colour

def srgb_to_linear(c):
    c = np.clip(np.asarray(c, dtype=np.float32), 0.0, 1.0)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4).astype(np.float32)


def linear_to_srgb(c):
    c = np.clip(np.asarray(c, dtype=np.float32), 0.0, 1.0)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1.0 / 2.4) - 0.055).astype(np.float32)


# ---------------------------------------------------------------- rasterizer

def _inside(tri, area, px, py, eps=1e-7):
    """tri (n,3,2), area (n,), px/py (n,k) int -> mask (n,k), bary (n,k,3)."""
    ax, ay = tri[:, 0, 0][:, None], tri[:, 0, 1][:, None]
    bx, by = tri[:, 1, 0][:, None], tri[:, 1, 1][:, None]
    cx, cy = tri[:, 2, 0][:, None], tri[:, 2, 1][:, None]
    inv = 1.0 / area[:, None]
    w0 = ((bx - px) * (cy - py) - (by - py) * (cx - px)) * inv
    w1 = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) * inv
    w2 = 1.0 - w0 - w1
    mask = (w0 >= -eps) & (w1 >= -eps) & (w2 >= -eps)
    return mask, np.stack([w0, w1, w2], axis=-1)


def rasterize(tri, width, height, budget=4_000_000):
    """Cover pixel centres of 2D triangles.

    tri: (T, 3, 2) pixel coordinates (x right, y along rows). Returns dict of flat arrays
    x, y (int32), tri (int64), bary (float32, (N, 3)). Pixels shared by an edge may appear twice.
    """
    tri = np.asarray(tri, dtype=np.float64)
    if tri.ndim != 3 or tri.shape[1:] != (3, 2):
        raise ValueError('tri must be (T, 3, 2)')
    out = {'x': [], 'y': [], 'tri': [], 'bary': []}
    if len(tri) == 0:
        return {k: np.zeros((0, 3) if k == 'bary' else 0, dtype=np.float32 if k == 'bary' else np.int64) for k in out}
    finite = np.isfinite(tri).all(axis=(1, 2))
    tri = np.where(finite[:, None, None], tri, 0.0)
    lo = np.ceil(tri.min(axis=1) - 1e-9).astype(np.int64)
    hi = np.floor(tri.max(axis=1) + 1e-9).astype(np.int64)
    lo = np.maximum(lo, 0)
    hi[:, 0] = np.minimum(hi[:, 0], width - 1)
    hi[:, 1] = np.minimum(hi[:, 1], height - 1)
    a, b, c = tri[:, 0], tri[:, 1], tri[:, 2]
    area = (b[:, 0] - a[:, 0]) * (c[:, 1] - a[:, 1]) - (b[:, 1] - a[:, 1]) * (c[:, 0] - a[:, 0])
    valid = finite & (hi >= lo).all(axis=1) & (np.abs(area) > 1e-12)
    span = (hi - lo + 1).max(axis=1)
    remaining = valid.copy()

    def emit(idx, px, py):
        mask, bary = _inside(tri[idx], area[idx], px, py)
        mask &= (px <= hi[idx, 0][:, None]) & (py <= hi[idx, 1][:, None])
        rows, cols = np.nonzero(mask)
        out['x'].append(px[rows, cols].astype(np.int32))
        out['y'].append(py[rows, cols].astype(np.int32))
        out['tri'].append(idx[rows])
        out['bary'].append(bary[rows, cols].astype(np.float32))

    for s in (1, 2, 4, 8, 16, 32, 64):
        sel = np.nonzero(remaining & (span <= s))[0]
        if len(sel) == 0:
            continue
        remaining[sel] = False
        oy, ox = np.mgrid[0:s, 0:s]
        ox, oy = ox.ravel(), oy.ravel()
        step = max(1, budget // (s * s))
        for i in range(0, len(sel), step):
            idx = sel[i:i + step]
            emit(idx, lo[idx, 0][:, None] + ox[None, :], lo[idx, 1][:, None] + oy[None, :])
    for t in np.nonzero(remaining)[0]:
        xs = np.arange(lo[t, 0], hi[t, 0] + 1)
        band = max(1, budget // max(1, len(xs)))
        for y0 in range(lo[t, 1], hi[t, 1] + 1, band):
            ys = np.arange(y0, min(hi[t, 1] + 1, y0 + band))
            gy, gx = np.meshgrid(ys, xs, indexing='ij')
            emit(np.array([t]), gx.ravel()[None, :], gy.ravel()[None, :])
    return {k: np.concatenate(v) if v else np.zeros(0) for k, v in out.items()}


def nearest_fragments(frag_pix, depth):
    """Indices of the nearest fragment per pixel (z-buffer by sorting)."""
    order = np.lexsort((depth, frag_pix))
    _, first = np.unique(frag_pix[order], return_index=True)
    return order[first]


# ---------------------------------------------------------------- sampling

def bilinear(img, x, y, wrap=False):
    """Sample img (H, W, C) at float pixel coords (pixel centres are integers). Clamps or wraps."""
    h, w = img.shape[:2]
    x0 = np.floor(x).astype(np.int64)
    y0 = np.floor(y).astype(np.int64)
    fx = (x - x0).astype(np.float32)[:, None]
    fy = (y - y0).astype(np.float32)[:, None]

    def idx(v, n):
        return np.mod(v, n) if wrap else np.clip(v, 0, n - 1)

    xa, xb, ya, yb = idx(x0, w), idx(x0 + 1, w), idx(y0, h), idx(y0 + 1, h)
    top = img[ya, xa] * (1 - fx) + img[ya, xb] * fx
    bot = img[yb, xa] * (1 - fx) + img[yb, xb] * fx
    return top * (1 - fy) + bot * fy


def uv_to_texel(u, v, width, height):
    """Local tile UV -> texel coordinates (bottom-up rows)."""
    return u * width - 0.5, v * height - 0.5


def udim_of(u, v):
    return 1001 + np.floor(u).astype(np.int64) + 10 * np.floor(v).astype(np.int64)


def udim_origin(tile):
    k = int(tile) - 1001
    return k % 10, k // 10


# ---------------------------------------------------------------- fill and masks

def push_pull_fill(img, known):
    """Fill pixels where known is False from known neighbours (pyramid push-pull). Returns new array."""
    img = np.asarray(img, dtype=np.float32)
    known = np.asarray(known, dtype=bool)
    if known.all():
        return img.copy()
    if not known.any():
        return img.copy()
    levels = []
    cur = img * known[..., None]
    wgt = known.astype(np.float32)
    while True:
        levels.append((cur, wgt))
        h, w = wgt.shape
        if h == 1 and w == 1:
            break
        ph, pw = h % 2, w % 2
        c = np.pad(cur, ((0, ph), (0, pw), (0, 0)))
        m = np.pad(wgt, ((0, ph), (0, pw)))
        c = c.reshape(c.shape[0] // 2, 2, c.shape[1] // 2, 2, -1).sum(axis=(1, 3))
        m = m.reshape(m.shape[0] // 2, 2, m.shape[1] // 2, 2).sum(axis=(1, 3))
        cur, wgt = c, m
    # normalise each level to colour estimates
    est = [np.where(m[..., None] > 0, c / np.maximum(m[..., None], 1e-12), 0.0) for c, m in levels]
    filled = est[-1]
    for lvl in range(len(levels) - 2, -1, -1):
        c, m = levels[lvl]
        h, w = m.shape
        up = np.repeat(np.repeat(filled, 2, axis=0), 2, axis=1)[:h, :w]
        filled = np.where(m[..., None] > 0, est[lvl], up)
    out = np.where(known[..., None], img, filled)
    return out.astype(np.float32)


def erode(mask, radius):
    """Binary erosion by a square of the given radius using shifts."""
    m = np.asarray(mask, dtype=bool)
    for _ in range(int(radius)):
        p = np.pad(m, 1, constant_values=False)
        m = p[1:-1, 1:-1] & p[:-2, 1:-1] & p[2:, 1:-1] & p[1:-1, :-2] & p[1:-1, 2:]
    return m


def edge_feather(mask, radius):
    """0..1 weight that ramps from 0 at the mask edge to 1 at `radius` pixels inside."""
    m = np.asarray(mask, dtype=bool)
    if radius <= 0:
        return m.astype(np.float32)
    acc = np.zeros(m.shape, dtype=np.float32)
    cur = m
    for _ in range(int(radius)):
        cur = erode(cur, 1)
        acc += cur
    return np.where(m, (acc + 1.0) / (radius + 1.0), 0.0).astype(np.float32)


def dilate(mask, radius):
    m = np.asarray(mask, dtype=bool)
    for _ in range(int(radius)):
        p = np.pad(m, 1, constant_values=False)
        m = p[1:-1, 1:-1] | p[:-2, 1:-1] | p[2:, 1:-1] | p[1:-1, :-2] | p[1:-1, 2:]
    return m


def background_model(rgb, band):
    """Smooth backdrop estimate (H, W, 3) interpolated from the image border (Coons patch).

    Follows vertical studio gradients and floor horizons that a single border colour cannot.
    """
    h, w = rgb.shape[:2]
    left = box_blur(np.median(rgb[:, :band], axis=1), band, axes=(0,))
    right = box_blur(np.median(rgb[:, -band:], axis=1), band, axes=(0,))
    top = box_blur(np.median(rgb[:band], axis=0), band, axes=(0,))
    bottom = box_blur(np.median(rgb[-band:], axis=0), band, axes=(0,))
    s = (np.arange(h, dtype=np.float32) / max(1, h - 1))[:, None, None]
    t = (np.arange(w, dtype=np.float32) / max(1, w - 1))[None, :, None]
    c00, c01 = (left[0] + top[0]) / 2, (right[0] + top[-1]) / 2
    c10, c11 = (left[-1] + bottom[0]) / 2, (right[-1] + bottom[-1]) / 2
    return ((1 - t) * left[:, None] + t * right[:, None] + (1 - s) * top[None] + s * bottom[None]
            - ((1 - s) * (1 - t) * c00 + (1 - s) * t * c01 + s * (1 - t) * c10 + s * t * c11)).astype(np.float32)


def foreground_mask(rgba, tol=0.08, max_dim=512, chroma_tol=0.035, shadow=(0.4, 1.15)):
    """Foreground of a reference image (top-down rows).

    Uses alpha when it varies. Otherwise models the backdrop from the border (gradients allowed),
    treats pixels near it, or neutral pixels that are only darker or lighter than it (floor
    shadows), as backdrop, and flood-fills that from the border, so a white shirt on a white
    backdrop is kept unless it touches the border region. The shadow rule applies only to the
    lowest fifth of the figure and below, where floor shadows fall; higher up, grey gear lit
    like the backdrop (a holster, a belt) stays foreground. shadow=None turns it off (a view from
    below sees no floor).
    """
    rgba = np.asarray(rgba, dtype=np.float32)
    h, w = rgba.shape[:2]
    if rgba.shape[2] == 4 and rgba[..., 3].min() < 0.5:
        return rgba[..., 3] >= 0.5, 'alpha'
    step = max(1, int(math.ceil(max(h, w) / max_dim)))
    small = rgba[::step, ::step, :3]
    band = max(2, int(round(0.015 * max(small.shape[:2]))))
    bg = background_model(small, band)
    lum, lum_bg = small.mean(axis=2), np.maximum(bg.mean(axis=2), 1e-3)
    chroma = small / np.maximum(small.sum(axis=2, keepdims=True), 1e-3)
    chroma_bg = bg / np.maximum(bg.sum(axis=2, keepdims=True), 1e-3)
    ratio = lum / lum_bg
    shade = ((np.abs(chroma - chroma_bg).max(axis=2) <= chroma_tol) & (ratio >= shadow[0]) & (ratio <= shadow[1])
             if shadow else np.zeros(lum.shape, bool))
    close = np.abs(small - bg).max(axis=2) <= tol
    rows = np.nonzero(dilate(erode(~_border_flood(close), 1), 1).any(axis=1))[0]
    if len(rows):
        shade[:rows[0] + int(0.8 * (rows[-1] - rows[0]))] = False
    fg_small = dilate(erode(~_border_flood(close | shade), 1), 1)  # drop single-pixel specks
    fg = np.repeat(np.repeat(fg_small, step, axis=0), step, axis=1)[:h, :w]
    return fg, 'backdrop-key'


def _border_flood(near):
    """The part of `near` connected (4-neighbour) to the image border."""
    reach = np.zeros_like(near)
    reach[0, :], reach[-1, :], reach[:, 0], reach[:, -1] = near[0, :], near[-1, :], near[:, 0], near[:, -1]
    for _ in range(sum(near.shape)):
        p = np.pad(reach, 1)
        grown = (p[1:-1, 1:-1] | p[:-2, 1:-1] | p[2:, 1:-1] | p[1:-1, :-2] | p[1:-1, 2:]) & near
        if (grown == reach).all():
            break
        reach = grown
    return reach


def box_blur(a, r, axes=(0, 1)):
    """Mean filter of radius r along the given axes (edge-padded)."""
    if r <= 0:
        return np.asarray(a, np.float32)
    out = np.asarray(a, np.float32)
    for axis in axes:
        pad = [(0, 0)] * out.ndim
        pad[axis] = (r + 1, r)
        c = np.cumsum(np.pad(out, pad, mode='edge'), axis=axis)
        n = out.shape[axis]
        out = (np.take(c, np.arange(2 * r + 1, 2 * r + 1 + n), axis=axis) - np.take(c, np.arange(0, n), axis=axis)) / (2 * r + 1)
    return out


def gaussian_blur(a, sigma, axes=(0, 1)):
    """Three box passes approximating a Gaussian of the given sigma (pixels)."""
    r = int(round((math.sqrt(4.0 * sigma * sigma + 1.0) - 1.0) / 2.0))
    out = np.asarray(a, np.float32)
    for _ in range(3):
        out = box_blur(out, r, axes)
    return out


# ---------------------------------------------------------------- distance fields and silhouette warp

def _row_distance(mask):
    """Distance along each row to the nearest True pixel (inf where the row has none)."""
    h, w = mask.shape
    idx = np.broadcast_to(np.arange(w, dtype=np.float64), (h, w))
    left = np.maximum.accumulate(np.where(mask, idx, -np.inf), axis=1)
    right = np.minimum.accumulate(np.where(mask, idx, np.inf)[:, ::-1], axis=1)[:, ::-1]
    return np.minimum(idx - left, right - idx)


def distance_to(mask, cap):
    """Euclidean distance to the nearest True pixel; exact up to `cap` pixels, `cap` beyond."""
    m = np.asarray(mask, bool)
    if not m.any():
        return np.full(m.shape, float(cap), np.float32)
    cap = int(cap)
    g2 = np.minimum(_row_distance(m), cap + 1.0) ** 2
    best = g2.copy()
    for k in range(1, min(cap, m.shape[0] - 1) + 1):
        kk = float(k * k)
        np.minimum(best[k:], g2[:-k] + kk, out=best[k:])
        np.minimum(best[:-k], g2[k:] + kk, out=best[:-k])
    return np.minimum(np.sqrt(best), cap).astype(np.float32)


def signed_distance(mask, cap):
    """Negative inside, positive outside, crossing zero on the boundary (pixels, capped)."""
    m = np.asarray(mask, bool)
    return (distance_to(m, cap) - distance_to(~m, cap) + np.where(m, 0.5, -0.5)).astype(np.float32)


def block_mean(a, f):
    """Downsample by an integer factor with block averaging (crops the remainder)."""
    a = np.asarray(a, np.float32)
    if f <= 1:
        return a
    h, w = (a.shape[0] // f) * f, (a.shape[1] // f) * f
    a = a[:h, :w]
    return a.reshape(h // f, f, w // f, f, *a.shape[2:]).mean(axis=(1, 3))


def resample(img, h2, w2):
    """Bilinear resize of (H, W[, C]) keeping pixel-centre alignment."""
    img = np.asarray(img, np.float32)
    squeeze = img.ndim == 2
    if squeeze:
        img = img[..., None]
    h, w = img.shape[:2]
    ys, xs = np.mgrid[0:h2, 0:w2]
    x = (xs.ravel() + 0.5) * w / w2 - 0.5
    y = (ys.ravel() + 0.5) * h / h2 - 0.5
    out = bilinear(img, x, y).reshape(h2, w2, -1)
    return out[..., 0] if squeeze else out


def warp_masks(model_mask, ref_mask, iters=(150, 80, 40), smooth=0.006, band=0.12, max_step=1.0):
    """Smooth displacement field u (H, W, 2) such that ref(x + u(x)) ~ model(x).

    Demons-style registration driven by the two silhouettes' signed distance fields: forces act
    in a band around the model outline and Gaussian smoothing after every step spreads them
    inward, so the interior (face, logos) follows the outline instead of tearing. Coarse-to-fine;
    `iters` lists the iterations per level from coarsest to finest.
    """
    model_mask, ref_mask = np.asarray(model_mask, bool), np.asarray(ref_mask, bool)
    H, W = model_mask.shape
    levels = len(iters)
    u = None
    for lvl in reversed(range(levels)):
        f = 2 ** lvl
        m = block_mean(model_mask, f) > 0.5
        r = block_mean(ref_mask, f) > 0.5
        h, w = m.shape
        if min(h, w) < 8:
            continue
        cap = max(4, int(0.25 * max(h, w)))
        sm, sr = signed_distance(m, cap), signed_distance(r, cap)
        gy, gx = np.gradient(sr)
        field = np.stack([sr, gx, gy], axis=-1)
        u = np.zeros((h, w, 2), np.float32) if u is None else resample(u, h, w) * (w / u.shape[1])
        ys, xs = np.mgrid[0:h, 0:w].astype(np.float32)
        bw = np.clip(1.0 - np.abs(sm) / max(2.0, band * max(h, w)), 0.0, 1.0)
        sigma = max(1.0, smooth * max(h, w))
        for _ in range(iters[levels - 1 - lvl]):
            s = bilinear(field, (xs + u[..., 0]).ravel(), (ys + u[..., 1]).ravel()).reshape(h, w, 3)
            res = s[..., 0] - sm
            g2 = s[..., 1] ** 2 + s[..., 2] ** 2
            k = -res / np.maximum(g2 + res * res, 1e-6) * bw
            du = np.stack([k * s[..., 1], k * s[..., 2]], axis=-1)
            norm = np.linalg.norm(du, axis=-1, keepdims=True)
            du *= np.minimum(1.0, max_step / np.maximum(norm, 1e-9))
            u = gaussian_blur(u + du, sigma)
    if u is None:
        return np.zeros((H, W, 2), np.float32)
    return (resample(u, H, W) * (W / u.shape[1])).astype(np.float32)


def pull_back(mask, u):
    """Sample mask at x + u(x) (nearest): the reference seen through the warp, on the model grid."""
    h, w = u.shape[:2]
    ys, xs = np.mgrid[0:h, 0:w]
    x = np.clip(np.round(xs + u[..., 0]).astype(np.int64), 0, mask.shape[1] - 1)
    y = np.clip(np.round(ys + u[..., 1]).astype(np.int64), 0, mask.shape[0] - 1)
    return np.asarray(mask, bool)[y, x]


def push_forward(mask, u, shape):
    """Splat True pixels of mask to x + u(x) on a grid of `shape` (closed by one pixel)."""
    ys, xs = np.nonzero(mask)
    x = np.round(xs + u[ys, xs, 0]).astype(np.int64)
    y = np.round(ys + u[ys, xs, 1]).astype(np.int64)
    ok = (x >= 0) & (x < shape[1]) & (y >= 0) & (y < shape[0])
    out = np.zeros(shape, bool)
    out[y[ok], x[ok]] = True
    return erode(dilate(out, 1), 1)


def iou(a, b):
    a, b = np.asarray(a, bool), np.asarray(b, bool)
    union = (a | b).sum()
    return float((a & b).sum() / union) if union else 0.0


# ---------------------------------------------------------------- cameras

AXIS_VIEWS = {
    # name: (view direction = where the camera looks, image-right, image-up) in Blender world axes.
    # Character convention: faces -Y, up +Z, its left hand at +X.
    'front': ((0, 1, 0), (1, 0, 0), (0, 0, 1)),
    'back': ((0, -1, 0), (-1, 0, 0), (0, 0, 1)),
    'cam+x': ((-1, 0, 0), (0, 1, 0), (0, 0, 1)),   # camera on +X: sees the character's LEFT side
    'cam-x': ((1, 0, 0), (0, -1, 0), (0, 0, 1)),   # camera on -X: sees the character's RIGHT side
    'top': ((0, 0, -1), (1, 0, 0), (0, 1, 0)),
    'bottom': ((0, 0, 1), (1, 0, 0), (0, -1, 0)),
}


def rotate_in_plane(right, up, quarter_turns):
    r, u = np.asarray(right, float), np.asarray(up, float)
    for _ in range(quarter_turns % 4):
        r, u = -u, r  # rotate image 90 degrees counter-clockwise
    return r, u


class Camera:
    """Orthographic or perspective camera mapping world points to top-down image pixels."""

    def __init__(self, spec):
        self.spec = dict(spec)
        self.kind = spec.get('kind', 'ORTHO').upper()
        self.width, self.height = int(spec['width']), int(spec['height'])
        self.right = np.asarray(spec['right'], float)
        self.up = np.asarray(spec['up'], float)
        self.forward = np.asarray(spec['forward'], float)  # viewing direction
        for v in (self.right, self.up, self.forward):
            v /= np.linalg.norm(v)
        if self.kind == 'ORTHO':
            self.center = np.asarray(spec['center'], float)  # world point at image centre
            self.ppm = float(spec['pixels_per_metre'])
        else:
            self.position = np.asarray(spec['position'], float)
            self.focal_px = float(spec['focal_px'])
        self.cx = spec.get('cx', (self.width - 1) / 2.0)
        self.cy = spec.get('cy', (self.height - 1) / 2.0)

    def project(self, p):
        """World points (N,3) -> pixel x, y (top-down), depth along forward."""
        p = np.asarray(p, float)
        if self.kind == 'ORTHO':
            d = p - self.center
            x = self.cx + (d @ self.right) * self.ppm
            y = self.cy - (d @ self.up) * self.ppm
            depth = d @ self.forward
        else:
            d = p - self.position
            depth = d @ self.forward
            safe = np.where(depth > 1e-9, depth, np.nan)
            x = self.cx + self.focal_px * (d @ self.right) / safe
            y = self.cy - self.focal_px * (d @ self.up) / safe
        return x, y, depth

    def towards_camera(self, p):
        """Unit vectors from points toward the camera."""
        if self.kind == 'ORTHO':
            return np.broadcast_to(-self.forward, np.shape(p)).copy()
        d = self.position - np.asarray(p, float)
        return d / np.maximum(np.linalg.norm(d, axis=1, keepdims=True), 1e-12)


def plane_coords(points, right, up):
    p = np.asarray(points, float)
    return p @ np.asarray(right, float), p @ np.asarray(up, float)


FACING = {'-Y': 0, '+X': 1, '+Y': 2, '-X': 3}


def character_frame(facing='-Y'):
    """(front, left, up) unit vectors of a character facing `facing` with +Z up."""
    f = np.array([0.0, -1.0, 0.0])
    for _ in range(FACING[facing]):
        f = np.array([-f[1], f[0], f[2]])
    z = np.array([0.0, 0.0, 1.0])
    return f, np.cross(z, f), z


def look_basis(azimuth, elevation, roll=0.0, frame=None):
    """Camera axes for a camera orbiting the character (degrees).

    azimuth 0 = in front of the character, 90 = at its left side, 180 = behind, 270 = at its right.
    elevation > 0 = above, looking down. At (0, 0) this equals AXIS_VIEWS['front'], at (90, 0)
    'cam+x', at (0, 90) 'top' and at (0, -90) 'bottom'. Returns (forward, right, up, out) where
    `out` points from the target towards the camera.
    """
    front, left, z = frame if frame is not None else character_frame()
    th, ph, ro = (math.radians(v) for v in (azimuth, elevation, roll))
    h = math.cos(th) * front + math.sin(th) * left
    out = math.cos(ph) * h + math.sin(ph) * z
    forward = -out
    right = np.cross(z, h)
    right /= np.linalg.norm(right)
    up = np.cross(right, forward)
    up /= np.linalg.norm(up)
    cr, sr = math.cos(ro), math.sin(ro)
    return forward, cr * right + sr * up, -sr * right + cr * up, out


def view_coords(points, forward, right, up, target, distance=None):
    """Image-plane coordinates relative to `target`, in metres at the target's depth: orthographic
    when distance is None, else a pinhole at target - forward * distance (focal length in pixels
    = pixels per metre * distance). Returns (a, b, valid)."""
    d = np.asarray(points, float) - np.asarray(target, float)
    a, b = d @ right, d @ up
    if distance is None or not np.isfinite(distance):
        return a, b, np.ones(a.shape, bool)
    depth = distance + d @ forward
    ok = depth > 1e-3 * distance
    scale = np.where(ok, distance / np.where(ok, depth, 1.0), np.nan)
    return a * scale, b * scale, ok


def silhouette_mask(tri_ab, res):
    """Rasterize (T, 3, 2) plane coordinates (a right, b up) into a top-down mask whose longer
    side has `res` pixels. Returns (mask, (a0, a1, b0, b1))."""
    tri_ab = np.asarray(tri_ab, float)
    a, b = tri_ab[..., 0], tri_ab[..., 1]
    a0, a1, b0, b1 = a.min(), a.max(), b.min(), b.max()
    pad = 0.02 * max(a1 - a0, b1 - b0)
    a0, a1, b0, b1 = a0 - pad, a1 + pad, b0 - pad, b1 + pad
    s = res / max(a1 - a0, b1 - b0)
    wm, hm = max(8, int(math.ceil((a1 - a0) * s))), max(8, int(math.ceil((b1 - b0) * s)))
    xy = np.stack([(a - a0) / (a1 - a0) * wm - 0.5, (b1 - b) / (b1 - b0) * hm - 0.5], axis=-1)
    r = rasterize(xy, wm, hm)
    mask = np.zeros((hm, wm), bool)
    mask[r['y'], r['x']] = True
    return mask, (a0, a1, b0, b1)


def fit_ortho(model_mask, model_extent, ref_mask, iters=3, span_scale=0.08, span_shift=0.04, steps=7, grid=384, init=None):
    """Fit scale and offset so a model silhouette (rendered in image-plane units) overlays a reference mask.

    model_mask: bool (Hm, Wm) top-down silhouette covering model_extent=(a0, a1, b0, b1)
      (a = image-right axis, b = image-up axis, see view_coords).
    ref_mask: bool (Hr, Wr) top-down reference foreground.
    init: optional dict from a previous fit of a nearby camera; starts there with half the spans
      instead of from several silhouette-statistics guesses.
    Returns dict(ppm, a_center, b_center, iou) where a/b_center is the plane coordinate at the
    reference image centre and ppm is reference pixels per plane unit.
    """
    ref = np.asarray(ref_mask, bool)
    hr, wr = ref.shape
    ys, xs = np.nonzero(ref)
    if len(xs) == 0:
        raise ValueError('Reference mask is empty')
    a0, a1, b0, b1 = model_extent
    hm, wm = model_mask.shape
    my, mx = np.nonzero(model_mask)
    # model silhouette bbox, centroid and area in plane units
    ma = a0 + (mx + 0.5) / wm * (a1 - a0)
    mb = b1 - (my + 0.5) / hm * (b1 - b0)
    ma0, ma1, mb0, mb1 = ma.min(), ma.max(), mb.min(), mb.max()
    m_area = len(mx) * ((a1 - a0) / wm) * ((b1 - b0) / hm)
    rh, rw = ys.max() - ys.min() + 1, xs.max() - xs.min() + 1
    cxi, cyi = (wr - 1) / 2.0, (hr - 1) / 2.0
    # Several starting scales: a protrusion one silhouette lacks (a ponytail, an arm at another angle)
    # spoils the bbox width or height, rarely all of height, width and area at once.
    ppm_h = rh / max(mb1 - mb0, 1e-9)
    ppm_w = rw / max(ma1 - ma0, 1e-9)
    starts = [(ppm_h, ma.mean(), (mb0 + mb1) / 2.0, xs.mean(), (ys.min() + ys.max()) / 2.0),
              (ppm_w, (ma0 + ma1) / 2.0, mb.mean(), (xs.min() + xs.max()) / 2.0, ys.mean()),
              (math.sqrt(len(xs) / max(m_area, 1e-12)), ma.mean(), mb.mean(), xs.mean(), ys.mean()),
              (math.sqrt(ppm_h * ppm_w), (ma0 + ma1) / 2.0, (mb0 + mb1) / 2.0, (xs.min() + xs.max()) / 2.0, (ys.min() + ys.max()) / 2.0)]
    # evaluation grid on the reference (subsampled)
    step = max(1, int(math.ceil(max(hr, wr) / grid)))
    gy, gx = np.mgrid[0:hr:step, 0:wr:step]
    rsub = ref[::step, ::step]

    def iou(p, ac, bc):
        a = ac + (gx - cxi) / p
        b = bc - (gy - cyi) / p
        col = np.floor((a - a0) / (a1 - a0) * wm).astype(np.int64)
        row = np.floor((b1 - b) / (b1 - b0) * hm).astype(np.int64)
        ok = (col >= 0) & (col < wm) & (row >= 0) & (row < hm)
        m = np.zeros(rsub.shape, bool)
        m[ok] = model_mask[row[ok], col[ok]]
        union = (m | rsub).sum()
        return (m & rsub).sum() / union if union else 0.0

    size_m = max(mb1 - mb0, ma1 - ma0)
    starts = [(ppm, mac - (rcx - cxi) / ppm, mbc + (rcy - cyi) / ppm) for ppm, mac, mbc, rcx, rcy in starts]
    if init is not None:
        starts = [(init['ppm'], init['a_center'], init['b_center'])]
        span_scale, span_shift = span_scale / 2, span_shift / 2
    results = []
    for ppm, a_c, b_c in starts:
        best = (iou(ppm, a_c, b_c), ppm, a_c, b_c)
        ss, sh = span_scale, span_shift
        for _ in range(iters):
            _, p0, ac0, bc0 = best
            for f in np.linspace(1 - ss, 1 + ss, steps):
                for da in np.linspace(-sh, sh, steps) * size_m:
                    for db in np.linspace(-sh, sh, steps) * size_m:
                        score = iou(p0 * f, ac0 + da, bc0 + db)
                        if score > best[0]:
                            best = (score, p0 * f, ac0 + da, bc0 + db)
            ss, sh = ss / 3.0, sh / 3.0
        results.append(best)
    best = max(results, key=lambda r: r[0])
    return {'iou': float(best[0]), 'ppm': float(best[1]), 'a_center': float(best[2]), 'b_center': float(best[3])}


# ---------------------------------------------------------------- alignment

def similarity_transform(src, dst):
    """Least-squares similarity (scale, R, t) with dst ~ s R src + t (Umeyama)."""
    src, dst = np.asarray(src, float), np.asarray(dst, float)
    ms, md = src.mean(0), dst.mean(0)
    a, b = src - ms, dst - md
    cov = b.T @ a / len(src)
    u, d, vt = np.linalg.svd(cov)
    s_fix = np.eye(3)
    if np.linalg.det(u) * np.linalg.det(vt) < 0:
        s_fix[2, 2] = -1
    r = u @ s_fix @ vt
    var = (a ** 2).sum() / len(src)
    scale = np.trace(np.diag(d) @ s_fix) / var if var > 0 else 1.0
    t = md - scale * r @ ms
    return scale, r, t


# ---------------------------------------------------------------- accumulation

def accumulate(n, index, weights, values):
    """Weighted sum per texel: returns (sum_w (n,), sum_wv (n,C), max_w (n,))."""
    sw = np.bincount(index, weights=weights, minlength=n)
    swv = np.stack([np.bincount(index, weights=weights * values[:, k], minlength=n) for k in range(values.shape[1])], axis=1)
    mw = np.zeros(n)
    np.maximum.at(mw, index, weights)
    return sw, swv, mw


def mean_abs_error(a, b, mask):
    m = np.asarray(mask, bool)
    if not m.any():
        return None
    return float(np.abs(np.asarray(a)[m] - np.asarray(b)[m]).mean())


# ---------------------------------------------------------------- tone match

def _kmeans(x, k, rng, iters=15):
    c = x[rng.choice(len(x), min(k, len(x)), replace=False)]
    for _ in range(iters):
        lab = ((x[:, None, :] - c[None]) ** 2).sum(-1).argmin(1)
        c = np.array([x[lab == j].mean(0) if (lab == j).any() else c[j] for j in range(len(c))])
    return c


def _mode(x, bin_size):
    """Centre of the densest bin (3x3x3-smoothed histogram) of (n, 3) points."""
    lo = x.min(0)
    idx = np.floor((x - lo) / bin_size).astype(np.int64)
    dims = idx.max(0) + 3
    hist = np.zeros(dims, np.float32)
    np.add.at(hist, tuple((idx + 1).T), 1.0)
    s = hist.copy()
    for axis in range(3):
        s = np.roll(s, 1, axis) + s + np.roll(s, -1, axis)
    return lo + (np.array(np.unravel_index(s.argmax(), dims)) - 1 + 0.5) * bin_size


def tone_gains(orig, proj, conf, cover, min_conf=0.5, k=6, sigma=8.0, min_pairs=100, seed=0):
    """Per-texel colour gains that recolour the kept original to the tone the images show.

    Lists per tile, all at one resolution: orig and proj (h, w, 3) linear, conf (h, w), cover (h, w) bool.
    Texels the images saw well (conf >= min_conf) give pairs of original and projected colour. Within about
    sigma pixels of them the gain is their local ratio, so a narrow unseen gap takes its neighbours' colour.
    Farther away it falls back to a per-colour-cluster gain: the original colours are clustered, and each
    cluster maps to the dominant projected colour of its seen texels, so unseen skin takes the skin tone the
    images show, not a badge or a strand of hair painted over it. Returns per-tile (h, w, 3) gains, or None
    when too little was seen well.
    """
    eps = 1e-3
    lo = [np.log(np.maximum(o, 0) + eps).astype(np.float32) for o in orig]
    lp = [np.log(np.maximum(p, 0) + eps).astype(np.float32) for p in proj]
    seen = [np.asarray(cv, bool) & (np.asarray(c) >= min_conf) for cv, c in zip(cover, conf)]
    po = np.concatenate([a[m] for a, m in zip(lo, seen)])
    if len(po) < min_pairs:
        return None
    pp = np.concatenate([a[m] for a, m in zip(lp, seen)])
    rng = np.random.default_rng(seed)
    pool = np.concatenate([a[np.asarray(m, bool)] for a, m in zip(lo, cover)])
    centres = _kmeans(pool[rng.choice(len(pool), min(len(pool), 50000), replace=False)], k, rng)
    label = ((po[:, None, :] - centres[None]) ** 2).sum(-1).argmin(1)
    fitted, gains = [], []
    for j in range(len(centres)):
        o, p = po[label == j], pp[label == j]
        if len(o) < min_pairs:
            continue
        near = np.abs(p - _mode(p, 0.2)).max(1) <= 0.3
        gains.append(np.median(p[near], 0) - np.median(o[near], 0))
        fitted.append(centres[j])
    fitted, gains = np.array(fitted, np.float32), np.array(gains, np.float32)
    out = []
    for o, p, m in zip(lo, lp, seen):
        h, w = m.shape
        g = np.empty((h, w, 3), np.float32)
        for y in range(0, h, 256):  # soft cluster assignment, in row blocks to bound memory
            d2 = ((o[y:y + 256, :, None, :] - fitted) ** 2).sum(-1)
            wt = np.exp(-(d2 - d2.min(-1, keepdims=True)) / (2 * 0.25 ** 2))
            g[y:y + 256] = (wt / wt.sum(-1, keepdims=True)) @ gains
        mf = m.astype(np.float32)
        den = gaussian_blur(mf, sigma)
        local = gaussian_blur((p - o) * mf[..., None], sigma) / np.maximum(den, 1e-6)[..., None]
        alpha = np.clip(4.0 * den, 0, 1)[..., None]
        out.append(np.exp(alpha * local + (1 - alpha) * g).astype(np.float32))
    return out


# ---------------------------------------------------------------- recolour: palette and region colours

def chroma_features(c, eps=0.01):
    """(..., 3) linear colours -> log-chroma plus damped log-luminance. Shading moves luminance far more
    than chroma, so one fabric under different light stays close in this space."""
    c = np.asarray(c, np.float32)
    lc = np.log(np.maximum(c, 0) + eps)
    lum = np.log(np.maximum(c @ np.array([0.2126, 0.7152, 0.0722], np.float32), 0) + eps)
    return np.stack([lc[..., 0] - lc[..., 1], lc[..., 2] - lc[..., 1], 0.35 * lum], -1).astype(np.float32)


def nearest_centre(f, centres, chunk=1 << 20):
    out = np.empty(len(f), np.int32)
    for s in range(0, len(f), chunk):
        out[s:s + chunk] = ((f[s:s + chunk, None, :] - centres[None]) ** 2).sum(-1).argmin(1)
    return out


def log_mode(x, bin_size=0.2):
    """Most common colour of (n, 3) linear colours, found in log space: robust to shading and specks."""
    return np.exp(_mode(np.log(np.maximum(x, 0) + 1e-3), bin_size)).astype(np.float32)


def palette(pixels, k, merge_chroma=0.35, merge_lum=1.4, sample=60000, seed=0):
    """k-means of (n, 3) linear pixels in chroma_features space; centres with nearly the same chroma and
    similar brightness are merged into one region (shades of one fabric). `pixels` may be a list, one array
    per view: the first view is clustered alone, and each later view adds only colours no existing centre
    covers (a back panel). Pooling the views instead lets their large areas crowd small colours such as
    badges out of the palette. Returns (centres, region index per centre, region count)."""
    rng = np.random.default_rng(seed)

    def similar(a, b):
        return np.linalg.norm(a[:2] - b[:2]) < merge_chroma and abs(a[2] - b[2]) / 0.35 < merge_lum

    def cluster(px):
        cent = _kmeans(chroma_features(px[rng.choice(len(px), min(sample, len(px)), replace=False)]), k, rng)
        group = list(range(len(cent)))
        for i in range(len(cent)):
            for j in range(i):
                if similar(cent[i], cent[j]):
                    gi, gj = group[i], group[j]
                    group = [gj if g == gi else g for g in group]
        return cent, group

    views = [pixels] if isinstance(pixels, np.ndarray) else list(pixels)
    cent, group = cluster(views[0])
    for v, px in enumerate(views[1:]):
        extra, eg = cluster(px)
        new = [i for i in range(len(extra)) if not any(similar(extra[i], c) for c in cent)]
        cent = np.concatenate([cent, extra[new]])
        group += [(v, eg[i]) for i in new]  # tagged so they never join an existing region
    ids = list(dict.fromkeys(group))
    return cent, np.array([ids.index(g) for g in group]), len(ids)


def tone_step(photo, render, applied, prev_render=None, prev_applied=None, prev_floor=False, damping=1.0, floor=0.25,
              linear_below=0.25):
    """Next colour scale for one region so that its render matches its photo colour; returns (scale, at_floor).
    Hue follows the per-channel ratio (damped). Brightness follows the luminance ratio on a first pass. Given
    the previous pass's render and scale, it solves render = slope * base + offset instead: lights add
    specular that a darker base colour cannot remove, so the plain ratio would drive the colour to black and
    leave grey shine. A target below `floor` x the current base luminance is out of reach, and brightness
    holds there. When it is in reach, each dark channel (render below `linear_below`, linear) is solved on its
    own: the shine adds to every channel alike, so one brightness for all overshoots the channel the base
    colour carries and turns navy grey. Bright channels keep the shared rule; the view transform compresses
    them and their own slope can't be trusted."""
    luma = np.array([0.2126, 0.7152, 0.0722])
    photo, render, applied = (np.asarray(x, np.float64) for x in (photo, render, applied))
    lum_ratio = (photo @ luma) / max(render @ luma, 1e-4)
    hue = np.clip(photo / np.maximum(render, 1e-4) / lum_ratio, 1 / 3, 3) ** damping
    bright, at_floor = np.clip(lum_ratio, 0.1, 3) ** damping, False
    if prev_render is not None and prev_applied is not None:
        b1, b0 = (photo * applied) @ luma, (photo * np.asarray(prev_applied)) @ luma
        l1, l0 = render @ luma, np.asarray(prev_render) @ luma
        if abs(np.log(max(b1, 1e-9) / max(b0, 1e-9))) > 0.05:
            slope = (l1 - l0) / (b1 - b0)
            target = (photo @ luma - (l1 - slope * b1)) / slope if slope > 0 else -1.0
            at_floor = target <= floor * b1
            bright = 1.0 if at_floor else np.clip(target / b1, 1 / 3, 3)
            if not at_floor:
                c1, c0, r0 = photo * applied, photo * np.asarray(prev_applied), np.asarray(prev_render)
                ok = (np.abs(np.log(np.maximum(c1, 1e-9) / np.maximum(c0, 1e-9))) > 0.05) & (render < linear_below)
                cslope = (render - r0) / np.where(ok, c1 - c0, 1)
                ok &= cslope > 0
                ctarget = (photo - (render - cslope * c1)) / np.where(ok, cslope, 1)
                own = np.clip(ctarget / np.maximum(c1, 1e-9), floor, 3)
                return applied * np.where(ok, own, hue * bright), False
        elif prev_floor:
            bright, at_floor = 1.0, True
    return applied * hue * bright, bool(at_floor)


def id_colour(i):
    """Flat colour for ID passes (216 ids); every channel is a multiple of 1/5, so 8-bit storage is exact enough."""
    return ((i % 6) / 5, ((i // 6) % 6) / 5, ((i // 36) % 6) / 5)
