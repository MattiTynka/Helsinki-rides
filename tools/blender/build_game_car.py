"""Headless Blender job: the user's rigged muscle car (.blend) -> two game-ready GLBs per
content/assets/vehicle-lumi-gt.contract.json: vehicle-lumi-gt.glb (deep red) and vehicle-patrol.glb
(white with a mid-blue door band, bonnet stripes and a roof light bar), plus blender-report.json.

The source is opened read-only, both armatures are put in rest position, every mesh is read into numpy
in world space (the rig's residual yaw removed) and the scene is then discarded: nothing of the Pro-Rig
(armatures, drivers, constraints, widgets, lights) survives. Each source mesh is split into connected
parts; parts are deleted by rule (badges, logos, lettering, the number plate, decals, the hidden engine
bay, under-floor and wheel-well mechanicals that the procedural wheels replace, duplicate lamp shells,
sub-3.5 cm debris) and the rest is assigned to a contract node and one of a few flat materials.
Every (node, material) group is decimated to a triangle budget, the groups are joined into the node
meshes and the wheels are re-topologised as simple tyre + alloy + rotor shells at the measured hubs.

Authoring frame: Blender -Y forward, +Z up, +X left (the source already faces -Y with the steering
wheel on +X); ``export_yup`` maps it to the contract's +Z forward, +Y up, +X left. CAR_ROOT sits on
the ground midway between the axles; everything is scaled by SCALE so the contract's dimensions hold.

Usage (through the skill runner, see docs/asset-pipeline.md):
  --python tools/blender/build_game_car.py -- --source <file.blend> --contract <contract.json> --out <dir>
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
sys.path.insert(0, str(Path(__file__).resolve().parent))
import release_pin  # noqa: E402

release_pin.require()

# --- source layout (measured with tools/blender/inspect_car.py) ---------------------------------------
RIG = "Car Rig"                       # Rigacar-style car rig: DEF-Body + four DEF-Wheel bones, 13 drivers
CONTROLS = "extra controls"           # second armature: door, hood, steering and light control bones
SRC = {"body": "muDEF-Body", "bonnet": "bonnet_ok", "door_l": "door_lf_ok", "door_r": "door_rf_ok",
       "steering": "stering wheel"}
SRC_WHEELS = {"WHEEL_FL": "muDEF- Wheel.Ft.L", "WHEEL_FR": "muDEF- Wheel.Ft.R",
              "WHEEL_RL": "muDEF- Wheel.Bk.L", "WHEEL_RR": "muDEF- Wheel.Bk.R"}
# The rigger named the door bones from the front view: "right door" sits on +X, the car's left.
HINGE_BONES = {"DOOR_FL": "right door", "DOOR_FR": "left door"}
STEERING_BONE = "stering bone"        # head = hub, tail-head = up the wheel face (forward and up)
SCALE = 0.88                          # source is ~1.12x life size: wheelbase 3.03 m, length 5.38 m
DOOR_OPEN_DEG, STEERING_LOCK_DEG = 65.0, 450.0

CLASSES = ["paint", "band", "trim", "glass", "alloy", "rubber", "interior", "lamp_head", "lamp_tail", "lamp_blue"]
INTERIOR_MATS = {"interior", "interior.0", "interior.2", "interior.3", "interior.4", "interior.6",
                 "interior with emission", "blue interior lights", "interior upper light"}
EXTERIOR_MATS = {"primary", "secondary", "window.001", "glass", "Material.003", "chassis.6", "bump_front_ok.5", "bump_front_ok.3"}
# Islands whose dominant material is one of these are brand decals, display textures or duplicate
# lamp shells (the tail lamps are modelled three times: brake, indicator and emissive copies).
DELETE_MATS = {"log.0", "engine_a.1", "engine_a.3", "v8_a.1", "tahook.0", "0.0", "Material.004",
               "Dots Stroke", "curve", "Material.007"}
MECHANICAL = {"extra1.0", "fanar.0", "engine.0", "engine.1", "engine.4", "engine_a.0", "engine_a.2",
              "interior.0", "interior.2", "interior.6", "interior", "chassis.6"}
# Deletion boxes in source world coordinates (metres): an island is removed when it lies fully inside
# the box and its dominant material is in the set. Labels feed the report's removed-parts list.
BOXES = [
    ("engine bay under the closed bonnet", (-0.88, 0.88, -3.93, -2.33, 0.30, 1.12), MECHANICAL),
    ("under-floor mechanicals (exhaust, driveshaft, suspension)", (-0.72, 0.72, -2.60, 1.05, -1.0, 0.33), MECHANICAL),
    ("front-left wheel well brakes and hubs", (0.70, 1.30, -3.44, -2.64, -1.0, 0.70), {"extra1.0", "fanar.0", "engine.1", "engine.4", "engine.0"}),
    ("front-right wheel well brakes and hubs", (-1.30, -0.70, -3.44, -2.64, -1.0, 0.70), {"extra1.0", "fanar.0", "engine.1", "engine.4", "engine.0"}),
    ("rear-left wheel well brakes and hubs", (0.70, 1.30, -0.41, 0.40, -1.0, 0.70), {"extra1.0", "fanar.0", "engine.1", "engine.4", "engine.0"}),
    ("rear-right wheel well brakes and hubs", (-1.30, -0.70, -0.41, 0.40, -1.0, 0.70), {"extra1.0", "fanar.0", "engine.1", "engine.4", "engine.0"}),
    ("grille emblem and its housing", (-0.09, 0.09, -4.20, -3.90, 0.62, 0.80), {"interior.2", "log.0", "extra1.0"}),
    ("left fender badge", (0.97, 1.20, -2.46, -2.30, 0.72, 0.88), {"interior.2", "log.0"}),
    ("right fender badge", (-1.20, -0.97, -2.46, -2.30, 0.72, 0.88), {"interior.2", "log.0"}),
    ("rear emblem", (-0.10, 0.10, 1.02, 1.30, 0.88, 1.16), {"interior.2", "log.0"}),
    ("rear number plate, frame, screws and plate lamps", (-0.22, 0.22, 1.10, 1.30, 0.55, 0.86),
     {"extra1.0", "bump_rear_ok.5", "bump_rear_ok.6", "window.001", "secondary", "right front light"}),
]
TINY_DIAG = {"body": 0.035, "bonnet": 0.035, "door_l": 0.03, "door_r": 0.03, "steering": 0.02}
CABIN = (-0.95, 0.95, -2.66, 0.62, 0.28, 1.56)
# Decimation budgets (triangles) per node and material class; groups under budget are left alone.
BUDGET = {("CAR_BODY", "paint"): 9500, ("CAR_BODY", "band"): 400, ("CAR_BODY", "trim"): 4500,
          ("CAR_BODY", "lamp_head"): 600, ("CAR_BODY", "lamp_tail"): 900, ("CAR_BODY", "alloy"): 1000,
          ("CAR_GLASS", "glass"): 1000, ("CAR_INTERIOR", "interior"): 5500,
          ("DOOR_FL", "paint"): 700, ("DOOR_FL", "interior"): 1200, ("DOOR_FL", "trim"): 350,
          ("DOOR_FL", "glass"): 80, ("DOOR_FL", "lamp_head"): 30,
          ("DOOR_FR", "paint"): 700, ("DOOR_FR", "interior"): 1200, ("DOOR_FR", "trim"): 350,
          ("DOOR_FR", "glass"): 80, ("DOOR_FR", "lamp_head"): 30,
          ("STEERING_WHEEL", "interior"): 700}
# Sockets that are not derived from geometry, in source world coordinates (hips on the driver's seat
# cushion island; lamp centres from the headlight projector and tail cluster islands).
SOURCE_POINTS = {"SEAT_DRIVER": (0.414, -1.20, 0.66), "LIGHT_HEAD_L": (0.851, -3.612, 0.81),
                 "LIGHT_HEAD_R": (-0.851, -3.612, 0.81), "LIGHT_TAIL_L": (0.68, 1.0, 0.97),
                 "LIGHT_TAIL_R": (-0.68, 1.0, 0.97)}
EXIT_X = 1.5  # metres from the centreline; "1.5 m out" in the contract read as a centreline offset

MATERIALS = {  # class: (base colour sRGB, roughness, metallic, coat, emission sRGB, alpha)
    "band": ((0.10, 0.32, 0.72), 0.40, 0.30, 0.3, None, 1.0),
    "trim": ((0.05, 0.05, 0.055), 0.70, 0.0, 0.0, None, 1.0),
    "glass": ((0.03, 0.04, 0.05), 0.05, 0.0, 0.0, None, 0.4),
    "alloy": ((0.62, 0.63, 0.66), 0.35, 1.0, 0.0, None, 1.0),
    "rubber": ((0.03, 0.03, 0.03), 0.90, 0.0, 0.0, None, 1.0),
    "interior": ((0.09, 0.085, 0.085), 0.80, 0.0, 0.0, None, 1.0),
    "lamp_head": ((0.85, 0.88, 0.90), 0.20, 0.0, 0.0, (0.90, 0.95, 1.0), 1.0),
    "lamp_tail": ((0.50, 0.02, 0.02), 0.20, 0.0, 0.0, (0.80, 0.05, 0.02), 1.0),
    "lamp_blue": ((0.10, 0.20, 0.90), 0.20, 0.0, 0.0, (0.20, 0.40, 1.0), 1.0),
}
PAINTS = {"vehicle-lumi-gt": ((0.50, 0.03, 0.05), 0.35, 0.6, 0.5, None, 1.0),
          "vehicle-patrol": ((0.93, 0.93, 0.92), 0.35, 0.3, 0.5, None, 1.0)}
EMISSION_STRENGTH = {"lamp_head": 1.5, "lamp_tail": 1.5, "lamp_blue": 3.0}


def srgb_to_linear(c):
    return tuple(x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c)


def to_gltf(p):
    """Blender authoring frame -> glTF asset frame (what export_yup does to positions)."""
    return [round(float(p[0]), 4), round(float(p[2]), 4), round(float(-p[1]), 4)]


def rounded(v, n=4):
    return [round(float(c), n) for c in v]


# --- source extraction ----------------------------------------------------------------------------------
def mesh_arrays(obj, deyaw):
    me = obj.data
    co = np.empty(len(me.vertices) * 3)
    me.vertices.foreach_get("co", co)
    m = np.array(obj.matrix_world)
    world = (co.reshape(-1, 3) @ m[:3, :3].T + m[:3, 3]) @ deyaw.T
    nf = len(me.polygons)
    ls, lt, mi = (np.empty(nf, dtype=np.int64) for _ in range(3))
    me.polygons.foreach_get("loop_start", ls)
    me.polygons.foreach_get("loop_total", lt)
    me.polygons.foreach_get("material_index", mi)
    lv = np.empty(len(me.loops), dtype=np.int64)
    me.loops.foreach_get("vertex_index", lv)
    edges = np.empty(len(me.edges) * 2, dtype=np.int64)
    me.edges.foreach_get("vertices", edges)
    names = [mt.name if mt else "None" for mt in me.materials] or ["None"]
    return {"verts": world, "loop_start": ls, "loop_total": lt, "loop_verts": lv,
            "mat": np.array([names[min(i, len(names) - 1)] for i in mi.tolist()]), "edges": edges.reshape(-1, 2)}


def islands(data):
    """Connected components: per-face island id and per-island stats (tris, bounds, dominant material)."""
    nv = len(data["verts"])
    parent = np.arange(nv)

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    for a, b in data["edges"].tolist():
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra
    labels = np.array([find(i) for i in range(nv)])
    _, labels = np.unique(labels, return_inverse=True)
    face_label = labels[data["loop_verts"][data["loop_start"]]]
    n = int(labels.max()) + 1
    tris = np.bincount(face_label, weights=data["loop_total"] - 2, minlength=n)
    lo = np.full((n, 3), np.inf)
    hi = np.full((n, 3), -np.inf)
    np.minimum.at(lo, labels, data["verts"])
    np.maximum.at(hi, labels, data["verts"])
    mats = np.unique(data["mat"])
    mat_index = np.searchsorted(mats, data["mat"])
    hist = np.bincount(face_label * len(mats) + mat_index, minlength=n * len(mats)).reshape(n, len(mats))
    dominant = mats[np.argmax(hist, axis=1)]
    return {"face_label": face_label, "count": n, "tris": tris, "lo": lo, "hi": hi, "centroid": (lo + hi) / 2,
            "diag": np.linalg.norm(hi - lo, axis=1), "dominant": dominant}


def inside(lo, hi, box):
    x0, x1, y0, y1, z0, z1 = box
    return lo[0] >= x0 and hi[0] <= x1 and lo[1] >= y0 and hi[1] <= y1 and lo[2] >= z0 and hi[2] <= z1


def face_class(mat, y):
    if mat in ("primary", "secondary"):
        return "paint"
    if mat in ("window.001", "glass"):
        return "glass"
    if mat == "Material.003":
        return "alloy"
    if mat in INTERIOR_MATS or mat in ("0.0", "tahook.0"):
        return "interior"
    if mat in ("breaklight l", "left rear light"):
        return "lamp_tail"
    if mat.startswith("indicator") or mat in ("right front light", "foglight l", "light night", "revlight r",
                                              "Material.005", "Material.004"):
        return "lamp_tail" if y > 0 else "lamp_head"
    return "trim"


def classify(key, data, isl, removed):
    """Per face: keep flag, target node and material class. Records deleted-part summaries."""
    n = isl["count"]
    keep = np.ones(n, dtype=bool)
    reasons = {}

    def drop(i, why):
        if keep[i]:
            keep[i] = False
            reasons.setdefault(why, [0, 0.0])
            reasons[why][0] += 1
            reasons[why][1] += float(isl["tris"][i])

    for i in range(n):
        dom, lo, hi, c = isl["dominant"][i], isl["lo"][i], isl["hi"][i], isl["centroid"][i]
        if isl["diag"][i] < TINY_DIAG[key]:
            drop(i, f"{key}: debris islands under {TINY_DIAG[key] * 100:.1f} cm (bolts, clips, screws)")
            continue
        if dom in DELETE_MATS:
            drop(i, f"{key}: islands of material '{dom}' (brand decal, display texture or duplicate lamp shell)")
            continue
        if dom.startswith("indicator") and c[1] > 0:
            drop(i, f"{key}: rear indicator shells duplicating the tail lamps")
            continue
        if key == "steering" and dom == "blue interior lights":
            drop(i, "steering: hub pad with the backlit emblem (replaced by a plain disc)")
            continue
        if key in ("body", "bonnet"):
            for label, box, mats in BOXES:
                if dom in mats and inside(lo, hi, box):
                    drop(i, f"{key}: {label}")
                    break
    for why, (count, tris) in reasons.items():
        removed.append({"what": why, "islands": count, "triangles": int(tris)})

    nf = len(data["mat"])
    node = np.empty(nf, dtype=object)
    cls = np.empty(nf, dtype=object)
    fl = isl["face_label"]
    face_y = data["verts"][data["loop_verts"][data["loop_start"]]][:, 1]
    # Everything that lies fully inside the cabin box and is not skin, glass or lamp-reflector chrome is
    # interior (seats, dash, lining, emissive display and dome-light islands included).
    cabin_island = np.array([inside(isl["lo"][i], isl["hi"][i], CABIN) and isl["dominant"][i] not in EXTERIOR_MATS
                             for i in range(n)])
    default_node = {"body": "CAR_BODY", "bonnet": "CAR_BODY", "door_l": "DOOR_FL", "door_r": "DOOR_FR",
                    "steering": "STEERING_WHEEL"}[key]
    for f in range(nf):
        mat = data["mat"][f]
        c = face_class(mat, face_y[f])
        nd = default_node
        if key == "body" and cabin_island[fl[f]]:
            nd = "CAR_INTERIOR"
        if key == "bonnet" and mat == "secondary":
            c = "band"  # the over-the-top stripes become the patrol's bonnet stripes
        if key in ("body", "bonnet") and c == "glass":
            nd = "CAR_GLASS"
        elif nd == "CAR_BODY" and c == "interior":
            c = "trim"  # black plastics outside the cabin: grille, vents, bumper inserts
        elif nd == "CAR_INTERIOR":
            c = "interior"
        elif nd == "STEERING_WHEEL":
            c = "interior"
        node[f], cls[f] = nd, c
    return keep[fl], node, cls


# --- mesh building ----------------------------------------------------------------------------------------
def face_lists(data, faces_mask):
    out = []
    ls, lt, lv = data["loop_start"], data["loop_total"], data["loop_verts"]
    for f in np.nonzero(faces_mask)[0].tolist():
        out.append(lv[ls[f]:ls[f] + lt[f]].tolist())
    return out


def compact(verts, faces):
    used = np.unique(np.concatenate([np.asarray(f) for f in faces])) if faces else np.array([], dtype=np.int64)
    remap = np.full(len(verts), -1, dtype=np.int64)
    remap[used] = np.arange(len(used))
    return verts[used], [[int(remap[v]) for v in f] for f in faces]


def new_object(name, verts, faces, collection, material_index=None, materials=None):
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(map(float, v)) for v in verts], [], faces)
    if materials:
        for mt in materials:
            me.materials.append(mt)
    if material_index is not None:
        me.polygons.foreach_set("material_index", material_index)
    me.validate(verbose=False)
    obj = bpy.data.objects.new(name, me)
    collection.objects.link(obj)
    return obj


def triangles(me):
    return sum(len(p.vertices) - 2 for p in me.polygons)


def decimate(obj, target):
    """Collapse-decimate in place to about ``target`` triangles (depsgraph evaluation, no operators)."""
    before = triangles(obj.data)
    if before <= target:
        return before, before
    mod = obj.modifiers.new("decimate", "DECIMATE")
    mod.decimate_type = "COLLAPSE"
    mod.ratio = target / before
    mod.use_collapse_triangulate = True
    depsgraph = bpy.context.evaluated_depsgraph_get()
    evaluated = bpy.data.meshes.new_from_object(obj.evaluated_get(depsgraph))
    obj.modifiers.clear()
    old = obj.data
    obj.data = evaluated
    bpy.data.meshes.remove(old)
    return before, triangles(evaluated)


def read_back(obj):
    me = obj.data
    co = np.empty(len(me.vertices) * 3)
    me.vertices.foreach_get("co", co)
    faces = [list(p.vertices) for p in me.polygons]
    return co.reshape(-1, 3), faces


def finish_mesh(me, sharp_deg):
    me.validate(verbose=False)
    me.shade_smooth()
    me.set_sharp_from_angle(angle=math.radians(sharp_deg))


def build_node(name, groups, collection, materials, work, budget_log, sharp_deg=38.0):
    """groups: {class: (verts, faces)} in the node's local frame -> one mesh object with class slots."""
    all_verts, all_faces, all_cls = [], [], []
    offset = 0
    for cls, (verts, faces) in groups.items():
        if not faces:
            continue
        tmp = new_object(f"tmp_{name}_{cls}", verts, faces, work)
        before, after = decimate(tmp, BUDGET.get((name, cls), 10 ** 9))
        budget_log.append({"node": name, "class": cls, "before": before, "after": after})
        v, f = read_back(tmp)
        all_verts.append(v)
        all_faces.extend([[i + offset for i in face] for face in f])
        all_cls.extend([CLASSES.index(cls)] * len(f))
        offset += len(v)
        bpy.data.objects.remove(tmp)
    verts = np.concatenate(all_verts) if all_verts else np.zeros((0, 3))
    obj = new_object(name, verts, all_faces, collection, all_cls, [materials[c] for c in CLASSES])
    finish_mesh(obj.data, sharp_deg)
    return obj


# --- procedural parts -------------------------------------------------------------------------------------
def bm_tag(bm, seen, cls_index, tags):
    for f in bm.faces:
        if f not in seen:
            seen.add(f)
            tags[f] = cls_index


def bm_to_object(bm, name, collection, materials, tags, sharp_deg=30.0):
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    for f in bm.faces:
        f.material_index = tags.get(f, 0)
    me = bpy.data.meshes.new(name)
    for c in CLASSES:
        me.materials.append(materials[c])
    bm.to_mesh(me)
    bm.free()
    finish_mesh(me, sharp_deg)
    obj = bpy.data.objects.new(name, me)
    collection.objects.link(obj)
    return obj


def build_wheel(name, side, radius, width, collection, materials):
    """Tyre, rim lip, barrel, hub, ten spokes, brake rotor and calliper around the origin; axle = local X,
    outboard face at side * X. Closed shells only, so recalculated normals are consistent."""
    bm = bmesh.new()
    seen, tags = set(), {}
    rim_r = radius - 0.075
    segments = 32
    hw = width / 2
    # Tyre: closed profile (axial, radial) spun around X.
    profile = [(-hw + 0.03, rim_r + 0.012), (-hw, rim_r + 0.05), (-hw + 0.012, radius - 0.03), (-hw + 0.045, radius),
               (hw - 0.045, radius), (hw - 0.012, radius - 0.03), (hw, rim_r + 0.05), (hw - 0.03, rim_r + 0.012),
               (hw - 0.03, rim_r - 0.02), (-hw + 0.03, rim_r - 0.02)]
    def spin_profile(points, cls):
        pv = [bm.verts.new((a, r, 0.0)) for a, r in points]
        pe = [bm.edges.new((pv[i], pv[(i + 1) % len(pv)])) for i in range(len(pv))]
        bmesh.ops.spin(bm, geom=pv + pe, cent=(0, 0, 0), axis=(1, 0, 0), angle=2 * math.pi, steps=segments, use_merge=True)
        bm_tag(bm, seen, CLASSES.index(cls), tags)

    spin_profile(profile, "rubber")
    face_a = side * (hw - 0.055)  # dished spoke face, inside the tyre's outer edge

    def cylinder(radius1, depth, centre, cls, axis_matrix=Matrix.Rotation(math.pi / 2, 4, "Y")):
        mat = Matrix.Translation(centre) @ axis_matrix
        bmesh.ops.create_cone(bm, cap_ends=True, segments=segments, radius1=radius1, radius2=radius1, depth=depth, matrix=mat)
        bm_tag(bm, seen, CLASSES.index(cls), tags)

    def box(size, centre, rotation_x=0.0, cls="alloy"):
        mat = Matrix.Translation(centre) @ Matrix.Rotation(rotation_x, 4, "X") @ Matrix.Diagonal((*size, 1.0))
        bmesh.ops.create_cube(bm, size=1.0, matrix=mat)
        bm_tag(bm, seen, CLASSES.index(cls), tags)

    # Rim lip (thick ring) and barrel (thin tube seen through the spokes), hub cap.
    spin_profile([(side * (hw - 0.03), rim_r - 0.004), (side * (hw - 0.03), rim_r - 0.03), (side * (hw - 0.07), rim_r - 0.03),
                  (side * (hw - 0.07), rim_r - 0.004)], "alloy")
    spin_profile([(side * (hw - 0.07), rim_r - 0.03), (-side * (hw - 0.05), rim_r - 0.03), (-side * (hw - 0.05), rim_r - 0.045),
                  (side * (hw - 0.07), rim_r - 0.045)], "trim")
    cylinder(0.085, 0.045, (face_a, 0.0, 0.0), "alloy")
    r_in, r_out = 0.07, rim_r - 0.02
    for i in range(5):
        for delta in (-9.0, 9.0):
            angle = math.radians(i * 72.0 + delta)
            r_mid = (r_in + r_out) / 2
            box((0.032, r_out - r_in, 0.028), (face_a, r_mid * math.cos(angle), r_mid * math.sin(angle)), angle, "alloy")
    # Brake rotor and calliper, inboard of the spokes.
    cylinder(0.165 * radius / 0.342, 0.03, (face_a - side * 0.06, 0.0, 0.0), "alloy")
    cal = math.radians(115.0)
    box((0.07, 0.11, 0.06), (face_a - side * 0.06, 0.145 * math.cos(cal), 0.145 * math.sin(cal)), cal, "trim")
    return bm_to_object(bm, name, collection, materials, tags)


def build_lightbar(collection, materials):
    """Roof light bar in the LIGHTBAR socket's frame: 1.0 m wide, 0.12 m tall; two blue lamps."""
    bm = bmesh.new()
    seen, tags = set(), {}

    def box(size, centre, cls):
        bmesh.ops.create_cube(bm, size=1.0, matrix=Matrix.Translation(centre) @ Matrix.Diagonal((*size, 1.0)))
        bm_tag(bm, seen, CLASSES.index(cls), tags)

    box((1.0, 0.24, 0.03), (0.0, 0.0, 0.015), "trim")                 # base plate
    box((0.08, 0.20, 0.09), (0.0, 0.0, 0.075), "trim")                # centre module
    for x in (-0.27, 0.27):
        box((0.44, 0.20, 0.09), (x, 0.0, 0.075), "lamp_blue")         # lamp blocks, 0.12 m total height
    return bm_to_object(bm, "LIGHTBAR_MESH", collection, materials, tags, sharp_deg=60.0)


def build_hub_disc(collection, materials, s):
    """Plain disc replacing the steering hub pad: axis along local Y (toward the driver)."""
    bm = bmesh.new()
    seen, tags = set(), {}
    bmesh.ops.create_cone(bm, cap_ends=True, segments=24, radius1=0.06 * s, radius2=0.06 * s, depth=0.04 * s,
                          matrix=Matrix.Rotation(math.pi / 2, 4, "X"))
    bm_tag(bm, seen, CLASSES.index("interior"), tags)
    return bm_to_object(bm, "tmp_hub", collection, materials, tags)


# --- materials, band, export --------------------------------------------------------------------------------
def make_materials():
    out = {}
    for cls in CLASSES:
        spec = MATERIALS.get(cls, PAINTS["vehicle-lumi-gt"])
        mt = bpy.data.materials.new(f"car_{cls}")
        mt.use_nodes = True
        set_material(mt, spec, EMISSION_STRENGTH.get(cls, 1.0))
        mt["role"] = "vehicle"
        out[cls] = mt
    return out


def set_material(mt, spec, emission_strength=1.0):
    colour, roughness, metallic, coat, emission, alpha = spec
    p = next(n for n in mt.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    p.inputs["Base Color"].default_value = srgb_to_linear(colour) + (1.0,)
    p.inputs["Roughness"].default_value = roughness
    p.inputs["Metallic"].default_value = metallic
    p.inputs["Coat Weight"].default_value = coat
    p.inputs["Coat Roughness"].default_value = 0.03
    if emission:
        p.inputs["Emission Color"].default_value = srgb_to_linear(emission) + (1.0,)
        p.inputs["Emission Strength"].default_value = emission_strength
    p.inputs["Alpha"].default_value = alpha
    if alpha < 1.0:
        mt.surface_render_method = "BLENDED"
    mt.diffuse_color = srgb_to_linear(colour) + (alpha,)


def paint_band(obj, z_range, y_range, offset, extra_region=None):
    """Patrol: cut the object's paint faces along the band planes and recolour the side band. ``offset``
    is the object's origin in root space; planes and the region test are given in root space."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    paint, band = CLASSES.index("paint"), CLASSES.index("band")
    planes = [((0, 0, z_range[0] - offset[2]), (0, 0, 1)), ((0, 0, z_range[1] - offset[2]), (0, 0, 1))]
    if y_range:
        planes += [((0, y_range[0] - offset[1], 0), (0, 1, 0)), ((0, y_range[1] - offset[1], 0), (0, 1, 0))]
    for co, no in planes:
        faces = [f for f in bm.faces if f.material_index == paint]
        geom = set(faces)
        for f in faces:
            geom.update(f.edges)
            geom.update(f.verts)
        bmesh.ops.bisect_plane(bm, geom=list(geom), plane_co=co, plane_no=no, dist=1e-5)
    changed = 0
    for f in bm.faces:
        if f.material_index != paint:
            continue
        c = f.calc_center_median() + Vector(offset)
        if not (z_range[0] - 1e-4 <= c.z <= z_range[1] + 1e-4):
            continue
        if y_range and not (y_range[0] - 1e-4 <= c.y <= y_range[1] + 1e-4):
            continue
        if extra_region and not extra_region(c, f.normal):
            continue
        f.material_index = band
        changed += 1
    bm.to_mesh(obj.data)
    bm.free()
    finish_mesh(obj.data, 38.0)
    return changed


def export_variant(glb, objects):
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    options = dict(filepath=str(glb), export_format="GLB", use_selection=True, export_yup=True, export_apply=True,
                   export_animations=False, export_materials="EXPORT", export_extras=True, export_normals=True,
                   export_texcoords=False, export_tangents=False, export_vertex_color="NONE", export_cameras=False,
                   export_lights=False, export_skins=False, export_morph=False, export_image_format="NONE",
                   export_copyright="Derived from the project owner's own model; brand marks removed")
    bpy.ops.export_scene.gltf(**options)
    return {k: v for k, v in options.items() if k != "filepath"}


def node_stats(objects):
    tris, mats = {}, set()
    for obj in objects:
        if obj.type != "MESH":
            continue
        tris[obj.name] = triangles(obj.data)
        used = {p.material_index for p in obj.data.polygons}
        mats |= {obj.data.materials[i].name for i in used if i < len(obj.data.materials)}
    tris["total"] = sum(tris.values())
    return tris, sorted(mats)


# --- main ----------------------------------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--contract", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
    source, out = args.source.resolve(), args.out.resolve()
    contract = json.loads(args.contract.read_text(encoding="utf-8"))
    out.mkdir(parents=True, exist_ok=True)
    source_bytes = source.read_bytes()
    source_sha = hashlib.sha256(source_bytes).hexdigest()

    # 1. Source: rest pose, world-space arrays, then the scene is thrown away.
    bpy.ops.wm.open_mainfile(filepath=str(source), load_ui=False, use_scripts=False)
    for obj in bpy.data.objects:
        if obj.type == "ARMATURE":
            obj.data.pose_position = "REST"
    bpy.context.view_layer.update()
    rig = bpy.data.objects[RIG]
    deyaw = np.array(rig.matrix_world.to_3x3().inverted())
    data = {key: mesh_arrays(bpy.data.objects[name], deyaw) for key, name in SRC.items()}
    wheels_src = {}
    for node, name in SRC_WHEELS.items():
        d = mesh_arrays(bpy.data.objects[name], deyaw)
        wheels_src[node] = {"lo": d["verts"].min(axis=0), "hi": d["verts"].max(axis=0)}
    controls = bpy.data.objects[CONTROLS]
    cm = controls.matrix_world
    bone_point = lambda b, attr: deyaw @ np.array(cm @ getattr(controls.data.bones[b], attr))
    hinges = {node: bone_point(b, "head_local") for node, b in HINGE_BONES.items()}
    st_head, st_tail = bone_point(STEERING_BONE, "head_local"), bone_point(STEERING_BONE, "tail_local")
    source_summary = {
        "fileVersion": list(bpy.data.version), "units": bpy.context.scene.unit_settings.system,
        "unitScale": bpy.context.scene.unit_settings.scale_length,
        "objects": sorted(o.name for o in bpy.data.objects),
        "armatures": {o.name: {"bones": len(o.data.bones), "drivers": len(o.animation_data.drivers) if o.animation_data else 0,
                               "poseConstraints": sum(len(pb.constraints) for pb in o.pose.bones)}
                      for o in bpy.data.objects if o.type == "ARMATURE"},
        "images": sorted(im.name for im in bpy.data.images if im.source == "FILE"),
        "materials": len(bpy.data.materials),
        "sourceTriangles": {k: int((d["loop_total"] - 2).sum()) for k, d in data.items()},
    }
    bpy.ops.wm.read_factory_settings(use_empty=True)

    # 2. Measurements in source space, then the root transform.
    hubs = {n: (w["lo"] + w["hi"]) / 2 for n, w in wheels_src.items()}
    wheel_radius_src = float(np.mean([(w["hi"][2] - w["lo"][2]) / 2 for w in wheels_src.values()]))
    wheel_width_src = float(np.mean([w["hi"][0] - w["lo"][0] for w in wheels_src.values()]))
    ground_src = float(min(w["lo"][2] for w in wheels_src.values()))
    front_y = (hubs["WHEEL_FL"][1] + hubs["WHEEL_FR"][1]) / 2
    rear_y = (hubs["WHEEL_RL"][1] + hubs["WHEEL_RR"][1]) / 2
    track_x = float(np.mean([abs(h[0]) for h in hubs.values()]))
    root_src = np.array([float(np.mean([h[0] for h in hubs.values()])), (front_y + rear_y) / 2, ground_src])
    s = SCALE
    T = lambda p: (np.asarray(p, dtype=np.float64) - root_src) * s  # source world -> CAR_ROOT space (Blender axes)
    for d in data.values():
        d["verts_src"] = d["verts"]
    wheelbase = float((rear_y - front_y) * s)

    # 3. Classification per source mesh.
    removed, budget_log = [], []
    groups = {}  # (node, class) -> list of (verts_root, faces)
    for key, d in data.items():
        isl = islands(d)
        keep, node, cls = classify(key, d, isl, removed)
        for nd in np.unique(node[keep]):
            for c in np.unique(cls[keep & (node == nd)]):
                mask = keep & (node == nd) & (cls == c)
                verts, faces = compact(T(d["verts_src"]), face_lists(d, mask))
                groups.setdefault((nd, c), []).append((verts, faces))

    def merged(nd):
        out = {}
        for (n, c), parts in groups.items():
            if n != nd:
                continue
            vs, fs, off = [], [], 0
            for v, f in parts:
                vs.append(v)
                fs.extend([[i + off for i in face] for face in f])
                off += len(v)
            out[c] = (np.concatenate(vs), fs)
        return out

    # 4. Scene: root, materials, node meshes.
    scene = bpy.context.scene
    visual = bpy.data.collections.new("VISUAL")
    scene.collection.children.link(visual)
    work = bpy.data.collections.new("WORK")
    scene.collection.children.link(work)
    root = bpy.data.objects.new("CAR_ROOT", None)
    root["role"] = "asset-root"
    root["assetId"] = contract["assetId"]
    visual.objects.link(root)
    materials = make_materials()

    def adopt(obj, role, **props):
        obj.parent = root
        obj.matrix_parent_inverse = Matrix.Identity(4)
        obj["role"] = role
        for k, v in props.items():
            obj[k] = v
        return obj

    body_groups = merged("CAR_BODY")
    # The engine was deleted: a dark horizontal plane under the bonnet vent and a dark vertical plane behind
    # the grille stop the vent and grille openings from showing the road or the cabin.
    a, b = T((-0.86, -3.90, 0.80)), T((0.86, -2.40, 0.80))
    c, d = T((-0.80, -3.84, 0.30)), T((0.80, -3.84, 1.02))
    extra_v = np.array([[a[0], a[1], a[2]], [b[0], a[1], a[2]], [b[0], b[1], a[2]], [a[0], b[1], a[2]],
                        [c[0], c[1], c[2]], [d[0], c[1], c[2]], [d[0], c[1], d[2]], [c[0], c[1], d[2]]])
    tv, tf = body_groups.get("trim", (np.zeros((0, 3)), []))
    n0 = len(tv)
    body_groups["trim"] = (np.concatenate([tv, extra_v]), tf + [[n0, n0 + 1, n0 + 2, n0 + 3], [n0 + 4, n0 + 5, n0 + 6, n0 + 7]])
    nodes = {}
    nodes["CAR_BODY"] = adopt(build_node("CAR_BODY", body_groups, visual, materials, work, budget_log), "vehicle-body")
    nodes["CAR_GLASS"] = adopt(build_node("CAR_GLASS", merged("CAR_GLASS"), visual, materials, work, budget_log), "vehicle-glass")
    nodes["CAR_INTERIOR"] = adopt(build_node("CAR_INTERIOR", merged("CAR_INTERIOR"), visual, materials, work, budget_log, 50.0), "vehicle-interior")
    door_hinges = {}
    for node in ("DOOR_FL", "DOOR_FR"):
        hinge = T(hinges[node])
        door_hinges[node] = hinge
        local = {c: (v - hinge, f) for c, (v, f) in merged(node).items()}
        obj = build_node(node, local, visual, materials, work, budget_log)
        obj.location = hinge.tolist()
        adopt(obj, "vehicle-door", openDeg=DOOR_OPEN_DEG, openSign=-1.0 if node == "DOOR_FL" else 1.0)
        nodes[node] = obj
    # Steering wheel: local X = car X, local +Z = up the wheel face (the control bone's direction), local -Y =
    # column away from the driver; export_yup turns local -Y into glTF +Z, the contract's turning axis.
    hub = T(st_head)
    up_face = st_tail - st_head
    up_face[0] = 0.0
    up_face /= np.linalg.norm(up_face)
    toward_driver = np.array([0.0, up_face[2], -up_face[1]])
    if toward_driver[1] < 0:
        toward_driver = -toward_driver
    r_sw = np.column_stack([[1.0, 0.0, 0.0], toward_driver, np.cross([1.0, 0.0, 0.0], toward_driver)])
    local = {c: ((v - hub) @ r_sw, f) for c, (v, f) in merged("STEERING_WHEEL").items()}
    sw = build_node("STEERING_WHEEL", local, visual, materials, work, budget_log, 45.0)
    disc = build_hub_disc(work, materials, s)
    dv, df = read_back(disc)
    bpy.data.objects.remove(disc)
    sw_bm = bmesh.new()
    sw_bm.from_mesh(sw.data)
    new_verts = [sw_bm.verts.new(tuple(v)) for v in dv]
    for f in df:
        face = sw_bm.faces.new([new_verts[i] for i in f])
        face.material_index = CLASSES.index("interior")
        face.smooth = True
    sw_bm.to_mesh(sw.data)
    sw_bm.free()
    finish_mesh(sw.data, 45.0)
    sw.matrix_world = Matrix.Translation(hub.tolist()) @ Matrix(r_sw.tolist()).to_4x4()
    adopt(sw, "steering-wheel", lockDeg=STEERING_LOCK_DEG)
    nodes["STEERING_WHEEL"] = sw
    wheel_radius, wheel_width = wheel_radius_src * s, wheel_width_src * s
    wheel_positions = {}
    for node in SRC_WHEELS:
        side = 1.0 if node.endswith("L") else -1.0
        y = front_y if node[-2] == "F" else rear_y
        pos = T((side * track_x, y, hubs[node][2]))
        pos[2] = wheel_radius  # hub height above the ground is the tyre radius by construction
        obj = build_wheel(node, side, wheel_radius, wheel_width, visual, materials)
        obj.location = pos.tolist()
        adopt(obj, "wheel")
        nodes[node] = obj
        wheel_positions[node] = pos
    # Sockets.
    body_me = nodes["CAR_BODY"].data
    bco = np.empty(len(body_me.vertices) * 3)
    body_me.vertices.foreach_get("co", bco)
    bco = bco.reshape(-1, 3)
    body_lo, body_hi = bco.min(axis=0), bco.max(axis=0)
    roof_mask = (np.abs(bco[:, 0]) < 0.3) & (bco[:, 1] > T((0, -1.5, 0))[1]) & (bco[:, 1] < T((0, -0.5, 0))[1])
    roof_z = float(bco[roof_mask][:, 2].max())
    door_centre_y = float(T((0, -1.48, 0))[1])
    sockets = {name: T(p) for name, p in SOURCE_POINTS.items()}
    sockets["EXIT_DRIVER"] = np.array([EXIT_X, door_centre_y, 0.0])
    sockets["EXIT_PASSENGER"] = np.array([-EXIT_X, door_centre_y, 0.0])
    sockets["CAMERA_CHASE"] = np.array([0.0, 7.5, 2.3])
    sockets["CENTER_OF_MASS"] = np.array([0.0, -0.15, 0.45])
    sockets["LIGHTBAR"] = np.array([0.0, T((0, -1.0, 0))[1], roof_z + 0.005])
    purposes = {sk["node"]: sk["purpose"] for sk in contract["sockets"]}
    socket_objects = {}
    for name, pos in sockets.items():
        empty = bpy.data.objects.new(name, None)
        empty.empty_display_type = "PLAIN_AXES"
        empty.empty_display_size = 0.2
        empty.location = pos.tolist()
        visual.objects.link(empty)
        adopt(empty, "socket", purpose=purposes.get(name, name))
        socket_objects[name] = empty
    bpy.data.collections.remove(work)

    # 5. Variants (the contract lists the civilian car first, the patrol car second).
    export_objects = [o for o in visual.all_objects]
    report_variants = {}
    export_options = None
    band_faces = {}

    def material_indices(obj):
        idx = np.empty(len(obj.data.polygons), dtype=np.int64)
        obj.data.polygons.foreach_get("material_index", idx)
        return idx

    for variant in contract["variants"]:
        vid = variant["id"]
        patrol = vid == "vehicle-patrol"
        set_material(materials["paint"], PAINTS[vid])
        objects = list(export_objects)
        original = {}
        if patrol:
            z_band = (0.50, 0.78)
            arch = wheel_radius + 0.07
            body_y = (wheel_positions["WHEEL_FL"][1] + arch, wheel_positions["WHEEL_RL"][1] - arch)
            side_only = lambda c, n: abs(c.x) > 0.80 and abs(n.x) > 0.35
            band_faces["CAR_BODY"] = paint_band(nodes["CAR_BODY"], z_band, body_y, (0.0, 0.0, 0.0), side_only)
            for node in ("DOOR_FL", "DOOR_FR"):
                band_faces[node] = paint_band(nodes[node], z_band, None, door_hinges[node], side_only)
            lightbar = build_lightbar(visual, materials)
            lightbar.parent = socket_objects["LIGHTBAR"]
            lightbar.matrix_parent_inverse = Matrix.Identity(4)
            lightbar["role"] = "lightbar"
            objects.append(lightbar)
        else:  # civilian: the bonnet stripe faces are plain paint for this export only
            for obj in nodes.values():
                idx = material_indices(obj)
                original[obj.name] = idx.copy()
                idx[idx == CLASSES.index("band")] = CLASSES.index("paint")
                obj.data.polygons.foreach_set("material_index", idx)
        glb = out / variant["file"]
        export_options = export_variant(glb, objects)
        blob = glb.read_bytes()
        tris, mats = node_stats(objects)
        report_variants[vid] = {"file": glb.name, "bytes": len(blob), "sha256": hashlib.sha256(blob).hexdigest(),
                                "triangles": tris, "materials": mats, "materialCount": len(mats), "textures": [],
                                "paint": variant["paint"], "bandFaces": band_faces if patrol else None}
        for name, idx in original.items():
            nodes[name].data.polygons.foreach_set("material_index", idx)
        if patrol:
            (out / "debug").mkdir(exist_ok=True)
            bpy.ops.wm.save_as_mainfile(filepath=str(out / "debug" / "vehicle-build.blend"), compress=True)

    # 6. Report (positions in glTF asset axes: +X left, +Y up, +Z forward).
    body_size = body_hi - body_lo
    gltf_lo = [round(float(body_lo[0]), 4), round(float(body_lo[2]), 4), round(float(-body_hi[1]), 4)]
    gltf_hi = [round(float(body_hi[0]), 4), round(float(body_hi[2]), 4), round(float(-body_lo[1]), 4)]
    report = {
        "status": "EXPORTED_NOT_VERIFIED_IN_RUNTIME", "blender": bpy.app.version_string, "assetId": contract["assetId"],
        "source": {"path": str(source), "bytes": len(source_bytes), "sha256": source_sha, **source_summary},
        "scale": {"factor": s, "sourceWheelbaseM": round(float(rear_y - front_y), 4), "sourceWheelRadiusM": round(wheel_radius_src, 4),
                  "rootInSourceSpace": rounded(root_src), "note": "source is metric at unit scale but ~1.12x life size"},
        "axes": contract["axes"],
        "bodyBoundsLocal": {"min": gltf_lo, "max": gltf_hi, "sizeXYZ": [round(float(body_size[0]), 4), round(float(body_size[2]), 4), round(float(body_size[1]), 4)],
                            "lengthM": round(float(body_size[1]), 4), "widthM": round(float(body_size[0]), 4),
                            "heightM": round(float(body_hi[2]), 4), "note": "CAR_BODY only (mirrors are on the doors); height from the ground"},
        "wheelPositions": {n: to_gltf(p) for n, p in wheel_positions.items()},
        "wheelRadius": round(wheel_radius, 4), "wheelWidth": round(wheel_width, 4), "wheelbase": round(wheelbase, 4),
        "track": round(2 * track_x * s, 4),
        "doorHinges": {n: {"position": to_gltf(p), "openDeg": DOOR_OPEN_DEG, "openSign": -1.0 if n == "DOOR_FL" else 1.0,
                           "axis": "local +Y (vertical)"} for n, p in door_hinges.items()},
        "steeringWheel": {"position": to_gltf(hub), "columnAxisGltf": to_gltf(-toward_driver), "lockDeg": STEERING_LOCK_DEG},
        "sockets": {n: {"position": to_gltf(p), "purpose": purposes.get(n, n)} for n, p in sockets.items()},
        "exitSocketNote": f"EXIT_* are {EXIT_X} m from the centreline at ground level, level with the door centre",
        "variants": report_variants,
        "decimation": budget_log,
        "removedParts": removed + [
            {"what": "all source textures dropped (brand marks: misc.png 'POWERED BY FORD'/'5.0'/'GT'/'brembo'/oval, "
                     "speedo.png cobra + 'FORD PERFORMANCE', interior.png cobra + 'RECARO', wheeel.png sidewall lettering, "
                     "logo.PNG, decal_gt/engine/warning/display, 2K leather maps); flat PBR materials instead"},
            {"what": "source wheels (13k triangles each, tread blocks and lug nuts as islands) replaced by procedural tyre/rim/rotor"},
            {"what": "Pro-Rig armatures 'Car Rig' (55 bones, 13 drivers, 53 constraints) and 'extra controls' (10 bones), rig widgets, "
                     "scene lights and the 'Cone' volume object: not exported"}],
        "exportOptions": export_options,
    }
    (out / "blender-report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({v: {"bytes": r["bytes"], "triangles": r["triangles"]["total"], "materials": r["materialCount"]}
                      for v, r in report_variants.items()}))


if __name__ == "__main__":
    main()
