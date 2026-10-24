"""Build the runtime clip manifest (<char>.clips.json) from retarget reports.
Each clip: name, loop, measured in-place travel speed (m/s) and travel direction, inferred from the name
(back / left / right, otherwise forward). Runtimes blend clips of one direction by speed.

python make_manifest.py --reports work/loco_report_*.json --output game/public/assets/char.clips.json
"""
import argparse
import json

ap = argparse.ArgumentParser()
ap.add_argument("--reports", nargs="+", required=True)
ap.add_argument("--output", required=True)
args = ap.parse_args()

clips = []
for path in args.reports:
    for name, r in json.load(open(path)).items():
        if name == "idle":
            clips.append({"name": name, "loop": True, "speed": 0})
            continue
        d = "back" if "back" in name else "left" if "left" in name else "right" if "right" in name else "forward"
        clips.append({"name": name, "loop": bool(r["loop"]), "speed": round(r["root_speed_mps"], 3), "dir": d})
clips.sort(key=lambda c: (c.get("dir", ""), c["speed"]))
json.dump(clips, open(args.output, "w"), indent=1)
print(json.dumps(clips))
