"""Original player character (courier-v1) for the Helsinki game, generated in Blender 5.2.

Body: a Skin-modifier graph of the torso, arms and legs, subdivided and reshaped by region (torso depth,
glutes, calves, flat shoe soles). Head, hands, hair, face details and the delivery backpack are sculpted
separately and bound rigidly to their bones. Materials are assigned by body region. A 21-joint deform
skeleton binds the body with automatic weights (four influences at most).

Motion is procedural (character_motion.py): every clip is a pose function sampled at 60 fps and baked
into one action per clip. Legs use two-bone IK toward planned foot pivots, so stance feet are planted by
construction; locomotion is in place (the game's capsule owns displacement). The run also writes one QA
scene per checked clip, with the rig carried at the clip speed, for the skill's motion_qa.py.
See content/assets/character-courier.contract.json.

Run through the skill's Blender runner (tools/blender must be readable for the motion module):
  node .agents/skills/build-helsinki-game/scripts/run-blender.mjs --container ... --script tools/blender/build_character.py \
    --read tools/blender --read content/assets --write OUT_PARENT \
    -- --contract content/assets/character-courier.contract.json --out OUT_DIR [--renders]
"""
import argparse
import hashlib
import json
import math
import sys
from pathlib import Path

import bmesh
import bpy
from mathutils import Matrix, Vector

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
import character_motion as cm  # noqa: E402
from character_motion import BONES  # noqa: E402  (rest skeleton shared with the motion planner)

TAU = 2.0 * math.pi
# Material seams, cut as edge loops so region boundaries are straight: jacket hem, trouser hem, shoe sole,
# and the reflective band on each upper arm (fractions along the arm from the shoulder joint).
HEM_Z, CUFF_Z, SOLE_Z = 0.885, 0.128, 0.028
BAND = (0.5, 0.68)

def srgb_to_linear(c):
    return [x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c]


def smooth(t):
    t = min(1.0, max(0.0, t))
    return t * t * (3.0 - 2.0 * t)


def bump(t, a, b):
    """1 in the middle of [a, b], 0 outside, smooth in between."""
    if t <= a or t >= b:
        return 0.0
    return math.sin(math.pi * (t - a) / (b - a)) ** 2


# --- Body graph for the Skin modifier ----------------------------------------------------------------------

def body_graph():
    """Vertices (position, radius) and edges of the skin skeleton. Radii are round; shape comes later."""
    verts, edges = [], []

    def v(p, r):
        verts.append((Vector(p), r))
        return len(verts) - 1

    def chain(points, start=None):
        ids = [v(p, r) for p, r in points]
        if start is not None:
            edges.append((start, ids[0]))
        edges.extend(zip(ids, ids[1:]))
        return ids

    # Radii include clothing: a padded jacket on the torso and sleeves, loose jeans on the legs.
    torso = chain([
        ((0.0, 0.004, 0.865), 0.13), ((0.0, 0.0, 0.95), 0.178), ((0.0, 0.0, 1.06), 0.168),
        ((0.0, 0.0, 1.19), 0.184), ((0.0, -0.004, 1.31), 0.194), ((0.0, 0.004, 1.405), 0.165),
        ((0.0, 0.012, 1.47), 0.064), ((0.0, 0.016, 1.53), 0.058), ((0.0, 0.02, 1.60), 0.048),  # neck, capped inside the head
    ])
    crotch, shoulders = torso[0], torso[5]
    for sx in (1.0, -1.0):
        chain([
            ((0.175 * sx, 0.01, 1.418), 0.07), ((0.27 * sx, 0.01, 1.325), 0.063), ((0.382 * sx, 0.01, 1.218), 0.053),
            ((0.47 * sx, -0.01, 1.134), 0.05), ((0.54 * sx, -0.026, 1.067), 0.044),
        ], start=shoulders)
        leg = chain([
            ((0.094 * sx, 0.0, 0.84), 0.098), ((0.098 * sx, -0.006, 0.68), 0.088), ((0.10 * sx, -0.012, 0.50), 0.066),
            ((0.10 * sx, 0.0, 0.34), 0.064), ((0.10 * sx, 0.01, 0.15), 0.056), ((0.10 * sx, 0.012, 0.095), 0.046),
        ], start=crotch)
        ankle = leg[-1]
        chain([((0.10 * sx, -0.07, 0.05), 0.047), ((0.10 * sx, -0.185, 0.038), 0.039)], start=ankle)
        chain([((0.10 * sx, 0.06, 0.045), 0.04)], start=ankle)
    return verts, edges, torso[0]


def shape_body(co):
    """Region-wise reshaping of the round skin mesh (rest pose, Blender axes)."""
    x, y, z = co
    ax = abs(x)
    if ax < 0.21 and 0.80 < z < 1.48:  # torso: shallower front-to-back, glutes and chest
        depth = 0.72 + 0.08 * bump(z, 0.8, 1.0)
        y *= depth
        y += 0.02 * bump(z, 0.80, 1.00) * (1.0 if y > 0 else 0.0)
        y -= 0.01 * bump(z, 1.17, 1.40) * (1.0 if y < 0 else 0.0)
        flare = 1.0 + 0.07 * bump(z, 0.875, 0.935)  # jacket hem
        x *= flare * (1.0 + 0.05 * bump(z, 1.25, 1.46))  # broader shoulders
        y *= flare
    if ax < 0.22 and z < 0.84:  # legs
        y += 0.01 * bump(z, 0.18, 0.48) * (1.0 if y > 0.0 else 0.0)  # calf
        hem = 1.0 + 0.10 * bump(z, 0.075, 0.16)  # trouser hem over the shoe
        x = math.copysign(0.10 + (ax - 0.10) * hem, x)
        y = 0.004 + (y - 0.004) * hem
    if z < 0.11 and ax < 0.22:  # trainers: wider, low toe, flat sole
        x = math.copysign(0.10 + (ax - 0.10) * 1.08, x)
        if y < -0.06:
            z = z * (1.0 - 0.25 * smooth((-0.06 - y) / 0.1))
        z = max(z, 0.0)
        if z < 0.016:
            z = 0.0
    return Vector((x, y, z))


def cuff_bulge(co, sx):
    """Sleeve cuffs: push forearm vertices near the wrist away from the forearm axis."""
    a, b = Vector((0.382 * sx, 0.01, 1.218)), Vector((0.54 * sx, -0.026, 1.067))
    ab = b - a
    t = (co - a).dot(ab) / ab.length_squared
    if t < 0.75 or t > 1.25:
        return co
    axis_point = a + ab * t
    radial = co - axis_point
    return axis_point + radial * (1.0 + 0.12 * bump(t, 0.78, 1.06))


def build_body(collection):
    verts, edges, root = body_graph()
    mesh = bpy.data.meshes.new("BODY_GRAPH")
    mesh.from_pydata([p for p, _ in verts], edges, [])
    obj = bpy.data.objects.new("BODY", mesh)
    collection.objects.link(obj)
    skin = obj.modifiers.new("skin", "SKIN")
    skin.branch_smoothing = 0.5
    for i, (_, r) in enumerate(verts):
        mesh.skin_vertices[0].data[i].radius = (r, r)
    mesh.skin_vertices[0].data[root].use_root = True
    sub = obj.modifiers.new("subsurf", "SUBSURF")
    sub.levels = 2
    dg = bpy.context.evaluated_depsgraph_get()
    baked = bpy.data.meshes.new_from_object(obj.evaluated_get(dg))
    obj.modifiers.clear()
    obj.data = baked
    bpy.data.meshes.remove(mesh)
    for vert in baked.vertices:
        co = shape_body(vert.co)
        if co.z > 0.95 and abs(co.x) > 0.3:
            co = cuff_bulge(co, 1.0 if co.x > 0 else -1.0)
        vert.co = co
    cut_seams(baked)
    baked.name = "BODY"
    return obj


def cut_seams(mesh):
    """Cut edge loops where the material changes, so seams are straight rather than face stair-steps."""
    bm = bmesh.new()
    bm.from_mesh(mesh)

    def cut(co, no, keep):
        faces = [f for f in bm.faces if all(keep(v.co) for v in f.verts)]
        # Ordered de-duplication: a set would order elements by memory address, and the bisect's output
        # (face order, so the exported index buffers) would differ from build to build.
        edges = list(dict.fromkeys(e for f in faces for e in f.edges))
        verts = list(dict.fromkeys(v for f in faces for v in f.verts))
        bmesh.ops.bisect_plane(bm, geom=verts + edges + faces, dist=1e-6, plane_co=co, plane_no=no)

    for z in (HEM_Z, CUFF_Z, SOLE_Z):
        cut(Vector((0.0, 0.0, z)), Vector((0.0, 0.0, 1.0)), lambda c: abs(c.x) < 0.3 and c.z < 1.0)
    for sx in (1.0, -1.0):
        a, b = Vector((0.17 * sx, 0.01, 1.43)), Vector((0.382 * sx, 0.01, 1.218))
        for t in BAND:
            cut(a + (b - a) * t, (b - a).normalized(), lambda c, sx=sx: c.x * sx > 0.2 and c.z > 1.0)
    bm.to_mesh(mesh)
    bm.free()


# --- Sculpted parts ----------------------------------------------------------------------------------------

def sphere_bm(segments=32, rings=18):
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=segments, v_segments=rings, radius=1.0)
    return bm


def bm_to_object(bm, name, collection, material_index=0):
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    for p in mesh.polygons:
        p.material_index = material_index
        p.use_smooth = True
    obj = bpy.data.objects.new(name, mesh)
    collection.objects.link(obj)
    return obj


HEAD_CENTRE = Vector((0.0, -0.004, 1.668))


def head_shape(u):
    """Unit-sphere point -> head surface (jaw taper, chin, flat face, nose, cranium)."""
    x, y, z = u
    rx, ry, rz = 0.077, 0.096, 0.112
    p = Vector((x * rx, y * ry, z * rz))
    low = smooth((-z - 0.05) / 0.85)  # 0 above the cheekbones, 1 at the chin
    p.x *= 1.0 - 0.2 * low
    p.y *= 1.0 - 0.22 * low * (1.0 if y > 0 else 0.4)
    if y < 0:  # face: flatter, chin forward
        p.y *= 0.93
        p.y -= 0.006 * low * smooth((0.6 - abs(x)) / 0.6)
    else:  # cranium a little fuller at the back
        p.y *= 1.0 + 0.06 * smooth(z + 0.2)
    # Brow ridge (the nose is a separate part).
    if y < -0.5:
        p.y -= 0.004 * bump(z, 0.12, 0.4) * smooth((0.75 - abs(x)) / 0.4)
    return HEAD_CENTRE + p


def build_head(collection):
    bm = sphere_bm(36, 22)
    for vert in bm.verts:
        vert.co = head_shape(vert.co.normalized())
    return bm_to_object(bm, "HEAD", collection)


def hairline(u):
    """Lowest normalised head height the hair reaches at direction u (short cut with sideburns and nape)."""
    side = smooth((abs(u.x) - 0.4) / 0.5)          # 0 on the face/back centre, 1 on the sides
    front = smooth((-u.y - 0.3) / 0.4)             # 1 on the forehead
    back = smooth((u.y - 0.1) / 0.5)               # 1 behind the ears
    ear = side * (1.0 - front) * (1.0 - back) * smooth((0.3 - abs(u.y + 0.05)) / 0.3)
    limit = 0.40 * front * (1.0 - side) + (-0.18) * side * front + (-0.52) * back
    limit += (1.0 - front) * (1.0 - back) * (0.05 + 0.25 * ear)
    return limit


def build_hair(collection):
    """Hair shell over the scalp. Below the hairline the shell sinks under the skin, so the visible edge is
    where the two surfaces cross. Coverage is diffused over neighbouring vertices first: where the hairline
    turns steeply (sideburns) a per-vertex ramp would jump within one face and the edge would follow faces."""
    bm = sphere_bm(48, 30)
    shape, cover = {}, {}
    for vert in bm.verts:
        u = vert.co.normalized()
        top = smooth((u.z + 0.1) / 0.9)
        fringe = smooth((-u.y - 0.3) / 0.5) * smooth((u.z - 0.2) / 0.5)
        lift = 0.005 + 0.019 * top + 0.007 * fringe + 0.003 * math.sin(7.0 * u.x + 3.0 * u.y) * top
        shape[vert] = (u, head_shape(u), lift)
        cover[vert] = smooth((u.z - hairline(u)) / 0.12 + 0.5)
    for _ in range(5):
        cover = {v: 0.5 * k + 0.5 * sum(cover[e.other_vert(v)] for e in v.link_edges) / len(v.link_edges)
                 for v, k in cover.items()}
    for vert, (u, surface, lift) in shape.items():
        k = cover[vert]
        vert.co = surface + u * (lift * k - 0.004 * (1.0 - k))
    dead = [f for f in bm.faces if all(cover[v] < 0.02 for v in f.verts)]
    bmesh.ops.delete(bm, geom=dead, context="FACES")
    return bm_to_object(bm, "HAIR", collection)


def ellipsoid(name, collection, centre, radii, segments=16, rings=10, rotation=None):
    bm = sphere_bm(segments, rings)
    for vert in bm.verts:
        p = Vector((vert.co.x * radii[0], vert.co.y * radii[1], vert.co.z * radii[2]))
        if rotation is not None:
            p = rotation @ p
        vert.co = Vector(centre) + p
    return bm_to_object(bm, name, collection)


def build_hand(side, collection):
    """Relaxed fist along the hand bone: palm toward the body when the arm hangs (rest: down and inward)."""
    head, tail = Vector(BONES[f"hand.{side}"][0]), Vector(BONES[f"hand.{side}"][1])
    axis = (tail - head).normalized()
    sx = 1.0 if side == "L" else -1.0
    palm_normal = Vector((-sx * 0.707, 0.0, -0.707))  # medial-down in the A-pose
    width = axis.cross(palm_normal).normalized()
    basis = Matrix((width, axis, palm_normal)).transposed()  # columns: width, length, thickness
    bm = sphere_bm(18, 12)

    def boxy(a):  # rounder than a box, flatter than a sphere
        return math.copysign(abs(a) ** 0.6, a)

    for vert in bm.verts:
        u = vert.co
        t = (u.y + 1.0) / 2.0  # 0 at the wrist, 1 at the knuckles
        w = 0.041 * (1.0 - 0.12 * t)
        th = 0.022 + 0.008 * math.sin(math.pi * min(1.0, t * 1.2))  # curled fingers bulge toward the palm
        p = Vector((boxy(u.x) * w, 0.002 + t * 0.108, boxy(u.z) * th + 0.004 * t))
        vert.co = head + basis @ p
    hand = bm_to_object(bm, f"HAND.{side}", collection)
    thumb = ellipsoid(f"THUMB.{side}", collection, head + basis @ Vector((-sx * 0.034, 0.05, 0.016)),
                      (0.012, 0.03, 0.012), segments=10, rings=8, rotation=basis @ Matrix.Rotation(0.35 * sx, 3, "Z"))
    return [hand, thumb]


def build_backpack(collection):
    """Insulated delivery backpack on the upper back (straps are added once the body exists)."""
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=(0.36, 0.20, 0.42), verts=bm.verts)
    bmesh.ops.bevel(bm, geom=list(bm.edges), offset=0.035, segments=3, affect="EDGES", profile=0.5)
    bmesh.ops.rotate(bm, cent=(0.0, 0.0, 0.0), matrix=Matrix.Rotation(math.radians(-4.0), 3, "X"), verts=bm.verts)
    bmesh.ops.translate(bm, vec=(0.0, 0.236, 1.19), verts=bm.verts)
    pack = bm_to_object(bm, "BACKPACK", collection)
    for p in pack.data.polygons:
        p.use_smooth = False
    return pack


def build_straps(body, collection):
    """Shoulder straps: ribbons laid on the body surface by ray casting around each shoulder."""
    bpy.context.view_layer.update()
    inv = body.matrix_world.inverted()
    straps = []
    for sx in (1.0, -1.0):
        centre = Vector((0.105 * sx, 0.0, 1.30))
        points = []
        for k in range(15):
            theta = math.radians(-35.0 + k * (245.0 / 14))  # from behind (into the pack) over the top to the front
            r = Vector((0.0, math.cos(theta), math.sin(theta)))
            origin = centre + r * 0.6
            hit, loc, normal, _ = body.ray_cast(inv @ origin, -r)
            if hit:
                points.append((Vector(loc), Vector(normal)))
        bm = bmesh.new()
        rows = []
        for loc, normal in points:
            side = Vector((1.0, 0.0, 0.0))
            side = (side - normal * side.dot(normal)).normalized()
            base = loc + normal * 0.004
            rows.append([bm.verts.new(base + side * w + normal * t) for w in (-0.019, 0.019) for t in (0.0, 0.007)])
        for a, b in zip(rows, rows[1:]):
            bm.faces.new((a[1], a[3], b[3], b[1]))  # outer face
            bm.faces.new((a[0], b[0], b[2], a[2]))  # inner face
            bm.faces.new((a[0], a[1], b[1], b[0]))  # edge
            bm.faces.new((a[2], b[2], b[3], a[3]))  # edge
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        straps.append(bm_to_object(bm, f"STRAP.{'L' if sx > 0 else 'R'}", collection))
    return straps


def build_collar(collection):
    """Low stand-up jacket collar, open at the front where the zip ends."""
    bm = bmesh.new()
    rings, seg = 4, 24
    vid = []
    for i in range(rings):
        t = i / (rings - 1)
        r = 0.082 - 0.01 * t
        z = 1.452 + 0.046 * t
        row = []
        for k in range(seg):
            a = TAU * k / seg
            row.append(bm.verts.new((r * math.cos(a), 0.008 + r * 0.98 * math.sin(a), z)))
        vid.append(row)
    for i in range(rings - 1):
        for k in range(seg):
            if k in (seg * 17 // 24, seg * 18 // 24):  # the two segments either side of straight ahead (-Y)
                continue
            bm.faces.new((vid[i][k], vid[i][(k + 1) % seg], vid[i + 1][(k + 1) % seg], vid[i + 1][k]))
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
    bmesh.ops.solidify(bm, geom=list(bm.faces), thickness=0.008)
    return bm_to_object(bm, "COLLAR", collection)


# --- Materials ---------------------------------------------------------------------------------------------

MATERIAL_SETTINGS = {  # name: (palette key, roughness, metallic)
    "skin": ("skin", 0.55, 0.0), "hair": ("hair", 0.7, 0.0), "eye": ("eye", 0.15, 0.0),
    "jacket": ("jacket", 0.78, 0.0), "accent": ("accent", 0.35, 0.0), "trousers": ("trousers", 0.86, 0.0),
    "shoes": ("shoes", 0.6, 0.0), "sole": ("sole", 0.8, 0.0), "backpack": ("backpack", 0.62, 0.0),
}


def make_materials(palette):
    mats = {}
    for name, (key, rough, metal) in MATERIAL_SETTINGS.items():
        m = bpy.data.materials.new(f"char_{name}")
        bsdf = m.node_tree.nodes.get("Principled BSDF")
        bsdf.inputs["Base Color"].default_value = (*srgb_to_linear(palette[key]), 1.0)
        bsdf.inputs["Roughness"].default_value = rough
        bsdf.inputs["Metallic"].default_value = metal
        mats[name] = m
    return mats


def body_region(c):
    """Material for a body face from its rest-pose centre."""
    x, y, z = c
    ax = abs(x)
    on_arm = z > 1.0 and ax > 0.2 or (z > 1.3 and ax > 0.16)
    if on_arm:
        # Distance along the upper arm from the shoulder joint: a reflective band at its middle.
        sx = 1.0 if x > 0 else -1.0
        s = Vector((0.17 * sx, 0.01, 1.43))
        e = Vector((0.382 * sx, 0.01, 1.218))
        t = (Vector(c) - s).dot(e - s) / (e - s).length_squared
        return "accent" if BAND[0] < t < BAND[1] else "jacket"  # the arm ends in the cuff; hands are separate
    if z > 1.47 and math.hypot(x, y - 0.015) < 0.075:  # the neck tube above the collar line, not the shoulder tops
        return "skin"
    if z >= HEM_Z:
        return "accent" if ax < 0.0075 and y < 0 and z < 1.44 else "jacket"  # zip
    if z > CUFF_Z:
        return "trousers"
    return "sole" if z < SOLE_Z else "shoes"


# --- Rig and binding --------------------------------------------------------------------------------------

def build_rig(collection):
    data = bpy.data.armatures.new("CHARACTER")
    rig = bpy.data.objects.new("CHARACTER", data)
    collection.objects.link(rig)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode="EDIT")
    for name, (head, tail, parent, connected) in BONES.items():
        eb = data.edit_bones.new(name)
        eb.head, eb.tail = Vector(head), Vector(tail)
        eb.roll = 0.0
        if parent:
            eb.parent = data.edit_bones[parent]
            eb.use_connect = connected
        eb.use_deform = True
    bpy.ops.object.mode_set(mode="OBJECT")
    for pb in rig.pose.bones:
        pb.rotation_mode = "QUATERNION"
    return rig


def bind(rig, body, rigid_parts):
    """Automatic weights for the body; rigid parts get weight 1 on one bone; at most 4 influences."""
    bpy.ops.object.select_all(action="DESELECT")
    body.select_set(True)
    rig.select_set(True)
    bpy.context.view_layer.objects.active = rig
    result = bpy.ops.object.parent_set(type="ARMATURE_AUTO")
    if "FINISHED" not in result:
        raise RuntimeError(f"automatic weights failed: {result}")
    for obj, bone in rigid_parts:
        group = obj.vertex_groups.new(name=bone)
        group.add(list(range(len(obj.data.vertices))), 1.0, "REPLACE")
    # Join everything into one skinned mesh.
    bpy.ops.object.select_all(action="DESELECT")
    for obj, _ in rigid_parts:
        obj.select_set(True)
    body.select_set(True)
    bpy.context.view_layer.objects.active = body
    bpy.ops.object.join()
    mesh = body.data
    groups = {g.index: g.name for g in body.vertex_groups}
    unweighted = 0
    for v in mesh.vertices:
        ws = sorted(((g.weight, g.group) for g in v.groups if g.weight > 1e-4), reverse=True)
        if not ws:
            unweighted += 1
            continue
        keep = ws[:4]
        total = sum(w for w, _ in keep)
        for g in list(v.groups):
            body.vertex_groups[g.group].remove([v.index])
        for w, gi in keep:
            body.vertex_groups[gi].add([v.index], w / total, "REPLACE")
    if unweighted:
        raise RuntimeError(f"{unweighted} vertices have no weights")
    body.parent = rig
    mod = next((m for m in body.modifiers if m.type == "ARMATURE"), None) or body.modifiers.new("armature", "ARMATURE")
    mod.object = rig
    return {"groups": sorted(groups.values()), "vertices": len(mesh.vertices)}


def canonical_faces(mesh):
    """Rebuild the faces in a fixed order, each starting at its lowest vertex index. Some bmesh operators emit
    faces in an order that changes from run to run (vertex order does not); without this the exported index
    buffers, and with them the GLB hash and the release ID, would differ between identical builds."""
    bm = bmesh.new()
    bm.from_mesh(mesh)
    layers = list(bm.faces.layers.int.values())
    specs = []
    for f in bm.faces:
        idx = [v.index for v in f.verts]
        k = idx.index(min(idx))
        specs.append((idx[k:] + idx[:k], f.material_index, f.smooth, [f[layer] for layer in layers]))
    specs.sort(key=lambda s: s[0])
    bm.verts.ensure_lookup_table()
    for f in list(bm.faces):
        bm.faces.remove(f)
    for order, material, smooth, values in specs:
        f = bm.faces.new([bm.verts[i] for i in order])
        f.material_index, f.smooth = material, smooth
        for layer, value in zip(layers, values):
            f[layer] = value
    bm.to_mesh(mesh)
    bm.free()


def assign_materials(body, materials, part_material):
    """Body faces by region; rigid parts by their own material name (stored as a face attribute index)."""
    names = list(MATERIAL_SETTINGS)
    for name in names:
        body.data.materials.append(materials[name])
    for poly in body.data.polygons:
        tag = part_material.get(poly.index)
        poly.material_index = names.index(tag if tag else body_region(poly.center))
        poly.use_smooth = True


# --- Main --------------------------------------------------------------------------------------------------

def triangles(obj):
    return sum(len(p.vertices) - 2 for p in obj.data.polygons)


def build_character(contract, collection):
    materials = make_materials(contract["palette"])
    body = build_body(collection)
    body_faces = len(body.data.polygons)
    parts = []  # (object, bone, material)
    parts.append((build_head(collection), "head", "skin"))
    parts.append((build_hair(collection), "head", "hair"))
    parts.append((ellipsoid("NOSE", collection, (0.0, -0.089, 1.653), (0.0105, 0.0125, 0.018), 12, 10,
                            rotation=Matrix.Rotation(-0.35, 3, "X")), "head", "skin"))
    for sx in (1.0, -1.0):
        parts.append((ellipsoid("SCLERA", collection, (0.03 * sx, -0.080, 1.681), (0.0125, 0.007, 0.0085), 12, 8), "head", "accent"))
        parts.append((ellipsoid("IRIS", collection, (0.03 * sx, -0.0862, 1.6805), (0.0062, 0.003, 0.0064), 10, 6), "head", "eye"))
        parts.append((ellipsoid("BROW", collection, (0.031 * sx, -0.086, 1.702), (0.016, 0.006, 0.004), 10, 6,
                                rotation=Matrix.Rotation(-0.12 * sx, 3, "Y")), "head", "hair"))
        parts.append((ellipsoid("EAR", collection, (0.079 * sx, 0.004, 1.665), (0.011, 0.022, 0.029), 10, 8), "head", "skin"))
    for side in ("L", "R"):
        for obj in build_hand(side, collection):
            parts.append((obj, f"hand.{side}", "skin"))
    parts.append((build_collar(collection), "chest", "jacket"))
    parts.append((build_backpack(collection), "chest", "backpack"))
    for strap in build_straps(body, collection):
        parts.append((strap, "chest", "sole"))
    rig = build_rig(collection)
    # Face index ranges of each part after joining (join appends in selection order: keep a stable order by
    # tagging faces with a temporary attribute before the join).
    for obj, _, mat in parts:
        attr = obj.data.attributes.new("part_material", "INT", "FACE")
        idx = list(MATERIAL_SETTINGS).index(mat) + 1
        for i in range(len(obj.data.polygons)):
            attr.data[i].value = idx
    attr = body.data.attributes.new("part_material", "INT", "FACE")
    for i in range(body_faces):
        attr.data[i].value = 0
    info = bind(rig, body, [(o, b) for o, b, _ in parts])
    canonical_faces(body.data)
    names = list(MATERIAL_SETTINGS)
    tags = body.data.attributes["part_material"]
    part_material = {i: names[d.value - 1] for i, d in enumerate(tags.data) if d.value > 0}
    body.data.attributes.remove(tags)
    assign_materials(body, materials, part_material)
    body.name = "CHARACTER_MESH"
    return rig, body, info


# --- Motion -------------------------------------------------------------------------------------------------

def check_contract_clips(contract, clips, gaits):
    """The contract declares the clips; the planner must produce exactly those."""
    declared = {c["name"]: c for c in contract["clips"]}
    if set(declared) != set(clips):
        raise SystemExit(f"contract clips {sorted(declared)} != planner clips {sorted(clips)}")
    for name, (frames, loop, _, _) in clips.items():
        c = declared[name]
        if c["frames"] != [0, frames] or c["loop"] != loop:
            raise SystemExit(f"clip {name}: contract frames/loop {c['frames']}/{c['loop']} != planner [0, {frames}]/{loop}")
        if name in gaits:
            g = gaits[name]
            planned = {f"foot.{side}": g.contact_intervals(side) for side in ("L", "R")}
            if (c["movementSpeed"], c["dutyFactor"], c["contacts"]) != (g.v, g.beta, planned):
                raise SystemExit(f"clip {name}: contract speed/duty/contacts differ from the planner: {g.v} {g.beta} {planned}")


def set_action(rig, action):
    """Assign an action (or None). Blender 5.0-5.2 can crash (#164426) if an armature's action changes before
    its pose was evaluated, so evaluate the view layer first."""
    bpy.context.view_layer.update()
    ad = rig.animation_data or rig.animation_data_create()
    ad.action = action
    if action is not None:
        ad.action_slot = action.slots[0]


def linear_keys(action):
    for layer in action.layers:
        for strip in layer.strips:
            for bag in strip.channelbags:
                for fc in bag.fcurves:
                    for key in fc.keyframe_points:
                        key.interpolation = "LINEAR"
                    fc.update()


def bases(rig, Q, H):
    """Blender pose-bone bases from a planner pose (world delta rotations and posed heads)."""
    posed, out = {}, {}
    for bone in rig.data.bones:  # creation order: parents first
        m = (Matrix(Q[bone.name].tolist()) @ bone.matrix_local.to_3x3()).to_4x4()
        m.translation = Vector(H[bone.name].tolist())
        posed[bone.name] = m
        if bone.parent is None:
            out[bone.name] = bone.matrix_local.inverted() @ m
        else:
            rel = bone.parent.matrix_local.inverted() @ bone.matrix_local
            out[bone.name] = rel.inverted() @ posed[bone.parent.name].inverted() @ m
    return out


def bake_clips(rig, contract):
    clips, gaits = cm.clip_specs()
    check_contract_clips(contract, clips, gaits)
    actions, summary = {}, {}
    for name in clips:
        frames, loop, _, mirrored = clips[name]
        poses, diags = cm.bake(name, clips)
        action = bpy.data.actions.new(name)
        action.slots.new(id_type="OBJECT", name=rig.name)
        set_action(rig, action)
        previous, drift = {}, 0.0
        for f, (Q, H) in enumerate(poses):
            for bone_name, basis in bases(rig, Q, H).items():
                pb = rig.pose.bones[bone_name]
                q = basis.to_quaternion()
                if bone_name in previous and previous[bone_name].dot(q) < 0:
                    q.negate()
                previous[bone_name] = q
                pb.rotation_quaternion = q
                pb.keyframe_insert("rotation_quaternion", frame=f, group=bone_name)
                if pb.parent is None:
                    pb.location = basis.translation
                    pb.keyframe_insert("location", frame=f, group=bone_name)
                else:
                    drift = max(drift, basis.translation.length)  # FK heads must follow their parents
        if drift > 1e-4:
            raise RuntimeError(f"{name}: child bone heads drift {drift:.6f} m from their parents")
        linear_keys(action)
        action.use_fake_user = True
        action.use_frame_range = True
        action.frame_start, action.frame_end = 0, frames
        actions[name] = action
        reach = [max(d["legReach"].values()) for d in diags]
        arms = [max(d["armReach"].values()) for d in diags if d["armReach"]]
        summary[name] = {"frames": [0, frames], "seconds": round(frames / cm.FPS, 4), "loop": loop, "mirrored": mirrored,
                         "maxLegReach": round(max(reach), 4), "maxArmReach": round(max(arms), 4) if arms else None}
        if name in gaits:
            g = gaits[name]
            summary[name].update({"speed": g.v, "stride": round(g.v * g.cycle, 4), "strikeY": round(g.strike_y, 4),
                                  "hipsHeight": [round(float(g.height.min()), 4), round(float(g.height.max()), 4)]})
    set_action(rig, None)
    rest_pose(rig)  # export the rest pose as the default node pose
    return actions, summary, clips, gaits


def rest_pose(rig):
    for pb in rig.pose.bones:
        pb.rotation_quaternion = (1.0, 0.0, 0.0, 0.0)
        pb.location = (0.0, 0.0, 0.0)


def local_point(rig, bone, rest_point):
    return list(rig.data.bones[bone].matrix_local.inverted() @ Vector(tuple(rest_point)))


def runs(flags):
    """Inclusive [start, end] runs of consecutive True frames, at least two frames long."""
    out, start = [], None
    for f, flag in enumerate(flags + [False]):
        if flag and start is None:
            start = f
        elif not flag and start is not None:
            if f - 1 > start:
                out.append([start, f - 1])
            start = None
    return out


def qa_spec(name, rig, clips, gaits):
    """Measured checks for one clip: planted heel/toe pivots, sole above the floor, no torso pops."""
    frames = clips[name][0]
    spec = {"frames": [0, frames], "contacts": [],
            "pops": [{"rig": rig.name, "bones": ["hips", "spine", "chest", "neck", "head"], "max_deg_per_frame": 8.0}]}
    if name in gaits:
        g = gaits[name]
        for side in ("L", "R"):
            thetas = [g.foot(side, (f % frames) / frames)[3] for f in range(frames + 1)]
            heel = [t is not None and t <= 1e-9 for t in thetas]
            tip = [t is not None and t >= -1e-9 for t in thetas]
            for label, flags, bone, pt in (("heel", heel, f"foot.{side}", cm.HEEL0[side]),
                                           ("toe tip", tip, f"toe.{side}", cm.TAIL0[f"toe.{side}"])):
                intervals = runs(flags)
                if intervals:
                    spec["contacts"].append({"label": f"{label} {side}", "rig": rig.name, "bone": bone,
                                             "point": local_point(rig, bone, pt), "intervals": intervals,
                                             "axes": "xyz", "tolerance": 0.004})
    elif name in ("idle", "land"):
        for side in ("L", "R"):
            for label, bone, pt in (("heel", f"foot.{side}", cm.HEEL0[side]), ("toe tip", f"toe.{side}", cm.TAIL0[f"toe.{side}"])):
                spec["contacts"].append({"label": f"{label} {side}", "rig": rig.name, "bone": bone,
                                         "point": local_point(rig, bone, pt), "intervals": [[0, frames]],
                                         "axes": "xyz", "tolerance": 0.004})
    if name in gaits or name in ("idle", "land"):
        spec["floor"] = {"z": 0.0, "objects": ["CHARACTER_MESH"], "tolerance": 0.012}
    if name == "land":
        spec["pops"][0]["max_deg_per_frame"] = 10.0
    return spec


def write_qa_scenes(scene, rig, actions, clips, gaits, out_dir):
    """One saved scene per checked clip: the rig rides an empty that moves at the clip speed, so planted feet
    must stay still in the world."""
    out_dir.mkdir()
    written = []
    for name in ("idle", "walk", "run", "sprint", "land", "drive", "enter_car_left"):
        frames = clips[name][0]
        mover = bpy.data.objects.new("MOVER", None)
        scene.collection.objects.link(mover)
        speed = gaits[name].v if name in gaits else 0.0
        move = bpy.data.actions.new(f"qa_move_{name}")
        move.slots.new(id_type="OBJECT", name=mover.name)
        mover.animation_data_create()
        mover.animation_data.action = move
        mover.animation_data.action_slot = move.slots[0]
        for f, y in ((0, 0.0), (frames, -speed * frames / cm.FPS)):
            mover.location = (0.0, y, 0.0)
            mover.keyframe_insert("location", frame=f)
        linear_keys(move)
        rig.parent = mover
        set_action(rig, actions[name])
        scene.frame_start, scene.frame_end = 0, frames
        blend = out_dir / f"qa-{name}.blend"
        bpy.ops.wm.save_as_mainfile(filepath=str(blend), copy=True, compress=True)
        (out_dir / f"qa-{name}.json").write_text(json.dumps(qa_spec(name, rig, clips, gaits), indent=1) + "\n", encoding="utf-8")
        rig.parent = None
        set_action(rig, None)
        bpy.data.objects.remove(mover)
        bpy.data.actions.remove(move)
        written.append(blend.name)
    return written


# --- Review renders -------------------------------------------------------------------------------------------

def render_views(scene, out_dir, prefix, target_z=0.95, views=None, dist=4.2):
    cam = bpy.data.objects.get("REVIEW")
    if cam is None:
        cam_data = bpy.data.cameras.new("REVIEW")
        cam_data.lens = 70
        cam = bpy.data.objects.new("REVIEW", cam_data)
        scene.collection.objects.link(cam)
    scene.camera = cam
    if "KEY" not in bpy.data.objects:
        key = bpy.data.objects.new("KEY", bpy.data.lights.new("KEY", "SUN"))
        key.data.energy = 3.5
        key.rotation_euler = (math.radians(50), 0, math.radians(-35))
        scene.collection.objects.link(key)
        world = bpy.data.worlds.new("W")
        world.color = (0.35, 0.38, 0.42)
        scene.world = world
        floor = bpy.data.meshes.new("FLOOR")
        floor.from_pydata([(-3, -3, 0), (3, -3, 0), (3, 3, 0), (-3, 3, 0)], [], [(0, 1, 2, 3)])
        fobj = bpy.data.objects.new("FLOOR", floor)
        scene.collection.objects.link(fobj)
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 24
    scene.render.resolution_x, scene.render.resolution_y = 420, 620
    files = []
    for name, angle in views or (("front", 0.0), ("three-quarter", 40.0), ("side", 90.0), ("back", 180.0)):
        a = math.radians(angle)
        cam.location = (dist * math.sin(a), -dist * math.cos(a), target_z + 0.15)
        cam.rotation_euler = (math.radians(88), 0.0, a)
        path = out_dir / f"{prefix}-{name}.png"
        scene.render.filepath = str(path)
        bpy.ops.render.render(write_still=True)
        files.append(path.name)
    return files


POSE_SHOTS = [  # clip, frame, camera angle (degrees around the character, 0 = front, 90 = its left side)
    ("idle", 0, 40.0), ("walk", 0, 90.0), ("walk", 16, 90.0), ("run", 6, 90.0), ("run", 22, 40.0), ("sprint", 4, 90.0),
    ("jump", 12, 90.0), ("fall", 15, 40.0), ("land", 5, 90.0), ("drive", 0, 60.0), ("steer_left", 0, 20.0),
    ("enter_car_left", 14, 20.0), ("enter_car_left", 24, 60.0),
]


def render_poses(scene, rig, actions, out_dir):
    files = []
    for clip, frame, angle in POSE_SHOTS:
        set_action(rig, actions[clip])
        scene.frame_set(frame)
        z = 0.75 if clip.startswith(("drive", "steer", "enter")) else 0.95
        files += render_views(scene, out_dir, f"pose-{clip}-{frame}", target_z=z, views=(("view", angle),))
    set_action(rig, None)
    rest_pose(rig)
    return files


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--contract", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--stem", default="character-courier")
    parser.add_argument("--renders", action="store_true", help="also render review stills (Cycles, CPU)")
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
    contract = json.loads(args.contract.read_text(encoding="utf-8"))
    args.out.mkdir(parents=True, exist_ok=False)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.fps = contract["fps"]
    visual = bpy.data.collections.new("VISUAL")
    scene.collection.children.link(visual)
    rig, body, info = build_character(contract, visual)
    actions, clip_summary, clips, gaits = bake_clips(rig, contract)

    report = {"status": "EXPORTED_NOT_VERIFIED_IN_RUNTIME", "blender": bpy.app.version_string, "assetId": contract["assetId"],
              "triangles": triangles(body), "vertices": len(body.data.vertices), "materials": len(body.data.materials),
              "deformJoints": len([b for b in rig.data.bones if b.use_deform]), "binding": info, "clips": clip_summary}
    if args.renders:
        report["renders"] = (render_views(scene, args.out, "rest")
                             + render_views(scene, args.out, "head", target_z=1.5, dist=1.1,
                                            views=(("front", 0.0), ("three-quarter", 35.0), ("side", 90.0)))
                             + render_poses(scene, rig, actions, args.out))
        scene.frame_set(0)
    report["qaScenes"] = write_qa_scenes(scene, rig, actions, clips, gaits, args.out / "qa")

    bpy.ops.object.select_all(action="DESELECT")
    rig.select_set(True)
    body.select_set(True)
    glb = args.out / f"{args.stem}.glb"
    bpy.ops.export_scene.gltf(filepath=str(glb), export_format="GLB", use_selection=True, export_yup=True,
                              export_apply=False, export_normals=True, export_texcoords=False, export_tangents=False,
                              export_vertex_color="NONE", export_materials="EXPORT", export_extras=False,
                              export_cameras=False, export_lights=False, export_skins=True, export_def_bones=True,
                              export_animations=True, export_animation_mode="ACTIONS", export_force_sampling=True,
                              export_frame_step=1, export_optimize_animation_size=False,
                              export_copyright="Original procedural asset")
    bpy.ops.wm.save_as_mainfile(filepath=str(args.out / f"{args.stem}.blend"), compress=True)
    data = glb.read_bytes()
    report["output"] = {"path": glb.name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
    (args.out / "blender-report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({k: report[k] for k in ("triangles", "vertices", "materials", "deformJoints")} | {"bytes": len(data)}))


if __name__ == "__main__":
    main()
