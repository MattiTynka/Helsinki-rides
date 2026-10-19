"""Re-bake only walk/run/sprint on a generated Snow/Rain game rig; never saves the input scene.

Blender 5.2, no add-ons or external execution. Source GLBs are decoded as data, not opened as scenes.
The target's geometry, vertex groups, rest skeleton, sockets, materials and seven other clips are hashed
before/after; a mismatch aborts before output. See content/assets/locomotion.motion.json for the contract.
"""
import argparse
import array
import hashlib
import json
import math
import struct
import sys
import time
from pathlib import Path

import bpy
from mathutils import Vector

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_game_character as character  # noqa: E402
import game_motion as gm  # noqa: E402
import locomotion_retarget as retarget  # noqa: E402
import release_pin  # noqa: E402

release_pin.require()
START = time.monotonic()


def log(*parts):
    print(f"[{time.monotonic() - START:6.1f}s]", *parts, flush=True)


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def stable_hash(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def vec(value):
    return [float(component) for component in value]


def action_hash(action):
    curves = []
    for layer in action.layers:
        for strip in layer.strips:
            for bag in strip.channelbags:
                for curve in bag.fcurves:
                    curves.append([curve.data_path, curve.array_index,
                                   [[*vec(key.co), key.interpolation, *vec(key.handle_left), *vec(key.handle_right)]
                                    for key in curve.keyframe_points]])
    return stable_hash({"curves": curves, "range": [action.frame_start, action.frame_end],
                        "useRange": action.use_frame_range})


def preserved_hashes(rig, movement_names):
    meshes = []
    for obj in sorted((o for o in bpy.data.objects if o.type == "MESH"), key=lambda o: o.name):
        digest = hashlib.sha256()
        for vertex in obj.data.vertices:
            digest.update(struct.pack("<3d", *vertex.co))
            for group in vertex.groups:
                digest.update(struct.pack("<Id", group.group, group.weight))
        for polygon in obj.data.polygons:
            digest.update(struct.pack("<II", polygon.material_index, len(polygon.vertices)))
            digest.update(struct.pack("<" + "I" * len(polygon.vertices), *polygon.vertices))
        for uv in obj.data.uv_layers:
            for item in uv.data:
                digest.update(struct.pack("<2d", *item.uv))
        meshes.append({"name": obj.name, "data": digest.hexdigest(), "groups": [g.name for g in obj.vertex_groups],
                       "materials": [m.name if m else None for m in obj.data.materials],
                       "matrix": [vec(row) for row in obj.matrix_world]})
    materials = []
    for mat in sorted(bpy.data.materials, key=lambda m: m.name):
        nodes = []
        if mat.node_tree:
            for node in mat.node_tree.nodes:
                defaults = []
                for socket in node.inputs:
                    if hasattr(socket, "default_value"):
                        value = socket.default_value
                        try:
                            value = list(value)
                        except TypeError:
                            if not isinstance(value, (int, float, str, bool)):
                                value = str(value)
                        defaults.append([socket.name, value])
                nodes.append([node.name, node.bl_idname, defaults, node.image.name if hasattr(node, "image") and node.image else None])
        materials.append([mat.name, vec(mat.diffuse_color), nodes])
    bones = [[bone.name, bone.parent.name if bone.parent else None, vec(bone.head_local), vec(bone.tail_local),
              [vec(row) for row in bone.matrix_local]] for bone in rig.data.bones]
    sockets = [[obj.name, obj.parent.name if obj.parent else None, obj.parent_type, obj.parent_bone,
                [vec(row) for row in obj.matrix_basis], [vec(row) for row in obj.matrix_parent_inverse]]
               for obj in bpy.data.objects if obj.name.startswith("SOCKET_")]
    return {"meshesAndWeights": stable_hash(meshes), "materials": stable_hash(materials),
            "restSkeleton": stable_hash(bones), "sockets": stable_hash(sockets),
            "otherActions": {a.name: action_hash(a) for a in bpy.data.actions if a.name not in movement_names}}


def source_supports(source, sample):
    return retarget.source_supports(source, sample)


def contiguous_intervals(indices, count):
    if not indices:
        return []
    ranges, start, previous = [], indices[0], indices[0]
    for index in indices[1:]:
        if index != previous + 1:
            ranges.append([start / count, (previous + 1) / count])
            start = index
        previous = index
    ranges.append([start / count, (previous + 1) / count])
    return ranges


def support_metrics(supports, seconds, speed):
    count, dt = len(supports) - 1, seconds / (len(supports) - 1)
    out = {}
    for side, _ in gm.SIDES:
        lowest = [min(point.z for point in pose[side]) for pose in supports]
        contacts = [i for i in range(count) if lowest[i] < 0.025]
        slip, vertical = [], []
        for i in contacts:
            # Follow one support marker across a sample; switching heel/ball markers would invent a velocity.
            point_index = min(range(len(supports[i][side])), key=lambda p: supports[i][side][p].z)
            velocity = (supports[i + 1][side][point_index] - supports[i][side][point_index]) / dt
            velocity.y -= speed
            slip.append(math.hypot(velocity.x, velocity.y))
            vertical.append(abs(velocity.z))
        out[side] = {"minHeightMeters": min(lowest), "maxHeightMeters": max(lowest),
                     "nearGroundIntervalsPhase": contiguous_intervals(contacts, count),
                     "nearGroundFraction": len(contacts) / count,
                     "nearGroundHorizontalSlipRmsMps": math.sqrt(sum(v * v for v in slip) / len(slip)) if slip else None,
                     "nearGroundVerticalSpeedMaxMps": max(vertical) if vertical else None}
    out["note"] = "lowest supplied support below2.5cm; target uses actual skinned shoe vertices, source uses heel/ball/toe proxies; final contact classification is independent"
    return out


def loop_metrics(poses, seconds):
    first_q, first_h, _ = poses[0]
    last_q, last_h, _ = poses[-1]
    dt = seconds / (len(poses) - 1)
    return {"measurement": "authored sample poses and first/last sample chord velocities; exported cubic derivative requires independent GLB measurement",
            "maxJointPositionSeamMeters": max((last_h[n] - first_h[n]).length for n in gm.JOINTS),
            "maxJointRotationSeamDegrees": max(math.degrees(retarget.quaternion_angle(first_q[n], last_q[n])) for n in gm.JOINTS),
            "maxJointVelocitySeamMps": max(((poses[1][1][n] - first_h[n]) / dt - (last_h[n] - poses[-2][1][n]) / dt).length
                                           for n in gm.JOINTS)}


def sample_target_baseline(rig, name, seconds, sample_hz):
    """Read the existing target action before replacement, including its original anatomical posture."""
    action = bpy.data.actions.get(name)
    if action is None:
        raise RuntimeError(f"missing target baseline action {name}")
    character.set_action(rig, action)
    frames = round(seconds * sample_hz)
    output = []
    for index in range(frames + 1):
        frame = index / sample_hz * bpy.context.scene.render.fps
        bpy.context.scene.frame_set(math.floor(frame), subframe=frame % 1)
        bpy.context.view_layer.update()
        Q, H = {}, {}
        for name in gm.JOINTS:
            pose = rig.pose.bones[name].matrix
            Q[name] = pose.to_3x3() @ rig.data.bones[name].matrix_local.to_3x3().inverted()
            H[name] = pose.translation.copy()
        output.append((Q, H))
    character.set_action(rig, None)
    character.rest_pose(rig)
    return output


def posture_metrics(poses):
    rows = []
    for pose in poses[:-1]:
        Q, H = pose[:2]
        hip, head, chest, neck = (H[name] for name in ("Hips", "Head", "Spine2", "Neck"))
        shoulders = (H["LeftArm"] + H["RightArm"]) / 2
        chest_y = chest.y + (neck.y - chest.y) * (shoulders.z - chest.z) / (neck.z - chest.z)
        sweep = sum(math.atan2(-(H[side + "Arm"].y - H[side + "Shoulder"].y),
                               abs(H[side + "Arm"].x - H[side + "Shoulder"].x)) for side, _ in gm.SIDES) / 2
        rows.append({"hipHeadLeanDegrees": math.degrees(math.atan2(-(head.y - hip.y), head.z - hip.z)),
                     "chestLeanDegrees": math.degrees(math.atan2(-(neck.y - chest.y), neck.z - chest.z)),
                     "clavicleSweepDegrees": math.degrees(sweep),
                     "shoulderBehindThoraxAxisMeters": chest_y - shoulders.y,
                     "handForwardFromShoulderMeters": sum(-(H[side + "Hand"].y - H[side + "Arm"].y) for side, _ in gm.SIDES) / 2})
    return {name: {"mean": sum(row[name] for row in rows) / len(rows),
                   "min": min(row[name] for row in rows), "max": max(row[name] for row in rows)} for name in rows[0]}


def periodic_glb_curves(path, names):
    """Add periodic cubic derivatives to dense moving tracks, after unwrapping quaternion hemispheres.

    glTF exporters may flip quaternion signs freely for LINEAR slerp. Component Hermite interpolation
    requires continuous signs before deriving any tangent. No geometry, skin, image or other clip data
    is changed. Dense120Hz values bound inter-key error; independent skinned-shoe QA remains required.
    """
    doc, original_binary, _ = character.read_glb(path)
    binary = bytearray(original_binary)

    def read(index):
        accessor = doc["accessors"][index]
        if accessor["componentType"] != 5126 or "sparse" in accessor:
            raise RuntimeError("periodic interpolation expects ordinary float32 animation accessors")
        width = {"SCALAR": 1, "VEC3": 3, "VEC4": 4}[accessor["type"]]
        view = doc["bufferViews"][accessor["bufferView"]]
        start = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
        stride = view.get("byteStride", width * 4)
        return [list(struct.unpack_from("<" + "f" * width, original_binary, start + i * stride)) for i in range(accessor["count"])]

    converted, unwrapped = 0, 0
    for animation in doc["animations"]:
        if animation["name"] not in names:
            continue
        paths = {channel["sampler"]: channel["target"]["path"] for channel in animation["channels"]}
        for sampler_index, sampler in enumerate(animation["samplers"]):
            if sampler.get("interpolation", "LINEAR") != "LINEAR":
                raise RuntimeError("dense export must use LINEAR channels before periodic conversion")
            times, values = [row[0] for row in read(sampler["input"])], read(sampler["output"])
            if paths[sampler_index] == "rotation":
                for i in range(1, len(values)):
                    if sum(a * b for a, b in zip(values[i - 1], values[i])) < 0:
                        values[i] = [-component for component in values[i]]
                        unwrapped += 1
            if len(times) < 2 or max(abs(a - b) for a, b in zip(values[0], values[-1])) > 1e-5:
                raise RuntimeError("a selected channel does not form a closed, sign-continuous quaternion loop")
            tangents = []
            for i in range(len(times)):
                if i in (0, len(times) - 1):
                    left, right = len(times) - 2, 1
                    span = times[-1] - times[-2] + times[1] - times[0]
                else:
                    left, right, span = i - 1, i + 1, times[i + 1] - times[i - 1]
                tangents.append([(b - a) / span for a, b in zip(values[left], values[right])])
            while len(binary) % 4:
                binary.append(0)
            start = len(binary)
            for value, tangent in zip(values, tangents):
                for row in (tangent, value, tangent):
                    binary.extend(struct.pack("<" + "f" * len(row), *row))
            old_output = doc["accessors"][sampler["output"]]
            view_index = len(doc["bufferViews"])
            doc["bufferViews"].append({"buffer": 0, "byteOffset": start, "byteLength": len(binary) - start})
            sampler["output"] = len(doc["accessors"])
            doc["accessors"].append({"bufferView": view_index, "componentType": 5126, "count": len(values) * 3, "type": old_output["type"]})
            sampler["interpolation"] = "CUBICSPLINE"
            converted += 1
    doc["buffers"][0]["byteLength"] = len(binary)
    doc["asset"]["generator"] += "; Helsinki120Hz hemisphere-continuous periodic locomotion"
    encoded = json.dumps(doc, separators=(",", ":")).encode()
    encoded += b" " * ((-len(encoded)) % 4)
    binary.extend(b"\0" * ((-len(binary)) % 4))
    result = struct.pack("<III", 0x46546C67, 2, 28 + len(encoded) + len(binary))
    result += struct.pack("<II", len(encoded), 0x4E4F534A) + encoded
    result += struct.pack("<II", len(binary), 0x004E4942) + binary
    path.write_bytes(result)
    return {"convertedSamplers": converted, "quaternionSamplesUnwrapped": unwrapped,
            "policy": "120Hz sampled values; quaternion hemispheres unwrapped before central periodic tangent derivation; matching boundary tangents"}


def bake_action(rig, name, poses, frame_step):
    old = bpy.data.actions.get(name)
    character.set_action(rig, None)
    if old:
        bpy.data.actions.remove(old)
    action = bpy.data.actions.new(name)
    action.slots.new(id_type="OBJECT", name=rig.name)
    character.set_action(rig, action)
    previous, drift = {}, 0
    for frame, (Q, H, _) in enumerate(poses):
        sample_frame = frame * frame_step
        for bone_name, basis in character.pose_bases(rig, Q, H).items():
            bone = rig.pose.bones[bone_name]
            bone.rotation_mode = "QUATERNION"
            rotation = basis.to_quaternion()
            if bone_name in previous and previous[bone_name].dot(rotation) < 0:
                rotation.negate()
            previous[bone_name] = rotation.copy()
            bone.rotation_quaternion = rotation
            bone.keyframe_insert("rotation_quaternion", frame=sample_frame, group=bone_name)
            if bone.parent is None:
                bone.location = basis.translation
                bone.keyframe_insert("location", frame=sample_frame, group=bone_name)
            else:
                drift = max(drift, basis.translation.length)
    if drift > 1e-4:
        raise RuntimeError(f"{name}: child-joint rest offset drift {drift} m")
    character.linear_keys(action)
    action.use_fake_user = True
    action.use_frame_range = True
    action.frame_start, action.frame_end = 0, (len(poses) - 1) * frame_step
    return drift


def ledger_file(ledger, path):
    record = next((entry for entry in ledger["files"] if entry["path"] == path.name), None)
    if record is None or record["sha256"] != sha(path) or record["bytes"] != path.stat().st_size:
        raise RuntimeError(f"source ledger mismatch: {path.name}")
    return record


def render_posture_views(glb, output, variant):
    """Re-import the actual export and capture every eighth cycle from front and side.

    These offline contact sheets inspect pose/deformation only. They do not establish runtime camera,
    locomotion blending or playable controls. Original source scenes have already been saved elsewhere.
    """
    import review_game_character as review

    if output.exists():
        raise RuntimeError("review output must be new")
    output.mkdir(parents=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.fps = 30
    camera = review.setup_scene(scene)
    scene.cycles.samples = 4
    tile = 384
    scene.render.resolution_x = scene.render.resolution_y = tile
    bpy.ops.import_scene.gltf(filepath=str(glb), bone_heuristic="BLENDER", guess_original_bind_pose=False)
    rigs = [obj for obj in bpy.data.objects if obj.type == "ARMATURE"]
    if len(rigs) != 1:
        raise RuntimeError("review export must contain one character rig")
    rig = rigs[0]
    phases = [index / 8 for index in range(8)]
    views = [("front", 0), ("side", 90)]
    captures = []
    for clip in ("walk", "run", "sprint"):
        action = bpy.data.actions.get(clip)
        review.set_action(rig, action)
        end_frame = float(action.frame_range[1])
        images = []
        for row, (view, angle) in enumerate(views):
            for column, phase in enumerate(phases):
                frame = phase * end_frame
                scene.frame_set(math.floor(frame), subframe=frame % 1)
                review.aim_camera(camera, angle, 0.9, 3.6)
                path = output / f"{variant}-{clip}-{view}-p{column}.png"
                review.render(scene, path)
                images.append((row, column, path))
                captures.append(path.name)
        width, height = tile * len(phases), tile * len(views)
        pixels = array.array("f", [0.0]) * (width * height * 4)
        for row, column, path in images:
            image = bpy.data.images.load(str(path), check_existing=False)
            source = array.array("f", [0.0]) * (tile * tile * 4)
            image.pixels.foreach_get(source)
            for y in range(tile):
                start = (((len(views) - row - 1) * tile + y) * width + column * tile) * 4
                pixels[start:start + tile * 4] = source[y * tile * 4:(y + 1) * tile * 4]
            bpy.data.images.remove(image)
        sheet = bpy.data.images.new(f"{variant}-{clip}-cycle", width=width, height=height, alpha=True)
        sheet.pixels.foreach_set(pixels)
        sheet.filepath_raw = str(output / f"{variant}-{clip}-cycle.png")
        sheet.file_format = "PNG"
        sheet.save()
        bpy.data.images.remove(sheet)
    (output / "review.json").write_text(json.dumps({"glb": str(glb), "glbSha256": sha(glb),
                                                  "phasesLeftToRight": phases, "rowsTopToBottom": [name for name, _ in views],
                                                  "renders": captures, "status": "CAPTURED_NOT_YET_REVIEWED"}, indent=2), encoding="utf-8")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--root-motion-source", type=Path)
    parser.add_argument("--ledger", required=True, type=Path)
    parser.add_argument("--contract", required=True, type=Path)
    parser.add_argument("--motion-contract", type=Path, default=Path(__file__).resolve().parents[2] / "content/assets/locomotion.motion.json")
    parser.add_argument("--variant", required=True, choices=("snow", "rain"))
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--review-out", type=Path)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
    for key in ("input", "source", "ledger", "contract", "motion_contract", "out"):
        setattr(args, key, getattr(args, key).resolve())
    if args.review_out:
        args.review_out = args.review_out.resolve()
    args.root_motion_source = (args.root_motion_source or args.source.with_stem(args.source.stem + "_RM")).resolve()
    if args.out.exists():
        raise RuntimeError("--out must be a new directory; existing source/output scenes are never overwritten")
    if args.input.suffix.lower() != ".blend":
        raise RuntimeError("--input must be the project's generated .blend")
    ledger = json.loads(args.ledger.read_text(encoding="utf-8"))
    if ledger["source"]["license"] != "CC0-1.0":
        raise RuntimeError("this motion pass expects the recorded CC0 source pack")
    source_record, rm_record = ledger_file(ledger, args.source), ledger_file(ledger, args.root_motion_source)
    contract = json.loads(args.contract.read_text(encoding="utf-8"))
    motion = json.loads(args.motion_contract.read_text(encoding="utf-8"))
    source, source_rm = retarget.MotionGlb(args.source), retarget.MotionGlb(args.root_motion_source)
    log("source GLB decoded as transform data; no source scripts or scene objects imported")
    bpy.ops.wm.open_mainfile(filepath=str(args.input), load_ui=False, use_scripts=False)
    rigs = [obj for obj in bpy.data.objects if obj.type == "ARMATURE"]
    if len(rigs) != 1 or set(rigs[0].data.bones.keys()) != set(gm.JOINTS):
        raise RuntimeError("input must contain the one generated 22-joint game rig")
    rig = rigs[0]
    names = {clip["name"] for clip in motion["clips"]}
    if {a.name for a in bpy.data.actions} != {clip["name"] for clip in contract["clips"]}:
        raise RuntimeError("input action set differs from the character contract")
    character.set_action(rig, None)
    character.rest_pose(rig)
    bpy.context.scene.frame_set(0)
    bpy.context.view_layer.update()
    before = preserved_hashes(rig, names)
    solver = retarget.Retargeter(rig, source)
    report = {"schemaVersion": 1, "id": f"character-{args.variant}", "status": "EXPORTED_PENDING_INDEPENDENT_VISUAL_AND_RUNTIME_QA",
              "blender": bpy.app.version_string, "input": {"path": str(args.input), "sha256": sha(args.input)},
              "motionSource": {**ledger["source"], "path": str(args.source), **source_record,
                               "rootMotionFile": rm_record, "ledgerSha256": sha(args.ledger)},
              "motionContractSha256": sha(args.motion_contract), "sourceLegMeters": solver.source_leg,
              "pipelineSha256": {Path(__file__).name: sha(__file__), "locomotion_retarget.py": sha(Path(__file__).with_name("locomotion_retarget.py"))},
              "targetLegMeters": solver.skel.leg, "targetSourceLegRatio": solver.scale,
              "posturePolicy": motion["posturePolicy"],
              "retargetMethod": motion["retarget"], "clips": {},
              "shoeFit": {side: {"shoeVertices": len(solver.feet[side]), "heelMarkers": len(solver.markers[side]["heel"]),
                                 "toeMarkers": len(solver.markers[side]["toe"])} for side, _ in gm.SIDES},
              "limits": ["target shoe floor fit uses actual linear-blend-skinned vertices; source baseline measurements use skeletal support proxies",
                         "foot pitch/clearance and recovery are analytical adaptations; target torso baseline receives bounded source dynamics, arms are body-frame retargeted",
                         "loop pose and velocity are solver-space measurements; verify exported GLB and actual runtime",
                         "aim/fire/hit/death/drive/arrested/idle remain the original generated actions"]}
    fps = int(motion["authoringFps"])
    sample_hz = int(motion["sampleFps"])
    bpy.context.scene.render.fps = fps
    all_samples = {}
    for clip in motion["clips"]:
        name, source_name, speed = clip["name"], clip["sourceClip"], clip["movementSpeed"]
        duration = source.duration(source_name)
        travel = source_rm.sample(source_name, duration)["root"].translation - source_rm.sample(source_name, 0)["root"].translation
        stride = travel.length
        if stride < 0.1 or travel.dot(Vector((0, -1, 0))) / stride < 0.999:
            raise RuntimeError(f"{source_name}: RM translation does not prove -Y Blender/+Z glTF forward")
        fit = retarget.contact_fit(source, source_name)
        target_stride = fit["sourceSupportStrideMeters"] * solver.scale
        frames = max(4, round(clip["seconds"] * sample_hz))
        seconds = frames / sample_hz
        baseline = sample_target_baseline(rig, name, seconds, sample_hz)
        adapter = retarget.MotionAdapter(solver, source_name, seconds, speed, clip["supportDuty"], clip["footLiftMeters"], clip["strikePitchDegrees"],
                                         clip["clearanceExponent"], clip["pelvisReachSmoothingMeters"], baseline, motion["posturePolicy"])
        offset = adapter.offset
        source_samples = [source.sample(source_name, ((i / frames + offset) % 1) * duration) for i in range(frames)]
        source_samples.append(source_samples[0])
        poses = [adapter.pose(i / frames) for i in range(frames)]
        poses.append(poses[0])
        baseline_posture, target_posture = posture_metrics(baseline), posture_metrics(poses)
        posture_delta = {key: target_posture[key]["mean"] - baseline_posture[key]["mean"] for key in baseline_posture}
        posture_limits = motion["posturePolicy"]["numericProbeLimits"]
        for key, limit in posture_limits.items():
            if abs(posture_delta[key]) > limit:
                raise RuntimeError(f"{name}: target baseline posture changed {key} by {posture_delta[key]}, limit {limit}")
        child_drift = bake_action(rig, name, poses, fps / sample_hz)
        lengths = []
        for _, H, _ in poses:
            for parent, child in gm.CHAIN.items():
                lengths.append(abs((H[child] - H[parent]).length - solver.skel.length[parent]))
        supports = [solver.supports(Q, H) for Q, H, _ in poses]
        source_feet = [source_supports(source, sample) for sample in source_samples]
        entry = {"sourceClip": source_name, "sourceSeconds": duration, "sourceRootTravelBlenderMeters": vec(travel),
                 "sourceStrideMeters": stride, "sourceRootMotionSpeedMps": stride / duration,
                 "sourceSupportFit": fit,
                 "phaseOffset": offset, "phaseZero": motion["phase"], "movementSpeed": speed,
                 "frames": [0, seconds * fps], "fps": fps, "sampleHz": sample_hz, "sampleCount": len(poses), "seconds": seconds,
                 "scaledSourceStrideMeters": target_stride, "runtimeStrideMeters": speed * seconds,
                 "sourceSupportDuty": adapter.source_duty, "targetSupportDuty": clip["supportDuty"],
                 "adaptation": "target original torso/clavicle balance plus bounded mean-relative source dynamics; source arm swing aligned to target torso; analytical C1 feet fit actual shoes to controller speed and natural cadence",
                 "postureComparison": {"baseline": baseline_posture, "repaired": target_posture, "meanDelta": posture_delta,
                                        "numericProbeLimits": posture_limits, "status": "NUMERIC_PROBES_PASS_VISUAL_REVIEW_REQUIRED"},
                 "maxIkRequestedReachRatio": max(max(diag["legReach"].values()) for _, _, diag in poses),
                 "ankleHeightCorrectionRangeMeters": [min(min(diag["ankleHeightCorrection"].values()) for _, _, diag in poses),
                                                      max(max(diag["ankleHeightCorrection"].values()) for _, _, diag in poses)],
                 "minimumActualSkinnedShoeHeightMeters": min(min(diag["actualShoeMinimumMeters"].values()) for _, _, diag in poses),
                 "maxBoneLengthErrorMeters": max(lengths), "maxChildRestOffsetDriftMeters": child_drift,
                 "loop": loop_metrics(poses, seconds), "targetSupport": support_metrics(supports, seconds, speed),
                 "sourceSupportAtRootMotionSpeed": support_metrics(source_feet, duration, stride / duration)}
        report["clips"][name] = entry
        all_samples[name] = {"seconds": seconds, "samples": [{"phase": i / frames, "hips": vec(H["Hips"]),
                                         "leftAnkle": vec(H["LeftFoot"]), "rightAnkle": vec(H["RightFoot"])}
                                        for i, (_, H, _) in enumerate(poses)]}
        log(name, json.dumps({key: entry[key] for key in ("seconds", "sourceStrideMeters", "phaseOffset", "maxIkRequestedReachRatio")}))
    character.set_action(rig, None)
    character.rest_pose(rig)
    bpy.context.scene.frame_set(0)
    bpy.context.view_layer.update()
    after = preserved_hashes(rig, names)
    if before != after:
        raise RuntimeError("non-locomotion data changed: " + json.dumps({key: [before[key], after[key]] for key in before if before[key] != after[key]}))
    report["preservedDataSha256"] = before
    report["preservation"] = "mesh/UV/weights/materials/rest skeleton/sockets/seven other action fingerprints match input"
    args.out.mkdir(parents=True, exist_ok=False)
    blend = args.out / f"character-{args.variant}.blend"
    bpy.ops.wm.save_as_mainfile(filepath=str(blend), compress=True)
    for obj in bpy.data.objects:
        obj.select_set(obj.type in ("ARMATURE", "MESH") or obj.name.startswith("SOCKET_"))
    bpy.context.view_layer.objects.active = rig
    glb = args.out / f"character-{args.variant}.glb"
    variant = next(v for v in contract["variants"] if v["id"] == f"character-{args.variant}")
    bpy.ops.export_scene.gltf(
        filepath=str(glb), export_format="GLB", use_selection=True, export_yup=True, export_apply=True,
        export_normals=True, export_texcoords=True, export_tangents=False, export_vertex_color="NONE",
        export_materials="EXPORT", export_image_format="JPEG", export_jpeg_quality=85, export_extras=False,
        export_cameras=False, export_lights=False, export_skins=True, export_all_influences=False, export_influence_nb=4,
        export_def_bones=False, export_armature_object_remove=False, export_rest_position_armature=True,
        export_animations=True, export_animation_mode="ACTIONS", export_force_sampling=False, export_frame_step=1,
        export_frame_range=False, export_anim_single_armature=True, export_optimize_animation_size=True,
        export_optimize_animation_keep_anim_armature=True, export_reset_pose_bones=True, export_morph=False,
        export_leaf_bone=False, export_hierarchy_flatten_bones=False,
        export_copyright=variant["credit"] + "; " + ledger["source"]["attribution"])
    cubic_names = {clip["name"] for clip in motion["clips"] if clip["interpolation"] == "CUBICSPLINE"}
    report["interpolation"] = periodic_glb_curves(glb, cubic_names)
    report["interpolation"]["blendSource"] = "saved blend retains dense120Hz LINEAR source keys; periodic cubic output shares all sampled poses"
    report["outputs"] = {"blend": {"file": blend.name, "sha256": sha(blend)},
                         "glb": {"file": glb.name, "sha256": sha(glb), "bytes": glb.stat().st_size}}
    summary = character.glb_summary(glb)
    report["exportedClips"] = summary["animations"]
    if {a["name"] for a in summary["animations"]} != {c["name"] for c in contract["clips"]}:
        raise RuntimeError("export did not preserve exactly the ten contract clips")
    for entry in summary["animations"]:
        if entry["name"] in report["clips"]:
            if abs(entry["seconds"] - report["clips"][entry["name"]]["seconds"]) > 1e-3:
                raise RuntimeError("export duration differs from the keyed locomotion")
    (args.out / "motion-report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    (args.out / "motion-samples.json").write_text(json.dumps(all_samples, indent=2), encoding="utf-8")
    original_report = args.input.parent / "blender-report.json"
    if original_report.is_file():
        native = json.loads(original_report.read_text(encoding="utf-8"))
        asset = native["assets"][f"character-{args.variant}"]
        asset["glb"] = {"path": glb.name, **{key: summary[key] for key in ("bytes", "sha256", "generator")}}
        asset["blend"] = blend.name
        asset["status"] = report["status"]
        asset["motionProvenance"] = {"motionReport": "motion-report.json", "source": report["motionSource"],
                                     "pipelineSha256": report["pipelineSha256"], "motionContractSha256": report["motionContractSha256"]}
        for name, entry in report["clips"].items():
            asset["clips"][name].update({key: entry[key] for key in ("frames", "fps", "seconds", "movementSpeed")})
            asset["clips"][name].update({"exportedSeconds": entry["seconds"], "sourceClip": entry["sourceClip"],
                                         "source": ledger["source"]["id"], "supportDuty": entry["targetSupportDuty"]})
        (args.out / "blender-report.json").write_text(json.dumps({"schemaVersion": 1, "kind": "blender-report",
                                                                  "assets": {asset["id"]: asset}}, indent=2), encoding="utf-8")
    log("saved locomotion-only candidate", args.out)
    if args.review_out:
        render_posture_views(glb, args.review_out, args.variant)
        log("exported GLB cycle contact sheets captured for review", args.review_out)


if __name__ == "__main__":
    main()
