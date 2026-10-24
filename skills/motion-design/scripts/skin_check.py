"""Stress-pose the game rig and measure how the skinned meshes stretch. Read-only on the .blend.

Hard weight seams (a limb glued to the pelvis, then a 0 -> 1 jump onto the thigh) look like the limb
detaching: one edge ring opens by centimetres while its neighbours barely move. Two metrics catch it:
  stretch_cm  how much an edge lengthens (absolute, so tiny edges at seams do not dominate)
  kink_cm     how far a vertex's displacement differs from its neighbours' mean (a step in the motion)
Calibration (Snow, 1.6 m): hard hip seam 6-13 cm stretch / 3-7 cm kink; fixed weights <= 3.6 / 2.9 in all poses.
Each pose rotates one joint about the head of its bone, in world space:
  hip flex 70 / extend 35 / abduct 35, knee flex 100, shoulder forward 70 / back 45, elbow flex 100,
  spine twist 35 (first spine bone, about world up).
Reported per pose and mesh: worst values, how many exceed the limits, and where the worst sits
(dominant bones). Limits assume metres and a human-sized character; compare against a known-good build.

blender -b --factory-startup --python skin_check.py -- --blend game.blend --profile rig.json
    --report skin.json [--stretch-cm 5] [--kink-cm 3] [--fail]
"""
import argparse
import collections
import json
import math
import sys

import bpy
import numpy as np
from mathutils import Matrix, Vector

ap = argparse.ArgumentParser()
ap.add_argument("--blend", required=True)
ap.add_argument("--profile", required=True)
ap.add_argument("--report", required=True)
ap.add_argument("--stretch-cm", type=float, default=5.0, help="edge lengthening counted as a tear")
ap.add_argument("--kink-cm", type=float, default=3.0, help="displacement step counted as a hard seam")
ap.add_argument("--fail", action="store_true", help="exit 1 when any pose exceeds a limit")
args = ap.parse_args(sys.argv[sys.argv.index("--") + 1:])

prof = json.load(open(args.profile))
R = prof["retarget"]
bpy.ops.wm.open_mainfile(filepath=args.blend, load_ui=False, use_scripts=False)
rig = bpy.data.objects[prof.get("game_rig", "GAME_rig")]
if rig.animation_data:
    rig.animation_data.action = None
meshes = [o for o in bpy.data.objects if o.type == "MESH"
          and any(m.type == "ARMATURE" and m.object == rig for m in o.modifiers)]
FACING = {"-Y": (0, -1), "+Y": (0, 1), "+X": (1, 0), "-X": (-1, 0)}
fx, fy = FACING[prof.get("facing", "-Y")]
FWD, LEFT, UP = Vector((fx, fy, 0)), Vector((-fy, fx, 0)), Vector((0, 0, 1))


def bone_dir(name):
    b = rig.data.bones[name]
    return (rig.matrix_world.to_3x3() @ (b.tail_local - b.head_local)).normalized()


def toward(name, target, deg):
    """Rotation that swings bone `name` toward world direction `target` by deg."""
    axis = bone_dir(name).cross(target)
    if axis.length < 1e-4:  # bone already along target: swing about the other horizontal axis
        axis = bone_dir(name).cross(UP.cross(target))
    return Matrix.Rotation(math.radians(deg), 4, axis.normalized())


arms = prof.get("arms", {})
spine_first = next((b for b in R.get("axial", []) if b != R["hips"]
                    and rig.data.bones[b].parent and rig.data.bones[b].parent.name == R["hips"]), None)
poses = {}
for s, out in (("L", LEFT), ("R", -LEFT)):
    leg = R["legs"][s]
    poses[f"hip_flex_{s}"] = {leg["thigh"]: toward(leg["thigh"], FWD, 70)}
    poses[f"hip_extend_{s}"] = {leg["thigh"]: toward(leg["thigh"], -FWD, 35)}
    poses[f"hip_abduct_{s}"] = {leg["thigh"]: toward(leg["thigh"], out, 35)}
    poses[f"knee_flex_{s}"] = {leg["knee"]: toward(leg["knee"], -FWD, 100)}
    if s in arms:
        poses[f"shoulder_fwd_{s}"] = {arms[s]["upper"]: toward(arms[s]["upper"], FWD, 70)}
        poses[f"shoulder_back_{s}"] = {arms[s]["upper"]: toward(arms[s]["upper"], -FWD, 45)}
        poses[f"elbow_flex_{s}"] = {arms[s]["lower"]: toward(arms[s]["lower"], FWD, 100)}
if spine_first:
    poses["spine_twist"] = {spine_first: Matrix.Rotation(math.radians(35), 4, UP)}


def evaluate():
    dg = bpy.context.evaluated_depsgraph_get()
    dg.update()
    out = {}
    for ob in meshes:
        ev = ob.evaluated_get(dg)
        me = ev.to_mesh()
        co = np.empty(len(me.vertices) * 3)
        me.vertices.foreach_get("co", co)
        out[ob.name] = co.reshape(-1, 3) @ np.array(ob.matrix_world.to_3x3()).T
        ev.to_mesh_clear()
    return out


def set_pose(rot):
    for pb in rig.pose.bones:
        pb.matrix_basis.identity()
    bpy.context.view_layer.update()
    for name, q in rot.items():
        pb = rig.pose.bones[name]
        h = pb.head.copy()
        pb.matrix = Matrix.Translation(h) @ q @ Matrix.Translation(-h) @ pb.matrix
    bpy.context.view_layer.update()


set_pose({})
rest = evaluate()
edges, dominant, nbrs = {}, {}, {}
for ob in meshes:
    e = np.empty(len(ob.data.edges) * 2, np.int64)
    ob.data.edges.foreach_get("vertices", e)
    edges[ob.name] = e.reshape(-1, 2)
    adj = collections.defaultdict(list)
    for a, b in edges[ob.name]:
        adj[a].append(b)
        adj[b].append(a)
    nbrs[ob.name] = adj
    names = [g.name for g in ob.vertex_groups]
    dominant[ob.name] = [names[max(v.groups, key=lambda g: g.weight).group] if len(v.groups) else None
                         for v in ob.data.vertices]

results, worst = {}, {"stretch_cm": 0.0, "kink_cm": 0.0}
for pose, rot in poses.items():
    set_pose(rot)
    posed = evaluate()
    per_mesh = {}
    for ob in meshes:
        E, p0, p1, adj = edges[ob.name], rest[ob.name], posed[ob.name], nbrs[ob.name]
        if not len(E):
            continue
        stretch = 100 * (np.linalg.norm(p1[E[:, 0]] - p1[E[:, 1]], axis=1) - np.linalg.norm(p0[E[:, 0]] - p0[E[:, 1]], axis=1))
        d = p1 - p0
        kink = 100 * np.array([np.linalg.norm(d[i] - d[adj[i]].mean(0)) if adj[i] else 0.0 for i in range(len(d))])
        k, v = int(np.argmax(stretch)), int(np.argmax(kink))
        a, b = E[k]
        per_mesh[ob.name] = {
            "stretch_cm": round(float(stretch[k]), 2), "stretch_over": int((stretch > args.stretch_cm).sum()),
            "stretch_at": [round(float(x), 3) for x in (p0[a] + p0[b]) / 2],
            "stretch_bones": sorted({dominant[ob.name][a], dominant[ob.name][b]} - {None}),
            "kink_cm": round(float(kink[v]), 2), "kink_over": int((kink > args.kink_cm).sum()),
            "kink_at": [round(float(x), 3) for x in p0[v]], "kink_bone": dominant[ob.name][v]}
        for m in worst:
            worst[m] = max(worst[m], per_mesh[ob.name][m])
    results[pose] = per_mesh
    ts = max(per_mesh.items(), key=lambda kv: kv[1]["stretch_cm"])
    tk = max(per_mesh.items(), key=lambda kv: kv[1]["kink_cm"])
    flag = "  <-- over limit" if ts[1]["stretch_cm"] > args.stretch_cm or tk[1]["kink_cm"] > args.kink_cm else ""
    print(f"{pose:16s} stretch {ts[1]['stretch_cm']:5.2f} cm ({ts[0]}, {'/'.join(ts[1]['stretch_bones'])})  "
          f"kink {tk[1]['kink_cm']:5.2f} cm ({tk[0]}, {tk[1]['kink_bone']}){flag}")
set_pose({})

over = [p for p, ms in results.items()
        if any(m["stretch_cm"] > args.stretch_cm or m["kink_cm"] > args.kink_cm for m in ms.values())]
report = {"blend": args.blend, "limits": {"stretch_cm": args.stretch_cm, "kink_cm": args.kink_cm},
          "worst": worst, "poses_over_limit": over, "poses": results}
json.dump(report, open(args.report, "w"), indent=1)
print(json.dumps({"worst": worst, "poses_over_limit": over}))
if args.fail and over:
    sys.exit(1)
