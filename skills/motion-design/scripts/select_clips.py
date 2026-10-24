"""Convert generated samples, cut exactly one gait cycle, and keep the best sample per clip.

Score = loop seam match cost (+ penalty if the body heading drifts from the constrained heading).
python -I select_clips.py --gen /abs/work/gen --clips walk jog run ... --out /abs/work/gen/selected.json
Runs export_src.py and extract_loop.py (next to this script) on every <clip>_<n>.npz sample.
"""
import argparse
import glob
import json
import os
import subprocess
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ap = argparse.ArgumentParser()
ap.add_argument("--gen", required=True)
ap.add_argument("--clips", nargs="+", required=True)
ap.add_argument("--out", required=True)
args = ap.parse_args()


def run(script, *a):
    r = subprocess.run([sys.executable, "-I", os.path.join(HERE, script), *a], capture_output=True, text=True)
    if r.returncode:
        raise RuntimeError(r.stderr[-2000:])
    return r.stdout.strip().splitlines()[-1]


def heading_drift_deg(src):
    z = np.load(src)
    n = [str(x) for x in z["names"]]
    d = z["pos"][:, n.index("RightLeg")] - z["pos"][:, n.index("LeftLeg")]
    ang = np.degrees(np.arctan2(d[:, 2], -d[:, 0]))  # Kimodo heading, 0 = facing +Z
    return float(np.abs(ang).mean())


selected = {}
for clip in args.clips:
    cands = []
    for npz in sorted(glob.glob(os.path.join(args.gen, f"{clip}_[0-9].npz"))):
        stem = npz[:-4]
        run("export_src.py", "--npz", npz, "--output", stem + "_src.npz")
        drift = heading_drift_deg(stem + "_src.npz")
        windows = [("2.0", "4.0")] if clip == "idle" else [("0.8", "1.6"), ("0.4", "0.85")]
        for lo, hi in windows:
            info = json.loads(run("extract_loop.py", "--src", stem + "_src.npz", "--output", stem + "_loop.npz",
                                  "--min-s", lo, "--max-s", hi))
            if clip == "idle" or info["left_strikes"] == 1:
                break
        ok = clip == "idle" or info["left_strikes"] == 1
        score = info["match_cost"] + 0.002 * max(0.0, drift - 5.0) + (0 if ok else 1.0)
        cands.append({"sample": stem + "_loop.npz", "score": score, "drift_deg": drift, **info})
        print(clip, os.path.basename(stem), f"frames {info['frames']} strikes {info['left_strikes']} cost {info['match_cost']:.4f} drift {drift:.1f}° speed {info['speed_mps']:.2f}", flush=True)
    best = min(cands, key=lambda c: c["score"])
    selected[clip] = best
    print("->", clip, os.path.basename(best["sample"]), flush=True)
json.dump(selected, open(args.out, "w"), indent=1)
