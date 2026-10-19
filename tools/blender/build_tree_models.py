"""Own tree models for the city tree layer (plan sections 3 and 4.3: positions and heights from the city, own models):
scenery-trees.glb holds three nodes, tree-broadleaf (lime, maple, aspen, cherry), tree-birch and tree-pine, each one
mesh with a bark and a leaf material on one shared, procedurally drawn atlas (no photographs, no external files).

Every model is built at REF_HEIGHT with its own reference crown diameter, origin at the trunk base, +Z up; the game
scales each instance to the register height and crown diameter (tools/world/build_trees.ts). Crowns are leaf cards
(alpha-tested, two-sided) whose corner normals point out of the crown centre, so a crown shades as one volume, and a
vertex colour darkens the inside and underside of the crown (glTF COLOR_0). The leaf material is set to alphaMode
MASK in the written GLB because the exporter has no switch for it.

  blender --background --factory-startup --disable-autoexec --python build_tree_models.py -- \
      --out data/work/m0/blender-scenery [--preview]
"""
import argparse
import datetime
import hashlib
import json
import math
import random
import struct
import sys
from pathlib import Path

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector
sys.path.insert(0, str(Path(__file__).resolve().parent))
import release_pin  # noqa: E402

release_pin.require()

ASSET_ID = "scenery-trees"
ATLAS = 1024
REF_HEIGHT = 10.0
SEED = 20261017
ALPHA_CUTOFF = 0.4   # below 0.5 so distant mip levels, which average the leaf alpha down, keep their crowns
# Atlas regions in Blender UV space (u right, v up): (u0, v0, u1, v1).
REGION = {
    "leaf_broad": (0.0, 0.5, 0.5, 1.0),
    "leaf_birch": (0.5, 0.5, 1.0, 1.0),
    "needles": (0.0, 0.0, 0.5, 0.5),
    "bark": (0.5, 0.0, 0.75, 0.5),
    "bark_birch": (0.75, 0.0, 1.0, 0.5),
}
# Per model: reference crown diameter, clear trunk, crown centre and radii, leaf cards, card size range, region, AO floor.
MODELS = {
    "tree-broadleaf": {"crown": 8.0, "trunk_top": 4.0, "trunk_r": (0.26, 0.15), "leader_top": 8.6, "centre": 6.6, "radii": (4.0, 4.0, 3.3),
                       "cards": 340, "card": (1.5, 2.3), "leaf": "leaf_broad", "bark": "bark", "branches": 7, "branch_r": 0.09, "shell": 0.5, "ao": 0.42, "droop": 0.0, "per_end": 4},
    "tree-birch": {"crown": 6.0, "trunk_top": 3.0, "trunk_r": (0.17, 0.07), "leader_top": 9.4, "centre": 6.4, "radii": (3.0, 3.0, 3.6),
                   "cards": 260, "card": (1.1, 1.7), "leaf": "leaf_birch", "bark": "bark_birch", "branches": 9, "branch_r": 0.06, "shell": 0.45, "ao": 0.5, "droop": 0.35, "per_end": 4},
    "tree-pine": {"crown": 6.0, "trunk_top": 5.6, "trunk_r": (0.21, 0.07), "leader_top": 9.7, "centre": 8.0, "radii": (3.0, 3.0, 2.0),
                  "cards": 330, "card": (1.3, 2.1), "leaf": "needles", "bark": "bark", "branches": 12, "branch_r": 0.07, "shell": 0.2, "ao": 0.45, "droop": 0.0, "per_end": 9},
}
TRUNK_SIDES = 9
BRANCH_SIDES = 5


# ---------------------------------------------------------------- atlas
def _blit_ellipse(img, cx, cy, rx, ry, angle, colour, edge=1.2):
    """Alpha-composite one leaf (an ellipse pointed at one end, lit across its width) onto an RGBA float image."""
    h, w, _ = img.shape
    r = int(max(rx, ry)) + 2
    x0, x1, y0, y1 = max(0, int(cx) - r), min(w, int(cx) + r + 1), max(0, int(cy) - r), min(h, int(cy) + r + 1)
    if x0 >= x1 or y0 >= y1:
        return
    yy, xx = np.mgrid[y0:y1, x0:x1].astype(np.float32)
    dx, dy = xx - cx, yy - cy
    c, s = math.cos(angle), math.sin(angle)
    u, v = (dx * c + dy * s) / rx, (-dx * s + dy * c) / ry
    taper = 1.0 - 0.35 * np.clip(u, 0, 1)            # narrower toward the tip
    d = u * u + (v / taper) ** 2
    a = np.clip((1.0 - d) * rx / edge, 0.0, 1.0)
    shade = (0.82 + 0.28 * np.clip(-v, -1, 1) * 0.5 + 0.1 * (1 - np.abs(u)))[..., None]
    vein = np.where(np.abs(v) < 0.08, 0.86, 1.0)[..., None]
    col = np.clip(np.array(colour, np.float32)[None, None, :] * shade * vein, 0, 1)
    dst = img[y0:y1, x0:x1]
    aa = a[..., None]
    dst[..., :3] = dst[..., :3] * (1 - aa) + col * aa
    dst[..., 3:] = dst[..., 3:] * (1 - aa) + aa


def _blit_line(img, x0, y0, x1, y1, width, colour):
    h, w, _ = img.shape
    pad = int(width) + 2
    bx0, bx1 = max(0, int(min(x0, x1)) - pad), min(w, int(max(x0, x1)) + pad + 1)
    by0, by1 = max(0, int(min(y0, y1)) - pad), min(h, int(max(y0, y1)) + pad + 1)
    if bx0 >= bx1 or by0 >= by1:
        return
    yy, xx = np.mgrid[by0:by1, bx0:bx1].astype(np.float32)
    vx, vy = x1 - x0, y1 - y0
    L2 = max(vx * vx + vy * vy, 1e-6)
    t = np.clip(((xx - x0) * vx + (yy - y0) * vy) / L2, 0, 1)
    d = np.hypot(xx - (x0 + t * vx), yy - (y0 + t * vy))
    a = np.clip(width / 2 + 0.6 - d, 0, 1)[..., None]
    dst = img[by0:by1, bx0:bx1]
    dst[..., :3] = dst[..., :3] * (1 - a) + np.array(colour, np.float32) * a
    dst[..., 3:] = dst[..., 3:] * (1 - a) + a


def leaf_cluster(size, rng, leaves, leaf_size, greens, twig, spread=0.46, elong=1.0):
    img = np.zeros((size, size, 4), np.float32)
    c = size / 2
    # twigs from the centre outwards, then leaves along and around them
    tips = []
    for k in range(9):
        ang = rng.uniform(0, 2 * math.pi)
        length = rng.uniform(0.25, 0.44) * size
        tx, ty = c + math.cos(ang) * length, c + math.sin(ang) * length * elong
        _blit_line(img, c, c, tx, ty, 2.2, twig)
        tips.append((tx, ty))
    for k in range(leaves):
        if rng.random() < 0.55:
            tx, ty = tips[rng.randrange(len(tips))]
            f = rng.uniform(0.3, 1.0)
            x, y = c + (tx - c) * f + rng.gauss(0, size * 0.05), c + (ty - c) * f + rng.gauss(0, size * 0.05)
        else:
            r = spread * size * math.sqrt(rng.random())
            ang = rng.uniform(0, 2 * math.pi)
            x, y = c + math.cos(ang) * r, c + math.sin(ang) * r * elong
        if math.hypot(x - c, (y - c) / elong) > spread * size:
            continue
        s = rng.uniform(*leaf_size)
        g = greens[rng.randrange(len(greens))]
        jitter = rng.uniform(0.85, 1.12)
        _blit_ellipse(img, x, y, s, s * rng.uniform(0.55, 0.75), rng.uniform(0, 2 * math.pi), [ch * jitter for ch in g])
    return img


def needle_cluster(size, rng):
    img = np.zeros((size, size, 4), np.float32)
    c = size / 2
    for k in range(40):
        ang = rng.uniform(0, 2 * math.pi)
        r = rng.uniform(0.05, 0.36) * size
        tx, ty = c + math.cos(ang) * r, c + math.sin(ang) * r
        _blit_line(img, c, c, tx, ty, 2.5, (0.30, 0.22, 0.15))
        for n in range(64):
            a2 = rng.uniform(0, 2 * math.pi)
            ln = rng.uniform(0.03, 0.075) * size
            g = rng.choice([(0.13, 0.24, 0.15), (0.17, 0.30, 0.17), (0.21, 0.33, 0.19), (0.11, 0.2, 0.13)])
            _blit_line(img, tx, ty, tx + math.cos(a2) * ln, ty + math.sin(a2) * ln, 1.8, g)
    return img


def bark(w, h, rng, base, crack, birch=False):
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    noise = np.zeros((h, w), np.float32)
    for k in range(5):
        fx, fy = rng.uniform(2, 6) * (k + 1), rng.uniform(0.5, 2) * (k + 1)
        ph = rng.uniform(0, 2 * math.pi)
        noise += np.sin(xx / w * 2 * math.pi * fx + np.sin(yy / h * 2 * math.pi * fy + ph) * 1.5 + ph) / (k + 1)
    noise = (noise - noise.min()) / (noise.max() - noise.min())
    img = np.zeros((h, w, 4), np.float32)
    col = np.array(base, np.float32)
    img[..., :3] = col * (0.75 + 0.35 * noise[..., None])
    img[..., 3] = 1.0
    if birch:
        for k in range(150):     # dark lenticels and patches across the stem
            x, y = rng.uniform(0, w), rng.uniform(0, h)
            _blit_ellipse(img, x, y, rng.uniform(3, 14), rng.uniform(0.8, 2.2), rng.gauss(0, 0.08), crack, edge=0.8)
        for k in range(14):
            x, y = rng.uniform(0, w), rng.uniform(0, h)
            _blit_ellipse(img, x, y, rng.uniform(8, 22), rng.uniform(5, 16), rng.uniform(0, 3), [c * 0.8 for c in crack], edge=1.5)
    else:
        cracks = (noise < 0.22)[..., None]
        img[..., :3] = np.where(cracks, np.array(crack, np.float32), img[..., :3])
    img[..., 3] = 1.0
    return img


def bleed(img):
    """Give transparent texels the mean colour of the opaque ones, so mip levels do not fringe dark."""
    a = img[..., 3]
    m = a > 0.5
    if m.any():
        mean = img[..., :3][m].mean(axis=0)
        img[..., :3] = np.where((a < 0.02)[..., None], mean, img[..., :3])
    return img


def build_atlas(path):
    rng = random.Random(SEED)
    half, quarter = ATLAS // 2, ATLAS // 4
    atlas = np.zeros((ATLAS, ATLAS, 4), np.float32)   # row 0 is the top here; flipped for Blender at the end
    broad = leaf_cluster(half, rng, 520, (11, 19), [(0.24, 0.40, 0.13), (0.30, 0.47, 0.16), (0.20, 0.34, 0.11), (0.36, 0.52, 0.19), (0.27, 0.43, 0.20)], (0.27, 0.21, 0.15))
    birch = leaf_cluster(half, rng, 900, (7, 12), [(0.40, 0.56, 0.18), (0.47, 0.62, 0.22), (0.34, 0.50, 0.16), (0.52, 0.64, 0.26)], (0.22, 0.17, 0.13), spread=0.47, elong=1.15)
    needles = needle_cluster(half, rng)
    brown = bark(quarter, half, rng, (0.36, 0.30, 0.25), (0.16, 0.13, 0.11))
    white = bark(quarter, half, rng, (0.88, 0.87, 0.82), (0.12, 0.11, 0.10), birch=True)

    def put(region, tile):
        u0, v0, u1, v1 = REGION[region]
        x0, x1 = int(u0 * ATLAS), int(u1 * ATLAS)
        y0, y1 = int((1 - v1) * ATLAS), int((1 - v0) * ATLAS)
        atlas[y0:y1, x0:x1] = tile[: y1 - y0, : x1 - x0]
    put("leaf_broad", bleed(broad))
    put("leaf_birch", bleed(birch))
    put("needles", bleed(needles))
    put("bark", brown)
    put("bark_birch", white)
    flipped = np.ascontiguousarray(atlas[::-1])
    image = bpy.data.images.new("tree-atlas", ATLAS, ATLAS, alpha=True)
    image.pixels.foreach_set(flipped.ravel())
    image.filepath_raw = str(path)
    image.file_format = "PNG"
    image.save()
    return image


# ---------------------------------------------------------------- geometry
class Builder:
    def __init__(self, name):
        self.bm = bmesh.new()
        self.uv = self.bm.loops.layers.uv.new("UVMap")
        self.normals = []      # per face: list of per-corner normals or None (flat)
        self.ao = []           # per face: list of per-corner AO values
        self.name = name

    def face(self, verts, uvs, mat, normals=None, ao=None):
        f = self.bm.faces.new([self.bm.verts.new(v) for v in verts])
        f.material_index = mat
        for loop, uv in zip(f.loops, uvs):
            loop[self.uv].uv = uv
        self.normals.append(normals)
        self.ao.append(ao or [1.0] * len(verts))
        return f


def region_uv(region, u, v):
    u0, v0, u1, v1 = REGION[region]
    return (u0 + (u1 - u0) * u, v0 + (v1 - v0) * v)


def tube(b, points, radii, sides, region, ao_fn):
    """A tapered tube through `points` (Vectors) with ring radii `radii`; the bark tile wraps once around and runs
    once along the whole tube (an atlas region cannot repeat)."""
    rings = []
    for i, p in enumerate(points):
        d = (points[min(i + 1, len(points) - 1)] - points[max(i - 1, 0)]).normalized()
        a = Vector((1, 0, 0)) if abs(d.z) > 0.9 else Vector((0, 0, 1))
        x = d.cross(a).normalized()
        y = d.cross(x).normalized()
        rings.append([p + (x * math.cos(2 * math.pi * k / sides) + y * math.sin(2 * math.pi * k / sides)) * radii[i] for k in range(sides)])
    length = 0.0
    vs = [0.0]
    for i in range(1, len(points)):
        length += (points[i] - points[i - 1]).length
        vs.append(length)
    for i in range(len(points) - 1):
        for k in range(sides):
            k1 = (k + 1) % sides
            quad = [rings[i][k], rings[i][k1], rings[i + 1][k1], rings[i + 1][k]]
            us = [k / sides, (k + 1) / sides, (k + 1) / sides, k / sides]
            vv = [vs[i] / length, vs[i] / length, vs[i + 1] / length, vs[i + 1] / length]
            b.face(quad, [region_uv(region, us[j], vv[j]) for j in range(4)], 0, ao=[ao_fn(q) for q in quad])


def build_tree(name, P, rng):
    b = Builder(name)
    h_ref = REF_HEIGHT
    cz, (rx, ry, rz) = P["centre"], P["radii"]
    centre = Vector((0, 0, cz))

    def crown_ao(q):
        # inside of the crown and its underside are darker; the trunk takes the value at its height
        rel = Vector(((q.x) / rx, (q.y) / ry, (q.z - cz) / rz))
        d = min(rel.length, 1.0)
        up = min(max((q.z - (cz - rz)) / (2 * rz), 0.0), 1.0)
        return P["ao"] + (1 - P["ao"]) * (0.55 * d + 0.45 * up)

    bark_ao = lambda q: 0.55 + 0.45 * min(q.z / P["trunk_top"], 1.0) if q.z < P["trunk_top"] else crown_ao(q) * 0.9
    # trunk and leader, with a slight lean
    lean = Vector((rng.uniform(-0.15, 0.15), rng.uniform(-0.15, 0.15), 0))
    pts, radii = [], []
    n = 6
    r0, r1 = P["trunk_r"]
    for i in range(n + 1):
        t = i / n
        z = P["leader_top"] * t
        pts.append(Vector((0, 0, z)) + lean * t * t)
        radii.append(r0 + (r1 * 0.45 - r0) * t if z > P["trunk_top"] else r0 + (r1 - r0) * (z / P["trunk_top"]))
    tube(b, pts, radii, TRUNK_SIDES, P["bark"], bark_ao)
    # main branches from the top of the clear trunk out toward the crown shell
    ends = []
    for k in range(P["branches"]):
        ang = 2 * math.pi * (k + rng.uniform(-0.3, 0.3)) / P["branches"]
        z0 = P["trunk_top"] + rng.uniform(-0.2, 0.55) * (P["leader_top"] - P["trunk_top"]) * (0.6 if name != "tree-pine" else 1.0)
        out = Vector((math.cos(ang), math.sin(ang), 0))
        reach = rng.uniform(0.6, 0.85)
        rise = rng.uniform(0.35, 0.9) * rz * (0.4 if name == "tree-pine" else 1.0)
        start = Vector((0, 0, z0)) + lean * (z0 / P["leader_top"]) ** 2
        mid = start + out * rx * reach * 0.55 + Vector((0, 0, rise * 0.75))
        end = start + out * rx * reach + Vector((0, 0, rise * (1 - P["droop"])))
        r = P["branch_r"] * rng.uniform(0.8, 1.2)
        tube(b, [start, mid, end], [r, r * 0.6, r * 0.3], BRANCH_SIDES, P["bark"], crown_ao)
        ends.append(end)
    # leaf cards: on the branch ends, then over the crown volume biased to the shell
    lo, hi = P["card"]
    for k in range(P["cards"]):
        if k < len(ends) * P["per_end"]:
            e = ends[k % len(ends)]
            p = e + Vector((rng.gauss(0, 0.5), rng.gauss(0, 0.5), rng.gauss(0, 0.4)))
        else:
            while True:
                q = Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(-1, 1)))
                if P["shell"] ** 2 <= q.length_squared <= 1.0:
                    break
            p = Vector((q.x * rx, q.y * ry, cz + q.z * rz))
            if name == "tree-pine":     # pine crowns: clumps at the whorls, flat-topped
                p.z = cz + q.z * rz * 0.8
        size = rng.uniform(lo, hi)
        radial = (p - centre)
        radial = Vector((radial.x / rx, radial.y / ry, radial.z / rz))
        if radial.length < 1e-3:
            radial = Vector((1, 0, 0))
        radial.normalize()
        # card plane: mostly facing outward, tilted at random; birch cards hang more vertically
        nrm = (radial + Vector((rng.gauss(0, 0.6), rng.gauss(0, 0.6), rng.gauss(0, 0.6)))).normalized()
        if P["droop"]:
            nrm = (nrm + Vector((0, 0, -nrm.z * P["droop"] * 1.5))).normalized()
        a = Vector((0, 0, 1)) if abs(nrm.z) < 0.9 else Vector((1, 0, 0))
        x = nrm.cross(a).normalized()
        y = nrm.cross(x).normalized()
        spin = rng.uniform(0, 2 * math.pi)
        x, y = x * math.cos(spin) + y * math.sin(spin), -x * math.sin(spin) + y * math.cos(spin)
        corners = [p + (-x - y) * size / 2, p + (x - y) * size / 2, p + (x + y) * size / 2, p + (-x + y) * size / 2]
        uvs = [region_uv(P["leaf"], 0, 0), region_uv(P["leaf"], 1, 0), region_uv(P["leaf"], 1, 1), region_uv(P["leaf"], 0, 1)]
        # corner normals: from the crown centre through the corner, so the whole crown shades as one volume
        normals = []
        for c in corners:
            d = c - centre
            d = Vector((d.x / rx, d.y / ry, d.z / rz))
            normals.append((d.normalized() + nrm * 0.25).normalized())
        b.face(corners, uvs, 1, normals=normals, ao=[crown_ao(c) for c in corners])
    return b


def to_object(b, materials):
    me = bpy.data.meshes.new(b.name)
    b.bm.to_mesh(me)
    b.bm.free()
    for m in materials:
        me.materials.append(m)
    for p in me.polygons:
        p.use_smooth = True
    # corner normals: cards take their crown normals; tubes keep their smooth normals
    loops = me.loops
    custom = [None] * len(loops)
    for poly, normals in zip(me.polygons, b.normals):
        for li, k in zip(poly.loop_indices, range(poly.loop_total)):
            custom[li] = tuple(normals[k]) if normals else None
    default = [tuple(l.normal) for l in loops]
    me.normals_split_custom_set([c if c is not None else d for c, d in zip(custom, default)])
    attr = me.color_attributes.new(name="Color", type="FLOAT_COLOR", domain="CORNER")
    for poly, ao in zip(me.polygons, b.ao):
        for li, k in zip(poly.loop_indices, range(poly.loop_total)):
            v = ao[k]
            attr.data[li].color = (v, v, v, 1.0)
    me.color_attributes.active_color = attr
    obj = bpy.data.objects.new(b.name, me)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def material(name, image, leaves):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = image
    tex.interpolation = "Linear"
    nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    if leaves:
        nt.links.new(tex.outputs["Alpha"], bsdf.inputs["Alpha"])
    bsdf.inputs["Roughness"].default_value = 0.85 if leaves else 0.95
    bsdf.inputs["Metallic"].default_value = 0.0
    m.use_backface_culling = not leaves
    return m


# ---------------------------------------------------------------- GLB post-processing
def read_glb(path):
    raw = path.read_bytes()
    _, _, length = struct.unpack("<III", raw[:12])
    offset, chunks = 12, []
    while offset < length:
        clen, ctype = struct.unpack("<II", raw[offset:offset + 8])
        chunks.append([ctype, raw[offset + 8:offset + 8 + clen]])
        offset += 8 + clen
    return chunks


def write_glb(path, chunks):
    body = b""
    for ctype, data in chunks:
        pad = (4 - len(data) % 4) % 4
        data = data + (b" " if ctype == 0x4E4F534A else b"\0") * pad
        body += struct.pack("<II", len(data), ctype) + data
    path.write_bytes(struct.pack("<III", 0x46546C67, 2, 12 + len(body)) + body)


def set_alpha_modes(path):
    chunks = read_glb(path)
    doc = json.loads(chunks[0][1].decode("utf-8"))
    for m in doc.get("materials", []):
        if m.get("name") == "tree_leaves":
            m["alphaMode"], m["alphaCutoff"], m["doubleSided"] = "MASK", ALPHA_CUTOFF, True
        else:
            m.pop("alphaMode", None)
            m["doubleSided"] = False
    chunks[0][1] = json.dumps(doc, separators=(",", ":")).encode("utf-8")
    write_glb(path, chunks)
    return doc


# ---------------------------------------------------------------- preview
def preview(objects, path):
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x, scene.render.resolution_y = 1500, 620
    scene.render.film_transparent = False
    world = bpy.data.worlds.new("w")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.62, 0.72, 0.85, 1)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.9
    scene.world = world
    sun = bpy.data.lights.new("sun", "SUN")
    sun.energy = 3.0
    so = bpy.data.objects.new("sun", sun)
    so.rotation_euler = (math.radians(50), 0, math.radians(127))
    scene.collection.objects.link(so)
    ground = bpy.data.meshes.new("ground")
    gb = bmesh.new()
    bmesh.ops.create_grid(gb, x_segments=1, y_segments=1, size=40)
    gb.to_mesh(ground)
    gb.free()
    go = bpy.data.objects.new("ground", ground)
    gm = bpy.data.materials.new("ground")
    gm.use_nodes = True
    gm.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.25, 0.24, 0.22, 1)
    ground.materials.append(gm)
    scene.collection.objects.link(go)
    for i, o in enumerate(objects):
        o.location = ((i - 1) * 11.0, 0, 0)
    cam = bpy.data.cameras.new("cam")
    cam.lens = 30
    co = bpy.data.objects.new("cam", cam)
    co.location = (0, -30, 5.5)
    co.rotation_euler = (math.radians(86), 0, 0)
    scene.collection.objects.link(co)
    scene.camera = co
    scene.render.filepath = str(path)
    bpy.ops.render.render(write_still=True)
    for o in objects:
        o.location = (0, 0, 0)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--preview", action="store_true")
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    image = build_atlas(out / "tree-atlas.png")
    bark_m, leaf_m = material("tree_bark", image, False), material("tree_leaves", image, True)
    rng = random.Random(SEED)
    objects, stats = [], {}
    for name, P in MODELS.items():
        o = to_object(build_tree(name, P, rng), [bark_m, leaf_m])
        objects.append(o)
        xs = [v.co.x for v in o.data.vertices]
        ys = [v.co.y for v in o.data.vertices]
        zs = [v.co.z for v in o.data.vertices]
        stats[name] = {"refHeight": REF_HEIGHT, "refCrownDiameter": P["crown"], "clearTrunk": P["trunk_top"], "trunkRadiusBase": P["trunk_r"][0],
                       "triangles": sum(len(p.vertices) - 2 for p in o.data.polygons), "leafCards": P["cards"],
                       "boundsBlender": {"min": [round(min(xs), 3), round(min(ys), 3), round(min(zs), 3)], "max": [round(max(xs), 3), round(max(ys), 3), round(max(zs), 3)]}}
    if args.preview:
        preview(objects, out / "trees-preview.png")
    blend = out / f"{ASSET_ID}.blend"
    bpy.ops.wm.save_as_mainfile(filepath=str(blend))
    for o in objects:
        o.select_set(True)
    glb = out / f"{ASSET_ID}.glb"
    bpy.ops.export_scene.gltf(filepath=str(glb), export_format="GLB", use_selection=True, export_yup=True, export_apply=True,
                              export_normals=True, export_texcoords=True, export_vertex_color="ACTIVE", export_materials="EXPORT",
                              export_image_format="AUTO", export_animations=False, export_skins=False, export_extras=False,
                              export_cameras=False, export_lights=False, export_copyright="Original procedural asset")
    doc = set_alpha_modes(glb)
    raw = glb.read_bytes()
    tris = sum(doc["accessors"][p["indices"]]["count"] // 3 for m in doc["meshes"] for p in m["primitives"])
    entry = {
        "id": ASSET_ID, "status": "EXPORTED_NOT_VERIFIED_IN_RUNTIME", "source": "procedural (bmesh, numpy atlas), no external file",
        "glb": {"path": glb.name, "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()},
        "nodes": [n.get("name") for n in doc["nodes"]], "triangles": tris, "materials": [m.get("name") for m in doc.get("materials", [])],
        "alphaCutoff": ALPHA_CUTOFF, "atlas": ATLAS, "models": stats,
        "frame": "glTF +Y up, origin at the trunk base; instances scale Y by height / refHeight and X, Z by crown / refCrownDiameter",
    }
    report_path = out / "blender-report.json"
    report = json.loads(report_path.read_text(encoding="utf-8")) if report_path.exists() else {"schemaVersion": 1, "kind": "blender-report", "assets": {}}
    report.setdefault("assets", {})[ASSET_ID] = entry
    report["generated"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    report["blender"] = bpy.app.version_string
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"id": ASSET_ID, "bytes": len(raw), "triangles": tris, "nodes": entry["nodes"]}))


if __name__ == "__main__":
    main()
