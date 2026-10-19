"""Author Finn's car entry, his own driver exit and a passenger-side climb-across exit.

Mathutils only, in the pinned Blender. The supplied GLB is read as rig data; no skin, mesh, scene or GLB is written.
The runtime samples parent-local native rotations and the hips translation with Finn's root at the car origin.

Limbs are true hinges. Thigh and shin share one knee axis lying across the hip-knee-ankle plane, the knee tracks
over the toes, and the elbow works the same way. Forearm roll is shared by both forearm bones instead of being left
to the wrist. Keys use monotone cubic interpolation, so a limb moves through an intermediate key without stopping.
Hip, knee, ankle and wrist ranges are checked on every frame and fail the build.

Car-local coordinates: metres, +X driver side, +Y up, +Z forward. Yaw angles are degrees, positive toward +X when
facing +Z (a left turn). Roll is positive leaning to the character's left; pitch is positive leaning forward.
"""
import argparse
import json
import math
from pathlib import Path
import sys

from mathutils import Matrix, Quaternion, Vector

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_finn_gameplay_clips as native
import cabin_warp
import game_motion as gm

D = math.radians
FPS = 30
OPEN_DEG = 65.0
DOORS = {'DOOR_FL': (Vector((0.82861, 0.67673, 0.58263)), -1.0), 'DOOR_FR': (Vector((-0.83539, 0.67673, 0.57681)), 1.0)}
# Feet point where the driver entry starts and the driver exit ends; the passenger side mirrors X.
STAGE = (1.45, 0.0, -0.95)
ENTRY_YAW = -12.0
ANKLE = 0.0806
EXIT_YAW = -35.0
SIDES = (('Left', 'L', 1.0), ('Right', 'R', -1.0))
# Head proxy in the authoring rest frame: hair top 1.793 m, head joint 1.533 m.
HEAD_CENTRE = Vector((0.0, -0.01, 1.66))
HEAD_RADIUS = 0.135
# Wheel 9-and-3 grip and the inner pull cup / window frame on the door, closed-door car-local.
WHEEL_L, WHEEL_R = (0.54, 0.94, 0.13), (0.19, 0.94, 0.13)
OUTER_HANDLE = (0.915, 0.93, -0.50)
INNER_PULL = (0.665, 0.80, 0.20)
WHEEL_TOP = (0.49, 1.06, 0.10)
WINDOW_REAR = (0.72, 1.17, -0.62)


def authored(v):
    return Vector((v[0], -v[2], v[1]))


def vehicle(v):
    return [v.x, v.z, -v.y]


def mirror_point(v):
    return (-v[0], v[1], v[2])


def door_rotate(door, amount, v, point=True):
    hinge, sign = DOORS[door]
    a = D(sign * OPEN_DEG * amount)
    r = Vector(v) - hinge if point else Vector(v)
    out = Vector((r.x * math.cos(a) + r.z * math.sin(a), r.y, -r.x * math.sin(a) + r.z * math.cos(a)))
    return out + hinge if point else out


# A car lying on its roof rests on the chassis collider's top face, car-local Y = ROOF. Flipped clips are authored in
# that ground frame (Y up from the ground, Z forward, so the driver's side is -X) and turned back into car space by a
# half turn about the car's forward axis. The map is its own inverse.
ROOF = 1.35
FLIP = Matrix(((-1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, -1.0)))  # the same half turn in authoring axes


def flip_point(v):
    return (-v[0], ROOF - v[1], v[2])


def flip_vector(v):
    return (-v[0], -v[1], v[2])


def hip_quat(yaw, pitch, roll):
    """Hip orientation (w, x, y, z) from the yaw/pitch/roll convention of the car-space keys."""
    return tuple((gm.rz(D(yaw)) @ gm.rx(D(pitch)) @ gm.ry(D(roll))).to_quaternion())


def hip_between(a, b, t):
    return tuple(Quaternion(a).slerp(Quaternion(b), t))


def flip_params(p):
    """Car-space key parameters as the same pose in the flipped ground frame. Feet must follow their shins (frel 1):
    a world-planted foot orientation has no flipped equivalent in these parameters."""
    assert p['frelL'] == 1.0 and p['frelR'] == 1.0
    out = dict(p)
    for k in ('hip', 'footL', 'footR', 'gripL', 'gripR', 'dptL', 'dptR'):
        if k in out:
            out[k] = flip_point(out[k])
    for k in ('poleL', 'poleR', 'pnL', 'pnR'):
        if k in out:
            out[k] = flip_vector(out[k])
    for k in ('palmL', 'palmR'):
        if k in out:
            out[k] = tuple(flip_vector(v) for v in out[k])
    out['hq'] = tuple((FLIP @ (gm.rz(D(p['yaw'])) @ gm.rx(D(p['pitch'])) @ gm.ry(D(p['roll'])))).to_quaternion())
    return out


# --- Interpolation --------------------------------------------------------------------------------------------

def pchip(ts, vs):
    """Monotone cubic through (t, v) with zero end slopes: no overshoot, no stop at a passing key."""
    n = len(ts)
    if n == 1:
        return lambda t: vs[0]
    h = [ts[i + 1] - ts[i] for i in range(n - 1)]
    d = [(vs[i + 1] - vs[i]) / h[i] for i in range(n - 1)]
    m = [0.0] * n
    for i in range(1, n - 1):
        if d[i - 1] * d[i] > 0:
            w1, w2 = 2 * h[i] + h[i - 1], h[i] + 2 * h[i - 1]
            m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i])

    def at(t):
        if t <= ts[0]:
            return vs[0]
        if t >= ts[-1]:
            return vs[-1]
        i = max(k for k in range(n - 1) if ts[k] <= t)
        s = (t - ts[i]) / h[i]
        h00, h10, h01, h11 = 2 * s ** 3 - 3 * s ** 2 + 1, s ** 3 - 2 * s ** 2 + s, -2 * s ** 3 + 3 * s ** 2, s ** 3 - s ** 2
        return h00 * vs[i] + h10 * h[i] * m[i] + h01 * vs[i + 1] + h11 * h[i] * m[i + 1]
    return at


# Hand and foot contacts stay where they are until the key just before their next key, so a planted foot or a
# gripping hand does not drift toward a target that is keyed much later.
HELD = ('foot', 'fyaw', 'fpitch', 'froll', 'toe', 'frel', 'ik', 'grip', 'orient', 'door', 'dpt', 'palm', 'auto', 'pn', 'curl')


def track(keys, base):
    """keys: [(seconds, {param: value})]; a parameter holds before its first and after its last key."""
    names = set(base).union(*(k for _, k in keys))
    times = sorted({t for t, _ in keys})
    flat = lambda v: [c for part in v for c in (part if isinstance(part, (tuple, list, Vector)) else (part,))]
    curves = {}
    for name in names:
        points = [(t, k[name]) for t, k in keys if name in k]
        if name == 'hq':
            # q and -q are the same hip rotation; keep neighbouring keys in one hemisphere before interpolating.
            for i in range(1, len(points)):
                if sum(a * b for a, b in zip(points[i - 1][1], points[i][1])) < 0:
                    points[i] = (points[i][0], tuple(-c for c in points[i][1]))
        if name[-1] in 'LR' and name[:-1] in HELD:
            for (ta, va), (tb, _) in list(zip(points, points[1:])):
                before = max(t for t in times if t < tb)
                if before > ta:
                    points.append((before, va))
            points.sort(key=lambda item: item[0])
        if not points:
            points = [(0.0, base[name])]
        value = points[0][1]
        if isinstance(value, (int, float)):
            curves[name] = pchip([t for t, _ in points], [float(v) for _, v in points])
            continue
        nested = isinstance(value[0], (tuple, list, Vector))
        series = [flat(v) if nested else list(v) for _, v in points]
        parts = [pchip([t for t, _ in points], [float(v[c]) for v in series]) for c in range(len(series[0]))]
        if nested:
            curves[name] = (lambda ps: lambda t: (tuple(p(t) for p in ps[:3]), tuple(p(t) for p in ps[3:])))(parts)
        else:
            curves[name] = (lambda ps: lambda t: tuple(p(t) for p in ps))(parts)
    return lambda t: {name: f(t) for name, f in curves.items()}


def door_curve(points):
    """Door opening (0..1) through (seconds, value, ease) segments; ease 'in' accelerates into a slam."""
    def at(t):
        if t <= points[0][0]:
            return points[0][1]
        for (t0, v0, _), (t1, v1, ease) in zip(points, points[1:]):
            if t <= t1:
                s = (t - t0) / (t1 - t0)
                s = {'in': s * s, 'out': 1 - (1 - s) ** 2, 'both': gm.smoother(s), 'linear': s}[ease]
                return v0 + (v1 - v0) * s
        return points[-1][1]
    return at


# --- Key poses ------------------------------------------------------------------------------------------------

def facing(yaw):
    a = D(yaw)
    return Vector((math.sin(a), 0.0, math.cos(a)))


def left_of(yaw):
    a = D(yaw)
    return Vector((math.cos(a), 0.0, -math.sin(a)))


def feet(centre, yaw, width=0.105, back=0.0):
    """Ankle points of a relaxed stance around a ground centre."""
    c, l, f = Vector(centre) + Vector((0.0, ANKLE, 0.0)), left_of(yaw), facing(yaw)
    return tuple(c + l * width - f * back), tuple(c - l * width - f * back)


# Palm presets: (finger direction, thumb-side direction), car-local.
PALM_WHEEL = ((0.0, -0.22, 1.0), (0.0, 1.0, 0.0))
PALM_HANDLE_OUT = ((-0.75, 0.1, 0.65), (0.0, 1.0, 0.0))
PALM_PULL_IN = ((0.9, -0.15, 0.4), (0.0, 1.0, 0.0))
# Left fingers round the rear edge of the window frame from the inner side, thumb up.
PALM_FRAME_L = ((-0.2, 0.0, -1.0), (0.0, 1.0, 0.0))
# Left fingers forward round the pull cup, palm toward the door and down.
PALM_CUP = ((0.4, -0.2, 0.9), (-0.72, -0.54, 0.2))
DOWN = (0.0, -1.0, 0.0)
KNEE_PN = (-0.45, -0.9, 0.0)
# Facing out of the car (+X): palms down on the knees.
PALM_KNEE_L = ((1.0, -0.7, 0.0), (0.0, 0.0, 1.0))
PALM_KNEE_R = ((1.0, -0.7, 0.0), (0.0, 0.0, -1.0))


def ground(x, z, lift=0.0):
    return (x, ANKLE + lift, z)


def plant(suffix, point, yaw):
    """Hold a foot flat on the ground: a key at the start of a step, so the foot does not drift before it."""
    return {'foot' + suffix: point, 'fyaw' + suffix: yaw, 'fpitch' + suffix: 0.0, 'froll' + suffix: 0.0,
            'toe' + suffix: 0.0, 'frel' + suffix: 0.0}


def base_standing(yaw, centre):
    fl, fr = feet(centre, yaw)
    return dict(hip=tuple(Vector(centre) + Vector((0, 0.872, 0))), yaw=yaw, pitch=4.0, roll=0.0,
                spine=(2.0, 0.0, 0.0), chest=(0.0, 0.0, 0.0), neck=(-4.0, 0.0, 0.0), head=(-2.0, 0.0, 0.0),
                footL=fl, footR=fr, fyawL=yaw + 6, fyawR=yaw - 6, fpitchL=0.0, fpitchR=0.0, frollL=0.0, frollR=0.0,
                toeL=0.0, toeR=0.0, splayL=4.0, splayR=4.0, frelL=0.0, frelR=0.0, fflexL=0.0, fflexR=0.0,
                kneeL=(0.0, 1.0, 1.0), kneeR=(0.0, 1.0, 1.0),
                ikL=0.0, ikR=0.0, orientL=0.0, orientR=0.0, doorL=0.0, doorR=0.0,
                gripL=(1.2, 0.9, -0.4), gripR=(1.2, 0.9, -0.4), dptL=INNER_PULL, dptR=INNER_PULL,
                poleL=(0.6, -0.5, -0.6), poleR=(-0.6, -0.5, -0.6),
                palmL=PALM_WHEEL, palmR=PALM_WHEEL, autoL=0.0, autoR=0.0, pnL=(0.0, -1.0, 0.0), pnR=(0.0, -1.0, 0.0),
                hangL=(9.0, 2.0, 14.0, 0.15), hangR=(9.0, 2.0, 14.0, 0.15),
                curlL=0.3, curlR=0.3, shrugL=(0.0, 0.0), shrugR=(0.0, 0.0))


# Heels on the floor, feet following the shins with a relaxed ankle; hands at nine and three.
SEATED = dict(base_standing(0.0, (0.0, 0.0, 0.0)), hip=(0.365, 0.478, -0.18), yaw=0.0, pitch=-26.0, roll=0.0,
              spine=(2.0, 0.0, 0.0), chest=(4.0, 0.0, 0.0), neck=(14.0, 0.0, 0.0), head=(4.0, 0.0, 0.0),
              footL=(0.50, 0.412, 0.50), footR=(0.25, 0.412, 0.50), fyawL=3.0, fyawR=-4.0, fpitchL=0.0, fpitchR=0.0,
              frelL=1.0, frelR=1.0, fflexL=-10.0, fflexR=-16.0, splayL=10.0, splayR=6.0,
              ikL=1.0, ikR=1.0, orientL=1.0, orientR=1.0, doorL=0.0, doorR=0.0,
              gripL=WHEEL_L, gripR=WHEEL_R, palmL=PALM_WHEEL, palmR=PALM_WHEEL,
              poleL=(0.7, -0.6, -0.3), poleR=(-0.5, -0.7, -0.3), curlL=1.0, curlR=1.0)
# A passenger has no wheel: hands rest on the thighs.
HANDS_ON_THIGHS = dict(ikL=1.0, ikR=1.0, gripL=(0.50, 0.625, 0.06), gripR=(0.22, 0.625, 0.06), orientL=1.0, orientR=1.0,
                       autoL=1.0, autoR=1.0, pnL=DOWN, pnR=DOWN, curlL=0.35, curlR=0.35,
                       poleL=(0.6, -0.4, -0.7), poleR=(-0.6, -0.4, -0.7))
# Sitting sideways on the cushion edge facing out, feet on the ground in the door gap.
EDGE_HIP = (0.56, 0.53, -0.21)
EDGE_FOOT_L, EDGE_FOOT_R = ground(1.10, -0.37), ground(1.12, -0.07)


def enter_keys():
    s = Vector(STAGE)
    base = base_standing(ENTRY_YAW, s)
    fl, fr = base['footL'], base['footR']
    keys = [(0.0, dict(base)),
            # Weight onto the right foot while the right hand comes up toward the handle.
            (0.16, dict(hip=tuple(s + Vector((-0.03, 0.866, 0.0))), yaw=-16.0, pitch=7.0, spine=(4.0, -2.0, -4.0),
                        ikR=0.35, gripR=(1.15, 1.02, -0.72), dptR=OUTER_HANDLE, palmR=PALM_HANDLE_OUT, autoR=1.0, pnR=(-0.4, -0.9, 0.0),
                        orientR=0.4, poleR=(-0.3, -0.7, -0.6),
                        curlR=0.4, hangL=(9.0, -4.0, 18.0, 0.15), **plant('L', fl, base['fyawL']))),
            # The left foot steps forward; a hinge at the hips with soft knees brings the hand down to the handle.
            (0.30, dict(footL=ground(1.54, -0.84, 0.05), fpitchL=-4.0, hip=(1.38, 0.858, -0.89), yaw=-20.0, pitch=13.0,
                        ikR=0.65, gripR=(1.04, 0.97, -0.60), orientR=0.7)),
            (0.44, dict(hip=(1.36, 0.842, -0.82), yaw=-26.0, pitch=21.0, spine=(10.0, -2.0, -8.0), chest=(6.0, 0.0, -6.0),
                        neck=(-2.0, 0.0, -6.0), ikR=1.0, orientR=1.0, gripR=OUTER_HANDLE, doorR=1.0, dptR=OUTER_HANDLE,
                        shrugR=(2.0, 10.0), curlR=0.85, hangL=(12.0, -10.0, 20.0, 0.15), **plant('L', ground(1.52, -0.74), -14.0))),
            # Pull: the hand rides the handle while the chest backs out of the door's sweep, then lets go.
            (0.58, dict(hip=(1.40, 0.848, -0.85), yaw=-16.0, pitch=14.0, spine=(6.0, -2.0, -6.0), chest=(4.0, 0.0, -4.0),
                        neck=(-2.0, 0.0, -4.0), doorR=1.0)),
            (0.70, dict(hip=(1.41, 0.846, -0.845), yaw=-11.0, pitch=12.0, spine=(4.0, -2.0, -4.0), chest=(2.0, 0.0, -2.0),
                        neck=(-2.0, 0.0, -2.0), doorR=1.0, **plant('R', fr, base['fyawR']))),
            # The door swings on; the right hand follows through and drops while the right foot steps in.
            (0.84, dict(hip=(1.41, 0.845, -0.80), yaw=0.0, pitch=8.0, spine=(3.0, -1.0, 0.0), chest=(1.0, 0.0, 0.0),
                        neck=(-2.0, 0.0, 2.0), doorR=0.0, ikR=0.5, gripR=(1.24, 0.90, -0.80), orientR=0.0, curlR=0.35,
                        shrugR=(0.0, 0.0), footR=ground(1.31, -0.82, 0.06), fyawR=4.0, fpitchR=-4.0)),
            (1.00, dict(hip=(1.36, 0.85, -0.70), yaw=15.0, pitch=6.0, spine=(2.0, 0.0, 2.0), chest=(0.0, 0.0, 2.0),
                        neck=(-2.0, 0.0, 6.0), ikR=0.0, hangR=(10.0, -6.0, 20.0, 0.15), hangL=(9.0, 8.0, 20.0, 0.15),
                        **plant('R', ground(1.27, -0.60), 22.0), **plant('L', ground(1.52, -0.74), -14.0))),
            # Turning his back to the seat: the left foot closes up beside the right, the car-side right foot leads
            # into the gap with its toe turned in, and the left foot swings round behind it, so the legs never cross.
            (1.08, dict(hip=(1.36, 0.85, -0.66), yaw=22.0, footL=ground(1.45, -0.64, 0.06), fyawL=10.0, fpitchL=-4.0)),
            (1.16, dict(hip=(1.33, 0.848, -0.56), yaw=32.0, **plant('L', ground(1.38, -0.54), 30.0))),
            (1.26, dict(hip=(1.27, 0.845, -0.44), yaw=46.0, spine=(4.0, 0.0, 0.0), chest=(2.0, 0.0, 0.0), neck=(0.0, 0.0, 4.0),
                        hangL=(9.0, -4.0, 20.0, 0.15), hangR=(4.0, 0.0, 30.0, 0.25), footR=ground(1.20, -0.34, 0.07),
                        fyawR=50.0, fpitchR=-4.0)),
            (1.36, dict(hip=(1.21, 0.838, -0.34), yaw=62.0, **plant('R', ground(1.13, -0.09), 74.0))),
            (1.44, dict(hip=(1.16, 0.845, -0.27), yaw=78.0, footL=ground(1.26, -0.46, 0.06), fyawL=70.0, fpitchL=-4.0)),
            (1.52, dict(hip=(1.13, 0.85, -0.23), yaw=90.0, pitch=8.0, spine=(4.0, 0.0, 0.0), chest=(2.0, 0.0, 0.0),
                        neck=(2.0, 0.0, 0.0), hangL=(10.0, 4.0, 22.0, 0.2), hangR=(4.0, 0.0, 30.0, 0.25),
                        ikL=0.0, ikR=0.0, gripL=(1.05, 0.70, -0.35), gripR=(1.05, 0.70, -0.12), palmL=PALM_KNEE_L,
                        palmR=PALM_KNEE_R, autoL=1.0, autoR=1.0, pnL=KNEE_PN, pnR=KNEE_PN, orientL=1.0, orientR=1.0, poleL=(-0.1, -0.4, -1.0), poleR=(-0.1, -0.4, 1.0),
                        curlL=0.5, curlR=0.5, **plant('R', EDGE_FOOT_R, 86.0), **plant('L', ground(1.16, -0.40), 92.0))),
            # Sit: hands find the thighs, hips go back and down onto the cushion edge, trunk folded forward so the
            # head stays outside the roof line.
            (1.64, dict(hip=(1.02, 0.80, -0.225), pitch=10.0, spine=(8.0, 0.0, 0.0), chest=(8.0, 0.0, 0.0), neck=(6.0, 0.0, 0.0),
                        head=(4.0, 0.0, 0.0), ikL=0.0, ikR=0.0)),
            (1.80, dict(hip=(0.84, 0.67, -0.22), pitch=12.0, spine=(14.0, 0.0, 0.0), chest=(16.0, 0.0, 0.0),
                        neck=(8.0, 0.0, 0.0), head=(6.0, 0.0, 0.0), ikL=1.0, ikR=1.0, gripL=(1.03, 0.67, -0.34),
                        gripR=(1.03, 0.67, -0.12))),
            (2.06, dict(hip=EDGE_HIP, pitch=4.0, roll=0.0, spine=(14.0, 0.0, 0.0), chest=(16.0, 0.0, 0.0),
                        neck=(12.0, 0.0, 0.0), head=(6.0, 0.0, 0.0), gripL=(0.86, 0.50, -0.33), gripR=(0.87, 0.50, -0.10),
                        splayL=4.0, splayR=4.0)),
            # Swing in, right leg just ahead of the left, pelvis rolling back onto the cushion. The head bows low over
            # the knees, comes in under the rail and rises only once it is under the liner.
            (2.16, dict(yaw=82.0, pitch=2.0, spine=(16.0, 0.0, 0.0), chest=(20.0, 0.0, 0.0), neck=(22.0, 0.0, 0.0),
                        head=(10.0, 0.0, 0.0), footR=(1.06, 0.20, -0.03), frelR=0.5, fflexR=-10.0, splayR=0.0,
                        kneeR=(-0.15, 0.6, 1.0), fyawR=60.0, ikR=0.6, gripR=(0.44, 0.58, -0.04), orientR=0.8,
                        poleR=(-0.3, -0.6, -0.6), curlR=0.4)),
            (2.26, dict(yaw=68.0, hip=(0.53, 0.52, -0.20), pitch=-6.0, spine=(16.0, 0.0, 0.0), chest=(20.0, 0.0, 0.0),
                        neck=(26.0, 0.0, 0.0), head=(12.0, 0.0, 0.0), footR=(0.94, 0.43, 0.06), frelR=1.0, fflexR=-30.0,
                        footL=(1.12, 0.16, -0.34), frelL=0.4, fflexL=-10.0, splayL=0.0, kneeL=(0.15, 0.6, 1.0), ikL=0.3)),
            (2.36, dict(yaw=52.0, hip=(0.49, 0.507, -0.195), pitch=-17.0, spine=(14.0, -2.0, 0.0), chest=(18.0, -2.0, 0.0),
                        neck=(32.0, 0.0, 0.0), head=(14.0, 0.0, 0.0), footR=(0.76, 0.50, 0.20), footL=(1.03, 0.42, -0.18),
                        frelL=1.0, fflexL=-18.0, ikL=0.0, hangL=(14.0, 10.0, 75.0, 0.3), ikR=0.7)),
            (2.48, dict(yaw=32.0, hip=(0.43, 0.491, -0.188), pitch=-15.0, spine=(10.0, -2.0, 0.0), chest=(14.0, 0.0, 0.0),
                        neck=(44.0, 0.0, 0.0), head=(18.0, 0.0, 0.0), footR=(0.50, 0.46, 0.48), fflexR=-14.0,
                        footL=(0.88, 0.50, 0.06))),
            (2.60, dict(yaw=16.0, hip=(0.39, 0.482, -0.182), pitch=-18.0, spine=(6.0, 0.0, 0.0), chest=(10.0, 0.0, 0.0),
                        neck=(38.0, 0.0, 0.0), head=(14.0, 0.0, 0.0), footR=SEATED['footR'], fflexR=SEATED['fflexR'],
                        splayR=SEATED['splayR'], kneeR=SEATED['kneeR'], footL=(0.62, 0.47, 0.30), fflexL=-14.0)),
            (2.72, dict(yaw=4.0, hip=(0.37, 0.479, -0.18), pitch=-20.0, spine=(4.0, 0.0, 0.0), chest=(8.0, 0.0, 0.0),
                        neck=(28.0, 0.0, 0.0), head=(8.0, 0.0, 0.0), footL=SEATED['footL'], fflexL=SEATED['fflexL'],
                        splayL=SEATED['splayL'], kneeL=SEATED['kneeL'], ikR=0.85, gripR=(0.30, 0.76, 0.0), pnR=(0.9, -0.2, 0.0))),
            (2.86, dict(yaw=0.0, hip=SEATED['hip'], pitch=-22.0, roll=0.0, spine=(2.0, 0.0, 0.0), chest=(4.0, 0.0, 0.0),
                        neck=(18.0, 0.0, 0.0), head=(4.0, 0.0, 0.0), shrugL=(0.0, 0.0), ikR=1.0, gripR=WHEEL_R, orientR=1.0,
                        palmR=PALM_WHEEL, autoR=1.0, pnR=(1.0, 0.0, 0.0), curlR=1.0, poleR=SEATED['poleR'])),
            # Lean out with the head ducked, take the pull cup, swing the door shut and let it latch.
            (3.02, dict(hip=(0.375, 0.48, -0.18), pitch=-14.0, roll=6.0, spine=(6.0, 4.0, -4.0), chest=(8.0, 4.0, -6.0),
                        neck=(40.0, -8.0, 0.0), head=(16.0, -4.0, 0.0),
                        ikL=1.0, gripL=(0.94, 0.82, 0.20), palmL=PALM_PULL_IN, autoL=1.0, pnL=(1.0, 0.0, 0.0), orientL=0.8,
                        poleL=(0.6, -0.6, -0.5),
                        curlL=0.6, shrugL=(2.0, 18.0))),
            (3.12, dict(doorL=1.0, dptL=INNER_PULL, gripL=INNER_PULL, orientL=1.0, curlL=0.9, pnL=(0.3, -0.9, 0.3), roll=9.0,
                        spine=(6.0, 6.0, -4.0), chest=(8.0, 6.0, -6.0), neck=(44.0, -8.0, 0.0), shrugL=(2.0, 22.0))),
            (3.36, dict(doorL=1.0, pitch=-16.0, roll=2.0, spine=(4.0, 2.0, -2.0), chest=(6.0, 2.0, -2.0), neck=(30.0, -4.0, 0.0),
                        head=(10.0, -2.0, 0.0), shrugL=(1.0, 10.0))),
            (3.46, dict(doorL=0.0, gripL=(0.66, 0.84, 0.14), orientL=0.6)),
            (3.60, dict(pitch=-22.0, roll=0.0, spine=(2.0, 0.0, 0.0), chest=(4.0, 0.0, 0.0), neck=(16.0, 0.0, 0.0),
                        head=(4.0, 0.0, 0.0), shrugL=(0.0, 0.0))),
            (3.80, dict(SEATED))]
    # Once let go, the door swings on a little, clear of the feet coming in past the hinge.
    doors = door_curve([(0.0, 0, 'linear'), (0.44, 0.0, 'linear'), (0.70, 0.24, 'in'), (1.26, 0.72, 'out'),
                        (1.70, 0.84, 'both'), (3.12, 0.84, 'linear'), (3.40, 0.14, 'both'), (3.52, 0.0, 'in')])
    return dict(name='enter', door='DOOR_FL', duration=3.8, keys=keys, base=base, doorCurve=doors)


def exit_keys(passenger_start=False):
    """Driver-side exit authored for +X; the passenger exit mirrors it after the climb."""
    s = Vector(STAGE)
    start = dict(SEATED, **(HANDS_ON_THIGHS if passenger_start else {}))
    end = base_standing(EXIT_YAW, s)
    # The right hand pushes on the cushion by the console as the pelvis turns.
    brace = dict(ikR=0.8, gripR=(0.26, 0.60, -0.04), autoR=1.0, pnR=DOWN, orientR=0.8, curlR=0.4, poleR=(-0.5, -0.6, -0.5))
    keys = [(0.0, start),
            # Left hand forward to the pull cup, fingers hooked round it; push the door open with a lean.
            (0.20, dict(ikL=1.0, gripL=(0.62, 0.82, 0.13), palmL=PALM_CUP, autoL=1.0, pnL=(1.0, 0.0, 0.0), orientL=1.0, curlL=0.6, poleL=(0.7, -0.6, -0.4),
                        pitch=-18.0, roll=2.0, spine=(6.0, 2.0, -4.0), chest=(8.0, 2.0, -6.0), neck=(32.0, -6.0, 0.0),
                        head=(14.0, -4.0, 0.0), shrugL=(0.0, 14.0))),
            (0.30, dict(gripL=INNER_PULL, doorL=1.0, dptL=INNER_PULL, curlL=0.9)),
            (0.54, dict(doorL=1.0, roll=4.0, spine=(6.0, 4.0, 0.0), chest=(8.0, 4.0, 0.0), yaw=4.0, hip=(0.385, 0.483, -0.185),
                        pitch=-14.0, neck=(36.0, -8.0, 0.0), head=(14.0, -6.0, 0.0), **brace)),
            # Release with a push; the door swings wide. The right hand braces for the turn.
            (0.62, dict(doorL=0.0, ikL=0.6, gripL=(0.92, 0.84, 0.10), orientL=0.0, curlL=0.4, shrugL=(0.0, 0.0))),
            # Left leg out first; the head bows low and leaves under the rail.
            (0.74, dict(yaw=18.0, hip=(0.40, 0.48, -0.185), pitch=-16.0, roll=0.0, spine=(8.0, 0.0, 0.0),
                        chest=(12.0, 0.0, 0.0), neck=(40.0, 0.0, 0.0), head=(14.0, 0.0, 0.0),
                        footL=(0.58, 0.44, 0.24), fflexL=-30.0, splayL=0.0, kneeL=(0.15, 0.6, 1.0), ikL=0.0,
                        hangL=(14.0, 10.0, 75.0, 0.3))),
            (0.86, dict(yaw=38.0, hip=(0.45, 0.478, -0.19), pitch=-14.0, spine=(10.0, 0.0, 0.0), chest=(16.0, 0.0, 0.0),
                        neck=(46.0, 0.0, 0.0), head=(18.0, 0.0, 0.0), footL=(0.92, 0.47, 0.06), fyawL=92.0, fpitchL=0.0,
                        footR=SEATED['footR'])),
            (0.98, dict(yaw=56.0, hip=(0.50, 0.515, -0.195), pitch=-10.0, spine=(14.0, 0.0, 0.0), chest=(18.0, 0.0, 0.0),
                        neck=(30.0, 0.0, 0.0), head=(12.0, 0.0, 0.0), footL=(1.06, 0.26, -0.16), frelL=0.6, fflexL=-10.0,
                        footR=(0.60, 0.46, 0.36), fflexR=-30.0, fyawR=50.0, splayR=0.0, kneeR=(-0.15, 0.8, 0.7))),
            (1.08, dict(yaw=70.0, hip=(0.53, 0.52, -0.20), pitch=-4.0, spine=(16.0, 0.0, 0.0), chest=(20.0, 0.0, 0.0),
                        neck=(24.0, 0.0, 0.0), head=(10.0, 0.0, 0.0), footR=(0.92, 0.47, 0.12), frelR=0.4, fflexR=-18.0, fyawR=86.0,
                        fpitchR=0.0, ikR=0.4, gripR=(0.80, 0.56, -0.04), orientR=0.4, palmR=PALM_KNEE_R, autoR=1.0, pnR=KNEE_PN,
                        curlR=0.5,
                        poleR=(-0.1, -0.4, 1.0), **plant('L', EDGE_FOOT_L, 92.0),
                        ikL=0.35, orientL=0.4, gripL=(0.86, 0.50, -0.31), palmL=PALM_KNEE_L, autoL=1.0, pnL=KNEE_PN, poleL=(-0.1, -0.4, -1.0), curlL=0.5)),
            (1.18, dict(yaw=82.0, pitch=0.0, spine=(16.0, 0.0, 0.0), chest=(18.0, 0.0, 0.0), neck=(18.0, 0.0, 0.0),
                        head=(8.0, 0.0, 0.0), footR=(1.08, 0.24, 0.0), frelR=0.4, fflexR=-10.0, ikL=0.7, orientL=0.75)),
            (1.26, dict(hip=EDGE_HIP, yaw=88.0, pitch=4.0, spine=(14.0, 0.0, 0.0), chest=(16.0, 0.0, 0.0), neck=(12.0, 0.0, 0.0),
                        head=(6.0, 0.0, 0.0), splayL=4.0, splayR=4.0, **plant('R', EDGE_FOOT_R, 86.0),
                        ikL=1.0, gripL=(0.86, 0.50, -0.31), palmL=PALM_KNEE_L, autoL=1.0, pnL=KNEE_PN, orientL=1.0,
                        poleL=(-0.1, -0.4, -1.0), curlL=0.5,
                        ikR=1.0, gripR=(0.87, 0.50, -0.09), palmR=PALM_KNEE_R, orientR=1.0, poleR=(-0.1, -0.4, 1.0), curlR=0.5)),
            # Stand: push off the knees, chest forward over the feet, the head leaves the cabin first.
            (1.42, dict(hip=(0.78, 0.66, -0.21), yaw=88.0, pitch=18.0, spine=(14.0, 0.0, 0.0), chest=(12.0, 0.0, 0.0),
                        neck=(8.0, 0.0, 0.0), head=(4.0, 0.0, 0.0), ikL=0.4, ikR=0.4, gripL=(1.02, 0.60, -0.32),
                        gripR=(1.03, 0.60, -0.09))),
            (1.52, dict(ikL=0.0, ikR=0.0)),
            (1.66, dict(hip=(1.10, 0.85, -0.22), yaw=84.0, pitch=6.0, spine=(4.0, 0.0, 0.0), chest=(2.0, 0.0, 0.0),
                        neck=(0.0, 0, 0), head=(0.0, 0, 0), ikL=0.0, ikR=0.0, hangL=(9.0, 2.0, 30.0, 0.15),
                        hangR=(4.0, 0.0, 30.0, 0.25))),
            # Step back toward the rear, take the rear window frame with the left hand and pull the door after him;
            # let it go at about 29 degrees and back out past the door's reach before it swings through.
            (1.78, dict(hip=(1.15, 0.845, -0.27), yaw=76.0, gripL=(1.36, 0.98, -0.34), footL=ground(1.28, -0.50, 0.07), fyawL=66.0, fpitchL=-4.0,
                        ikL=0.5, palmL=PALM_FRAME_L, autoL=1.0, pnL=(-0.9, -0.3, 0.3), poleL=(0.4, -0.7, -0.6))),
            (1.90, dict(hip=(1.24, 0.83, -0.36), yaw=66.0, spine=(4.0, 0.0, 4.0), neck=(0.0, 0.0, 4.0),
                        ikL=1.0, gripL=(1.63, 1.17, -0.32), palmL=PALM_FRAME_L, autoL=1.0, pnL=DOWN, orientL=0.6,
                        poleL=(0.4, -0.7, -0.6),
                        curlL=0.5, **plant('L', ground(1.43, -0.57), 66.0))),
            (2.02, dict(hip=(1.29, 0.848, -0.46), yaw=46.0, ikL=1.0, gripL=(1.63, 1.17, -0.32), doorL=1.0, dptL=WINDOW_REAR,
                        orientL=0.85, curlL=0.8, footR=ground(1.26, -0.40, 0.07), fyawR=40.0, fpitchR=-4.0)),
            (2.16, dict(hip=(1.40, 0.863, -0.62), yaw=30.0, pitch=4.0, spine=(4.0, 0.0, 2.0), doorL=1.0,
                        **plant('R', ground(1.38, -0.74), 14.0))),
            (2.28, dict(hip=(1.43, 0.866, -0.76), yaw=16.0, doorL=1.0, orientL=0.5, footL=ground(1.52, -0.80, 0.06), fyawL=0.0,
                        fpitchL=-4.0)),
            (2.36, dict(doorL=0.0, ikL=0.8, gripL=(1.40, 1.05, -0.62), orientL=0.15, curlL=0.4)),
            (2.44, dict(hip=(1.44, 0.867, -0.84), yaw=-8.0, spine=(4.0, 0.0, 0.0), ikL=0.4, orientL=0.0,
                        **plant('L', end['footL'], end['fyawL']))),
            (2.60, dict(hip=(1.45, 0.866, -0.90), yaw=-22.0, footR=ground(1.37, -0.92, 0.05), fyawR=end['fyawR'], fpitchR=-4.0)),
            (2.80, dict(end))]
    doors = door_curve([(0.0, 0, 'linear'), (0.30, 0.0, 'linear'), (0.56, 0.36, 'in'), (0.86, 0.72, 'out'),
                        (2.02, 0.72, 'linear'), (2.30, 0.45, 'both'), (2.50, 0.0, 'in')])
    return dict(name='exit', door='DOOR_FL', duration=2.8, keys=keys, base=start, doorCurve=doors)


# Climb across: left palm flat on the console, right palm on the passenger cushion, fingers along the forearms.
PALM_CONSOLE_L = ((1.0, -0.4, 0.0), (0.0, 0.0, 1.0))
PALM_ACROSS_R = ((-0.6, -0.4, 0.6), (0.7, 0.0, 0.7))


def climb_keys():
    """Driver seat to passenger seat: left hand on the wheel, right hand on the passenger cushion, perch on the
    console armrest, step the inboard leg and then the other over the low console ahead of the cushions (the tunnel is
    solid up to the dash further forward), and slide down onto the passenger cushion. The trunk stays bowed so the
    head keeps under the roof."""
    rest = dict(SEATED)
    mirrored_rest = mirror_params(dict(rest, **HANDS_ON_THIGHS))
    keys = [(0.0, rest),
            (0.26, dict(hip=(0.30, 0.50, -0.20), ikR=1.0, gripR=(-0.32, 0.52, -0.14), palmR=PALM_ACROSS_R, autoR=1.0,
                        pnR=(0.45, -0.9, 0.0), orientR=1.0, curlR=0.3, poleR=(0.2, 0.3, -1.0),
                        pitch=-16.0, roll=-8.0, spine=(14.0, -6.0, -4.0), chest=(16.0, -6.0, -4.0), neck=(20.0, -4.0, 0.0),
                        head=(6.0, 0.0, 0.0))),
            # Up onto the armrest, both feet drawn back in the driver footwell.
            (0.44, dict(hip=(0.12, 0.75, -0.29), yaw=-16.0, pitch=-10.0, roll=-14.0, spine=(28.0, -14.0, -4.0), chest=(30.0, -14.0, -4.0),
                        neck=(44.0, 2.0, 0.0), head=(16.0, 0.0, 0.0), footR=(0.20, 0.44, 0.35), fflexR=-16.0,
                        footL=(0.34, 0.44, 0.32), ikL=1.0, gripL=(0.24, 0.88, 0.06), palmL=PALM_CONSOLE_L, autoL=1.0,
                        pnL=(-0.3, -0.95, 0.0), orientL=1.0, curlL=0.3, poleL=(0.6, 0.2, -1.0))),
            (0.54, dict(footR=(0.10, 0.64, 0.20), fflexR=-48.0, kneeR=(0.1, 0.5, 0.9))),
            (0.62, dict(hip=(0.04, 0.755, -0.35), pitch=-14.0, roll=-12.0, footR=(-0.02, 0.76, 0.08), footL=(0.30, 0.46, 0.30),
                        gripR=(-0.32, 0.52, -0.14), gripL=(0.20, 0.86, 0.04))),
            (0.72, dict(footR=(-0.18, 0.58, 0.20), footL=(0.20, 0.62, 0.22), fflexL=-48.0, kneeL=(0.1, 0.5, 0.9), gripR=(-0.37, 0.53, -0.16))),
            (0.80, dict(hip=(-0.06, 0.745, -0.34), yaw=-10.0, pitch=-22.0, roll=-10.0, spine=(26.0, -12.0, -4.0), chest=(28.0, -12.0, -4.0),
                        neck=(44.0, 0.0, 0.0), footR=(-0.28, 0.43, 0.34), fflexR=-16.0, footL=(0.05, 0.76, 0.08),
                        gripR=(-0.41, 0.545, -0.17), gripL=(0.14, 0.84, 0.01))),
            # Let go of the wheel once the legs are across; the hand comes over the console toward the lap.
            (0.88, dict(hip=(-0.14, 0.66, -0.25), footL=(-0.14, 0.58, 0.20), gripL=(0.08, 0.80, -0.02), gripR=(-0.42, 0.62, -0.04))),
            (0.96, dict(hip=(-0.22, 0.57, -0.21), pitch=-14.0, footL=(-0.23, 0.44, 0.44), fflexL=-12.0, gripL=(0.0, 0.76, -0.04),
                        gripR=(-0.58, 0.56, -0.06))),
            # Drop onto the cushion with the head still bowed; it comes up only once it is back under the high liner.
            (1.06, dict(hip=(-0.29, 0.50, -0.185), neck=(40.0, 0.0, 0.0), head=(14.0, 0.0, 0.0))),
            (1.22, dict(hip=(-0.34, 0.486, -0.18), yaw=-2.0, pitch=-22.0, roll=-2.0, spine=(6.0, -2.0, 0.0), chest=(8.0, -2.0, 0.0),
                        neck=(26.0, 0.0, 0.0), head=(6.0, 0.0, 0.0), footR=(-0.48, 0.412, 0.50), footL=(-0.24, 0.412, 0.50),
                        gripL=(-0.20, 0.645, 0.04))),
            (1.50, mirrored_rest)]
    return dict(name='climb', door=None, duration=1.5, keys=keys, base=rest, doorCurve=door_curve([(0.0, 0.0, 'linear')]))


HEADER_L, HEADER_R = (0.56, 1.29, 0.17), (0.19, 1.30, 0.17)
# Heels of the hands against the underside of the windshield header, fingers up round its edge, thumbs inward.
PALM_HEADER_L = ((0.0, 1.0, 0.3), (-1.0, 0.0, 0.0))
PALM_HEADER_R = ((0.0, 1.0, 0.3), (1.0, 0.0, 0.0))
UP = (0.0, 1.0, 0.0)
# Bonnet surface height along the car's centre line.
BONNET = ((0.9, 1.05), (1.2, 1.03), (1.5, 1.0), (1.7, 0.96), (1.9, 0.90), (2.1, 0.82), (2.2, 0.76))


def bonnet(z):
    for (z0, y0), (z1, y1) in zip(BONNET, BONNET[1:]):
        if z <= z1:
            return y0 + (y1 - y0) * max(0.0, (z - z0) / (z1 - z0))
    return BONNET[-1][1]


def windshield_keys():
    """Both doors blocked: from a seat without a wheel (authored on the driver's side, mirrored onto the passenger
    seat), slouch and kick the windshield out with both feet, push off the header and slide out feet first on the
    back over the dashboard until the head is clear of the header, sit up on the bonnet leaning back on the hands,
    shuffle to the nose and drop off in front."""
    start = dict(SEATED, **HANDS_ON_THIGHS)
    end = base_standing(0.0, Vector((0.30, 0.0, 2.75)))
    header = lambda side, point: {'ik' + side: 1.0, 'grip' + side: point, 'palm' + side: PALM_HEADER_L if side == 'L' else PALM_HEADER_R,
                                  'auto' + side: 0.0, 'orient' + side: 1.0, 'curl' + side: 0.6}
    # Sitting on the bonnet leaning well back on nearly straight arms, hands behind the hips, fingers back.
    behind = lambda z, orient=0.6: dict(gripL=(0.62, bonnet(z - 0.45) + 0.01, z - 0.45), gripR=(0.12, bonnet(z - 0.45) + 0.01, z - 0.45),
                                        orientL=orient, orientR=orient)
    tucked = dict(kneeL=(0.1, 1.0, 0.1), kneeR=(-0.1, 1.0, 0.1), splayL=6.0, splayR=6.0)
    keys = [(0.0, start),
            # Brace: the left hand on the door armrest, the right pushes on the cushion; the pelvis slides to its edge.
            (0.26, dict(hip=(0.37, 0.50, -0.04), pitch=-34.0, spine=(-4.0, 0.0, 0.0), chest=(2.0, 0.0, 0.0), neck=(24.0, 0.0, 0.0),
                        head=(8.0, 0.0, 0.0), ikL=1.0, gripL=(0.66, 0.70, -0.02), palmL=PALM_KNEE_L, autoL=1.0, pnL=DOWN, orientL=0.8,
                        curlL=0.4, poleL=(-0.4, 0.2, -1.0), ikR=1.0, gripR=(0.18, 0.50, 0.02), autoR=1.0, pnR=DOWN, orientR=0.8,
                        curlR=0.3, poleR=(0.4, 0.2, -1.0), footL=(0.50, 0.42, 0.30), footR=(0.28, 0.42, 0.30))),
            # Knees up behind the dash, then both feet into the glass above it twice; the second kick breaks it.
            (0.38, dict(hip=(0.37, 0.51, 0.04), pitch=-64.0, footL=(0.50, 0.44, 0.32), footR=(0.28, 0.44, 0.32), poleL=(0.2, -1.0, -0.3))),
            (0.50, dict(hip=(0.37, 0.52, 0.08), pitch=-74.0, spine=(8.0, 0.0, 0.0), chest=(12.0, 0.0, 0.0), neck=(34.0, 0.0, 0.0),
                        footL=(0.50, 0.92, 0.35), footR=(0.28, 0.94, 0.35), fflexL=18.0, fflexR=18.0, **tucked)),
            (0.66, dict(hip=(0.37, 0.55, 0.13), footL=(0.50, 1.15, 0.49), footR=(0.28, 1.16, 0.49), fflexL=24.0, fflexR=24.0, pitch=-74.0)),
            (0.80, dict(hip=(0.37, 0.52, 0.09), footL=(0.50, 0.94, 0.36), footR=(0.28, 0.96, 0.36), pitch=-74.0)),
            (0.96, dict(hip=(0.37, 0.56, 0.15), footL=(0.50, 1.16, 0.53), footR=(0.28, 1.17, 0.53), fflexL=24.0, fflexR=24.0, pitch=-74.0)),
            # Feet down onto the dash top and the left hand to the cushion; the feet push the pelvis up in a bridge while
            # the hands come up past the chest to the header.
            (1.12, dict(footL=(0.50, 1.12, 0.56), footR=(0.28, 1.13, 0.56), fflexL=0.0, fflexR=0.0, ikL=1.0, gripL=(0.60, 0.51, 0.0),
                        gripR=(0.22, 0.51, -0.18),
                        palmL=PALM_KNEE_L, autoL=1.0, pnL=DOWN, orientL=0.8, curlL=0.3, poleL=(0.2, -1.0, -0.3), poleR=(-0.2, -1.0, -0.3),
                        kneeL=(0.1, 1.0, 0.6), kneeR=(-0.1, 1.0, 0.6))),
            (1.36, dict(hip=(0.37, 0.82, 0.16), pitch=-66.0, spine=(-6.0, 0.0, 0.0), chest=(-4.0, 0.0, 0.0), neck=(26.0, 0.0, 0.0),
                        head=(6.0, 0.0, 0.0), gripL=(0.62, 1.05, 0.18), gripR=(0.12, 1.05, 0.18), poleL=(0.6, -0.8, 0.0), poleR=(-0.6, -0.8, 0.0))),
            # Hands up against the header; the feet slide out over the cowl and the back lies flat under the roof.
            (1.56, dict(hip=(0.37, 0.98, 0.26), pitch=-80.0, **header('L', HEADER_L), **header('R', HEADER_R),
                        poleL=(0.6, -0.8, 0.0), poleR=(-0.6, -0.8, 0.0), footL=(0.48, 1.18, 0.80), footR=(0.30, 1.19, 0.80),
                        neck=(30.0, 0.0, 0.0), head=(8.0, 0.0, 0.0))),
            # Push off the header: the body slides out feet first, flat on its back over the dash, chin tucked.
            (1.80, dict(hip=(0.37, 1.08, 0.42), pitch=-94.0, spine=(-2.0, 0.0, 0.0), chest=(0.0, 0.0, 0.0), footL=(0.48, 1.12, 1.08),
                        footR=(0.30, 1.13, 1.08), fflexL=-20.0, fflexR=-20.0, neck=(8.0, 0.0, 0.0), head=(0.0, 0.0, 0.0))),
            (2.06, dict(hip=(0.37, 1.10, 0.70), pitch=-94.0, footL=(0.48, bonnet(1.38) + 0.08, 1.38), footR=(0.30, bonnet(1.38) + 0.09, 1.38),
                        ikL=0.6, ikR=0.6)),
            # Hands down to the cowl beside the hips while the head passes under the header.
            (2.30, dict(hip=(0.37, 1.11, 1.00), pitch=-90.0, neck=(16.0, 0.0, 0.0), footL=(0.48, bonnet(1.66) + 0.08, 1.66), footR=(0.30, bonnet(1.66) + 0.09, 1.66),
                        ikL=1.0, gripL=(0.64, bonnet(0.95) + 0.01, 0.95), palmL=PALM_KNEE_L, autoL=1.0, pnL=DOWN, curlL=0.3, orientL=0.6,
                        ikR=1.0, gripR=(0.10, bonnet(0.95) + 0.01, 0.95), palmR=PALM_KNEE_R, autoR=1.0, pnR=DOWN, curlR=0.3, orientR=0.6,
                        poleL=(0.5, 0.6, -0.6), poleR=(-0.5, 0.6, -0.6))),
            # Sit up on the bonnet, leaning back on the hands, knees up.
            (2.54, dict(hip=(0.37, bonnet(1.05) + 0.08, 1.05), pitch=-44.0, spine=(0.0, 0.0, 0.0), chest=(0.0, 0.0, 0.0), neck=(22.0, 0.0, 0.0),
                        head=(2.0, 0.0, 0.0), **behind(1.05), footL=(0.47, bonnet(1.62) + 0.08, 1.62), footR=(0.28, bonnet(1.62) + 0.09, 1.62),
                        fflexL=-10.0, fflexR=-10.0, kneeL=(0.1, 1.0, 1.0), kneeR=(-0.1, 1.0, 1.0), poleL=(0.6, -0.2, -0.8), poleR=(-0.6, -0.2, -0.8))),
            # Shuffle down the bonnet toward the nose.
            (2.80, dict(hip=(0.37, bonnet(1.20) + 0.08, 1.20), pitch=-42.0, **behind(1.20), footL=(0.47, bonnet(1.86) + 0.08, 1.86),
                        footR=(0.28, bonnet(1.86) + 0.09, 1.86))),
            (3.04, dict(hip=(0.36, bonnet(1.45) + 0.08, 1.45), **behind(1.45), footL=(0.46, 0.90, 2.05), footR=(0.27, 0.91, 2.05))),
            (3.24, dict(hip=(0.35, bonnet(1.78) + 0.08, 1.78), pitch=-34.0, **behind(1.78, 0.15), footL=(0.45, 0.66, 2.34), footR=(0.25, 0.67, 2.34),
                        fflexL=-20.0, fflexR=-20.0)),
            # Push off the bonnet and drop onto both feet in front of the bumper, knees soft.
            (3.46, dict(hip=(0.33, 0.76, 2.52), pitch=14.0, spine=(4.0, 0.0, 0.0), chest=(2.0, 0.0, 0.0), neck=(0.0, 0.0, 0.0),
                        head=(0.0, 0.0, 0.0), ikL=0.0, ikR=0.0, orientL=0.0, orientR=0.0, **plant('L', ground(0.42, 2.74), 6.0), **plant('R', ground(0.20, 2.76), -6.0),
                        hangL=(10.0, 4.0, 24.0, 0.2), hangR=(10.0, 4.0, 24.0, 0.2))),
            (3.70, dict(end))]
    # Ahead of the header the head is outside: the liner field there is the windshield, so the roof check stops.
    return dict(name='windshield', door=None, duration=3.7, keys=keys, base=start, roofZMax=0.12,
                doorCurve=door_curve([(0.0, 0.0, 'linear')]))


# --- Flipped car ---------------------------------------------------------------------------------------------
# Authored in the ground frame of a car lying on its roof: the liner is the floor (about Y 0), the seats hang from
# above, the driver's door is on the -X side and the wheel hangs at Y 0.25-0.57 in front of the driver.

# Finn lands on all fours under the console, his head clear of the closed door, and crawls out along a straight line
# angled back past the B-pillar so he comes out behind the open door. Positions on it are distances S from where the drop lands him (hips) and a lateral offset
# (positive to his left).
CRAWL_YAW = -102.0
CRAWL_ORIGIN = (0.155, -0.156)
CRAWL_STEP = 0.105


def line(s, lateral=0.0, y=0.0):
    d, l = facing(CRAWL_YAW), left_of(CRAWL_YAW)
    return (CRAWL_ORIGIN[0] + d.x * s + l.x * lateral, y, CRAWL_ORIGIN[1] + d.z * s + l.z * lateral)


def crawl_palm(thumb):
    """Palm on the ground, fingers along the crawl line and slightly cupped, thumb toward the body midline."""
    d = facing(CRAWL_YAW)
    return ((d.x * 0.97, -0.25, d.z * 0.97), tuple(left_of(CRAWL_YAW) * thumb))


PALM_CRAWL_L, PALM_CRAWL_R = crawl_palm(-1.0), crawl_palm(1.0)


def crawl(hip_s, hand_l, hand_r, knee_l, knee_r, hip_y=0.44, yaw=CRAWL_YAW, sway=0.0, lift_l=0.0, lift_r=0.0):
    """All fours along the crawl line, the trunk nearly level: hips, hands and knees given as S. A knee is set
    through its ankle, which lies a shin's length behind it with the foot just off the floor."""
    p = dict(hip=line(hip_s, 0.0, hip_y), hq=hip_quat(yaw, 86.0, sway), spine=(0.0, 0.0, 0.0), chest=(0.0, 0.0, 0.0),
             neck=(-28.0, 0.0, 0.0), head=(-14.0, 0.0, 0.0),
             gripL=line(hand_l, 0.15, 0.03), gripR=line(hand_r, -0.15, 0.03), ikL=1.0, ikR=1.0, orientL=1.0, orientR=1.0,
             autoL=0.0, autoR=0.0, palmL=PALM_CRAWL_L, palmR=PALM_CRAWL_R, curlL=0.35, curlR=0.35,
             poleL=tuple(-facing(CRAWL_YAW) + Vector((0.0, -0.2, 0.0)) + left_of(CRAWL_YAW) * 0.5),
             poleR=tuple(-facing(CRAWL_YAW) + Vector((0.0, -0.2, 0.0)) - left_of(CRAWL_YAW) * 0.5),
             footL=line(knee_l - 0.40, 0.09, 0.15 + lift_l), footR=line(knee_r - 0.40, -0.09, 0.15 + lift_r),
             frelL=1.0, frelR=1.0, fflexL=-42.0, fflexR=-42.0, splayL=0.0, splayR=0.0, kneeL=(0.0, 1.0, 1.0), kneeR=(0.0, 1.0, 1.0),
             toeL=0.0, toeR=0.0, doorL=0.0, doorR=0.0)
    return p


def crawl_steps(t0, dt, hip_s, n, hands, knees, left_first=True):
    """n steps, each a hand with the opposite knee; a moving hand lands 0.70 ahead of the hips and a knee 0.05."""
    keys, (hl, hr), (kl, kr) = [], hands, knees
    for k in range(1, n + 1):
        s = hip_s + CRAWL_STEP * k
        if (k % 2 == 1) == left_first:
            hl, kr, sway = s + 0.70, s + 0.05, -4.0
        else:
            hr, kl, sway = s + 0.70, s + 0.05, 4.0
        keys.append((round(t0 + dt * k, 4), crawl(s, hl, hr, kl, kr, sway=sway)))
    return keys


# Where the drop lands and the door-side tail starts: hips, hands and knees as S.
CRAWL_START = (0.0, 0.595, 0.595, 0.0, 0.0)


def flipped_seated():
    return flip_params(SEATED)


# Hanging upside down: palms flat on the liner under the shoulders, fingers forward and inward along the forearms.
# A fixed palm, because an auto palm is ill-conditioned with the forearm nearly upright on it.
LINER_L, LINER_R = (-0.58, 0.03, -0.26), (-0.14, 0.03, -0.26)
PALM_LINER_L = ((0.73, 0.0, 0.68), (-0.68, 0.0, 0.73))
PALM_LINER_R = ((-0.64, 0.0, 0.77), (0.77, 0.0, 0.64))


def off_the_wheel(start):
    """Hands let go of the wheel and reach for the liner relaxed; the palm target changes over while the hand
    follows the forearm, so it then turns over the short way."""
    part = lambda a, b, t: tuple(x + (y - x) * t for x, y in zip(a, b))
    hands = dict(ikL=1.0, ikR=1.0, autoL=0.0, autoR=0.0, palmL=PALM_LINER_L, palmR=PALM_LINER_R, orientL=0.9, orientR=0.9,
                 curlL=0.2, curlR=0.2)
    return [(0.18, dict(gripL=part(start['gripL'], LINER_L, 0.4), gripR=part(start['gripR'], LINER_R, 0.4), orientL=0.0, orientR=0.0,
                        palmL=start['palmL'], palmR=start['palmR'])),
            (0.24, dict(gripL=part(start['gripL'], LINER_L, 0.6), gripR=part(start['gripR'], LINER_R, 0.6),
                        palmL=PALM_LINER_L, palmR=PALM_LINER_R)),
            (0.44, dict(gripL=LINER_L, gripR=LINER_R, poleL=(-0.6, 0.6, -0.4), poleR=(0.6, 0.6, -0.4),
                        neck=(26.0, 0.0, 0.0), head=(10.0, 0.0, 0.0), **hands))]


def flipped_drop_keys():
    """Hanging upside down in the driver's seat: hands down onto the liner, let the belt go, and fall forward and
    round onto hands and knees facing the driver's door, the legs coming down out of the footwell. He lands inboard,
    under the console, so his head stays clear of the door until it is open."""
    start = flipped_seated()
    a0 = crawl(*CRAWL_START)
    q0, q1 = start['hq'], a0['hq']
    keys = [(0.0, start),
            # Both hands off the wheel and flat on the liner under the shoulders.
            *off_the_wheel(start),
            # The belt lets go: the pelvis drops out of the seat, the feet slide back out of the footwell.
            (0.52, dict(hip=(-0.33, 0.80, -0.15), hq=hip_between(q0, q1, 0.12), footL=(-0.48, 0.90, 0.28), footR=(-0.24, 0.90, 0.28),
                        kneeL=(0.0, 0.8, 1.0), kneeR=(0.0, 0.8, 1.0), poleL=(-0.5, 0.5, -0.87))),
            (0.78, dict(hip=(-0.15, 0.68, -0.14), hq=hip_between(q0, q1, 0.34), footL=(-0.38, 0.40, 0.38), footR=(-0.16, 0.52, 0.30),
                        kneeL=(0.3, 0.6, 1.0), kneeR=(-0.1, 0.8, 1.0), poleL=(0.5, 0.25, -0.87), orientL=0.5,
                        neck=(10.0, 0.0, 0.0), head=(0.0, 0.0, 0.0))),
            (1.02, dict(hip=(0.04, 0.55, -0.16), hq=hip_between(q0, q1, 0.82), footL=line(-0.42, 0.10, 0.34), footR=line(-0.40, -0.10, 0.32),
                        gripL=line(0.595, 0.15, 0.03), gripR=line(0.595, -0.15, 0.03), palmL=PALM_CRAWL_L, palmR=PALM_CRAWL_R,
                        autoL=0.0, autoR=0.0, orientL=0.8, orientR=0.8, poleL=a0['poleL'], poleR=a0['poleR'],
                        neck=(6.0, 0.0, 0.0), head=(0.0, 0.0, 0.0), fflexL=-30.0, fflexR=-30.0)),
            (1.30, dict(a0)),
            (1.50, dict(a0))]
    return dict(name='exitFlippedDrop', door=None, duration=1.5, keys=keys, base=start, flipped=True,
                doorCurve=door_curve([(0.0, 0.0, 'linear')]))


# The driver's door inner pull, and the rear end of the door's lower edge (the top edge with the car on its roof),
# in the flipped ground frame at closed-door positions.
FLIP_PULL = flip_point(INNER_PULL)
FLIP_DOOR_EDGE = (-0.90, 0.92, -0.70)
PALM_FLIP_PUSH = flip_vector(PALM_PULL_IN[0]), flip_vector(PALM_PULL_IN[1])
# The door is pushed to its first stop, wide enough to crawl out behind it.
FLIP_DOOR_OPEN = 0.68
FLIP_END = (-1.52, -0.88)
FLIP_END_YAW = -14.0
# The simulation's Lumi GT checks (packages/sim/src/vehicle-interaction.ts), warped with the clips for another car.
SIM_WINDSHIELD_STAGE = (-0.3, 0.0, 2.75)
SIM_DOOR_SWEEP = ((1.2, 0.85, -0.5), (1.55, 0.85, -0.15), (1.9, 0.85, 0.25), (0.9, 0.9, -0.3))
SIM_BONNET_PATH = ((-0.3, 1.4, 1.0), (-0.3, 1.35, 1.6), (-0.3, 1.2, 2.2))


def flipped_door_point(point, amount):
    return flip_point(door_rotate('DOOR_FL', amount, flip_point(point)))


def flipped_tail_keys():
    """On all fours facing the driver's door: reach up, pull the release and push the door open, crawl out behind
    it, kneel up and stand, step back clear of its swing, then take its edge and swing it shut."""
    a0 = crawl(*CRAWL_START)
    end = base_standing(FLIP_END_YAW, Vector((FLIP_END[0], 0.0, FLIP_END[1])))
    t8 = 0.90 + 0.12 * 10
    steps = crawl_steps(0.90, 0.12, 0.0, 10, (0.595, 0.595), (0.0, 0.0))
    # After the crawl: S measured from where it ends, two steps on from the original eight-step crawl.
    out = lambda s, lateral=0.0, y=0.0: line(s + 2 * CRAWL_STEP, lateral, y)
    last = steps[-1][1]
    lifted = lambda grip: (grip[0], grip[1] + 0.12, grip[2])
    hang = dict(ikL=0.0, ikR=0.0, hangL=(9.0, 2.0, 22.0, 0.15), hangR=(9.0, 2.0, 22.0, 0.15), orientL=0.0, orientR=0.0)
    keys = [(0.0, a0),
            # Weight onto the right hand; the left reaches up to the pull, pushes the door and lets it swing on.
            (0.24, dict(hip=line(0.01, 0.02, 0.43), hq=hip_quat(CRAWL_YAW + 6.0, 82.0, 8.0), ikL=1.0, gripL=FLIP_PULL, palmL=PALM_FLIP_PUSH,
                        autoL=0.5, pnL=(-1.0, 0.0, 0.0), orientL=0.8, curlL=0.8, poleL=(0.6, -0.6, 0.6))),
            (0.40, dict(doorL=1.0, dptL=FLIP_PULL)),
            (0.64, dict(doorL=1.0, hip=line(0.10, 0.02, 0.43))),
            (0.90, dict(a0)),
            *steps,
            # Push back off the hands and sit up onto both knees.
            (t8 + 0.10, dict(hip=out(0.87, 0.0, 0.44), hq=hip_quat(CRAWL_YAW, 76.0, 0.0), ikL=0.6, ikR=0.6, orientL=0.5, orientR=0.5,
                             gripL=lifted(last['gripL']), gripR=lifted(last['gripR']))),
            (t8 + 0.24, dict(hip=out(0.90, 0.0, 0.44), hq=hip_quat(CRAWL_YAW, 14.0, 0.0), spine=(2.0, 0.0, 0.0), chest=(2.0, 0.0, 0.0),
                             neck=(-4.0, 0.0, 0.0), head=(-2.0, 0.0, 0.0), footL=out(0.49, 0.09, 0.12), footR=out(0.48, -0.09, 0.12),
                             kneeL=(0.0, -0.8, 1.0), kneeR=(0.0, -0.8, 1.0), **dict(hang, ikL=0.25, ikR=0.25), gripL=out(1.20, 0.13, 0.50),
                             gripR=out(1.05, -0.14, 0.40))),
            # Left foot forward onto the floor, the knee coming up past the hip, then up off the right knee with a hand
            # on the left.
            (t8 + 0.37, dict(footL=out(0.74, 0.16, 0.20), kneeL=(0.2, -0.4, 1.0), hip=out(0.90, -0.01, 0.48), ikL=0.0, ikR=0.0)),
            (t8 + 0.50, dict(footL=out(1.05, 0.13, 0.17), fflexL=0.0, kneeL=(0.15, -0.2, 1.0), hip=out(0.91, -0.01, 0.43))),
            (t8 + 0.64, dict(hip=out(0.93, -0.03, 0.43), hq=hip_quat(CRAWL_YAW + 4.0, 18.0, 0.0), **plant('L', ground(*out(1.21, 0.13)[::2]), CRAWL_YAW + 4.0),
                             ikL=0.6, gripL=out(1.20, 0.13, 0.50), autoL=1.0, pnL=DOWN, orientL=0.6, curlL=0.4)),
            (t8 + 0.90, dict(hip=out(1.08, -0.04, 0.66), hq=hip_quat(CRAWL_YAW + 4.0, 30.0, 0.0), footR=out(0.72, -0.10, 0.22),
                             fflexR=-20.0, kneeR=(0.0, -0.4, 1.0), ikL=0.0)),
            (t8 + 1.10, dict(hip=out(1.20, -0.02, 0.86), hq=hip_quat(CRAWL_YAW, 6.0, 0.0), spine=(2.0, 0.0, 0.0), chest=(0.0, 0.0, 0.0),
                             **plant('R', ground(*out(1.24, -0.11)[::2]), CRAWL_YAW - 4.0), **hang)),
            # Weight onto the right foot; the left pivots on the ball toward the door.
            (t8 + 1.20, dict(**plant('L', ground(*out(1.21, 0.13)[::2]), -70.0))),
            # Step back out of the door's swing, turning toward it.
            (t8 + 1.34, dict(hip=(-1.41, 0.79, -0.61), hq=hip_quat(-60.0, 6.0, 0.0), **plant('R', ground(-1.52, -0.74), -36.0),
                             gripR=flipped_door_point(FLIP_DOOR_EDGE, FLIP_DOOR_OPEN))),
            # Lean in and take the door's edge with the right hand.
            (t8 + 1.58, dict(hip=(-1.53, 0.83, -0.80), hq=hip_quat(FLIP_END_YAW, 22.0, 0.0), **plant('L', end['footL'], end['fyawL']),
                             ikR=1.0, gripR=flipped_door_point(FLIP_DOOR_EDGE, FLIP_DOOR_OPEN), autoR=1.0, pnR=(0.3, 0.0, 1.0),
                             orientR=0.8, curlR=0.8, poleR=(-0.6, -0.6, -0.5))),
            (t8 + 1.70, dict(doorR=1.0, dptR=FLIP_DOOR_EDGE)),
            # Swing it to and let go; it slams on its own.
            (t8 + 2.04, dict(doorR=1.0, hip=(-1.50, 0.84, -0.84), hq=hip_quat(FLIP_END_YAW + 8.0, 14.0, 0.0))),
            (t8 + 2.16, dict(doorR=0.0, ikR=0.4, gripR=(-1.42, 1.05, -0.74), orientR=0.3)),
            (t8 + 2.44, dict(end, hq=hip_quat(FLIP_END_YAW, end['pitch'], 0.0), **plant('R', end['footR'], end['fyawR'])))]
    duration = round(t8 + 2.44, 4)
    doors = door_curve([(0.0, 0.0, 'linear'), (0.40, 0.0, 'linear'), (0.64, 0.42, 'in'), (1.10, FLIP_DOOR_OPEN, 'out'),
                        (t8 + 1.70, FLIP_DOOR_OPEN, 'linear'), (t8 + 2.12, 0.35, 'both'), (t8 + 2.34, 0.0, 'in')])
    return dict(name='exitFlippedTail', door='DOOR_FL', duration=duration, keys=keys, base=dict(flipped_seated(), **a0), flipped=True,
                doorCurve=doors)


def flipped_across_keys():
    """Driver's door blocked on a car lying on its roof: fall round the other way onto hands and knees facing the
    passenger side and crawl across under the console to where the mirrored tail starts."""
    start = flipped_seated()
    m = mirror_params
    # Unmirrored arguments: m(crawl(S, ...)) crawls the mirrored line toward the passenger's door.
    target = m(crawl(*CRAWL_START))
    q0, q1 = start['hq'], target['hq']
    s0 = -2 * CRAWL_STEP
    landing = m(crawl(s0, s0 + 0.595, s0 + 0.595, s0, s0))
    steps = [(t, m(k)) for t, k in crawl_steps(1.30, 0.15, s0, 2, (s0 + 0.595, s0 + 0.595), (s0, s0))]
    keys = [(0.0, start),
            *off_the_wheel(start),
            (0.52, dict(hip=(-0.36, 0.80, -0.14), hq=hip_between(q0, q1, 0.12), footL=(-0.50, 0.90, 0.28), footR=(-0.25, 0.90, 0.28),
                        kneeL=(0.0, 0.8, 1.0), kneeR=(0.0, 0.8, 1.0), poleR=(0.5, 0.5, -0.87))),
            (0.78, dict(hip=(-0.38, 0.68, -0.14), hq=hip_between(q0, q1, 0.42), footL=(-0.52, 0.58, 0.23), footR=(-0.36, 0.60, 0.25),
                        neck=(10.0, 0.0, 0.0), head=(0.0, 0.0, 0.0), gripR=(0.0, 0.12, -0.22), orientR=0.6, poleR=(-0.5, 0.25, -0.87),
                        gripL=(-0.50, 0.06, -0.22), orientL=0.5)),
            (0.90, dict(gripL=tuple((a + b) / 2 + (0.12 if i == 1 else 0.0) for i, (a, b) in enumerate(zip(LINER_L, landing['gripL']))),
                        orientL=0.3)),
            (1.02, dict(hip=(-0.38, 0.55, -0.14), hq=hip_between(q0, q1, 0.75), footL=landing['footL'], footR=landing['footR'],
                        gripL=landing['gripL'], gripR=landing['gripR'], palmL=landing['palmL'], palmR=landing['palmR'],
                        autoL=0.0, autoR=0.0, orientL=0.8, orientR=0.8, poleL=landing['poleL'], poleR=landing['poleR'],
                        neck=(-10.0, 0.0, 0.0), head=(-8.0, 0.0, 0.0), fflexL=-30.0, fflexR=-30.0)),
            (1.30, landing),
            *steps,
            # The last steps leave a hand and a knee a little ahead; bring them level for the tail.
            (1.76, dict(target))]
    return dict(name='exitFlippedAcross', door=None, duration=1.76, keys=keys, base=start, flipped=True,
                doorCurve=door_curve([(0.0, 0.0, 'linear')]))


MIRROR_SWAP = ('foot', 'fyaw', 'fpitch', 'froll', 'toe', 'splay', 'frel', 'fflex', 'knee', 'ik', 'orient', 'door', 'grip',
               'dpt', 'pole', 'palm', 'auto', 'pn', 'hang', 'curl', 'shrug')


def mirror_params(p):
    out = dict(p)
    for stem in MIRROR_SWAP:
        if stem + 'L' in p or stem + 'R' in p:
            out[stem + 'L'], out[stem + 'R'] = p.get(stem + 'R'), p.get(stem + 'L')
            for s in 'LR':
                if out[stem + s] is None:
                    del out[stem + s]
    for k in ('hip', 'footL', 'footR', 'gripL', 'gripR', 'dptL', 'dptR', 'poleL', 'poleR', 'kneeL', 'kneeR', 'pnL', 'pnR'):
        if k in out:
            out[k] = mirror_point(out[k])
    for k in ('palmL', 'palmR'):
        if k in out:
            out[k] = tuple(mirror_point(v) for v in out[k])
    for k in ('yaw', 'roll', 'fyawL', 'fyawR', 'frollL', 'frollR'):
        if k in out:
            out[k] = -out[k]
    for k in ('spine', 'chest', 'neck', 'head'):
        if k in out:
            a, b, c = out[k]
            out[k] = (a, -b, -c)
    if 'hq' in out:
        # Reflecting across the X plane keeps the X component and negates the other two (w, x, y, z).
        w, x, y, z = out['hq']
        out['hq'] = (w, x, -y, -z)
    return out


def mirrored(clip, name, door):
    return dict(clip, name=name, door=door, keys=[(t, mirror_params(k)) for t, k in clip['keys']], base=mirror_params(clip['base']))


# --- Solver ---------------------------------------------------------------------------------------------------

def frame(y, z):
    y = y.normalized()
    z = (z - y * z.dot(y)).normalized()
    return Matrix((y.cross(z), y, z)).transposed()


def seg(p):
    pitch, roll, twist = p
    return gm.rz(D(twist)) @ gm.rx(D(pitch)) @ gm.ry(D(roll))


def auto_palm(suffix, forearm, normal):
    """(finger, thumb-side) for a palm facing `normal` with the fingers continuing the forearm, car-local."""
    n = Vector(normal).normalized()
    f = Vector(forearm) - n * Vector(forearm).dot(n)
    f = f.normalized() if f.length > 1e-6 else n.orthogonal().normalized()
    # Left palm normal = finger x thumb, right palm normal = thumb x finger.
    return tuple(f), tuple(n.cross(f) if suffix == 'L' else f.cross(n))


class Rig:
    def __init__(self, skel, palms, native_rest, names):
        self.s = skel
        self.palms = palms
        self.rest_frames = {}
        for side, _, _ in SIDES:
            for upper, lower, fold in (('UpLeg', 'Leg', Vector((0, 1, 0))), ('Arm', 'ForeArm', Vector((0, -1, 0)))):
                y1, y2 = skel.rest_dir(side + upper), skel.rest_dir(side + lower)
                z1 = (fold - y1 * fold.dot(y1)).normalized()
                x1 = y1.cross(z1)
                self.rest_frames[side + upper] = frame(y1, z1)
                self.rest_frames[side + lower] = frame(y2, x1.cross(y2))
        # Forearm twist bones carry part of the hand roll.
        self.twist_heads = {s: (native.B @ native_rest[names['DEF-Forearm_2.' + suffix]]).translation for s, suffix, _ in SIDES}

    def limb(self, Q, H, side, upper, lower, root, target, pole):
        l1, l2 = self.s.length[side + upper], self.s.length[side + lower]
        mid, reach = gm.two_bone(root, target, l1, l2, pole)
        y1 = (mid - root).normalized()
        end = mid + (target - mid).normalized() * l2
        fold = (end - mid) - y1 * (end - mid).dot(y1)
        if fold.length < 1e-5:
            fold = -(pole - y1 * pole.dot(y1))
        z1 = fold.normalized()
        x1 = y1.cross(z1)
        y2 = (end - mid).normalized()
        Q[side + upper] = frame(y1, z1) @ self.rest_frames[side + upper].transposed()
        Q[side + lower] = frame(y2, x1.cross(y2)) @ self.rest_frames[side + lower].transposed()
        H[side + upper], H[side + lower] = root, mid
        return end, reach, math.acos(max(-1.0, min(1.0, y1.dot(y2))))

    def child(self, Q, H, name, parent):
        R = self.s.R
        H[name] = Q[parent] @ (R[name] - R[parent]) + H[parent]

    def hand_target(self, suffix, palm, grip):
        basis, offset = self.palms[suffix]
        finger = Vector(palm[0]).normalized()
        width = Vector(palm[1])
        width = (width - finger * width.dot(finger)).normalized()
        target = Matrix((finger, width, finger.cross(width))).transposed()
        delta = target @ basis.transposed()
        return delta, Vector(grip) - delta @ offset

    def solve(self, p, door, door_amount, flipped=False):
        """Pose in the clip's frame; a flipped clip is authored in the ground frame of a car lying on its roof."""
        R, Q, H, diag = self.s.R, {}, {}, {}
        hq = p.get('hq')
        qh = Quaternion(hq).normalized().to_matrix() if hq else gm.rz(D(p['yaw'])) @ gm.rx(D(p['pitch'])) @ gm.ry(D(p['roll']))
        Q['Hips'], H['Hips'] = qh, authored(p['hip'])
        chain = [('Spine', 'Hips', seg(p['spine'])), ('Spine1', 'Spine', seg(tuple(v / 2 for v in p['chest']))),
                 ('Spine2', 'Spine1', seg(tuple(v / 2 for v in p['chest']))), ('Neck', 'Spine2', seg(p['neck'])),
                 ('Head', 'Neck', seg(p['head']))]
        for name, parent, local in chain:
            self.child(Q, H, name, parent)
            Q[name] = Q[parent] @ local
        hands = {}
        for side, suffix, sx in SIDES:
            # Leg, a true hinge. A planted foot (frel 0) is placed in the world and the knee tracks over its toes;
            # a foot in the air (frel 1) follows its shin with a keyed ankle flex and a pelvis-relative knee direction.
            hip = Q['Hips'] @ (R[side + 'UpLeg'] - R['Hips']) + H['Hips']
            ankle = authored(p['foot' + suffix])
            frel = min(1.0, max(0.0, p['frel' + suffix]))
            fq = gm.rz(D(p['fyaw' + suffix])) @ gm.rx(D(p['fpitch' + suffix])) @ gm.ry(D(p['froll' + suffix]))
            fwd = gm.rz(D(p['fyaw' + suffix])) @ Vector((0, -1, 0))
            axis = (ankle - hip).normalized()
            planted = fwd + Vector((0, 0, 1))
            planted = (planted - axis * planted.dot(axis)).normalized()
            keyed = qh @ authored(p['knee' + suffix])
            keyed = keyed - axis * keyed.dot(axis)
            keyed = keyed.normalized() if keyed.length > 1e-6 else planted
            pole = planted.lerp(keyed, frel).normalized()
            out = qh @ Vector((sx, 0, 0))
            out = out - axis * out.dot(axis) - pole * out.dot(pole)
            if out.length > 1e-6:
                a = D(p['splay' + suffix])
                pole = pole * math.cos(a) + out.normalized() * math.sin(a)
            end, reach, knee = self.limb(Q, H, side, 'UpLeg', 'Leg', hip, ankle, pole)
            hinge = Q[side + 'UpLeg'] @ self.rest_frames[side + 'UpLeg'].col[0]
            # Rotation about the hinge axis is plantar flexion; fflex > 0 dorsiflexes.
            follow = gm.rot(hinge, -D(p['fflex' + suffix])) @ Q[side + 'Leg']
            if frel > 0:
                fq = fq.to_quaternion().slerp(follow.to_quaternion(), frel).to_matrix()
            H[side + 'Foot'], Q[side + 'Foot'] = end, fq
            self.child(Q, H, side + 'ToeBase', side + 'Foot')
            Q[side + 'ToeBase'] = fq @ gm.rx(-D(p['toe' + suffix]))
            diag['leg' + suffix] = dict(reach=reach, knee=math.degrees(knee), ankleError=(end - ankle).length)
            # Arm.
            elev, pro = p['shrug' + suffix]
            self.child(Q, H, side + 'Shoulder', 'Spine2')
            Q[side + 'Shoulder'] = Q['Spine2'] @ gm.rz(-sx * D(pro)) @ gm.ry(-sx * D(elev))
            root = Q[side + 'Shoulder'] @ (R[side + 'Arm'] - R[side + 'Shoulder']) + H[side + 'Shoulder']
            ab, sw, bend, inward = p['hang' + suffix]
            up, fore = (Q['Spine2'] @ v for v in gm.hang_dirs(side, D(ab), D(sw), D(bend), inward))
            elbow_h = root + up * self.s.length[side + 'Arm']
            wrist_h = elbow_h + fore * self.s.length[side + 'ForeArm']
            pole_h = elbow_h - (root + wrist_h) / 2
            ik, ride = p['ik' + suffix], p['door' + suffix]
            palm, normal = p['palm' + suffix], Vector(p['pn' + suffix])
            grip = Vector(p['grip' + suffix])
            if door and ride > 0:
                # The door swings in car space; a flipped clip carries its contact points there and back.
                fp, fv = (flip_point, flip_vector) if flipped else (tuple, tuple)
                on_door = Vector(fp(door_rotate(door, door_amount, fp(p['dpt' + suffix]))))
                grip = grip.lerp(on_door, ride)
                palm = tuple(tuple(Vector(v).lerp(Vector(fv(door_rotate(door, door_amount, fv(v), point=False))), ride)) for v in palm)
                normal = normal.lerp(Vector(fv(door_rotate(door, door_amount, fv(normal), point=False))), ride)
            # An auto palm faces `pn` with the fingers carrying on from the forearm, so the wrist stays nearly
            # straight; it is refined once from the solved forearm.
            auto = min(1.0, max(0.0, p['auto' + suffix]))
            fore = grip - Vector(vehicle(root))
            pole = (pole_h.normalized() if pole_h.length > 1e-6 else Vector((sx, 0.3, -1))).lerp(authored(p['pole' + suffix]).normalized(), ik)
            for _ in range(2 if auto > 0 else 1):
                hand_delta, wrist_target = self.hand_target(suffix, palm, grip)
                if auto > 0:
                    auto_delta, auto_target = self.hand_target(suffix, auto_palm(suffix, fore, normal), grip)
                    hand_delta = hand_delta.to_quaternion().slerp(auto_delta.to_quaternion(), auto).to_matrix()
                    wrist_target = wrist_target.lerp(auto_target, auto)
                wrist = wrist_h.lerp(authored(wrist_target), ik)
                end, reach, elbow = self.limb(Q, H, side, 'Arm', 'ForeArm', root, wrist, pole)
                fore = Vector(vehicle(end - H[side + 'ForeArm']))
            H[side + 'Hand'] = end
            carried = Q[side + 'ForeArm']
            want = native.B.to_3x3() @ hand_delta @ native.BI.to_3x3()
            hq = carried.to_quaternion().slerp(want.to_quaternion(), min(1.0, max(0.0, p['orient' + suffix] * min(1.0, ik / 0.5))))
            Q[side + 'Hand'] = hq.to_matrix()
            hands[side] = (carried, Q[side + 'Hand'], (end - H[side + 'ForeArm']).normalized())
            diag['arm' + suffix] = dict(reach=reach, elbow=math.degrees(elbow), wristError=(end - wrist).length)
        return Q, H, hands, diag


def twist_about(rel, axis):
    q = rel.to_quaternion()
    v = Vector((q.x, q.y, q.z))
    angle = 2 * math.atan2(v.dot(axis), q.w)
    return (angle + math.pi) % (2 * math.pi) - math.pi


def anatomy(rig, Q, H, hands, p):
    """Joint ranges that read as broken or creepy when exceeded; degrees."""
    out = {}
    qh = Q['Hips']
    for side, suffix, sx in SIDES:
        thigh = Q[side + 'UpLeg'] @ rig.s.rest_dir(side + 'UpLeg')
        local = qh.transposed() @ thigh
        flexion = math.degrees(math.atan2(-local.y, -local.z))
        abduction = math.degrees(math.asin(max(-1, min(1, sx * local.x))))
        # Femur rotation: kneecap against the pelvis-forward direction transported onto the thigh.
        kneecap = -(Q[side + 'UpLeg'] @ rig.rest_frames[side + 'UpLeg'].col[2])
        neutral = gm.arc(rig.s.rest_dir(side + 'UpLeg'), local)
        neutral_cap = qh @ (neutral @ Vector((0, -1, 0)))
        neutral_cap = (neutral_cap - thigh * neutral_cap.dot(thigh)).normalized()
        cap = (kneecap - thigh * kneecap.dot(thigh)).normalized()
        rotation = math.degrees(math.atan2(thigh.dot(neutral_cap.cross(cap)), neutral_cap.dot(cap))) * sx
        shin = Q[side + 'Leg'] @ rig.s.rest_dir(side + 'Leg')
        shin_front = -(Q[side + 'Leg'] @ rig.rest_frames[side + 'Leg'].col[2])
        foot = Q[side + 'Foot'] @ rig.s.rest_dir(side + 'Foot')
        foot_flat = (foot - shin * foot.dot(shin)).normalized()
        front = (shin_front - shin * shin_front.dot(shin)).normalized()
        foot_twist = math.degrees(math.atan2(shin.dot(front.cross(foot_flat)), front.dot(foot_flat)))
        rest_ankle = math.degrees(rig.s.rest_dir(side + 'Leg').angle(rig.s.rest_dir(side + 'Foot')))
        ankle = math.degrees(shin.angle(foot)) - rest_ankle
        carried, hand, fore = hands[side]
        rel = hand @ carried.transposed()
        twist = twist_about(rel, fore)
        # What the wrist itself bends once the forearm bones have taken 75% of the roll.
        residual = rel.to_quaternion() @ Quaternion(fore, twist * 0.75).inverted()
        wrist_bend = math.degrees(min(residual.angle, 2 * math.pi - residual.angle))
        out[suffix] = dict(hipFlexion=flexion, hipAbduction=abduction, femurRotation=rotation, footTwist=foot_twist,
                           ankleFlex=ankle, forearmTwist=math.degrees(twist), wristBend=wrist_bend)
    return out


# femurRotation > 0 is internal rotation; ankleFlex > 0 is dorsiflexion (toes toward the shin).
LIMITS = dict(hipFlexion=(-25, 140), hipAbduction=(-25, 55), femurRotation=(-45, 40), footTwist=(-28, 28),
              ankleFlex=(-50, 32), forearmTwist=(-170, 170), wristBend=(0, 80), knee=(0, 150), elbow=(0, 150))


def roof_field(path):
    if not path:
        return None
    data = json.loads(Path(path).read_text(encoding='utf-8'))
    grid = {(round(r['x'], 3), round(r['z'], 3)): r['liner'] for r in data['up']}
    xs, zs = sorted({k[0] for k in grid}), sorted({k[1] for k in grid})

    def liner(x, z):
        if not (xs[0] <= x <= xs[-1] and zs[0] <= z <= zs[-1]):
            return None
        i = max(k for k in range(len(xs) - 1) if xs[k] <= x) if x < xs[-1] else len(xs) - 2
        j = max(k for k in range(len(zs) - 1) if zs[k] <= z) if z < zs[-1] else len(zs) - 2
        corners = [grid[(xs[i + a], zs[j + b])] for a in (0, 1) for b in (0, 1)]
        if any(c is None for c in corners):
            return None
        u, v = (x - xs[i]) / (xs[i + 1] - xs[i]), (z - zs[j]) / (zs[j + 1] - zs[j])
        return (corners[0] * (1 - u) * (1 - v) + corners[1] * (1 - u) * v + corners[2] * u * (1 - v) + corners[3] * u * v)
    return liner


def bake_clip(clip, rig, ctx, roof):
    doc, rest, local, parents, joints, owners, heads, names, axes = ctx
    fn = track(clip['keys'], clip['base'])
    count = int(round(clip['duration'] * FPS))
    frames, door_values, diagnostics, lastq = [], [], [], {}
    drift = scale_drift = 0.0
    for f in range(count + 1):
        seconds = clip['duration'] * f / count
        p = fn(seconds)
        door_amount = clip['doorCurve'](seconds)
        flipped = clip.get('flipped', False)
        Q, H, hands, diag = rig.solve(p, clip['door'], door_amount, flipped)
        ground_gap = None
        if flipped:
            # Lowest joint above the ground (the roof plane), then everything into car space.
            ground_gap = min(h.z for h in H.values())
            Q = {k: FLIP @ q for k, q in Q.items()}
            H = {k: Vector((-h.x, h.y, ROOF - h.z)) for k, h in H.items()}
            hands = {k: (FLIP @ c, FLIP @ m, FLIP @ f) for k, (c, m, f) in hands.items()}
        # Forearm roll is spread over both forearm bones, the remainder stays at the wrist.
        extra = {}
        for side, suffix, _ in SIDES:
            carried, hand, fore = hands[side]
            twist = twist_about(hand @ carried.transposed(), fore)
            elbow, twist_head = rig.s.R[side + 'ForeArm'], rig.twist_heads[side]
            extra['DEF-Forearm_1.' + suffix] = (gm.rot(fore, twist * 0.3) @ carried, H[side + 'ForeArm'], elbow)
            extra['DEF-Forearm_2.' + suffix] = (gm.rot(fore, twist * 0.75) @ carried,
                                                carried @ (twist_head - elbow) + H[side + 'ForeArm'], twist_head)
        desired = native.pose_world(rest, owners, Q, H, heads)
        for name, (rotation, head, rest_head) in extra.items():
            i = names[name]
            delta = rotation.to_4x4()
            delta.translation = head - rotation @ rest_head
            desired[i] = native.BI @ delta @ native.B @ rest[i]
        rotations, hips = {}, None
        for i in joints:
            relative = desired[parents[i]].inverted() @ desired[i]
            translation, q, scale = relative.decompose()
            q.normalize()
            rt, _, rs = local[i].decompose()
            name = doc['nodes'][i]['name']
            if name == 'DEF-Hips':
                hips = list(translation)
            else:
                drift = max(drift, (translation - rt).length)
            scale_drift = max(scale_drift, (scale - rs).length)
            if i in axes:
                curl = p['curlL' if name.endswith('.L') else 'curlR']
                q = (q @ Quaternion(axes[i], native.grip_angle('drive', name) * curl)).normalized()
            if i in lastq and lastq[i].dot(q) < 0:
                q.negate()
            lastq[i] = q.copy()
            rotations[name] = [round(v, 5) for v in native.xyzw(q)]
        frames.append(dict(time=round(seconds / clip['duration'], 6), rotations=rotations, hips=[round(v, 5) for v in hips]))
        door_values.append(dict(time=round(seconds / clip['duration'], 6), value=round(door_amount, 5)))
        anat = anatomy(rig, Q, H, hands, p)
        head_centre = Q['Head'] @ (HEAD_CENTRE - rig.s.R['Head']) + H['Head']
        hc = vehicle(head_centre)
        liner = roof(hc[0], hc[2]) if roof and not flipped and hc[2] <= clip.get('roofZMax', math.inf) else None
        diagnostics.append(dict(seconds=round(seconds, 4), diag=diag, anatomy=anat, door=door_amount,
                                groundGap=None if ground_gap is None else round(ground_gap, 4),
                                headCentre=[round(c, 4) for c in hc], headTop=round(hc[1] + HEAD_RADIUS, 4),
                                roofGap=None if liner is None else round(liner - hc[1] - HEAD_RADIUS, 4),
                                joints={k: [round(c, 4) for c in vehicle(v)] for k, v in H.items()}))
    if drift > 1e-4 or scale_drift > 1e-4:
        raise ValueError(f'{clip["name"]}: native local transforms drift {drift} {scale_drift}')
    return frames, door_values, diagnostics


def check(name, diagnostics):
    problems, peaks = [], {}
    for d in diagnostics:
        for suffix in 'LR':
            leg, arm, anat = d['diag']['leg' + suffix], d['diag']['arm' + suffix], d['anatomy'][suffix]
            values = dict(anat, knee=leg['knee'], elbow=arm['elbow'], legReach=leg['reach'], armReach=arm['reach'],
                          ankleError=leg['ankleError'], wristError=arm['wristError'])
            for k, v in values.items():
                lo, hi = peaks.get(k, (math.inf, -math.inf))
                peaks[k] = (min(lo, v), max(hi, v))
                if k in LIMITS and not (LIMITS[k][0] <= v <= LIMITS[k][1]):
                    problems.append(f'{name} {d["seconds"]}s {suffix} {k}={v:.1f}')
            if leg['reach'] > 0.995 or arm['reach'] > 0.995:
                problems.append(f'{name} {d["seconds"]}s {suffix} reach leg={leg["reach"]:.3f} arm={arm["reach"]:.3f}')
        if d['roofGap'] is not None and d['roofGap'] < 0.0:
            problems.append(f'{name} {d["seconds"]}s head proxy above roof by {-d["roofGap"]:.3f}')
        if d['groundGap'] is not None and d['groundGap'] < 0.0:
            problems.append(f'{name} {d["seconds"]}s a joint is {-d["groundGap"]:.3f} below the ground')
    return problems, {k: [round(a, 3), round(b, 3)] for k, (a, b) in peaks.items()}


def main():
    global ROOF, OPEN_DEG, STAGE
    ap = argparse.ArgumentParser()
    ap.add_argument('--source-glb', required=True)
    ap.add_argument('--output', required=True)
    ap.add_argument('--report', required=True)
    ap.add_argument('--cabin', default=None, help='cabin-probe.json for the head/roof proxy check')
    ap.add_argument('--draft', action='store_true', help='write output even if joint checks fail (review only)')
    ap.add_argument('--target', default=None, help='cabin spec of another car: warp the Lumi GT clips into its cabin')
    args = ap.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else sys.argv[1:])
    output, report_path = Path(args.output), Path(args.report)
    if output.exists() or report_path.exists():
        raise ValueError('Use fresh output/report paths')
    roof = roof_field(args.cabin)
    doc, _binary = native.read_glb(Path(args.source_glb))
    names, parents, local, rest, joints, owners = native.hierarchy(doc)
    heads = {semantic: (native.B @ rest[names[bone]]).translation for semantic, bone in native.SEMANTIC.items()}
    skel = gm.Skeleton(heads, {side: heads[side + 'ToeBase'] + Vector((0, -.075, 0)) for side in ('Left', 'Right')})
    palms = {s: native.palm_frame(rest, names, '.' + s) for s in ('L', 'R')}
    axes = {}
    for i in joints:
        name = doc['nodes'][i]['name']
        if 'Finger_' not in name or 'Carpal' in name:
            continue
        children = doc['nodes'][i].get('children', [])
        direction = rest[children[0]].translation - rest[i].translation if children else rest[i].to_3x3() @ Vector((0, 1, 0))
        axis = direction.normalized().cross(Vector((0, -1, 0))).normalized()
        axes[i] = rest[i].to_quaternion().inverted() @ axis
    rig = Rig(skel, palms, rest, names)
    ctx = (doc, rest, local, parents, joints, owners, heads, names, axes)
    warp = cabin_warp.CabinWarp.load(args.target, ROOF) if args.target else None
    if warp:
        # A lower roof: the seated pose (Lumi GT space, warped with the rest) every clip starts or ends in.
        SEATED.update({k: tuple(v) if isinstance(v, list) else v for k, v in warp.spec.get('seated', {}).items()})
    enter, exit_driver = enter_keys(), exit_keys()
    climb = climb_keys()
    exit_passenger = mirrored(exit_keys(passenger_start=True), 'exitPassengerTail', 'DOOR_FR')
    # The windshield exit is authored for a driver's seat without a wheel and mirrored onto the passenger seat.
    windshield = mirrored(windshield_keys(), 'exitWindshieldTail', None)
    if warp:
        # The flipped clips start from the seated pose turned into the roof-plane frame, which the warp leaves
        # alone: give it the cabin posture the upright clips get.
        SEATED.update(warp.seated_posture(SEATED))
    flipped_tail = flipped_tail_keys()
    flipped_tail_passenger = dict(mirrored(flipped_tail, 'exitFlippedPassengerTail', 'DOOR_FR'), flipped=True)
    parts = (enter, exit_driver, climb, exit_passenger, windshield, flipped_drop_keys(), flipped_tail, flipped_across_keys(),
             flipped_tail_passenger)
    interaction, car_sha = None, '5a03cb798a093409ac6d2524a90f9400f9a5b35990ed80e5413d933b4b605b8b'
    if warp:
        # Keys are authored in the Lumi GT's cabin: move them into the target's, then solve with its doors and roof.
        parts = tuple(warp.clip(c) for c in parts)
        spec = warp.spec
        # Where the flipped exit ends (tweaks may move it): its last hips, back from the roof-plane frame.
        flipped_end = next(c for c in parts if c['name'] == 'exitFlippedTail')['keys'][-1][1]['hip']
        interaction = dict(stage=list(warp.point(STAGE)), windshieldStage=list(warp.point(SIM_WINDSHIELD_STAGE, True)),
                           flippedStage=[-flipped_end[0], flipped_end[2]],
                           doorSweep=[list(warp.point(p)) for p in SIM_DOOR_SWEEP],
                           bonnetPath=[list(warp.point(p, True)) for p in SIM_BONNET_PATH])
        interaction = {k: [round(c, 3) for c in v] if isinstance(v[0], float) else [[round(c, 3) for c in p] for p in v]
                       for k, v in interaction.items()}
        STAGE = tuple(interaction['stage'])
        ROOF, OPEN_DEG = spec['roof'], spec['openDeg']
        for door, hinge in spec['doors'].items():
            DOORS[door] = (Vector(hinge), DOORS[door][1])
        car_sha = spec['carSha256']
    baked, report, problems = {}, {}, []
    for clip in parts:
        frames, doors, diagnostics = bake_clip(clip, rig, ctx, roof)
        found, peaks = check(clip['name'], diagnostics)
        problems += found
        baked[clip['name']] = dict(duration=clip['duration'], door=clip['door'], frames=frames, doorCurve=doors)
        report[clip['name']] = dict(peaks=peaks, minRoofGap=min((d['roofGap'] for d in diagnostics if d['roofGap'] is not None), default=None),
                                    minGroundGap=min((d['groundGap'] for d in diagnostics if d['groundGap'] is not None), default=None),
                                    frames=diagnostics)

    def gap(fa, fb):
        # q and -q are the same rotation.
        return max(min(max(abs(x - y) for x, y in zip(qa, fb[n])), max(abs(x + y) for x, y in zip(qa, fb[n])))
                   for n, qa in fa.items())

    def joined(names, door):
        """Consecutive parts on one clock; each part starts on the previous part's last frame."""
        seq = [baked[n] for n in names]
        total = sum(c['duration'] for c in seq)
        frames, curve, offset = [], [], 0.0
        for i, c in enumerate(seq):
            shift = lambda items: [dict(item, time=round((item['time'] * c['duration'] + offset) / total, 6)) for item in items]
            frames += shift(c['frames'][1 if i else 0:])
            curve += shift(c['doorCurve'][1 if i else 0:])
            offset += c['duration']
        seams = [gap(a['frames'][-1]['rotations'], b['frames'][0]['rotations']) for a, b in zip(seq, seq[1:])]
        return dict(duration=round(total, 4), door=door, frames=frames, doorCurve=curve), max(seams)

    clips = {'enter': baked['enter'], 'exit': baked['exit']}
    # The passenger exit is the climb followed by the mirrored exit; the windshield exit climbs across too.
    clips['exitPassenger'], seam = joined(('climb', 'exitPassengerTail'), 'DOOR_FR')
    clips['exitWindshield'], windshield_seam = joined(('climb', 'exitWindshieldTail'), None)
    clips['exitFlipped'], flipped_seam = joined(('exitFlippedDrop', 'exitFlippedTail'), 'DOOR_FL')
    clips['exitFlippedPassenger'], flipped_passenger_seam = joined(('exitFlippedAcross', 'exitFlippedPassengerTail'), 'DOOR_FR')
    seated = clips['enter']['frames'][-1]['rotations']
    seated_seam = max(gap(seated, clips[n]['frames'][0]['rotations']) for n in ('exit', 'exitFlipped', 'exitFlippedPassenger'))
    seams = dict(climbExit=seam, climbWindshield=windshield_seam, flippedTail=flipped_seam,
                 flippedPassengerTail=flipped_passenger_seam, enterExit=seated_seam)
    if max(seams.values()) > 2e-3:
        problems.append(f'clip seams differ: {seams}')
    # A joint turning this far between samples pops on screen (the runtime test's limit).
    for name, clip in clips.items():
        for a, b in zip(clip['frames'], clip['frames'][1:]):
            for joint, qb in b['rotations'].items():
                turn = 2 * math.acos(min(1.0, abs(sum(x * y for x, y in zip(a['rotations'][joint], qb)))))
                if turn >= 0.65:
                    problems.append(f'{name} {b["time"] * clip["duration"]:.3f}s {joint} turns {turn:.2f} rad in one sample')
    data = dict(schemaVersion=2, fps=FPS, sourceSha256=native.SOURCE_SHA256, nativeJoints=71,
                sourcePackagedSha256='c54802ad951926a1574576e6797ff73a9744c86707614a1e81e3f307f212fe86',
                carSha256=car_sha,
                rootMotion='Bone poses in car-local coordinates; render model root follows full car transform.',
                stage=list(STAGE), entryYawDeg=ENTRY_YAW, exitYawDeg=EXIT_YAW, openDeg=OPEN_DEG,
                seated=clips['enter']['frames'][-1], clips=clips)
    if interaction:
        # The car definition's `interaction` block, for the simulation's stage and clearance checks.
        data['interaction'] = interaction
    status = 'DRAFT_JOINT_CHECKS_FAILED' if problems else 'DRAFT_NUMERIC_SKIN_REVIEW_PENDING'
    if problems and not args.draft:
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(json.dumps(dict(status=status, problems=problems, clips=report), indent=1), encoding='utf-8')
        raise ValueError(f'{len(problems)} joint/clearance problems, first: {problems[:6]}')
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(data, separators=(',', ':')), encoding='utf-8')
    summary = dict(status=status, problems=problems, durations={k: v['duration'] for k, v in clips.items()},
                   frames={k: len(v['frames']) for k, v in clips.items()}, seams=seams,
                   scriptSha256=native.sha(Path(__file__).read_bytes()), solverSha256=native.sha(Path(gm.__file__).read_bytes()),
                   outputSha256=native.sha(output.read_bytes()), outputBytes=output.stat().st_size,
                   peaks={k: v['peaks'] for k, v in report.items()}, minRoofGap={k: v['minRoofGap'] for k, v in report.items()},
                   minGroundGap={k: v['minGroundGap'] for k, v in report.items() if v['minGroundGap'] is not None})
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(dict(summary, clips=report), indent=1), encoding='utf-8')
    print(json.dumps(summary))


if __name__ == '__main__':
    main()
