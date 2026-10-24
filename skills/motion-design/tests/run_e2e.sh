#!/usr/bin/env bash
# End-to-end check of the generic pipeline on the synthetic Mixamo-style rig (tests/make_test_rig.py):
# inspect -> draft profile -> build_game_rig -> skin_check -> retarget -> export_glb -> render_clips -> manifest.
# Needs Kimodo loops from select_clips.py (selected.json with idle, walk, run and strafe_left).
#
# usage: BLENDER=/path/to/blender tests/run_e2e.sh /abs/out_dir /abs/work/gen/selected.json
set -euo pipefail
OUT=$1
SEL=$2
B=${BLENDER:-"/c/Program Files/Blender Foundation/Blender 5.2/blender.exe"}
SK=$(cd "$(dirname "$0")/.." && pwd)
GEN=$(dirname "$(dirname "$SEL")")  # selected.json stores sample paths relative to the work dir
mkdir -p "$OUT"
run() { "$B" -b --factory-startup --python-exit-code 1 --python "$@" > "$OUT/last.log" 2>&1 || { tail -20 "$OUT/last.log"; exit 1; }; }
src() { python -c "import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]]['sample'])" "$SEL" "$1"; }

run "$SK/tests/make_test_rig.py" -- --output "$OUT/test_rig.blend"
run "$SK/scripts/inspect_rig.py" -- --blend "$OUT/test_rig.blend" --report "$OUT/inspect.json" --draft "$OUT/profile.json"
run "$SK/scripts/build_game_rig.py" -- --blend "$OUT/test_rig.blend" --profile "$OUT/profile.json" --output "$OUT/game.blend" --report "$OUT/game_report.json"
run "$SK/scripts/skin_check.py" -- --blend "$OUT/game.blend" --profile "$OUT/profile.json" --report "$OUT/skin.json"
run "$SK/scripts/retarget.py" -- --blend "$OUT/game.blend" --profile "$OUT/profile.json" --src "$GEN/$(src idle)" --action idle \
  --output "$OUT/clips.blend" --in-place --foot-lock --report "$OUT/rt_none.json"
run "$SK/scripts/retarget.py" -- --blend "$OUT/clips.blend" --profile "$OUT/profile.json" --src "$GEN/$(src walk)" "$GEN/$(src run)" \
  --action walk run --output "$OUT/clips.blend" --in-place --foot-lock --align forward --report "$OUT/rt_forward.json"
run "$SK/scripts/retarget.py" -- --blend "$OUT/clips.blend" --profile "$OUT/profile.json" --src "$GEN/$(src strafe_left)" \
  --action strafe_left --output "$OUT/clips.blend" --in-place --foot-lock --align left --report "$OUT/rt_left.json"
run "$SK/scripts/export_glb.py" -- --blend "$OUT/clips.blend" --profile "$OUT/profile.json" --output "$OUT/test.glb"
run "$SK/scripts/render_clips.py" -- --blend "$OUT/clips.blend" --profile "$OUT/profile.json" --out-dir "$OUT/qa" --frames 6 --size 300
python "$SK/scripts/make_manifest.py" --reports "$OUT"/rt_none.json "$OUT"/rt_forward.json "$OUT"/rt_left.json --output "$OUT/test.clips.json" > /dev/null

python - "$OUT" <<'EOF'
import json, sys, os
o = sys.argv[1]
j = lambda f: json.load(open(os.path.join(o, f)))
ins, prof, rt, exp, man = j("inspect.json"), j("profile.json"), j("rt_forward.json"), j("test.export.json"), j("test.clips.json")
checks = {
    "draft has no problems": ins["draft_problems"] == [],
    "facing detected as +Y": prof["facing"] == "+Y",
    "every deform bone mapped": ins["unmapped_deform_bones"] == [],
    "FBX-style transform seen": ins["object_transform_identity"] is False,
    "run foot lock removes skating": max(rt["run"]["skate_m_after"].values()) < 0.005,
    "walk speed close to Kimodo request": 1.2 < rt["walk"]["root_speed_mps"] < 1.6,
    "four clips exported": sorted(exp["actions"]) == ["idle", "run", "strafe_left", "walk"],
    "materials glTF-ready": exp["materials_not_gltf_ready"] == {},
    "manifest directions": {c["name"]: c.get("dir") for c in man} == {"idle": None, "walk": "forward", "run": "forward", "strafe_left": "left"},
    "contact sheets written": all(os.path.exists(os.path.join(o, "qa", f"{a}_sheet.png")) for a in exp["actions"]),
}
for k, v in checks.items():
    print("PASS" if v else "FAIL", k)
print("open the sheets in", os.path.join(o, "qa"), "- numbers do not prove the motion looks right")
sys.exit(0 if all(checks.values()) else 1)
EOF
