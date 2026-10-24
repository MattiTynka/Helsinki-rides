"""Inspect an armature-driven character and draft a rig profile for the motion pipeline. Read-only.

Reports what matters for game motion: object transforms, deform bones, B-Bones (flattened by the game
rig), constraints/drivers, bound meshes and their modifiers (masks, corrective smooth), weighted groups that
name no bone (stale names from older rig versions), and the facing direction.
The draft profile maps deform bones to Kimodo's SOMA-77 joints by name and hierarchy. It is a draft:
check every mapping against the report before using it.

blender -b --factory-startup --python inspect_rig.py -- --blend /abs/char.blend --report rig_report.json
    --draft rig.profile.json [--rig ARMATURE_NAME]
"""
import argparse
import difflib
import json
import re
import sys

import bpy
from mathutils import Vector

ap = argparse.ArgumentParser()
ap.add_argument("--blend", required=True)
ap.add_argument("--report", required=True)
ap.add_argument("--draft", required=True)
ap.add_argument("--rig", help="armature object (default: the one most meshes deform with)")
args = ap.parse_args(sys.argv[sys.argv.index("--") + 1:])
bpy.ops.wm.open_mainfile(filepath=args.blend, load_ui=False, use_scripts=False)

arms = [o for o in bpy.data.objects if o.type == "ARMATURE"]
users = {a.name: [o for o in bpy.data.objects if o.type == "MESH"
                  and any(m.type == "ARMATURE" and m.object == a for m in o.modifiers)] for a in arms}
rig = bpy.data.objects[args.rig] if args.rig else max(arms, key=lambda a: len(users[a.name]))
bones = rig.data.bones
mw = rig.matrix_world
deform = [b for b in bones if b.use_deform]
DEF = {b.name for b in deform}


def deform_parent(b):
    p = b.parent
    while p is not None and not p.use_deform:
        p = p.parent
    return p


dparent = {b.name: (deform_parent(b).name if deform_parent(b) else None) for b in deform}
dchildren = {n: [c for c, p in dparent.items() if p == n] for n in DEF}


# --- Names -> roles ----------------------------------------------------------------------------
def split_side(name):
    core = re.sub(r"^(mixamorig\d*:|DEF[-_.]|ORG[-_.]|MCH[-_.]|Bip0?1[ _]|Armature_|CC_Base_)", "", name)
    side = None
    for pat, s in ((r"([._ -](L|l)|Left|left)$", "L"), (r"([._ -](R|r)|Right|right)$", "R"),  # "Center" is not right
                   (r"^(Left|left|L_|l_)", "L"), (r"^(Right|right|R_|r_)", "R"),
                   (r"_(l)_", "L"), (r"_(r)_", "R")):
        m = re.search(pat, core)
        if m:
            side, core = s, (core[:m.start()] + core[m.end():])
            break
    return side, re.sub(r"[^a-z0-9]", "", core.lower())


ROLES = [  # order matters: first match wins
    ("thigh", r"^(thigh|upleg|upperleg|legupper|femur|hip(?!s))"),
    ("knee", r"^(shin|calf|knee|lowerleg|leglower|crus|leg)"),
    ("foot", r"^(foot|ankle)"),
    ("toes", r"^(toe|ball)"),
    ("shoulder", r"^(shoulder|clavicle|collar)"),
    ("upper", r"^(upperarm|uparm|arm|humerus)"),
    ("lower", r"^(forearm|lowerarm|elbow)"),
    ("hand", r"^(hand|wrist)(?!.*(thumb|index|middle|ring|pinky))"),
    ("finger", r"(thumb|index|middle|ring|pinky)"),
]
info = {}
for b in deform:
    side, core = split_side(b.name)
    role = next((r for r, pat in ROLES if side and re.search(pat, core)), None)
    if not side:
        role = ("head" if re.search(r"^head(?!end|top|nub)", core) else "neck" if core.startswith("neck") else None)
    info[b.name] = (side, role, core)


def topmost(names):
    """Keep only names without an ancestor in the same set (twist segments share a role)."""
    s = set(names)
    out = []
    for n in names:
        p, up = dparent[n], False
        while p:
            if p in s:
                up = True
                break
            p = dparent[p]
        if not up:
            out.append(n)
    return out


def depth(n):
    d = 0
    while dparent[n]:
        n, d = dparent[n], d + 1
    return d


def pick(side, role):
    c = topmost([n for n, (s, r, _) in info.items() if s == side and r == role])
    return min(c, key=depth) if c else None


def lca(a, b):
    chain = []
    while a:
        chain.append(a)
        a = dparent[a]
    while b and b not in chain:
        b = dparent[b]
    return b


def path(top, bottom):
    out = [bottom]
    while out[-1] != top:
        out.append(dparent[out[-1]])
    return out[::-1]


roles = {s: {r: pick(s, r) for r in ("thigh", "knee", "foot", "toes", "shoulder", "upper", "lower", "hand")}
         for s in ("L", "R")}
problems = [f"{s}.{r}" for s in roles for r in ("thigh", "knee", "foot", "upper", "lower", "hand") if not roles[s][r]]
head = min((n for n, v in info.items() if v[1] == "head"), key=depth, default=None)
neck = min((n for n, v in info.items() if v[1] == "neck"), key=depth, default=None)
hips = lca(roles["L"]["thigh"], roles["R"]["thigh"]) if roles["L"]["thigh"] and roles["R"]["thigh"] else None
if not head:
    problems.append("head")
if not hips:
    problems.append("hips (common parent of the thighs)")
orphans = [n for n, p in dparent.items() if p is None]
if len(orphans) > 1:  # authoring rigs (CloudRig, Rigify) parent DEF bones to mechanism bones
    problems.append(f"{len(orphans)} deform bones have no deform parent: write profile.bones by hand "
                    "(see assets/profiles/snow-cloudrig.json)")

MAP, axial, twist = {}, [], []
if hips and head:
    trunk = path(hips, head)  # hips .. head
    neck_i = trunk.index(neck) if neck in trunk else len(trunk) - 1
    spine, necks = trunk[1:neck_i], trunk[neck_i:-1]
    MAP[hips] = ["Hips", None]
    soma_spine = ["Spine1", "Spine2", "Chest"]
    for i, n in enumerate(spine):  # spread any number of spine bones over Spine1/Spine2/Chest by position
        j = 2 if len(spine) == 1 else round(i * 2 / (len(spine) - 1))
        MAP[n] = [soma_spine[j], (soma_spine + ["Neck1"])[j + 1]]
    for i, n in enumerate(necks):
        MAP[n] = ["Neck1" if i == 0 else "Neck2", "Neck2" if i == 0 and len(necks) > 1 else "Head"]
    MAP[head] = ["Head", "HeadEnd"]
    axial = trunk
    if necks:
        neck = necks[0]
for s, S in (("L", "Left"), ("R", "Right")):
    r = roles[s]
    pairs = [("shoulder", f"{S}Shoulder", f"{S}Arm"), ("upper", f"{S}Arm", f"{S}ForeArm"),
             ("lower", f"{S}ForeArm", f"{S}Hand"), ("hand", f"{S}Hand", f"{S}HandMiddle2"),
             ("thigh", f"{S}Leg", f"{S}Shin"), ("knee", f"{S}Shin", f"{S}Foot"),
             ("foot", f"{S}Foot", f"{S}ToeBase"), ("toes", f"{S}ToeBase", f"{S}ToeEnd")]
    for role, j, child in pairs:
        if r[role]:
            MAP[r[role]] = [j, child]
    if r["hand"] and r["lower"]:  # twist segment between forearm and hand takes half the wrist twist
        p = dparent[r["hand"]]
        if p and p != r["lower"] and dparent.get(p) == r["lower"]:
            twist.append({"bone": p, "driver": r["hand"], "fraction": 0.5})
    if r["hand"]:
        for f in ("Thumb", "Index", "Middle", "Ring", "Pinky"):
            # finger chain under the hand, root first; a carpal (metacarpal) bone maps to SOMA <f>1
            roots = [c for c in dchildren[r["hand"]] if f.lower() in info[c][2]]
            if not roots:
                continue
            chain = [roots[0]]
            while True:
                nxt = [c for c in dchildren[chain[-1]] if f.lower() in info[c][2]]
                if not nxt:
                    break
                chain.append(nxt[0])
            if f == "Thumb":
                soma = [f"{S}HandThumb{k}" for k in (1, 2, 3)] + [f"{S}HandThumbEnd"]
            else:
                soma = [f"{S}Hand{f}{k}" for k in (1, 2, 3, 4)] + [f"{S}Hand{f}End"]
                if len(chain) <= 3:  # no metacarpal: first phalanx is SOMA <f>2
                    soma = soma[1:]
            for k, n in enumerate(chain[:len(soma) - 1]):
                MAP[n] = [soma[k], soma[k + 1]]

# --- Facing from the thighs: character left is the L thigh side -------------------------------------
facing = None
if roles["L"]["thigh"] and roles["R"]["thigh"]:
    left = mw @ bones[roles["L"]["thigh"]].head_local - mw @ bones[roles["R"]["thigh"]].head_local
    fx, fy = left.y, -left.x  # facing is left turned 90 degrees clockwise
    facing = ("+X" if fx > 0 else "-X") if abs(fx) > abs(fy) else ("+Y" if fy > 0 else "-Y")

# --- Rig facts --------------------------------------------------------------------------------------
drivers = len(rig.animation_data.drivers) if rig.animation_data else 0
meshes = []
stale = {}
bone_names = set(bones.keys())
for ob in users[rig.name]:
    mods = [{"name": m.name, "type": m.type, "viewport": m.show_viewport, "render": m.show_render,
             **({"vertex_group": m.vertex_group, "invert": m.invert_vertex_group} if m.type == "MASK" else {})}
            for m in ob.modifiers]
    counts = {}
    for v in ob.data.vertices:
        for g in v.groups:
            if g.weight > 1e-4:
                counts[g.group] = counts.get(g.group, 0) + 1
    used = {getattr(m, "vertex_group", "") for m in ob.modifiers}
    for vg in ob.vertex_groups:
        if counts.get(vg.index) and vg.name not in bone_names and vg.name not in used:
            near = difflib.get_close_matches(vg.name, list(DEF), n=1, cutoff=0.85)
            if near:
                stale.setdefault(ob.name, {})[vg.name] = {"verts": counts[vg.index], "looks_like": near[0]}
    meshes.append({"name": ob.name, "verts": len(ob.data.vertices), "hide_render": ob.hide_render,
                   "modifiers": mods, "shape_keys": len(ob.data.shape_keys.key_blocks) if ob.data.shape_keys else 0})

height = max((mw @ b.tail_local).z for b in deform) if deform else 0
report = {
    "rig": rig.name, "armatures": [a.name for a in arms], "object_transform_identity": rig.matrix_world == rig.matrix_world.Identity(4),
    "matrix_world": [list(r) for r in rig.matrix_world], "bones": len(bones), "deform_bones": len(deform),
    "bbone_deform_bones": {b.name: b.bbone_segments for b in deform if b.bbone_segments > 1},
    "constrained_bones": sum(1 for pb in rig.pose.bones if pb.constraints), "drivers": drivers,
    "deform_bones_without_deform_parent": [n for n, p in dparent.items() if p is None],
    "approx_height_m": round(height, 3), "facing": facing, "roles": roles, "hips": hips, "neck": neck, "head": head,
    "unmapped_deform_bones": sorted(DEF - set(MAP)), "draft_problems": problems,
    "meshes": meshes, "stale_weight_groups": stale,
}
json.dump(report, open(args.report, "w"), indent=1)

draft = {
    "name": rig.name.lower(),
    "notes": "DRAFT from inspect_rig.py: verify every mapping, facing and the bone list before use.",
    "source": {"rig": rig.name, "exclude_meshes": [], "texture_dirs": ["textures", "../textures"]},
    "game_rig": "GAME_rig",
    "facing": facing or "-Y",
    "bones": None,  # null: every deform bone, parented to its nearest deform ancestor
    "merge_groups": [],
    "cloth": None,
    "retarget": {"hips": hips, "head": head, "neck": neck or head, "axial": axial, "map": MAP,
                 "legs": {s: {k: roles[s][k] for k in ("thigh", "knee", "foot")} for s in ("L", "R")},
                 "twist": twist},
    "arms": {s: {"upper": roles[s]["upper"], "lower": roles[s]["lower"], "hand": roles[s]["hand"]} for s in ("L", "R")},
}
json.dump(draft, open(args.draft, "w"), indent=1)
print(json.dumps({k: report[k] for k in ("rig", "deform_bones", "facing", "hips", "head", "draft_problems",
                                         "object_transform_identity", "drivers")}))
print("mapped", len(MAP), "unmapped", len(report["unmapped_deform_bones"]), report["unmapped_deform_bones"][:20])
if stale:
    print("stale groups:", {m: list(g) for m, g in stale.items()})
