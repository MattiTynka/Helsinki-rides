# Native Poliisi Rain officer — 2026-10-17

Status: **PASS, active locally** at `http://127.0.0.1:5317/`.
Content: `senate-20261017-a236a318`. Ordinary bundle
`index-Bw7FPas1.js`, SHA-256
`f5aa5683bb970913872fb46638d7752be94541aa55bffe6379687bd6eafe6605`.
Rain GLB: `assets/character-rain.009d3210eb.glb`, 6,972,804 bytes, SHA-256
`009d3210eb011c43e06b3bc45a6cc4cacd7e531807c01e619d7ca58b5c7ef202`.
Evidence root: `data/evidence/rain-native-20261017/`.

The supplied model already wears the navy Poliisi uniform. It replaces the old
officer in the existing `character-rain` slot, with all eleven supplied in-place
movement clips and their direction/speed metadata. The game blends these on a
shared step phase; simulation still owns movement. Native gameplay actions add
aim, fire, hit, death, drive and arrested, plus pistol/head sockets.

Rain uses her own 70-joint skeleton and `DEF-Spine1` aim pivot. Finn's jump and
cabin-specific pose layers are restricted to Finn's profile. NPC pistol aiming
targets the same player height as police shooting. Skinned characters are not
culled using their stale bind-pose bounds. A read-only character inspection hook
exposes the actual loaded rig, mixer actions, skin bounds and pistol direction.

## Preservation and visual checks

- `preservation-final1.json`: all 2,436 original non-image buffer views are
  byte-exact, including geometry, UVs, skin weights, inverse binds and eleven gait
  tracks. Original rest hierarchy, materials and assignments also match. No
  geometry or skin exceptions. The checker has adversarial mutation tests.
- `stage-final1.json`: all 39 other payloads match the preceding car checkpoint.
  Buildings, terrain, collisions, scenery, Finn, cars and pistol are unchanged.
  The previous release is retained.
- The inherited underarm skin flash was an incomplete navy area in the body
  colour atlas. A UV-owner-aware mask corrects 3,756 RGB texels (0.0224%), with
  identical alpha and pixels outside the mask before texture encoding. Face,
  hands, lettering and other texture maps are protected. Patch identity and
  source images are retained under `data/work/rain-native-20261017/uniform-v1/`.
- `authoring-v5/review.json`: 221 actual skinned samples checked. Opened sheets
  cover six appended actions, hands, original sprint and idle. Compact two-hand
  pistol holds keep elbows down; the settled death pose keeps soles and ponytail
  above the flat reference ground. No detached limbs observed in reviewed views.
- `browser-final4/texture-review.json`: CPU-decoded packaged KTX2 maps retain
  the source's subdued blue chest lettering, partial back lettering and sleeve
  patches. Opened source/decoded maps confirm this. Mean RGB error is 2.48/255
  in the chest region and 2.00/255 at the back. The original back label is partly
  painted; no repair or improved distance legibility is claimed.

## Automated and browser gates

- `tests-final1.log`: **179/179 tests pass**; `typecheck-final1.log` and
  `build-final1.log`: pass. The existing Vite chunk-size warning remains.
- `glb-final1/glb.json`: **105/105 checks pass**, zero glTF validation errors.
  The explicit Rain contract permits 76,974 triangles and sixteen materials;
  legacy and Finn budgets remain separate.
- `standard-final1/browser.json` and `low-final1/browser.json`: **8/8 each** on
  the RTX 3070 Ti, approximately 144 fps scene averages. Highest measured frame
  p95 is 3.24 ms standard / 2.78 ms low. Draw calls peak at 215 / 155 against
  600 / 350 limits. Uploaded textures total 155.0 MiB, below 320 / 160 MiB limits;
  low-preset headroom is only 5 MiB. Initial transfer is 90 MB. No browser errors.
  These are local hardware measurements, not a claim about all devices.

- `browser-final4/results.json`: native Rain leaves the patrol car, pursues with
  animated native gaits, aims/fires and falls through the actual police state
  machine. 23 captures, no browser errors. Player teleports are labelled fixtures;
  no NPC/bone/mixer state is directly changed. Earlier capture attempts are
  retained: final1/2 pass with obstructed framing; final3 rejected its rear-camera
  fixture. Final4 corrects camera initialization and verifies the actual view side.
- `journey-final1/journey.json`: **2/2 uninterrupted gameplay runs pass**, including
  police pursuit, death/arrest, safe respawn, 12/48 ammunition and firing after
  respawn. Matching browser/Node replays: `e17e8d3b` (2,794 commands), `e58769fa`
  (2,949 commands). No browser errors. These runs use ordinary real controls;
  headless camera aiming uses the native camera hook.
- `car-final1/results.json`: the final default URL still passes real keyboard
  approach, visible entry/seating/driving, reverse exit and a real-time repeat.
  Opened entry 45%/75%, seated and after-exit frames show the intended cabin fit.
- `default-smoke.json`: default URL, native Rain profile and served GLB/bundle
  hashes verified after activation and restart (PID 41176, strict port 5317).
  Port 5173 belongs to the independent Finn Motion Lab.

`candidate-final2.json` freezes 109 source inputs. Its only delta from the tested
final1 candidate is camera framing in the Rain browser harness; runtime, asset
and bundle hashes remain exact. `completion.json` binds the final checks and
opened captures. `rain-police-fixture-demo.mp4` records the focused fixtures and
fixed-tick captures; it is not labelled an uninterrupted gameplay demo. The Finn
real-time car demo remains in `data/evidence/car-entry-20261017/`.

## Scope and limits

Rain's generic drive hold is retained for contract compatibility. AI drivers
remain hidden as before; Finn alone has the separately verified car entry and
seating sequence. Death is authored animation, not terrain-aware ragdoll physics.
Sampled poses and opened captures do not prove absence of every microscopic
finger/garment intersection. Original source scenes were not edited, and no
new model inference, download service or dependency installation was used.

## Reproduce

Use fresh output directories and the default local preview on strict port 5317.
Asset construction is documented in [the pipeline](../asset-pipeline.md).

```powershell
pnpm typecheck
pnpm test
pnpm build
pnpm preview
node tools/verify/verify-rain-native.ts --url http://127.0.0.1:5317/ --release apps/game/public/world/senate-20261017-a236a318 --out data/evidence/NEW-rain-browser
node tools/verify/verify-car-entry.ts --out data/evidence/NEW-rain-car
node tools/verify/play-journey.ts --url http://127.0.0.1:5317/ --release apps/game/public/world/senate-20261017-a236a318 --out data/evidence/NEW-rain-journey --runs 2 --max-seconds 90
```
