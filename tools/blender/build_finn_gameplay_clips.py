"""Author six Helsinki gameplay clips against the exact supplied Finn glTF rest hierarchy.

Run in the pinned Blender Python for mathutils; no .blend/GLB importer, source scripts, scene edits,
mesh changes or export operators are used. Source GLB is data only. Existing eleven animations are
not read/resampled. The JSON supplement is merged by tools/assets/prepare_finn_character.mjs.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import struct
import sys

from mathutils import Matrix, Quaternion, Vector

sys.path.insert(0, str(Path(__file__).resolve().parent))
import release_pin
release_pin.require()
import game_motion as gm

SOURCE_SHA256 = "2d4516c7efc691fd544b25b5ff66d39e19a0f23a5c3b029dd44785652a9adebd"
NAMES = ("aim", "fire", "hit", "death", "drive", "arrested")
DURATIONS = {"aim": 1.0, "fire": 0.25, "hit": 0.5, "death": 1.4, "drive": 2.0, "arrested": 2.0}
# glTF global -> the existing authoring library's canonical Blender frame: +Z up/-Y forward.
B = Matrix(((1, 0, 0, 0), (0, 0, -1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))
BI = B.inverted()
SEMANTIC = {"Hips": "DEF-Hips", "Spine": "DEF-Spine", "Spine1": "DEF-RibCage",
            "Spine2": "DEF-Chest", "Neck": "DEF-Neck", "Head": "DEF-Head"}
for side, suffix in (("Left", ".L"), ("Right", ".R")):
    for semantic, native in (("Shoulder", "Shoulder"), ("Arm", "UpperArm_1"),
                             ("ForeArm", "Forearm_1"), ("Hand", "Wrist"),
                             ("UpLeg", "Thigh_1"), ("Leg", "Knee_1"),
                             ("Foot", "Foot"), ("ToeBase", "Toes")):
        SEMANTIC[side + semantic] = "DEF-" + native + suffix


def sha(data):
    return hashlib.sha256(data).hexdigest()


def matrix_from_node(node):
    if "matrix" in node:
        m = node["matrix"]
        return Matrix([[m[col * 4 + row] for col in range(4)] for row in range(4)])
    q = node.get("rotation", [0, 0, 0, 1])
    return Matrix.LocRotScale(Vector(node.get("translation", [0, 0, 0])),
                              Quaternion((q[3], q[0], q[1], q[2])),
                              Vector(node.get("scale", [1, 1, 1])))


def error(a, b):
    return max(abs(a[r][c] - b[r][c]) for r in range(4) for c in range(4))


def xyzw(q):
    return [q.x, q.y, q.z, q.w]


def read_glb(path):
    data = path.read_bytes()
    magic, version, length = struct.unpack_from("<III", data)
    if magic != 0x46546C67 or version != 2 or length != len(data):
        raise ValueError("invalid source GLB")
    doc, binary, offset = None, None, 12
    while offset < length:
        size, kind = struct.unpack_from("<II", data, offset)
        chunk = data[offset + 8:offset + 8 + size]
        if kind == 0x4E4F534A:
            doc = json.loads(chunk)
        elif kind == 0x004E4942:
            binary = chunk
        offset += 8 + size
    if doc is None or binary is None or sha(data) != SOURCE_SHA256:
        raise ValueError("unexpected Finn source revision")
    return doc, binary


def accessor(doc, binary, index):
    a = doc["accessors"][index]
    if "sparse" in a:
        raise ValueError("sparse source accessors are not supported")
    widths = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}
    formats = {5120: ("b", 1), 5121: ("B", 1), 5122: ("h", 2), 5123: ("H", 2), 5125: ("I", 4), 5126: ("f", 4)}
    fmt, size = formats[a["componentType"]]
    width = widths[a["type"]]
    view = doc["bufferViews"][a["bufferView"]]
    if view.get("buffer", 0) != 0:
        raise ValueError("source accessor uses external buffer")
    offset = view.get("byteOffset", 0) + a.get("byteOffset", 0)
    stride = view.get("byteStride", size * width)
    for row in range(a["count"]):
        yield struct.unpack_from("<" + fmt * width, binary, offset + row * stride)


def hierarchy(doc):
    nodes = doc["nodes"]
    names = {n["name"]: i for i, n in enumerate(nodes) if "name" in n}
    if len(names) != len(nodes):
        raise ValueError("source requires unique named nodes")
    parents = {}
    for i, node in enumerate(nodes):
        for child in node.get("children", []):
            if child in parents:
                raise ValueError("source is not a tree")
            parents[child] = i
    local = [matrix_from_node(n) for n in nodes]
    world = {}
    def at(i):
        if i not in world:
            world[i] = at(parents[i]) @ local[i] if i in parents else local[i].copy()
        return world[i]
    for i in range(len(nodes)):
        at(i)
    joints = doc["skins"][0]["joints"]
    if len(joints) != 71 or len(set(joints)) != 71:
        raise ValueError("expected unchanged native71-joint skin")
    by_index = {names[native]: semantic for semantic, native in SEMANTIC.items()}
    owner = {}
    for i in joints:
        j = i
        while j not in by_index and j in parents:
            j = parents[j]
        owner[i] = by_index.get(j)
    return names, parents, local, world, joints, owner


def pose_world(rest, owners, Q, H, heads):
    out = dict(rest)
    for i, semantic in owners.items():
        if semantic is None:
            continue
        delta = Q[semantic].to_4x4()
        delta.translation = H[semantic] - Q[semantic] @ heads[semantic]
        out[i] = BI @ delta @ B @ rest[i]
    return out


def palm_frame(rest, names, suffix):
    """Actual mirrored native palm axes, independent of glTF bone-axis conventions."""
    wrist = rest[names["DEF-Wrist" + suffix]].translation
    finger = (rest[names["DEF-Finger_Middle1" + suffix]].translation - wrist).normalized()
    width = rest[names["DEF-Finger_Index1" + suffix]].translation - rest[names["DEF-Finger_Pinky1" + suffix]].translation
    width = (width - finger * width.dot(finger)).normalized()
    basis = Matrix((finger, width, finger.cross(width))).transposed()
    palm_offset = finger * 0.075 + Vector((0, -0.012, 0))
    return basis, palm_offset


def support_grip(skel, Q, H, left_frame, right_frame):
    """Close the mirrored left palm beside the firing palm, carrying recoil rigidly.

    A forearm delta is not a native hand orientation: in v2 it left the support finger axis
    pointing mostly up, 7.9cm behind the right knuckles. Match both anatomical palm frames,
    solve the same fixed-length arm, and choose forearm roll closest to the requested wrist.
    """
    left_basis, left_offset = left_frame
    right_basis, right_offset = right_frame
    right_delta = BI.to_3x3() @ Q["RightHand"] @ B.to_3x3()
    right_palm = BI.to_3x3() @ H["RightHand"] + right_delta @ right_offset
    # Author a support-palm contact beside and just ahead of the firing palm, rather than treating
    # the two wrist pivots as the contact. Fingers cross around the firing knuckles; thumb sides stay up.
    inward = (right_delta @ Vector((0, -1, 0))).normalized()
    forward = right_delta @ right_basis.col[0]
    finger_goal = (forward * 0.35 - inward * 0.94).normalized()
    thumb_side = right_delta @ right_basis.col[1]
    left_palm = right_palm + inward * 0.025 + forward * 0.025 - thumb_side * 0.008
    root = H["LeftArm"]
    finger = finger_goal.copy()
    # Palm-centre IK and wrist orientation are coupled. Iterate the short analytic chain while
    # allowing at most20 degrees of wrist flexion toward the grip; forearm roll carries the rest.
    for _ in range(12):
        width = (thumb_side - finger * thumb_side.dot(finger)).normalized()
        target_basis = Matrix((finger, width, finger.cross(width))).transposed()
        left_delta = target_basis @ left_basis.transposed()
        wrist = B.to_3x3() @ (left_palm - left_delta @ left_offset)
        elbow, reach = gm.two_bone(root, wrist, skel.length["LeftArm"], skel.length["LeftForeArm"], Vector((1.0, 0.0, -0.28)))
        fore_direction = (BI.to_3x3() @ (wrist - elbow)).normalized()
        toward_grip = fore_direction.rotation_difference(finger_goal)
        fraction = min(1.0, math.radians(20) / max(toward_grip.angle, 1e-8))
        finger = Quaternion().slerp(toward_grip, fraction) @ fore_direction
    hand_delta = B.to_3x3() @ left_delta @ BI.to_3x3()
    upper = gm.arc(Q["LeftShoulder"] @ skel.rest_dir("LeftArm"), elbow - root) @ Q["LeftShoulder"]
    fore = gm.arc(hand_delta @ skel.rest_dir("LeftForeArm"), wrist - elbow) @ hand_delta
    Q["LeftArm"], Q["LeftForeArm"], Q["LeftHand"] = upper, fore, hand_delta
    H["LeftForeArm"] = root + upper @ (skel.R["LeftForeArm"] - skel.R["LeftArm"])
    H["LeftHand"] = H["LeftForeArm"] + fore @ (skel.R["LeftHand"] - skel.R["LeftForeArm"])
    if (H["LeftHand"] - wrist).length > 1e-5 or reach > 0.995:
        raise ValueError("native support grip exceeds the fixed-length arm")
    bend = (fore.to_quaternion().rotation_difference(hand_delta.to_quaternion())).angle
    bend = min(bend, 2 * math.pi - bend)
    if bend > math.radians(35):
        raise ValueError(f"support wrist exceeds authored bend bound: {math.degrees(bend)}")
    return {"palmSeparationMeters": (left_palm - right_palm).length, "leftArmReach": reach,
            "wristBendDegrees": math.degrees(bend),
            "fingerAxisAlignment": (left_delta @ left_basis.col[0]).dot(forward)}


def grip_angle(clip, name):
    if clip not in ("aim", "fire", "drive") or "Finger_" not in name or "Carpal" in name:
        return 0.0
    if "Thumb1" in name:
        return 0.0
    segment = int(name.split(".")[0][-1])
    if "Thumb" in name:
        return 0.35 if segment == 2 else 0.45
    if clip == "drive":
        return (0.35, 0.65, 0.55)[segment - 1]
    if ".R" in name and "Index" in name:
        return (0.06, 0.15, 0.10)[segment - 1]
    return (0.75, 0.95, 0.75)[segment - 1]


def mesh_points(doc, binary, world, mesh_name):
    for i, node in enumerate(doc["nodes"]):
        if "mesh" not in node or doc["meshes"][node["mesh"]].get("name") != mesh_name:
            continue
        for primitive in doc["meshes"][node["mesh"]]["primitives"]:
            for p in accessor(doc, binary, primitive["attributes"]["POSITION"]):
                yield world[i] @ Vector(p)


def make_sockets(doc, binary, names, rest, aim_world):
    wrist, middle = names["DEF-Wrist.R"], names["DEF-Finger_Middle1.R"]
    direction = (rest[middle].translation - rest[wrist].translation).normalized()
    palm = rest[wrist].translation + direction * 0.075 + Vector((0, -0.012, 0))
    hand_translation = rest[wrist].inverted() @ palm
    # At the reference aim pose, gun barrel is global +Z and gun up global +Y. Use native wrist's
    # actual rest/posed orientation; no imported Blender bone-axis assumptions enter this socket.
    hand_rotation = aim_world[wrist].to_quaternion().inverted().normalized()
    eye = list(mesh_points(doc, binary, rest, "FINN-eyes_game"))
    head = list(mesh_points(doc, binary, rest, "FINN-head_game"))
    if not eye or not head:
        raise ValueError("native eye/head mesh required for the head socket")
    head_centre = Vector(((min(p.x for p in head) + max(p.x for p in head)) / 2,
                          (min(p.y for p in eye) + max(p.y for p in eye)) / 2 + 0.10,
                          (min(p.z for p in head) + max(p.z for p in head)) / 2))
    head_index = names["DEF-Head"]
    head_translation = rest[head_index].inverted() @ head_centre
    head_rotation = rest[head_index].to_quaternion().inverted().normalized()
    sockets = [dict(name="SOCKET_HAND_R", parent="DEF-Wrist.R", translation=list(hand_translation), rotation=xyzw(hand_rotation), scale=[1, 1, 1]),
               dict(name="SOCKET_HEAD", parent="DEF-Head", translation=list(head_translation), rotation=xyzw(head_rotation), scale=[1, 1, 1])]
    aimed = aim_world[wrist] @ Matrix.LocRotScale(hand_translation, hand_rotation, Vector((1, 1, 1)))
    angle = aimed.to_quaternion().rotation_difference(Quaternion()).angle
    if angle > 1e-4:
        raise ValueError("aim socket axis calibration failed")
    return sockets, {"restPalmGlTF": list(palm), "aimGripGlTF": list(aimed.translation),
                     "aimBarrelGlTF": list((aimed.to_3x3() @ Vector((0, 0, 1))).normalized()),
                     "aimUpGlTF": list((aimed.to_3x3() @ Vector((0, 1, 0))).normalized()),
                     "headCentreRestGlTF": list(head_centre), "referenceAimAngularErrorRad": angle}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source-glb", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--report", required=True)
    args = ap.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:])
    source, output, report_path = Path(args.source_glb), Path(args.output), Path(args.report)
    if output.exists() or report_path.exists():
        raise ValueError("use fresh supplement/report paths")
    doc, binary = read_glb(source)
    names, parents, local, rest, joints, owners = hierarchy(doc)
    heads = {semantic: (B @ rest[names[native]]).translation for semantic, native in SEMANTIC.items()}
    # No end joints are encoded in this export. Toe tips are unused by the six non-locomotion
    # definitions; a declared forward proxy satisfies Skeleton's interface without altering a foot.
    toe_tips = {side: heads[side + "ToeBase"] + Vector((0, -0.075, 0)) for side in ("Left", "Right")}
    skel = gm.Skeleton(heads, toe_tips)
    authored = gm.Clips(skel)
    specs, _ = authored.specs()
    left_frame, right_frame = palm_frame(rest, names, ".L"), palm_frame(rest, names, ".R")
    rest_Q = {j: Matrix.Identity(3) for j in gm.JOINTS}
    reconstructed = pose_world(rest, owners, rest_Q, heads, heads)
    rest_error = max(error(reconstructed[i], rest[i]) for i in joints)
    if rest_error > 2e-6:
        raise ValueError(f"rest world reconstruction failed: {rest_error}")
    # Curl about the native rest finger's lateral axis toward a bind-pose down-facing palm.
    axes = {}
    for i in joints:
        name = doc["nodes"][i]["name"]
        if "Finger_" not in name or "Carpal" in name:
            continue
        children = doc["nodes"][i].get("children", [])
        direction = rest[children[0]].translation - rest[i].translation if children else rest[i].to_3x3() @ Vector((0, 1, 0))
        axis = direction.normalized().cross(Vector((0, -1, 0))).normalized()
        axes[i] = rest[i].to_quaternion().inverted() @ axis
    clips, metrics = [], {}
    aim_world = None
    max_translation_drift = max_scale_drift = max_head_error = 0.0
    for name in NAMES:
        frames, loop, _ = specs[name]
        poses, diagnostics = gm.bake(skel, specs, name)
        grip_diagnostics = []
        if name in ("aim", "fire"):
            for Q, H in poses:
                grip_diagnostics.append(support_grip(skel, Q, H, left_frame, right_frame))
        times = [f / frames * DURATIONS[name] for f in range(frames + 1)]
        tracks = {i: [] for i in joints if owners[i] is not None}
        hips_positions, last_q = [], {}
        loop_first = loop_last = None
        for f, (Q, H) in enumerate(poses):
            desired = pose_world(rest, owners, Q, H, heads)
            if name == "aim" and f == 0:
                aim_world = desired
            if f == 0:
                loop_first = desired
            loop_last = desired
            for semantic, native in SEMANTIC.items():
                target = BI @ H[semantic]
                max_head_error = max(max_head_error, (desired[names[native]].translation - target).length)
            for i in tracks:
                relative = desired[parents[i]].inverted() @ desired[i]
                t, q, scale = relative.decompose()
                q.normalize()
                rest_t, _, rest_scale = local[i].decompose()
                if doc["nodes"][i]["name"] != "DEF-Hips":
                    max_translation_drift = max(max_translation_drift, (t - rest_t).length)
                else:
                    hips_positions.extend(t)
                max_scale_drift = max(max_scale_drift, (scale - rest_scale).length)
                angle = grip_angle(name, doc["nodes"][i]["name"])
                if angle:
                    q = (q @ Quaternion(axes[i], angle)).normalized()
                if i in last_q and last_q[i].dot(q) < 0:
                    q.negate()
                last_q[i] = q.copy()
                tracks[i].extend(xyzw(q))
        clip_tracks = [dict(node=doc["nodes"][i]["name"], path="rotation", times=times, values=values) for i, values in tracks.items()]
        clip_tracks.append(dict(node="DEF-Hips", path="translation", times=times, values=hips_positions))
        seam = max(error(loop_first[i], loop_last[i]) for i in joints) if loop else None
        if loop and seam > 1e-5:
            raise ValueError(f"{name} loop does not close")
        if any(not math.isfinite(v) for track in clip_tracks for v in track["values"]):
            raise ValueError(f"{name} has nonfinite tracks")
        clips.append(dict(name=name, loop=loop, duration=DURATIONS[name], tracks=clip_tracks))
        metrics[name] = dict(samples=len(times), duration=times[-1], loop=loop, loopWorldMatrixError=seam,
                             maxLegReach=max(max(d["legReach"].values()) for d in diagnostics),
                             maxArmReach=max([v for d in diagnostics for v in d["armReach"].values()] or [0]),
                             authoredFrameIntervals=frames, timeScaledFromSeconds=frames / gm.FPS)
        if grip_diagnostics:
            metrics[name]["supportGrip"] = {"palmSeparationMeters": max(d["palmSeparationMeters"] for d in grip_diagnostics),
                                          "maxLeftArmReach": max(d["leftArmReach"] for d in grip_diagnostics),
                                          "maxWristBendDegrees": max(d["wristBendDegrees"] for d in grip_diagnostics),
                                          "minFingerAxisAlignment": min(d["fingerAxisAlignment"] for d in grip_diagnostics)}
    if max_translation_drift > 1e-4 or max_scale_drift > 1e-4 or max_head_error > 1e-5:
        raise ValueError(f"native hierarchy transport drift: {max_translation_drift}, {max_scale_drift}, {max_head_error}")
    sockets, socket_metrics = make_sockets(doc, binary, names, rest, aim_world)
    result = dict(version=1, sourceSha256=SOURCE_SHA256, clips=clips, sockets=sockets)
    report = dict(version=1, sourceGlb=str(source), sourceSha256=SOURCE_SHA256,
                  authoringSha256=sha(Path(__file__).read_bytes()), gameMotionSha256=sha(Path(gm.__file__).read_bytes()),
                  nativeJoints=len(joints), semanticMapping=SEMANTIC,
                  ownerMapping={doc["nodes"][i]["name"]: owner for i, owner in owners.items()},
                  axes="native glTF +Y up/+Z forward -> canonical Blender(x,-z,y); no importer or reorientation",
                  restWorldIdentityError=rest_error, maxNonHipsLocalTranslationDriftMeters=max_translation_drift,
                  maxLocalScaleDrift=max_scale_drift, maxSemanticHeadErrorMeters=max_head_error,
                  clips=metrics, sockets=sockets, socketDesign=socket_metrics,
                  nativeAnimationPolicy="eleven source clips are not read or resampled; supplement only",
                  fingers="native parent-relative positions retained; aim/fire pistol grip, drive wheel grip authored as local phalanx curls",
                  limits="Numerical hierarchy/finite/loop/socket checks only; native runtime appearance, pistol hand contact, death floor contact, seated anchors and transitions remain required.")
    output.parent.mkdir(parents=True, exist_ok=True)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, separators=(",", ":")), encoding="utf-8")
    report["supplementSha256"] = sha(output.read_bytes())
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({"status": "PASS_NUMERICAL_RUNTIME_PENDING", "output": str(output), "sha256": report["supplementSha256"], "clips": metrics, "drift": max_translation_drift, "sockets": socket_metrics}))


if __name__ == "__main__":
    main()
