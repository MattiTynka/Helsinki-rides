"""Author Snow's jump, airborne and ledge-climb motion in the unmodified native rest hierarchy.

Blender 5.2 mathutils only. The source GLB is read as data; no importer, scene edit, mesh change or
GLB export is involved. Clip clocks belong to the simulation (apps/game/src/render/native-jump-animation.ts):
take-off by phase time, rise by vertical speed, fall by time to contact, landings by time since
touchdown and climbs by climb progress.

Key poses are anatomical parameters (pelvis, spine, arm swing/abduction/elbow, ball-of-foot placement
and pitch) solved by game_motion's two-bone IK. Keys are joined by monotone cubic splines, so motion
flows through a key instead of easing to a stop at each one. Running variants are authored for a left
take-off foot and mirrored for the right. Climbs are authored in the ledge frame with the wrists solved
onto the edge, then expressed relative to the simulation's climb path (packages/sim/src/character.ts).
"""
import argparse
import json
import math
from pathlib import Path
import sys

from mathutils import Matrix, Quaternion, Vector

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_snow_gameplay_clips as native
import game_motion as gm

# Mirrors packages/sim/src/character.ts CHARACTER.radius and CLIMB; a runtime test compares them.
RADIUS = 0.32
CLIMB = dict(riseFraction=0.55, lift=0.05, wallGap=0.06, inset=0.12, baseSeconds=0.5, perMetreSeconds=0.5)
WALL = RADIUS + CLIMB["wallGap"]                      # capsule axis to wall face while pulling up
TRAVEL = WALL + RADIUS + CLIMB["inset"]               # wall position to the standing position on top
D = math.radians
SIDES = (("L", "Left", 1.0), ("R", "Right", -1.0))

# --- Key interpolation ------------------------------------------------------------------------------------


def pchip(xs, ys, x):
    """Monotone cubic (Fritsch-Carlson): C1, no overshoot between keys."""
    n = len(xs)
    if n == 1 or x <= xs[0]:
        return ys[0]
    if x >= xs[-1]:
        return ys[-1]
    h = [xs[i + 1] - xs[i] for i in range(n - 1)]
    d = [(ys[i + 1] - ys[i]) / h[i] for i in range(n - 1)]
    m = [0.0] * n
    m[0], m[-1] = d[0] * 0.5, d[-1] * 0.5
    for i in range(1, n - 1):
        if d[i - 1] * d[i] > 0:
            w1, w2 = 2 * h[i] + h[i - 1], h[i] + 2 * h[i - 1]
            m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i])
    i = max(j for j in range(n - 1) if xs[j] <= x)
    t = (x - xs[i]) / h[i]
    t2, t3 = t * t, t * t * t
    return ((2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h[i] * m[i]
            + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h[i] * m[i + 1])


def keyed(base, keys):
    """Each key overrides parameters of the previous one; every parameter is splined through all keys."""
    full, cur = [], dict(base)
    for u, over in keys:
        unknown = set(expand(over)) - set(base)
        if unknown:
            raise KeyError(f"unknown pose parameters {sorted(unknown)}")
        cur = {**cur, **expand(over)}
        full.append((u, dict(cur)))
    times = [u for u, _ in full]

    def at(u):
        out = {}
        for name, value in full[0][1].items():
            vals = [k[name] for _, k in full]
            if isinstance(value, tuple):
                out[name] = tuple(pchip(times, [v[c] for v in vals], u) for c in range(len(value)))
            else:
                out[name] = pchip(times, vals, u)
        return out
    return at


def expand(over):
    """'arm.*' style keys apply to both sides (mirrored where the value is lateral)."""
    out = {}
    for name, value in over.items():
        if not name.endswith(".*"):
            out[name] = value
            continue
        stem = name[:-2]
        for s, _, sx in SIDES:
            if isinstance(value, tuple) and stem in ("elbow", "knee", "wrist"):
                out[f"{stem}.{s}"] = (sx * abs(value[0]),) + tuple(value[1:])
            else:
                out[f"{stem}.{s}"] = value
    return out


def mirror(params):
    """Left/right mirror of a parameter set (lateral offsets, yaw and roll change sign)."""
    out = {}
    for name, value in params.items():
        if "." in name:
            stem, side = name.split(".")
            name = f"{stem}.{'R' if side == 'L' else 'L'}"
            if stem in ("foot",):
                value = (-value[0], value[1], value[2], value[3], -value[4])
            elif stem in ("elbow", "knee", "wrist"):
                value = (-value[0], value[1], value[2])
        elif name in ("hip",):
            value = (-value[0], value[1], value[2])
        elif name in ("pelvis", "spine", "chest", "neck", "head"):
            value = (-value[0], value[1], -value[2])
        out[name] = value
    return out


def mirrored(fn):
    return lambda u: mirror(fn(u))


# --- Pose parameters -> solver spec ------------------------------------------------------------------------
# Blender frame: +Z up, Snow faces -Y, +X is his left. 'hip' and 'foot' offsets are metres from the rest
# hips / rest ball of the foot; rotations are (yaw, pitch, roll) degrees, pitch > 0 leans forward.
# 'arm' = (abduction, swing, elbow bend, bend-plane inward): swing 0 hangs, 90 points forward, 180 up.
# 'foot' = (ball x, y, z, pitch, toe-out yaw): pitch > 0 points the toes down about the ball.

STAND = {
    "hip": (0.0, 0.0, -0.02), "pelvis": (0.0, 3.0, 0.0), "spine": (0.0, 1.0, 0.0), "chest": (0.0, 0.0, 0.0),
    "neck": (0.0, -2.0, 0.0), "head": (0.0, -1.0, 0.0),
    "arm.L": (10.0, 0.0, 12.0, 0.15), "arm.R": (10.0, 0.0, 12.0, 0.15), "shrug.L": 0.0, "shrug.R": 0.0,
    "ik.L": 0.0, "ik.R": 0.0, "wrist.L": (0.2, -0.4, 1.0), "wrist.R": (-0.2, -0.4, 1.0),
    "elbow.L": (1.0, 0.3, -0.6), "elbow.R": (-1.0, 0.3, -0.6), "palm.L": 0.0, "palm.R": 0.0, "flat.L": 0.0, "flat.R": 0.0,
    "foot.L": (0.01, 0.0, 0.0, 0.0, 6.0), "foot.R": (-0.01, 0.0, 0.0, 0.0, -6.0), "toeflat.L": 1.0, "toeflat.R": 1.0,
    "knee.L": (0.12, -1.0, 0.0), "knee.R": (-0.12, -1.0, 0.0),
}


def flat_feet(l, r):
    return {"foot.L": l, "foot.R": r, "toeflat.L": 1.0, "toeflat.R": 1.0}


class Poser:
    def __init__(self, skel):
        self.s = skel
        self.ball = {s: skel.R[f"{n}ToeBase"] for s, n, _ in SIDES}
        self.ankle_from_ball = {s: skel.R[f"{n}Foot"] - skel.R[f"{n}ToeBase"] for s, n, _ in SIDES}

    def foot(self, s, p):
        bx, by, bz, pitch, yaw = p[f"foot.{s}"]
        rf = gm.rz(D(yaw)) @ gm.rx(D(pitch))
        ball = self.ball[s] + Vector((bx, by, bz))
        flat = p[f"toeflat.{s}"]
        toe_pitch = pitch * (1 - flat) + flat * max(0.0, pitch - 55.0)
        return ball, ball + rf @ self.ankle_from_ball[s], rf, gm.rz(D(yaw)) @ gm.rx(D(toe_pitch))

    def spec(self, p):
        s = self.s
        legs, arms = {}, {}
        for side, name, sx in SIDES:
            _, ankle, rf, rt = self.foot(side, p)
            legs[name] = {"ankle": ankle, "foot_q": rf, "toe_q": rt, "pole": Vector(p[f"knee.{side}"])}
            ab, sw, bend, inward = p[f"arm.{side}"]
            arm = {"hang": (D(ab), D(sw), D(bend), inward), "shoulder": gm.ry(-sx * D(p[f"shrug.{side}"])),
                   "ik": max(0.0, min(1.0, p[f"ik.{side}"]))}
            if arm["ik"] > 1e-4:
                arm["wrist"] = Vector(p[f"wrist.{side}"])
                arm["pole"] = Vector(p[f"elbow.{side}"])
            arms[name] = arm
        r = lambda key: gm.ypr(*(D(v) for v in p[key]))
        return {"hips_pos": s.R["Hips"] + Vector(p["hip"]), "hips_q": r("pelvis"), "spine": r("spine"),
                "spine2": r("chest"), "neck": r("neck"), "head": r("head"), "arms": arms, "legs": legs}

    def solve(self, p):
        Q, H, diag = self.s.solve(self.spec(p))
        for side, name, sx in SIDES:
            w = max(0.0, min(1.0, p[f"palm.{side}"]))
            if w > 0:
                # Bind palms face down with the fingers lateral: turn the fingers ahead (slightly outward)
                # and tip them over the edge.
                goal = (gm.rx(D(10)) @ gm.rz(-sx * D(78))).to_quaternion()
                Q[f"{name}Hand"] = Q[f"{name}Hand"].to_quaternion().slerp(goal, w).to_matrix()
        return Q, H, diag


# --- Clips --------------------------------------------------------------------------------------------------

def jump_clips():
    toe = (0.01, 0.0, 0.0, 32.0, 6.0)
    # Normal standing jump: arm swing back in the crouch, drive up at toe-off, tuck at the apex, reach down.
    ns_off = {"hip": (0.0, -0.03, 0.05), "pelvis": (0.0, 8.0, 0.0), "spine": (0.0, 2.0, 0.0), "chest": (0.0, -4.0, 0.0),
              "neck": (0.0, -6.0, 0.0), "head": (0.0, -4.0, 0.0), "arm.L": (16.0, 145.0, 22.0, 0.2), "arm.R": (16.0, 140.0, 24.0, 0.2),
              "shrug.*": 8.0, "foot.L": toe, "foot.R": (-0.01, 0.0, 0.0, 32.0, -6.0)}
    ns_apex = {"hip": (0.0, 0.0, 0.02), "pelvis": (0.0, 14.0, 0.0), "spine": (0.0, 6.0, 0.0), "chest": (0.0, 3.0, 0.0),
               "neck": (0.0, -10.0, 0.0), "head": (0.0, -7.0, 0.0), "arm.L": (40.0, 78.0, 30.0, 0.2), "arm.R": (42.0, 74.0, 32.0, 0.2),
               "shrug.*": 0.0, "foot.L": (0.05, -0.09, 0.38, 16.0, 8.0), "foot.R": (-0.06, -0.04, 0.33, 22.0, -8.0),
               "toeflat.*": 0.0}
    ns_touch = {"hip": (0.0, 0.0, -0.04), "pelvis": (0.0, 6.0, 0.0), "spine": (0.0, 2.0, 0.0), "chest": (0.0, 0.0, 0.0),
                "neck": (0.0, -4.0, 0.0), "head": (0.0, -3.0, 0.0), "arm.L": (40.0, 50.0, 22.0, 0.2), "arm.R": (42.0, 46.0, 24.0, 0.2),
                "foot.L": (0.035, -0.05, 0.0, 14.0, 7.0), "foot.R": (-0.04, 0.03, 0.0, 18.0, -7.0), "toeflat.*": 1.0}
    clips = {}
    clips["normal_stand_takeoff"] = keyed(STAND, [
        (0.0, {}),
        (0.45, {"hip": (0.0, 0.035, -0.17), "pelvis": (0.0, 24.0, 0.0), "spine": (0.0, 8.0, 0.0), "chest": (0.0, 4.0, 0.0),
                "neck": (0.0, -12.0, 0.0), "head": (0.0, -8.0, 0.0), "arm.L": (14.0, -48.0, 18.0, 0.15), "arm.R": (14.0, -50.0, 18.0, 0.15)}),
        (1.0, ns_off)])
    clips["normal_stand_rise"] = keyed({**STAND, **expand(ns_off)}, [
        (0.0, {"foot.L": (0.01, 0.0, 0.02, 38.0, 6.0), "foot.R": (-0.01, 0.0, 0.02, 38.0, -6.0), "toeflat.*": 0.3}),
        (0.3, {"hip": (0.0, -0.01, 0.03), "chest": (0.0, -5.0, 0.0), "head": (0.0, -6.0, 0.0),
               "arm.L": (18.0, 150.0, 18.0, 0.2), "arm.R": (18.0, 146.0, 20.0, 0.2),
               "foot.L": (0.02, 0.06, 0.10, 34.0, 6.0), "foot.R": (-0.02, 0.07, 0.09, 36.0, -6.0), "toeflat.*": 0.0}),
        (0.65, {"hip": (0.0, 0.0, 0.02), "pelvis": (0.0, 10.0, 0.0), "spine": (0.0, 4.0, 0.0), "chest": (0.0, 0.0, 0.0),
                "arm.L": (34.0, 105.0, 26.0, 0.2), "arm.R": (36.0, 100.0, 28.0, 0.2), "shrug.*": 3.0,
                "foot.L": (0.04, -0.04, 0.30, 22.0, 8.0), "foot.R": (-0.05, 0.0, 0.25, 26.0, -8.0)}),
        (1.0, ns_apex)])
    clips["normal_stand_fall"] = keyed({**STAND, **expand(ns_apex)}, [
        (0.0, {}),
        (0.4, {"pelvis": (0.0, 9.0, 0.0), "spine": (0.0, 3.0, 0.0), "head": (0.0, -4.0, 0.0),
               "arm.L": (44.0, 62.0, 26.0, 0.2), "arm.R": (46.0, 58.0, 28.0, 0.2),
               "foot.L": (0.04, -0.05, 0.17, 20.0, 8.0), "foot.R": (-0.05, 0.0, 0.13, 26.0, -8.0)}),
        (0.8, {"hip": (0.0, 0.0, -0.025), "pelvis": (0.0, 6.0, 0.0), "arm.L": (40.0, 50.0, 22.0, 0.2), "arm.R": (42.0, 46.0, 24.0, 0.2),
               "foot.L": (0.035, -0.05, 0.045, 22.0, 7.0), "foot.R": (-0.04, 0.03, 0.04, 26.0, -7.0)}),
        (1.0, ns_touch)])
    clips["normal_stand_land"] = keyed({**STAND, **expand(ns_touch)}, [
        (0.0, {}),
        (0.12, {"hip": (0.0, 0.02, -0.09), "pelvis": (0.0, 12.0, 0.0),
                **flat_feet((0.035, -0.05, 0.0, 0.0, 7.0), (-0.04, 0.03, 0.0, 0.0, -7.0))}),
        (0.3, {"hip": (0.0, 0.05, -0.23), "pelvis": (0.0, 26.0, 0.0), "spine": (0.0, 10.0, 0.0), "chest": (0.0, 6.0, 0.0),
               "neck": (0.0, -16.0, 0.0), "head": (0.0, -10.0, 0.0), "arm.L": (26.0, 48.0, 34.0, 0.2), "arm.R": (28.0, 44.0, 36.0, 0.2)}),
        (0.62, {"hip": (0.0, 0.02, -0.08), "pelvis": (0.0, 10.0, 0.0), "spine": (0.0, 4.0, 0.0), "chest": (0.0, 1.0, 0.0),
                "neck": (0.0, -6.0, 0.0), "head": (0.0, -3.0, 0.0), "arm.L": (16.0, 16.0, 22.0, 0.15), "arm.R": (16.0, 14.0, 22.0, 0.15)}),
        (1.0, {k: STAND[k] for k in ("hip", "pelvis", "spine", "chest", "neck", "head", "arm.L", "arm.R")})])

    # Super standing jump: deep load, whole body thrown upward, long streamlined rise, open tuck, reach and
    # a crouched three-point landing with the right hand on the ground.
    ss_off = {**ns_off, "hip": (0.0, -0.02, 0.05), "pelvis": (0.0, 4.0, 0.0), "spine": (0.0, 0.0, 0.0), "chest": (0.0, -8.0, 0.0),
              "neck": (0.0, -10.0, 0.0), "head": (0.0, -10.0, 0.0), "arm.L": (8.0, 168.0, 10.0, 0.1), "arm.R": (8.0, 166.0, 10.0, 0.1),
              "shrug.*": 16.0, "foot.L": (0.01, 0.0, 0.0, 34.0, 6.0), "foot.R": (-0.01, 0.0, 0.0, 34.0, -6.0)}
    ss_apex = {"hip": (0.0, 0.0, 0.03), "pelvis": (0.0, 16.0, 0.0), "spine": (0.0, 8.0, 0.0), "chest": (0.0, 5.0, 0.0),
               "neck": (0.0, -12.0, 0.0), "head": (0.0, -8.0, 0.0), "arm.L": (62.0, 86.0, 30.0, 0.2), "arm.R": (64.0, 82.0, 32.0, 0.2),
               "shrug.*": 0.0, "foot.L": (0.06, -0.11, 0.42, 14.0, 10.0), "foot.R": (-0.06, -0.07, 0.40, 18.0, -10.0), "toeflat.*": 0.0}
    ss_touch = {"hip": (0.0, 0.0, -0.045), "pelvis": (0.0, 10.0, 0.0), "spine": (0.0, 4.0, 0.0), "chest": (0.0, 0.0, 0.0),
                "neck": (0.0, -6.0, 0.0), "head": (0.0, -6.0, 0.0), "arm.L": (52.0, 88.0, 26.0, 0.2), "arm.R": (50.0, 84.0, 28.0, 0.2),
                "foot.L": (0.06, -0.07, 0.0, 12.0, 9.0), "foot.R": (-0.07, 0.05, 0.0, 16.0, -9.0), "toeflat.*": 1.0}
    clips["super_stand_takeoff"] = keyed(STAND, [
        (0.0, {}),
        (0.5, {"hip": (0.0, 0.05, -0.25), "pelvis": (0.0, 30.0, 0.0), "spine": (0.0, 10.0, 0.0), "chest": (0.0, 6.0, 0.0),
               "neck": (0.0, -16.0, 0.0), "head": (0.0, -10.0, 0.0), "arm.L": (16.0, -58.0, 16.0, 0.15), "arm.R": (16.0, -60.0, 16.0, 0.15)}),
        (1.0, ss_off)])
    clips["super_stand_rise"] = keyed({**STAND, **expand(ss_off)}, [
        (0.0, {"foot.L": (0.01, 0.0, 0.02, 40.0, 6.0), "foot.R": (-0.01, 0.0, 0.02, 40.0, -6.0), "toeflat.*": 0.3}),
        (0.18, {"hip": (0.0, 0.0, 0.04), "chest": (0.0, -7.0, 0.0), "head": (0.0, -14.0, 0.0),
                "arm.L": (10.0, 172.0, 6.0, 0.1), "arm.R": (10.0, 170.0, 6.0, 0.1), "shrug.*": 18.0,
                "foot.L": (0.015, 0.05, 0.05, 48.0, 4.0), "foot.R": (-0.015, 0.05, 0.05, 48.0, -4.0), "toeflat.*": 0.0}),
        (0.5, {"pelvis": (0.0, 4.0, 0.0), "chest": (0.0, -4.0, 0.0), "head": (0.0, -8.0, 0.0),
               "arm.L": (38.0, 150.0, 12.0, 0.15), "arm.R": (40.0, 146.0, 14.0, 0.15), "shrug.*": 10.0,
               "foot.L": (0.03, 0.06, 0.12, 40.0, 6.0), "foot.R": (-0.03, 0.07, 0.11, 42.0, -6.0)}),
        (0.8, {"pelvis": (0.0, 10.0, 0.0), "spine": (0.0, 4.0, 0.0), "chest": (0.0, 0.0, 0.0), "head": (0.0, -6.0, 0.0),
               "arm.L": (55.0, 112.0, 20.0, 0.2), "arm.R": (58.0, 106.0, 22.0, 0.2), "shrug.*": 4.0,
               "foot.L": (0.05, -0.04, 0.30, 22.0, 8.0), "foot.R": (-0.05, 0.0, 0.26, 26.0, -8.0)}),
        (1.0, ss_apex)])
    clips["super_stand_fall"] = keyed({**STAND, **expand(ss_apex)}, [
        (0.0, {}),
        (0.3, {"hip": (0.0, 0.0, 0.0), "pelvis": (0.0, 8.0, 0.0), "spine": (0.0, 2.0, 0.0), "chest": (0.0, -3.0, 0.0), "head": (0.0, -4.0, 0.0),
               "arm.L": (72.0, 116.0, 24.0, 0.2), "arm.R": (70.0, 120.0, 22.0, 0.2),
               "foot.L": (0.05, -0.06, 0.22, 22.0, 10.0), "foot.R": (-0.06, 0.0, 0.18, 26.0, -10.0)}),
        (0.7, {"hip": (0.0, 0.0, -0.02), "pelvis": (0.0, 4.0, 0.0), "chest": (0.0, -2.0, 0.0), "head": (0.0, -1.0, 0.0),
               "arm.L": (76.0, 128.0, 18.0, 0.2), "arm.R": (74.0, 132.0, 20.0, 0.2),
               "foot.L": (0.06, -0.09, 0.06, 26.0, 10.0), "foot.R": (-0.07, 0.07, 0.08, 30.0, -10.0)}),
        (0.9, {"pelvis": (0.0, 10.0, 0.0), "spine": (0.0, 4.0, 0.0), "head": (0.0, -6.0, 0.0),
               "arm.L": (52.0, 88.0, 26.0, 0.2), "arm.R": (50.0, 84.0, 28.0, 0.2),
               "foot.L": (0.06, -0.07, 0.02, 18.0, 9.0), "foot.R": (-0.07, 0.05, 0.03, 22.0, -9.0)}),
        (1.0, ss_touch)])
    hero = {"hip": (0.0, 0.10, -0.52), "pelvis": (-6.0, 46.0, -4.0), "spine": (-4.0, 18.0, 0.0), "chest": (-4.0, 12.0, -10.0),
            "neck": (0.0, -30.0, 0.0), "head": (4.0, -20.0, 0.0), "shrug.R": -10.0,
            "foot.L": (0.08, -0.18, 0.0, 0.0, 12.0), "toeflat.L": 1.0, "foot.R": (-0.09, 0.28, 0.0, 50.0, -8.0), "toeflat.R": 1.0,
            "knee.R": (-0.15, -1.0, -0.5), "ik.R": 1.0, "wrist.R": (-0.24, -0.33, 0.10), "elbow.R": (-1.0, 0.3, 0.2),
            "palm.R": 0.9, "flat.R": 1.0, "arm.L": (62.0, -24.0, 30.0, 0.2), "arm.R": (30.0, 60.0, 10.0, 0.2)}
    clips["super_stand_land"] = keyed({**STAND, **expand(ss_touch)}, [
        (0.0, {}),
        (0.08, {"hip": (0.0, 0.04, -0.16), "pelvis": (0.0, 18.0, 0.0),
                **flat_feet((0.06, -0.07, 0.0, 0.0, 9.0), (-0.07, 0.05, 0.0, 0.0, -9.0))}),
        (0.2, hero),
        (0.42, {"hip": (0.0, 0.10, -0.50), "neck": (0.0, -28.0, 0.0), "head": (2.0, -22.0, 0.0)}),
        (0.68, {"hip": (0.0, 0.04, -0.16), "pelvis": (0.0, 12.0, 0.0), "spine": (0.0, 4.0, 0.0), "chest": (0.0, 2.0, 0.0),
                "neck": (0.0, -6.0, 0.0), "head": (0.0, -4.0, 0.0), "ik.R": 0.0, "palm.R": 0.0, "flat.R": 0.0, "shrug.R": 0.0,
                "arm.R": (20.0, 20.0, 30.0, 0.15), "arm.L": (24.0, 10.0, 28.0, 0.15),
                "foot.R": (-0.07, 0.10, 0.04, 16.0, -8.0), "toeflat.R": 0.0, "knee.R": (-0.12, -1.0, 0.0)}),
        (1.0, {"hip": (0.0, -0.05, -0.02), "pelvis": STAND["pelvis"], "spine": STAND["spine"], "chest": STAND["chest"],
               "neck": STAND["neck"], "head": STAND["head"], "arm.L": STAND["arm.L"], "arm.R": STAND["arm.R"],
               "foot.R": (-0.07, -0.04, 0.0, 0.0, -8.0), "toeflat.R": 1.0})])

    # Running jumps (left take-off foot): the right knee drives up, arms in opposition, a stride leap,
    # the right leg reaches to land and the run continues.
    run = {**STAND, "hip": (0.0, 0.0, -0.06), "pelvis": (4.0, 10.0, 0.0), "spine": (-3.0, 4.0, 0.0), "chest": (-4.0, 2.0, 0.0),
           "neck": (0.0, -6.0, 0.0), "head": (2.0, -4.0, 0.0), "arm.L": (12.0, 38.0, 88.0, 0.3), "arm.R": (12.0, -34.0, 80.0, 0.3),
           "foot.L": (0.01, 0.04, 0.0, 6.0, 4.0), "toeflat.L": 1.0, "foot.R": (-0.03, 0.34, 0.20, 52.0, -4.0), "toeflat.R": 0.0}
    nr_off = {"hip": (0.0, -0.05, 0.03), "pelvis": (-6.0, 6.0, 2.0), "spine": (4.0, 2.0, 0.0), "chest": (6.0, -2.0, 0.0),
              "neck": (0.0, -4.0, 0.0), "head": (-2.0, -4.0, 0.0),
              "foot.L": (0.01, 0.24, 0.0, 46.0, 4.0), "foot.R": (-0.05, -0.30, 0.40, 28.0, -4.0),
              "arm.L": (14.0, 92.0, 70.0, 0.3), "arm.R": (20.0, -48.0, 58.0, 0.3)}
    nr_apex = {"hip": (0.0, -0.02, 0.02), "pelvis": (-3.0, 6.0, 1.0), "chest": (3.0, -2.0, 0.0), "head": (-2.0, -6.0, 0.0),
               "foot.L": (0.03, 0.38, 0.34, 46.0, 4.0), "foot.R": (-0.05, -0.40, 0.30, 14.0, -4.0), "toeflat.*": 0.0,
               "arm.L": (30.0, 84.0, 40.0, 0.25), "arm.R": (44.0, -8.0, 40.0, 0.25)}
    nr_touch = {"hip": (0.0, 0.0, -0.03), "pelvis": (4.0, 10.0, 0.0), "chest": (-2.0, 1.0, 0.0), "head": (0.0, -4.0, 0.0),
                "foot.L": (0.03, 0.16, 0.26, 40.0, 4.0), "foot.R": (-0.04, -0.16, 0.0, 6.0, -4.0), "toeflat.*": 0.0, "toeflat.R": 1.0,
                "arm.L": (14.0, 26.0, 74.0, 0.3), "arm.R": (16.0, -14.0, 70.0, 0.3)}
    clips["normal_run_takeoff"] = keyed(run, [
        (0.0, {}),
        (0.5, {"hip": (0.0, 0.0, -0.08), "foot.R": (-0.04, 0.05, 0.25, 40.0, -4.0),
               "arm.L": (12.0, 55.0, 80.0, 0.3), "arm.R": (14.0, -40.0, 72.0, 0.3)}),
        (1.0, nr_off)])
    clips["normal_run_rise"] = keyed({**run, **expand(nr_off)}, [
        (0.0, {"foot.L": (0.01, 0.26, 0.03, 48.0, 4.0), "toeflat.L": 0.2}),
        (0.45, {"hip": (0.0, -0.02, 0.03), "pelvis": (-6.0, 4.0, 2.0), "chest": (6.0, -4.0, 0.0), "head": (-2.0, -6.0, 0.0),
                "foot.L": (0.03, 0.40, 0.24, 44.0, 4.0), "toeflat.L": 0.0, "foot.R": (-0.05, -0.34, 0.44, 24.0, -4.0),
                "arm.L": (20.0, 104.0, 46.0, 0.3), "arm.R": (34.0, -30.0, 42.0, 0.3)}),
        (1.0, nr_apex)])
    clips["normal_run_fall"] = keyed({**run, **expand(nr_apex)}, [
        (0.0, {}),
        (0.6, {"pelvis": (2.0, 8.0, -1.0), "chest": (-2.0, 0.0, 0.0), "head": (0.0, -4.0, 0.0),
               "foot.L": (0.03, 0.22, 0.30, 40.0, 4.0), "foot.R": (-0.05, -0.26, 0.10, 10.0, -4.0),
               "arm.L": (20.0, 40.0, 62.0, 0.3), "arm.R": (30.0, 6.0, 56.0, 0.3)}),
        (1.0, nr_touch)])
    clips["normal_run_land"] = keyed({**run, **expand(nr_touch)}, [
        (0.0, {}),
        (0.4, {"hip": (0.0, 0.0, -0.12), "pelvis": (4.0, 12.0, 0.0), "spine": (-2.0, 5.0, 0.0), "chest": (-3.0, 3.0, 0.0),
               "foot.R": (-0.04, 0.02, 0.0, 0.0, -4.0), "toeflat.R": 1.0, "foot.L": (0.03, 0.02, 0.20, 34.0, 4.0),
               "arm.L": (12.0, -30.0, 76.0, 0.3), "arm.R": (12.0, 36.0, 84.0, 0.3)}),
        (1.0, {"hip": (0.0, 0.0, -0.07), "pelvis": (-4.0, 10.0, 0.0), "spine": (3.0, 4.0, 0.0), "chest": (4.0, 2.0, 0.0),
               "foot.R": (-0.04, 0.26, 0.0, 30.0, -4.0), "foot.L": (0.03, -0.14, 0.24, 20.0, 4.0),
               "arm.L": (12.0, -36.0, 80.0, 0.3), "arm.R": (12.0, 40.0, 88.0, 0.3)})])

    sr_apex = {**ss_apex, "foot.L": (0.06, -0.08, 0.40, 16.0, 10.0), "foot.R": (-0.06, -0.12, 0.42, 14.0, -10.0),
               "pelvis": (0.0, 14.0, 0.0)}
    clips["super_run_takeoff"] = keyed(run, [
        (0.0, {}),
        (0.5, {"hip": (0.0, 0.0, -0.11), "pelvis": (4.0, 14.0, 0.0), "foot.R": (-0.04, 0.05, 0.25, 40.0, -4.0),
               "arm.L": (12.0, 40.0, 70.0, 0.3), "arm.R": (14.0, -50.0, 60.0, 0.3)}),
        (1.0, {**nr_off, "arm.L": (14.0, 128.0, 40.0, 0.25), "arm.R": (20.0, 60.0, 50.0, 0.25), "shrug.*": 6.0})])
    clips["super_run_rise"] = keyed({**run, **expand(nr_off), "arm.L": (14.0, 128.0, 40.0, 0.25), "arm.R": (20.0, 60.0, 50.0, 0.25)}, [
        (0.0, {"foot.L": (0.01, 0.26, 0.03, 48.0, 4.0), "toeflat.L": 0.2}),
        (0.2, {"hip": (0.0, -0.02, 0.04), "pelvis": (-4.0, 2.0, 1.0), "chest": (2.0, -8.0, 0.0), "head": (0.0, -12.0, 0.0),
               "foot.L": (0.02, 0.30, 0.06, 52.0, 4.0), "foot.R": (-0.05, -0.32, 0.52, 22.0, -4.0), "toeflat.*": 0.0,
               "arm.L": (18.0, 150.0, 24.0, 0.2), "arm.R": (24.0, 128.0, 30.0, 0.2), "shrug.*": 12.0}),
        (0.6, {"pelvis": (0.0, 6.0, 0.0), "spine": (0.0, 2.0, 0.0), "chest": (0.0, -4.0, 0.0), "head": (0.0, -6.0, 0.0),
               "foot.L": (0.04, 0.12, 0.18, 38.0, 6.0), "foot.R": (-0.05, -0.06, 0.24, 30.0, -6.0),
               "arm.L": (44.0, 138.0, 16.0, 0.2), "arm.R": (46.0, 132.0, 18.0, 0.2), "shrug.*": 6.0}),
        (1.0, sr_apex)])
    clips["super_run_fall"] = keyed({**run, **expand(sr_apex)}, [
        (0.0, {}),
        (0.35, {"pelvis": (0.0, 6.0, 0.0), "foot.L": (0.05, 0.0, 0.20, 24.0, 8.0), "foot.R": (-0.06, -0.12, 0.18, 20.0, -8.0),
                "arm.L": (70.0, 118.0, 24.0, 0.2), "arm.R": (68.0, 122.0, 22.0, 0.2)}),
        (0.8, {"pelvis": (2.0, 10.0, 0.0), "chest": (-2.0, 2.0, 0.0), "head": (0.0, -5.0, 0.0),
               "foot.L": (0.04, 0.18, 0.22, 36.0, 6.0), "foot.R": (-0.05, -0.22, 0.06, 10.0, -6.0),
               "arm.L": (40.0, 70.0, 40.0, 0.25), "arm.R": (40.0, 40.0, 40.0, 0.25)}),
        (1.0, {**nr_touch, "arm.L": (26.0, 40.0, 60.0, 0.3), "arm.R": (28.0, 10.0, 56.0, 0.3)})])
    clips["super_run_land"] = keyed({**run, **expand(nr_touch), "arm.L": (26.0, 40.0, 60.0, 0.3), "arm.R": (28.0, 10.0, 56.0, 0.3)}, [
        (0.0, {}),
        (0.38, {"hip": (0.0, 0.03, -0.24), "pelvis": (4.0, 22.0, 0.0), "spine": (-2.0, 8.0, 0.0), "chest": (-3.0, 5.0, 0.0),
                "neck": (0.0, -12.0, 0.0), "head": (0.0, -8.0, 0.0),
                "foot.R": (-0.04, 0.04, 0.0, 0.0, -4.0), "toeflat.R": 1.0, "foot.L": (0.04, 0.10, 0.12, 30.0, 4.0),
                "arm.L": (30.0, 30.0, 56.0, 0.3), "arm.R": (34.0, 44.0, 60.0, 0.3)}),
        (1.0, {"hip": (0.0, 0.0, -0.08), "pelvis": (-4.0, 10.0, 0.0), "spine": (3.0, 4.0, 0.0), "chest": (4.0, 2.0, 0.0),
               "neck": STAND["neck"], "head": (0.0, -4.0, 0.0),
               "foot.R": (-0.04, 0.30, 0.0, 34.0, -4.0), "foot.L": (0.03, -0.14, 0.24, 20.0, 4.0),
               "arm.L": (12.0, -36.0, 80.0, 0.3), "arm.R": (12.0, 40.0, 88.0, 0.3)})])

    out = {}
    for kind in ("normal", "super"):
        for phase in ("takeoff", "rise", "fall", "land"):
            out[f"{kind}_stand_{phase}"] = clips[f"{kind}_stand_{phase}"]
            out[f"{kind}_runL_{phase}"] = clips[f"{kind}_run_{phase}"]
            out[f"{kind}_runR_{phase}"] = mirrored(clips[f"{kind}_run_{phase}"])
    return out


def air_loop(u):
    """Long falls: slow alternating arm circles and leg cycling for balance (one 1.2 s cycle)."""
    a = 2 * math.pi * u
    p = dict(STAND)
    p.update({"hip": (0.0, 0.0, 0.0), "pelvis": (0.0, 7.0 + 2.0 * math.sin(a), 0.0), "spine": (0.0, 3.0, 0.0),
              "chest": (0.0, -2.0 + 1.5 * math.sin(a + 0.6), 0.0), "neck": (0.0, -6.0, 0.0), "head": (2.0 * math.sin(a), -3.0, 0.0),
              "toeflat.L": 0.0, "toeflat.R": 0.0})
    for s, _, sx in SIDES:
        ph = a + (0.0 if s == "L" else math.pi)
        p[f"arm.{s}"] = (62.0 + 8.0 * math.cos(ph), 104.0 + 20.0 * math.sin(ph), 26.0 + 6.0 * math.cos(ph), 0.2)
        p[f"foot.{s}"] = (sx * 0.05, -0.03 + 0.09 * math.sin(ph), 0.16 + 0.08 * math.cos(ph), 26.0 + 6.0 * math.sin(ph), sx * 8.0)
    return p


def climb_root(u, h):
    """Feet of the simulation capsule in the ledge frame (packages/sim/src/character.ts climbPathPoint)."""
    r = CLIMB["riseFraction"]
    return Vector((0.0, -TRAVEL * gm.smooth((u - r) / (1 - r)), (h + CLIMB["lift"]) * gm.smooth(u / r)))


def climb_clips():
    # Ledge frame: the capsule's feet start at the origin below the wall position, the wall face is y = -WALL and
    # the top is z = h. While a hand grips, its shoulder stays within arm's length of the wrist (report:
    # maxGripArmReach), and a foot comes over the edge only once the hips are high enough that the ankle stays
    # below the hip (no knee flip).
    def grip(h, onto=0.05, spread=0.20, up=0.035):
        return {"ik.*": 1.0, "wrist.L": (spread, -WALL - onto, h + up), "wrist.R": (-spread, -WALL - onto, h + up),
                "palm.*": 1.0, "flat.*": 0.8}

    release = {"ik.*": 0.0, "palm.*": 0.0, "flat.*": 0.0, "arm.L": (22.0, -8.0, 22.0, 0.15), "arm.R": (22.0, -6.0, 22.0, 0.15),
               "shrug.*": 0.0, "elbow.*": (1.0, 0.3, -0.6)}
    out_knee = {"knee.R": (-0.75, -0.35, 0.45)}

    def end(h):
        # Standing on top at the simulation's target, feet beside each other.
        return {"hip": (0.0, -TRAVEL, h - 0.02), "pelvis": STAND["pelvis"], "spine": STAND["spine"], "chest": STAND["chest"],
                "neck": STAND["neck"], "head": STAND["head"], "arm.L": STAND["arm.L"], "arm.R": STAND["arm.R"],
                "knee.L": STAND["knee.L"], "knee.R": STAND["knee.R"],
                "foot.L": (0.02, -TRAVEL - 0.04, h, 0.0, 6.0), "foot.R": (-0.02, -TRAVEL + 0.02, h, 0.0, -6.0),
                "toeflat.L": 1.0, "toeflat.R": 1.0}

    def settle(h):
        # The trailing (right) foot steps in beside the left one.
        return {"foot.R": (-0.06, -TRAVEL + 0.10, h + 0.07, 22.0, -10.0), "toeflat.R": 0.0}

    # High (shoulder height above the airborne feet): catch with bent arms, pull the chest to the edge, press
    # with the palms rolling onto the top, right foot over wide, rise over it as the hands push off, left foot
    # over, stand.
    h = 1.5
    high = keyed(STAND, [
        (0.0, {"hip": (0.0, -0.09, -0.08), "pelvis": (0.0, 4.0, 0.0), "spine": (0.0, 3.0, 0.0), "chest": (0.0, -4.0, 0.0),
               "neck": (0.0, -12.0, 0.0), "head": (0.0, -14.0, 0.0), **grip(h), "elbow.*": (1.0, 0.2, -0.8), "shrug.*": 12.0,
               "foot.L": (0.07, -0.16, 0.16, -20.0, 6.0), "foot.R": (-0.08, 0.04, 0.10, 30.0, -6.0), "toeflat.*": 0.0,
               "knee.L": (0.7, -0.5, 0.0)}),
        (0.18, {"hip": (0.0, -0.12, 0.24), "pelvis": (0.0, 8.0, 0.0), "spine": (0.0, 4.0, 0.0), "chest": (0.0, 0.0, 0.0),
                "neck": (0.0, -10.0, 0.0), "head": (0.0, -10.0, 0.0), "shrug.*": 4.0, "elbow.*": (1.0, 0.6, -0.4),
                "foot.L": (0.07, -0.18, 0.55, -40.0, 6.0), "foot.R": (-0.08, -0.02, 0.30, 25.0, -6.0)}),
        (0.34, {"hip": (0.0, -0.17, 0.52), "pelvis": (0.0, 24.0, 0.0), "spine": (0.0, 10.0, 0.0), "chest": (0.0, 6.0, 0.0),
                "neck": (0.0, -18.0, 0.0), "head": (0.0, -10.0, 0.0), "shrug.*": 0.0, "elbow.*": (0.8, 1.0, 0.2),
                "foot.L": (0.07, -0.18, 0.80, -30.0, 6.0), "foot.R": (-0.08, -0.10, 0.62, 15.0, -6.0), **out_knee}),
        (0.44, {"hip": (0.0, -0.22, 0.86), "pelvis": (0.0, 46.0, 0.0), "spine": (0.0, 18.0, 0.0), "chest": (0.0, 10.0, 0.0),
                "neck": (0.0, -32.0, 0.0), "head": (0.0, -12.0, 0.0), "elbow.*": (0.6, 1.0, 0.6), **grip(h, onto=0.12),
                "foot.R": (-0.18, -0.10, 1.10, 20.0, -14.0), "foot.L": (0.07, -0.18, 0.98, -20.0, 6.0)}),
        (0.50, {"foot.R": (-0.20, -0.18, h + 0.05, 10.0, -10.0)}),
        (0.58, {"hip": (0.0, -0.28, 0.86), "foot.R": (-0.19, -0.42, h, 0.0, -10.0), "toeflat.R": 1.0, "knee.R": (-0.45, -0.8, 0.25),
                "foot.L": (0.07, -0.18, 1.08, -15.0, 6.0)}),
        (0.66, {"hip": (0.0, -0.42, 1.04), "pelvis": (0.0, 34.0, 0.0), "spine": (0.0, 10.0, 0.0), "chest": (0.0, 4.0, 0.0),
                "neck": (0.0, -18.0, 0.0), "head": (0.0, -8.0, 0.0), **release,
                "foot.L": (0.08, -0.12, h - 0.12, 10.0, 6.0), "knee.L": (0.45, -0.65, 0.5)}),
        (0.70, {"foot.L": (0.06, -0.28, h + 0.12, 20.0, 6.0)}),
        (0.74, {"hip": (0.0, -0.58, 1.22), "pelvis": (0.0, 24.0, 0.0), "spine": (0.0, 6.0, 0.0), "chest": (0.0, 2.0, 0.0),
                "neck": (0.0, -10.0, 0.0), "head": (0.0, -5.0, 0.0), "arm.L": (18.0, 10.0, 26.0, 0.15), "arm.R": (18.0, 14.0, 26.0, 0.15),
                "foot.L": (0.05, -0.50, h + 0.08, 15.0, 6.0), "knee.L": (0.2, -1.0, 0.3), "knee.R": (-0.25, -0.9, 0.2)}),
        (0.81, {"hip": (0.0, -0.72, h - 0.10), "pelvis": (0.0, 14.0, 0.0), "foot.L": (0.02, -TRAVEL - 0.04, h, 2.0, 6.0), "toeflat.L": 1.0,
                "knee.L": STAND["knee.L"]}),
        (0.90, {**settle(h), "knee.R": STAND["knee.R"]}),
        (1.0, end(h)),
    ])
    # Mid (chest height): hands on the edge with bent elbows, press with a near-horizontal torso as the palms roll
    # onto the top, right foot over wide, rise over it as the hands push off.
    h = 1.0
    mid = keyed(STAND, [
        (0.0, {"hip": (0.0, -0.07, 0.03), "pelvis": (0.0, 6.0, 0.0), "spine": (0.0, 4.0, 0.0), "chest": (0.0, 0.0, 0.0),
               "neck": (0.0, -10.0, 0.0), "head": (0.0, -12.0, 0.0), **grip(h), "elbow.*": (1.0, 0.3, -0.5), "shrug.*": 6.0,
               "foot.L": (0.07, -0.18, 0.25, -25.0, 6.0), "foot.R": (-0.08, 0.0, 0.10, 25.0, -6.0), "toeflat.*": 0.0,
               "knee.L": (0.7, -0.5, 0.0)}),
        (0.16, {"hip": (0.0, -0.13, 0.18), "pelvis": (0.0, 24.0, 0.0), "spine": (0.0, 8.0, 0.0), "chest": (0.0, 4.0, 0.0),
                "neck": (0.0, -18.0, 0.0), "head": (0.0, -10.0, 0.0), "shrug.*": 0.0, "elbow.*": (1.0, 0.6, 0.0),
                "foot.R": (-0.16, -0.04, 0.52, 25.0, -14.0), **out_knee, "foot.L": (0.07, -0.17, 0.40, -20.0, 6.0)}),
        (0.26, {"hip": (0.0, -0.18, 0.36), "pelvis": (0.0, 44.0, 0.0), "spine": (0.0, 18.0, 0.0), "chest": (0.0, 10.0, 0.0),
                "neck": (0.0, -30.0, 0.0), "head": (0.0, -12.0, 0.0), "elbow.*": (1.0, 0.3, 0.4), **grip(h, onto=0.12),
                "foot.R": (-0.18, -0.08, 0.80, 20.0, -14.0), "foot.L": (0.07, -0.17, 0.50, -20.0, 6.0)}),
        (0.32, {"foot.R": (-0.20, -0.18, h + 0.05, 10.0, -10.0)}),
        (0.38, {"hip": (0.0, -0.22, 0.38), "foot.R": (-0.19, -0.40, h, 0.0, -10.0), "toeflat.R": 1.0, "knee.R": (-0.45, -0.8, 0.25),
                "foot.L": (0.07, -0.16, 0.56, -15.0, 6.0)}),
        (0.46, {"hip": (0.0, -0.38, 0.52), "pelvis": (0.0, 30.0, 0.0), "spine": (0.0, 10.0, 0.0), "chest": (0.0, 4.0, 0.0),
                "neck": (0.0, -16.0, 0.0), "head": (0.0, -8.0, 0.0), **release,
                "foot.L": (0.07, -0.13, 0.72, 10.0, 6.0), "knee.L": (0.3, -0.8, 0.4)}),
        (0.53, {"foot.L": (0.07, -0.18, h - 0.06, 20.0, 6.0)}),
        (0.57, {"foot.L": (0.06, -0.28, h + 0.10, 20.0, 6.0)}),
        (0.60, {"hip": (0.0, -0.54, 0.74), "pelvis": (0.0, 22.0, 0.0), "spine": (0.0, 6.0, 0.0), "chest": (0.0, 2.0, 0.0),
                "neck": (0.0, -10.0, 0.0), "head": (0.0, -5.0, 0.0), "arm.L": (18.0, 10.0, 26.0, 0.15), "arm.R": (18.0, 14.0, 26.0, 0.15),
                "foot.L": (0.05, -0.46, h + 0.08, 15.0, 6.0), "knee.L": (0.2, -1.0, 0.3), "knee.R": (-0.25, -0.9, 0.2)}),
        (0.72, {"hip": (0.0, -0.70, h - 0.08), "pelvis": (0.0, 12.0, 0.0), "spine": (0.0, 4.0, 0.0), "chest": (0.0, 1.0, 0.0),
                "neck": (0.0, -4.0, 0.0), "head": (0.0, -3.0, 0.0),
                "foot.L": (0.02, -TRAVEL - 0.04, h, 4.0, 6.0), "toeflat.L": 1.0, "knee.L": STAND["knee.L"],
                "foot.R": (-0.19, -0.40, h, 30.0, -10.0)}),
        (0.85, {**settle(h), "knee.R": STAND["knee.R"]}),
        (1.0, end(h)),
    ])
    # Low (knee height): no hands; the arms reach toward the top for balance while the right foot steps onto it, then
    # drive up over it. Contacts follow the mid climb's timeline (right foot down, left foot over and down) so that
    # a climb between the two heights blends matching phases.
    h = 0.5
    low = keyed(STAND, [
        (0.0, {"hip": (0.0, -0.04, -0.02), "pelvis": (0.0, 14.0, 0.0), "spine": (0.0, 6.0, 0.0), "chest": (0.0, 2.0, 0.0),
               "neck": (0.0, -10.0, 0.0), "head": (0.0, -8.0, 0.0), "arm.L": (18.0, 42.0, 34.0, 0.2), "arm.R": (18.0, 46.0, 32.0, 0.2),
               "foot.R": (-0.07, -0.02, 0.18, 20.0, -6.0), "foot.L": (0.07, 0.05, 0.02, 30.0, 6.0), "toeflat.*": 0.0}),
        (0.14, {"hip": (0.0, -0.08, 0.04), "pelvis": (0.0, 20.0, 0.0), "spine": (0.0, 8.0, 0.0), "chest": (0.0, 4.0, 0.0),
                "neck": (0.0, -14.0, 0.0), "arm.L": (20.0, 56.0, 28.0, 0.2), "arm.R": (20.0, 60.0, 26.0, 0.2),
                "foot.R": (-0.10, -0.10, h - 0.04, 22.0, -10.0), "knee.R": (-0.6, -0.7, 0.35),
                "foot.L": (0.07, 0.05, 0.08, 34.0, 6.0)}),
        (0.24, {"hip": (0.0, -0.13, 0.08), "pelvis": (0.0, 24.0, 0.0), "foot.R": (-0.10, -0.26, h + 0.08, 12.0, -10.0)}),
        (0.32, {"hip": (0.0, -0.20, 0.13), "foot.R": (-0.10, -0.46, h, 0.0, -8.0), "toeflat.R": 1.0, "knee.R": (-0.35, -0.9, 0.2),
                "foot.L": (0.07, 0.02, 0.26, 42.0, 6.0)}),
        (0.40, {"foot.L": (0.07, -0.04, 0.34, 44.0, 6.0)}),
        (0.46, {"hip": (0.0, -0.42, 0.37), "pelvis": (0.0, 14.0, 0.0), "spine": (0.0, 4.0, 0.0), "chest": (0.0, 2.0, 0.0),
                "neck": (0.0, -6.0, 0.0), "head": (0.0, -4.0, 0.0), "arm.L": (16.0, 20.0, 40.0, 0.25), "arm.R": (16.0, 10.0, 40.0, 0.25),
                "foot.L": (0.07, -0.08, 0.38, 45.0, 6.0)}),
        (0.54, {"foot.L": (0.07, -0.16, h + 0.14, 30.0, 6.0)}),
        (0.62, {"hip": (0.0, -0.66, h - 0.06), "pelvis": (0.0, 8.0, 0.0), "foot.L": (0.05, -0.50, h + 0.10, 15.0, 6.0),
                "foot.R": (-0.10, -0.46, h, 34.0, -8.0),
                "arm.L": (16.0, 4.0, 30.0, 0.2), "arm.R": (16.0, 24.0, 34.0, 0.2)}),
        (0.71, {"hip": (0.0, -0.76, h - 0.04), "foot.L": (0.02, -TRAVEL - 0.04, h, 4.0, 6.0), "toeflat.L": 1.0}),
        (0.85, {**settle(h), "knee.R": STAND["knee.R"]}),
        (1.0, end(h)),
    ])
    return {"climb_low": (0.5, low), "climb_mid": (1.0, mid), "climb_high": (1.5, high)}


# --- Bake ---------------------------------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source-glb", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--report", required=True)
    ap.add_argument("--joints", help="optional review dump of the semantic joint heads per sample")
    args = ap.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:])
    output, report_path = Path(args.output), Path(args.report)
    if output.exists() or report_path.exists():
        raise ValueError("use fresh output/report paths")
    doc, _binary = native.read_glb(Path(args.source_glb))
    names, parents, local, rest, joints, owners = native.hierarchy(doc)
    heads = {semantic: (native.B @ rest[names[bone]]).translation for semantic, bone in native.SEMANTIC.items()}
    skel = gm.Skeleton(heads, {side: heads[side + "ToeBase"] + Vector((0., -.075, 0.)) for side, _ in gm.SIDES})
    poser = Poser(skel)
    finger_axes = {}
    for i in joints:
        name = doc["nodes"][i]["name"]
        if "Finger_" not in name or "Carpal" in name:
            continue
        children = doc["nodes"][i].get("children", [])
        direction = rest[children[0]].translation - rest[i].translation if children else rest[i].to_3x3() @ Vector((0, 1, 0))
        axis = direction.normalized().cross(Vector((0, -1, 0))).normalized()
        finger_axes[i] = rest[i].to_quaternion().inverted() @ axis

    jumps = jump_clips()
    # name -> (sampler, samples, natural seconds or None, loop, climb height or None)
    plan = {}
    for name, fn in jumps.items():
        phase = name.rsplit("_", 1)[1]
        samples = 13 if phase == "takeoff" else 25
        seconds = None
        if phase == "land":
            seconds = {"normal_stand": 0.5, "super_stand": 1.0, "normal_runL": 0.22, "normal_runR": 0.22,
                       "super_runL": 0.36, "super_runR": 0.36}[name.rsplit("_", 1)[0]]
        plan[name] = (fn, samples, seconds, False, None)
    plan["air_loop"] = (air_loop, 31, 1.2, True, None)
    for name, (height, fn) in climb_clips().items():
        plan[name] = (fn, 31, None, False, height)

    records, metrics, grips, dump = {}, {}, {}, {}
    max_translation_drift = max_scale_drift = max_bone_length_error = 0.
    for key, (fn, count, seconds, loop, climb_height) in plan.items():
        times = [i / (count - 1) for i in range(count)]
        rotations = {i: [] for i in joints}
        hips, last_q, reaches, arm_reaches, knee_angles, issues = [], {}, [], [], [], []
        wrist_errors, grip_curve, lowest, frames, overreach, wrists = [], [], [], [], [], []
        knee_step, last_knees = 0.0, None
        for t in times:
            p = fn(0.0 if loop and t == 1.0 else t)
            Q, H, diag = poser.solve(p)
            reaches.extend(diag["legReach"].values())
            overreach.extend(f"{side}@{t:.2f}={r:.3f}" for side, r in diag["legReach"].items() if r > .995)
            for semantic, parent in gm.PARENT.items():
                if parent is not None:
                    max_bone_length_error = max(max_bone_length_error,
                        abs((H[semantic] - H[parent]).length - (heads[semantic] - heads[parent]).length))
            for side, name, _sx in SIDES:
                upper = (H[name + "UpLeg"] - H[name + "Leg"]).normalized()
                lower = (H[name + "Foot"] - H[name + "Leg"]).normalized()
                knee_angles.append(180 - math.degrees(upper.angle(lower)))
                ball, ankle, _, _ = poser.foot(side, p)
                toe_tip = skel.point(Q, H, name + "ToeBase", skel.tip[name])
                knee = H[name + "Leg"]
                if climb_height is None:
                    # Heights above the ground: foot joints against their flat-foot rest height, the knee joint
                    # against an approximate kneecap radius.
                    ground = skel.R[name + "ToeBase"].z
                    lowest.extend((round(z, 4), f"{label}.{side}@{t:.2f}") for label, z in
                                  (("ball", ball.z - ground), ("toe", toe_tip.z - ground), ("knee", knee.z - 0.06)))
                if p[f"ik.{side}"] > 0.99:
                    arm_reaches.append(diag["armReach"][name])
                    wrist_errors.append((H[name + "Hand"] - Vector(p[f"wrist.{side}"])).length)
                if climb_height is not None:
                    # Nothing may enter the wall below the top: points past the face must be above the top.
                    for label, point in (("ball", ball), ("toe", toe_tip), ("ankle", ankle), ("knee", knee)):
                        if point.y < -WALL - 0.01 and point.z < climb_height + 0.02:
                            issues.append(f"{label}.{side}@{t:.2f}: y={point.y:.3f} z={point.z:.3f}")
            frames.append({j: [round(c, 4) for c in H[j]] for j in gm.JOINTS})
            knees = [H[name + "Leg"].copy() for _, name, _ in SIDES]
            if last_knees:
                knee_step = max(knee_step, *((a - b).length for a, b in zip(knees, last_knees)))
            last_knees = knees
            if climb_height is not None:
                grip_curve.append(round(max(0.0, min(1.0, p["ik.L"])), 4))
                # Wrist targets relative to the edge: lateral (+ = the climber's left), onto the top past the
                # face, and up from the top. The runtime pins the hands to the same offsets from the real edge.
                wrists.append([round(v, 4) for side in ("L", "R") for v in
                               (p[f"wrist.{side}"][0], -p[f"wrist.{side}"][1] - WALL, p[f"wrist.{side}"][2] - climb_height)])
                shift = climb_root(t, climb_height)
                H = {k: v - shift for k, v in H.items()}
            desired = native.pose_world(rest, owners, Q, H, heads)
            for i in joints:
                relative = desired[parents[i]].inverted() @ desired[i]
                trans, q, scale = relative.decompose()
                q.normalize()
                rest_t, _rest_q, rest_s = local[i].decompose()
                if doc["nodes"][i]["name"] == "DEF-Hips":
                    hips.extend(trans)
                else:
                    max_translation_drift = max(max_translation_drift, (trans - rest_t).length)
                max_scale_drift = max(max_scale_drift, (scale - rest_s).length)
                if i in finger_axes:
                    name = doc["nodes"][i]["name"]
                    segment = int(name.split(".")[0][-1])
                    flat = p["flat.L" if name.endswith(".L") else "flat.R"]
                    degrees = ((6., 15., 12.) if "Thumb" in name else (18., 26., 18.))[segment - 1] * (1 - 0.75 * flat)
                    q = (q @ Quaternion(finger_axes[i], math.radians(degrees))).normalized()
                if i in last_q and last_q[i].dot(q) < 0:
                    q.negate()
                last_q[i] = q.copy()
                rotations[i].extend(native.xyzw(q))
        tracks = []
        for i, values in rotations.items():
            constant = max(abs(values[j] - values[j % 4]) for j in range(len(values))) < 1e-6
            tracks.append(dict(node=doc["nodes"][i]["name"], path="quaternion", times=[0, 1] if constant else times,
                               values=[round(v, 5) for v in (values[:4] * 2 if constant else values)]))
        tracks.append(dict(node="DEF-Hips", path="position", times=times, values=[round(v, 5) for v in hips]))
        record = dict(duration=1, tracks=tracks)
        if seconds is not None:
            record["seconds"] = seconds
        if loop:
            record["loop"] = True
        records[key] = record
        dump[key] = frames
        if climb_height is not None:
            grips[key] = dict(height=climb_height, grip=grip_curve, wrists=wrists)
        metrics[key] = dict(samples=len(times), maxLegReach=max(reaches), maxGripArmReach=max(arm_reaches, default=0.0),
                            minKneeBendDegrees=min(knee_angles), maxKneeBendDegrees=max(knee_angles),
                            lowestAboveGround=min(lowest, default=None), wallIssues=issues, overreach=overreach,
                            maxGripWristErrorMeters=max(wrist_errors, default=0.0), maxKneeStepPerSample=knee_step,
                            maxKneeSpeedMetersPerSecond=None if climb_height is None else
                            knee_step * (count - 1) / (CLIMB["baseSeconds"] + CLIMB["perMetreSeconds"] * climb_height))
    if max_translation_drift > 1e-4 or max_scale_drift > 1e-4 or max_bone_length_error > 1e-5:
        raise ValueError(f"native hierarchy drift {max_translation_drift}, {max_scale_drift}, {max_bone_length_error}")
    too_far = {k: m["overreach"][:6] for k, m in metrics.items() if m["overreach"]}
    if too_far and not args.joints:
        raise ValueError(f"leg targets exceed safe reach: {too_far}")
    output.parent.mkdir(parents=True, exist_ok=True)
    climb = dict(radius=RADIUS, **CLIMB, variants=[dict(clip=k, **v) for k, v in sorted(grips.items(), key=lambda kv: kv[1]["height"])])
    output.write_text(json.dumps(dict(version=2, sourceSha256=native.SOURCE_SHA256, nativeJoints=71,
                                     rootMotion="none; local anatomical hips displacement, climbs relative to the simulation climb path",
                                     climb=climb, clips=records), separators=(",", ":")), encoding="utf-8")
    report = dict(status="FAIL_LEG_REACH" if too_far else "PASS_NUMERICAL_RUNTIME_REVIEW_PENDING", sourceSha256=native.SOURCE_SHA256,
                  scriptSha256=native.sha(Path(__file__).read_bytes()),
                  transportSha256=native.sha(Path(native.__file__).read_bytes()),
                  solverSha256=native.sha(Path(gm.__file__).read_bytes()),
                  outputSha256=native.sha(output.read_bytes()), outputBytes=output.stat().st_size,
                  maxNonHipsLocalTranslationDrift=max_translation_drift, maxLocalScaleDrift=max_scale_drift,
                  maxSemanticBoneLengthError=max_bone_length_error, clips=metrics,
                  limits="Simulation state drives every clip clock. Runtime hand IK pins the palms to the actual edge; this report does not certify skinned appearance.")
    report_path.parent.mkdir(parents=True, exist_ok=True)
    if args.joints:
        Path(args.joints).write_text(json.dumps(dict(frame="authoring (ledge frame for climbs)", clips=dump)), encoding="utf-8")
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({key: report[key] for key in ("status", "outputSha256", "outputBytes", "maxNonHipsLocalTranslationDrift", "maxSemanticBoneLengthError")}))
    for key, m in metrics.items():
        flag = " WALL" if m["wallIssues"] else ""
        print(f"{key:24s} leg {m['maxLegReach']:.3f} arm {m['maxGripArmReach']:.3f} low {m['lowestAboveGround']} grip {m['maxGripWristErrorMeters']:.4f} knee {m['maxKneeStepPerSample']:.3f}{flag} {m['wallIssues'][:3]} {m['overreach'][:4]}")


if __name__ == "__main__":
    main()
