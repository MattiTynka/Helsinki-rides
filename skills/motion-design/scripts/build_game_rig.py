"""Build a game character from an authoring rig: a plain armature of deform bones (no B-Bones,
constraints or drivers) at the origin, bound to evaluated copies of the visible meshes. Never saves the source.

Bind pose = the source rig's current (default) pose, so the game rest pose matches the studio render.
Bones come from profile["bones"] (name -> parent, "root" for top level) or, when that is absent,
from every deform bone, parented to its nearest deform ancestor.

blender -b --factory-startup --python build_game_rig.py -- --blend /abs/source.blend --profile rig.json
    --output /abs/game.blend --report /abs/game_report.json [--subsurf 0]
"""
import argparse
import difflib
import json
import re
import sys
from pathlib import Path

import bpy
from mathutils import Matrix
from mathutils.bvhtree import BVHTree
from mathutils.interpolate import poly_3d_calc

ap = argparse.ArgumentParser()
ap.add_argument("--blend", required=True)
ap.add_argument("--profile", required=True)
ap.add_argument("--output", required=True)
ap.add_argument("--report", required=True)
ap.add_argument("--subsurf", type=int, default=0, help="subdivision levels baked into the game meshes")
args = ap.parse_args(sys.argv[sys.argv.index("--") + 1:])

prof = json.load(open(args.profile))
SRC = prof["source"]
blend = Path(args.blend).resolve()  # relative paths end up baked into image file paths
bpy.ops.wm.open_mainfile(filepath=str(blend), load_ui=False, use_scripts=False)
scene = bpy.context.scene
src = bpy.data.objects[SRC["rig"]]
GAME_RIG = prof.get("game_rig", "GAME_rig")

# Image paths in authoring files often point at an older location; repoint them at real files (absolute).
SEARCH = [blend.parent / d for d in SRC.get("texture_dirs", ["textures", "../textures"])]
fixed_images = {}
for img in bpy.data.images:
    if img.source not in {"FILE", "TILED"} or not img.filepath:
        continue
    current = Path(bpy.path.abspath(img.filepath).replace("<UDIM>", "1001"))
    if current.exists():
        continue
    name = Path(bpy.path.abspath(img.filepath).replace("\\", "/")).name
    for d in SEARCH:
        if (d / name.replace("<UDIM>", "1001")).exists():
            img.filepath = str((d / name).resolve())
            fixed_images[img.name] = img.filepath
            break

# --- Deform skeleton ------------------------------------------------------------------------
if prof.get("bones"):
    PARENTS = dict(prof["bones"])
else:
    def deform_parent(b):
        p = b.parent
        while p is not None and not p.use_deform:
            p = p.parent
        return p.name if p else "root"
    PARENTS = {b.name: deform_parent(b) for b in src.data.bones if b.use_deform}
missing = [n for n in PARENTS if n not in src.pose.bones]
assert not missing, f"bones missing in source rig: {missing}"
ordered, seen = [], {"root"}
while len(ordered) < len(PARENTS):  # parent before child
    ready = [n for n in PARENTS if n not in seen and PARENTS[n] in seen]
    assert ready, f"bone parents form a cycle or name unknown bones: {set(PARENTS) - seen}"
    for n in ready:
        ordered.append(n)
        seen.add(n)

for ob in bpy.data.objects:
    for m in ob.modifiers:
        if m.type == "SUBSURF":
            m.levels = m.render_levels = args.subsurf
            m.show_viewport = args.subsurf > 0
dg = bpy.context.evaluated_depsgraph_get()
dg.update()
src_eval = src.evaluated_get(dg)
mw = src.matrix_world.copy()
posed = {}
for name in ordered:
    pb = src_eval.pose.bones[name]
    posed[name] = (mw @ pb.matrix, mw @ pb.head, mw @ pb.tail)
bbones = {b.name: b.bbone_segments for b in src.data.bones if b.name in PARENTS and b.bbone_segments > 1}

# --- Meshes bound to the rig -----------------------------------------------------------------
exclude = [re.compile(p) for p in SRC.get("exclude_meshes", [])]
bound = [ob for ob in scene.objects if ob.type == "MESH"
         and any(m.type == "ARMATURE" and m.object == src for m in ob.modifiers)]

# --- Cloth weight source: visible body skin only ------------------------------------------------
CLOTH = prof.get("cloth") or {}
body_full = None
if CLOTH:
    body_src = bpy.data.objects[CLOTH["body"]]
    masks = [m for m in body_src.modifiers if m.type == "MASK"]
    states = [(m.show_viewport, m.show_render) for m in masks]
    for m in masks:
        m.show_viewport = m.show_render = False
    dg.update()
    body_full = bpy.data.meshes.new_from_object(body_src.evaluated_get(dg), preserve_all_data_layers=True, depsgraph=dg)
    body_full.transform(body_src.matrix_world)
    body_full_groups = [vg.name for vg in body_src.vertex_groups]
    # Skin a mask hides under the clothes never renders and its weights are rarely maintained
    # (stale group names, no limb weights), so clothing only takes weights from visible skin.
    hidden = [False] * len(body_full.vertices)
    for m, (shown, _) in zip(masks, states):  # game meshes are evaluated with viewport settings
        if shown and m.invert_vertex_group and m.vertex_group in body_src.vertex_groups:
            gi = body_src.vertex_groups[m.vertex_group].index
            for v in body_full.vertices:
                if any(g.group == gi and g.weight > m.threshold for g in v.groups):
                    hidden[v.index] = True
    for m, (v, r) in zip(masks, states):
        m.show_viewport, m.show_render = v, r
    dg.update()

# --- Game meshes from evaluated geometry ------------------------------------------------------
rename = SRC.get("mesh_rename")  # [old_prefix, new_prefix]
game_meshes, skipped = [], []
for ob in bound:
    if ob.hide_render or any(p.search(ob.name) for p in exclude):
        skipped.append(ob.name)
        continue
    me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg), preserve_all_data_layers=True, depsgraph=dg)
    me.name = (ob.name.replace(rename[0], rename[1], 1) if rename else ob.name) + "_game"
    for i, slot in enumerate(ob.material_slots):  # object-linked materials too
        if i < len(me.materials):
            me.materials[i] = slot.material
        else:
            me.materials.append(slot.material)
    new = bpy.data.objects.new(me.name, me)
    new.matrix_world = Matrix.Identity(4)  # evaluated mesh is in object space; bake object transform
    me.transform(ob.matrix_world)
    game_meshes.append((ob.name, new))  # names: the source objects are removed below

curves = [ob for ob in scene.objects if ob.type == "CURVES" and not ob.hide_render]
curve_world = {ob.name: ob.evaluated_get(dg).matrix_world.copy() for ob in curves}

# --- Stale weight groups: weighted groups that name no bone of the source rig -----------------------
src_bones = set(src.data.bones.keys())
merge = [(re.compile(m["pattern"]), m["into"]) for m in prof.get("merge_groups", [])]
stale = {}
for ob in bound + ([bpy.data.objects[CLOTH["body"]]] if CLOTH else []):
    counts = {}
    modifier_groups = {getattr(m, "vertex_group", "") for m in ob.modifiers}  # masks, smoothing etc.
    for v in ob.data.vertices:
        for g in v.groups:
            if g.weight > 1e-4:
                counts[g.group] = counts.get(g.group, 0) + 1
    for vg in ob.vertex_groups:
        n = vg.name
        if counts.get(vg.index) and n not in src_bones and n not in modifier_groups \
                and not any(p.search(n) for p, _ in merge):
            near = difflib.get_close_matches(n, list(PARENTS), n=1, cutoff=0.85)
            stale.setdefault(ob.name, {})[n] = {"verts": counts[vg.index], "looks_like": near[0] if near else None}

# --- Remove studio rig objects ------------------------------------------------------------------
keep = {n.name for _, n in game_meshes} | {c.name for c in curves}
RIG_NAMES = {src.name, *SRC.get("extra_rig_objects", [])}


def belongs_to_rig(ob):
    p = ob
    while p is not None:
        if p.name in RIG_NAMES or any(m.type == "ARMATURE" for m in getattr(p, "modifiers", [])):
            return True
        p = p.parent
    return False


removed, kept = [], []
for ob in bpy.data.objects:
    if ob.name in keep or ob.type in {"CAMERA", "LIGHT"}:
        kept.append(ob.name)
    elif ob.type in {"ARMATURE", "LATTICE"} or ob.name.startswith("WGT-") or belongs_to_rig(ob) \
            or not ob.users_collection:
        removed.append(ob.name)
    else:
        kept.append(ob.name)
for name in removed:
    bpy.data.objects.remove(bpy.data.objects[name], do_unlink=True)

# --- Game armature ---------------------------------------------------------------------------------
coll = bpy.data.collections.get(GAME_RIG) or bpy.data.collections.new(GAME_RIG)
if coll.name not in scene.collection.children:
    scene.collection.children.link(coll)
arm_data = bpy.data.armatures.new(GAME_RIG)
rig = bpy.data.objects.new(GAME_RIG, arm_data)
coll.objects.link(rig)
bpy.context.view_layer.objects.active = rig
bpy.ops.object.mode_set(mode="EDIT")
eb = arm_data.edit_bones
root = eb.new("root")
root.head, root.tail = (0, 0, 0), (0, 0.25, 0)
root.use_deform = False
for name in ordered:
    m, head, tail = posed[name]
    b = eb.new(name)
    b.head, b.tail = head, tail
    b.align_roll(m.to_3x3().normalized().col[2])
    b.parent = eb[PARENTS[name]]
    b.use_connect = False
    b.use_deform = True
bpy.ops.object.mode_set(mode="OBJECT")
for pb in rig.pose.bones:
    pb.rotation_mode = "QUATERNION"

# Hair curves follow the head bone, keeping their world placement.
head_name = prof.get("retarget", {}).get("head")
if curves and head_name in rig.data.bones:
    head = rig.data.bones[head_name]
    head_world = rig.matrix_world @ head.matrix_local @ Matrix.Translation((0, head.length, 0))
    for ob in curves:
        ob.parent = rig
        ob.parent_type = "BONE"
        ob.parent_bone = head_name
        ob.matrix_basis = Matrix.Identity(4)
        ob.matrix_parent_inverse = head_world.inverted() @ curve_world[ob.name]

# --- Weights: merge groups, drop non-game groups, normalise, limit 4 --------------------------------
GAME = set(PARENTS)


def clean_weights(me, names):
    per_vertex = []
    for v in me.vertices:
        acc = {}
        for g in v.groups:
            n = names[g.group]
            if g.weight <= 0:
                continue
            if n not in GAME:
                n = next((into for p, into in merge if p.search(n)), None)
            if n in GAME:
                acc[n] = acc.get(n, 0) + g.weight
        best = sorted(acc.items(), key=lambda kv: -kv[1])[:4]
        total = sum(w for _, w in best)
        per_vertex.append([(n, w / total) for n, w in best] if total > 0 else [])
    return per_vertex


if body_full is not None:
    body_w = clean_weights(body_full, body_full_groups)
    bvh = BVHTree.FromPolygons([v.co for v in body_full.vertices], [p.vertices[:] for p in body_full.polygons])
    NEAR, FAR = CLOTH.get("near", 0.025), CLOTH.get("far", 0.06)  # metres: body weights inside NEAR, own beyond FAR

    def body_weights_at(co):
        loc, _, face, dist = bvh.find_nearest(co, FAR)
        if loc is None:
            return None, None, 0.0
        vids = body_full.polygons[face].vertices
        bary = poly_3d_calc([body_full.vertices[i].co for i in vids], loc)
        acc, visible = {}, 0.0
        for vi, b in zip(vids, bary):
            visible += 0 if hidden[vi] else b
            for n, w in body_w[vi]:
                acc[n] = acc.get(n, 0) + w * b
        return acc, dist, visible

stats, cloth_stats = {}, {}
for orig, ob in game_meshes:
    coll.objects.link(ob)
    me = ob.data
    per_vertex = clean_weights(me, [vg.name for vg in ob.vertex_groups])
    if body_full is not None and orig in CLOTH["meshes"]:
        moved = 0
        for i, v in enumerate(me.vertices):
            acc, dist, visible = body_weights_at(v.co)
            if acc is None or visible <= 0:
                continue
            k = (1.0 if dist <= NEAR else (FAR - dist) / (FAR - NEAR)) * visible
            mix = {n: w * (1 - k) for n, w in per_vertex[i]}
            for n, w in acc.items():
                mix[n] = mix.get(n, 0) + w * k
            best = sorted(mix.items(), key=lambda kv: -kv[1])[:4]
            total = sum(w for _, w in best)
            if total <= 1e-6:
                continue
            per_vertex[i] = [(n, w / total) for n, w in best]
            moved += 1
        cloth_stats[ob.name] = moved
    for vg in list(ob.vertex_groups):
        ob.vertex_groups.remove(vg)
    groups, unweighted = {}, 0
    for i, ws in enumerate(per_vertex):
        if not ws:
            unweighted += 1
        for n, w in ws:
            if n not in groups:
                groups[n] = ob.vertex_groups.new(name=n)
            groups[n].add([i], w, "REPLACE")
    ob.parent = rig
    mod = ob.modifiers.new("Armature", "ARMATURE")
    mod.object = rig
    stats[ob.name] = {"source": orig, "verts": len(me.vertices), "faces": len(me.polygons),
                      "unweighted": unweighted, "groups": len(groups),
                      "materials": [m.name for m in me.materials if m]}

if body_full is not None:
    bpy.data.meshes.remove(body_full)
scene.frame_start, scene.frame_end = 1, 1
bpy.context.view_layer.update()
bpy.ops.wm.save_as_mainfile(filepath=str(Path(args.output).resolve()), compress=True)
report = {"blender": bpy.app.version_string, "source": str(blend), "game_rig": GAME_RIG, "bones": len(rig.data.bones),
          "deform_bones": sum(b.use_deform for b in rig.data.bones), "meshes": stats, "skipped_meshes": skipped,
          "removed_objects": len(removed), "hair_curves": [c.name for c in curves], "subsurf": args.subsurf,
          "cloth_weight_transfer": cloth_stats, "fixed_images": fixed_images,
          "bbone_bones_flattened": bbones, "stale_weight_groups": stale,
          # the actionable part: weighted groups that look like a renamed game bone (old rig versions)
          "stale_like_game_bones": {m: {n: g["looks_like"] for n, g in gs.items() if g["looks_like"]}
                                    for m, gs in stale.items() if any(g["looks_like"] for g in gs.values())},
          "head_height": max((posed[n][2].z for n in posed), default=0)}
json.dump(report, open(args.report, "w"), indent=1)
print(json.dumps({k: v for k, v in report.items() if k not in ("meshes", "fixed_images")}))
for k, v in stats.items():
    print(k, v["verts"], "unweighted", v["unweighted"], "groups", v["groups"])
