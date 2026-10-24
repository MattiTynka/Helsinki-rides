"""Convert a Kimodo SOMA motion NPZ into a retarget-ready 77-joint NPZ.

Kimodo's neutral skeleton is already an upright T-pose with identity global rotations,
so rotations are kept in that convention (the "standard T-pose" frames only re-orient bone axes).

Output (Kimodo frame: Y up, character faces +Z, metres):
  names[J], parents[J], rest_pos[J,3]   neutral T-pose joint positions (identity rotations), feet on the floor
  grot[T,J,3,3]                         global rotations relative to that T-pose
  pos[T,J,3]                            posed joint positions
  contacts[T,4]                         left heel, left toe, right heel, right toe
  fps

python export_src.py --npz motion.npz --output src.npz [--fps 30]
"""
import argparse

import numpy as np
import torch

from kimodo.skeleton import SOMASkeleton30, SOMASkeleton77

ap = argparse.ArgumentParser()
ap.add_argument("--npz", required=True)
ap.add_argument("--output", required=True)
ap.add_argument("--fps", type=float, default=30.0)
args = ap.parse_args()

z = np.load(args.npz)
grot = torch.from_numpy(z["global_rot_mats"]).float()
pos = z["posed_joints"]
nj = grot.shape[1]
sk77 = SOMASkeleton77()
if nj == 30:
    sk30 = SOMASkeleton30()
    local = sk30.global_rots_to_local_rots(grot)
    local = sk30.to_SOMASkeleton77(local)
elif nj == 77:
    local = sk77.global_rots_to_local_rots(grot)
else:
    raise SystemExit(f"unsupported joint count {nj}")

root = torch.from_numpy(pos[:, 0]).float()
grot77, posed77, _ = sk77.fk(local, root)
rest = sk77.neutral_joints.numpy().copy()
rest -= np.array([0.0, rest[:, 1].min(), 0.0])  # feet on the floor


def kinematic_contacts(p, names, fps, height=0.04, speed=0.6):
    """[left heel, left toe, right heel, right toe] from the motion itself: a joint is planted
    when it is near its lowest height and nearly still. Model contact labels vary by checkpoint
    (4 or 6 columns) and drift on fast gaits, so they are not trusted."""
    cols = []
    for j in ("LeftFoot", "LeftToeBase", "RightFoot", "RightToeBase"):
        q = p[:, names.index(j)]
        v = np.zeros(len(q))
        v[1:-1] = np.linalg.norm(q[2:, [0, 2]] - q[:-2, [0, 2]], axis=1) * fps / 2
        v[0], v[-1] = v[1], v[-2]
        c = (q[:, 1] < np.percentile(q[:, 1], 5) + height) & (v < speed)
        # drop single-frame flickers
        c[1:-1] &= c[:-2] | c[2:]
        cols.append(c)
    return np.stack(cols, axis=1)


contacts = kinematic_contacts(posed77.numpy(), list(sk77.bone_order_names), args.fps)
np.savez(args.output, names=np.array(list(sk77.bone_order_names)), parents=sk77.joint_parents.numpy(),
         rest_pos=rest.astype(np.float32), grot=grot77.numpy().astype(np.float32),
         pos=posed77.numpy().astype(np.float32), contacts=contacts.astype(bool), fps=np.float32(args.fps))
print(f"frames {len(pos)} joints {sk77.nbjoints} rest height {rest[:, 1].max():.3f}")
