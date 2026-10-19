"""Game-ready humanoid GLB from a Blender Studio CloudRig character (Snow, Rain).

Per content/assets/character.contract.json and docs/asset-pipeline.md. Opens the source .blend read-only,
collects the visible body/clothes/hair meshes at rest, bakes modifiers, decimates to budget, bakes the
shader base colour of each material group to one small texture (Cycles DIFFUSE colour, CPU), rebinds the
vertex weights of the CloudRig DEF-* bones to a new 22-joint game armature positioned from those bones,
authors the ten contract clips procedurally (game_motion.py), adds the two sockets and exports a GLB.
Never saves the source file; intermediate files go under --out only.

  blender --background --factory-startup --disable-autoexec --python build_game_character.py -- \
      --source models/Snow_v4.2/Snow/snow_v4.2.blend --variant snow \
      --contract content/assets/character.contract.json --out data/work/m0/blender-character
"""
import argparse
import datetime
import hashlib
import json
import math
import re
import struct
import sys
import time
from pathlib import Path

import bmesh
import bpy
from mathutils import Matrix, Quaternion, Vector

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
import game_motion as gm  # noqa: E402
import release_pin  # noqa: E402

release_pin.require()

DEG = math.pi / 180.0
T0 = time.time()


def log(*parts):
    print(f"[{time.time() - T0:7.1f}s]", *parts, flush=True)


def srgb_to_linear(c):
    return tuple(x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c)


# --- Variant configuration ---------------------------------------------------------------------------------
# parts: (source object, material group, target triangles, options)
# joints: game joint -> (bone whose head is the joint, bone whose tail ends it); "{s}" is the side suffix.
# rules: (regex on the vertex-group name, joint; "{Side}" from the .L/.R suffix). Unmatched DEF groups fall
# back to the nearest game joint segment of the source bone's position.
VARIANTS = {
    "snow": {
        "id": "character-snow", "role": "player", "budget": "player", "rig": "RIG-Snow", "eyes": "GEO-snow-eyes",
        "head_mesh": "GEO-snow-head",
        "parts": [
            ("GEO-snow-head", "skin", 6000, {}),
            ("GEO-snow-body", "skin", 4200, {}),
            ("GEO-snow-shirt", "clothes", 3000, {}),
            ("GEO-snow-pants", "clothes", 3400, {}),
            ("GEO-snow-shoes_base", "clothes", 2000, {}),
            ("GEO-snow-shoes_bottom", "clothes", 800, {}),
            ("GEO-snow-shoes_parts", "clothes", 1400, {}),
            ("GEO-snow-hair_base", "hair", 4300, {}),
            ("GEO-snow-eyebrows", "hair", 400, {}),
            ("GEO-snow-eyes", "eyes", 700, {}),
        ],
        "textures": {"skin": 1024, "clothes": 1024, "hair": 512, "eyes": 256},
        "joints": {
            "Spine": ("DEF-Spine", "DEF-Spine"), "Spine1": ("DEF-RibCage", "DEF-RibCage"), "Spine2": ("DEF-Chest", "DEF-Chest"),
            "Neck": ("DEF-Neck", "DEF-Neck"), "Head": ("DEF-Head", "DEF-Head"),
            "{S}Shoulder": ("DEF-Shoulder.{s}", "DEF-Shoulder.{s}"), "{S}Arm": ("DEF-UpperArm_1.{s}", "DEF-UpperArm_2.{s}"),
            "{S}ForeArm": ("DEF-Forearm_1.{s}", "DEF-Forearm_2.{s}"), "{S}Hand": ("DEF-Wrist.{s}", "DEF-Wrist.{s}"),
            "{S}UpLeg": ("DEF-Thigh_1.{s}", "DEF-Thigh_2.{s}"), "{S}Leg": ("DEF-Knee_1.{s}", "DEF-Knee_2.{s}"),
            "{S}Foot": ("DEF-Foot.{s}", "DEF-Foot.{s}"), "{S}ToeBase": ("DEF-Toes.{s}", "DEF-Toes.{s}"),
        },
        "rules": [
            (r"^DEF-Spine$", "Spine"), (r"^DEF-RibCage$", "Spine1"), (r"^DEF-Chest$", "Spine2"), (r"^DEF-Neck$", "Neck"),
            (r"^DEF-(Head|Ponytail\d*|Eye.*|Teeth.*|Tongue\d*)$", "Head"),
            (r"^DEF-(Hips|Hip_Center)$", "Hips"), (r"^DEF-Hips\.(L|R)$", "Hips"),
            (r"^DEF-Shoulder\.(L|R)$", "{Side}Shoulder"), (r"^DEF-UpperArm_?\d\.(L|R)$", "{Side}Arm"),
            (r"^DEF-Forearm_?\d\.(L|R)$", "{Side}ForeArm"), (r"^DEF-(Wrist|Finger_.*)\.(L|R)$", "{Side}Hand"),
            (r"^DEF-Thigh_?\d\.(L|R)$", "{Side}UpLeg"), (r"^DEF-Knee_?\d\.(L|R)$", "{Side}Leg"),
            (r"^DEF-Foot\.(L|R)$", "{Side}Foot"), (r"^DEF-Toes\.(L|R)$", "{Side}ToeBase"),
        ],
        "tints": {}, "double_sided": [],
    },
    "rain": {
        "id": "character-rain", "role": "officer", "budget": "npc", "rig": "RIG-rain", "eyes": "GEO-rain-eyes",
        "head_mesh": "GEO-rain-head",
        "parts": [
            ("GEO-rain-head", "skin", 3200, {}),
            ("GEO-rain-body", "skin", 3200, {"mask_out": ["mask_legs"]}),
            ("GEO-rain-eyebrows", "skin", 260, {}),
            ("GEO-rain-top", "clothes", 1500, {"disable": ["SOLIDIFY"]}),
            ("GEO-rain-jeans", "clothes", 2000, {}),
            ("GEO-rain-shoes", "clothes", 1200, {}),
            ("GEO-rain-hair_main", "hair", 1500, {}),
            ("GEO-rain-eyes", "eyes", 500, {}),
        ],
        "textures": {"skin": 512, "clothes": 512, "hair": 256, "eyes": 128},
        "joints": {
            "Spine": ("DEF-Spine1", "DEF-Spine1"), "Spine1": ("DEF-Spine2", "DEF-Spine2"), "Spine2": ("DEF-Spine3", "DEF-Spine3"),
            "Neck": ("DEF-Neck", "DEF-Neck"), "Head": ("DEF-Head", "DEF-Head"),
            "{S}Shoulder": ("DEF-Clavicle.{s}", "DEF-Clavicle.{s}"), "{S}Arm": ("DEF-Upperarm1.{s}", "DEF-Upperarm2.{s}"),
            "{S}ForeArm": ("DEF-Forearm1.{s}", "DEF-Forearm2.{s}"), "{S}Hand": ("DEF-Hand.{s}", "DEF-Hand.{s}"),
            "{S}UpLeg": ("DEF-Thigh1.{s}", "DEF-Thigh2.{s}"), "{S}Leg": ("DEF-Shin1.{s}", "DEF-Shin2.{s}"),
            "{S}Foot": ("DEF-Foot.{s}", "DEF-Foot.{s}"), "{S}ToeBase": ("DEF-Toe.{s}", "DEF-Toe.{s}"),
        },
        "rules": [
            (r"^DEF-Spine1$", "Spine"), (r"^DEF-Spine2$", "Spine1"), (r"^DEF-Spine3$", "Spine2"), (r"^DEF-Neck$", "Neck"),
            (r"^DEF-(Head|Head_Top|Hair_.*|Eye.*|Teeth.*|Tongue.*)$", "Head"),
            (r"^DEF-(Pelvis|COR-Hip_.*)$", "Hips"),
            (r"^DEF-(COR-)?Clavicle(_Front)?\.(L|R)$", "{Side}Shoulder"), (r"^DEF-(COR-)?Upperarm.*\.(L|R)$", "{Side}Arm"),
            (r"^DEF-(COR-)?Forearm.*\.(L|R)$", "{Side}ForeArm"),
            (r"^DEF-(COR-)?(HLP-)?(Hand|Index\d|Middle\d|Ring\d|Pinky\d|Thumb.*)\.(L|R)$", "{Side}Hand"),
            (r"^DEF-(COR-)?Thigh.*\.(L|R)$", "{Side}UpLeg"), (r"^DEF-(COR-)?Shin.*\.(L|R)$", "{Side}Leg"),
            (r"^DEF-(COR-Ankle.*|Foot)\.(L|R)$", "{Side}Foot"), (r"^DEF-Toe\.(L|R)$", "{Side}ToeBase"),
            (r"^DEF-Scarf\d$", "Spine2"),
        ],
        # Uniform: lighter blue shirt (Rain's only upper garment is a sleeveless top), dark blue trousers,
        # and the orange sneakers (with socks and laces) tinted to dark boots.
        "tints": {"GEO-rain-top": (0.35, 0.50, 0.75), "GEO-rain-jeans": (0.10, 0.14, 0.30), "GEO-rain-shoes": (0.11, 0.11, 0.12)},
        "double_sided": ["clothes"],
    },
}
GROUP_ORDER = ["skin", "clothes", "hair", "eyes"]


# --- Source handling ------------------------------------------------------------------------------------------

def capture_bones(rig):
    mw = rig.matrix_world
    return {b.name: {"head": mw @ b.head_local, "tail": mw @ b.tail_local, "parent": b.parent.name if b.parent else None,
                     "deform": b.use_deform} for b in rig.data.bones}


def world_bounds(obj):
    pts = [obj.matrix_world @ Vector(c) for c in obj.bound_box]
    return Vector([min(p[i] for p in pts) for i in range(3)]), Vector([max(p[i] for p in pts) for i in range(3)])


def show_object(obj):
    """Make an object evaluable: unhide it and every collection it sits in (view layer and collection flags)."""
    obj.hide_viewport = False
    obj.hide_render = False
    for coll in obj.users_collection:
        coll.hide_viewport = False
        coll.hide_render = False

    def unhide_chain(lc, target):
        """Unhide the layer collection holding `target` and every layer collection above it."""
        hit = lc.collection == target
        for c in lc.children:
            hit = unhide_chain(c, target) or hit
        if hit:
            lc.exclude = False
            lc.hide_viewport = False
        return hit
    for coll in obj.users_collection:
        unhide_chain(bpy.context.view_layer.layer_collection, coll)
    try:
        obj.hide_set(False)
    except RuntimeError:
        pass


def prepare_source(cfg):
    for rig in (o for o in bpy.data.objects if o.type == "ARMATURE"):
        rig.data.pose_position = "REST"
    for name, group, target, opts in cfg["parts"]:
        obj = bpy.data.objects[name]
        show_object(obj)
        keys = obj.data.shape_keys
        if keys:
            for kb in keys.key_blocks[1:]:
                kb.mute = True
                kb.value = 0.0
        # Mirror modifiers flip .L/.R weights only when the counterpart group exists.
        names = {g.name for g in obj.vertex_groups}
        for g in list(names):
            for a, b in ((".L", ".R"), (".R", ".L")):
                if g.endswith(a) and g[:-2] + b not in names:
                    obj.vertex_groups.new(name=g[:-2] + b)
        # Studio files drive modifier settings (subdivision levels, masks) from rig properties: drop those
        # drivers so the values set here are the ones evaluated.
        if obj.animation_data:
            for fc in list(obj.animation_data.drivers):
                if fc.data_path.startswith("modifiers["):
                    obj.animation_data.drivers.remove(fc)
        for m in list(obj.modifiers):
            if m.type == "SUBSURF":
                level = opts.get("subsurf", 0)
                if level == 0:
                    obj.modifiers.remove(m)
                    continue
                m.levels = level
            if m.type in opts.get("disable", ()):
                m.show_viewport = False
        for vg in opts.get("mask_out", ()):
            if vg in obj.vertex_groups:
                m = obj.modifiers.new(f"mask_out_{vg}", "MASK")
                m.vertex_group = vg
                m.invert_vertex_group = True
    bpy.context.view_layer.update()


def evaluated_mesh(obj):
    dg = bpy.context.evaluated_depsgraph_get()
    ev = obj.evaluated_get(dg)
    return bpy.data.meshes.new_from_object(ev, preserve_all_data_layers=True, depsgraph=dg)


def triangles(me):
    return sum(len(p.vertices) - 2 for p in me.polygons)


def extract_part(name, group, target, opts, collection):
    src = bpy.data.objects[name]
    me = evaluated_mesh(src)
    me.transform(src.matrix_world)
    me.name = f"GAME_{name}"
    # Materials live on the object slots for some source objects; copy per part so baking can edit them.
    me.materials.clear()
    for slot in src.material_slots:
        me.materials.append(slot.material.copy() if slot.material else None)
    obj = bpy.data.objects.new(f"GAME_{name}", me)
    collection.objects.link(obj)
    # Vertex group names travel with the mesh data (Blender 3.0+), so the new object already has them.
    if {g.name for g in obj.vertex_groups} != {g.name for g in src.vertex_groups}:
        raise RuntimeError(f"{name}: vertex groups did not survive evaluation")
    part = {"source": name, "group": group, "target": target, "obj": obj, "sourceTriangles": triangles(me),
            "sourceVertices": len(me.vertices), "options": opts}
    log(f"extracted {name}: {len(me.vertices)} verts, {triangles(me)} tris, {len(me.materials)} materials")
    return part


def delete_everything_but(keep_objects):
    keep = {o.name for o in keep_objects}
    for o in list(bpy.data.objects):
        if o.name not in keep:
            bpy.data.objects.remove(o, do_unlink=True)
    for coll in list(bpy.data.collections):
        if not any(o.name in keep for o in coll.all_objects):
            bpy.data.collections.remove(coll)
    purge()


def purge():
    for _ in range(3):
        bpy.data.orphans_purge(do_local_ids=True, do_linked_ids=True, do_recursive=True)


def replace_mesh(obj, new_me):
    old = obj.data
    mats = list(old.materials)
    obj.data = new_me
    new_me.materials.clear()
    for m in mats:
        new_me.materials.append(m)
    obj.modifiers.clear()
    bpy.data.meshes.remove(old)


def decimate_to(part):
    obj, target = part["obj"], part["target"]
    current = triangles(obj.data)
    if current <= target:
        part["decimateRatio"] = 1.0
        return
    ratio = target / current
    mod = obj.modifiers.new("decimate", "DECIMATE")
    mod.decimate_type = "COLLAPSE"
    mod.ratio = ratio
    mod.use_collapse_triangulate = True
    part["decimateRatio"] = round(ratio, 4)
    me = evaluated_mesh(obj)
    me.name = obj.data.name
    replace_mesh(obj, me)
    log(f"decimated {part['source']}: {current} -> {triangles(me)} tris (ratio {ratio:.3f})")


# --- Joints and weights ---------------------------------------------------------------------------------------

def compute_joints(cfg, bones):
    """Game joint rest heads/tails (armature space) from the source DEF bones."""
    out = {}
    for key, (hb, tb) in cfg["joints"].items():
        sides = [("Left", "L"), ("Right", "R")] if "{S}" in key else [("", "")]
        for S, s in sides:
            name = key.replace("{S}", S)
            h, t = bones[hb.replace("{s}", s)], bones[tb.replace("{s}", s)]
            out[name] = (Vector(h["head"]), Vector(t["tail"]))
    spine = out["Spine"][0]
    thigh = out["LeftUpLeg"][0]
    hips = Vector((0.0, spine.y, (spine.z + thigh.z) / 2))
    out["Hips"] = (hips, hips + Vector((0.0, 0.0, 0.1)))
    return out


def side_of(name):
    return "Left" if name.endswith(".L") else "Right" if name.endswith(".R") else None


def seg_distance(p, a, b):
    ab = b - a
    t = 0.0 if ab.length_squared < 1e-12 else max(0.0, min(1.0, (p - a).dot(ab) / ab.length_squared))
    return (p - (a + ab * t)).length


def nearest_joint(p, joints, side=None):
    best, best_d = None, 1e9
    for j, (h, t) in joints.items():
        js = "Left" if j.startswith("Left") else "Right" if j.startswith("Right") else None
        if side and js and js != side:
            continue
        d = seg_distance(p, h, t)
        if d < best_d:
            best, best_d = j, d
    return best


def resolve_group(name, cfg, bones, joints, cache):
    if name in cache:
        return cache[name]
    joint = None
    for pattern, template in cfg["rules"]:
        if re.match(pattern, name):
            joint = template.replace("{Side}", side_of(name) or "")
            break
    if joint is None and name.startswith("DEF-") and name in bones:
        b = bones[name]
        mid = (Vector(b["head"]) + Vector(b["tail"])) / 2
        joint = "Head" if mid.z > joints["Neck"][0].z else nearest_joint(mid, joints, side_of(name))
    cache[name] = joint
    return joint


def map_weights(part, cfg, bones, joints, cache):
    obj = part["obj"]
    me = obj.data
    names = {g.index: g.name for g in obj.vertex_groups}
    resolved = {i: resolve_group(n, cfg, bones, joints, cache) for i, n in names.items()}
    weights, unweighted, dropped = [], 0, {}
    for v in me.vertices:
        acc = {}
        for g in v.groups:
            if g.weight <= 1e-5:
                continue
            j = resolved.get(g.group)
            if j is None:
                dropped[names[g.group]] = dropped.get(names[g.group], 0) + 1
                continue
            acc[j] = acc.get(j, 0.0) + g.weight
        if sum(acc.values()) < 1e-3:
            unweighted += 1
            acc = {nearest_joint(v.co, joints): 1.0}
        keep = sorted(acc.items(), key=lambda kv: -kv[1])[:4]
        total = sum(w for _, w in keep)
        weights.append([(j, w / total) for j, w in keep])
    for g in list(obj.vertex_groups):
        obj.vertex_groups.remove(g)
    groups = {j: obj.vertex_groups.new(name=j) for j in gm.JOINTS}
    for vi, ws in enumerate(weights):
        for j, w in ws:
            groups[j].add([vi], w, "REPLACE")
    part["weights"] = {"unweightedFallback": unweighted,
                       "mapping": {n: resolved[i] for i, n in names.items() if resolved[i] is not None},
                       "ignoredGroups": sorted(n for i, n in names.items() if resolved[i] is None)}
    log(f"weights {part['source']}: {len(me.vertices)} verts, {unweighted} fallback, "
        f"{len(part['weights']['mapping'])} groups mapped, {len(part['weights']['ignoredGroups'])} ignored")


# --- UV packing and baking --------------------------------------------------------------------------------------

def uv_islands(me, layer):
    polys = me.polygons
    parent = list(range(len(polys)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    data, loops, seen = layer.data, me.loops, {}
    for p in polys:
        for li in p.loop_indices:
            uv = data[li].uv
            key = (loops[li].vertex_index, round(uv.x * 2e4), round(uv.y * 2e4))
            f = seen.get(key)
            if f is None:
                seen[key] = p.index
            else:
                union(f, p.index)
    islands = {}
    for p in polys:
        islands.setdefault(find(p.index), []).append(p.index)
    out = []
    for faces in islands.values():
        lo, hi = Vector((1e9, 1e9)), Vector((-1e9, -1e9))
        for fi in faces:
            for li in polys[fi].loop_indices:
                uv = data[li].uv
                lo.x, lo.y = min(lo.x, uv.x), min(lo.y, uv.y)
                hi.x, hi.y = max(hi.x, uv.x), max(hi.y, uv.y)
        out.append({"faces": faces, "min": lo, "size": Vector((max(hi.x - lo.x, 1e-4), max(hi.y - lo.y, 1e-4)))})
    return out


def shelf_pack(items, scale, margin):
    """Place rects (w, h) scaled by `scale` on shelves inside the unit square; returns origins or None."""
    x = y = shelf = 0.0
    origins = []
    for w, h in items:
        w, h = w * scale + margin, h * scale + margin
        if x + w > 1.0 + 1e-9:
            y += shelf
            x = shelf = 0.0
        if y + h > 1.0 + 1e-9:
            return None
        origins.append((x + margin / 2, y + margin / 2))
        x += w
        shelf = max(shelf, h)
    return origins


def pack_group_uvs(objs, size, px_margin=3):
    """New 'UVBake' layer on every object of a group: all source islands (any UDIM tile) packed into 0..1."""
    entries = []
    for obj in objs:
        me = obj.data
        # Image textures without an explicit UV Map node sample the render-active layer: pack that one.
        src = next((l for l in me.uv_layers if l.active_render), me.uv_layers[0])
        for layer in me.uv_layers:
            layer.active_render = layer == src
        for isl in uv_islands(me, src):
            entries.append((obj, src.name, isl))
    entries.sort(key=lambda e: -e[2]["size"].y)
    rects = [(e[2]["size"].x, e[2]["size"].y) for e in entries]
    margin = px_margin / size
    area = sum(w * h for w, h in rects)
    lo, hi, best = 0.0, 1.2 / math.sqrt(max(area, 1e-9)), None
    for _ in range(28):
        mid = (lo + hi) / 2
        placed = shelf_pack(rects, mid, margin)
        if placed is None:
            hi = mid
        else:
            lo, best = mid, (mid, placed)
    if best is None:
        raise RuntimeError("UV packing failed")
    scale, origins = best
    per_obj = {}
    for (obj, src_name, isl), origin in zip(entries, origins):
        per_obj.setdefault(obj.name, []).append((src_name, isl, origin))
    for obj in objs:
        me = obj.data
        bake = me.uv_layers.new(name="UVBake")
        for src_name, isl, origin in per_obj.get(obj.name, []):
            src = me.uv_layers[src_name].data
            for fi in isl["faces"]:
                for li in me.polygons[fi].loop_indices:
                    uv = src[li].uv
                    bake.data[li].uv = ((uv.x - isl["min"].x) * scale + origin[0], (uv.y - isl["min"].y) * scale + origin[1])
        # Textures sample through the render-active source layer; the bake writes through the active layer.
        src_name = per_obj[obj.name][0][0] if per_obj.get(obj.name) else me.uv_layers[0].name
        me.uv_layers[src_name].active_render = True
        me.uv_layers.active = me.uv_layers["UVBake"]
    log(f"packed {len(entries)} islands of {len(objs)} objects at scale {scale:.4f} (area use {area * scale * scale:.2f})")
    return scale


def inject_tint(mat, tint):
    """Replace a material's base colour with tint x (0.7 + 0.9 x luminance of the original)."""
    nt = mat.node_tree
    for node in [n for n in nt.nodes if n.type == "BSDF_PRINCIPLED"]:
        inp = node.inputs["Base Color"]
        if inp.links:
            link = inp.links[0]
            src = link.from_socket
            nt.links.remove(link)
        else:
            rgb = nt.nodes.new("ShaderNodeRGB")
            rgb.outputs[0].default_value = inp.default_value
            src = rgb.outputs[0]
        bw = nt.nodes.new("ShaderNodeRGBToBW")
        nt.links.new(src, bw.inputs["Color"])
        mad = nt.nodes.new("ShaderNodeMath")
        mad.operation = "MULTIPLY_ADD"
        mad.inputs[1].default_value = 0.9
        mad.inputs[2].default_value = 0.7
        nt.links.new(bw.outputs[0], mad.inputs[0])
        mix = nt.nodes.new("ShaderNodeMix")
        mix.data_type = "RGBA"
        mix.blend_type = "MULTIPLY"
        mix.inputs[0].default_value = 1.0
        a = [s for s in mix.inputs if s.name == "A" and s.type == "RGBA"][0]
        b = [s for s in mix.inputs if s.name == "B" and s.type == "RGBA"][0]
        a.default_value = (*srgb_to_linear(tint), 1.0)
        nt.links.new(mad.outputs[0], b)
        result = [s for s in mix.outputs if s.name == "Result" and s.type == "RGBA"][0]
        nt.links.new(result, inp)


def bake_group(group, parts, size, out_dir, tints, skip, asset_id):
    objs = [p["obj"] for p in parts]
    img = bpy.data.images.new(f"{asset_id}-{group}", size, size, alpha=False)
    img.generated_color = (0.5, 0.5, 0.5, 1.0)
    img.colorspace_settings.name = "sRGB"
    for p in parts:
        tint = tints.get(p["source"])
        for mat in p["obj"].data.materials:
            if mat is None:
                continue
            if not mat.use_nodes:
                mat.use_nodes = True
            if tint:
                inject_tint(mat, tint)
            node = mat.node_tree.nodes.new("ShaderNodeTexImage")
            node.image = img
            mat.node_tree.nodes.active = node
    scene = bpy.context.scene
    if not skip:
        scene.render.engine = "CYCLES"
        scene.cycles.device = "CPU"
        scene.cycles.samples = 4
        scene.cycles.use_adaptive_sampling = False
        scene.cycles.use_denoising = False
        bake = scene.render.bake
        bake.use_pass_direct = bake.use_pass_indirect = False
        bake.use_pass_color = True
        bake.use_selected_to_active = False
        bake.target = "IMAGE_TEXTURES"
        bake.margin = 6
        bake.margin_type = "EXTEND"
        for o in bpy.data.objects:
            o.hide_render = o not in objs
            o.select_set(o in objs)
        bpy.context.view_layer.objects.active = objs[0]
        with bpy.context.temp_override(selected_objects=objs, selected_editable_objects=objs, active_object=objs[0], object=objs[0]):
            result = bpy.ops.object.bake(type="DIFFUSE", pass_filter={"COLOR"}, margin=6, margin_type="EXTEND",
                                         use_clear=False, use_selected_to_active=False, target="IMAGE_TEXTURES",
                                         save_mode="INTERNAL", uv_layer="UVBake")
        if "FINISHED" not in result:
            raise RuntimeError(f"bake of {group} failed: {result}")
        for o in bpy.data.objects:
            o.hide_render = False
    tex_dir = out_dir.resolve() / "textures"
    tex_dir.mkdir(exist_ok=True)
    path = tex_dir / f"{img.name}.png"
    img.filepath_raw = str(path)  # Blender resolves relative paths itself: always hand it absolute ones
    img.file_format = "PNG"
    img.save()
    if not path.exists():
        raise RuntimeError(f"could not write {path}")
    img.source = "FILE"
    img.filepath = str(path)
    img.reload()
    img.colorspace_settings.name = "sRGB"
    log(f"baked {group}: {size}px -> {path.name}")
    return img


def game_material(name, img, roughness=0.8, double_sided=False):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    bsdf.inputs["Metallic"].default_value = 0.0
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Specular IOR Level"].default_value = 0.3
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = img
    nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    mat.use_backface_culling = not double_sided
    return mat


def finalize_part_mesh(part, materials, group_index):
    """One material slot layout shared by all parts (so a bmesh join keeps indices), one UV layer, no colours."""
    me = part["obj"].data
    for layer in [l for l in me.uv_layers if l.name != "UVBake"]:
        me.uv_layers.remove(layer)
    me.uv_layers[0].name = "UVMap"
    me.uv_layers[0].active_render = True
    for attr in list(me.color_attributes):
        me.color_attributes.remove(attr)
    me.materials.clear()
    for g in GROUP_ORDER:
        me.materials.append(materials[g])
    gi = group_index[part["group"]]
    for p in me.polygons:
        p.material_index = gi
        p.use_smooth = True


def join_parts(parts, materials, name):
    bm = bmesh.new()
    for part in parts:
        bm.from_mesh(part["obj"].data)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for g in GROUP_ORDER:
        me.materials.append(materials[g])
    obj = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(obj)
    for j in gm.JOINTS:
        obj.vertex_groups.new(name=j)
    for part in parts:
        bpy.data.objects.remove(part["obj"], do_unlink=True)
    return obj


# --- Armature, binding, sockets, clips ------------------------------------------------------------------------

def build_armature(name, joints):
    data = bpy.data.armatures.new(name)
    rig = bpy.data.objects.new(name, data)
    bpy.context.scene.collection.objects.link(rig)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode="EDIT")
    for j in gm.JOINTS:
        eb = data.edit_bones.new(j)
        eb.head, eb.tail = joints[j]
        eb.roll = 0.0
        eb.use_deform = True
        if gm.PARENT[j]:
            eb.parent = data.edit_bones[gm.PARENT[j]]
            eb.use_connect = False
    bpy.ops.object.mode_set(mode="OBJECT")
    for pb in rig.pose.bones:
        pb.rotation_mode = "QUATERNION"
    return rig


def bind(mesh_obj, rig):
    mesh_obj.parent = rig
    mod = mesh_obj.modifiers.new("Armature", "ARMATURE")
    mod.object = rig
    me = mesh_obj.data
    groups = {g.index: g.name for g in mesh_obj.vertex_groups}
    bad, over = 0, 0
    for v in me.vertices:
        ws = [(groups[g.group], g.weight) for g in v.groups if g.weight > 1e-6]
        if abs(sum(w for _, w in ws) - 1.0) > 1e-3 or not ws:
            bad += 1
        if len(ws) > 4:
            over += 1
    if bad or over:
        raise RuntimeError(f"binding: {bad} vertices without normalised weights, {over} with more than 4 influences")


def set_action(rig, action):
    """Assign an action (or None). Blender 5.x can crash if an armature's action changes before its pose was
    evaluated, so evaluate the view layer first."""
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


def pose_bases(rig, Q, H):
    posed, out = {}, {}
    for bone in rig.data.bones:
        m = (Matrix(Q[bone.name]) @ bone.matrix_local.to_3x3()).to_4x4()
        m.translation = Vector(H[bone.name])
        posed[bone.name] = m
        if bone.parent is None:
            out[bone.name] = bone.matrix_local.inverted() @ m
        else:
            rel = bone.parent.matrix_local.inverted() @ bone.matrix_local
            out[bone.name] = rel.inverted() @ posed[bone.parent.name].inverted() @ m
    return out


def rest_pose(rig):
    for pb in rig.pose.bones:
        pb.rotation_quaternion = (1.0, 0.0, 0.0, 0.0)
        pb.location = (0.0, 0.0, 0.0)


def bake_clips(rig, skel, contract):
    clips_obj = gm.Clips(skel)
    clips, gaits = clips_obj.specs()
    declared = {c["name"]: c for c in contract["clips"]}
    summary, actions, deviations = {}, {}, []
    for name in [c["name"] for c in contract["clips"]]:
        frames, loop, _ = clips[name]
        poses, diags = gm.bake(skel, clips, name)
        action = bpy.data.actions.new(name)
        action.slots.new(id_type="OBJECT", name=rig.name)
        set_action(rig, action)
        previous, drift = {}, 0.0
        for f, (Q, H) in enumerate(poses):
            for bone_name, basis in pose_bases(rig, Q, H).items():
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
                    drift = max(drift, basis.translation.length)
        if drift > 1e-4:
            raise RuntimeError(f"{name}: child joint heads drift {drift:.6f} m from their parents")
        linear_keys(action)
        action.use_fake_user = True
        action.use_frame_range = True
        action.frame_start, action.frame_end = 0, frames
        actions[name] = action
        seconds = frames / gm.FPS
        want = declared[name]
        entry = {"frames": [0, frames], "fps": gm.FPS, "seconds": round(seconds, 4), "loop": loop,
                 "contractSeconds": want["seconds"], "movementSpeed": want["movementSpeed"],
                 "maxLegReach": round(max(max(d["legReach"].values()) for d in diags), 4),
                 "maxArmReach": round(max([max(d["armReach"].values()) for d in diags if d["armReach"]] or [0.0]), 4)}
        if abs(seconds - want["seconds"]) > 1e-6:
            deviations.append(f"clip {name}: {seconds:.4f} s ({frames} frames at 30 fps) instead of {want['seconds']} s")
        if loop != want["loop"]:
            deviations.append(f"clip {name}: loop {loop} differs from the contract")
        if name in gaits:
            g = gaits[name]
            entry.update({"stride": round(g.v * g.cycle, 4), "duty": g.beta,
                          "hipsHeight": [round(min(g.height), 4), round(max(g.height), 4)]})
        summary[name] = entry
    set_action(rig, None)
    rest_pose(rig)
    return actions, summary, clips, deviations


def add_socket(rig, name, bone, matrix_world):
    empty = bpy.data.objects.new(name, None)
    empty.empty_display_type = "ARROWS"
    empty.empty_display_size = 0.05
    bpy.context.scene.collection.objects.link(empty)
    empty.parent = rig
    empty.parent_type = "BONE"
    empty.parent_bone = bone
    bpy.context.view_layer.update()
    empty.matrix_world = matrix_world
    bpy.context.view_layer.update()
    return empty


# --- GLB read-back -------------------------------------------------------------------------------------------

def image_size(data):
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return list(struct.unpack(">II", data[16:24]))
    if data[:2] == b"\xff\xd8":
        i = 2
        while i + 9 < len(data):
            if data[i] != 0xFF:
                return None
            marker = data[i + 1]
            if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
                h, w = struct.unpack(">HH", data[i + 5:i + 9])
                return [w, h]
            i += 2 + struct.unpack(">H", data[i + 2:i + 4])[0]
    return None


def read_glb(path):
    raw = path.read_bytes()
    magic, version, length = struct.unpack("<III", raw[:12])
    if magic != 0x46546C67 or version != 2:
        raise RuntimeError("not a GLB 2")
    offset, doc, binary = 12, None, b""
    while offset < length:
        clen, ctype = struct.unpack("<II", raw[offset:offset + 8])
        chunk = raw[offset + 8:offset + 8 + clen]
        if ctype == 0x4E4F534A:
            doc = json.loads(chunk.decode("utf-8"))
        elif ctype == 0x004E4942:
            binary = chunk
        offset += 8 + clen
    return doc, binary, raw


def node_world_matrices(doc):
    nodes = doc.get("nodes", [])
    parent = {}
    for i, n in enumerate(nodes):
        for c in n.get("children", []):
            parent[c] = i
    cache = {}

    def local(i):
        n = nodes[i]
        if "matrix" in n:
            m = n["matrix"]
            return Matrix([[m[0], m[4], m[8], m[12]], [m[1], m[5], m[9], m[13]], [m[2], m[6], m[10], m[14]], [m[3], m[7], m[11], m[15]]])
        t = Matrix.Translation(Vector(n.get("translation", [0, 0, 0])))
        q = n.get("rotation", [0, 0, 0, 1])
        r = Quaternion((q[3], q[0], q[1], q[2])).to_matrix().to_4x4()
        s = Matrix.Diagonal(Vector(n.get("scale", [1, 1, 1])).to_4d())
        return t @ r @ s

    def world(i):
        if i not in cache:
            cache[i] = (world(parent[i]) @ local(i)) if i in parent else local(i)
        return cache[i]
    return {i: world(i) for i in range(len(nodes))}, parent


def glb_summary(path):
    doc, binary, raw = read_glb(path)
    nodes = doc.get("nodes", [])
    worlds, parent = node_world_matrices(doc)
    accessors, views = doc.get("accessors", []), doc.get("bufferViews", [])
    name_of = lambda i: nodes[i].get("name", f"#{i}")
    skins = doc.get("skins", [])
    joints = []
    if skins:
        for j in skins[0]["joints"]:
            joints.append({"name": name_of(j), "parent": name_of(parent[j]) if j in parent and parent[j] in skins[0]["joints"] else None,
                           "restWorldPosition": [round(c, 5) for c in worlds[j].translation]})
    tris, lo, hi = 0, Vector((1e9,) * 3), Vector((-1e9,) * 3)
    for i, n in enumerate(nodes):
        if "mesh" not in n:
            continue
        for prim in doc["meshes"][n["mesh"]]["primitives"]:
            if "indices" in prim:
                tris += accessors[prim["indices"]]["count"] // 3
            acc = accessors[prim["attributes"]["POSITION"]]
            for corner in ((acc["min"][0], acc["min"][1], acc["min"][2]), (acc["max"][0], acc["max"][1], acc["max"][2])):
                p = Vector(corner)  # skinned mesh: bind pose coordinates are already in armature space
                lo, hi = Vector(map(min, lo, p)), Vector(map(max, hi, p))
    images = []
    for img in doc.get("images", []):
        if "bufferView" in img:
            v = views[img["bufferView"]]
            data = binary[v.get("byteOffset", 0):v.get("byteOffset", 0) + v["byteLength"]]
            images.append({"name": img.get("name"), "mimeType": img.get("mimeType"), "bytes": v["byteLength"], "size": image_size(data)})
    anims = []
    for a in doc.get("animations", []):
        duration = max(accessors[s["input"]]["max"][0] for s in a["samplers"])
        anims.append({"name": a.get("name"), "seconds": round(duration, 4), "channels": len(a["channels"])})
    sockets = []
    for i, n in enumerate(nodes):
        if n.get("name", "").startswith("SOCKET_"):
            w = worlds[i]
            sockets.append({"node": n["name"], "parent": name_of(parent[i]) if i in parent else None,
                            "translation": n.get("translation", [0, 0, 0]), "rotation": n.get("rotation", [0, 0, 0, 1]),
                            "restWorldPosition": [round(c, 5) for c in w.translation],
                            "restWorldAxes": {"x": [round(c, 4) for c in w.col[0][:3]], "y": [round(c, 4) for c in w.col[1][:3]],
                                              "z": [round(c, 4) for c in w.col[2][:3]]}})
    return {"bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest(), "generator": doc.get("asset", {}).get("generator"),
            "nodes": len(nodes), "triangles": tris, "materials": len(doc.get("materials", [])),
            "materialNames": [m.get("name") for m in doc.get("materials", [])], "images": images,
            "skins": len(skins), "joints": joints, "jointCount": len(joints),
            "meshBounds": {"min": [round(c, 4) for c in lo], "max": [round(c, 4) for c in hi]},
            "height": round(hi.y - lo.y, 4), "animations": anims, "sockets": sockets,
            "extensionsUsed": doc.get("extensionsUsed", [])}


def merge_report(path, asset_id, entry):
    report = {"schemaVersion": 1, "kind": "blender-report", "assets": {}}
    if path.exists():
        try:
            report = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            pass
    report.setdefault("assets", {})[asset_id] = entry
    report["generated"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    report["blender"] = bpy.app.version_string
    path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")


# --- Main ------------------------------------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--variant", required=True, choices=sorted(VARIANTS))
    parser.add_argument("--contract", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--skip-bake", action="store_true", help="flat grey textures (fast structural test)")
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
    cfg = VARIANTS[args.variant]
    contract = json.loads(args.contract.read_text(encoding="utf-8"))
    budget = contract["budgets"][cfg["budget"]]
    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    source_sha = hashlib.sha256(args.source.read_bytes()).hexdigest()
    deviations = []

    bpy.ops.wm.open_mainfile(filepath=str(args.source.resolve()), load_ui=False, use_scripts=False)
    scene = bpy.context.scene
    scene.render.fps, scene.render.fps_base = contract["fps"], 1.0
    scene.frame_start, scene.frame_end = 0, 60
    rig_src = bpy.data.objects[cfg["rig"]]
    bones = capture_bones(rig_src)
    prepare_source(cfg)
    eyes_lo, eyes_hi = world_bounds(bpy.data.objects[cfg["eyes"]])
    head_lo, head_hi = world_bounds(bpy.data.objects[cfg["head_mesh"]])
    game_coll = bpy.data.collections.new("GAME")
    scene.collection.children.link(game_coll)
    parts = [extract_part(name, group, target, opts, game_coll) for name, group, target, opts in cfg["parts"]]
    delete_everything_but([p["obj"] for p in parts])
    log("source objects removed")

    # Height: the contract range is enforced by a uniform scale when the figure is too short.
    top = max(world_bounds(p["obj"])[1].z for p in parts)
    bottom = min(world_bounds(p["obj"])[0].z for p in parts)
    scale = 1.0
    hmin, hmax = contract["heightMeters"]["min"], contract["heightMeters"]["max"]
    if top - bottom < hmin:
        scale = (hmin + 0.03) / (top - bottom)
        deviations.append(f"source figure is {top - bottom:.3f} m tall; scaled uniformly by {scale:.4f} to {hmin + 0.03:.2f} m")
    elif top - bottom > hmax:
        scale = (hmax - 0.03) / (top - bottom)
        deviations.append(f"source figure is {top - bottom:.3f} m tall; scaled uniformly by {scale:.4f} to {hmax - 0.03:.2f} m")
    if scale != 1.0:
        for p in parts:
            p["obj"].data.transform(Matrix.Scale(scale, 4))
        for b in bones.values():
            b["head"], b["tail"] = b["head"] * scale, b["tail"] * scale
        eyes_lo, eyes_hi, head_lo, head_hi = eyes_lo * scale, eyes_hi * scale, head_lo * scale, head_hi * scale
    if abs(bottom * scale) > 0.01:
        deviations.append(f"lowest source point at z={bottom * scale:.4f} m, not at the ground")

    for p in parts:
        decimate_to(p)
    joints = compute_joints(cfg, bones)
    cache = {}
    for p in parts:
        map_weights(p, cfg, bones, joints, cache)

    groups = [g for g in GROUP_ORDER if any(p["group"] == g for p in parts)]
    images = {}
    for g in groups:
        gparts = [p for p in parts if p["group"] == g]
        pack_group_uvs([p["obj"] for p in gparts], cfg["textures"][g])
        images[g] = bake_group(g, gparts, cfg["textures"][g], out, cfg["tints"], args.skip_bake, cfg["id"])
    materials = {g: game_material(f"{cfg['id']}-{g}", images[g], double_sided=g in cfg["double_sided"]) for g in groups}
    group_index = {g: i for i, g in enumerate(GROUP_ORDER)}
    for p in parts:
        finalize_part_mesh(p, materials, group_index)
    part_stats = [{k: p[k] for k in ("source", "group", "target", "sourceTriangles", "sourceVertices", "decimateRatio")}
                  | {"triangles": triangles(p["obj"].data), "weights": p["weights"]} for p in parts]
    mesh_obj = join_parts(parts, materials, f"{cfg['id']}-mesh")
    purge()
    log(f"joined mesh: {len(mesh_obj.data.vertices)} verts, {triangles(mesh_obj.data)} tris")

    rig = build_armature(cfg["id"], joints)
    bind(mesh_obj, rig)
    toe_tips = {"Left": joints["LeftToeBase"][1], "Right": joints["RightToeBase"][1]}
    skel = gm.Skeleton({j: joints[j][0] for j in gm.JOINTS}, toe_tips)
    actions, clip_summary, clips, clip_dev = bake_clips(rig, skel, contract)
    deviations += clip_dev
    log("clips keyed: " + ", ".join(f"{n}:{s['frames'][1]}" for n, s in clip_summary.items()))

    # Sockets. The hand socket is placed at the palm centre and oriented so that, in the aim pose, its
    # Blender -Y (glTF +Z) runs along the barrel and +Z (glTF +Y) is up.
    aim_Q, aim_H, _ = skel.solve(clips["aim"][2](0))
    hand_head, hand_tail = joints["RightHand"]
    hand_dir = (hand_tail - hand_head).normalized()
    palm_rest = hand_head + hand_dir * 0.075 + Vector((0.0, 0.0, -0.012))
    hand_socket_rest = Matrix.Translation(palm_rest) @ Matrix(aim_Q["RightHand"]).inverted().to_4x4()
    add_socket(rig, "SOCKET_HAND_R", "RightHand", hand_socket_rest)
    eye_z = (eyes_lo.z + eyes_hi.z) / 2
    head_socket_rest = Matrix.Translation(Vector((0.0, (head_lo.y + head_hi.y) / 2, eye_z + 0.10)))
    add_socket(rig, "SOCKET_HEAD", "Head", head_socket_rest)
    grip_aim = skel.point(aim_Q, aim_H, "RightHand", palm_rest)

    for act in list(bpy.data.actions):
        if act.name not in actions:
            bpy.data.actions.remove(act)
    purge()
    blend_path = out / f"{cfg['id']}.blend"
    bpy.ops.wm.save_as_mainfile(filepath=str(blend_path), compress=True)
    log(f"saved {blend_path.name}")

    export = [rig, mesh_obj] + [o for o in bpy.data.objects if o.name.startswith("SOCKET_")]
    for o in bpy.data.objects:
        o.select_set(o in export)
    bpy.context.view_layer.objects.active = rig
    glb = out / f"{cfg['id']}.glb"
    bpy.ops.export_scene.gltf(
        filepath=str(glb), export_format="GLB", use_selection=True, export_yup=True, export_apply=True,
        export_normals=True, export_texcoords=True, export_tangents=False, export_vertex_color="NONE",
        export_materials="EXPORT", export_image_format="JPEG", export_jpeg_quality=85, export_extras=False,
        export_cameras=False, export_lights=False, export_skins=True, export_all_influences=False, export_influence_nb=4,
        export_def_bones=False, export_armature_object_remove=False, export_rest_position_armature=True,
        export_animations=True, export_animation_mode="ACTIONS", export_force_sampling=True, export_frame_step=1,
        export_frame_range=False, export_anim_single_armature=True, export_optimize_animation_size=True,
        export_optimize_animation_keep_anim_armature=True, export_reset_pose_bones=True, export_morph=False,
        export_leaf_bone=False, export_hierarchy_flatten_bones=False,
        export_copyright=contract["variants"][0 if args.variant == "snow" else 1]["credit"])
    summary = glb_summary(glb)
    log(f"exported {glb.name}: {summary['bytes']} bytes, {summary['triangles']} tris, {summary['materials']} materials, "
        f"{summary['jointCount']} joints, {len(summary['animations'])} clips")

    # Contract checks on the exported bytes.
    joint_names = [j["name"] for j in summary["joints"]]
    want_joints = contract["skeleton"]["joints"]
    if sorted(joint_names) != sorted(want_joints):
        deviations.append(f"skin joints {joint_names} differ from the contract set {want_joints}")
    for j in summary["joints"]:
        want_parent = contract["skeleton"]["parents"].get(j["name"])
        if (j["parent"] or None) != want_parent:
            deviations.append(f"joint {j['name']} parent {j['parent']} != {want_parent}")
    if summary["triangles"] > budget["triangles"]:
        deviations.append(f"{summary['triangles']} triangles > budget {budget['triangles']}")
    if summary["materials"] > budget["materials"]:
        deviations.append(f"{summary['materials']} materials > budget {budget['materials']}")
    if summary["bytes"] > budget["fileBytes"]:
        deviations.append(f"{summary['bytes']} bytes > budget {budget['fileBytes']}")
    for img in summary["images"]:
        if img["size"] and max(img["size"]) > budget["textureMaxSize"]:
            deviations.append(f"image {img['name']} {img['size']} > {budget['textureMaxSize']} px")
    if abs(summary["meshBounds"]["min"][1]) > 0.01:
        deviations.append(f"feet at glTF y={summary['meshBounds']['min'][1]}, not 0")
    if not (hmin <= summary["height"] <= hmax):
        deviations.append(f"height {summary['height']} m outside {hmin}-{hmax}")
    by_name = {j["name"]: j for j in summary["joints"]}
    lf, hd = by_name.get("LeftFoot"), by_name.get("Head")
    if lf and lf["restWorldPosition"][0] <= 0.02:
        deviations.append("LeftFoot is not at positive glTF X (+X must be the character's left)")
    if hd and not (1.3 < hd["restWorldPosition"][1] < 1.8):
        deviations.append(f"Head joint at glTF y={hd['restWorldPosition'][1]}")
    exported = {a["name"] for a in summary["animations"]}
    missing = [c["name"] for c in contract["clips"] if c["name"] not in exported]
    if missing:
        deviations.append(f"clips missing from the GLB: {missing}")
    for a in summary["animations"]:
        want = clip_summary.get(a["name"], {}).get("seconds")
        if want is not None and abs(a["seconds"] - want) > 1e-3:
            deviations.append(f"clip {a['name']} exported {a['seconds']} s, keyed {want} s")

    entry = {
        "id": cfg["id"], "role": cfg["role"], "status": "EXPORTED_NOT_VERIFIED_IN_RUNTIME",
        "source": {"path": str(args.source).replace("\\", "/"), "sha256": source_sha, "rig": cfg["rig"],
                   "rigBones": len(bones), "deformBones": sum(1 for b in bones.values() if b["deform"])},
        "scale": scale, "parts": part_stats, "glb": {"path": glb.name, **{k: summary[k] for k in ("bytes", "sha256", "generator")}},
        "triangles": summary["triangles"], "materials": summary["materialNames"], "textures": summary["images"],
        "vertices": len(mesh_obj.data.vertices), "jointCount": summary["jointCount"], "joints": summary["joints"],
        "meshBoundsGltf": summary["meshBounds"], "height": summary["height"],
        "clips": {n: {**clip_summary[n], "exportedSeconds": next((a["seconds"] for a in summary["animations"] if a["name"] == n), None)}
                  for n in clip_summary},
        "sockets": summary["sockets"],
        "socketDesign": {"SOCKET_HAND_R": {"restPalmPointBlender": [round(c, 4) for c in palm_rest],
                                           "aimPoseGripPointBlender": [round(c, 4) for c in grip_aim],
                                           "note": "identity world orientation in the aim pose: barrel along glTF +Z, up +Y"},
                         "SOCKET_HEAD": {"eyeLevelBlenderZ": round(eye_z, 4), "restPointBlender": [round(c, 4) for c in head_socket_rest.translation]}},
        "axes": {"authoring": "Blender -Y forward, +Z up, +X left; exported with export_yup", "gltf": contract["axes"]},
        "budget": budget, "deviations": deviations, "blend": blend_path.name,
    }
    merge_report(out / "blender-report.json", cfg["id"], entry)
    print(json.dumps({"id": cfg["id"], "bytes": summary["bytes"], "triangles": summary["triangles"], "materials": summary["materials"],
                      "joints": summary["jointCount"], "clips": [(a["name"], a["seconds"]) for a in summary["animations"]],
                      "height": summary["height"], "deviations": deviations}))


if __name__ == "__main__":
    main()
