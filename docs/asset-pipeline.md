# Hero asset pipeline (Blender 5.2.1, headless, host)

## Native Poliisi Rain

Use the pinned `data/raw/rain-native-20261017/rain.glb` and clip manifest. The
supplied model already has the uniform. `character-rain-native.contract.json`
records its 70 joints, 76,974 triangles, sixteen materials and original height.
The separate profile uses Rain's own measured gait speeds and `DEF-Spine1`.

`build_rain_gameplay_clips.py` reads GLB data with Blender mathutils and reuses the
fixed-length native hierarchy transport. It writes six gameplay actions and two
sockets; it never re-exports or resamples the original skin or eleven gait clips.
`prepare_rain_uniform_patch.mjs` rasterizes a bounded body-space/UV mask to extend
the existing navy sleeve colour over the axillae, protecting all other UV owners.

```powershell
node tools/assets/prepare_rain_uniform_patch.mjs --source data/raw/rain-native-20261017/rain.glb --out data/work/NEW_RAIN_UNIFORM
node tools/assets/prepare_rain_character.mjs --source data/raw/rain-native-20261017/rain.glb --supplement content/assets/rain-gameplay-clips.json --profile content/assets/character-rain-native.profile.json --uniform-patch data/work/NEW_RAIN_UNIFORM/patch.json --texture-cache data/work/rain-native-20261017/encoded-textures --out data/work/NEW_RAIN_ASSET
node tools/verify/verify-rain-preservation.mjs --candidate data/work/NEW_RAIN_ASSET/character-rain.glb --out data/evidence/NEW_RAIN_PRESERVATION.json
```

The adapter validates the exact source/patch hashes, unchanged alpha and every
pixel outside the mask, then encodes textures. All original non-image buffers
remain exact. `stage_character_release.ts` copies a new local release changing
only one character and attribution metadata; it neither prunes releases nor
changes the active pointer. Run native GLB, browser/police and performance gates
before local activation. Authoring proof lives in
`data/evidence/rain-native-20261017/authoring-v5/review.json`; it does not replace
packaged-game verification. Rain's generic `drive` action is not exposed as a
visible AI driver, and has no claim of Finn's cabin-specific entry fit.

## Finn vehicle interaction

Finn's car interaction is authored by `tools/blender/build_finn_vehicle_poses.py`
using the pinned supplied GLB as rig data and the measured Lumi GT cabin. It emits
`content/assets/finn-vehicle-poses.json` (schema 2). It holds `enter` (3.8 s) and
`exit` (2.8 s), plus `exitPassenger` (4.3 s), a climb across the cabin followed by the
mirrored exit. `exitWindshield` (5.2 s) is the same climb, then a kick through the
windshield and a slide out over the bonnet. `exitFlipped` (6.04 s) and
`exitFlippedPassenger` (6.3 s) crawl out of a car on its roof; they are authored in the
roof-plane frame and stored car-local. The file also holds the seated pose. These parent-local native bone transforms are bundled with the
game and sampled on the simulation's interaction clock. The car owns world motion.
This avoids re-exporting the accepted mesh, skin or eleven native locomotion clips.
Use fresh output/report paths for each Blender iteration. Check the report for
joint-limit problems and per-sample rotation jumps (it lists any of 0.65 rad or more), and measure skin clearance
at every frame (`data/evidence/car-motion-20261017/clearance.mjs <version> <clips> 1`
with `REACH=0.12`; the tool's default 0.05 m reach caps the depth it reports). Open
the contact sheets from `render-clips.mjs` in the same directory,
then run `tools/verify/verify-car-entry.ts` against a review build
(`npm run build:review`; the ordinary build has no test API). The final asset comes
from a run without `--draft`:

```
node .agents/skills/build-helsinki-game/scripts/run-blender.mjs --trusted-host ^
  --blender "C:\Program Files\Blender Foundation\Blender 5.2\blender.exe" ^
  --threads 2 --max-rss-gib 3 --timeout 600 --name car-motion-strict --log-dir data/logs ^
  --script tools/blender/build_finn_vehicle_poses.py -- --source-glb data/raw/finn12-20261017/finn.glb ^
  --output data/work/NEW/poses.json --report data/work/NEW/report.json ^
  --cabin data/evidence/car-motion-20261017/geometry/cabin-probe.json
```

Keys hold contact parameters (feet, grips, door ride, palms) until the key just before
their next key, so a key added anywhere changes those transitions. Arm poles are not
held, so they interpolate straight between keys. See decisions 0014, 0018 and 0020.

Other cars get their own clip set, warped from the Lumi GT's (decision 0021). `--target <spec>`
maps every keyed point through `tools/blender/cabin_warp.py` into that car's cabin, keeping
each clip's timing, and writes `content/assets/finn-vehicle-poses-<car>.json`; a car
definition selects it with `interaction.poses`. The spec comes from the car's own
cabin measurements: `data/evidence/cars-20261018/tools/cabin-probe.mjs <glb> <probe>`, then
`landmarks.py` and `make_specs.py`, which merges the per-car `tuning.json` (seat hip,
roof, seated posture and per-clip tweaks: `add` offsets or `set` values on the keys in a
time window). Rebuild the car, probe, spec and clips together: the spec records the car
GLB's SHA-256. Measure skin clearance against that car with
`data/evidence/cars-20261018/tools/clearance.mjs` (`CAR=<glb>`, `REACH=0.12`).

Blender is used only for hero assets (plan section 4 and rule 7): characters, vehicles and props, plus the
Cathedral's authored landmark model (decision 0005). LoD2 city buildings never pass through it. Every job runs
headless, one at a time, through the skill runner with thread and memory caps:

```
node .agents/skills/build-helsinki-game/scripts/run-blender.mjs --trusted-host ^
  --blender "C:\Program Files\Blender Foundation\Blender 5.2\blender.exe" ^
  --threads 4 --max-rss-gib 6 --timeout 1800 --name <job> --log-dir data/logs ^
  --script tools/blender/<script>.py -- <script args>
```

The runner adds `--background --factory-startup --disable-autoexec --python-exit-code 1`. Logs land in
`data/logs/<job>.stdout.log`, `.stderr.log` and `.resources.json`. Host execution is authorised for this project's
own scripts on the user's own source files; nothing downloaded runs with embedded scripts enabled.

**Pinned release: Blender 5.2** (5.2.1 LTS installed). The project `.env` sets `BLENDER_PATH` to that executable so
the runner cannot pick up the other installed build (3.1), and every script in the table below calls
`release_pin.require()` (`tools/blender/release_pin.py`) before any work, so a run on another release stops with an
error instead of meeting a moved API. Change the pin in that one file, then rerun the scripts and the census.

## Rules for every Blender script

1. Never modify the source `.blend` under `models/`. Open it, work in memory, save new files only under `data/work/`.
2. Export GLB with `export_yup=True` so the asset's Blender +Y (forward) becomes glTF +Z and Blender +Z (up) becomes +Y:
   author the asset in Blender as **−Y forward, +Z up, +X left** (the Blender default front view), which the
   exporter maps to the contract's **+Z forward, +Y up, +X left**. Check the exported node transforms in the report.
3. Unit scale, metres, no negative scales, transforms applied before export; no drivers, constraints or bendy bones
   survive export — bake first.
4. Materials: Principled BSDF with baked base colour images (sRGB), or flat colours. Limit image size per contract.
5. Write `blender-report.json` next to the GLB with node names, positions, bounds, triangle and material counts,
   clip names/durations and the source file's SHA-256; the Node verifier reads it.
6. Verify the GLBs against their contracts and the Khronos validator:
   `node tools/verify/verify-glb.ts --character data/work/m0/blender-character --car data/work/m0/blender-car --out data/evidence/NEW_DIR`
   (37 checks on 2026-10-16: joints, clips, sockets, height, wheel axes, dimensions, budgets). The quick structural
   look is `node .agents/skills/build-helsinki-game/scripts/inspect-glb.mjs --file <glb>`.
7. Census every exported GLB before looking at pictures: the skill's `mesh_census.py` re-imports it on the pinned
   release and counts boundary, non-manifold, flipped, loose and degenerate geometry, shells and size against a spec
   in `content/assets/census/` (bundled helper, so it runs on the host without `--trusted-host`):
   `node .agents/skills/build-helsinki-game/scripts/run-blender.mjs --script .agents/skills/build-helsinki-game/scripts/blender/mesh_census.py --log-dir data/evidence/NEW_DIR/logs -- --glb <glb> --spec content/assets/census/<asset>.census.json --output data/evidence/NEW_DIR/<asset>.json --fail-on-threshold`
   Limits follow the representation, not the measurement: closed solids (Cathedral, pistol) allow no boundary
   edges; open visual sheets (cars, characters) limit interior non-manifold edges; sizes come from an independent
   source (the STL under its placement, the build report) with a stated tolerance. First run on 2026-10-16
   (`data/evidence/census-20261016`): Cathedral, characters and pistol pass; both cars fail (backlog 27).

## Scripts (tools/blender)

| Script | Job |
| --- | --- |
| `inspect_car.py`, `probe_character_source.py`, `probe_uv_islands.py` | Read-only inventories of the source scenes (rigs, islands, materials, UDIM tiles) |
| `build_game_character.py` + `game_motion.py` | Snow/Rain → evaluated meshes, decimation, weight remap to the 22-joint skeleton, UV repack and base-colour bake, ten procedural in-place clips, sockets, GLB |
| `build_prop_pistol.py` | The 108-triangle pistol prop |
| `build_game_car.py` | Mustang rig → scale 0.88, brand parts and engine bay removed, decimated classes, procedural wheels, sockets, lumi-gt and patrol variants |
| `build_extra_cars.py` | The Revontuli (`models/bugatti-veyron-fully-rigged`) and the Kaamos (`models/GT40.blend`) on `build_game_car.py`'s nodes, materials and wheels: brand marks removed, cabin fit for Finn (seats, wheel, the Kaamos's roof blisters), own WINDSHIELD node; `--car revontuli\|kaamos` |
| `build_finn_vehicle_poses.py` + `cabin_warp.py` | Finn's car clips; `--target` warps them into another car's cabin |
| `review_game_character.py`, `review_car_glb.py` | Re-import the GLBs and render review stills under `data/work/m0/*/review/` |
| `build_landmark_model.py` | An authored landmark STL placed by `tools/world/place_landmark_model.ts` → three flat materials, Cycles light bake into one 2048² texture, GLB in the runtime frame, previews (the Cathedral, decision 0005) |
| `release_pin.py` | The pinned release and the `require()` check the scripts above call |

Runs on 2026-10-16: characters 10–15 s each at 0.35 GiB peak RSS; cars 6.6 s at 0.45 GiB; reports in
`data/work/m0/blender-character/blender-report.json` and `data/work/m0/blender-car/blender-report.json`.

## Contracts

- `content/assets/character.contract.json`: legacy 22-joint fallback, pistol rules,
  and explicit native Finn/Rain contract selection.
- `content/assets/character-finn.contract.json`: Finn's 71 native joints, parent links, 17 clips, sockets,
  40,000-triangle / 12-material / 6 MB limits and texture limits.
- `content/assets/character-rain-native.contract.json`: Rain's 70 native joints,
  parent links, 17 clips, sockets and 78,000-triangle / 16-material / 7.5 MB limits.
  Texture limits remain 1024 base colour / 512 data maps. The measured low-preset
  scene texture budget is checked separately; this does not raise that budget.
- `content/assets/vehicle-lumi-gt.contract.json`: the Mustang-derived "Lumi GT" and its patrol variant: node names,
  wheel and socket rules, budgets, brand-mark removal.
- `content/assets/vehicle-revontuli.contract.json`, `vehicle-kaamos.contract.json`: the two extra civilian cars
  (decision 0021), same node, wheel and socket rules; their census specs are `census/vehicle-<car>.census.json`.

## Finn native player pipeline

Decision [0011](decisions/0011-finn-player-character.md) replaces the old Snow player.
Use the supplied portable `finn.glb`, copied and pinned under `data/raw/finn12-20261017/`.
Do not run `build_game_character.py` on Finn12: it resets the facial shape and chooses
the hidden original hair. The portable source already contains the intended evaluated
face, short blond hair, native rig and eleven movement clips.

`tools/blender/build_finn_gameplay_clips.py` reads this GLB as data and writes six
supplemental gameplay actions plus sockets in its native rest frame. It does not
execute source scripts or import/reorient the source model. The release uses
`data/work/finn12-20261017/gameplay-final/supplement.json`; its report records exact inputs.

```powershell
node tools/assets/prepare_finn_character.mjs --source data/raw/finn12-20261017/finn.glb --supplement data/work/finn12-20261017/gameplay-final/supplement.json --profile content/assets/finn-locomotion.json --texture-cache data/work/finn12-20261017/encoded-textures --collar-patch data/work/finn12-20261017/collar-v1/patch.json --hidden-faces data/work/finn12-20261017/hidden-collar-v1/patch.json --out data/work/NEW_FINN_ASSETS
```

The packager preserves vertex positions, normals, UVs, materials, bind data, rest nodes
and native animation payloads. Two explicit corrections repair inherited collar
clipping: 89 covered lower-neck vertices follow the adjacent shirt weights, and two
head triangles entirely hidden beneath the source shirt are removed. Source hashes,
old/new weights, garment donors, exact triangle ordinals and dense coverage proof
bind both patches. All other weights and retained index order remain exact.
It converts images to mipmapped KTX2 (1024 base colour, 512 linear maps):
UASTC for skin, eyes and linear maps; ETC1S for clothing base colours. It then appends
the supplemental actions, sockets and renderer profile. Copy the accepted Rain and
pistol files byte-exact into the combined asset directory before publishing.

Verify with `verify-glb.ts`, `verify-finn-preservation.mjs` (both explicit patch inputs),
`verify-finn-gameplay-supplement.mjs` and the two Finn census specs. Blender 5.2's
importer cannot read required KTX2: `prepare-character-census.mjs` creates an
evidence-only copy without texture references, proving all BIN/geometry/rig/animation
data unchanged. Tiny eye-highlight triangles use a separate 1e-10 square-metre
degeneracy threshold; all other meshes retain 1e-8. Neither permits collapsed faces.
The measured positive areas and original failed import/census attempts are retained.

The runtime reads the optional profile from the GLB. It uses supplied gait speeds,
directional clips and common left-strike phase, and masks aim/fire to the upper body.
Rain now shares this native runtime through her own profile. Finn-specific jump
and vehicle pose layers are explicitly restricted to Finn. Movement and collision
stay in the simulation.
Finish with actual game captures, stair traversal, both graphics presets and journeys
with matching replays before changing the active pointer.

## Finn jump phases

Decisions [0012](decisions/0012-jumping-controls-and-camera.md) and
[0016](decisions/0016-finn-natural-jumps-and-ledge-climb.md) add jump and ledge-climb
poses in `content/assets/finn-jump-poses.json` (format version 2), bundled with the
renderer. The accepted GLB, world release and original eleven gait clips remain
byte-identical. This is authored animation data for the existing rig, with no
runtime Blender dependency.

`build_finn_jump_poses.py` reads the pinned portable source as data, uses its
actual rest hierarchy and the existing anatomical two-bone IK solver, and writes
28 clips of 71 normalized joint rotations plus hips translation. Other bone positions
and scales are preserved.

- Jumps: normal and super takeoff, rise, fall and landing. Each phase has a
  standing variant and two running variants, one per push-off foot.
- `air_loop`: a 1.2-second loop for long super-jump flight.
- Climbs: `climb_low`, `climb_mid` and `climb_high` for ledges 0.5, 1.0 and 1.5 m
  above the feet. Each has 31 samples over climb progress, plus per-sample grip
  weights and wrist targets relative to the edge.

The simulation's phase, vertical speed, predicted support clearance, impact
speed and climb progress select animation time. Raised surfaces therefore cause
actual contact-based landings. The runtime blends the climb variants by the real
ledge height and pins both palms to the real edge with two-bone arm IK. Upper-body
aim keeps both hands on the gun during flight.

Reproduce in a fresh output directory using the established reviewed host pipeline:

```powershell
node .agents/skills/build-helsinki-game/scripts/run-blender.mjs --trusted-host --blender "C:\Program Files\Blender Foundation\Blender 5.2\blender.exe" --threads 2 --max-rss-gib 3 --timeout 180 --name finn-jump-new --log-dir data/logs --script tools/blender/build_finn_jump_poses.py -- --source-glb data/raw/finn12-20261017/finn.glb --output data/work/NEW-JUMP/poses.json --report data/work/NEW-JUMP/report.json --joints data/work/NEW-JUMP/joints.json
```

The accepted output SHA-256 is
`a611f37213dd8b4b75ac6dba42e0fde274cc901f592ab2a42dc8e94488648e1d` (856,107 bytes).
The authoring report is `data/work/finn-jump-climb-20261017/b16/report.json`. It
checks leg and arm reach, knee bend and speed, wall contact of the legs during
climbs, wrist placement and bone lengths. It does not certify skinned appearance.
Before copying a changed output into `content/assets/finn-jump-poses.json` and
rebuilding, validate:

- the actual packaged GLTFLoader/mixer result;
- unchanged original tracks and bone lengths;
- skinned shoe contact;
- real runtime phase and climb captures.

See the jump verification records
([0012](benchmarks/finn-jump-controls.md), [0016](benchmarks/finn-jump-climb.md)).

## Historical Snow / Rain locomotion retarget pass

Both active characters now use the supplied native exports described above. This
older retarget route is retained for provenance and is not the current Rain build.

The base character build supplies the meshes, weights, game skeleton, sockets and non-locomotion actions. Its
procedural walk/run/sprint clips are intermediate inputs. The final character assets use the free Standard edition
of [Quaternius Universal Animation Library](https://quaternius.itch.io/universal-animation-library), CC0-1.0.
The archive, original GLBs, license and checksums are recorded in
`data/raw/quaternius-animation/ual1-standard-20261017/ledger.json` and `docs/source-register.md`.

`tools/blender/retarget_locomotion.py` replaces only those three actions on a generated game scene, writing a new
directory. `locomotion_retarget.py` decodes the motion GLB as data; no source meshes, scripts, drivers or add-ons are
loaded. The mapping and adaptation policy live in `content/assets/locomotion.motion.json`. Retargeting preserves
the target character's original torso balance, clavicle placement and mean arm carriage, then adds bounded,
mean-relative source motion in the target's anatomical frame. Copying the source's absolute collar directions
previously swept Snow's shoulders behind his chest; inspect front and side views across each full cycle.
The capsule continues
to own displacement; animation carries no horizontal root motion. Run Snow and Rain serially, changing the input,
variant, job name and output for Rain:

```powershell
node .agents/skills/build-helsinki-game/scripts/run-blender.mjs --trusted-host --blender "C:\Program Files\Blender Foundation\Blender 5.2\blender.exe" --threads 2 --max-rss-gib 3 --timeout 300 --name retarget-snow --log-dir data/logs --script tools/blender/retarget_locomotion.py -- --input data/work/m0/blender-character/character-snow.blend --source data/raw/quaternius-animation/ual1-standard-20261017/UAL1_Standard.glb --root-motion-source data/raw/quaternius-animation/ual1-standard-20261017/UAL1_Standard_RM.glb --ledger data/raw/quaternius-animation/ual1-standard-20261017/ledger.json --contract content/assets/character.contract.json --variant snow --out data/work/NEW/snow
```

Each output includes the new scene and GLB, source/retarget measurements in `motion-report.json`, and sampled
motion in `motion-samples.json`. The scene keeps dense 120 Hz LINEAR authoring keys. A deterministic GLB
postpass gives walk/run/sprint periodic cubic tangents after unwrapping quaternion signs.
The provenance records that interpolation difference and hashes the final GLB. Check the exported bytes
independently, against the previous character asset:

```powershell
node tools/verify/verify-character-motion.mjs --before data/work/m0/blender-character/character-snow.glb --after data/work/NEW/snow/character-snow.glb --provenance data/work/NEW/snow/motion-report.json --out data/evidence/NEW-snow-motion
```

That check verifies preserved geometry, materials, skin, rest skeleton and the seven other clips, then measures
loop continuity and skinned shoe contact on a flat floor, including between animation keys. It reports boundary
derivatives separately from finite-interval chord velocities. Its inferred contacts do not establish terrain contact.
Run the mesh census and native `verify-glb.ts` on both final character assets. Review real controls with
`tools/verify/verify-locomotion.ts`; it writes a WebM recording, timestamped frames, command/state evidence and an
HTML viewer with normal and slow playback. Browser performance and journey evidence must name the final release.

## Outputs

### Central Helsinki cells and Alexander II (2026-10-18)

The expanded cell pipeline is recorded in
[the reproducible build recipe](central-expansion-build.md). Its stable inputs
are `content/helsinki/central-expansion/`; frozen source data live under
`data/raw/central-expansion-20261017/`. It preserves the existing EPSG:3879/N2000
origin, the 128 m grid and the accepted Senate source/texture prefix.

The supplied `models/Alexander/Alexander-improved.glb` is retained untouched.
Its calibrated game derivative and placement report are in
`data/work/expansion-20261017/alexander/v3/`. `prepare_monument_ground.ts` adjusts
only the recorded 59 terrain samples beneath the monument and feather;
`add_cell_monument.ts` appends its visual and closed base collider to the origin
cell. Do not append it again after a ground-only rebuild.

Final cells are `data/work/expansion-20261017/cells-v4`. The last ground-only
repair reconciles one old retaining-wall line with the surveyed wall footprint;
all facade images and non-ground geometry remain exact. Facade repairs precede
derived tiers: `build_low_monument_cell.mjs` preserves every other node and
texture, while `build_distant_cells.mjs` emits textureless architecture with
exact ground. `build_far_vehicles.mjs` emits two optional low-preset distant car
models while retaining the full accepted car assets. The publisher stages a new
content-addressed release; it never needs to overwrite source GLBs.

Both detailed and distant visual tiers stream and unload at runtime. Shared
character/car/tree templates have a separate fixed reservation, and tree
instance buffers follow their owner cells. Runtime admission uses decoded
texture/buffer sizes. Full-release texture sums describe stored content, not
residency; acceptance requires the [streaming benchmark](benchmarks/central-expansion-streaming.md).
Static collision remains resident for this bounded 0.76 km² expansion.

The final routing graph is `roads-v2`, and `gameplay-v2` is byte-identical to
the previous gameplay bundle. Node-context checks exclude approaches to
unmodelled underground entrances/passages and gated/private driveways; the
road report names every source node and connection behind an exclusion.
Archived tree placement retains its original road input because that input
also determines which trunk colliders are disabled near streets.

`data/work/m0/blender-character/{character-snow.glb, character-rain.glb, prop-pistol.glb, blender-report.json}` and
`data/work/m0/blender-car/{vehicle-lumi-gt.glb, vehicle-patrol.glb, blender-report.json}`. The release publisher
copies them content-hashed into `apps/game/public/world/<release>/`.
