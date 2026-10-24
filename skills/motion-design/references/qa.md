# QA and verdicts

## Gates

| Stage | Evidence | Pass when |
| --- | --- | --- |
| Profile | `inspect_rig.py` on the built game rig | `draft_problems: []`, draft `retarget` matches the profile or every difference is deliberate |
| Game rig | build report | `unweighted` 0 on visible meshes, `stale_like_game_bones` empty or explained |
| Skin | `skin_check.py` + a close look | no pose over limits, or each one seen in renders and accepted |
| Loops | `select_clips.py` output | `left_strikes == 1`, low seam cost, speed near the request |
| Retarget | report + contact sheets | facing right, arms natural, knees forward, run/strafe skating ≈ 0 after lock |
| Export | export json, GLB inspector | every clip present, `materials_not_gltf_ready` empty, joints ≤ budget |
| Runtime | deterministic scenarios + real keyboard/mouse | blends smooth through walk→run→stop and turns, slide metric low, no console errors |
| Demo | full-res stills from the video | no detaching, popping, skating or clipping visible |

Give **PASS**, **RETHINK** or **INCOMPLETE** for the milestone and name missing evidence. Inspect renders honestly and
say what still looks wrong, even when it is outside the request (report those as follow-ups instead of fixing them).

## Symptom → cause → fix

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Thigh looks like a separate tube; gap behind the hip when the leg trails | clothing took weights from hidden skin with stale group names | visible-skin cloth transfer (default now); check `stale_like_game_bones`; skin_check hips |
| Arms swing too little at run/sprint | source clip style | runtime `widenArmSwing` (0.35), not new clips |
| Feet skate | foot lock off, contacts wrong, or runtime rate not following speed | `--foot-lock`; kinematic contacts; phase rate = actual/clip speed |
| Pop at the loop seam | loop not one cycle or no closing key | `left_strikes == 1`; retarget writes N+1 keys |
| Blend between gaits stutters | loops start at different phases | all loops start at the left-foot strike (extract_loop does it) |
| Character looks at the floor | source head pitch | gaze levelling (default); `--keep-head-pitch` to disable |
| Clip runs sideways / backwards | wrong `facing` or wrong `--align` group | fix the profile; retarget each direction group separately |
| Arms raised / spread wrong | rest pose differs (A vs T) and the bone is listed as axial | keep limbs out of `axial` so the rest-direction correction applies |
| Wrist candy-wrap | no twist split | `retarget.twist` entry for the forearm twist bone |
| Export failed but the game shows the old model | chain hid the failure | `set -o pipefail`; copy only after a successful export |
| Textures missing after rebuild | relative `--blend` baked relative image paths | absolute paths; the build now resolves them |
| Port busy after stopping the dev server | orphan vite process | check the PID's command line, then stop it |
