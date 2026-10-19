"""Headless Blender job: the original modelled sedan (car-sedan-v1) from its asset contract, exported as GLB.

Everything is generated here; there are no third-party meshes, textures or brand marks. Geometry is
authored in the runtime asset frame (+X left, +Y up, +Z forward) and converted to Blender once, at mesh
creation: asset (x, y, z) -> Blender (x, -z, y). The glTF exporter's Y-up conversion maps it back.

Parts:
- CAR_BODY: one closed shell lofted through cross-sections. Each half-section has 16 points (underbody,
  wheel well, side, shoulder, then glass and roof, or the hood/deck where there is no glasshouse). Wheel
  openings come from raising the outer bottom along the arch circle; the wells are lined.
- CAR_DETAILS: lights, grille, plates, shut lines and handles projected onto the body by ray casting and
  lifted a few millimetres along the surface normal.
- DOOR_FL/DOOR_FR: the front doors, cut from the same shell along their shut lines, with door cards, edges,
  handle and mirror; origin on the vertical hinge axis at the front edge. The runtime swings them open.
- CAR_INTERIOR: cabin lining (an inward offset of the shell), opening jambs, bulkheads, seats, dashboard,
  console and steering column. The glass is tinted but see-through, so the driver can be seen.
- STEERING_WHEEL: rim, spokes and hub, origin at the wheel centre, local +Z along the column away from the
  driver, so the runtime turns it about local Z.
- WHEEL_FL/FR/RL/RR: tyre and twin-spoke rim, origin at the hub, axle along X.
Sockets are empties, except DOOR_FL/DOOR_FR/STEERING_WHEEL, which are the origins of those meshes. The collider
proxy is built for inspection only and is not exported.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

# --- design (asset frame, metres) -------------------------------------------------------------------
ZF, ZR = 2.35, -2.35
HW = 0.92
FLOOR, SILL, ROOF = 0.16, 0.22, 1.45
AXLES, HUB_Y, ARCH_R = (1.40, -1.40), 0.33, 0.385
Z_A, Z_WT, Z_PEAK, Z_RT, Z_C = 0.95, 0.02, -0.40, -0.98, -1.62
ROOF_K = 0.12                     # roof camber along z: ROOF - k (z - Z_PEAK)^2
ROOF_HALF, ROOF_CROWN = 0.62, 0.045
BLEND = 0.10                      # glasshouse grows out of the hood/deck over this length
DLO_REAR, B_PILLAR = -1.10, (-0.32, -0.22)
ENDS = {"front": dict(z=ZF, length=0.20, nose=0.54), "rear": dict(z=ZR, length=0.20, nose=0.66)}
END_P, END_F = 4.0, 0.25          # end rounding exponent; section scale where the loft stops and the cap starts
STATION_STEP = 0.085
WHEEL_SEGMENTS = 36
DOOR_Z = (-0.27, 0.93)            # front doors: rear edge (the seam at the B-pillar) and front edge (behind the arch)
CABIN_Z = (Z_C, Z_A - BLEND)      # lining from the rear-window base to the windscreen base
LINING, CARD = 0.035, 0.07        # inward offsets of the cabin lining and of the door cards
DOOR_BOTTOM = 0.25                # height of the door's lower cut (half-section point 4 between the arches)
MESH_SOCKETS = ("DOOR_FL", "DOOR_FR", "STEERING_WHEEL")  # contract sockets that are mesh origins, not empties

GLASS_ALPHA = 0.42
MATERIALS = {  # name: (base colour sRGB, roughness, metallic, coat, emission sRGB); paint comes from the contract
    "glass": ((0.03, 0.035, 0.04), 0.04, 0.0, 0.0, None),  # windows only: tinted, alpha-blended (GLASS_ALPHA)
    "interior": ((0.085, 0.085, 0.09), 0.85, 0.0, 0.0, None),
    "trim": ((0.035, 0.035, 0.038), 0.4, 0.0, 0.0, None),
    "rubber": ((0.03, 0.03, 0.032), 0.92, 0.0, 0.0, None),
    "alloy": ((0.78, 0.79, 0.8), 0.28, 1.0, 0.0, None),
    "metal": ((0.32, 0.32, 0.33), 0.45, 1.0, 0.0, None),
    "plate": ((0.9, 0.9, 0.88), 0.45, 0.0, 0.0, None),
    "lamp_front": ((0.9, 0.92, 0.95), 0.1, 0.0, 0.0, (0.95, 0.97, 1.0)),
    "lamp_rear": ((0.45, 0.02, 0.02), 0.15, 0.0, 0.0, (0.75, 0.03, 0.02)),
}


def srgb_to_linear(c):
    return tuple(x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c)


def to_blender(p):
    return (float(p[0]), float(-p[2]), float(p[1]))


def smoothstep(t):
    t = min(1.0, max(0.0, t))
    return t * t * (3 - 2 * t)


# --- indexed mesh in the asset frame ----------------------------------------------------------------
class Part:
    def __init__(self):
        self.verts, self.faces, self.mats = [], [], []

    def add(self, points):
        base = len(self.verts)
        self.verts.extend(tuple(float(c) for c in p) for p in points)
        return base

    def face(self, indices, material):
        self.faces.append(tuple(int(i) for i in indices))
        self.mats.append(material)

    def grid(self, rows, material, closed=False, want=None):
        """Quads between consecutive rows of points (equal lengths). ``material`` may be a function
        (row, column) -> name. ``want(centre, normal)`` returns True when a face must be flipped."""
        n = len(rows[0])
        bases = [self.add(r) for r in rows]
        cols = n if closed else n - 1
        for i in range(len(rows) - 1):
            for k in range(cols):
                k1 = (k + 1) % n
                face = [bases[i] + k, bases[i] + k1, bases[i + 1] + k1, bases[i + 1] + k]
                if want is not None:
                    pts = np.array([self.verts[v] for v in face])
                    normal = np.cross(pts[1] - pts[0], pts[3] - pts[0]) + np.cross(pts[2] - pts[1], pts[0] - pts[1])
                    if want(pts.mean(axis=0), normal):
                        face = face[::-1]
                self.face(face, material(i, k) if callable(material) else material)
        return bases

    def fan(self, ring, centre, material, outward):
        """Triangle fan closing ``ring`` (vertex indices) at a new centre vertex, facing ``outward``."""
        c = self.add([centre])
        for k in range(len(ring)):
            tri = [ring[k], ring[(k + 1) % len(ring)], c]
            pts = np.array([self.verts[v] for v in tri])
            if np.dot(np.cross(pts[1] - pts[0], pts[2] - pts[0]), outward) < 0:
                tri = tri[::-1]
            self.face(tri, material)

    def flipped(self):
        self.faces = [f[::-1] for f in self.faces]

    def signed_volume(self):
        v = np.asarray(self.verts)
        total = 0.0
        for f in self.faces:
            for k in range(1, len(f) - 1):
                total += np.dot(v[f[0]], np.cross(v[f[k]], v[f[k + 1]]))
        return total / 6.0

    def triangles(self):
        return sum(len(f) - 2 for f in self.faces)

    def subset(self, face_ids, origin=(0.0, 0.0, 0.0)):
        """New part with only the given faces; vertices relative to ``origin``."""
        out, remap = Part(), {}
        o = np.asarray(origin, dtype=np.float64)
        for fi in face_ids:
            face = []
            for v in self.faces[fi]:
                if v not in remap:
                    remap[v] = out.add([np.asarray(self.verts[v]) - o])
                face.append(remap[v])
            out.face(face, self.mats[fi])
        return out

    def extend(self, other):
        base = self.add(other.verts)
        for f, m in zip(other.faces, other.mats):
            self.face([base + v for v in f], m)
        return self

    def oriented(self, points, material, toward):
        """Add a quad or polygon whose normal points toward ``toward`` (a point)."""
        pts = np.asarray(points, dtype=np.float64)
        normal = np.zeros(3)
        for k in range(len(pts)):  # Newell's method: robust for non-planar quads and polygons
            a, b = pts[k], pts[(k + 1) % len(pts)]
            normal += np.array([(a[1] - b[1]) * (a[2] + b[2]), (a[2] - b[2]) * (a[0] + b[0]), (a[0] - b[0]) * (a[1] + b[1])])
        base = self.add(pts)
        face = list(range(base, base + len(pts)))
        self.face(face[::-1] if np.dot(normal, np.asarray(toward) - pts.mean(axis=0)) < 0 else face, material)

    def to_object(self, name, collection, materials, sharp_angle=35.0, location=(0.0, 0.0, 0.0)):
        """Mesh object; vertices are relative to ``location`` (asset frame), where the object origin goes."""
        mesh = bpy.data.meshes.new(name)
        mesh.from_pydata([to_blender(v) for v in self.verts], [], self.faces)
        used = sorted(set(self.mats))
        for m in used:
            mesh.materials.append(materials[m])
        mesh.polygons.foreach_set("material_index", [used.index(m) for m in self.mats])
        if mesh.validate():
            raise RuntimeError(f"{name}: generated mesh needed repairs; fix the generator")
        mesh.shade_smooth()
        mesh.set_sharp_from_angle(angle=math.radians(sharp_angle))
        obj = bpy.data.objects.new(name, mesh)
        obj.location = to_blender(location)
        collection.objects.link(obj)
        return obj


# --- body ---------------------------------------------------------------------------------------------
def half_width(z):
    hw = HW
    if z > 1.85:
        hw -= 0.055 * ((z - 1.85) / 0.50) ** 2
    if z < -1.90:
        hw -= 0.045 * ((-1.90 - z) / 0.45) ** 2
    return hw


def floor_y(z):
    if z > 1.75:
        return FLOOR + 0.14 * ((z - 1.75) / 0.60) ** 1.5
    if z < -1.85:
        return FLOOR + 0.16 * ((-1.85 - z) / 0.50) ** 1.5
    return FLOOR


def outer_bottom(z):
    for za in AXLES:
        dz = abs(z - za)
        if dz < ARCH_R:
            return HUB_Y + math.sqrt(ARCH_R ** 2 - dz ** 2)
    return max(floor_y(z) + 0.06, SILL)


def belt_y(z):
    if z >= Z_A:  # the hood edge falls towards the headlights
        return 0.945 - 0.11 * smoothstep((z - Z_A) / (2.20 - Z_A))
    if z >= Z_C:  # wedge: the beltline rises towards the C-pillar
        return 0.945 + 0.055 * (Z_A - z) / (Z_A - Z_C)
    return 1.0 + 0.02 * min(1.0, (Z_C - z) / 0.6)


def roof_y(z):
    return ROOF - ROOF_K * (z - Z_PEAK) ** 2


def top_centre(z):
    if z >= Z_WT:  # windshield
        t = (Z_A - z) / (Z_A - Z_WT)
        y0 = belt_y(Z_A) + 0.012 + 0.035
        return y0 + (roof_y(Z_WT) - y0) * (1 - (1 - t) ** 1.35)
    if z >= Z_RT:
        return roof_y(z)
    t = (z - Z_C) / (Z_RT - Z_C)  # rear window
    y0 = belt_y(Z_C) + 0.06
    return y0 + (roof_y(Z_RT) - y0) * (1 - (1 - t) ** 1.6)


def deck_points(z, hw, belt):
    crown = 0.035 if z > 0 else 0.02
    x9 = hw - 0.085
    return [(x9 * f, belt + 0.012 + crown * (1 - f * f)) for f in (0.80, 0.64, 0.48, 0.32, 0.16, 0.0)]


def glasshouse_points(z, hw, belt):
    xb, yb = hw - 0.10, belt + 0.02
    if z >= Z_WT:
        t = (Z_A - z) / (Z_A - Z_WT)
    elif z >= Z_RT:
        t = 1.0
    else:
        t = (z - Z_C) / (Z_RT - Z_C)
    xe, crown = xb + (ROOF_HALF - xb) * t, ROOF_CROWN * t
    yc = top_centre(z)
    ye = yc - crown
    p12 = (xe + 0.004, max(ye - 0.025, yb + 0.004))
    p13 = (xe, max(ye, p12[1] + 0.002))
    p11 = ((xb + p12[0]) / 2 + 0.012, (yb + p12[1]) / 2)
    return [(xb, yb), p11, p12, p13, (0.55 * xe, yc - crown * 0.3025), (0.0, yc)]


def glasshouse_weight(z):
    if Z_C <= z <= Z_A:
        return smoothstep((Z_A - z) / BLEND) * smoothstep((z - Z_C) / BLEND)
    return 0.0


def half_section(z):
    """16 half-section points (x >= 0, y) at station z, before end rounding."""
    hw, yf, yo, belt = half_width(z), floor_y(z), outer_bottom(z), belt_y(z)
    x_in = hw - 0.30
    y5 = max(0.40, yo + 0.06)
    y6 = max(0.68, y5 + 0.03)
    y7 = max(belt - 0.075, y6 + 0.02)
    lower = [(0.0, yf), (x_in, yf), (x_in, yo), (hw - 0.05, yo), (hw - 0.012, yo + 0.03),
             (hw, y5), (hw, y6), (hw - 0.018, y7), (hw - 0.04, belt), (hw - 0.085, belt + 0.012)]
    upper = np.asarray(deck_points(z, hw, belt))
    w = glasshouse_weight(z)
    if w > 0:
        upper = (1 - w) * upper + w * np.asarray(glasshouse_points(z, hw, belt))
    return np.vstack([np.asarray(lower), upper])


def end_rounding(z):
    """(f, nose height) for the rounded ends; f = 1 away from them."""
    for end in ENDS.values():
        start = end["z"] - math.copysign(end["length"], end["z"])
        u = (z - start) / (end["z"] - start)
        if u > 0:
            return (1 - min(u, 1.0) ** END_P) ** (1 / END_P), end["nose"]
    return 1.0, None


def section(z):
    pts = half_section(z)
    f, nose = end_rounding(z)
    if nose is not None:
        pts = np.column_stack([pts[:, 0] * (1 - 0.30 * (1 - f)), nose + (pts[:, 1] - nose) * f])
    return pts


def ring(z):
    """Closed section ring in 3D: left half bottom-to-top, then the mirrored right half top-to-bottom."""
    half = section(z)
    left = [(x, y, z) for x, y in half]
    right = [(-x, y, z) for x, y in half[14:0:-1]]
    return left + right


def stations():
    fixed = {Z_A, Z_A - BLEND, Z_WT, Z_PEAK, Z_RT, Z_C, Z_C + BLEND, DLO_REAR, *B_PILLAR, *DOOR_Z}
    for za in AXLES:
        fixed |= {za + (ARCH_R - 0.003) * math.cos(math.pi * k / 12) for k in range(13)}
        fixed |= {za - ARCH_R - 0.003, za + ARCH_R + 0.003}
    u_stop = (1 - END_F ** END_P) ** (1 / END_P)
    ends = set()
    for end in ENDS.values():
        sign = math.copysign(1.0, end["z"])
        for i in range(15):
            u = u_stop * math.sin(math.pi / 2 * i / 14)
            ends.add(end["z"] - sign * end["length"] * (1 - u))
    lo, hi = ZR + ENDS["rear"]["length"], ZF - ENDS["front"]["length"]
    uniform = {z for z in np.arange(lo, hi, STATION_STEP) if min(abs(z - f) for f in fixed) > 0.03}
    inner = {z for z in fixed | uniform if lo < z < hi}
    return sorted(inner | ends)


def segment_material(seg, z_mid, glasshouse):
    if seg <= 2:
        return "rubber"  # underbody and wheel-well liners
    if seg <= 8 or not glasshouse:
        return "paint"
    front_blend = z_mid > Z_A - BLEND
    rear_blend = z_mid < Z_C + BLEND
    if front_blend:
        return "trim"  # cowl panel and wiper well
    if seg == 9:
        return "trim" if z_mid > DLO_REAR else "paint"  # belt moulding along the side glass
    if seg in (10, 11):
        if rear_blend or z_mid < DLO_REAR:
            return "paint"  # C-pillar sail
        return "trim" if B_PILLAR[0] < z_mid < B_PILLAR[1] else "glass"
    if seg == 12:
        return "paint" if rear_blend else "trim"  # drip rail around the side glass
    return "paint" if Z_RT < z_mid < Z_WT else "glass"  # roof, or windshield / rear window


def build_body():
    part = Part()
    zs = stations()
    rows = [ring(z) for z in zs]
    n = len(rows[0])

    def material(i, k):
        seg = k if k <= 14 else n - 1 - k
        z_mid = (zs[i] + zs[i + 1]) / 2
        return segment_material(seg, z_mid, glasshouse_weight(z_mid) > 0 or Z_C < z_mid < Z_A)

    bases = part.grid(rows, material, closed=True)
    if part.signed_volume() < 0:  # the open ends are tiny, so the sign is reliable before capping
        part.flipped()
    for base, z, end in ((bases[0], zs[0], ENDS["rear"]), (bases[-1], zs[-1], ENDS["front"])):
        loop = list(range(base, base + n))
        centre = np.asarray(rows[0 if base == bases[0] else -1]).mean(axis=0)
        centre[2] = end["z"]
        part.fan(loop, centre, "paint", np.array([0.0, 0.0, math.copysign(1.0, end["z"])]))
    if part.signed_volume() <= 0:
        raise RuntimeError("body shell is not oriented outward")
    return part, zs, rows


# --- cabin: front doors, lining, jambs ------------------------------------------------------------------------
def door_segment(seg, z_mid):
    """True when the shell face of half-section segment ``seg`` between two stations belongs to a front door:
    the panel from the sill to the belt between the shut lines, and the side window ahead of the B-pillar."""
    if 4 <= seg <= 8:
        return DOOR_Z[0] < z_mid < DOOR_Z[1]
    if seg == 9:
        return DOOR_Z[0] < z_mid < Z_A - BLEND
    if seg in (10, 11):
        return B_PILLAR[1] < z_mid < Z_A - BLEND
    return False


def inner_ring(row, t):
    """Ring points moved inward by ``t`` within their section plane (rings run counter-clockwise in x/y)."""
    pts = np.asarray(row, dtype=np.float64)
    out = []
    for k in range(len(pts)):
        normals = []
        for a, b in ((pts[k - 1], pts[k]), (pts[k], pts[(k + 1) % len(pts)])):
            d = b[:2] - a[:2]
            length = math.hypot(d[0], d[1])
            if length > 1e-6:
                normals.append(np.array([-d[1], d[0]]) / length)  # left of travel = inside
        if not normals:
            out.append(pts[k].copy())
            continue
        n = sum(normals)
        n = n / max(np.linalg.norm(n), 1e-9)
        miter = t / max(0.5, float(np.dot(n, normals[0])))
        out.append(np.array([pts[k][0] + n[0] * miter, pts[k][1] + n[1] * miter, pts[k][2]]))
    return out


def build_cabin(body, zs, rows):
    """Cut the front doors out of the shell and line the cabin. Returns the shell without the doors, the
    doors (asset frame) by side, and the lining with the opening jambs and window seals."""
    n = len(rows[0])
    outer = [np.asarray(r, dtype=np.float64) for r in rows]
    lining_pts = [inner_ring(r, LINING) for r in rows]
    card_pts = [inner_ring(r, CARD) for r in rows]
    seg = lambda k: k if k <= 14 else n - 1 - k
    owner, glass = {}, {}
    for i in range(len(zs) - 1):
        z_mid = (zs[i] + zs[i + 1]) / 2
        for k in range(n):
            glass[i, k] = body.mats[i * n + k] == "glass"
            owner[i, k] = ("L" if k <= 14 else "R") if door_segment(seg(k), z_mid) else "body"

    def edges(i, k):
        """(neighbour cell, the shared edge's two grid points) for the four sides of cell (i, k)."""
        k1 = (k + 1) % n
        return [((i, (k - 1) % n), ((i, k), (i + 1, k))), ((i, k1), ((i, k1), (i + 1, k1))),
                ((i - 1, k), ((i, k), (i, k1))), ((i + 1, k), ((i + 1, k), (i + 1, k1)))]

    def quad(pts, i, k):
        k1 = (k + 1) % n
        return [pts[i][k], pts[i][k1], pts[i + 1][k1], pts[i + 1][k]]

    def strip(part, a, b, inner, material, toward):
        """Thickness strip along a cell edge, from the skin to ``inner``, facing the centre of cell ``toward``."""
        pts = [outer[a[0]][a[1]], outer[b[0]][b[1]], inner[b[0]][b[1]], inner[a[0]][a[1]]]
        part.oriented(pts, material, np.mean(quad(outer, *toward), axis=0))

    lining = Part()
    in_cabin = lambda i: CABIN_Z[0] - 1e-9 <= zs[i] and zs[i + 1] <= CABIN_Z[1] + 1e-9
    for (i, k), who in owner.items():
        if who != "body" or glass[i, k] or not in_cabin(i):
            continue
        q = quad(lining_pts, i, k)
        lining.oriented(q, "interior", CABIN_AXIS(np.mean(q, axis=0)))
        for (ni, nk), (a, b) in edges(i, k):
            if (ni, nk) in glass and glass[ni, nk] and owner[ni, nk] == "body":
                strip(lining, a, b, lining_pts, "trim", (ni, nk))  # window seal around fixed glass
    for z in CABIN_Z:  # bulkheads: the whole lining section at the windscreen base and behind the rear seat
        i = zs.index(z)
        lining.oriented(lining_pts[i], "interior", np.array([0.0, 0.7, z - math.copysign(1.0, z)]))

    doors = {}
    for side in ("L", "R"):
        door = body.subset([i * n + k for (i, k), who in owner.items() if who == side])
        for (i, k), who in owner.items():
            if who != side:
                continue
            if not glass[i, k]:
                q = quad(card_pts, i, k)
                door.oriented(q, "interior", CABIN_AXIS(np.mean(q, axis=0)))
            for (ni, nk), (a, b) in edges(i, k):
                if (ni, nk) not in owner:
                    continue
                if owner[ni, nk] != side:  # door outline: the door's own edge and the body's opening jamb
                    if not glass[i, k]:
                        strip(door, a, b, card_pts, "paint", (ni, nk))
                    # Window seals and the sill's scuff plate are black trim; the other jambs are body colour.
                    strip(lining, a, b, lining_pts, "trim" if glass[i, k] or seg(nk) <= 3 else "paint", (i, k))
                elif glass[ni, nk] and not glass[i, k]:
                    strip(door, a, b, card_pts, "trim", (ni, nk))  # window sill seal
        doors[side] = door
    cells = (len(zs) - 1) * n
    shell = body.subset([f for f in range(len(body.faces)) if f >= cells or owner[divmod(f, n)] == "body"])
    return shell, doors, lining


def CABIN_AXIS(p):
    """Point on the cabin's long axis level with ``p``: lining and card faces turn toward it."""
    return np.array([0.0, 0.75, p[2]])


# --- details projected onto the body ---------------------------------------------------------------
class Projector:
    def __init__(self, body):
        self.bvh = BVHTree.FromPolygons([Vector(v) for v in body.verts], body.faces)

    def hit(self, origin, direction):
        location, normal, _, _ = self.bvh.ray_cast(Vector(origin), Vector(direction))
        if location is None:
            raise RuntimeError(f"detail ray from {origin} along {direction} missed the body")
        n = np.array(normal)
        if np.dot(n, direction) > 0:
            n = -n
        return np.array(location), n

    def decal(self, part, material, origin_fn, direction, ns, nt, lift):
        direction = np.asarray(direction, dtype=np.float64)
        rows = []
        for i in range(ns + 1):
            row = []
            for j in range(nt + 1):
                p, n = self.hit(origin_fn(i / ns, j / nt), direction)
                row.append(p + n * lift)
            rows.append(row)
        part.grid(rows, material, want=lambda centre, normal: np.dot(normal, direction) > 0)


def mirrored(fn):
    return lambda s, t: (lambda p: (-p[0], p[1], p[2]))(fn(s, t))


def front_rect(x0, x1, y0, y1, z=3.0):
    return lambda s, t: (x0 + (x1 - x0) * s, y0 + (y1 - y0) * t, z)


def build_details(body):
    part = Part()
    proj = Projector(body)
    back, fwd, inward = (0.0, 0.0, -1.0), (0.0, 0.0, 1.0), (-1.0, 0.0, 0.0)

    def both_sides(material, fn, direction, ns, nt, lift):
        proj.decal(part, material, fn, direction, ns, nt, lift)
        d = np.asarray(direction, dtype=np.float64) * np.array([-1.0, 1.0, 1.0])
        proj.decal(part, material, mirrored(fn), d, ns, nt, lift)

    # Front: swept headlights with a daytime-running-light strip, grille, intake, plate.
    def headlight(s, t):
        x = 0.40 + 0.40 * s
        y_bot, y_top = 0.700 + 0.03 * s, 0.775 - 0.015 * s
        return (x, y_bot + (y_top - y_bot) * t, 3.0)

    def drl(s, t):
        x = 0.43 + 0.36 * s
        y_top = 0.775 - 0.015 * s
        return (x, y_top - 0.018 + 0.012 * t, 3.0)

    both_sides("metal", headlight, back, 10, 3, 0.003)  # reflector behind a clear lens
    both_sides("lamp_front", drl, back, 10, 1, 0.005)
    proj.decal(part, "trim", lambda s, t: (-0.36 - 0.04 * (1 - t) + (0.72 + 0.08 * (1 - t)) * s, 0.52 + 0.16 * t, 3.0), back, 12, 3, 0.003)
    proj.decal(part, "trim", front_rect(-0.52, 0.52, 0.27, 0.36), back, 12, 2, 0.003)
    proj.decal(part, "trim", front_rect(-0.268, 0.268, 0.382, 0.508), back, 6, 2, 0.004)
    proj.decal(part, "plate", front_rect(-0.26, 0.26, 0.39, 0.50), back, 6, 2, 0.006)

    # Rear: wrap-around tail lamps joined by a light bar, plate, diffuser.
    def taillight(s, t):
        x = 0.38 + 0.46 * s
        y_bot, y_top = 0.90 - 0.02 * s, 0.97
        return (x, y_bot + (y_top - y_bot) * t, -3.0)

    both_sides("lamp_rear", taillight, fwd, 10, 2, 0.004)
    proj.decal(part, "lamp_rear", front_rect(-0.38, 0.38, 0.935, 0.95, -3.0), fwd, 10, 1, 0.004)
    proj.decal(part, "trim", front_rect(-0.268, 0.268, 0.612, 0.738, -3.0), fwd, 6, 2, 0.004)
    proj.decal(part, "plate", front_rect(-0.26, 0.26, 0.62, 0.73, -3.0), fwd, 6, 2, 0.006)
    proj.decal(part, "trim", front_rect(-0.60, 0.60, 0.30, 0.40, -3.0), fwd, 12, 2, 0.003)

    # Sides: door shut lines and flush handles.
    def vertical_line(z):
        return lambda s, t: (2.0, DOOR_BOTTOM + (belt_y(z) - 0.02 - DOOR_BOTTOM) * s, z - 0.0025 + 0.005 * t)

    # The front door's lines lie just inside its cut (DOOR_Z), so they swing with it; the rear door is fixed.
    for z in (DOOR_Z[1] - 0.0025, DOOR_Z[0] + 0.0025, -0.99):
        both_sides("trim", vertical_line(z), inward, 8, 1, 0.002)
    both_sides("trim", lambda s, t: (2.0, DOOR_BOTTOM + 0.005 * t, 0.93 - 1.92 * s), inward, 16, 1, 0.002)
    for z0 in (0.24, -0.70):
        both_sides("alloy", lambda s, t, z0=z0: (2.0, 0.855 + 0.03 * t, z0 + 0.16 * s), inward, 3, 1, 0.008)

    # Door mirrors: a rounded housing on a short arm at the front of the side glass.
    for side in (1.0, -1.0):
        build_mirror(part, side)
    return part


def build_mirror(part, side):
    cx, cy, cz = 0.965 * side, 1.03, 0.74
    ax, ay, az = 0.095, 0.065, 0.05  # half sizes
    n_u, n_v = 14, 8
    v_max = math.pi / 2 * 0.86  # stop short of the poles; fans close them
    rows = []
    for i in range(n_v + 1):
        v = -v_max + 2 * v_max * i / n_v
        row = []
        for k in range(n_u):
            u = 2 * math.pi * k / n_u
            cu, su, cv, sv = math.cos(u), math.sin(u), math.cos(v), math.sin(v)
            e = 0.5  # superellipse exponent: boxier than an ellipsoid
            sgn = lambda a: math.copysign(abs(a) ** e, a)
            row.append((cx + ax * sgn(cv) * sgn(cu), cy + ay * sgn(sv), cz + az * sgn(cv) * sgn(su) * (1.0 if su > 0 else 0.6)))
        rows.append(row)

    def material(i, k):
        u = 2 * math.pi * (k + 0.5) / n_u
        v = -v_max + 2 * v_max * (i + 0.5) / n_v
        facing_back = math.sin(u) < -0.75 and abs(v) < 1.0
        return "metal" if facing_back else "paint"

    centre = np.array([cx, cy, cz])
    bases = part.grid(rows, material, closed=True, want=lambda c, normal: np.dot(normal, c - centre) < 0)
    for base, dy in ((bases[0], -ay), (bases[-1], ay)):
        part.fan(list(range(base, base + n_u)), (cx, cy + dy, cz), "paint", np.array([0.0, math.copysign(1.0, dy), 0.0]))
    # Arm from inside the door to the housing.
    x0, x1 = 0.80 * side, (cx - 0.06 * side)
    arm = [[(x0, 0.975, 0.76), (x0, 1.0, 0.76), (x0, 1.0, 0.70), (x0, 0.975, 0.70)],
           [(x1, 0.995, 0.75), (x1, 1.015, 0.75), (x1, 1.015, 0.71), (x1, 0.995, 0.71)]]
    mid = np.array([(x0 + x1) / 2, 0.99, 0.73])
    part.grid(arm, "trim", closed=True, want=lambda c, normal: np.dot(normal, c - mid) < 0)


# --- interior -----------------------------------------------------------------------------------------
def rounded_box(part, centre, half, material, pitch=0.0, e=0.32, n_u=16, n_v=8):
    """Superellipsoid block (flat faces, rounded edges). ``pitch`` (degrees) tilts its top toward -Z."""
    c = np.asarray(centre, dtype=np.float64)
    a = math.radians(pitch)
    rot = lambda p: np.array([p[0], p[1] * math.cos(a) + p[2] * math.sin(a), -p[1] * math.sin(a) + p[2] * math.cos(a)])
    sgn = lambda v: math.copysign(abs(v) ** e, v)
    v_max = math.pi / 2 * 0.9  # fans close the top and bottom
    rows = []
    for i in range(n_v + 1):
        v = -v_max + 2 * v_max * i / n_v
        rows.append([c + rot((half[0] * sgn(math.cos(v)) * sgn(math.cos(u)), half[1] * sgn(math.sin(v)),
                              half[2] * sgn(math.cos(v)) * sgn(math.sin(u))))
                     for u in (2 * math.pi * k / n_u for k in range(n_u))])
    bases = part.grid(rows, material, closed=True, want=lambda p, normal: np.dot(normal, p - c) < 0)
    for base, dy in ((bases[0], -half[1]), (bases[-1], half[1])):
        part.fan(list(range(base, base + n_u)), c + rot((0.0, dy, 0.0)), material, rot((0.0, math.copysign(1.0, dy), 0.0)))


def tube(part, a, b, radius, material, segments=12):
    """Capped cylinder from point ``a`` to ``b``."""
    a, b = np.asarray(a, dtype=np.float64), np.asarray(b, dtype=np.float64)
    axis = (b - a) / np.linalg.norm(b - a)
    u = np.cross(axis, (1.0, 0.0, 0.0))
    u /= np.linalg.norm(u)
    w = np.cross(axis, u)
    ring = lambda c: [c + radius * (math.cos(t) * u + math.sin(t) * w) for t in (2 * math.pi * k / segments for k in range(segments))]
    mid = (a + b) / 2
    bases = part.grid([ring(a), ring(b)], material, closed=True,
                      want=lambda p, normal: np.dot(normal, p - mid - np.dot(p - mid, axis) * axis) < 0)
    for base, end, out in ((bases[0], a, -axis), (bases[1], b, axis)):
        part.fan(list(range(base, base + segments)), end, material, out)


def wheel_frame(cabin):
    """Steering-wheel axes in the asset frame: X left, Y up the wheel face, Z along the column away from
    the driver (forward and down)."""
    tilt = math.radians(cabin["steeringWheel"]["tiltDeg"])
    return np.array([[1.0, 0.0, 0.0], [0.0, math.cos(tilt), math.sin(tilt)], [0.0, -math.sin(tilt), math.cos(tilt)]])


def build_interior(lining, sockets, cabin):
    """Lining plus seats, rear bench, dashboard, console and steering column (asset frame)."""
    part = Part().extend(lining)
    seat_x = sockets["SEAT_DRIVER"]["position"][0]
    for x in (seat_x, -seat_x):
        rounded_box(part, (x, 0.355, -0.13), (0.25, 0.08, 0.27), "interior", pitch=6)       # cushion
        rounded_box(part, (x, 0.74, -0.47), (0.25, 0.32, 0.065), "interior", pitch=14)      # backrest
        rounded_box(part, (x, 1.13, -0.57), (0.13, 0.09, 0.055), "interior", pitch=14)      # headrest
    rounded_box(part, (0.0, 0.34, -1.10), (0.60, 0.09, 0.25), "interior", pitch=4)          # rear bench
    rounded_box(part, (0.0, 0.72, -1.44), (0.60, 0.30, 0.07), "interior", pitch=18)
    rounded_box(part, (0.0, 0.80, 0.72), (0.89, 0.17, 0.16), "interior", e=0.4)             # dashboard
    wheel = np.asarray(sockets["STEERING_WHEEL"]["position"], dtype=np.float64)
    rounded_box(part, (wheel[0], 0.975, 0.63), (0.20, 0.035, 0.09), "trim")                 # instrument hood
    rounded_box(part, (0.0, 0.60, 0.60), (0.12, 0.20, 0.10), "trim", pitch=-15)             # centre stack
    rounded_box(part, (0.0, 0.33, 0.10), (0.10, 0.14, 0.42), "interior")                    # console
    column = wheel_frame(cabin)[2]
    tube(part, wheel + 0.04 * column, wheel + 0.26 * column, 0.032, "trim")
    return part


def torus(part, major, minor, material, n_u=32, n_v=8):
    """Ring in the local XY plane around the origin."""
    base = len(part.verts)
    for i in range(n_u):
        t = 2 * math.pi * i / n_u
        radial = np.array([math.cos(t), math.sin(t), 0.0])
        part.add([(major + minor * math.cos(q)) * radial + minor * math.sin(q) * np.array([0.0, 0.0, 1.0])
                  for q in (2 * math.pi * k / n_v for k in range(n_v))])
    for i in range(n_u):
        for k in range(n_v):
            i1, k1 = (i + 1) % n_u, (k + 1) % n_v
            face = [base + i * n_v + k, base + i1 * n_v + k, base + i1 * n_v + k1, base + i * n_v + k1]
            pts = np.array([part.verts[v] for v in face])
            centre = pts.mean(axis=0)
            ring_point = major * centre[:2] / np.linalg.norm(centre[:2])
            outward = centre - np.array([ring_point[0], ring_point[1], 0.0])
            normal = np.cross(pts[1] - pts[0], pts[3] - pts[0])
            part.face(face[::-1] if np.dot(normal, outward) < 0 else face, material)


def build_steering_wheel(cabin):
    """Rim, three spokes and hub in the wheel frame (see wheel_frame); the origin is the wheel centre."""
    part = Part()
    radius = cabin["steeringWheel"]["radius"]
    torus(part, radius, 0.014, "rubber")
    reach = (radius + 0.045) / 2
    for centre, half in (((reach, -0.01, 0.012), (reach - 0.04, 0.016, 0.007)),
                         ((-reach, -0.01, 0.012), (reach - 0.04, 0.016, 0.007)),
                         ((0.0, -reach, 0.012), (0.018, reach - 0.04, 0.007))):
        rounded_box(part, centre, half, "trim", n_u=12, n_v=6)
    rounded_box(part, (0.0, -0.005, 0.022), (0.06, 0.05, 0.022), "trim", e=0.45, n_u=12, n_v=6)
    return part


# --- wheels -------------------------------------------------------------------------------------------
TYRE_PROFILE = [(-0.1125, 0.222), (-0.1125, 0.285), (-0.105, 0.312), (-0.088, 0.327), (-0.05, 0.33),
                (0.05, 0.33), (0.088, 0.327), (0.105, 0.312), (0.1125, 0.285), (0.1125, 0.222)]
SPOKE_RINGS = [0.058, 0.085, 0.12, 0.155, 0.19, 0.205]
SPOKE_SEGMENTS = 60


def lathe(side, profile, segments, phase=0.0):
    rows = []
    for a, r in profile:
        rows.append([(side * a, r * math.cos(phase + 2 * math.pi * k / segments), r * math.sin(phase + 2 * math.pi * k / segments))
                     for k in range(segments)])
    return rows


def dish(r):
    return 0.070 + 0.032 * (r - SPOKE_RINGS[0]) / (SPOKE_RINGS[-1] - SPOKE_RINGS[0])


def is_window(ring_index, segment):
    """Twin-spoke pattern: per 72 degrees, spoke 2 segments, slot 1, spoke 2, open window 7."""
    if not 1 <= ring_index <= 3:
        return False
    return segment % 12 in (2, 5, 6, 7, 8, 9, 10, 11)


def build_wheel(side):
    part = Part()
    axial_out = lambda c, normal: normal[0] * side < 0
    part.grid(lathe(side, TYRE_PROFILE, WHEEL_SEGMENTS), "rubber", closed=True,
              want=lambda c, normal: (np.dot(normal[1:], c[1:]) < 0) if abs(normal[0]) < 0.5 * np.linalg.norm(normal)
              else (normal[0] * c[0] < 0))
    # Rim lip and barrel (barrel faces the axle; seen through the spoke windows).
    part.grid(lathe(side, [(0.1125, 0.222), (0.112, 0.214), (0.104, 0.205)], WHEEL_SEGMENTS), "alloy", closed=True, want=axial_out)
    part.grid(lathe(side, [(0.095, 0.205), (-0.10, 0.205)], WHEEL_SEGMENTS), "metal", closed=True, want=lambda c, normal: np.dot(normal[1:], c[1:]) > 0)
    back = lathe(side, [(-0.10, 0.205)], WHEEL_SEGMENTS)[0]
    start = part.add(back)
    part.fan(list(range(start, start + len(back))), (-0.10 * side, 0.0, 0.0), "trim", np.array([side, 0.0, 0.0]))
    # Brake disc and calliper behind the spokes.
    part.grid(lathe(side, [(-0.02, 0.08), (-0.02, 0.165)], WHEEL_SEGMENTS), "metal", closed=True, want=axial_out)
    calliper = [[(side * -0.05, 0.14, -0.06), (side * -0.05, 0.19, -0.06), (side * 0.0, 0.19, -0.06), (side * 0.0, 0.14, -0.06)],
                [(side * -0.05, 0.14, 0.06), (side * -0.05, 0.19, 0.06), (side * 0.0, 0.19, 0.06), (side * 0.0, 0.14, 0.06)]]
    centre = np.array([side * -0.025, 0.165, 0.0])
    angle = math.radians(115.0)  # rotate the calliper behind the axle, upper rear quadrant
    rot = lambda p: (p[0], p[1] * math.cos(angle) - p[2] * math.sin(angle), p[1] * math.sin(angle) + p[2] * math.cos(angle))
    calliper = [[rot(p) for p in row] for row in calliper]
    rc = np.array(rot(centre))
    part.grid(calliper, "trim", closed=True, want=lambda c, normal: np.dot(normal, c - rc) < 0)
    # Spoke face: polar grid with windows cut out, side walls along every window edge, centre cap.
    face = [[(side * dish(r), r * math.cos(2 * math.pi * k / SPOKE_SEGMENTS), r * math.sin(2 * math.pi * k / SPOKE_SEGMENTS))
             for k in range(SPOKE_SEGMENTS)] for r in SPOKE_RINGS]
    bases = [part.add(row) for row in face]
    depth = 0.025
    walls = Part()
    for i in range(len(SPOKE_RINGS) - 1):
        for k in range(SPOKE_SEGMENTS):
            if is_window(i, k):
                continue
            k1 = (k + 1) % SPOKE_SEGMENTS
            quad = [bases[i] + k, bases[i] + k1, bases[i + 1] + k1, bases[i + 1] + k]
            pts = np.array([part.verts[v] for v in quad])
            normal = np.cross(pts[1] - pts[0], pts[3] - pts[0])
            part.face(quad[::-1] if normal[0] * side < 0 else quad, "alloy")
            edges = [((i, k), (i, k1), (i - 1, k)), ((i + 1, k), (i + 1, k1), (i + 1, k)),
                     ((i, k), (i + 1, k), (i, k - 1)), ((i, k1), (i + 1, k1), (i, k1))]
            for a, b, neighbour in edges:
                ni, nk = neighbour[0], neighbour[1] % SPOKE_SEGMENTS
                if 0 <= ni < len(SPOKE_RINGS) - 1 and is_window(ni, nk):
                    pa, pb = np.array(face[a[0]][a[1] % SPOKE_SEGMENTS]), np.array(face[b[0]][b[1] % SPOKE_SEGMENTS])
                    back_off = np.array([-side * depth, 0.0, 0.0])
                    wall = [pa, pb, pb + back_off, pa + back_off]
                    centre_spoke = pts.mean(axis=0)
                    base = walls.add(wall)
                    w = [base, base + 1, base + 2, base + 3]
                    wn = np.cross(wall[1] - wall[0], wall[3] - wall[0])
                    out = (pa + pb) / 2 - centre_spoke
                    out[0] = 0.0
                    walls.face(w[::-1] if np.dot(wn, out) < 0 else w, "alloy")
    offset = part.add(walls.verts)
    for f, m in zip(walls.faces, walls.mats):
        part.face([v + offset for v in f], m)
    part.fan(list(range(bases[0], bases[0] + SPOKE_SEGMENTS)), (side * 0.072, 0.0, 0.0), "alloy", np.array([side, 0.0, 0.0]))
    return part


# --- materials, sockets, export ------------------------------------------------------------------------
def make_materials(paint):
    out = {}
    specs = {"paint": (tuple(paint["baseColorSrgb"]), paint["roughness"], paint["metallic"], paint["clearcoat"], None), **MATERIALS}
    for name, (colour, roughness, metallic, coat, emission) in specs.items():
        material = bpy.data.materials.new(f"car_{name}")
        if material.node_tree is None:
            material.use_nodes = True
        p = next(n for n in material.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
        p.inputs["Base Color"].default_value = srgb_to_linear(colour) + (1.0,)
        p.inputs["Roughness"].default_value = roughness
        p.inputs["Metallic"].default_value = metallic
        if coat:
            p.inputs["Coat Weight"].default_value = coat
            p.inputs["Coat Roughness"].default_value = 0.03
        if emission:
            p.inputs["Emission Color"].default_value = srgb_to_linear(emission) + (1.0,)
            p.inputs["Emission Strength"].default_value = 1.0
        if name == "glass":  # exported as alphaMode BLEND
            p.inputs["Alpha"].default_value = GLASS_ALPHA
            material.surface_render_method = "BLENDED"
        material["role"] = "vehicle"
        out[name] = material
    return out


def box(name, centre, size, collection):
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=to_blender(centre))
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = (size[0], size[2], size[1])
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    for c in list(obj.users_collection):
        c.objects.unlink(obj)
    collection.objects.link(obj)
    return obj


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--contract", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--stem", default="car-sedan", help="output file name stem")
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
    contract = json.loads(args.contract.read_text(encoding="utf-8"))
    args.out.mkdir(parents=True, exist_ok=False)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    visual = bpy.data.collections.new("VISUAL")
    scene.collection.children.link(visual)
    collision = bpy.data.collections.new("COLLISION")
    scene.collection.children.link(collision)
    root = bpy.data.objects.new("CAR_ROOT", None)  # pivot: ground plane, centred between the axles
    root["role"] = "asset-root"
    root["assetId"] = contract["assetId"]
    visual.objects.link(root)
    materials = make_materials(contract["paint"])

    shell, zs, rows = build_body()
    lo, hi = np.min(shell.verts, axis=0), np.max(shell.verts, axis=0)
    size = (hi - lo).tolist()
    if max(abs(a - b) for a, b in zip(size, contract["bodySize"])) > 1e-3 or abs(lo[0] + hi[0]) > 1e-6:
        raise RuntimeError(f"body size {size} (min {lo.tolist()}) does not match the contract {contract['bodySize']}")
    details = build_details(shell)  # projected onto the whole shell, then split with the doors
    body, door_shells, lining = build_cabin(shell, zs, rows)
    sockets = {s["node"]: s for s in contract["sockets"]}
    cabin = contract["cabin"]
    if abs(cabin["floorY"] - (FLOOR + LINING)) > 1e-9:
        raise RuntimeError(f"cabin.floorY {cabin['floorY']} is not the lined floor {FLOOR + LINING}")
    on_door = lambda c, side: c[0] * side > 0.5 and 0.2 < c[1] < 1.25 and DOOR_Z[0] < c[2] < DOOR_Z[1]
    centroids = [np.mean([details.verts[v] for v in f], axis=0) for f in details.faces]
    doors = {}
    for name, side, key in (("DOOR_FL", 1.0, "L"), ("DOOR_FR", -1.0, "R")):
        hinge = np.asarray(sockets[name]["position"], dtype=np.float64)
        if abs(hinge[2] - DOOR_Z[1]) > 1e-9 or not 0.0 < hinge[0] * side < HW:
            raise RuntimeError(f"{name}: the hinge must lie on the door's front edge inside the skin")
        door = door_shells[key].subset(range(len(door_shells[key].faces)), origin=hinge)
        door.extend(details.subset([f for f, c in enumerate(centroids) if on_door(c, side)], origin=hinge))
        doors[name] = (door, hinge)
    details = details.subset([f for f, c in enumerate(centroids) if not (on_door(c, 1.0) or on_door(c, -1.0))])
    interior = build_interior(lining, sockets, cabin)
    parts = {"CAR_BODY": (body, "vehicle-body"), "CAR_DETAILS": (details, "vehicle-detail"),
             "CAR_INTERIOR": (interior, "vehicle-interior")}
    for name, (part, role) in parts.items():
        obj = part.to_object(name, visual, materials)
        obj.parent = root
        obj["role"] = role
    for name, (door, hinge) in doors.items():
        obj = door.to_object(name, visual, materials, location=hinge)
        obj.parent = root
        obj["role"] = "vehicle-door"
        obj["openDeg"] = cabin["doorOpenDeg"]
    steering = build_steering_wheel(cabin)
    obj = steering.to_object("STEERING_WHEEL", visual, materials, location=sockets["STEERING_WHEEL"]["position"])
    t = np.array([[1.0, 0.0, 0.0], [0.0, 0.0, -1.0], [0.0, 1.0, 0.0]])  # asset -> Blender axes
    obj.rotation_mode = "QUATERNION"
    obj.rotation_quaternion = Matrix((t @ wheel_frame(cabin).T @ t.T).tolist()).to_quaternion()
    obj.parent = root
    obj["role"] = "steering-wheel"
    obj["lockDeg"] = cabin["steeringWheel"]["lockDeg"]

    wheel_tris = {}
    for name in ("WHEEL_FL", "WHEEL_FR", "WHEEL_RL", "WHEEL_RR"):
        hub = sockets[name]["position"]
        if abs(hub[1] - contract["wheel"]["radius"]) > 1e-9:
            raise RuntimeError(f"{name}: hub height must equal the wheel radius")
        side = 1.0 if hub[0] > 0 else -1.0
        part = build_wheel(side)  # authored around the hub, which becomes the object origin
        obj = part.to_object(name, visual, materials, location=hub)
        obj.parent = root
        obj["role"] = "wheel"
        wheel_tris[name] = part.triangles()
    for name, socket in sockets.items():
        if name.startswith("WHEEL_") or name in MESH_SOCKETS:
            continue
        empty = bpy.data.objects.new(name, None)
        empty.empty_display_type = "PLAIN_AXES"
        empty.location = to_blender(socket["position"])
        empty["role"] = "socket"
        empty["purpose"] = socket["purpose"]
        visual.objects.link(empty)
        empty.parent = root
    collider = contract["collider"]
    proxy = box("CAR_COLLIDER", collider["centre"], [2 * h for h in collider["halfExtents"]], collision)
    proxy.display_type = "WIRE"

    bpy.ops.object.select_all(action="DESELECT")
    for obj in visual.all_objects:
        obj.select_set(True)
    glb = args.out / f"{args.stem}.glb"
    export_options = dict(filepath=str(glb), export_format="GLB", use_selection=True, export_yup=True,
                          export_apply=False, export_normals=True, export_texcoords=False, export_tangents=False,
                          export_vertex_color="NONE", export_materials="EXPORT", export_extras=True,
                          export_cameras=False, export_lights=False, export_copyright="Original procedural asset")
    bpy.ops.export_scene.gltf(**export_options)
    bpy.ops.wm.save_as_mainfile(filepath=str(args.out / f"{args.stem}.blend"), compress=True)
    data = glb.read_bytes()
    report = {"status": "EXPORTED_NOT_VERIFIED_IN_RUNTIME", "blender": bpy.app.version_string, "assetId": contract["assetId"],
              "bodyBoundsAsset": {"min": lo.round(4).tolist(), "max": hi.round(4).tolist()}, "bodyStations": len(zs),
              "triangles": {"body": body.triangles(), "details": details.triangles(), "interior": interior.triangles(),
                            "doors": {n: d.triangles() for n, (d, _) in doors.items()}, "steeringWheel": steering.triangles(),
                            "wheels": wheel_tris,
                            "total": body.triangles() + details.triangles() + interior.triangles() + steering.triangles()
                            + sum(d.triangles() for d, _ in doors.values()) + sum(wheel_tris.values())},
              "materials": sorted(materials),
              "exportOptions": {k: v for k, v in export_options.items() if k != "filepath"},
              "output": {"path": glb.name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}}
    (args.out / "blender-report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"triangles": report["triangles"], "bytes": len(data)}))


if __name__ == "__main__":
    main()
