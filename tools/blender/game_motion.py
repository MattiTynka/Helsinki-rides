"""Procedural clips for the 22-joint game skeleton of content/assets/character.contract.json.

Runs inside Blender (mathutils only). The skeleton is data: joint rest positions come from the source
rig, so the same clip definitions serve every humanoid. Conventions are Blender's: metres, +Z up, the
character faces -Y, +X is its left. The glTF exporter (export_yup) maps this to the contract's +Z forward.

A pose gives every joint a world ("armature-space") delta rotation Q about its rest head and the posed
head position H from forward kinematics: a rest point p carried by joint j moves to Q_j (p - rest_j) + H_j.
Locomotion is in place: stance feet slide backwards at the clip speed in the root frame, legs are placed
by two-bone IK, and the hips height is solved from leg reach (inverted-pendulum rise and fall).
"""
import math

from mathutils import Matrix, Vector

FPS = 30
LEFT, RIGHT = "Left", "Right"
SIDES = ((LEFT, 1.0), (RIGHT, -1.0))
DEG = math.pi / 180.0
I3 = Matrix.Identity(3)

JOINTS = ["Hips", "Spine", "Spine1", "Spine2", "Neck", "Head",
          "LeftShoulder", "LeftArm", "LeftForeArm", "LeftHand",
          "RightShoulder", "RightArm", "RightForeArm", "RightHand",
          "LeftUpLeg", "LeftLeg", "LeftFoot", "LeftToeBase",
          "RightUpLeg", "RightLeg", "RightFoot", "RightToeBase"]
PARENT = {"Hips": None, "Spine": "Hips", "Spine1": "Spine", "Spine2": "Spine1", "Neck": "Spine2", "Head": "Neck"}
for _s in (LEFT, RIGHT):
    PARENT.update({f"{_s}Shoulder": "Spine2", f"{_s}Arm": f"{_s}Shoulder", f"{_s}ForeArm": f"{_s}Arm",
                   f"{_s}Hand": f"{_s}ForeArm", f"{_s}UpLeg": "Hips", f"{_s}Leg": f"{_s}UpLeg",
                   f"{_s}Foot": f"{_s}Leg", f"{_s}ToeBase": f"{_s}Foot"})
# The child that defines a joint's rest direction (bone axis).
CHAIN = {"Spine": "Spine1", "Spine1": "Spine2", "Spine2": "Neck", "Neck": "Head"}
for _s in (LEFT, RIGHT):
    CHAIN.update({f"{_s}Shoulder": f"{_s}Arm", f"{_s}Arm": f"{_s}ForeArm", f"{_s}ForeArm": f"{_s}Hand",
                  f"{_s}UpLeg": f"{_s}Leg", f"{_s}Leg": f"{_s}Foot", f"{_s}Foot": f"{_s}ToeBase"})


# --- Math -------------------------------------------------------------------------------------------------

def V(*a):
    return Vector(a)


def unit(v):
    v = Vector(v)
    return v.normalized() if v.length > 1e-12 else v


def rot(axis, angle):
    return Matrix.Rotation(angle, 3, unit(axis))


def rx(a):
    return Matrix.Rotation(a, 3, "X")


def ry(a):
    return Matrix.Rotation(a, 3, "Y")


def rz(a):
    return Matrix.Rotation(a, 3, "Z")


def ypr(yaw, pitch, roll):
    """Yaw about +Z (positive turns left), pitch about +X (positive leans forward), roll about +Y."""
    return rz(yaw) @ rx(pitch) @ ry(roll)


def arc(a, b):
    """Shortest rotation taking direction a to direction b."""
    a, b = unit(a), unit(b)
    if a.length < 1e-9 or b.length < 1e-9:
        return I3.copy()
    return a.rotation_difference(b).to_matrix()


def slerp(m0, m1, t):
    return m0.to_quaternion().slerp(m1.to_quaternion(), t).to_matrix()


def smooth(t):
    t = min(1.0, max(0.0, t))
    return t * t * (3.0 - 2.0 * t)


def smoother(t):
    t = min(1.0, max(0.0, t))
    return t * t * t * (t * (6.0 * t - 15.0) + 10.0)


def lerp_value(a, b, u):
    if isinstance(a, (int, float)):
        return a + (b - a) * u
    return tuple(x + (y - x) * u for x, y in zip(a, b))


def keyed(keys):
    """Per-parameter eased interpolation through key poses [(t, {param: value})]: a parameter is keyed only
    where a key names it, holds before its first and after its last key."""
    names = set().union(*(params for _, params in keys))
    tracks = {n: sorted((t, p[n]) for t, p in keys if n in p) for n in names}

    def at(t):
        out = {}
        for n, track in tracks.items():
            if t <= track[0][0]:
                out[n] = track[0][1]
                continue
            if t >= track[-1][0]:
                out[n] = track[-1][1]
                continue
            for (t0, v0), (t1, v1) in zip(track, track[1:]):
                if t0 <= t <= t1:
                    out[n] = lerp_value(v0, v1, smoother((t - t0) / (t1 - t0)))
                    break
        return out
    return at


def two_bone(root, target, l1, l2, pole):
    """Middle joint of a two-bone chain from root toward target bending toward pole; (joint, reach)."""
    d_vec = target - root
    d = d_vec.length
    reach = d / (l1 + l2)
    dc = min(max(d, abs(l1 - l2) + 1e-4), (l1 + l2) * (1 - 1e-6))
    u = d_vec / d
    a = (l1 * l1 - l2 * l2 + dc * dc) / (2 * dc)
    h = math.sqrt(max(l1 * l1 - a * a, 0.0))
    w = unit(pole - u * pole.dot(u))
    return root + u * a + w * h, reach


def hang_dirs(side, abduct, swing, bend, inward):
    """Upper-arm and forearm directions (torso frame): hanging abducted, swung forward (positive) about the
    lateral axis, elbow bent toward the front and slightly toward the body."""
    sx = 1.0 if side == LEFT else -1.0
    up = rx(-swing) @ V(sx * math.sin(abduct), 0.0, -math.cos(abduct))
    fwd = unit(V(-sx * inward, -1.0, 0.0))
    axis = unit(up.cross(fwd))
    return up, rot(axis, bend) @ up


# --- Skeleton -----------------------------------------------------------------------------------------------

class Skeleton:
    """Rest heads of the 22 joints (armature space) plus the toe tips."""

    def __init__(self, heads, toe_tips, heel_back=0.04):
        self.R = {j: Vector(heads[j]) for j in JOINTS}
        self.tip = {s: Vector(toe_tips[s]) for s, _ in SIDES}
        self.length = {j: (self.R[c] - self.R[j]).length for j, c in CHAIN.items()}
        self.leg = self.length["LeftUpLeg"] + self.length["LeftLeg"]
        self.arm = self.length["LeftArm"] + self.length["LeftForeArm"]
        # Ground contact of the heel per side (lowest rearmost sole point) in the rest pose.
        self.heel = {s: V(self.R[f"{s}Foot"].x, self.R[f"{s}Foot"].y + heel_back, 0.0) for s, _ in SIDES}

    def rest_dir(self, j):
        return unit(self.R[CHAIN[j]] - self.R[j])

    # --- Pose solver ---------------------------------------------------------------------------------
    def solve(self, spec):
        R, Q, H = self.R, {}, {}
        diag = {"legReach": {}, "armReach": {}}

        def place(name, q):
            parent = PARENT[name]
            H[name] = Vector(spec["hips_pos"]) if parent is None else Q[parent] @ (R[name] - R[parent]) + H[parent]
            Q[name] = q

        def joint(name):
            parent = PARENT[name]
            return Q[parent] @ (R[name] - R[parent]) + H[parent]

        place("Hips", Matrix(spec["hips_q"]))
        place("Spine", Q["Hips"] @ spec.get("spine", I3))
        place("Spine1", Q["Spine"] @ spec.get("spine1", I3))
        place("Spine2", Q["Spine1"] @ spec.get("spine2", I3))
        place("Neck", Q["Spine2"] @ spec.get("neck", I3))
        place("Head", Q["Neck"] @ spec.get("head", I3))
        torso = Q["Spine2"]
        for side, sx in SIDES:
            arm = spec["arms"][side]
            sh, ua, fa, hd = f"{side}Shoulder", f"{side}Arm", f"{side}ForeArm", f"{side}Hand"
            place(sh, torso @ arm.get("shoulder", I3))
            if "dirs" in arm:
                up, fore = (torso @ Vector(v) for v in arm["dirs"])
            else:
                up, fore = (torso @ v for v in hang_dirs(side, *arm["hang"]))
            weight = arm.get("ik", 0.0)
            if weight > 0:
                j = joint(ua)
                wrist = Vector(arm["wrist"])
                elbow, reach = two_bone(j, wrist, self.length[ua], self.length[fa], unit(arm["pole"]))
                diag["armReach"][side] = reach
                up = unit(up.lerp(unit(elbow - j), weight)) if weight < 1 else unit(elbow - j)
                fore = unit(fore.lerp(unit(wrist - elbow), weight)) if weight < 1 else unit(wrist - elbow)
            place(ua, arc(Q[sh] @ self.rest_dir(ua), up) @ Q[sh])
            qf = arc(Q[ua] @ self.rest_dir(fa), fore) @ Q[ua]
            if arm.get("twist"):
                qf = rot(fore, arm["twist"]) @ qf
            place(fa, qf)
            place(hd, Matrix(arm.get("wrist_rot", I3)) @ Q[fa])
        for side, sx in SIDES:
            leg = spec["legs"][side]
            th, sh, ft, toe = f"{side}UpLeg", f"{side}Leg", f"{side}Foot", f"{side}ToeBase"
            hip = joint(th)
            ankle = Vector(leg["ankle"])
            knee, reach = two_bone(hip, ankle, self.length[th], self.length[sh], unit(leg.get("pole", V(0.0, -1.0, 0.0))))
            diag["legReach"][side] = reach
            place(th, arc(Q["Hips"] @ self.rest_dir(th), knee - hip) @ Q["Hips"])
            place(sh, arc(Q[th] @ self.rest_dir(sh), ankle - knee) @ Q[th])
            place(ft, Matrix(leg["foot_q"]))
            place(toe, Matrix(leg["toe_q"]))
        return Q, H, diag

    def point(self, Q, H, joint, rest_point):
        return Q[joint] @ (Vector(rest_point) - self.R[joint]) + H[joint]

    # --- Feet ----------------------------------------------------------------------------------------
    def foot_on_ground(self, side, ball_y, theta, toe_relax=35 * DEG):
        """Ankle position and foot/toe rotations for a stance foot whose ball joint ground track is at
        ball_y. theta > 0 lifts the heel pivoting about the ball; theta < 0 rolls the foot on its heel."""
        A, B, Hl = self.R[f"{side}Foot"], self.R[f"{side}ToeBase"], self.heel[side]
        r = rx(theta)
        if theta < 0:
            heel = V(Hl.x, ball_y + (Hl.y - B.y), 0.0)
            return heel + r @ (A - Hl), r, r
        ball = V(B.x, ball_y, B.z)
        return ball + r @ (A - B), r, rx(max(0.0, theta - toe_relax))

    def flat_foot(self, side, x, y, z=0.0, theta=0.0, toe=0.0, yaw=0.0):
        """Leg spec for a foot whose ankle ground point sits at (x, y, z), pitched theta about the ankle."""
        rf = rz(yaw) @ rx(theta)
        ankle = V(x, y, z + self.R[f"{side}Foot"].z)
        return {"ankle": ankle, "foot_q": rf, "toe_q": rf @ rx(toe)}


# --- Locomotion ---------------------------------------------------------------------------------------------

GAITS = {
    "walk": dict(seconds=1.0, speed=1.4, duty=0.60, lift=0.06, lift_peak=0.4, strike=0.5,
                 theta=[(0.0, -12), (0.10, 0), (0.36, 0), (0.60, 46)], bob=(0.012, -1.0), drop=0.045,
                 yaw=5, roll=3, sway=0.014, lean=2, head=2,
                 arms=dict(abduct=10, swing=18, bend=(12, 14), inward=0.15)),
    "run": dict(seconds=0.7, speed=3.6, duty=0.36, lift=0.20, lift_peak=0.4, strike=0.46,
                theta=[(0.0, 6), (0.10, 0), (0.22, 8), (0.36, 60)], bob=(0.02, 1.0), drop=0.05,
                yaw=7, roll=3, sway=0.010, lean=7, head=-2,
                arms=dict(abduct=12, swing=30, bend=(78, 12), inward=0.3)),
    "sprint": dict(seconds=0.6, speed=6.0, duty=0.26, lift=0.30, lift_peak=0.4, strike=0.42,
                   theta=[(0.0, 8), (0.07, 4), (0.18, 14), (0.26, 66)], bob=(0.025, 1.0), drop=0.065,
                   yaw=9, roll=3, sway=0.008, lean=12, head=-5,
                   arms=dict(abduct=12, swing=44, bend=(86, 8), inward=0.4)),
}


def curve(points, periodic_wrap=None):
    """Piecewise eased interpolation through [(x, y)] sorted by x; holds outside."""
    points = sorted(points)

    def f(x):
        if x <= points[0][0]:
            return points[0][1]
        if x >= points[-1][0]:
            return points[-1][1]
        for (x0, y0), (x1, y1) in zip(points, points[1:]):
            if x0 <= x <= x1:
                return y0 + (y1 - y0) * smooth((x - x0) / (x1 - x0))
        return points[-1][1]
    return f


class Gait:
    """One locomotion cycle; the left foot strikes at phase 0, the right at 0.5."""

    def __init__(self, skel, name, params):
        self.s, self.name, self.p = skel, name, params
        self.n = int(round(params["seconds"] * FPS))
        self.cycle = self.n / FPS
        self.v = params["speed"]
        self.beta = params["duty"]
        self.theta = curve([(x, y * DEG) for x, y in params["theta"]])
        self.travel = self.v * self.cycle * self.beta  # root-frame distance a stance foot slides
        self.height = self.solve_height()

    def ball_strike_y(self, side):
        return self.s.R[f"{side}ToeBase"].y - self.travel * self.p["strike"]

    def stance(self, side, psi):
        return self.s.foot_on_ground(side, self.ball_strike_y(side) + self.travel * psi / self.beta, self.theta(psi))

    def foot(self, side, phi):
        """(ankle, foot_q, toe_q, stance_theta) at cycle phase phi; theta is None in swing."""
        psi = (phi - (0.0 if side == LEFT else 0.5)) % 1.0
        if psi < self.beta:
            ankle, qf, qt = self.stance(side, psi)
            return ankle, qf, qt, self.theta(psi)
        u = (psi - self.beta) / (1.0 - self.beta)
        a_off, _, _ = self.stance(side, self.beta)
        a_hs, _, _ = self.stance(side, 0.0)
        ankle = a_off.lerp(a_hs, smoother(u))
        k = math.log(0.5) / math.log(self.p["lift_peak"])
        ankle.z += self.p["lift"] * math.sin(math.pi * u ** k) ** 2
        th_off, th_hs = self.theta(self.beta), self.theta(0.0)
        th = th_off * (1.0 - smoother(u / 0.5)) + th_hs * smoother((u - 0.55) / 0.45)
        return ankle, rx(th), rx(th), None

    def pelvis(self, phi):
        p = self.p
        mid = self.beta / 2
        yaw = -p["yaw"] * DEG * math.cos(2 * math.pi * phi)
        roll = -p["roll"] * DEG * math.cos(2 * math.pi * (phi - mid))
        x = p["sway"] * math.cos(2 * math.pi * (phi - mid))
        return V(x, 0.0, 0.0), ypr(yaw, p["lean"] * DEG, roll), yaw

    def max_heights(self):
        """Highest hips height per frame that keeps each leg within its reach limit."""
        s, out = self.s, []
        r = 0.985 * s.leg
        for f in range(self.n):
            phi = f / self.n
            pos, q, _ = self.pelvis(phi)
            limits = []
            for side, _ in SIDES:
                ankle = self.foot(side, phi)[0]
                off = q @ (s.R[f"{side}UpLeg"] - s.R["Hips"])
                dxy = math.hypot(pos.x + off.x - ankle.x, pos.y + off.y - ankle.y)
                limits.append(ankle.z - off.z + math.sqrt(r * r - dxy * dxy) if dxy < r else 0.0)
            out.append(min(limits))
        return out

    def solve_height(self):
        amp, sign = self.p["bob"]
        base = self.s.R["Hips"].z - self.p["drop"]
        mid = self.beta / 2
        limit = self.max_heights()
        h = [min(base + sign * amp * math.cos(4 * math.pi * (f / self.n - mid)), limit[f]) for f in range(self.n)]
        for _ in range(6):  # circular smoothing, then push below the limit again
            h = [(h[(f - 1) % self.n] + 2 * h[f] + h[(f + 1) % self.n]) / 4 for f in range(self.n)]
            h = [min(h[f], limit[f]) for f in range(self.n)]
        return h

    def spec(self, frame):
        p, a = self.p, self.p["arms"]
        f = frame % self.n
        phi = f / self.n
        pos, hq, yaw = self.pelvis(phi)
        pos = pos + V(0.0, 0.0, self.height[f])
        legs = {}
        for side, sx in SIDES:
            ankle, qf, qt, _ = self.foot(side, phi)
            legs[side] = {"ankle": ankle, "foot_q": qf, "toe_q": qt, "pole": rz(yaw) @ V(sx * 0.15, -1.0, 0.0)}
        arms = {}
        for side, _ in SIDES:
            swing = a["swing"] * DEG * math.cos(2 * math.pi * (phi - (0.5 if side == LEFT else 0.0)))
            bend = (a["bend"][0] + a["bend"][1] * (0.5 + 0.5 * swing / (a["swing"] * DEG))) * DEG
            arms[side] = {"hang": (a["abduct"] * DEG, swing, bend, a["inward"])}
        return {"hips_pos": pos, "hips_q": hq, "spine": ypr(-0.6 * yaw, 0.3 * p["lean"] * DEG, 0.0),
                "spine2": ypr(-0.5 * yaw, 0.2 * p["lean"] * DEG, 0.0), "head": rx(p["head"] * DEG),
                "arms": arms, "legs": legs}


# --- Keyed clips --------------------------------------------------------------------------------------------

class Clips:
    def __init__(self, skel, aim_twist=90 * DEG):
        self.s = skel
        s = skel
        hips = s.R["Hips"]
        self.stand = {
            "hips": (hips.x, hips.y, hips.z - 0.008), "hips_rot": (0.0, 2 * DEG, 0.0), "spine_rot": (0.0, 0.0, 0.0),
            "chest_rot": (0.0, -1 * DEG, 0.0), "head_rot": (0.0, 1 * DEG, 0.0),
            "ankle.Left": (s.R["LeftFoot"].x + 0.015, s.R["LeftFoot"].y - 0.01, 0.0),
            "ankle.Right": (s.R["RightFoot"].x - 0.015, s.R["RightFoot"].y + 0.015, 0.0),
            "foot.Left": 0.0, "foot.Right": 0.0, "toe.Left": 0.0, "toe.Right": 0.0,
            "footyaw.Left": 6 * DEG, "footyaw.Right": -6 * DEG,
            "pole.Left": (0.15, -1.0, 0.0), "pole.Right": (-0.15, -1.0, 0.0),
            "arm.Left": (10 * DEG, 0.0, 12 * DEG, 0.15), "arm.Right": (10 * DEG, 0.0, 12 * DEG, 0.15),
            "ik.Left": 0.0, "ik.Right": 0.0, "twist.Left": 0.0, "twist.Right": 0.0,
        }
        chest_z = s.R["RightArm"].z
        self.aim_twist = aim_twist
        reach = s.arm  # grip distances scale with the arm so every figure keeps a slight elbow bend
        self.aim = {**self.stand,
                    "hips_rot": (-6 * DEG, 3 * DEG, 0.0), "spine_rot": (-6 * DEG, 0.0, 0.0), "chest_rot": (-8 * DEG, 2 * DEG, 0.0),
                    "head_rot": (16 * DEG, 0.0, 0.0),
                    "ik.Right": 1.0, "ik.Left": 1.0,
                    "grip.Right": (-0.045, -0.86 * reach, chest_z - 0.01), "grip.Left": (0.035, -0.78 * reach, chest_z - 0.035),
                    "elbow.Right": (-0.7, 0.1, -1.0), "elbow.Left": (0.8, 0.1, -0.9),
                    "twist.Right": aim_twist, "twist.Left": -aim_twist,
                    "wrist.Right": (0.0, 0.0, 0.0), "wrist.Left": (0.0, -10 * DEG, 0.0)}
        leg = s.leg
        hip_dz = s.R["LeftUpLeg"].z - s.R["Hips"].z
        az = s.R["LeftFoot"].z
        drive_dz = (-0.5 + az) - hip_dz
        drive_dy = -math.sqrt(max(0.05, (0.93 * leg) ** 2 - drive_dz ** 2 - 0.05 ** 2))
        self.seated = {
            "hips": (0.0, 0.0, 0.0), "hips_rot": (0.0, -16 * DEG, 0.0), "spine_rot": (0.0, 6 * DEG, 0.0),
            "chest_rot": (0.0, 6 * DEG, 0.0), "head_rot": (0.0, 2 * DEG, 0.0),
            "ankle.Left": (s.R["LeftUpLeg"].x + 0.05, drive_dy, -0.5), "ankle.Right": (s.R["RightUpLeg"].x - 0.05, drive_dy + 0.03, -0.49),
            "foot.Left": -25 * DEG, "foot.Right": -30 * DEG, "footyaw.Left": 6 * DEG, "footyaw.Right": -4 * DEG,
            "toe.Left": 0.0, "toe.Right": 0.0,
            "pole.Left": (0.2, -0.3, 1.0), "pole.Right": (-0.2, -0.3, 1.0),
            "arm.Left": (14 * DEG, 40 * DEG, 60 * DEG, 0.3), "arm.Right": (14 * DEG, 40 * DEG, 60 * DEG, 0.3),
            "ik.Left": 1.0, "ik.Right": 1.0,
            "grip.Left": (0.17, -0.33, 0.47), "grip.Right": (-0.17, -0.33, 0.47),
            "elbow.Left": (0.7, 0.3, -1.0), "elbow.Right": (-0.7, 0.3, -1.0),
            "twist.Left": -40 * DEG, "twist.Right": 40 * DEG,
        }

    # --- spec from keyed parameters ------------------------------------------------------------------
    def spec_from(self, p):
        s, legs, arms = self.s, {}, {}
        for side, sx in SIDES:
            x, y, z = p[f"ankle.{side}"]
            legs[side] = s.flat_foot(side, x, y, z, p[f"foot.{side}"], p[f"toe.{side}"], p.get(f"footyaw.{side}", 0.0))
            legs[side]["pole"] = Vector(p[f"pole.{side}"])
            arm = {"ik": float(p.get(f"ik.{side}", 0.0)), "twist": float(p.get(f"twist.{side}", 0.0))}
            if f"dirs.{side}" in p:
                d = p[f"dirs.{side}"]
                arm["dirs"] = (unit(d[:3]), unit(d[3:]))
            else:
                arm["hang"] = tuple(p[f"arm.{side}"])
            if arm["ik"] > 0:
                arm["wrist"] = Vector(p[f"grip.{side}"])
                arm["pole"] = Vector(p[f"elbow.{side}"])
            if f"wrist.{side}" in p:
                arm["wrist_rot"] = ypr(*p[f"wrist.{side}"])
            arms[side] = arm
        return {"hips_pos": Vector(p["hips"]), "hips_q": ypr(*p["hips_rot"]), "spine": ypr(*p["spine_rot"]),
                "spine2": ypr(*p["chest_rot"]), "head": ypr(*p["head_rot"]), "arms": arms, "legs": legs}

    def idle(self, frame, n=60):
        phi = frame / n
        sn, cs = math.sin(2 * math.pi * phi), math.cos(2 * math.pi * phi)
        p = dict(self.stand)
        hx, hy, hz = self.stand["hips"]
        p["hips"] = (hx + 0.008 * sn, hy, hz - 0.003 * (1 - cs))
        p["hips_rot"] = (0.02 * sn, 2 * DEG, -0.015 * sn)
        p["spine_rot"] = (-0.01 * sn, 0.0, 0.01 * sn)
        p["chest_rot"] = (0.0, -1 * DEG - 1.2 * DEG * math.sin(2 * math.pi * phi + 0.6), 0.003 * sn)
        p["head_rot"] = (0.06 * math.sin(2 * math.pi * (phi + 0.15)), 1 * DEG + 1 * DEG * cs, 0.0)
        p["arm.Left"] = (10 * DEG + 0.01 * sn, 1.5 * DEG * cs, 12 * DEG, 0.15)
        p["arm.Right"] = (10 * DEG - 0.01 * sn, -1.5 * DEG * cs, 12 * DEG, 0.15)
        return self.spec_from(p)

    def aim_spec(self, frame, n=30):
        phi = frame / n
        p = dict(self.aim)
        breath = math.sin(2 * math.pi * phi)
        p["chest_rot"] = (-8 * DEG, 2 * DEG - 0.6 * DEG * breath, 0.0)
        gx, gy, gz = self.aim["grip.Right"]
        p["grip.Right"] = (gx, gy, gz + 0.003 * breath)
        gx, gy, gz = self.aim["grip.Left"]
        p["grip.Left"] = (gx, gy, gz + 0.003 * breath)
        return self.spec_from(p)

    def fire_curve(self):
        a = self.aim
        gr, gl = a["grip.Right"], a["grip.Left"]
        return keyed([
            (0.0, dict(a)),
            (0.25, {"grip.Right": (gr[0], gr[1] + 0.035, gr[2] + 0.02), "grip.Left": (gl[0], gl[1] + 0.03, gl[2] + 0.015),
                    "wrist.Right": (0.0, -14 * DEG, 0.0), "wrist.Left": (0.0, -20 * DEG, 0.0),
                    "chest_rot": (-8 * DEG, -1 * DEG, 0.0), "head_rot": (16 * DEG, -3 * DEG, 0.0)}),
            (1.0, dict(a)),
        ])

    def hit_curve(self):
        st = self.stand
        hx, hy, hz = st["hips"]
        return keyed([
            (0.0, dict(st)),
            (0.3, {"hips": (hx, hy + 0.04, hz - 0.02), "hips_rot": (0.0, -8 * DEG, 0.0), "spine_rot": (0.0, -8 * DEG, 0.0),
                   "chest_rot": (0.0, -8 * DEG, 0.0), "head_rot": (0.0, -16 * DEG, 0.0),
                   "arm.Left": (28 * DEG, 30 * DEG, 70 * DEG, 0.3), "arm.Right": (28 * DEG, 30 * DEG, 70 * DEG, 0.3)}),
            (1.0, dict(st)),
        ])

    def death_curve(self):
        st, s = self.stand, self.s
        hx, hy, hz = st["hips"]
        ax, ay, _ = st["ankle.Left"]
        bx, by, _ = st["ankle.Right"]
        lying = {"hips": (0.0, hy + 0.20, 0.11), "hips_rot": (0.0, -82 * DEG, 0.0), "spine_rot": (0.0, -4 * DEG, 0.0),
                 "chest_rot": (0.0, -3 * DEG, 0.0), "head_rot": (0.0, 14 * DEG, 0.0),
                 "ankle.Left": (ax + 0.03, hy - 0.60, 0.07), "ankle.Right": (bx - 0.03, hy - 0.57, 0.07),
                 "foot.Left": -55 * DEG, "foot.Right": -50 * DEG, "footyaw.Left": 12 * DEG, "footyaw.Right": -10 * DEG,
                 "pole.Left": (0.2, -0.3, 1.0), "pole.Right": (-0.2, -0.3, 1.0),
                 "arm.Left": (45 * DEG, 10 * DEG, 20 * DEG, 0.1), "arm.Right": (55 * DEG, -5 * DEG, 25 * DEG, 0.1)}
        return keyed([
            (0.0, dict(st)),
            (0.2, {"hips": (hx, hy + 0.02, hz - 0.14), "hips_rot": (0.0, 14 * DEG, 0.0), "spine_rot": (0.0, 8 * DEG, 0.0),
                   "head_rot": (0.0, 10 * DEG, 0.0),
                   "arm.Left": (24 * DEG, 24 * DEG, 40 * DEG, 0.2), "arm.Right": (24 * DEG, 18 * DEG, 40 * DEG, 0.2)}),
            (0.5, {"hips": (hx, hy + 0.10, 0.34), "hips_rot": (0.0, -30 * DEG, 0.0), "spine_rot": (0.0, -8 * DEG, 0.0),
                   "chest_rot": (0.0, -6 * DEG, 0.0), "head_rot": (0.0, -8 * DEG, 0.0),
                   "ankle.Left": (ax + 0.02, ay - 0.08, 0.0), "ankle.Right": (bx - 0.02, by + 0.03, 0.0),
                   "foot.Left": -20 * DEG, "foot.Right": 0.0,
                   "pole.Left": (0.2, -1.0, 0.4), "pole.Right": (-0.2, -1.0, 0.4),
                   "arm.Left": (40 * DEG, 20 * DEG, 30 * DEG, 0.1), "arm.Right": (45 * DEG, 10 * DEG, 30 * DEG, 0.1)}),
            (0.82, dict(lying)),
            (1.0, {**lying, "hips": (0.0, hy + 0.20, 0.10), "head_rot": (6 * DEG, 12 * DEG, 0.0)}),
        ])

    def drive(self, frame, n=60):
        phi = frame / n
        sn = math.sin(2 * math.pi * phi)
        p = dict(self.seated)
        p["hips_rot"] = (0.0, -16 * DEG, 0.004 * sn)
        p["chest_rot"] = (0.0, 6 * DEG - 0.6 * DEG * math.sin(2 * math.pi * phi + 1.0), 0.0)
        p["head_rot"] = (0.04 * math.sin(2 * math.pi * (phi + 0.3)), 2 * DEG, 0.0)
        return self.spec_from(p)

    def arrested(self, frame, n=60):
        phi = frame / n
        sn = math.sin(2 * math.pi * phi)
        p = dict(self.stand)
        p["hips_rot"] = (0.01 * sn, 1 * DEG, 0.0)
        p["chest_rot"] = (0.0, -2 * DEG - 0.8 * DEG * math.sin(2 * math.pi * phi + 0.5), 0.0)
        p["head_rot"] = (0.0, -3 * DEG, 0.0)
        for side, sx in SIDES:
            p[f"dirs.{side}"] = (sx * 0.88, -0.30, 0.30 + 0.02 * sn, sx * 0.12, -0.25, 1.0)
            p[f"twist.{side}"] = -sx * 25 * DEG
        return self.spec_from(p)

    # --- registry ------------------------------------------------------------------------------------
    def specs(self):
        """name -> (frames, loop, spec(frame)); gaits included."""
        gaits = {name: Gait(self.s, name, params) for name, params in GAITS.items()}
        fire, hit, death = self.fire_curve(), self.hit_curve(), self.death_curve()
        clips = {
            "idle": (60, True, lambda f: self.idle(f, 60)),
            "walk": (gaits["walk"].n, True, gaits["walk"].spec),
            "run": (gaits["run"].n, True, gaits["run"].spec),
            "sprint": (gaits["sprint"].n, True, gaits["sprint"].spec),
            "aim": (30, True, lambda f: self.aim_spec(f, 30)),
            "fire": (8, False, lambda f: self.spec_from(fire(f / 8))),
            "hit": (15, False, lambda f: self.spec_from(hit(f / 15))),
            "death": (42, False, lambda f: self.spec_from(death(f / 42))),
            "drive": (60, True, lambda f: self.drive(f, 60)),
            "arrested": (60, True, lambda f: self.arrested(f, 60)),
        }
        return clips, gaits


def bake(skel, clips, name):
    """Solved poses for frames 0..frames of a clip (loops end on frame 0's pose), plus diagnostics."""
    frames, loop, fn = clips[name]
    poses, diags = [], []
    for f in range(frames + 1):
        Q, H, diag = skel.solve(fn(0 if (loop and f == frames) else f))
        poses.append((Q, H))
        diags.append(diag)
    return poses, diags
