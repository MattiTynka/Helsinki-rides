# Pipeline commands

Variables used below (bash; use absolute paths everywhere):

```bash
set -o pipefail
SK=/abs/.agents/skills/motion-design/scripts
B="/c/Program Files/Blender Foundation/Blender 5.2/blender.exe"; BL() { "$B" -b --factory-startup --python-exit-code 1 --python "$@"; }
PY="/abs/motion/.venv-kimodo/Scripts/python.exe -I"
W=/abs/motion/work; P=$W/char.profile.json; SRC=/abs/path/character.blend
```

## 1. Inspect and build the game rig

```bash
BL $SK/inspect_rig.py -- --blend $SRC --report $W/rig_report.json --draft $W/char.profile.draft.json
# edit/verify -> $P   (references/rig-profile.md)
BL $SK/build_game_rig.py -- --blend $SRC --profile $P --output $W/char_game.blend --report $W/char_game_report.json
BL $SK/skin_check.py -- --blend $W/char_game.blend --profile $P --report $W/skin.json
```

Read `char_game_report.json`: `stale_like_game_bones` must be empty or explained, `unweighted` 0 for visible meshes,
`cloth_weight_transfer` plausible (clothing next to visible skin only), `bbone_bones_flattened` tells you where
skin_check matters most. Then `skin_check` (references/skinning.md).

## 2. Generate motion (Kimodo, text-free)

```bash
cd $W && $PY $SK/gen_notext.py --clips idle walk jog run sprint walk_back jog_back strafe_left strafe_right jog_left jog_right \
    --outdir $W/gen --samples 3        # ~1-2 min per clip on an 8 GB RTX 3070 Ti
$PY $SK/select_clips.py --gen $W/gen --clips idle walk jog run sprint walk_back jog_back strafe_left strafe_right jog_left jog_right \
    --out $W/gen/selected.json
```

Default specs (speed m/s for the SOMA body, direction in the character frame x = left, z = forward, seconds):

| clip | speed | dir | s | | clip | speed | dir | s |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| idle | 0 | — | 6 | | walk_back | 1.0 | back | 8 |
| walk | 1.35 | fwd | 8 | | jog_back | 2.0 | back | 7 |
| jog | 2.6 | fwd | 7 | | strafe_left / right | 1.1 | left / right | 8 |
| run | 3.9 | fwd | 6 | | jog_left / right | 2.1 | left / right | 7 |
| sprint | 5.4 | fwd | 5 | | | | | |

Add clips with `--specs extra.json` (`{"walk_slow": [0.9, [0, 1], 8.0]}`). Heading stays fixed (+Z), so strafes and
back-pedals move sideways/backwards while facing forward, exactly what an aiming or camera-relative game needs.
Generated speeds land within about 1 % of the request; retargeted speeds scale with the hip-height ratio
(Snow: 0.914 → walk 1.23 m/s).

`select_clips.py` converts every sample (`export_src.py`: SOMA-77 globals + **kinematic** contacts, because the model's
own contact columns drift on fast gaits), cuts a loop (`extract_loop.py`: best pose+velocity match in the steady part,
residual spread over the cycle, rotated to start at the left-foot strike), and keeps the sample with the lowest seam cost
that holds exactly one cycle (`left_strikes == 1`; a second window 0.4-0.85 s is tried for fast gaits) and whose body
heading drifts least. Look at its printout: a clip with `strikes 2` or a large `drift` needs more samples or a new seed.

## 3. Retarget, one run per direction group

`--align` turns the clip so its travel matches the group; groups share one output file (each run adds actions).

```bash
S() { python -c "import json,sys; print('$W/' + json.load(open('$W/gen/selected.json'))[sys.argv[1]]['sample'])" $1; }
rt() { in=$1 al=$2; shift 2; srcs=(); for c in "$@"; do srcs+=("$(S $c)"); done
  BL $SK/retarget.py -- --blend $in --profile $P --src "${srcs[@]}" --action "$@" --output $W/char_clips.blend \
     --in-place --foot-lock $([ $al != none ] && echo --align $al) --report $W/rt_$al.json; }
rt $W/char_game.blend none idle && rt $W/char_clips.blend forward walk jog run sprint && \
rt $W/char_clips.blend back walk_back jog_back && rt $W/char_clips.blend left strafe_left jog_left && \
rt $W/char_clips.blend right strafe_right jog_right
```

Each report line gives frames, hip scale, removed head pitch, speed and skating before/after foot lock. Expect
run/sprint/strafe skating ≈ 0 after lock; walks keep a few centimetres summed over ~60 contact frames (heel-to-toe roll).
A head pitch above ~10° (Snow's sprint: 14.6°) is the source looking down; levelling it is on by default.

Re-running the chain after a rig change (e.g. new weights) reproduces identical motion: retargeting only reads bones.

## 4. Look, export, manifest

```bash
BL $SK/render_clips.py -- --blend $W/char_clips.blend --profile $P --out-dir $W/qa --frames 8
BL $SK/export_glb.py -- --blend $W/char_clips.blend --profile $P --output /abs/motion/out/char.glb
python $SK/make_manifest.py --reports $W/rt_none.json $W/rt_forward.json $W/rt_back.json $W/rt_left.json $W/rt_right.json \
    --output /abs/game/public/assets/char.clips.json && cp /abs/motion/out/char.glb /abs/game/public/assets/char.glb
```

Copy the GLB into the game only after the export succeeded (the `&&` chain with `pipefail`).

## Materials

glTF reads Principled BSDF with image textures. Authoring files often use node groups, UDIM tiles or procedural skin.
`export_glb.py` lists them under `materials_not_gltf_ready` (or fails with `--strict-materials`). Rebuild them before
export in a small project script; a worked example from the Snow character (not bundled) packs three skin UDIM
tiles into a 2×2 atlas, remaps the skin UVs per face, and replaces each studio shader with a plain Principled material
using the same base colour, normal, roughness and metal images.

## Loop and clip rules

- Loops are in place; the runtime controller owns translation. Speed in the manifest is the removed travel speed.
- Last key equals the first (closing frame), so runtimes loop `[0, duration)` with no doubled pose.
- All locomotion loops start at the left-foot strike: blends use one normalised phase.
- One-shots (draw, reload, vault) are not covered by `extract_loop.py`; cut them by frame range and export with
  `loop: false` in the manifest.
