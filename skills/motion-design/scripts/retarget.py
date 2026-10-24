"""Retarget Kimodo SOMA-77 motion (export_src.py / extract_loop.py output) onto a game rig as Blender actions.

The target is described by a rig profile (see references/rig-profile.md). The rig must come from
build_game_rig.py: a plain armature at the origin, metres, Z up, with a non-deforming "root" above the hips.

Rotation transfer: W_bone(t) = A G_src(t) A^T  C_bone  R_bone_rest
  A        Kimodo (Y up, faces +Z, left +X) -> Blender (Z up, character faces profile["facing"])
  G_src    source global rotation relative to its T-pose (identity at rest)
  C_bone   limbs only: minimal rotation aligning the rest bone direction (+Y) to the source rest
           direction, so small rest-pose differences (A/T arms, finger splay) do not offset the motion
Hips translation is scaled by the hip-joint height ratio. Twist bones take a fraction of their child's twist.
--foot-lock re-solves each leg with two-bone IK during source foot contacts so the ankle stays planted.

blender -b --factory-startup --python retarget.py -- --blend game.blend --profile rig.json
    --src a_loop.npz b_loop.npz --action walk run --output clips.blend
    [--in-place] [--foot-lock] [--align forward|back|left|right] [--keep-head-pitch] [--report r.json]
"""
import argparse
import json
import math
import sys

import bpy
import numpy as np
from bpy_extras import anim_utils
from mathutils import Matrix, Quaternion, Vector

ap = argparse.ArgumentParser()
ap.add_argument("--blend", required=True)
ap.add_argument("--profile", required=True)
ap.add_argument("--src", required=True, nargs="+", help="one or more src npz files")
ap.add_argument("--action", required=True, nargs="+", help="action name per src")
ap.add_argument("--output", required=True)
ap.add_argument("--in-place", action="store_true", help="remove steady horizontal travel (game clips)")
ap.add_argument("--foot-lock", action="store_true")
ap.add_argument("--align", choices=["forward", "back", "left", "right"],
                help="rotate the clip so its travel points this way relative to the character")
ap.add_argument("--keep-head-pitch", action="store_true", help="skip gaze levelling")
ap.add_argument("--report")
args = ap.parse_args(sys.argv[sys.argv.index("--") + 1:])
assert len(args.src) == len(args.action), "one --action name per --src file"

prof = json.load(open(args.profile))
R = prof["retarget"]
bpy.ops.wm.open_mainfile(filepath=args.blend, load_ui=False, use_scripts=False)
scene = bpy.context.scene
rig = bpy.data.objects[prof.get("game_rig", "GAME_rig")]
assert rig.matrix_world == Matrix.Identity(4), "rig object must sit at the origin (run build_game_rig.py)"
bones = rig.data.bones

FACING = {"-Y": (0, -1), "+Y": (0, 1), "+X": (1, 0), "-X": (-1, 0)}
fx, fy = FACING[prof.get("facing", "-Y")]
LEFT = np.array([-fy, fx, 0.0])  # character left, 90 degrees counter-clockwise from facing
FWD = np.array([fx, fy, 0.0])
A = np.array([[LEFT[0], 0, fx], [LEFT[1], 0, fy], [0, 1, 0]], dtype=np.float64)

MAP = {k: tuple(v) for k, v in R["map"].items()}
AXIAL = set(R.get("axial", []))
HIPS = R["hips"]
missing = [b for b in [*MAP, HIPS, R["head"], R["neck"]] if b not in bones]
assert not missing, f"profile bones missing in {rig.name}: {missing}"

order = [b.name for b in bones]  # Blender stores parents before children
idx = {n: i for i, n in enumerate(order)}
parent = [idx[b.parent.name] if b.parent else -1 for b in bones]
assert parent[idx[HIPS]] >= 0, "hips need a parent root bone (build_game_rig.py adds one)"
rest = np.array([np.array(b.matrix_local) for b in bones])  # armature space 4x4
rest_rot = rest[:, :3, :3]
local_rest = np.array([np.linalg.inv(rest[parent[i]]) @ rest[i] if parent[i] >= 0 else rest[i]
                       for i in range(len(order))])
children = {i: [j for j in range(len(order)) if parent[j] == i] for i in range(len(order))}


def subtree(i):
    out, stack = [], [i]
    while stack:
        j = stack.pop()
        out.append(j)
        stack.extend(children[j])
    return set(out)


def path_between(top, bottom):
    """Bones from top down to (excluding) bottom along the hierarchy."""
    chain, j = [], parent[bottom]
    while j >= 0 and j != top:
        chain.append(j)
        j = parent[j]
    assert j == top, f"{order[bottom]} is not below {order[top]}"
    return [top] + chain[::-1]


LEGS = {}
for s, cols, soma in (("L", [0, 1], "LeftLeg"), ("R", [2, 3], "RightLeg")):
    leg = R["legs"][s]
    th, kn, ft = idx[leg["thigh"]], idx[leg["knee"]], idx[leg["foot"]]
    foot_tree = subtree(ft)
    LEGS[s] = {"thigh": th, "knee": kn, "foot": ft, "cols": cols, "soma": soma,
               "upper_rot": sorted(subtree(th) - subtree(kn) - foot_tree) + sorted(subtree(kn) - foot_tree),
               "lower_rot": sorted(subtree(kn) - foot_tree)}
    path_between(th, kn), path_between(kn, ft)  # validates the chain
TWIST = []
for tw in R.get("twist", []):
    b, w = idx[tw["bone"]], idx[tw["driver"]]
    assert parent[w] == b, f"twist driver {tw['driver']} must be a child of {tw['bone']}"
    TWIST.append((b, parent[b], w, float(tw.get("fraction", 0.5))))


def unit(v):
    return v / np.linalg.norm(v)


def align(a, b):
    """Minimal rotation matrix taking unit vector a to unit vector b."""
    v, c = np.cross(a, b), float(np.dot(a, b))
    if c < -0.999999:
        raise ValueError("opposite directions")
    vx = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + vx + vx @ vx / (1 + c)


def twist_about_y(m):
    q = Matrix(m.tolist()).to_quaternion()
    t = Quaternion((q.w, 0, q.y, 0))
    return t.normalized() if t.magnitude > 1e-8 else Quaternion()


def two_bone_ik(a, b, c, target, pole):
    """Return new knee and ankle positions so the chain a-b-c reaches target (lengths kept)."""
    l1, l2 = np.linalg.norm(b - a), np.linalg.norm(c - b)
    d = target - a
    dist = np.clip(np.linalg.norm(d), 1e-6, l1 + l2 - 1e-5)
    dn = d / np.linalg.norm(d)
    cos_a = np.clip((l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist), -1, 1)
    bend = pole - a - np.dot(pole - a, dn) * dn
    bend = unit(bend) if np.linalg.norm(bend) > 1e-6 else FWD
    knee = a + dn * (l1 * cos_a) + bend * (l1 * math.sqrt(max(0.0, 1 - cos_a * cos_a)))
    return knee, a + dn * dist


report = {}
for src_path, action_name in zip(args.src, args.action):
    z = np.load(src_path)
    names = [str(n) for n in z["names"]]
    sj = {n: i for i, n in enumerate(names)}
    G = np.einsum("ab,tjbc,dc->tjad", A, z["grot"].astype(np.float64), A)
    P = z["pos"].astype(np.float64) @ A.T
    R0 = z["rest_pos"].astype(np.float64) @ A.T
    contacts = z["contacts"]
    fps = float(z["fps"])
    is_loop = "loop" in z.files and bool(z["loop"])
    travel = z["travel"].astype(np.float64) @ A.T if is_loop else P[-1, 0] - P[0, 0]
    if args.align:
        # Turn the clip about Z (around the start hips) so its travel points along the wanted axis.
        want = {"forward": FWD, "back": -FWD, "left": LEFT, "right": -LEFT}[args.align]
        yaw = math.atan2(want[1], want[0]) - math.atan2(travel[1], travel[0])
        Rz = np.array(Matrix.Rotation(yaw, 3, "Z"))
        pivot = P[0, 0] * np.array([1, 1, 0])
        G = np.einsum("ab,tjbc->tjac", Rz, G)
        P = (P - pivot) @ Rz.T + pivot
        travel = Rz @ travel
    N = len(G)
    if is_loop:  # previous + current + next cycle (+ closing frame), so foot locks wrap across the seam
        G = np.concatenate([G, G, G, G[:1]])
        P = np.concatenate([P - travel, P, P + travel, P[:1] + 2 * travel])
        contacts = np.concatenate([contacts, contacts, contacts, contacts[:1]])
    T = len(G)

    # Scale by hip-joint (thigh head) height; the two skeletons place "Hips" differently.
    thigh_mid = (rest[LEGS["L"]["thigh"], :3, 3] + rest[LEGS["R"]["thigh"], :3, 3]) / 2
    src_leg_mid = (P[:, sj["LeftLeg"]] + P[:, sj["RightLeg"]]) / 2
    scale = thigh_mid[2] / ((R0[sj["LeftLeg"], 2] + R0[sj["RightLeg"], 2]) / 2)
    hip = idx[HIPS]
    hips_offset = rest[hip, :3, 3] - thigh_mid  # world rest offset, rotates with the hips
    hips_rest_inv = np.linalg.inv(rest_rot[hip])

    corr = {}
    for b, (j, child) in MAP.items():
        if child is None or b in AXIAL:
            corr[b] = np.eye(3)
            continue
        corr[b] = align(unit(rest[idx[b], :3, 1]), unit(R0[sj[child]] - R0[sj[j]]))

    world = np.zeros((T, len(order), 4, 4))

    def propagate(t):
        """Re-derive every position from its parent (rotations kept); the hips keep their own."""
        for i in range(len(order)):
            p = parent[i]
            if p >= 0 and i != hip:
                world[t, i, :3, 3] = (world[t, p] @ local_rest[i])[:3, 3]

    for t in range(T):
        for i, b in enumerate(order):
            p = parent[i]
            if p < 0:
                world[t, i] = rest[i]
                continue
            m = world[t, p] @ local_rest[i]
            if b in MAP:
                m[:3, :3] = G[t, sj[MAP[b][0]]] @ corr[b] @ rest_rot[i]
            if i == hip:
                m[:3, 3] = src_leg_mid[t] * scale + m[:3, :3] @ hips_rest_inv @ hips_offset
            world[t, i] = m
        for b, p, w, frac in TWIST:  # twist bone carries part of its child's twist about the bone axis
            rigid = world[t, p] @ local_rest[b]
            delta = np.linalg.inv(local_rest[w][:3, :3]) @ rigid[:3, :3].T @ world[t, w][:3, :3]
            part = Quaternion().slerp(twist_about_y(delta), frac).to_matrix()
            world[t, b, :3, :3] = rigid[:3, :3] @ np.array(part)
        propagate(t)

    # Level the gaze: remove the clip's mean head pitch (variation kept), half on neck, half on head.
    head_pitch = 0.0
    if not args.keep_head_pitch:
        hd, nk = idx[R["head"]], idx[R["neck"]]
        lefts, pitches = [], []
        for t in range(T):
            left = unit(world[t, hip, :3, :3] @ rest_rot[hip].T @ LEFT)
            fwd = unit(np.cross(left, [0, 0, 1.0]))  # character forward on the ground
            up = world[t, hd, :3, :3] @ rest_rot[hd].T @ np.array([0, 0, 1.0])
            lefts.append(left)
            pitches.append(math.degrees(math.atan2(np.dot(up, fwd), up[2])))  # + = chin down
        head_pitch = float(np.mean(pitches))
        if abs(head_pitch) > 2.0:
            for t in range(T):
                # + angle about the character's left axis tips the head back (chin up)
                half = np.array(Matrix.Rotation(math.radians(-head_pitch / 2), 3, Vector(lefts[t])))
                world[t, nk, :3, :3] = half @ world[t, nk, :3, :3]
                world[t, hd, :3, :3] = half @ half @ world[t, hd, :3, :3]
                for i in subtree(hd) - {hd}:
                    world[t, i, :3, :3] = half @ half @ world[t, i, :3, :3]
                propagate(t)

    def ankle(t, s):
        return world[t, LEGS[s]["foot"], :3, 3]

    def skate(s):
        cols, moves = LEGS[s]["cols"], []
        for t in range(1, T):
            if contacts[t, cols].any() and contacts[t - 1, cols].any():
                moves.append(np.linalg.norm(ankle(t, s)[:2] - ankle(t - 1, s)[:2]))
        return float(np.sum(moves)), len(moves)

    before = {s: skate(s) for s in LEGS}

    if args.foot_lock:
        for s, L in LEGS.items():
            cols, th, kn, ft = L["cols"], L["thigh"], L["knee"], L["foot"]
            t = 0
            while t < T:
                if not contacts[t, cols].any():
                    t += 1
                    continue
                start = t
                while t < T and contacts[t, cols].any():
                    t += 1
                end = t  # [start, end)
                anchor = ankle(start, s).copy()
                anchor[:2] = np.mean([ankle(k, s)[:2] for k in range(start, end)], axis=0)
                blend_in = 3
                for k in range(max(0, start - blend_in), min(T, end + blend_in)):
                    wgt = 1.0
                    if k < start:
                        wgt = (k - (start - blend_in) + 1) / (blend_in + 1)
                    elif k >= end:
                        wgt = 1 - (k - end + 1) / (blend_in + 1)
                    cur = ankle(k, s).copy()
                    target = cur + wgt * (np.array([anchor[0], anchor[1], cur[2]]) - cur)
                    a, b = world[k, th, :3, 3].copy(), world[k, kn, :3, 3].copy()
                    # keep the current bend plane: pole = knee pushed away from the hip-ankle line
                    line = unit(cur - a)
                    bend = b - a - np.dot(b - a, line) * line
                    pole = b + 0.3 * (unit(bend) if np.linalg.norm(bend) > 1e-4 else FWD)
                    new_b, new_c = two_bone_ik(a, b, cur, target, pole)
                    keep = {i: world[k, i, :3, :3].copy() for i in subtree(ft)}  # feet keep the source orientation
                    r1 = align(unit(b - a), unit(new_b - a))
                    for i in L["upper_rot"]:
                        world[k, i, :3, :3] = r1 @ world[k, i, :3, :3]
                    propagate(k)
                    knee_now = world[k, kn, :3, 3]
                    r2 = align(unit(ankle(k, s) - knee_now), unit(new_c - knee_now))
                    for i in L["lower_rot"]:
                        world[k, i, :3, :3] = r2 @ world[k, i, :3, :3]
                    for i, m in keep.items():
                        world[k, i, :3, :3] = m
                    propagate(k)
    after = {s: skate(s) for s in LEGS}

    if is_loop:  # N frames plus a closing key equal to the first, so runtimes loop without a hitch
        world, contacts, T = world[N:2 * N + 1], contacts[N:2 * N + 1], N + 1
    root_speed = float(np.linalg.norm((travel * scale)[:2]) / (N / fps)) if is_loop else None
    if args.in_place:
        # Remove only the steady travel (constant velocity), keeping hip sway and surge.
        ramp = np.outer(np.arange(T) / (N if is_loop else T - 1), (travel * scale)[:2] if is_loop
                        else world[-1, hip, :2, 3] - world[0, hip, :2, 3])
        offset = world[:, hip, :2, 3] - ramp
        offset = offset.mean(axis=0) - rest[hip, :2, 3]
        # The root bone is not keyed, so it must stay put; shifting it too would cancel the change.
        for i in range(len(order)):
            if parent[i] >= 0:
                world[:, i, :2, 3] -= ramp + offset
        if not is_loop:
            root_speed = float(np.linalg.norm(ramp[-1]) / ((T - 1) / fps))

    # --- Write the action -----------------------------------------------------------
    action = bpy.data.actions.new(action_name)
    slot = action.slots.new(id_type="OBJECT", name=rig.name)
    ad = rig.animation_data or rig.animation_data_create()
    bpy.context.view_layer.update()
    ad.action = action
    ad.action_slot = slot
    bag = anim_utils.action_ensure_channelbag_for_slot(action, slot)
    frames = np.arange(1, T + 1, dtype=np.float64)
    for i, b in enumerate(order):
        p = parent[i]
        if p < 0:
            continue
        basis = np.einsum("ij,tjk->tik", np.linalg.inv(local_rest[i]),
                          np.einsum("tij,tjk->tik", np.linalg.inv(world[:, p]), world[:, i]))
        quats = np.array([Matrix(m[:3, :3].tolist()).to_quaternion()[:] for m in basis])
        for t in range(1, T):  # sign continuity
            if np.dot(quats[t], quats[t - 1]) < 0:
                quats[t] = -quats[t]
        channels = [("rotation_quaternion", k, quats[:, k]) for k in range(4)]
        if i == hip:
            channels += [("location", k, basis[:, k, 3]) for k in range(3)]
        for path, k, values in channels:
            fc = bag.fcurves.new(f'pose.bones["{b}"].{path}', index=k, group_name=b)
            fc.keyframe_points.add(T)
            fc.keyframe_points.foreach_set("co", np.column_stack([frames, values]).ravel())
            fc.keyframe_points.foreach_set("interpolation", [2] * T)  # LINEAR between samples
            fc.update()
    action.use_fake_user = True
    action["fps"] = fps
    action["source"] = src_path
    action["loop"] = is_loop
    if root_speed is not None:
        action["root_speed_mps"] = root_speed
    report[action_name] = {"frames": T, "fps": fps, "scale": scale, "in_place": args.in_place, "loop": is_loop,
                           "head_pitch_removed_deg": head_pitch, "root_speed_mps": root_speed,
                           "skate_m_before": {s: v[0] for s, v in before.items()},
                           "skate_m_after": {s: v[0] for s, v in after.items()},
                           "contact_frames": {s: v[1] for s, v in before.items()}}
    print(action_name, json.dumps(report[action_name]))

scene.render.fps = int(round(fps))
scene.frame_start, scene.frame_end = 1, T
bpy.ops.wm.save_as_mainfile(filepath=args.output, compress=True)
if args.report:
    json.dump(report, open(args.report, "w"), indent=1)
