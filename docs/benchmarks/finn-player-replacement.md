# Finn12 player replacement

Date: 2026-10-17. Status: **PASS_LOCAL**, active release `senate-20261017-15933497`.
This replaces the accepted facade release `senate-20261017-cbd20b69`.
See [decision 0011](../decisions/0011-finn-player-character.md).

## Inputs and preservation

The supplied game's `finn.glb` is byte-identical to `motion/out/finn.glb`, SHA-256
`2d4516c7efc691fd544b25b5ff66d39e19a0f23a5c3b029dd44785652a9adebd`.
It preserves Finn12's evaluated face shape, short blond hair, blue eyes and revised
skin. The integration retains all 71 native joints, 12 materials, bind/rest data
and eleven supplied animation clips. Final geometry has 38,735 triangles; the two
removed triangles were entirely hidden below the shirt. Only 89 lower-neck skin
weight tuples differ. The source's 2,450 non-image buffer views are independently
compared: 2,447 exact, and three reconstructed with only the pinned corrections.

The simulation and input controls are unchanged. The renderer uses the source's
calibrated gait speeds, directional movement clips and synchronized left-strike
phase. Aim/fire use an upper-body mask over moving legs. Six existing gameplay
states absent from the source export are authored in Finn's native rest frame.

All 39 non-player world payloads remain byte-identical to the accepted baseline:
cell visuals and collision, terrain, roads, gameplay, scenery, Rain, pistol, cars
and trees. Original Downloads files are read-only. The 2017 mesh remains removed.

## Intermediate findings retained

The first package exceeded the 6 MB limit. The second uses UASTC KTX2 for skin,
eyes and linear maps, and ETC1S for clothing base colours: 5,920,152 bytes. Geometry,
material properties and original movement tracks are unchanged.

The generic census initially classified 32 tiny eye-highlight facets below its
1e-8 square-metre threshold. All 60 highlight triangles have positive area; the
minimum is 8.194231e-9 square metres, with a 0.29008 mm minimum edge. Only this
separate mesh uses a 1e-10 threshold; collapsed/duplicate/zero-area triangles remain
forbidden. Main meshes retain the original precision. Census passes 68/68 + 8/8.
Blender cannot import required KTX2; the evidence-only census copy removes texture
references while retaining every binary byte and all geometry/rig/animation data.
Both original failures and the equivalence proof remain in the evidence directory.

Candidate `senate-20261017-88519b41` passes 86/86 asset checks, 29 supplement checks,
1,560 actual offline mixer ticks, 31/31 real-control locomotion checks, 50/50 ground
checks and both 8/8 graphics gates. Full typecheck and 93/93 tests pass. Opened
front/side gait images show coherent shoulders, torso and alternating steps; all
six stair routes complete without capsule feet below the visible support. Selected
landing images show no deep leg immersion. Stair-specific foot IK is not present:
flat-ground motion can hover or intersect individual treads during a stride.

Close aim/fire views exposed open support fingers behind the pistol and small
skin intersections near the shirt collar. That intermediate candidate was not
activated. Native palm-frame alignment, arm IK and phalanx curls fix the support
grip without changing the original movements. Collar clipping also appears in the
supplied demo; pose-only variants v4/v5 did not repair the underlying different
head/shirt weights and were rejected.

The final uses the proper high aim from `gameplay-final` (byte-identical to the
accepted v3 grip). A source-bound 89-vertex patch follows the existing garment's
weights. A wider 128-vertex trial still left the differently triangulated face
interiors crossing and was rejected. Exactly two head triangles fully beneath the
shirt are removed in v8: source ordinals 11 and 2946. Each has 325 independent bind
coverage probes, at least 9.64 mm from the actual garment opening. Vertex positions,
normals, UVs, face shape, all other weights and native animation arrays stay exact.
The final opened aim front/side views clear the isolated skin island and retain
the intended collar opening and grip. Earlier failed views remain as controls.

Final asset: `data/work/finn12-20261017/character-v8/character-snow.glb`, 5,920,152
bytes, SHA-256 `c54802ad951926a1574576e6797ff73a9744c86707614a1e81e3f307f212fe86`.
Publisher staging: `data/work/finn12-20261017/world-v8`. Activation followed the
final gates, source binding and bounded visual acceptance.

The v6 native graphics checks passed; its journey was intentionally stopped during
run 2 when the remaining collar finding required a new asset. It is incomplete
historical evidence, not the final candidate's journey gate.

## Evidence and limits

Final offline acceptance passes 86/86 GLB checks, strict source/world preservation,
650 independently recalculated garment-coverage probes, 12 negative regression
tests, and a fresh 8/8 evaluated head census. The eleven other meshes reuse their
unchanged source census. Full typecheck and all 105 tests pass. The actual Three.js
loader/mixer completes 1,560 checked ticks. `candidate-v8.json` freezes 174 source
and configuration files, the review bundle and manifest; the local activation
script rejects any subsequent source drift.

Both final graphics presets pass 8/8 native checks on the RTX 3070 Ti:

| Preset | Lowest scene average | Maximum draw calls | Uploaded textures | First control |
| --- | ---: | ---: | ---: | ---: |
| Standard | 142 fps | 188 | 147.1 MiB | 5.7 s / 84.1 MB |
| Low | 127 fps | 179 | 147.1 MiB | 6.0 s / 84.1 MB |

These are local measurements on the recorded GPU, not a guarantee for other devices.
Final visual captures are under `poses-v8/` (62 views) and `aim-v8-final/` (12 close
views). The independent aim review finds the collar clipping cleared and the
support hand wrapped around the grip. Evidence paths are relative to the root below.

Natural journey screenshots also show the hands-up arrested state and an early
death fall. The death screenshot is at 28 simulation ticks, not the final prone
pose: the wasted screen slows time to 0.3, so the harness's 1.5-second wall delay
advances the clip only about 0.47 seconds. `reaction-review-motion-analysis.json`
binds that state to the source and packaged tracks. The final prone endpoint is
verified numerically; these screenshots do not establish its runtime appearance.
The harness comment about a settled death animation should not be read as proof
of that endpoint.

All ten final real-control journeys pass with matching Node replays and zero
browser errors. They cover walking, vehicle entry/driving/exit, police pursuit,
firing, death/arrest and recovery without reloading. `journeys-v8/journey.json`
holds the per-run results and command traces.

The ordinary build passed, and the previous preview process was stopped before
restarting on strict port 5317 (final PID 28756). No listener remains on 4317.
`production-smoke/smoke.json` verifies the unqualified default URL, both current
pointers, the served ordinary bundle, all 21 served GLBs and 2.24 metres of real
keyboard walking. Both resulting screenshots were opened and show Finn. The first
smoke attempt had a test-helper wait-condition error after the loading overlay
already closed; the corrected helper passed without a product change. That failed
attempt is retained under `production-smoke-attempt-1/`.

`activation.json` binds pre-activation gates. `completion.json` binds the ordinary
build, default-URL visual review, final listener and documentation. All 174 frozen
source/config files remained exact through acceptance. Nothing was committed or
published externally. Open `http://127.0.0.1:5317/` without an old `release=` query
and reload an already open page to receive Finn.

Evidence root: `data/evidence/finn12-20261017/`. Source/clip provenance is in
`data/raw/finn12-20261017/` and `source-motion-investigation.json`. Source inference
is not reproduced: the supplied export is pinned, but its original Kimodo checkpoint
revision/hash is absent. Source scripts are archived references, not executed input.

Driving hides the player model, as in the existing game; car entry/exit is verified,
but an in-car seated-driver visual is not claimed. Captures establish selected poses,
not exhaustive contact or a motion-capture quality rating. The unchanged world retains
the facade/roof limits documented in the previous handoff. First-control transfer
remains above the original 20 MB target; character replacement does not close that
pre-existing world-loading limit.
