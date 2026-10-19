"""2D polygon and grid helpers (numpy) for planning the generated near field.

Rings are (k, 2) float64 arrays in local ENU metres without a repeated closing point. After
``orient_polygon`` outer rings run counter-clockwise and holes clockwise, so the interior is always on the
left of an edge and ``offset_ring`` with a positive distance moves every ring away from the interior.
"""
import struct
import warnings
import zlib

import numpy as np


def open_ring(coords, eps=1e-6):
    """Drop the closing point and consecutive duplicates of a GeoJSON ring."""
    ring = np.asarray([c[:2] for c in coords], dtype=np.float64)
    keep = [0] + [i for i in range(1, len(ring)) if np.hypot(*(ring[i] - ring[i - 1])) > eps]
    ring = ring[keep]
    if len(ring) > 1 and np.hypot(*(ring[0] - ring[-1])) <= eps:
        ring = ring[:-1]
    return ring


def signed_area(ring):
    x, y = ring[:, 0], ring[:, 1]
    return 0.5 * float(np.dot(x, np.roll(y, -1)) - np.dot(np.roll(x, -1), y))


def orient_polygon(rings):
    """Outer ring counter-clockwise, holes clockwise."""
    out = []
    for k, ring in enumerate(rings):
        ccw = signed_area(ring) > 0
        out.append(ring if ccw == (k == 0) else ring[::-1].copy())
    return out


def simplify_ring(ring, tolerance):
    """Remove vertices closer than ``tolerance`` to the line through their neighbours (repeat until stable)."""
    ring = ring.copy()
    changed = True
    while changed and len(ring) > 3:
        changed = False
        prev, nxt = np.roll(ring, 1, axis=0), np.roll(ring, -1, axis=0)
        chord = nxt - prev
        length = np.hypot(chord[:, 0], chord[:, 1])
        cross = np.abs(chord[:, 0] * (ring[:, 1] - prev[:, 1]) - chord[:, 1] * (ring[:, 0] - prev[:, 0]))
        dist = np.where(length > 1e-9, cross / np.maximum(length, 1e-9), np.hypot(*(ring - prev).T))
        worst = int(np.argmin(dist))
        if dist[worst] < tolerance:
            ring = np.delete(ring, worst, axis=0)
            changed = True
    return ring


def points_in_polygon(points, rings):
    """Even-odd containment of (n, 2) points in a polygon given as rings (outer plus holes)."""
    px, py = points[:, 0], points[:, 1]
    inside = np.zeros(len(points), dtype=bool)
    for ring in rings:
        a, b = ring, np.roll(ring, -1, axis=0)
        for (ax, ay), (bx, by) in zip(a, b):
            if ay == by:
                continue
            crosses = (ay > py) != (by > py)
            xcross = ax + (bx - ax) * (py - ay) / (by - ay)
            inside ^= crosses & (px < xcross)
    return inside


def distance_to_segment(points, a, b):
    ab = b - a
    denom = float(np.dot(ab, ab))
    t = np.zeros(len(points)) if denom == 0 else np.clip(((points - a) @ ab) / denom, 0.0, 1.0)
    closest = a + t[:, None] * ab
    return np.hypot(*(points - closest).T)


def distance_to_rings(points, rings):
    """Distance from each point to the nearest polygon edge."""
    best = np.full(len(points), np.inf)
    for ring in rings:
        for a, b in zip(ring, np.roll(ring, -1, axis=0)):
            best = np.minimum(best, distance_to_segment(points, a, b))
    return best


def offset_ring(ring, distance, miter_limit=3.0):
    """Mitred offset of an oriented ring; positive distance moves away from the polygon interior."""
    prev_pts, next_pts = np.roll(ring, 1, axis=0), np.roll(ring, -1, axis=0)

    def right_normals(a, b):
        d = b - a
        length = np.maximum(np.hypot(d[:, 0], d[:, 1]), 1e-12)
        return np.stack([d[:, 1] / length, -d[:, 0] / length], axis=1)

    n_in = right_normals(prev_pts, ring)   # normal of the edge arriving at each vertex
    n_out = right_normals(ring, next_pts)  # normal of the edge leaving it
    bisector = n_in + n_out
    denom = 1.0 + np.sum(n_in * n_out, axis=1)
    scale = np.where(denom > 1e-9, 1.0 / np.maximum(denom, 1e-9), 0.0)
    miter = bisector * scale[:, None]
    length = np.hypot(miter[:, 0], miter[:, 1])
    too_long = length > miter_limit
    miter[too_long] *= (miter_limit / length[too_long])[:, None]
    return ring + distance * miter


def offset_ring_weighted(ring, distances, miter_limit=3.0):
    """Offset where edge k (vertex k to k + 1) moves by distances[k] away from the interior.

    Each new vertex is the intersection of its two moved edge lines, so an edge with distance 0 stays on
    its line (used for party walls that must not step back).
    """
    distances = np.asarray(distances, dtype=np.float64)
    d = np.roll(ring, -1, axis=0) - ring
    length = np.maximum(np.hypot(d[:, 0], d[:, 1]), 1e-12)
    normals = np.stack([d[:, 1] / length, -d[:, 0] / length], axis=1)  # right normal = away from the interior
    n1, n2 = np.roll(normals, 1, axis=0), normals  # edges arriving at and leaving each vertex
    d1, d2 = np.roll(distances, 1), distances
    det = n1[:, 0] * n2[:, 1] - n1[:, 1] * n2[:, 0]
    out = np.empty_like(ring)
    for k in range(len(ring)):
        if abs(det[k]) < 1e-6:  # collinear edges: average the two moves
            x = 0.5 * (n1[k] * d1[k] + n2[k] * d2[k])
        else:
            x = np.array([(d1[k] * n2[k, 1] - d2[k] * n1[k, 1]) / det[k], (n1[k, 0] * d2[k] - n2[k, 0] * d1[k]) / det[k]])
        limit = miter_limit * max(abs(d1[k]), abs(d2[k]))
        size = float(np.hypot(*x))
        if size > limit > 0:
            x *= limit / size
        out[k] = ring[k] + x
    return out


def segments_cross(a1, a2, b1, b2):
    """Proper intersection test for two segments (shared endpoints do not count)."""
    def orient(p, q, r):
        return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
    d1, d2 = orient(b1, b2, a1), orient(b1, b2, a2)
    d3, d4 = orient(a1, a2, b1), orient(a1, a2, b2)
    return (d1 * d2 < -1e-12) and (d3 * d4 < -1e-12)


def rings_are_simple(rings):
    """True when no two non-adjacent edges of the rings cross (rings checked against each other too)."""
    edges = []
    for r, ring in enumerate(rings):
        n = len(ring)
        edges += [(r, i, n, ring[i], ring[(i + 1) % n]) for i in range(n)]
    for i in range(len(edges)):
        ri, ii, ni, a1, a2 = edges[i]
        for j in range(i + 1, len(edges)):
            rj, jj, nj, b1, b2 = edges[j]
            if ri == rj and (jj == ii + 1 or (ii == 0 and jj == ni - 1)):
                continue
            if segments_cross(a1, a2, b1, b2):
                return False
    return True


def edge_directions_kept(before, after):
    """Every offset edge still points the way its source edge did (an inset has not collapsed or flipped)."""
    d0 = np.roll(before, -1, axis=0) - before
    d1 = np.roll(after, -1, axis=0) - after
    return bool(np.all(np.sum(d0 * d1, axis=1) > 0))


def safe_inset(rings, wanted, minimum=0.2, steps=6, weights=None):
    """Largest inset (towards the interior) up to ``wanted`` that keeps every ring valid; returns (d, rings).

    ``weights`` optionally gives, per ring, a factor per edge (0 keeps that edge in place).
    """
    d = wanted
    for _ in range(steps):
        if weights is None:
            inset = [offset_ring(r, -d) for r in rings]
        else:
            inset = [offset_ring_weighted(r, -d * np.asarray(w, dtype=np.float64)) for r, w in zip(rings, weights)]
        if all(edge_directions_kept(a, b) for a, b in zip(rings, inset)) and rings_are_simple(inset):
            return d, inset
        d *= 0.6
        if d < minimum:
            break
    return 0.0, [r.copy() for r in rings]


def grid_window_reduce(grid, radius, reducer):
    """NaN-aware square-window min/max filter on a 2D grid (window side 2 * radius + 1)."""
    padded = np.pad(grid, radius, mode="constant", constant_values=np.nan)
    windows = np.lib.stride_tricks.sliding_window_view(padded, (2 * radius + 1, 2 * radius + 1))
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)  # all-NaN windows stay NaN
        return reducer(windows, axis=(2, 3))


def fill_nan(grid, relax_iterations=200):
    """Fill NaN cells by growing from known neighbours, then relax the filled cells towards a smooth surface."""
    out = grid.copy()
    unknown = np.isnan(out)
    if unknown.all():
        raise ValueError("Grid has no known values")
    todo = unknown.copy()
    while todo.any():
        padded = np.pad(out, 1, mode="constant", constant_values=np.nan)
        neighbours = np.stack([padded[:-2, 1:-1], padded[2:, 1:-1], padded[1:-1, :-2], padded[1:-1, 2:]])
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            mean = np.nanmean(neighbours, axis=0)
        grow = todo & ~np.isnan(mean)
        if not grow.any():
            break
        out[grow] = mean[grow]
        todo &= ~grow
    for _ in range(relax_iterations):
        padded = np.pad(out, 1, mode="edge")
        mean = (padded[:-2, 1:-1] + padded[2:, 1:-1] + padded[1:-1, :-2] + padded[1:-1, 2:]) / 4.0
        out[unknown] = mean[unknown]
    return out


def gaussian_smooth(grid, sigma_cells):
    radius = max(1, int(round(3 * sigma_cells)))
    x = np.arange(-radius, radius + 1)
    kernel = np.exp(-0.5 * (x / sigma_cells) ** 2)
    kernel /= kernel.sum()
    out = np.pad(grid, ((0, 0), (radius, radius)), mode="edge")
    out = np.apply_along_axis(lambda r: np.convolve(r, kernel, mode="valid"), 1, out)
    out = np.pad(out, ((radius, radius), (0, 0)), mode="edge")
    return np.apply_along_axis(lambda c: np.convolve(c, kernel, mode="valid"), 0, out)


def sample_grid(grid, x0, y0, res, points):
    """Bilinear sample of a cell-centred grid at (n, 2) points; points outside clamp to the edge."""
    ny, nx = grid.shape
    fx = np.clip((points[:, 0] - x0) / res - 0.5, 0, nx - 1)
    fy = np.clip((points[:, 1] - y0) / res - 0.5, 0, ny - 1)
    i0, j0 = np.floor(fx).astype(int), np.floor(fy).astype(int)
    i1, j1 = np.minimum(i0 + 1, nx - 1), np.minimum(j0 + 1, ny - 1)
    tx, ty = fx - i0, fy - j0
    return ((grid[j0, i0] * (1 - tx) + grid[j0, i1] * tx) * (1 - ty)
            + (grid[j1, i0] * (1 - tx) + grid[j1, i1] * tx) * ty)


def write_png(path, rgb):
    """Write an (h, w, 3) uint8 array as an 8-bit RGB PNG (standard library zlib only)."""
    h, w, _ = rgb.shape
    raw = b"".join(b"\x00" + rgb[row].tobytes() for row in range(h))

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b"")
    with open(path, "wb") as stream:
        stream.write(png)
