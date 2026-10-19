"""Procedural motion for the courier character (character-courier-v1): skeleton, pose solver and clips.

Pure numpy, no Blender: build_character.py bakes these poses into actions, and the unit tests check the
planner without Blender. Conventions are Blender's: metres, +Z up, the character faces -Y, +X is its left.

A pose gives every bone a world ("armature-space") delta rotation Q about its head plus its posed head
position from forward kinematics: a rest point p of bone b moves to Q_b (p - head_rest_b) + head_b. Bone
roll therefore never enters the planner; build_character.py converts poses to Blender's local bases.

Locomotion is in place (the game's capsule owns displacement). Stance feet are planted by construction:
each stance foot rolls about a ground-fixed pivot (heel, then the ball joint, then the toe tip) while the
root-frame footprint slides backwards at the clip speed, and two-bone IK places thigh and shin. The pelvis
height is solved from leg reach, which gives walking its inverted-pendulum rise and fall.
"""
import math

import numpy as np

FPS = 60
SIDES = (("L", 1.0), ("R", -1.0))

# --- Skeleton (rest A-pose) -------------------------------------------------------------------------------
# name: (head, tail, parent, connected)
BONES = {
    "hips": ((0.0, 0.0, 0.96), (0.0, 0.0, 1.06), None, False),
    "spine": ((0.0, 0.0, 1.06), (0.0, 0.0, 1.22), "hips", True),
    "chest": ((0.0, 0.0, 1.22), (0.0, 0.0, 1.44), "spine", True),
    "neck": ((0.0, 0.0, 1.46), (0.0, -0.01, 1.57), "chest", False),
    "head": ((0.0, -0.01, 1.57), (0.0, -0.01, 1.80), "neck", True),
}
for _side, _sx in SIDES:
    BONES.update({
        f"shoulder.{_side}": ((0.03 * _sx, 0.0, 1.42), (0.17 * _sx, 0.01, 1.43), "chest", False),
        f"upper_arm.{_side}": ((0.17 * _sx, 0.01, 1.43), (0.382 * _sx, 0.01, 1.218), f"shoulder.{_side}", True),
        f"forearm.{_side}": ((0.382 * _sx, 0.01, 1.218), (0.555 * _sx, -0.03, 1.05), f"upper_arm.{_side}", True),
        f"hand.{_side}": ((0.555 * _sx, -0.03, 1.05), (0.665 * _sx, -0.035, 0.94), f"forearm.{_side}", True),
        f"thigh.{_side}": ((0.095 * _sx, 0.0, 0.92), (0.10 * _sx, -0.012, 0.50), "hips", False),
        f"shin.{_side}": ((0.10 * _sx, -0.012, 0.50), (0.10 * _sx, 0.015, 0.085), f"thigh.{_side}", True),
        f"foot.{_side}": ((0.10 * _sx, 0.015, 0.085), (0.10 * _sx, -0.10, 0.03), f"shin.{_side}", True),
        f"toe.{_side}": ((0.10 * _sx, -0.10, 0.03), (0.10 * _sx, -0.175, 0.025), f"foot.{_side}", True),
    })

HEAD0 = {n: np.array(b[0], float) for n, b in BONES.items()}
TAIL0 = {n: np.array(b[1], float) for n, b in BONES.items()}
PARENT = {n: b[2] for n, b in BONES.items()}
LENGTH = {n: float(np.linalg.norm(TAIL0[n] - HEAD0[n])) for n in BONES}
LEG = LENGTH["thigh.L"] + LENGTH["shin.L"]
# Ground contact of the shoe heel (lowest rearmost sole point), per side, in the rest pose.
HEEL0 = {s: np.array((0.10 * sx, 0.075, 0.0)) for s, sx in SIDES}
I3 = np.eye(3)
DEG = math.pi / 180.0


def mirror_name(name):
    return name[:-2] + {".L": ".R", ".R": ".L"}[name[-2:]] if name[-2:] in (".L", ".R") else name


# --- Math -------------------------------------------------------------------------------------------------

def unit(v):
    v = np.asarray(v, float)
    n = np.linalg.norm(v)
    return v / n if n > 1e-12 else v


def rot(axis, angle):
    x, y, z = unit(axis)
    c, s = math.cos(angle), math.sin(angle)
    k = 1.0 - c
    return np.array([[c + x * x * k, x * y * k - z * s, x * z * k + y * s],
                     [y * x * k + z * s, c + y * y * k, y * z * k - x * s],
                     [z * x * k - y * s, z * y * k + x * s, c + z * z * k]])


def rx(a):
    return rot((1.0, 0.0, 0.0), a)


def ry(a):
    return rot((0.0, 1.0, 0.0), a)


def rz(a):
    return rot((0.0, 0.0, 1.0), a)


def ypr(yaw, pitch, roll):
    """Yaw about +Z (positive turns left), pitch about +X (positive leans forward), roll about +Y (positive
    leans left)."""
    return rz(yaw) @ rx(pitch) @ ry(roll)


def arc(a, b):
    """Shortest rotation taking direction a to direction b."""
    a, b = unit(a), unit(b)
    axis = np.cross(a, b)
    s, c = float(np.linalg.norm(axis)), float(np.dot(a, b))
    if s < 1e-9:
        if c > 0:
            return I3.copy()
        perp = np.cross(a, (1.0, 0.0, 0.0) if abs(a[0]) < 0.9 else (0.0, 1.0, 0.0))
        return rot(perp, math.pi)
    return rot(axis, math.atan2(s, c))


def to_quat(m):
    """Rotation matrix to a unit quaternion (w, x, y, z)."""
    t = m[0, 0] + m[1, 1] + m[2, 2]
    if t > 0:
        s = math.sqrt(t + 1.0) * 2
        q = (0.25 * s, (m[2, 1] - m[1, 2]) / s, (m[0, 2] - m[2, 0]) / s, (m[1, 0] - m[0, 1]) / s)
    elif m[0, 0] > m[1, 1] and m[0, 0] > m[2, 2]:
        s = math.sqrt(1.0 + m[0, 0] - m[1, 1] - m[2, 2]) * 2
        q = ((m[2, 1] - m[1, 2]) / s, 0.25 * s, (m[0, 1] + m[1, 0]) / s, (m[0, 2] + m[2, 0]) / s)
    elif m[1, 1] > m[2, 2]:
        s = math.sqrt(1.0 + m[1, 1] - m[0, 0] - m[2, 2]) * 2
        q = ((m[0, 2] - m[2, 0]) / s, (m[0, 1] + m[1, 0]) / s, 0.25 * s, (m[1, 2] + m[2, 1]) / s)
    else:
        s = math.sqrt(1.0 + m[2, 2] - m[0, 0] - m[1, 1]) * 2
        q = ((m[1, 0] - m[0, 1]) / s, (m[0, 2] + m[2, 0]) / s, (m[1, 2] + m[2, 1]) / s, 0.25 * s)
    return unit(q)


def from_quat(q):
    w, x, y, z = unit(q)
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                     [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                     [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])


def slerp(m0, m1, t):
    q0, q1 = to_quat(m0), to_quat(m1)
    if np.dot(q0, q1) < 0:
        q1 = -q1
    d = min(1.0, float(np.dot(q0, q1)))
    if d > 0.9995:
        return from_quat(q0 + (q1 - q0) * t)
    th = math.acos(d)
    return from_quat((math.sin((1 - t) * th) * q0 + math.sin(t * th) * q1) / math.sin(th))


def turn_toward(a, b, t):
    """Direction a rotated a fraction t of the way to direction b."""
    a, b = unit(a), unit(b)
    axis = np.cross(a, b)
    if np.linalg.norm(axis) < 1e-9:
        return b if t >= 0.5 else a
    return rot(axis, math.atan2(np.linalg.norm(axis), np.dot(a, b)) * t) @ a


def smooth(t):
    t = min(1.0, max(0.0, t))
    return t * t * (3.0 - 2.0 * t)


def smoother(t):
    """Minimum-jerk ease: zero velocity and acceleration at both ends."""
    t = min(1.0, max(0.0, t))
    return t * t * t * (t * (6.0 * t - 15.0) + 10.0)


def hermite(p0, p1, m0, m1, u):
    u2, u3 = u * u, u * u * u
    return (2 * u3 - 3 * u2 + 1) * p0 + (u3 - 2 * u2 + u) * m0 + (-2 * u3 + 3 * u2) * p1 + (u3 - u2) * m1


class Curve:
    """Monotone cubic (PCHIP) through keys [(x, y), ...]; periodic over [0, 1) when periodic=True. No overshoot,
    so a held value (two equal keys) stays exactly flat."""

    def __init__(self, keys, periodic=False):
        keys = sorted(keys)
        xs = [float(k[0]) for k in keys]
        ys = [np.asarray(k[1], float) for k in keys]
        if periodic:
            xs = [xs[-1] - 1.0] + xs + [xs[0] + 1.0]
            ys = [ys[-1]] + ys + [ys[0]]
        self.periodic = periodic
        self.x = np.array(xs)
        self.y = np.array(ys)
        h = np.diff(self.x)
        d = np.diff(self.y, axis=0) / h.reshape((-1,) + (1,) * (self.y.ndim - 1))
        m = np.zeros_like(self.y)
        for k in range(1, len(xs) - 1):
            a, b = d[k - 1], d[k]
            w1, w2 = 2 * h[k] + h[k - 1], h[k] + 2 * h[k - 1]
            with np.errstate(divide="ignore", invalid="ignore"):
                hm = (w1 + w2) / (w1 / a + w2 / b)
            m[k] = np.where(a * b > 0, hm, 0.0)
        if not periodic and len(xs) > 1:
            m[0], m[-1] = 0.0, 0.0  # clips start and end at rest
        self.m, self.h = m, h

    def __call__(self, x):
        x = float(x)
        if self.periodic:
            x %= 1.0
        x = min(max(x, self.x[0]), self.x[-1])
        k = min(int(np.searchsorted(self.x, x, side="right")) - 1, len(self.h) - 1)
        if len(self.h) == 0:
            return self.y[0]
        u = (x - self.x[k]) / self.h[k]
        return hermite(self.y[k], self.y[k + 1], self.m[k] * self.h[k], self.m[k + 1] * self.h[k], u)


def lowpass(values, harmonics):
    """Keep the first harmonics of a periodic sequence."""
    spectrum = np.fft.rfft(values)
    spectrum[harmonics + 1:] = 0
    return np.fft.irfft(spectrum, len(values))


# --- Pose solver ------------------------------------------------------------------------------------------

def rest_dir(name):
    return unit(TAIL0[name] - HEAD0[name])


def two_bone(root, target, l1, l2, pole):
    """Middle joint of a two-bone chain reaching from root toward target, bending toward pole.
    Returns (joint, reach) with reach = distance / (l1 + l2); beyond 1 the end falls short."""
    d_vec = target - root
    d = float(np.linalg.norm(d_vec))
    reach = d / (l1 + l2)
    dc = min(max(d, abs(l1 - l2) + 1e-4), (l1 + l2) * (1 - 1e-6))
    u = d_vec / d
    a = (l1 * l1 - l2 * l2 + dc * dc) / (2 * dc)
    h = math.sqrt(max(l1 * l1 - a * a, 0.0))
    w = unit(pole - np.dot(pole, u) * u)
    return root + u * a + w * h, reach


def hang_dirs(side, abduct, swing, bend, inward):
    """Upper-arm and forearm directions in rest axes: hanging abducted, swung forward (positive) about the
    lateral axis, elbow bent toward the front and slightly toward the body."""
    sx = 1.0 if side == "L" else -1.0
    up = rx(-swing) @ np.array((sx * math.sin(abduct), 0.0, -math.cos(abduct)))
    fwd = unit((-sx * inward, -1.0, 0.0))
    axis = unit(np.cross(up, fwd))
    return up, rot(axis, bend) @ up


def solve(spec):
    """Pose from a spec (see the clip builders). Returns (Q, H, diagnostics)."""
    Q, H = {}, {}
    diag = {"legReach": {}, "armReach": {}}

    def place(name, q):
        parent = PARENT[name]
        if parent is None:
            H[name] = np.asarray(spec["hips_pos"], float)
        else:
            H[name] = Q[parent] @ (HEAD0[name] - HEAD0[parent]) + H[parent]
        Q[name] = q

    def joint(name):  # world position of a child's head before the child is placed
        parent = PARENT[name]
        return Q[parent] @ (HEAD0[name] - HEAD0[parent]) + H[parent]

    place("hips", spec["hips_q"])
    place("spine", Q["hips"] @ spec.get("spine", I3))
    place("chest", Q["spine"] @ spec.get("chest", I3))
    head_q = spec["head_q"]
    place("neck", slerp(Q["chest"], head_q, 0.5))
    place("head", head_q)
    for side, sx in SIDES:
        arm = spec["arms"][side]
        sh, ua, fa, hd = f"shoulder.{side}", f"upper_arm.{side}", f"forearm.{side}", f"hand.{side}"
        place(sh, Q["chest"] @ arm.get("shoulder", I3))
        up, fore = (Q["chest"] @ v for v in hang_dirs(side, *arm["hang"]))
        weight = arm.get("ik", 0.0)
        if weight > 0:
            j = joint(ua)
            grip = np.asarray(arm["grip"], float)
            wrist = grip - unit(grip - j) * arm.get("palm", 0.07)
            elbow, reach = two_bone(j, wrist, LENGTH[ua], LENGTH[fa], unit(arm["pole"]))
            diag["armReach"][side] = reach
            up = turn_toward(up, elbow - j, weight)
            fore = turn_toward(fore, wrist - elbow, weight)
        place(ua, arc(Q[sh] @ rest_dir(ua), up) @ Q[sh])
        qf = arc(Q[ua] @ rest_dir(fa), fore) @ Q[ua]
        if arm.get("twist"):
            qf = rot(fore, arm["twist"]) @ qf
        place(fa, qf)
        place(hd, Q[fa] @ arm.get("wrist", I3))
    for side, sx in SIDES:
        leg = spec["legs"][side]
        th, sh, ft, toe = f"thigh.{side}", f"shin.{side}", f"foot.{side}", f"toe.{side}"
        hip = joint(th)
        ankle = np.asarray(leg["ankle"], float)
        knee, reach = two_bone(hip, ankle, LENGTH[th], LENGTH[sh], unit(leg.get("pole", (0.0, -1.0, 0.0))))
        diag["legReach"][side] = reach
        place(th, arc(Q["hips"] @ rest_dir(th), knee - hip) @ Q["hips"])
        place(sh, arc(Q[th] @ rest_dir(sh), ankle - knee) @ Q[th])
        place(ft, leg["foot_q"])
        place(toe, leg["toe_q"])
    return Q, H, diag


def mirror_pose(Q, H):
    """Left-right mirror of a solved pose (the rest skeleton is symmetric)."""
    S = np.diag((-1.0, 1.0, 1.0))
    return ({mirror_name(n): S @ q @ S for n, q in Q.items()}, {mirror_name(n): S @ h for n, h in H.items()})


def point(Q, H, bone, rest_point):
    """Posed position of a rest-pose point carried by a bone."""
    return Q[bone] @ (np.asarray(rest_point, float) - HEAD0[bone]) + H[bone]


# --- Feet -------------------------------------------------------------------------------------------------

def foot_on_ground(side, tip, theta, gamma):
    """Ankle and foot/toe rotations for a foot whose toe tip rests at `tip`. theta is the foot pitch (positive
    lifts the heel), gamma the toe pitch about its tip. theta < 0 rolls the foot on its heel instead."""
    if theta < 0:
        heel = tip + (HEEL0[side] - TAIL0[f"toe.{side}"])
        r = rx(theta)
        return heel + r @ (HEAD0[f"foot.{side}"] - HEEL0[side]), r, r
    rg, rf = rx(gamma), rx(theta)
    ball = tip + rg @ (HEAD0[f"toe.{side}"] - TAIL0[f"toe.{side}"])
    return ball + rf @ (HEAD0[f"foot.{side}"] - HEAD0[f"toe.{side}"]), rf, rg


def flat_foot(side, x, y, z=0.0, theta=0.0, toe=0.0, yaw=0.0):
    """Leg spec for a foot whose ankle-ground point sits at (x, y, z), pitched theta about the ankle."""
    rf = rz(yaw) @ rx(theta)
    ankle = np.array((x, y, z + HEAD0[f"foot.{side}"][2]))
    return {"ankle": ankle, "foot_q": rf, "toe_q": rf @ rx(toe)}


# --- Locomotion -------------------------------------------------------------------------------------------

GAITS = {
    "walk": dict(frames=64, speed=1.4, duty=0.62, track=0.085, strike="heel",
                 theta=[(0.0, -12), (0.10, 0), (0.34, 0), (0.62, 48), (0.70, 36), (0.82, 2), (0.93, -14)],
                 toe=(0.46, 16), lift=0.07, lift_peak=0.36, height=(0.955, 0.012, 1.0), reach=0.993,
                 yaw=5, roll=3.5, sway=0.02, pitch=3, lean=(1.5, 1.0), head=3,
                 arms=dict(abduct=13, swing=16, lag=0.04, bend=(14, 16), inward=0.2)),
    "run": dict(frames=44, speed=3.6, duty=0.35, track=0.05, strike="fore",
                theta=[(0.0, 9), (0.11, 4), (0.35, 56), (0.46, 74), (0.62, 52), (0.82, 8), (0.93, 3)],
                toe=(0.18, 22), lift=0.26, lift_peak=0.32, height=(0.94, 0.02, -1.0), reach=0.993,
                yaw=8, roll=4, sway=0.012, pitch=7, lean=(3, 2), head=-2,
                arms=dict(abduct=15, swing=30, lag=0.03, bend=(78, 14), inward=0.35)),
    "sprint": dict(frames=36, speed=6.4, duty=0.22, track=0.04, strike="fore",
                   theta=[(0.0, 8), (0.084, 5), (0.22, 56), (0.33, 82), (0.51, 70), (0.77, 10), (0.9, 2)],
                   toe=(0.088, 26), lift=0.42, lift_peak=0.3, height=(0.935, 0.025, -1.0), reach=0.993,
                   yaw=10, roll=4, sway=0.008, pitch=11, lean=(5, 3), head=-6,
                   arms=dict(abduct=13, swing=46, lag=0.03, bend=(86, 10), inward=0.42)),
}


class Gait:
    """One locomotion cycle. The left heel (or forefoot) strikes at frame 0, the right at half the cycle."""

    def __init__(self, name, params, strike_y=None):
        self.name, self.p = name, params
        self.n = params["frames"]
        self.cycle = self.n / FPS
        self.v = params["speed"]
        self.beta = params["duty"]
        self.theta = Curve([(x, y * DEG) for x, y in params["theta"]], periodic=True)
        self.strike_y = self.best_strike() if strike_y is None else strike_y
        self.height = self.solve_height()

    # Feet ---------------------------------------------------------------------------------------------
    def gamma(self, psi):
        start, peak = self.p["toe"]
        if psi >= self.beta:
            return 0.0
        return peak * DEG * smoother((psi - start) / (self.beta - start)) if psi > start else 0.0

    def stance(self, side, psi, tip_strike):
        """Root-frame foot at stance phase psi: the toe tip slides back at the clip speed."""
        tip = tip_strike + np.array((0.0, self.v * psi * self.cycle, 0.0))
        return foot_on_ground(side, tip, self.theta(psi), self.gamma(psi))

    def tip_strike(self, side):
        sx = 1.0 if side == "L" else -1.0
        tip0 = TAIL0[f"toe.{side}"] + np.array((sx * self.p["track"] - sx * 0.10, 0.0, 0.0))
        ankle, _, _ = foot_on_ground(side, tip0, self.theta(0.0), self.gamma(0.0))
        return tip0 + np.array((0.0, self.strike_y - ankle[1], 0.0))

    def foot(self, side, phi):
        """(ankle, foot_q, toe_q, theta) at cycle phase phi; theta is the stance pitch, None in swing. The heel
        is planted while theta <= 0 and the toe tip while theta >= 0."""
        psi = (phi - (0.0 if side == "L" else 0.5)) % 1.0
        tip = self.tip_strike(side)
        if psi < self.beta:
            ankle, qf, qt = self.stance(side, psi, tip)
            return ankle, qf, qt, float(self.theta(psi))
        # Swing: Hermite in the ground frame between toe-off and the next strike, matching velocities.
        u = (psi - self.beta) / (1.0 - self.beta)
        eps = 1e-4
        a_off, _, _ = self.stance(side, self.beta - eps, tip)
        a_off2, _, _ = self.stance(side, self.beta - 2 * eps, tip)
        a_hs, _, _ = self.stance(side, 0.0, tip)
        a_hs2, _, _ = self.stance(side, eps, tip)
        belt = np.array((0.0, self.v * self.cycle, 0.0))  # root-frame drift per unit psi
        swing_len = 1.0 - self.beta
        g_off, g_hs = a_off, a_hs - belt * swing_len
        m_off = ((a_off - a_off2) / eps - belt) * swing_len
        m_hs = ((a_hs2 - a_hs) / eps - belt) * swing_len
        g = np.array([hermite(g_off[i], g_hs[i], m_off[i], m_hs[i], u) for i in range(3)])
        k = math.log(0.5) / math.log(self.p["lift_peak"])
        g[2] += self.p["lift"] * math.sin(math.pi * u ** k) ** 2
        ankle = g + belt * (psi - self.beta)
        theta = self.theta(psi)
        rel_off = self.gamma(self.beta - eps) - self.theta(self.beta - eps)
        rel_hs = self.gamma(0.0) - self.theta(0.0) if self.theta(0.0) >= 0 else 0.0
        rel = rel_off * (1.0 - smoother(u / 0.45)) + rel_hs * smoother((u - 0.6) / 0.4)
        return ankle, rx(theta), rx(theta + rel), None

    # Pelvis -------------------------------------------------------------------------------------------
    def pelvis(self, phi):
        p = self.p
        mid = self.beta / 2  # middle of the left foot's single support
        yaw = -p["yaw"] * DEG * math.cos(2 * math.pi * phi)
        roll = -p["roll"] * DEG * math.cos(2 * math.pi * (phi - mid))
        x = p["sway"] * math.cos(2 * math.pi * (phi - mid))
        return np.array((x, 0.0, 0.0)), ypr(yaw, p["pitch"] * DEG, roll), yaw

    def max_heights(self, frames=None):
        """Highest hips-head height per frame that keeps each leg within its reach limit."""
        out = []
        for f in range(self.n) if frames is None else frames:
            phi = f / self.n
            pos, q, _ = self.pelvis(phi)
            limits = []
            for side, _ in SIDES:
                ankle = self.foot(side, phi)[0]
                off = q @ (HEAD0[f"thigh.{side}"] - HEAD0["hips"])
                dxy = math.hypot(pos[0] + off[0] - ankle[0], pos[1] + off[1] - ankle[1])
                r = self.p["reach"] * LEG
                limits.append(ankle[2] - off[2] + math.sqrt(r * r - dxy * dxy) if dxy < r else -1.0)
            out.append(min(limits))
        return np.array(out)

    def best_strike(self):
        """Strike position that leaves the most leg reach over the cycle (golden-section search)."""
        lo, hi = -0.7, 0.0
        g = (math.sqrt(5) - 1) / 2

        def score(y):
            self.strike_y = y
            return float(self.max_heights(range(0, self.n, 2)).min())

        a, b = hi - g * (hi - lo), lo + g * (hi - lo)
        fa, fb = score(a), score(b)
        for _ in range(28):
            if fa < fb:
                lo, a, fa = a, b, fb
                b = lo + g * (hi - lo)
                fb = score(b)
            else:
                hi, b, fb = b, a, fa
                a = hi - g * (hi - lo)
                fa = score(a)
        return (lo + hi) / 2

    def solve_height(self):
        c0, amp, sign = self.p["height"]
        mid = self.beta / 2
        phis = np.arange(self.n) / self.n
        nominal = c0 + sign * amp * np.cos(4 * math.pi * (phis - mid))
        limit = self.max_heights()
        h = nominal.copy()
        for _ in range(40):
            h = lowpass(np.minimum(h, limit), 6)
        return h - max(0.0, float((h - limit).max()))

    # Whole pose ---------------------------------------------------------------------------------------
    def spec(self, frame):
        p, a = self.p, self.p["arms"]
        f = frame % self.n
        phi = f / self.n
        pos, hq, yaw = self.pelvis(phi)
        pos = pos + np.array((0.0, 0.0, self.height[f]))
        legs, contacts = {}, {}
        for side, _ in SIDES:
            ankle, qf, qt, contact = self.foot(side, phi)
            legs[side] = {"ankle": ankle, "foot_q": qf, "toe_q": qt, "pole": rz(yaw) @ np.array((0.0, -1.0, 0.0))}
            contacts[side] = contact
        arms = {}
        for side, _ in SIDES:
            # Each arm swings forward with the opposite leg.
            swing = a["swing"] * DEG * math.cos(2 * math.pi * (phi - (0.5 if side == "L" else 0.0) - a["lag"]))
            bend = (a["bend"][0] + a["bend"][1] * (0.5 + 0.5 * swing / (a["swing"] * DEG))) * DEG
            arms[side] = {"hang": (a["abduct"] * DEG, swing, bend, a["inward"])}
        lean_s, lean_c = p["lean"]
        return {"hips_pos": pos, "hips_q": hq,
                "spine": ypr(-0.7 * yaw, lean_s * DEG, 0.0), "chest": ypr(-0.8 * yaw, lean_c * DEG, 0.0),
                "head_q": rx(p["head"] * DEG), "arms": arms, "legs": legs, "contacts": contacts}

    def contact_intervals(self, side):
        """Stance frames of a foot as inclusive integer intervals within [0, frames]."""
        start = 0 if side == "L" else self.n // 2
        end = start + int(math.floor(self.beta * self.n - 1e-9))
        if end <= self.n:
            return [[start, end]]
        return [[start, self.n], [0, end - self.n]]


# --- Keyed clips ------------------------------------------------------------------------------------------

def keyed(keys):
    """Per-parameter monotone curves through key poses [(u, {param: value})], like keyframes in a DCC: a
    parameter is keyed only where a key names it and holds its value after its last key."""
    names = set().union(*(params for _, params in keys))
    curves = {name: Curve([(u, params[name]) for u, params in keys if name in params]) for name in names}
    return lambda u: {name: curve(u) for name, curve in curves.items()}


STAND = {  # relaxed standing pose shared by idle, land and the car entry
    "hips": (0.0, 0.0, 0.952), "hips_rot": (0.0, 2 * DEG, 0.0), "spine_rot": (0.0, 0.0, 0.0),
    "chest_rot": (0.0, 0.0, 0.0), "head_rot": (0.0, 2 * DEG, 0.0),
    "ankle.L": (0.11, -0.02, 0.0), "ankle.R": (-0.11, 0.025, 0.0), "foot.L": 0.0, "foot.R": 0.0,
    "footyaw.L": 6 * DEG, "footyaw.R": -6 * DEG, "toe.L": 0.0, "toe.R": 0.0,
    "pole.L": (0.15, -1.0, 0.0), "pole.R": (-0.15, -1.0, 0.0),
    "arm.L": (12 * DEG, 0.0, 14 * DEG, 0.2), "arm.R": (12 * DEG, 0.0, 14 * DEG, 0.2), "ik.L": 0.0, "ik.R": 0.0,
}


def spec_from(params, grips=None, elbow_poles=None):
    """Spec from keyed parameters. Ankle parameters are the ankle's ground point (z is the sole height)."""
    legs, arms = {}, {}
    for side, sx in SIDES:
        x, y, z = params[f"ankle.{side}"]
        legs[side] = flat_foot(side, x, y, z, params[f"foot.{side}"], params[f"toe.{side}"],
                               params.get(f"footyaw.{side}", 0.0))
        legs[side]["pole"] = np.asarray(params[f"pole.{side}"], float)
        arm = {"hang": tuple(params[f"arm.{side}"]), "ik": float(params.get(f"ik.{side}", 0.0))}
        if arm["ik"] > 0:
            arm["grip"] = grips[side]
            arm["pole"] = elbow_poles[side]
            arm["twist"] = float(params.get(f"twist.{side}", 0.0))
        arms[side] = arm
    return {"hips_pos": np.asarray(params["hips"], float), "hips_q": ypr(*params["hips_rot"]),
            "spine": ypr(*params["spine_rot"]), "chest": ypr(*params["chest_rot"]),
            "head_q": ypr(*params["head_rot"]), "arms": arms, "legs": legs}


def idle_spec(frame, n=240):
    phi = frame / n
    s, c = math.sin(2 * math.pi * phi), math.cos(2 * math.pi * phi)
    p = dict(STAND)
    p["hips"] = (0.012 * s, 0.0, 0.952 - 0.003 * (1 - c))
    p["hips_rot"] = (0.03 * s, 2 * DEG, -0.025 * s)
    p["spine_rot"] = (-0.015 * s, 0.0, 0.015 * s)
    p["chest_rot"] = (0.0, -1.2 * DEG * math.sin(2 * math.pi * phi + 0.6), 0.004 * s)  # breathing
    p["head_rot"] = (0.11 * math.sin(2 * math.pi * (phi + 0.15)), 2 * DEG + 1 * DEG * c, 0.0)
    p["arm.L"] = (12 * DEG + 0.01 * s, 1.5 * DEG * c, 14 * DEG, 0.2)
    p["arm.R"] = (12 * DEG - 0.01 * s, -1.5 * DEG * c, 14 * DEG, 0.2)
    return spec_from(p)


def jump_curve():
    return keyed([
        (0.0, {**STAND, "hips": (0.0, 0.02, 0.90), "hips_rot": (0.0, 10 * DEG, 0.0), "spine_rot": (0.0, 4 * DEG, 0.0),
               "ankle.L": (0.10, -0.03, 0.0), "ankle.R": (-0.10, 0.03, 0.0),
               "arm.L": (14 * DEG, -30 * DEG, 30 * DEG, 0.2), "arm.R": (14 * DEG, -30 * DEG, 30 * DEG, 0.2)}),
        (0.4, {"hips": (0.0, 0.0, 0.97), "hips_rot": (0.0, 4 * DEG, 0.0), "spine_rot": (0.0, 1 * DEG, 0.0),
               "ankle.L": (0.10, 0.0, 0.02), "ankle.R": (-0.10, 0.05, 0.03), "foot.L": 30 * DEG, "foot.R": 34 * DEG,
               "toe.L": -14 * DEG, "toe.R": -14 * DEG,
               "arm.L": (18 * DEG, 30 * DEG, 40 * DEG, 0.25), "arm.R": (18 * DEG, 24 * DEG, 40 * DEG, 0.25)}),
        (1.0, {"hips": (0.0, 0.0, 0.98), "hips_rot": (0.0, 6 * DEG, 0.0), "head_rot": (0.0, 4 * DEG, 0.0),
               "ankle.L": (0.11, -0.16, 0.36), "ankle.R": (-0.10, 0.22, 0.22), "foot.L": 12 * DEG, "foot.R": 40 * DEG,
               "toe.L": 0.0, "toe.R": -10 * DEG, "pole.L": (0.1, -1.0, 0.3), "pole.R": (-0.1, -1.0, 0.0),
               "arm.L": (30 * DEG, 22 * DEG, 50 * DEG, 0.25), "arm.R": (34 * DEG, -10 * DEG, 40 * DEG, 0.25)}),
    ])


def fall_spec(frame, n=60):
    phi = frame / n
    s, c = math.sin(2 * math.pi * phi), math.cos(2 * math.pi * phi)
    p = dict(STAND)
    p.update({"hips": (0.0, 0.0, 0.98), "hips_rot": (0.03 * s, 6 * DEG, 0.03 * c), "spine_rot": (0.0, 2 * DEG, -0.02 * c),
              "head_rot": (0.0, 6 * DEG, 0.0),
              "ankle.L": (0.13, -0.10 + 0.07 * s, 0.30 + 0.05 * c), "ankle.R": (-0.13, 0.13 - 0.07 * s, 0.22 - 0.05 * c),
              "foot.L": 18 * DEG, "foot.R": 28 * DEG, "footyaw.L": 0.0, "footyaw.R": 0.0,
              "pole.L": (0.2, -1.0, 0.2), "pole.R": (-0.2, -1.0, 0.0),
              "arm.L": (48 * DEG + 0.08 * s, 12 * DEG + 6 * DEG * c, 34 * DEG, 0.2),
              "arm.R": (48 * DEG - 0.08 * s, 12 * DEG - 6 * DEG * c, 34 * DEG, 0.2)})
    return spec_from(p)


def land_curve():
    return keyed([
        (0.0, {**STAND, "hips": (0.0, 0.0, 0.93), "hips_rot": (0.0, 6 * DEG, 0.0), "head_rot": (0.0, 6 * DEG, 0.0),
               "arm.L": (40 * DEG, 10 * DEG, 30 * DEG, 0.2), "arm.R": (40 * DEG, 10 * DEG, 30 * DEG, 0.2)}),
        (0.3, {"hips": (0.0, 0.03, 0.80), "hips_rot": (0.0, 20 * DEG, 0.0), "spine_rot": (0.0, 6 * DEG, 0.0),
               "chest_rot": (0.0, 4 * DEG, 0.0), "head_rot": (0.0, 4 * DEG, 0.0),
               "pole.L": (0.3, -1.0, 0.0), "pole.R": (-0.3, -1.0, 0.0),
               "arm.L": (30 * DEG, 24 * DEG, 44 * DEG, 0.25), "arm.R": (30 * DEG, 24 * DEG, 44 * DEG, 0.25)}),
        (1.0, dict(STAND)),
    ])


# --- Driving and car entry --------------------------------------------------------------------------------
# Root at the driver's seat feet point (SEAT_DRIVER - 0.5 m), car-forward = character forward (-Y here).
# The cabin geometry is the sedan's (content/assets/car-sedan.contract.json, built by build_sedan.py): hip
# joints 0.5 m above the root, the lined cabin floor 0.20 m above it, the driver door point (EXIT_DRIVER)
# 1.13 m to the left at ground level, and the steering wheel (STEERING_WHEEL, "cabin") ahead of the chest.
DRIVE_HIP_Z = 0.5
FLOOR_Z = 0.20
DOOR = (1.13, 0.0, 0.0)
WHEEL_CENTRE = np.array((0.0, -0.37, 0.93))
WHEEL_NORMAL = unit((0.0, math.cos(25 * DEG), math.sin(25 * DEG)))  # faces the driver
WHEEL_UP = unit(np.cross(WHEEL_NORMAL, (1.0, 0.0, 0.0)) * -1.0)
WHEEL_RADIUS = 0.18
CROSS_FORWARD = 0.22  # hips ahead of the seat while crossing the door opening (backpack vs B-pillar)


def wheel_grips(steer):
    """Hand grip points at ten-to-two, turned by steer radians (positive turns left)."""
    if WHEEL_UP[2] < 0:
        raise AssertionError("wheel up axis points down")
    grips = {}
    for side, sx in SIDES:
        a = sx * 60 * DEG + steer
        p = WHEEL_CENTRE + WHEEL_RADIUS * (math.cos(a) * WHEEL_UP + math.sin(a) * np.array((1.0, 0.0, 0.0)))
        grips[side] = p + WHEEL_NORMAL * 0.02
    return grips


STEER_LOCK = 50 * DEG  # wheel angle of the steer_left / steer_right poses
ELBOW_POLES = {"L": unit((0.7, 0.2, -1.0)), "R": unit((-0.7, 0.2, -1.0))}

SEATED = {
    "hips": (0.0, 0.0, DRIVE_HIP_Z + 0.04), "hips_rot": (0.0, -24 * DEG, 0.0), "spine_rot": (0.0, 8 * DEG, 0.0),
    "chest_rot": (0.0, 5 * DEG, 0.0), "head_rot": (0.0, 3 * DEG, 0.0),
    "ankle.L": (0.17, -0.66, FLOOR_Z), "ankle.R": (-0.12, -0.70, FLOOR_Z + 0.02),
    "foot.L": -26 * DEG, "foot.R": -32 * DEG, "footyaw.L": 8 * DEG, "footyaw.R": -4 * DEG, "toe.L": 0.0, "toe.R": 0.0,
    "pole.L": (0.25, -0.5, 1.0), "pole.R": (-0.15, -0.5, 1.0),
    "arm.L": (14 * DEG, 40 * DEG, 60 * DEG, 0.3), "arm.R": (14 * DEG, 40 * DEG, 60 * DEG, 0.3), "ik.L": 1.0, "ik.R": 1.0,
    "twist.L": 0.0, "twist.R": 0.0,
}


def drive_spec(frame, n=120, steer=0.0):
    phi = frame / n
    s = math.sin(2 * math.pi * phi)
    p = dict(SEATED)
    lean = -steer / STEER_LOCK * 3 * DEG  # lean into the turn (left turn: lean left is positive roll)
    p["hips_rot"] = (0.0, -24 * DEG, 0.006 * s)
    p["chest_rot"] = (0.0, 5 * DEG - 0.7 * DEG * math.sin(2 * math.pi * phi + 1.0), -lean)
    p["head_rot"] = (0.05 * math.sin(2 * math.pi * (phi + 0.3)) + steer * 0.2, 3 * DEG, -lean * 0.5)
    return spec_from(p, wheel_grips(steer), ELBOW_POLES)


def enter_curve():
    """Driver-side entry: right leg steps into the footwell, the body ducks and slides onto the seat, the left
    leg swings in, then the hands go to the wheel. Root fixed at the seat. The body crosses the door opening
    CROSS_FORWARD ahead of the seat, so the backpack clears the B-pillar, and settles back once inboard."""
    dx, _, gz = DOOR
    stand = {**STAND, "hips": (dx, 0.0, gz + 0.952),
             "ankle.L": (dx + 0.11, -0.02, gz), "ankle.R": (dx - 0.11, 0.025, gz),
             "arm.L": (12 * DEG, 0.0, 14 * DEG, 0.2), "arm.R": (12 * DEG, 0.0, 14 * DEG, 0.2), "twist.L": 0.0, "twist.R": 0.0}
    return keyed([
        (0.0, stand),
        (0.08, {"hips": (dx + 0.02, 0.0, gz + 0.94)}),
        (0.26, {"hips": (0.80, -CROSS_FORWARD, gz + 0.84), "hips_rot": (-10 * DEG, 14 * DEG, -6 * DEG),
                "spine_rot": (0.0, 10 * DEG, -6 * DEG), "chest_rot": (0.0, 8 * DEG, -4 * DEG),
                "head_rot": (-6 * DEG, 14 * DEG, 0.0),
                "ankle.R": (0.42, -0.62, FLOOR_Z), "foot.R": -10 * DEG, "footyaw.R": -10 * DEG,
                "arm.R": (22 * DEG, 14 * DEG, 30 * DEG, 0.2), "arm.L": (24 * DEG, 6 * DEG, 24 * DEG, 0.2)}),
        (0.18, {"ankle.R": (0.78, -0.22, 0.32), "foot.R": 6 * DEG}),
        (0.26, {"ankle.L": (dx + 0.11, -0.04, gz + 0.03), "foot.L": 16 * DEG}),  # heel up, pivoting on the ball
        (0.36, {"ankle.L": (dx + 0.08, -0.08, gz + 0.10), "foot.L": 14 * DEG}),
        (0.50, {"ankle.L": (0.86, -0.36, 0.40), "foot.L": -6 * DEG, "pole.L": (0.4, -0.6, 0.8)}),
        (0.52, {"hips": (0.24, -CROSS_FORWARD, DRIVE_HIP_Z + 0.10), "hips_rot": (-4 * DEG, 4 * DEG, -10 * DEG),
                "spine_rot": (0.0, 16 * DEG, -8 * DEG), "chest_rot": (0.0, 10 * DEG, -4 * DEG),
                "head_rot": (-4 * DEG, 18 * DEG, -6 * DEG)}),
        (0.63, {"hips": (0.07, -0.7 * CROSS_FORWARD, DRIVE_HIP_Z + 0.07)}),
        (0.74, {"hips": SEATED["hips"], "hips_rot": SEATED["hips_rot"], "spine_rot": (0.0, 12 * DEG, 0.0),
                "chest_rot": (0.0, 8 * DEG, 0.0), "head_rot": (0.0, 6 * DEG, 0.0),
                "ankle.L": SEATED["ankle.L"], "ankle.R": SEATED["ankle.R"], "foot.L": SEATED["foot.L"],
                "foot.R": SEATED["foot.R"], "footyaw.L": SEATED["footyaw.L"], "footyaw.R": SEATED["footyaw.R"],
                "pole.L": SEATED["pole.L"], "pole.R": SEATED["pole.R"]}),
        (0.62, {"ik.L": 0.0, "ik.R": 0.0}),
        (0.92, {**SEATED}),
        (1.0, {**SEATED}),
    ])


# --- Clip registry ----------------------------------------------------------------------------------------

def clip_specs():
    """name -> (frames, loop, spec(frame), mirrored). Mirrored clips are solved, then mirrored left-right."""
    jump, land = jump_curve(), land_curve()
    enter = enter_curve()
    gaits = {name: Gait(name, params) for name, params in GAITS.items()}
    clips = {
        "idle": (240, True, idle_spec, False),
        **{name: (g.n, True, g.spec, False) for name, g in gaits.items()},
        "jump": (12, False, lambda f: spec_from(jump(f / 12)), False),
        "fall": (60, True, fall_spec, False),
        "land": (18, False, lambda f: spec_from(land(f / 18)), False),
        "drive": (120, True, drive_spec, False),
        "steer_left": (1, True, lambda f: drive_spec(0, steer=STEER_LOCK), False),
        "steer_right": (1, True, lambda f: drive_spec(0, steer=-STEER_LOCK), False),
        "enter_car_left": (48, False, lambda f: spec_from(enter(f / 48), wheel_grips(0.0), ELBOW_POLES), False),
        "exit_car_left": (48, False, lambda f: spec_from(enter(1.0 - f / 48), wheel_grips(0.0), ELBOW_POLES), False),
        # Passenger-side doors: the same motion mirrored, rooted at the mirrored seat (the runtime slides the
        # seated figure across to the driver's seat).
        "enter_car_right": (48, False, lambda f: spec_from(enter(f / 48), wheel_grips(0.0), ELBOW_POLES), True),
        "exit_car_right": (48, False, lambda f: spec_from(enter(1.0 - f / 48), wheel_grips(0.0), ELBOW_POLES), True),
    }
    return clips, gaits


def bake(name, clips):
    """Solved poses for every frame 0..frames of a clip, plus diagnostics."""
    frames, loop, fn, mirrored = clips[name]
    poses, diags = [], []
    for f in range(frames + 1):
        Q, H, diag = solve(fn(0 if (loop and f == frames) else f))
        if mirrored:
            Q, H = mirror_pose(Q, H)
        poses.append((Q, H))
        diags.append(diag)
    return poses, diags
