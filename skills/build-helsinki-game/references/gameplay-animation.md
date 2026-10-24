# Character and vehicle animation for gameplay

## Use film craft, change the acceptance target

Blender authoring tools are valuable for authoring controls, preserving rotation continuity, inspecting rigs and reopening saved scenes. A film shot follows a fixed timeline; gameplay must handle arbitrary interruptions, turning, slope changes, different car seats, pause/resume and repeated loops. Contact quality in Blender is necessary evidence, not sufficient runtime evidence.

Do not export the full authoring rig by default. A studio CloudRig character can carry more than a thousand bones and drivers (one measured 1,494 bones and 1,114 drivers). That is a useful authoring tool, not a suitable default crowd skeleton. A provisional near-character budget might be 64 deform joints, four weights per vertex and a few materials, with lower-cost distant NPCs; measure the actual runtime and visual needs before making this a release limit.

## Inspect before animating

Inspect the rig on a working copy; the `motion-design` skill's `inspect_rig.py` reports bones, B-Bones, masks, drivers, facing and stale weight groups.

Confirm rig/mesh names, actual control bones, IK/FK switches, stretch, root/pelvis relationships, actions and slots, weights, shape keys, and drivers requiring Python. Do not guess Rigify or CloudRig control names. Existing rig compatibility is runtime-tested, not inferred from filenames. Scripts written for Blender 4.4+ expect slotted actions; if installed capabilities differ, adapt a small tested compatibility layer instead of changing the entire scene.

Author controls, not arbitrary DEF/MCH/ORG internals. Pre-bend IK limbs, maintain poles, avoid stretch unless intended, and make foot/hand contacts explicit. Stress-test squat, reach, twist, single-leg support, sprint extremes and seated pose. Automatic weights need inspection, especially at clothing seams, shoulders, hips and rigid accessories. A car body or wheel should not receive soft skin deformation.

## Runtime clip contract

| Clip family | Behavior | Verification |
| --- | --- | --- |
| idle/walk/run | Loops; controller-driven translation by default | Seam continuity, phase synchronization, turn/stop transitions and speed-matched feet |
| enter/exit car | One-shot action aligned to seat/door/ground anchors | Position/orientation match, event ordering, blocked exit, interruption and duplicate-input handling |
| seated drive | Layered idle/steer pose | Hands on wheel, feet at pedals, body/chassis motion separation |
| fall/recover | Scoped state transition | Collision-authoritative landing and usable recovery |
| NPC idle/gesture | Interruptible decorative overlay | No movement or mission authority encoded only in a clip |

Declare exact names, durations, fps, sample range, loop flag, root-motion policy, movement speed, contact intervals and event phases in `assets/asset-contract.template.json`. Define whether the final Blender sample duplicates the first pose; export a duration and runtime looping policy that do not create a doubled dwell at the seam. Review pose **and velocity** across the seam. Retargeting must preserve scale and rest-pose compatibility, not just match bone names.

Default locomotion is in-place: the capsule/controller owns world displacement; animation speed follows measured horizontal movement. Root-motion actions are possible only with an explicit controller integration, collision sweep and interruption/correction policy. Applying root motion and controller translation together causes double movement.

## Adapt contact checks correctly

Saved-scene contact QA measures evaluated Blender world positions. On an in-place walk, the stance foot moves backwards relative to the static rig root. This is expected: apply the intended forward trajectory to a QA parent/scene before measuring world-space skating. Do not “fix” that backward foot motion into a stationary foot and break the animation. On slopes and curved paths, verify the controller/animation composition in the browser too.

Use separate QA scenes or actions per clip and a new saved file, then reopen in a separate process. Contacts require nonempty integer frame intervals within the measured range and numeric tolerances. A QA spec must reject empty or out-of-range checks, missing thresholds and insufficient jerk samples. Bone length checks assume correctly established uniform rig scale; use an evaluated rest-pose reference for nonuniform rigs. A declared floor/selected mesh must represent the intended support surface, not an unrelated flat height in the Helsinki world.

Take rig/bone names and frame ranges from actual inspection. Tolerances in metres/degrees are project decisions, not defaults. Inspect normal playback and slow motion. `failed:0` without measured relevant checks is not acceptance; numerical checks do not prove weight, appeal or blend quality.

## Export and runtime tests

Bake evaluated deformation motion, retain needed parent/root/socket hierarchy and supported morph tracks, then load GLB in Three.js. Check all clips exist and play without the Blender control rig. Match arbitrary idle→run→stop and walk→run transitions, reverse/turn, pause at mid-step, enter/exit car on both sides, and motion on curbs/ramps. Inspect feet, hands, capsule position, door and chassis alignment from the actual camera. Treat world placement, animation and physics debug overlays separately.

Preserve original/source license and motion provenance. Licensed reusable game animation is a valid option when within the user's instructions; if original motion is required, author it and record that constraint. Do not import paid video-generation calls, motion-transfer requirements or cinematic approval stages into ordinary game asset work.
