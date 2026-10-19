"""Data-only glTF sampling and world-space humanoid retargeting; imported by retarget_locomotion.py.

No source meshes, scripts, drivers or Blender add-ons are imported. The source GLB is decoded as bounded
JSON/accessor data. Source directions and pelvis motion drive the target body; adapted gait controls
drive its feet. Two-bone IK preserves target bone lengths instead of copying local Euler channels.
"""
import bisect
import json
import math
import statistics
import struct
from pathlib import Path

from mathutils import Matrix, Quaternion, Vector

import game_motion as gm

MAPPING = {
    "Hips": "pelvis", "Spine": "spine_01", "Spine1": "spine_02", "Spine2": "spine_03",
    "Neck": "neck_01", "Head": "Head",
}
for _side, _suffix in (("Left", "l"), ("Right", "r")):
    MAPPING.update({f"{_side}Shoulder": f"clavicle_{_suffix}", f"{_side}Arm": f"upperarm_{_suffix}",
                    f"{_side}ForeArm": f"lowerarm_{_suffix}", f"{_side}Hand": f"hand_{_suffix}",
                    f"{_side}UpLeg": f"thigh_{_suffix}", f"{_side}Leg": f"calf_{_suffix}",
                    f"{_side}Foot": f"foot_{_suffix}", f"{_side}ToeBase": f"ball_{_suffix}"})

# glTF: +Y up, +Z forward (proved independently by RM root displacement). Blender: +Z up, -Y forward.
GLTF_TO_BLENDER = Matrix(((1, 0, 0, 0), (0, 0, -1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))


class MotionGlb:
    def __init__(self, path):
        raw = Path(path).read_bytes()
        if len(raw) > 32 * 1024 * 1024:
            raise ValueError("motion GLB exceeds the 32 MiB input limit")
        magic, version, length = struct.unpack_from("<III", raw)
        if (magic, version, length) != (0x46546C67, 2, len(raw)):
            raise ValueError("invalid GLB header")
        self.doc, self.binary = None, None
        cursor = 12
        while cursor < len(raw):
            size, kind = struct.unpack_from("<II", raw, cursor)
            cursor += 8
            if cursor + size > len(raw):
                raise ValueError("truncated GLB chunk")
            chunk = raw[cursor:cursor + size]
            cursor += size
            if kind == 0x4E4F534A:
                self.doc = json.loads(chunk)
            elif kind == 0x004E4942:
                self.binary = chunk
        if self.doc is None or self.binary is None:
            raise ValueError("GLB must contain JSON and binary chunks")
        if any(buffer.get("uri") for buffer in self.doc.get("buffers", [])):
            raise ValueError("external motion buffers are forbidden")
        self.nodes = self.doc["nodes"]
        self.names = {node["name"]: i for i, node in enumerate(self.nodes) if "name" in node}
        self.parents = {child: parent for parent, node in enumerate(self.nodes) for child in node.get("children", [])}
        self.animations = {a["name"]: a for a in self.doc["animations"]}
        self.cache = {}
        self.rest = self.sample(None, 0)

    def accessor(self, index):
        if index in self.cache:
            return self.cache[index]
        accessor = self.doc["accessors"][index]
        if accessor["componentType"] != 5126 or "sparse" in accessor or accessor.get("normalized"):
            raise ValueError("motion channels require ordinary float32 accessors")
        width = {"SCALAR": 1, "VEC3": 3, "VEC4": 4}[accessor["type"]]
        view = self.doc["bufferViews"][accessor["bufferView"]]
        if view.get("buffer", 0) != 0:
            raise ValueError("motion must use its embedded GLB buffer")
        stride = view.get("byteStride", width * 4)
        start = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
        if start + max(0, accessor["count"] - 1) * stride + width * 4 > len(self.binary):
            raise ValueError("motion accessor exceeds its binary buffer")
        values = [struct.unpack_from("<" + "f" * width, self.binary, start + i * stride)
                  for i in range(accessor["count"])]
        if any(not math.isfinite(value) for row in values for value in row):
            raise ValueError("motion accessor contains non-finite values")
        self.cache[index] = values
        return values

    def duration(self, name):
        return max(self.accessor(s["input"])[-1][0] for s in self.animations[name]["samplers"])

    def value(self, sampler, time, path):
        times = self.accessor(sampler["input"])
        values = self.accessor(sampler["output"])
        if sampler.get("interpolation", "LINEAR") not in ("LINEAR", "STEP"):
            raise ValueError("unsupported motion interpolation")
        right = min(len(times) - 1, bisect.bisect_right(times, (time,)))
        left = max(0, right - 1)
        span = times[right][0] - times[left][0]
        u = max(0, min(1, (time - times[left][0]) / span)) if span > 0 else 0
        if sampler.get("interpolation") == "STEP":
            u = 0
        if path == "rotation":
            a, b = values[left], values[right]
            q = Quaternion((a[3], a[0], a[1], a[2])).slerp(Quaternion((b[3], b[0], b[1], b[2])), u)
            return q
        return Vector(values[left]).lerp(Vector(values[right]), u)

    def sample(self, name, time):
        channels = {}
        if name is not None:
            animation = self.animations[name]
            for channel in animation["channels"]:
                path, index = channel["target"]["path"], channel["target"]["node"]
                if path not in ("translation", "rotation", "scale"):
                    raise ValueError("unexpected non-transform motion channel")
                channels[index, path] = self.value(animation["samplers"][channel["sampler"]], time, path)
        worlds = {}

        def world(index):
            if index in worlds:
                return worlds[index]
            node = self.nodes[index]
            if "matrix" in node:
                if any((index, path) in channels for path in ("translation", "rotation", "scale")):
                    raise ValueError("animated matrix nodes are unsupported")
                values = node["matrix"]
                local = Matrix(tuple(tuple(values[column * 4 + row] for column in range(4)) for row in range(4)))
            else:
                xyz = node.get("rotation", (0, 0, 0, 1))
                rotation = channels.get((index, "rotation"), Quaternion((xyz[3], xyz[0], xyz[1], xyz[2])))
                local = Matrix.LocRotScale(channels.get((index, "translation"), Vector(node.get("translation", (0, 0, 0)))),
                                          rotation, channels.get((index, "scale"), Vector(node.get("scale", (1, 1, 1)))))
            worlds[index] = world(self.parents[index]) @ local if index in self.parents else local
            return worlds[index]

        return {node_name: GLTF_TO_BLENDER @ world(index) for node_name, index in self.names.items()}

    def sample_smooth(self, name, time):
        """Small periodic, hemisphere-corrected rotation/trajectory filter; no seam endpoint dwell."""
        duration = self.duration(name)
        weights = (1, 4, 6, 4, 1)
        poses = [self.sample(name, (time + (i - 2) / 60) % duration) for i in range(5)]
        output = {}
        for bone in self.names:
            center = poses[2][bone].to_quaternion()
            quaternions = []
            for pose in poses:
                rotation = pose[bone].to_quaternion()
                if center.dot(rotation) < 0:
                    rotation.negate()
                quaternions.append(rotation)
            rotation = Quaternion(tuple(sum(q[component] * weight for q, weight in zip(quaternions, weights)) / 16
                                        for component in range(4)))
            rotation.normalize()
            matrix = rotation.to_matrix().to_4x4()
            matrix.translation = sum((pose[bone].translation * weight for pose, weight in zip(poses, weights)), Vector()) / 16
            output[bone] = matrix
        return output


def mean(values):
    return sum(values) / len(values)


def quaternion_angle(a, b):
    return a.to_quaternion().rotation_difference(b.to_quaternion()).angle


def anatomical_frame(heads):
    """Anatomical axes, independent of either rig's bone-roll conventions: left/back/up."""
    up = gm.unit(heads["Neck"] - heads["Spine2"])
    left = heads["LeftShoulder"] - heads["RightShoulder"]
    left = gm.unit(left - up * left.dot(up))
    back = gm.unit(up.cross(left))
    return Matrix((left, back, up)).transposed()


def mean_rotation(matrices):
    reference = matrices[0].to_quaternion()
    quaternions = [matrix.to_quaternion() for matrix in matrices]
    for rotation in quaternions:
        if reference.dot(rotation) < 0:
            rotation.negate()
    rotation = Quaternion(tuple(sum(q[c] for q in quaternions) / len(quaternions) for c in range(4)))
    rotation.normalize()
    return rotation.to_matrix()


def limit_rotation(matrix, degrees):
    """Smoothly bounded angular displacement; no hard clamp discontinuity at the cap."""
    rotation = matrix.to_quaternion()
    if rotation.w < 0:
        rotation.negate()
    axis, angle = rotation.to_axis_angle()
    cap = math.radians(degrees)
    return Quaternion(axis, cap * math.tanh(angle / cap)).to_matrix() if angle > 1e-8 else Matrix.Identity(3)


def source_supports(source, sample):
    result = {}
    for side, suffix in (("Left", "l"), ("Right", "r")):
        foot, toe, tip = f"foot_{suffix}", f"ball_{suffix}", f"ball_leaf_{suffix}"
        ankle, ball, end = (source.rest[name].translation for name in (foot, toe, tip))
        heel = Vector((ankle.x, ankle.y + 0.04, 0))
        foot_delta = sample[foot].to_quaternion().to_matrix() @ source.rest[foot].to_quaternion().to_matrix().inverted()
        toe_delta = sample[toe].to_quaternion().to_matrix() @ source.rest[toe].to_quaternion().to_matrix().inverted()
        result[side] = [sample[foot].translation + foot_delta @ (point - ankle)
                        for point in (heel, Vector((ball.x, ball.y, 0)))]
        result[side].append(sample[toe].translation + toe_delta @ (Vector((end.x, end.y, 0)) - ball))
    return result


def contact_fit(source, clip, samples=480):
    """Estimate travel from low, vertically stable source supports, independent of the RM root track."""
    duration = source.duration(clip)
    dt = duration / samples
    feet = [source_supports(source, source.sample(clip, i * dt)) for i in range(samples)]
    velocities = []
    for i in range(samples):
        for side, _ in gm.SIDES:
            marker = min(range(3), key=lambda p: feet[i][side][p].z)
            point = feet[i][side][marker]
            velocity = (feet[(i + 1) % samples][side][marker] - feet[(i - 1) % samples][side][marker]) / (2 * dt)
            if point.z < 0.015 and abs(velocity.z) < 0.25 and velocity.y > 0:
                velocities.append(velocity.y)
    if len(velocities) < 6:
        raise RuntimeError(f"{clip}: insufficient stable near-ground source support samples")
    speed = statistics.median(velocities)
    return {"sourceSupportSpeedMps": speed, "sourceSupportStrideMeters": speed * duration,
            "sampleCount": len(velocities), "sourceSupportSpeedRangeMps": [min(velocities), max(velocities)],
            "method": "median rearward velocity of lowest heel/ball/toe marker below1.5cm, vertical speed<0.25m/s"}


class Retargeter:
    def __init__(self, rig, source):
        self.source, self.rig = source, rig
        self.rest = source.rest
        self.skel = gm.Skeleton({name: rig.data.bones[name].head_local for name in gm.JOINTS},
                                {side: rig.data.bones[f"{side}ToeBase"].tail_local for side, _ in gm.SIDES})
        source_leg = sum((self.rest[MAPPING[b]].translation - self.rest[MAPPING[a]].translation).length
                         for a, b in (("LeftUpLeg", "LeftLeg"), ("LeftLeg", "LeftFoot")))
        self.scale = self.skel.leg / source_leg
        self.source_leg = source_leg
        self.feet = {side: [] for side, _ in gm.SIDES}
        for obj in rig.users_scene[0].objects:
            if obj.type != "MESH":
                continue
            transform = rig.matrix_world.inverted() @ obj.matrix_world
            groups = {group.index: group.name for group in obj.vertex_groups}
            for vertex in obj.data.vertices:
                point = transform @ vertex.co
                influences = [(groups[group.group], group.weight) for group in vertex.groups if group.weight > 1e-8]
                for side, _ in gm.SIDES:
                    weight = sum(weight for name, weight in influences if name in (side + "Foot", side + "ToeBase"))
                    if weight >= 0.5 and point.z <= 0.12:
                        self.feet[side].append({"point": point, "influences": influences})
        self.markers = {}
        for side, _ in gm.SIDES:
            vertices = self.feet[side]
            if not vertices:
                raise RuntimeError(f"{side}: no target shoe vertices")
            minimum = min(vertex["point"].z for vertex in vertices)
            sole = [vertex for vertex in vertices if vertex["point"].z <= minimum + 0.01]
            back, front = max(vertex["point"].y for vertex in sole), min(vertex["point"].y for vertex in sole)
            heel = [vertex for vertex in sole if vertex["point"].y >= back - 0.2 * (back - front)]
            toe = [vertex for vertex in sole if vertex["point"].y <= front + 0.2 * (back - front)]
            self.markers[side] = {"heel": heel, "toe": toe}

    def skin(self, vertex, Q, H):
        return sum(((Q[name] @ (vertex["point"] - self.skel.R[name]) + H[name]) * weight
                    for name, weight in vertex["influences"]), Vector())

    def marker(self, side, name, Q, H):
        vertices = self.markers[side][name]
        return sum((self.skin(vertex, Q, H) for vertex in vertices), Vector()) / len(vertices)

    def marker_rest(self, side, name):
        vertices = self.markers[side][name]
        return sum((vertex["point"] for vertex in vertices), Vector()) / len(vertices)

    def world_delta(self, name, sample):
        source_name = MAPPING[name]
        return sample[source_name].to_quaternion().to_matrix() @ self.rest[source_name].to_quaternion().to_matrix().inverted()

    def rotation(self, name, sample):
        """World-space swing plus source twist, corrected for the target's different bind axes/pose."""
        source_name = MAPPING[name]
        delta = self.world_delta(name, sample)
        # Absolute source clavicle/spine directions encode the source model's anatomy. Applying those
        # directions to Snow/Rain overwrites their rest posture (e.g. -38deg vs -3deg collarbone sweep).
        # These joints accept motion deltas only; the active posture adapter supplies the target baseline.
        if name in ("Hips", "Spine", "Spine1", "Spine2", "Neck", "Head", "LeftShoulder", "RightShoulder"):
            return delta
        child = gm.CHAIN.get(name)
        if child is None:
            return delta
        rest_dir = self.rest[MAPPING[child]].translation - self.rest[source_name].translation
        posed_dir = sample[MAPPING[child]].translation - sample[source_name].translation
        source_swing = gm.arc(rest_dir, posed_dir)
        twist = delta @ source_swing.inverted()
        return twist @ gm.arc(self.skel.rest_dir(name), posed_dir)

    def pose(self, sample, ankle_y=None, foot_controls=None, posture=None, _corrections=None, _iteration=0):
        R, Q, H = self.skel.R, {}, {}
        source_hips = sample["pelvis"].translation
        rest_hips = self.rest["pelvis"].translation
        root = Vector(posture["root"]) if posture else R["Hips"] + self.scale * (source_hips - rest_hips)
        reach = {}
        hips_rotation = posture["rotations"]["Hips"] if posture else self.rotation("Hips", sample)
        source_feet = source_supports(self.source, sample)
        goals, height_corrections = {}, {}
        root_limits = [root.z]
        for side, _ in gm.SIDES:
            foot, toe, thigh = side + "Foot", side + "ToeBase", side + "UpLeg"
            ankle = R[foot] + self.scale * (sample[MAPPING[foot]].translation - self.rest[MAPPING[foot]].translation)
            control = foot_controls[side] if foot_controls else None
            foot_rotation = control["foot_q"] if control else self.world_delta(foot, sample)
            toe_rotation = control["toe_q"] if control else self.world_delta(toe, sample)
            toe_head = ankle + foot_rotation @ (R[toe] - R[foot])
            ball, tip = R[toe].copy(), self.skel.tip[side].copy()
            ball.z = tip.z = 0
            supports = [ankle + foot_rotation @ (point - R[foot]) for point in (self.skel.heel[side], ball)]
            supports.append(toe_head + toe_rotation @ (tip - R[toe]))
            # Preserve source swing clearance while adapting different ankle heights, shoe sizes and toe
            # pivots. A source support below its floor is treated as contact rather than copied penetration.
            clearance = control["clearance"] if control else max(0, min(point.z for point in source_feet[side])) * self.scale
            correction = clearance - min(point.z for point in supports)
            ankle.z += correction
            if ankle_y is not None:
                ankle.y = ankle_y[side]
            if _corrections:
                ankle += _corrections[side]
            height_corrections[side] = correction
            goals[side] = ankle
            hip_offset = hips_rotation @ (R[thigh] - R["Hips"])
            hip = root + hip_offset
            horizontal = math.hypot(hip.x - ankle.x, hip.y - ankle.y)
            length = (self.skel.length[thigh] + self.skel.length[side + "Leg"]) * 0.995
            if horizontal >= length:
                raise RuntimeError("source ankle trajectory exceeds the target's horizontal leg reach")
            root_limits.append(ankle.z + math.sqrt(length * length - horizontal * horizontal) - hip_offset.z)
        smoothing = foot_controls["Left"].get("reach_smoothing", 0) if foot_controls else 0
        minimum = min(root_limits)
        root.z = minimum - smoothing * math.log(sum(math.exp(-(height - minimum) / smoothing) for height in root_limits)) if smoothing else minimum

        def place(name, rotation):
            parent = gm.PARENT[name]
            H[name] = root.copy() if parent is None else H[parent] + Q[parent] @ (R[name] - R[parent])
            Q[name] = rotation

        for name in ("Hips", "Spine", "Spine1", "Spine2", "Neck", "Head"):
            place(name, posture["rotations"][name] if posture else self.rotation(name, sample))
        for side, _ in gm.SIDES:
            for suffix in ("Shoulder", "Arm", "ForeArm", "Hand"):
                name = side + suffix
                place(name, posture["rotations"][name] if posture else self.rotation(name, sample))
            thigh, shin, foot, toe = (side + suffix for suffix in ("UpLeg", "Leg", "Foot", "ToeBase"))
            hip = H["Hips"] + Q["Hips"] @ (R[thigh] - R["Hips"])
            ankle = goals[side]
            source_thigh, source_knee = sample[MAPPING[thigh]].translation, sample[MAPPING[shin]].translation
            source_ankle = sample[MAPPING[foot]].translation
            along = gm.unit(source_ankle - source_thigh)
            pole = source_knee - source_thigh
            pole -= along * pole.dot(along)
            if pole.length < 1e-6:
                pole = Vector((0, -1, 0))
            # Keep the anatomical knee plane stable when the source approaches a straight leg, where
            # its tiny pole offset becomes ill-conditioned. Source lateral articulation contributes25%.
            forward = hips_rotation @ Vector((0, -1, 0))
            pole = gm.unit(forward * 0.75 + gm.unit(pole) * 0.25)
            knee, reach[side] = gm.two_bone(hip, ankle, self.skel.length[thigh], self.skel.length[shin], gm.unit(pole))
            place(thigh, gm.arc(Q["Hips"] @ self.skel.rest_dir(thigh), knee - hip) @ Q["Hips"])
            place(shin, gm.arc(Q[thigh] @ self.skel.rest_dir(shin), ankle - knee) @ Q[thigh])
            # Both shoes have a horizontal sole at bind even though ankle-to-ball axes differ. Preserve
            # the source world-space sole rotation delta, rather than forcing identical bone axes.
            place(foot, foot_controls[side]["foot_q"] if foot_controls else self.world_delta(foot, sample))
            place(toe, foot_controls[side]["toe_q"] if foot_controls else self.world_delta(toe, sample))
        actual_minimum = {side: min(self.skin(vertex, Q, H).z for vertex in self.feet[side]) for side, _ in gm.SIDES}
        errors = {side: (foot_controls[side]["clearance"] if foot_controls else max(0, min(point.z for point in source_feet[side])) * self.scale) - actual_minimum[side]
                  for side, _ in gm.SIDES}
        if _iteration < 5 and max(abs(value) for value in errors.values()) > 2e-5:
            corrections = {side: (_corrections[side].copy() if _corrections else Vector()) + Vector((0, 0, errors[side]))
                           for side, _ in gm.SIDES}
            return self.pose(sample, ankle_y, foot_controls, posture, corrections, _iteration + 1)
        return Q, H, {"legReach": reach, "ankleHeightCorrection": height_corrections,
                      "actualShoeMinimumMeters": actual_minimum, "soleFitIterations": _iteration}

    def supports(self, Q, H):
        return {side: [self.skin(vertex, Q, H) for vertex in self.feet[side]] for side, _ in gm.SIDES}


def phase_offset(source, clip, samples=240):
    """Start every gait at left support entry following its forward-most ankle position."""
    duration = source.duration(clip)
    poses = [source.sample(clip, duration * i / samples) for i in range(samples)]
    # Source forward is Blender -Y. The most forward ankle relative to its pelvis is repeatable across gaits.
    forward = [-(pose["foot_l"].translation.y - pose["pelvis"].translation.y) for pose in poses]
    index = max(range(samples), key=lambda i: forward[i])
    heights = [min(point.z for point in source_supports(source, pose)["Left"]) for pose in poses]
    velocities = [(heights[(i + 1) % samples] - heights[(i - 1) % samples]) * samples / duration / 2 for i in range(samples)]
    entries = [i for i in range(samples) if heights[i] <= 0.003 and abs(velocities[i]) < 0.15
               and (heights[(i - 1) % samples] > 0.003 or abs(velocities[(i - 1) % samples]) >= 0.15)]
    if not entries:
        raise RuntimeError(f"{clip}: no left-foot near-ground support entry")
    strike = min(entries, key=lambda i: (i - index) % samples)
    return strike / samples


def hermite(y0, y1, tangent0, tangent1, u, span):
    return ((2 * u ** 3 - 3 * u ** 2 + 1) * y0 + (u ** 3 - 2 * u ** 2 + u) * tangent0 * span
            + (-2 * u ** 3 + 3 * u ** 2) * y1 + (u ** 3 - u ** 2) * tangent1 * span)


def phase_warp(phase, source_duty, target_duty):
    """Monotone C1 periodic time warp. Left/right strikes stay at0/.5, stance duty changes explicitly."""
    half = math.floor(phase * 2) / 2
    local = phase - half
    source_break = source_duty % 0.5
    target_break = target_duty % 0.5
    if min(source_break, target_break, 0.5 - source_break, 0.5 - target_break) < 1e-4:
        raise RuntimeError("stance duty too close to a half-cycle for the monotone warp")
    slopes = (source_break / target_break, (0.5 - source_break) / (0.5 - target_break))
    tangent = 2 * slopes[0] * slopes[1] / (slopes[0] + slopes[1])
    if local <= target_break:
        return half + hermite(0, source_break, tangent, tangent, local / target_break, target_break)
    span = 0.5 - target_break
    return half + hermite(source_break, 0.5, tangent, tangent, (local - target_break) / span, span)


class MotionAdapter:
    """Keep licensed body/foot-roll motion while fitting supported feet to controller speed/cadence.

    The stance pivot rolls heel-to-toe on a fixed world contact; the swing uses a smooth polynomial
    recovery. Source pelvis, torso, arm and lateral motion are retained. Foot pitch/clearance are
    analytical controls; fixed-length target leg IK and actual skinned-sole fitting follow those controls.
    """
    def __init__(self, solver, clip, seconds, speed, duty, lift, strike_degrees, clearance_exponent, reach_smoothing, baseline, posture_policy):
        self.solver, self.source, self.clip = solver, solver.source, clip
        self.seconds, self.speed, self.duty = seconds, speed, duty
        self.lift, self.strike = lift, math.radians(strike_degrees)
        self.clearance_exponent, self.reach_smoothing = clearance_exponent, reach_smoothing
        self.baseline, self.posture_policy = baseline, posture_policy
        self.duration = self.source.duration(clip)
        self.offset = phase_offset(self.source, clip)
        samples = 480
        height = [min(point.z for point in source_supports(self.source, self.source.sample(
            clip, ((i / samples + self.offset) % 1) * self.duration))["Left"]) for i in range(samples)]
        exits = [i for i in range(1, samples) if i / samples > 0.05 and height[i] > 0.015 >= height[i - 1]]
        if not exits:
            raise RuntimeError(f"{clip}: cannot measure source support exit")
        self.source_duty = exits[0] / samples
        if not 0.08 <= self.source_duty <= 0.85:
            raise RuntimeError(f"{clip}: implausible source support duty {self.source_duty}")
        source_samples = [self.sample(i / 120) for i in range(120)]
        source_frames = [self.source_frame(sample) for sample in source_samples]
        self.source_mean_frame = mean_rotation(source_frames)
        self.source_mean_root = sum((sample["pelvis"].translation for sample in source_samples), Vector()) / len(source_samples)
        self.source_clavicle_means = {side: mean_rotation([frame.inverted() @ sample[MAPPING[side + "Shoulder"]].to_quaternion().to_matrix()
                                                        for frame, sample in zip(source_frames, source_samples)]) for side, _ in gm.SIDES}
        self.target_rest_frame = anatomical_frame(solver.skel.R)
        arm_joints = [side + suffix for side, _ in gm.SIDES for suffix in ("Arm", "ForeArm", "Hand")]
        self.source_arm_means = {name: mean_rotation([frame.inverted() @ solver.rotation(name, sample)
                                                    for frame, sample in zip(source_frames, source_samples)]) for name in arm_joints}
        target_baselines = [self.baseline_pose(i / 120)[0] for i in range(120)]
        self.target_arm_means = {name: mean_rotation([(pose["Spine2"] @ self.target_rest_frame).inverted() @ pose[name]
                                                    for pose in target_baselines]) for name in arm_joints}
        self.raw_cache = {}
        self.anchors, self.sole_span, self.swing = {}, {}, {}
        for side, offset in (("Left", 0), ("Right", 0.5)):
            Q, H, _ = self.raw_pose(offset)
            # A longer target stance must be centred around the hips; retaining the source's short
            # support anchor would push the trailing ankle outside this character's leg reach.
            rest_foot = solver.skel.R[side + "Foot"]
            heel_offset = solver.marker_rest(side, "heel").y - rest_foot.y
            self.anchors[side] = rest_foot.y - speed * seconds * duty / 2 + heel_offset
            self.sole_span[side] = solver.marker_rest(side, "toe").y - solver.marker_rest(side, "heel").y
            epsilon = 1e-4
            front = self.stance_goal(side, 0)
            rear = self.stance_goal(side, duty)
            front_tangent = (self.stance_goal(side, epsilon) - self.stance_goal(side, -epsilon)) / (2 * epsilon)
            rear_tangent = (self.stance_goal(side, duty + epsilon) - self.stance_goal(side, duty - epsilon)) / (2 * epsilon)
            self.swing[side] = (rear, front, rear_tangent, front_tangent)

    def sample(self, phase):
        phase = phase % 1
        source_phase = (phase_warp(phase, self.source_duty, self.duty) + self.offset) % 1
        return self.source.sample_smooth(self.clip, source_phase * self.duration)

    def raw_pose(self, phase):
        key = round(phase % 1, 9)
        if key not in self.raw_cache:
            sample = self.sample(key)
            self.raw_cache[key] = self.solver.pose(sample, foot_controls=self.controls(key, sample), posture=self.posture(key, sample))
        return self.raw_cache[key]

    @staticmethod
    def source_frame(sample):
        return anatomical_frame({name: sample[MAPPING[name]].translation for name in ("Neck", "Spine2", "LeftShoulder", "RightShoulder")})

    def baseline_pose(self, phase):
        frame = (phase % 1) * (len(self.baseline) - 1)
        left, u = math.floor(frame), frame % 1
        right = (left + 1) % (len(self.baseline) - 1)
        qa, ha = self.baseline[left]
        qb, hb = self.baseline[right]
        rotations = {name: qa[name].to_quaternion().slerp(qb[name].to_quaternion(), u).to_matrix() for name in gm.JOINTS}
        return rotations, ha["Hips"].lerp(hb["Hips"], u)

    def posture(self, phase, sample):
        baseline_q, root = self.baseline_pose(phase)
        source_frame = self.source_frame(sample)
        target_frame = baseline_q["Spine2"] @ self.target_rest_frame
        local_variation = self.source_mean_frame.inverted() @ source_frame
        policy, rotations = self.posture_policy, {}
        for name, weight in {"Hips": 0.25, "Spine": 0.35, "Spine1": 0.65, "Spine2": 1.0, "Neck": 0.5, "Head": 0.25}.items():
            variation = limit_rotation(local_variation, policy["torsoDynamicsCapDegrees"] * weight)
            rotations[name] = target_frame @ variation @ target_frame.inverted() @ baseline_q[name]
        adjusted_frame = rotations["Spine2"] @ self.target_rest_frame
        for side, _ in gm.SIDES:
            shoulder = side + "Shoulder"
            clavicle = source_frame.inverted() @ sample[MAPPING[shoulder]].to_quaternion().to_matrix()
            clavicle_delta = limit_rotation(clavicle @ self.source_clavicle_means[side].inverted(), policy["clavicleDynamicsCapDegrees"])
            chest_delta = rotations["Spine2"] @ baseline_q["Spine2"].inverted()
            rotations[shoulder] = adjusted_frame @ clavicle_delta @ adjusted_frame.inverted() @ chest_delta @ baseline_q[shoulder]
            for suffix in ("Arm", "ForeArm", "Hand"):
                name = side + suffix
                source_local = source_frame.inverted() @ self.solver.rotation(name, sample)
                swing = limit_rotation(source_local @ self.source_arm_means[name].inverted(), policy["armDynamicsCapDegrees"])
                # Preserve the target's relaxed/bent arm carriage. Importing an absolute source arm
                # direction would reintroduce the source model's static reach and wrist-rest bias.
                rotations[name] = adjusted_frame @ swing @ self.target_arm_means[name]
        residual = adjusted_frame @ self.source_mean_frame.inverted() @ (sample["pelvis"].translation - self.source_mean_root) * self.solver.scale
        cap = policy["rootDynamicsCapMeters"]
        root += Vector([cap * math.tanh(value / cap) for value in residual])
        return {"root": root, "rotations": rotations}

    def controls(self, phase, sample):
        controls = {}
        forward = self.solver.world_delta("Hips", sample) @ Vector((0, -1, 0))
        pelvis_yaw = math.atan2(forward.x, -forward.y)
        toe_off = math.radians(42)
        for side, offset in (("Left", 0), ("Right", 0.5)):
            local = (phase - offset) % 1
            if local <= self.duty:
                u = local / self.duty
                if u < 0.10:
                    pitch = self.strike * (1 - gm.smoother(u / 0.10))
                elif u < 0.75:
                    pitch = 0
                else:
                    pitch = toe_off * gm.smoother((u - 0.75) / 0.25)
                toe_pitch = min(0, pitch)
                clearance = 0
            else:
                u = (local - self.duty) / (1 - self.duty)
                pitch = toe_off + (self.strike - toe_off) * gm.smoother(u) - math.radians(35) * math.sin(math.pi * u) ** 3
                toe_pitch = pitch * gm.smoother(u / 0.20)
                if self.strike > 0:
                    toe_pitch *= 1 - gm.smoother((u - 0.80) / 0.20)
                clearance = self.lift * math.sin(math.pi * u) ** self.clearance_exponent
            yaw = pelvis_yaw + math.radians(3 if side == "Left" else -3)
            controls[side] = {"foot_q": gm.rz(yaw) @ gm.rx(pitch), "toe_q": gm.rz(yaw) @ gm.rx(toe_pitch),
                              "clearance": clearance, "reach_smoothing": self.reach_smoothing}
        return controls

    def stance_goal(self, side, local_phase):
        global_phase = local_phase + (0 if side == "Left" else 0.5)
        Q, H, _ = self.raw_pose(global_phase)
        # Heel pivot early in support, toe pivot after the heel lifts; both anchors retain sole length.
        blend = gm.smooth((local_phase / self.duty - 0.25) / 0.40)
        pivot = self.solver.marker(side, "heel", Q, H).lerp(self.solver.marker(side, "toe", Q, H), blend)
        desired = self.anchors[side] + self.speed * self.seconds * local_phase + self.sole_span[side] * blend
        return H[side + "Foot"].y + desired - pivot.y

    def pose(self, phase):
        phase = phase % 1
        goals = {}
        for side, offset in (("Left", 0), ("Right", 0.5)):
            local = (phase - offset) % 1
            if local <= self.duty:
                goals[side] = self.stance_goal(side, local)
            else:
                rear, front, rear_tangent, front_tangent = self.swing[side]
                span = 1 - self.duty
                time = local - self.duty
                turn = min(0.04, span * 0.2)
                back = rear + rear_tangent * turn / 2
                forward = front - front_tangent * turn / 2
                if time < turn:
                    u = time / turn
                    goals[side] = rear + rear_tangent * turn * (u - u ** 3 + u ** 4 / 2)
                elif time > span - turn:
                    u = (time - (span - turn)) / turn
                    goals[side] = forward + front_tangent * turn * (u ** 3 - u ** 4 / 2)
                else:
                    goals[side] = back + (forward - back) * gm.smoother((time - turn) / (span - 2 * turn))
        sample = self.sample(phase)
        return self.solver.pose(sample, goals, self.controls(phase, sample), self.posture(phase, sample))
