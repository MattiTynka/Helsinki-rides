"""Cut a seamless locomotion loop from a retarget-ready src.npz (export_src.py output).

Searches start/end frame pairs inside the steady part of the clip whose pose (joint positions
relative to the hips, in the heading frame) and joint velocities match best, with a cycle
length inside [--min-s, --max-s]. The leftover mismatch is spread linearly over the loop, so
frame N (not stored) equals frame 0 exactly and the seam has no pop. The last stored frame is
N-1, so a runtime that loops [0, N) has no doubled pose.

python extract_loop.py --src walk_src.npz --output walk_loop_src.npz [--min-s 0.8 --max-s 1.6]
"""
import argparse
import json

import numpy as np
from scipy.spatial.transform import Rotation, Slerp

ap = argparse.ArgumentParser()
ap.add_argument("--src", required=True)
ap.add_argument("--output", required=True)
ap.add_argument("--min-s", type=float, default=0.8)
ap.add_argument("--max-s", type=float, default=1.6)
ap.add_argument("--skip-s", type=float, default=0.8, help="ignore start/stop transients at both ends")
args = ap.parse_args()

z = np.load(args.src)
names = [str(n) for n in z["names"]]
G, P, fps = z["grot"].astype(np.float64), z["pos"].astype(np.float64), float(z["fps"])
T, J = G.shape[:2]
BODY = [names.index(n) for n in ("Hips", "Spine2", "Chest", "Neck1", "Head", "LeftArm", "LeftForeArm",
                                  "LeftHand", "RightArm", "RightForeArm", "RightHand", "LeftLeg",
                                  "LeftShin", "LeftFoot", "LeftToeBase", "RightLeg", "RightShin",
                                  "RightFoot", "RightToeBase")]
hips = names.index("Hips")


def heading_frame(t):
    """Rotation (Y up) that turns the hips' facing direction into +Z."""
    f = G[t, hips] @ np.array([0, 0, 1.0])
    yaw = np.arctan2(f[0], f[2])
    c, s = np.cos(-yaw), np.sin(-yaw)
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])


feat = np.zeros((T, len(BODY), 3))
for t in range(T):
    H = heading_frame(t)
    rel = P[t, BODY] - P[t, hips] * np.array([1, 0, 1])
    feat[t] = rel @ H.T
vel = np.gradient(feat, axis=0) * fps

skip = int(args.skip_s * fps)
lo, hi = int(args.min_s * fps), int(args.max_s * fps)
best = None
for a in range(skip, T - skip - lo):
    for n in range(lo, min(hi, T - skip - a) + 1):
        b = a + n
        cost = np.abs(feat[a] - feat[b]).mean() + 0.1 * np.abs(vel[a] - vel[b]).mean()
        if best is None or cost < best[0]:
            best = (cost, a, b)
assert best is not None, "clip too short for the requested cycle length"
cost, a, b = best
N = b - a

# Spread the seam residual over the loop.
seg_G = G[a:b + 1].copy()
seg_P = P[a:b + 1].copy()
travel = seg_P[N, hips] - seg_P[0, hips]
travel[1] = 0.0  # vertical bob must close exactly
for j in range(J):
    delta = Rotation.from_matrix(G[a, j] @ G[b, j].T)  # rotation taking end -> start
    slerp = Slerp([0, 1], Rotation.concatenate([Rotation.identity(), delta]))
    w = np.arange(N + 1) / N
    seg_G[:, j] = np.einsum("tij,tjk->tik", slerp(w).as_matrix(), seg_G[:, j])
pos_res = (seg_P[0, hips] + travel) - seg_P[N, hips]
seg_P[:, hips] += np.outer(np.arange(N + 1) / N, pos_res)
# Recompute every joint position from the corrected rotations (forward kinematics).
parents, rest = z["parents"], z["rest_pos"].astype(np.float64)
for j in range(J):  # parents precede children in Kimodo's joint order
    p = parents[j]
    if p >= 0:
        seg_P[:, j] = seg_P[:, p] + np.einsum("tij,j->ti", seg_G[:, p], rest[j] - rest[p])
seam_rot = max(np.degrees(Rotation.from_matrix(seg_G[N, j] @ seg_G[0, j].T).magnitude()) for j in range(J))

speed = float(np.linalg.norm(travel[[0, 2]]) / (N / fps))
contacts = z["contacts"][a:b]

# Start the cycle at the left foot touchdown (heel or forefoot) so every gait loop shares phase
# (runtime blends by normalized time; loops must hold exactly one cycle, see "left_strikes").
left = contacts[:, 0] | contacts[:, 1]
strikes = [t for t in range(N) if left[t] and not left[t - 1]]  # t-1 wraps at 0
k = strikes[0] if strikes else 0
seg_G = np.concatenate([seg_G[k:N], seg_G[:k]])
seg_P = np.concatenate([seg_P[k:N], seg_P[:k] + travel])
contacts = np.concatenate([contacts[k:], contacts[:k]])
np.savez(args.output, names=z["names"], parents=z["parents"], rest_pos=z["rest_pos"],
         grot=seg_G.astype(np.float32), pos=seg_P.astype(np.float32), contacts=contacts,
         fps=np.float32(fps), loop=np.bool_(True), travel=travel.astype(np.float32),
         speed=np.float32(speed))
info = {"start": a, "end": b, "frames": N, "seconds": N / fps, "match_cost": float(cost),
        "seam_residual_deg_after": float(seam_rot), "speed_mps": speed, "phase_shift_frames": int(k),
        "left_heel_strike_found": bool(strikes), "left_strikes": len(strikes)}
print(json.dumps(info))
