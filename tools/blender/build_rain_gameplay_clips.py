"""Append six gameplay actions to Rain's unchanged native70 glTF rig.

The source GLB is data only. Native gait buffers, geometry, skin and source scenes are never
modified. Reuse the already validated fixed-length solver and hierarchy transport; only Rain's
semantic map, palm dimensions, phalanx names and sockets are character-specific here.
"""
import argparse
import json
import math
from pathlib import Path
import re
import struct
import sys
import numpy as np
from mathutils import Matrix, Quaternion, Vector
sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_snow_gameplay_clips as transport
from build_snow_gameplay_clips import B, BI, DURATIONS, NAMES, accessor, error, matrix_from_node, mesh_points, pose_world, sha, support_grip, xyzw
import game_motion as gm

SOURCE_SHA256 = "c2aec924a23100aeae0d1ea9d006af5aea3dd6b37c76359a3bf262b679fe1e58"
SEMANTIC = {"Hips":"DEF-Pelvis","Spine":"DEF-Spine1","Spine1":"DEF-Spine2","Spine2":"DEF-Spine3","Neck":"DEF-Neck","Head":"DEF-Head"}
for side,suffix in (("Left",".L"),("Right",".R")):
    for semantic,native in (("Shoulder","Clavicle"),("Arm","Upperarm1"),("ForeArm","Forearm1"),("Hand","Hand"),("UpLeg","Thigh1"),("Leg","Shin1"),("Foot","Foot"),("ToeBase","Toe")):
        SEMANTIC[side+semantic]="DEF-"+native+suffix
FINGER = re.compile(r"^DEF-(Index|Middle|Ring|Pinky|Thumb)([1-4])\.([LR])$")


def palm_frame(rest,names,suffix):
    wrist=rest[names["DEF-Hand"+suffix]].translation
    finger=(rest[names["DEF-Middle2"+suffix]].translation-wrist).normalized()
    width=rest[names["DEF-Index2"+suffix]].translation-rest[names["DEF-Pinky2"+suffix]].translation
    width=(width-finger*width.dot(finger)).normalized()
    return Matrix((finger,width,finger.cross(width))).transposed(), finger*.065+Vector((0,-.01,0))


def grip_angle(clip,name):
    match=FINGER.match(name)
    if clip not in ("aim","fire","drive") or match is None:return 0.
    finger,segment,side=match.groups();segment=int(segment)
    if segment==1:return 0.  # Rain's first segment is the metacarpal.
    if finger=="Thumb":return .35 if segment==2 else .45
    if clip=="drive":return (.35,.65,.55)[segment-2]
    if side=="R" and finger=="Index":return (.06,.15,.10)[segment-2]
    return (.75,.95,.75)[segment-2]


def rain_specs(skel):
    authored = gm.Clips(skel)
    # A compact pistol hold keeps Rain's elbows down and fits her short upper arms.
    x, _, z = authored.aim["grip.Right"]
    authored.aim["grip.Right"] = (x, -.72 * skel.arm, z - .035)
    x, _, z = authored.aim["grip.Left"]
    authored.aim["grip.Left"] = (x, -.66 * skel.arm, z - .035)
    # Rain's shorter arms need the generic seated wheel targets closer to the torso.
    for side, sign in (("Left", 1), ("Right", -1)):
        authored.seated["grip." + side] = (sign * .15, -.29, .43)
    specs, _ = authored.specs()
    frames, loop, death = specs["death"]
    def fitted_death(frame):
        spec = death(frame)
        # Keep the feet on the same floor path while folding the shorter legs during the fall.
        tuck = .12 * gm.smoother((frame / frames - .5) / .32)
        for leg in spec["legs"].values():
            leg["ankle"].y += tuck
        return spec
    specs["death"] = (frames, loop, fitted_death)
    return specs


def shoe_skin(doc, binary):
    """Read-only native linear-blend skin data for actual sole contact, including toe weights."""
    skin = doc["skins"][0]
    inverse_binds = np.array(list(accessor(doc, binary, skin["inverseBindMatrices"]))).reshape(-1, 4, 4).transpose(0, 2, 1)
    pieces = []
    for mesh in doc["meshes"]:
        if mesh["name"] != "RAIN-shoes_game":
            continue
        for primitive in mesh["primitives"]:
            attributes = primitive["attributes"]
            positions = np.array(list(accessor(doc, binary, attributes["POSITION"])))
            pieces.append((np.column_stack((positions, np.ones(len(positions)))),
                           np.array(list(accessor(doc, binary, attributes["JOINTS_0"])), dtype=int),
                           np.array(list(accessor(doc, binary, attributes["WEIGHTS_0"])))))
    return skin["joints"], inverse_binds, pieces


def floor_heights(skin_data, desired):
    joints, inverse_binds, pieces = skin_data
    palette = np.array([list(map(list, desired[i])) for i in joints]) @ inverse_binds
    minima = {"Left": float("inf"), "Right": float("inf")}
    for positions, indices, weights in pieces:
        skinned = np.zeros_like(positions)
        for slot in range(4):
            skinned += np.einsum("nij,nj->ni", palette[indices[:, slot]], positions) * weights[:, slot, None]
        for side, positive in (("Left", True), ("Right", False)):
            selected = skinned[positions[:, 0] > 0 if positive else positions[:, 0] < 0]
            minima[side] = min(minima[side], float(selected[:, 1].min()))
    return minima


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
        raise ValueError("unexpected Rain source revision")
    return doc, binary

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
    if len(joints) != 70 or len(set(joints)) != 70:
        raise ValueError("expected unchanged native70-joint skin")
    by_index = {names[native]: semantic for semantic, native in SEMANTIC.items()}
    owner = {}
    for i in joints:
        j = i
        while j not in by_index and j in parents:
            j = parents[j]
        owner[i] = by_index.get(j)
    return names, parents, local, world, joints, owner

def make_sockets(doc, binary, names, rest, aim_world):
    wrist, middle = names["DEF-Hand.R"], names["DEF-Middle2.R"]
    direction = (rest[middle].translation - rest[wrist].translation).normalized()
    palm = rest[wrist].translation + direction * 0.065 + Vector((0, -0.010, 0))
    hand_translation = rest[wrist].inverted() @ palm
    # At the reference aim pose, gun barrel is global +Z and gun up global +Y. Use native wrist's
    # actual rest/posed orientation; no imported Blender bone-axis assumptions enter this socket.
    hand_rotation = aim_world[wrist].to_quaternion().inverted().normalized()
    eye = list(mesh_points(doc, binary, rest, "RAIN-eyes_game"))
    head = list(mesh_points(doc, binary, rest, "RAIN-head_game"))
    if not eye or not head:
        raise ValueError("native eye/head mesh required for the head socket")
    head_centre = Vector(((min(p.x for p in head) + max(p.x for p in head)) / 2,
                          (min(p.y for p in eye) + max(p.y for p in eye)) / 2 + 0.10,
                          (min(p.z for p in head) + max(p.z for p in head)) / 2))
    head_index = names["DEF-Head"]
    head_translation = rest[head_index].inverted() @ head_centre
    head_rotation = rest[head_index].to_quaternion().inverted().normalized()
    sockets = [dict(name="SOCKET_HAND_R", parent="DEF-Hand.R", translation=list(hand_translation), rotation=xyzw(hand_rotation), scale=[1, 1, 1]),
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
    specs = rain_specs(skel)
    sole_skin = shoe_skin(doc, binary)
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
        if FINGER.match(name) is None:
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
        sole_corrections = []
        if name == "death":
            fitted = []
            for f in range(frames + 1):
                spec = specs[name][2](f)
                corrections = {"Left": 0., "Right": 0.}
                for _ in range(3):
                    Q, H, diag = skel.solve(spec)
                    floors = floor_heights(sole_skin, pose_world(rest, owners, Q, H, heads))
                    for side in corrections:
                        lift = max(0., .001 - floors[side])
                        corrections[side] += lift
                        spec["legs"][side]["ankle"].z += lift
                Q, H, diag = skel.solve(spec)
                fitted.append((Q, H))
                diagnostics[f] = diag
                sole_corrections.append(corrections)
            poses = fitted
        grip_diagnostics = []
        if name in ("aim", "fire"):
            for Q, H in poses:
                grip_diagnostics.append(support_grip(skel, Q, H, left_frame, right_frame))
        times = [f / frames * DURATIONS[name] for f in range(frames + 1)]
        tracks = {i: [] for i in joints}
        hips_positions, last_q = [], {}
        loop_first = loop_last = None
        for f, (Q, H) in enumerate(poses):
            desired = pose_world(rest, owners, Q, H, heads)
            if name == "death":
                # The source has one rigid ponytail joint. Lay the ponytail sideways as the
                # head reaches the floor instead of allowing its standing direction below ground.
                hair = names["DEF-Hair_Ponytail1"]
                pivot = desired[hair].translation.copy()
                roll = math.radians(90) * gm.smoother((f / frames - .4) / .4)
                desired[hair] = (Matrix.Translation(pivot) @ Quaternion((0, 0, 1), roll).to_matrix().to_4x4()
                                 @ Matrix.Translation(-pivot) @ desired[hair])
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
                if doc["nodes"][i]["name"] != "DEF-Pelvis":
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
        clip_tracks.append(dict(node="DEF-Pelvis", path="translation", times=times, values=hips_positions))
        seam = max(error(loop_first[i], loop_last[i]) for i in joints) if loop else None
        if loop and seam > 1e-5:
            raise ValueError(f"{name} loop does not close")
        if any(not math.isfinite(v) for track in clip_tracks for v in track["values"]):
            raise ValueError(f"{name} has nonfinite tracks")
        max_step = 0.
        for track in clip_tracks:
            if track["path"] != "rotation":
                continue
            quaternions = [track["values"][i:i + 4] for i in range(0, len(track["values"]), 4)]
            for a, b in zip(quaternions, quaternions[1:]):
                dot = min(1., abs(sum(x * y for x, y in zip(a, b))))
                max_step = max(max_step, 2 * math.acos(dot))
        if max_step > .65:
            raise ValueError(f"{name} has a discontinuous local rotation: {max_step}")
        clips.append(dict(name=name, loop=loop, duration=DURATIONS[name], tracks=clip_tracks))
        metrics[name] = dict(samples=len(times), duration=times[-1], loop=loop, loopWorldMatrixError=seam,
                             maxAdjacentQuaternionRadians=max_step,
                             maxLegReach=max(max(d["legReach"].values()) for d in diagnostics),
                             maxArmReach=max([v for d in diagnostics for v in d["armReach"].values()] or [0]),
                             authoredFrameIntervals=frames, timeScaledFromSeconds=frames / gm.FPS)
        if grip_diagnostics:
            metrics[name]["supportGrip"] = {"palmSeparationMeters": max(d["palmSeparationMeters"] for d in grip_diagnostics),
                                          "maxLeftArmReach": max(d["leftArmReach"] for d in grip_diagnostics),
                                          "maxWristBendDegrees": max(d["wristBendDegrees"] for d in grip_diagnostics),
                                          "minFingerAxisAlignment": min(d["fingerAxisAlignment"] for d in grip_diagnostics)}
        if sole_corrections:
            metrics[name]["maximumSoleLiftMeters"] = max(v for row in sole_corrections for v in row.values())
        if metrics[name]["maxLegReach"] > .995 or metrics[name]["maxArmReach"] > .995:
            raise ValueError(f"{name} exceeds native fixed-length reach: {metrics[name]}")
    if max_translation_drift > 1e-4 or max_scale_drift > 1e-4 or max_head_error > 1e-5:
        raise ValueError(f"native hierarchy transport drift: {max_translation_drift}, {max_scale_drift}, {max_head_error}")
    sockets, socket_metrics = make_sockets(doc, binary, names, rest, aim_world)
    result = dict(version=1, sourceSha256=SOURCE_SHA256, clips=clips, sockets=sockets)
    report = dict(version=1, sourceGlb=str(source), sourceSha256=SOURCE_SHA256,
                  authoringSha256=sha(Path(__file__).read_bytes()), gameMotionSha256=sha(Path(gm.__file__).read_bytes()),
                  transportSha256=sha(Path(transport.__file__).read_bytes()),
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
