---
name: motion-design
description: Put realistic walk, jog, run, sprint, strafe, back-pedal and idle motion on any rigged character (Blender .blend from CloudRig, Rigify, Mixamo, Unreal-style or custom rigs) and ship it as a game-ready GLB with a clip manifest and a three.js runtime. Generates motion locally with NVIDIA Kimodo (text-free, root-path constrained, runs on an 8 GB GPU), cuts seamless one-cycle loops, retargets them through a per-rig JSON profile with foot locking, converts authoring rigs into a plain game skeleton without breaking the skin, stress-tests the skinning, exports, renders contact sheets and records deterministic demo videos. Use it whenever the user wants to animate, retarget or add locomotion to a character, make a character walk/run/strafe in a game, fix limbs that detach, slide, pop at loop seams or swing too little, or record a motion demo, even if they never say "motion design".
---

# Motion-design

Turn a rigged character into a game character that walks, runs and strafes convincingly. Blender is the offline tool;
the browser (three.js) owns blending, procedural layers and rendering. Every stage writes a file you can open and every
stage has a check. This skill was distilled from making a CloudRig character (Snow) walk, run and shoot in a
three.js game; its profile is `assets/profiles/snow-cloudrig.json`.

```
 rig.blend ─inspect_rig─▶ rig.profile.json (draft → verified by you)
     │                          │
     └──build_game_rig──▶ game.blend ─skin_check─▶ stretch/kink report (+ look at it)
 Kimodo (gen_notext) ─▶ samples ─select_clips─▶ one-cycle loops ─retarget (per direction)─▶ clips.blend
 clips.blend ─render_clips─▶ contact sheets      clips.blend ─export_glb─▶ char.glb + make_manifest ─▶ char.clips.json
 char.glb + clips.json ─assets/runtime/locomotion.ts─▶ game ─▶ browser review + demo video
```

## Read by task

| Task | Read |
| --- | --- |
| First-time setup: Python env, Kimodo, Blender, licences, GPU | [setup](references/setup.md) |
| New character: inspect, write/verify the rig profile | [rig profile](references/rig-profile.md) |
| Generate, loop, retarget, export clips (commands) | [pipeline](references/pipeline.md) |
| Authoring rig → game skeleton, limbs detaching, clothing weights | [skinning](references/skinning.md) |
| three.js blending, arm swing, aim/IK layers, test API, demo video | [runtime](references/runtime.md) |
| What to check before calling it done; symptom → cause → fix | [QA](references/qa.md) |

## Rules learnt the hard way

- **Never write the source .blend.** Every script opens it read-only or saves elsewhere. Work in `motion/work/` (or the project's equivalent).
- **Absolute paths for every `--blend`/`--output`.** A relative `--blend` once baked relative texture paths into the game rig and the export failed.
- **Chains fail loudly.** Use `set -o pipefail` (or `&&` without a trailing filter) for multi-step shell chains. A `| grep` once hid a failed export and an old GLB got copied into the game.
- **Text-free generation is the default.** Kimodo's text encoder needs the gated Llama-3-8B; the root-path + heading constraints with a zero text embedding give speed/direction-accurate locomotion without it. Never swap in an ungated Llama mirror without asking the user.
- **Never print tokens** (`HUGGINGFACE_TOKEN` in `.env`); test them by length or an API call.
- **Every loop holds exactly one gait cycle starting at the left-foot strike** (`left_strikes == 1`); the runtime blends clips on one shared phase and breaks otherwise.
- **Clothing takes weights only from visible skin.** Skin hidden under clothes by a mask is unmaintained (Snow's still used `DEF-Thigh1` names) and glued the jeans to the pelvis.
- **Fix motion in the right layer:** bad skin → weights (build step); wrong pose content → generation/selection; style tweaks that depend on speed or state (arm swing, lean, aim) → runtime procedural layer.
- **Numbers do not prove looks.** Open the contact sheets and browser frames, at full resolution and up close at joints, and give a blunt verdict.

## Execution loop

1. **Inspect.** Run `inspect_rig.py`; read the report (B-Bones, masks, drivers, stale weight groups, facing, orphan deform bones). Ask the user only about choices that change the result (which clips, speeds, target engine).
2. **Profile.** Start from the draft (simple rigs) or from `assets/profiles/snow-cloudrig.json` (CloudRig/Rigify-style rigs with mechanism parents). Verify every mapping; see [rig profile](references/rig-profile.md).
3. **Game rig + skin.** `build_game_rig.py`, then `skin_check.py`. Fix any stale group, hard seam or tear before generating motion; compare to a known-good build when possible.
4. **Motion.** `gen_notext.py` (3 samples per clip) → `select_clips.py` → `retarget.py` once per direction group (`none` idle, `forward`, `back`, `left`, `right`) with `--in-place --foot-lock`.
5. **Look.** `render_clips.py` contact sheets: gait, contacts, arms, head, hands. Reject and re-select before exporting.
6. **Ship.** `export_glb.py` (rebuild non-Principled materials first), `make_manifest.py`, integrate with `assets/runtime/locomotion.ts`.
7. **Verify in the runtime** through the real input path, deterministic scenarios and a recorded demo; see [QA](references/qa.md). Report PASS, RETHINK or INCOMPLETE and name any missing evidence.

## Helpers (`scripts/`, run with Blender 5.2 `-b --factory-startup --python-exit-code 1 --python <script> -- …` unless marked Python)

| Script | Does | Limits |
| --- | --- | --- |
| `inspect_rig.py` | Rig facts + draft profile (name/hierarchy mapping to SOMA-77, facing, twist bones) | Draft only; orphaned deform bones (CloudRig/Rigify) need hand-written `bones` |
| `build_game_rig.py` | Plain deform skeleton at the origin, evaluated meshes, merged/normalised top-4 weights, visible-skin cloth transfer, stale-group report | Drops B-Bones, constraints, shape-key drivers and corrective smooth |
| `skin_check.py` | Stress poses (hips, knees, shoulders, elbows, spine) → stretch_cm / kink_cm per mesh | Limits calibrated on one 1.6 m character; compare builds |
| `gen_notext.py` (Python, Kimodo venv) | Text-free Kimodo locomotion from speed/direction specs | SOMA body proportions; needs CUDA |
| `export_src.py`, `extract_loop.py`, `select_clips.py` (Python, venv) | SOMA-77 export with kinematic contacts, seamless one-cycle loops, best-sample choice | Locomotion loops; one-shots need a different cut |
| `retarget.py` | Profile-driven retarget, hip-height scale, rest-direction correction, twist split, gaze levelling, foot lock, in-place | Humanoid bipeds |
| `render_clips.py` | EEVEE contact sheet per clip, side + front | Visual evidence, not runtime proof |
| `export_glb.py` | GLB, one animation per clip, lists materials glTF cannot read | Does not rebuild materials |
| `make_manifest.py` (Python) | `<char>.clips.json` (name, loop, speed, direction) | Direction from clip name |
| `tests/make_test_rig.py`, `tests/run_e2e.sh` | Synthetic Mixamo-style rig (+Y facing, A-pose, FBX transform) end-to-end test | Needs selected Kimodo loops |

## Completion

Do not call a character "animated" from Blender renders alone: the milestone is clips playing through the runtime's real
input path with blends, transitions and the procedural layers, inspected in captured frames. Missing GPU, Blender,
browser or model access means INCOMPLETE for that stage; do the preparation that is possible and name the exact
remaining check.
