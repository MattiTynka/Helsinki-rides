"""Generate locomotion with Kimodo using only root-path constraints (no text encoder).

Kimodo is trained with text dropout; its unconditional branch is text_feat = 0 with an all-False
pad mask. Feeding that branch while constraining the root path and heading every frame gives
speed- and direction-controlled locomotion without the gated Llama-3 text encoder.

Kimodo frame: Y up, heading 0 faces +Z, character-left is +X. smooth_root_2d is (x, z).

python -I gen_notext.py --clips walk jog run idle walk_back strafe_left strafe_right --outdir /abs/work/gen
    [--specs extra_specs.json] [--samples 3] [--steps 100] [--seed 7]
--specs adds or overrides clips: {"walk_slow": [0.9, [0, 1], 8.0]} = speed m/s, direction (x=left, z=forward), seconds.
Speeds are for Kimodo's SOMA body (about 1.75 m); retarget.py scales travel by hip height.
"""
import argparse
import json
import math
import os

import numpy as np
import torch
import torch.nn as nn

from kimodo import load_model
from kimodo.constraints import Root2DConstraintSet
from kimodo.exports.motion_io import save_kimodo_npz
from kimodo.tools import seed_everything

# name: (speed m/s, travel direction in the character frame (x=left, z=forward), seconds)
SPECS = {
    "idle": (0.0, (0, 1), 6.0),
    "walk": (1.35, (0, 1), 8.0),
    "jog": (2.6, (0, 1), 7.0),
    "run": (3.9, (0, 1), 6.0),
    "sprint": (5.4, (0, 1), 5.0),
    "walk_back": (1.0, (0, -1), 8.0),
    "strafe_left": (1.1, (1, 0), 8.0),
    "strafe_right": (1.1, (-1, 0), 8.0),
    "jog_back": (2.0, (0, -1), 7.0),
    "jog_left": (2.1, (1, 0), 7.0),
    "jog_right": (2.1, (-1, 0), 7.0),
}


class ZeroText(nn.Module):
    """Stands in for LLM2Vec: every prompt becomes the unconditional (empty) embedding."""

    def __init__(self, dim=4096):
        super().__init__()
        self.dim = dim

    def forward(self, texts):
        return torch.zeros(len(texts), 1, self.dim), [0] * len(texts)


ap = argparse.ArgumentParser()
ap.add_argument("--clips", nargs="+")
ap.add_argument("--specs", help="JSON file adding or overriding clip specs")
ap.add_argument("--outdir", required=True)
ap.add_argument("--model", default="Kimodo-SOMA-RP-v1.2")
ap.add_argument("--samples", type=int, default=3)
ap.add_argument("--steps", type=int, default=100)
ap.add_argument("--seed", type=int, default=7)
ap.add_argument("--cfg", type=float, nargs=2, default=[2.0, 2.0])
args = ap.parse_args()
if args.specs:
    SPECS.update({k: (float(v[0]), tuple(v[1]), float(v[2])) for k, v in json.load(open(args.specs)).items()})
args.clips = args.clips or list(SPECS)
unknown = [c for c in args.clips if c not in SPECS]
assert not unknown, f"no spec for {unknown}"
os.makedirs(args.outdir, exist_ok=True)

model = load_model(args.model, device="cuda", default_family="Kimodo", text_encoder=ZeroText())
fps = float(model.fps)
summary = {}
for name in args.clips:
    speed, (dx, dz), secs = SPECS[name]
    T = int(round(secs * fps))
    t = np.arange(T) / fps
    # ease in over 0.6 s so the first steps are not a jump start
    ease = np.minimum(1.0, t / 0.6)
    dist = speed * np.cumsum(ease) / fps
    path = np.stack([dx * dist, dz * dist], axis=-1).astype(np.float32)
    heading = np.zeros(T, dtype=np.float32)  # always face +Z; strafes/back move sideways/backward
    cons = Root2DConstraintSet(
        model.skeleton,
        frame_indices=torch.arange(T),
        smooth_root_2d=torch.from_numpy(path).to("cuda"),
        global_root_heading=torch.from_numpy(np.stack([np.cos(heading), np.sin(heading)], -1)).to("cuda"),
    )
    seed_everything(args.seed)
    out = model(
        [""] * args.samples, [T] * args.samples,
        constraint_lst=[cons],  # shared by every sample
        num_denoising_steps=args.steps,
        num_samples=args.samples,
        cfg_type="separated", cfg_weight=list(args.cfg),
        post_processing=True,
        return_numpy=True,
    )
    for i in range(args.samples):
        single = {k: (v[i] if hasattr(v, "shape") and v.ndim > 0 and v.shape[0] == args.samples else v) for k, v in out.items()}
        p = os.path.join(args.outdir, f"{name}_{i}.npz")
        save_kimodo_npz(p, single)
        root = single["root_positions"]
        v = np.linalg.norm(np.diff(root[:, [0, 2]], axis=0), axis=-1) * fps
        summary[f"{name}_{i}"] = {"frames": T, "mean_speed": float(v[int(fps):].mean()), "want": speed}
        print(name, i, json.dumps(summary[f"{name}_{i}"]), flush=True)
json.dump(summary, open(os.path.join(args.outdir, "summary.json"), "w"), indent=1)
