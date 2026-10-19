# Central Helsinki expansion: reproducible build recipe

Recorded 2026-10-18. Corrected candidate `senate-20261017-185c7a1b` comes from `data/work/expansion-20261017/cells-v4`, `roads-v2` and `gameplay-v2`. Its manifest SHA-256 is `96a66fa54e20c3f7d8ece20b651d12549276d315753350f20152de371be89312`. Earlier candidate `senate-20261017-69ef6997` / `cells-v3` failed the final driving check and is historical. See the [streaming benchmark](benchmarks/central-expansion-streaming.md) and current handoff for the corrected candidate's runtime verification and activation status.

## Scope and preservation contract

The playable rectangle is runtime X `[-800,150]`, Z `[-450,350]`: 950 × 800 m, **0.76 km²**, covering Senate Square, Kluuvi, the railway station approach and Esplanadi. The fixed origin remains `senate-square-statue-v2`, EPSG:3879/N2000 `[25497350,6672960,7.5]`, with runtime X east, Y up and Z south. Cells remain 128 m. Static deterministic physics for this bounded rectangle stays loaded independently of streamed visual cells. This is not the whole-city milestone and does not restore the removed 2017 mesh.

The playable projected bbox is `[25496550,6672610,25497500,6673410]`. Acquisition uses a 40 m margin: `[25496510,6672570,25497540,6673450]`. Full intersecting source tiles/polygons extend farther than this rectangle; builders clip to the playable bounds. Do not use source-feature bounds as the playable boundary.

The accepted comparison release is `apps/game/public/world/senate-20261017-a236a318`. Its source city model is `data/work/m0/citymodel-v2`; accepted facade output is `data/work/facade-cleanup-20261017/cells-v3`; source terrain is `data/work/m0/terrain-v2/terrain.bin`; authored Cathedral is `data/work/m0/cathedral/model-v4`. Keep these and the original Senate raw directories immutable.

`tools/world/merge_city_model.ts` preserves the accepted city binary's **988,704-byte prefix, 63 building records and 124 texture-page indices**. It verifies overlapping geometry, UVs, indices, material data, source vintage and texture bytes, deduplicates by building ID and texture source hash, then appends new content. The merged source has 418 buildings, 903 texture pages and 106,566 triangles. Source page numbers used by existing facade reconstructions therefore remain valid. Some full-tile buildings lie beyond the playable rectangle.

## Frozen acquisition

All snapshots below are named `central-expansion` beneath `data/raw/central-expansion-20261017`. Each layer has its own ledger. The game makes no live City of Helsinki or OSM requests.

| Directory | Payload | Snapshot SHA-256 |
| --- | --- | --- |
| `lod2` | 148 tiles, 128,614,748 bytes | `44d2bc551f526131e1513664b2e5c93678a84926906b4623ad194bab416c0a3d` |
| `terrain` | 336 tiles at zoom 18, 3,826,134 bytes | `129fb3e54d50562f66f0d2e29352610192876d8d4cc492a6243e6427ceae05f9` |
| `trees/street` | 79 tiles, 2,102,372 bytes | `8ac175f5f9b11aacd357b3142614b40f52516719d8ce36e97103d3bbd3c83970` |
| `trees/plot` | 126 tiles, 1,081,388 bytes | `4d174f0af5af54105db9c8d6f47e7e7bf488ac06122d235a6508d265a1a907f8` |
| `building-register` | 389 GeoJSON features | `c665d7d838ec4bcc3142721a29ed4591c01f162e0164658969609e6bc439f5db` |
| `street-parts` | 3,065 GeoJSON features | `e1ff183823d87db0633f758a86476daff27ffd9fa988d164170da00a6b865a04` |
| `osm` | 26,066 nodes, 5,416 ways, 710 relations | `e59d950e5732f4a64b684f89f4c2544e5ca84a3cdf758ce2a91a91433188c44f` |

Tile snapshot hashes identify `central-expansion/tiles.json`; individual payload hashes and sizes are in that index. WFS and OSM hashes identify the actual GeoJSON/JSON body. `data/evidence/expansion-20261017/acquisition/report.json` verifies every payload and all shared accepted source data: 19 LoD2 tiles, 80 terrain tiles, 3 street-tree tiles, 31 plot-tree tiles, 61 building footprints and 482 street-part geometries. Versions match the accepted snapshots: LoD2 `303357262605`, terrain `1.1708423032937557`, street trees `303007720360`, plot trees `300497315794`.

WFS response feature `id` values are request-dependent. Compare buildings by persistent `vtj_prt`, or exact geometry when it is null; compare street parts by `osan_id`. `acquisition/wfs-bounds.json` records the full returned polygon bounds and demonstrates why they must be clipped.

These commands describe a **new acquisition**, not a way to overwrite the frozen snapshot. Choose a fresh raw root, verify the live layer/vintage and compare overlap again. Network results at a later date are not guaranteed to reproduce these hashes.

```powershell
$freshRaw = 'data/raw/central-expansion-new-snapshot'
if (Test-Path -LiteralPath $freshRaw) { throw 'Choose a new raw directory' }
node tools/world/fetch_city_model.ts --bbox 25496510 6672570 25497540 6673450 --name central-expansion --out "$freshRaw/lod2"
node tools/world/fetch_terrain.ts --bbox 25496510 6672570 25497540 6673450 --zoom 18 --name central-expansion --out "$freshRaw/terrain"
node tools/world/fetch_trees.ts --layer street --bbox 25496510 6672570 25497540 6673450 --name central-expansion --out "$freshRaw/trees"
node tools/world/fetch_trees.ts --layer plot --bbox 25496510 6672570 25497540 6673450 --name central-expansion --out "$freshRaw/trees"
python tools/world/fetch_footprints.py --layer building-register --bbox 25496510 6672570 25497540 6673450 --name central-expansion --out "$freshRaw/building-register"
python tools/world/fetch_footprints.py --layer street-parts --bbox 25496510 6672570 25497540 6673450 --name central-expansion --out "$freshRaw/street-parts"
node tools/world/fetch_osm.ts --bbox 25496550 6672610 25497500 6673410 --margin 40 --name central-expansion --out "$freshRaw/osm"
```

`fetch_trees.ts` appends its layer subdirectory itself. OSM receives the playable bbox plus `--margin 40`; supplying the already expanded bbox would apply the margin twice. City layer URLs are explicit constants in the fetchers and source URLs are retained in the ledgers. The sources registry retains the existing license-verification requirements; acquisition success is not a substitute for licensing evidence.

## Replay from the frozen sources

Run from the repository root with the workspace's Node and pnpm dependencies installed. Commands below are sequential; do not publish or verify while a preceding helper is mutating the same cells. Stop after any failed command. Use fresh output directories, not an active release.

`data/work/expansion-20261017/config/{cells,roads,gameplay,sources}.json` records the configurations used for the final candidate. All four stable copies under `content/helsinki/central-expansion/` were verified byte-identical to those archived inputs. Compare their hashes again before substituting them into a later replay. The commands intentionally name the archived working inputs so their identity is explicit.

```powershell
$raw = 'data/raw/central-expansion-20261017'
$sourceWork = 'data/work/expansion-20261017'
$work = 'data/work/central-expansion-replay'
$cfg = "$sourceWork/config"
$origin = 'content/helsinki/world-origin.json'
$monument = "$sourceWork/alexander/v3"
if (Test-Path -LiteralPath $work) { throw 'Choose a new replay directory' }

node tools/world/convert_city_model.ts --ledger "$raw/lod2/ledger.json" --snapshot central-expansion --origin $origin --out "$work/citymodel-expanded"
node tools/world/merge_city_model.ts --base data/work/m0/citymodel-v2 --expanded "$work/citymodel-expanded" --out "$work/citymodel"
node tools/world/build_terrain.ts --tiles "$raw/terrain/central-expansion" --ledger "$raw/terrain/ledger.json" --origin $origin --config "$cfg/cells.json" --resolution 1 --out "$work/terrain"
node tools/world/prepare_monument_ground.ts --terrain "$work/terrain" --placement "$monument/placement.json" --out "$work/terrain-monument"
node tools/world/build_roads.ts --osm-ledger "$raw/osm/ledger.json" --snapshot central-expansion --origin $origin --config "$cfg/roads.json" --terrain "$work/terrain-monument/terrain.bin" --street-parts "$raw/street-parts/central-expansion.geojson" --out "$work/roads"
node tools/world/build_trees.ts --ledgers "$raw/trees/street/ledger.json,$raw/trees/plot/ledger.json" --snapshot central-expansion --terrain "$work/terrain-monument" --roads "$sourceWork/roads/roads.json" --footprints "$raw/building-register/central-expansion.geojson" --models "$sourceWork/trees-models/blender-report.json" --config "$cfg/cells.json" --origin $origin --out "$work/trees"
node tools/world/build_gameplay.ts --content "$cfg/gameplay.json" --origin $origin --register "$raw/building-register/central-expansion.geojson" --roads "$work/roads/roads.json" --terrain "$work/terrain-monument/terrain.bin" --out "$work/gameplay"
node tools/world/build_cells.ts --city-model "$work/citymodel" --terrain "$work/terrain-monument" --footprints "$raw/building-register/central-expansion.geojson" --street-parts "$raw/street-parts/central-expansion.geojson" --landmarks content/helsinki/landmarks.json --landmark-models data/work/m0/cathedral/model-v4 --osm-ledger "$raw/osm/ledger.json" --osm-snapshot central-expansion --trees "$work/trees" --config "$cfg/cells.json" --origin $origin --out "$work/cells"
node tools/world/add_cell_monument.ts --cells "$work/cells" --monument $monument
node tools/world/fix_cell_quantization.ts --cells "$work/cells"
$finalCells = "$work/cells"
```

The source conversion loads the installed trusted Basis transcoder as an ordinary temporary CommonJS module, without evaluating generated strings. The merged JSON SHA-256 is `bc23ac4b9386a83904f9a806903ff1200131543a9d9666073d41178d8023df22`; binary SHA-256 is `780c1005bd061152866c2d3766d6a238b3d98362acdd0ec89058bd1eedc6a648`. `citymodel/merge-report.json` records the exact prefix and overlap checks.

The terrain's only intentional source-height correction is the supplied Alexander base: `prepare_monument_ground.ts` changes 59 one-metre grid samples inside the recorded footprint and one-metre feather. Every other original-district source sample is unchanged. The source terrain is separate from the derived lower safety heightfield in each cell build. Roads, authored geometry and trees use source terrain; publishing selects the matching `runtime-terrain.bin` from the cell report automatically.

`tools/world/lib/surface-way.ts` is shared by road and ground assembly. Tunnels, bridges, indoor ways and negative layers that lack supported separate geometry are excluded instead of being drawn or driven as surface roads. The frozen source has 687 such ways; the offline checker independently verifies their exclusion.

`tools/world/lib/road-approaches.ts` also considers connected nodes and ways: parking portals, isolated approaches into excluded tunnels/building passages, and gated/private driveways do not become surface traffic routes. Its traversal stops at public junctions and ordinary roads. `roads-v2/roads-report.json` records the source reasons; `data/evidence/expansion-20261017/unsupported-approaches.json` records the exact 77 ways removed from the previous graph. The corrected graph has 960 lanes and 1,232 connectors; `gameplay-v2/gameplay.json` remains byte-identical to the earlier gameplay payload.

The tree model report is bound to the **accepted** `assets/scenery-trees.glb`, hash `ad3978765df75d695c5756b53c9ff2f1f418bf964a28e0ae910661882c6f2690`, not the newer authoring GLB. `trees-models/bind-accepted-profile.mjs` and `geometry-proof.json` verify all three models' decoded geometry, world transforms and measured bounds against the authoring profile before binding that profile. The profile SHA-256 is `ed47cca2296042fba9240b9d34b20d75365452bb4528ab94cd4541d0110922c1`. The resulting `trees-v2` has 810 instances. Never fix an asset binding by replacing a hash without proving the model/profile compatibility.

The tree replay deliberately uses archived `roads/roads.json`, the exact road input used for `trees-v2`; the traffic graph uses the corrected current road builder. Tree generation uses lane proximity to disable colliders, so substituting `roads-v2` would change the tree build input and could change trunk-collider flags. The final ground repair preserves the accepted 810 placements and all non-ground colliders exactly.

## Ground-only correction and facade-only correction

Use these routes when the city geometry and source inputs are already correct. They avoid a complete building/facade rebake. A new full build with the current ground helpers already contains the ground correction.

The observed failures were concrete: stepped entrance terraces used a separate smooth collision surface, and one-metre terrain peaks could protrude above four-metre ground quads. `buildEntranceTerraces` now collides against its visible treads and risers. `lowerTerrainUnderGround` clips actual support triangles against the safety grid and keeps its translated collider at least 5 cm below the visible surface. It leaves source heights and visual geometry untouched. Existing stairs and retaining-wall floor constraints remain in force.

The first correction produced `cells-v1` → `cells-v2`; facade reconstruction then produced `cells-v3`. Final keyboard driving exposed a separate defect: old OSM retaining wall `87053923` cut through current Fabianinkatu carriageway `56749`. `reconcileRegisterWalls` in `tools/world/lib/ground.ts` aligns a complete matching wall to the current survey only when the old line crosses a carriageway, every segment has a parallel surveyed wall edge, and no point moves more than 2.5 m. Exactly one source wall matches here, to register wall `470907`. The real sunken driveway remains lower on its own side of the surveyed wall; source terrain and source OSM remain unchanged.

The current correction is `cells-v3` → `cells-v4`, retaining all facade repairs. To reproduce it in a fresh output:

```powershell
node tools/world/rebuild_ground.ts --base "$sourceWork/cells-v3" --terrain "$sourceWork/terrain-monument" --footprints "$raw/building-register/central-expansion.geojson" --street-parts "$raw/street-parts/central-expansion.geojson" --osm-ledger "$raw/osm/ledger.json" --osm-snapshot central-expansion --config "$cfg/cells.json" --origin $origin --out "$work/cells-ground-repair"
$finalCells = "$work/cells-ground-repair"
```

The helper checks decoded non-ground geometry, transforms, material properties and image bytes before/after serialization, and checks every non-ground collider's arrays exactly. The Alexander collider is `landmarks/alexander-ii-monument`, so it is retained; **do not append the monument a second time** on this route. It emits lod0 descriptors only. In `cells-v4`, only ground collision cells `c_m02_p00` and `c_m02_p01` change; the other 67 collision payloads are byte-identical. The safety field changes 79 derived samples within X `[-161,-150]`, Z `[119,150]`, with SHA-256 `b8f609084b1f5578817fb9e5f66a7f895fb79dfd779c26681ce22bec1c55b6d2`. Source terrain remains `e48f5dfe89b72e2299a76a28c2c90935f09afc85c7fd2f0a6fab77e9b9345342`. `drive-final/ground-v4-preservation.json` records these comparisons.

For a new facade reconstruction, follow [the facade cleanup protocol](facade-cleanup-protocol.md): locate the actual building, inspect corresponding Street View/reference evidence, reconstruct only explicitly identified source charts using permitted source pixels, and inspect exported browser views. Street View is visual reference, not a texture download source. Register source-bound reconstruction code in `tools/world/lib/facade-restoration-registry.ts`; do not apply generic repeating-pattern erasure to the city.

```powershell
# Optional: only for a new facade repair. cells-v4 already preserves the recorded Esplanadi repair.
# Set this to the fresh full build or the fresh ground-only repair above.
$finalCells = "$work/cells-ground-repair"
node tools/world/repair_facades.ts --base $finalCells --city-model "$sourceWork/citymodel" --trees "$sourceWork/trees-v2" --config "$cfg/cells.json" --pages 677,697,698,699,701 --out "$work/cells-facade-repair" --texture-cache "$work/facade-texture-cache"
$finalCells = "$work/cells-facade-repair"
```

The historical `cells-v2` → `cells-v3` Esplanadi repair selected merged source pages `677,697,698,699,701` with the command above. Those indices include the preserved 124-page Senate prefix; the unmerged source indices are different. `--pages` selects cells referencing those pages and reconstructs all atlases in those cells. Five atlas images were checked: three remained byte-identical and only two changed, in `c_m03_p01` and `c_m04_p01`; all geometry and collision remained exact. Change the selected page list for a different bounded repair, or omit it only for an intentional all-cell facade rebuild.

For a fresh full build, use its own `citymodel` and `trees` directories in that command. Facade repair copies the frozen build, changes image ranges only, checks that geometry/compression/non-image semantics and collision remain unchanged, and retains `runtime-terrain.bin` and `scenery.json` byte-for-byte. It removes lod1/lod2 descriptors because those tiers must be regenerated from the repaired detail. Do all facade changes before the following steps.

## Derived tiers, verification and staged publication

The quantization helper only declares missing `KHR_mesh_quantization` metadata; it proves the BIN payload is unchanged. Use it once on a fresh working build when needed, before derived tiers. It is not a geometry rebake.

```powershell
node tools/world/build_low_monument_cell.mjs --cells $finalCells --monument "$monument/alexander-monument.glb"
node tools/world/build_distant_cells.mjs --cells $finalCells
node tools/world/build_far_vehicles.mjs --assets "$sourceWork/assets" --out "$work/far-vehicles"
# Copy the six accepted assets, then the two newly built optional derivatives.
New-Item -ItemType Directory -Path "$work/assets" -Force | Out-Null
Copy-Item -LiteralPath "$sourceWork/assets/character-snow.glb","$sourceWork/assets/character-rain.glb","$sourceWork/assets/prop-pistol.glb","$sourceWork/assets/vehicle-lumi-gt.glb","$sourceWork/assets/vehicle-patrol.glb","$sourceWork/assets/scenery-trees.glb" -Destination "$work/assets"
Copy-Item -LiteralPath "$work/far-vehicles/vehicle-lumi-gt-far-low.glb","$work/far-vehicles/vehicle-patrol-far-low.glb" -Destination "$work/assets"
node --test tools/world/test/*.test.ts
pnpm exec tsc -p tools/world/tsconfig.json --noEmit
pnpm exec tsc -p tools/verify/tsconfig.json --noEmit
node tools/verify/verify-expansion-world.ts --cells $finalCells --terrain "$sourceWork/terrain-monument" --roads "$sourceWork/roads-v2/roads.json" --gameplay "$sourceWork/gameplay-v2/gameplay.json" --street-parts "$raw/street-parts/central-expansion.geojson" --assets "$work/assets" --baseline apps/game/public/world/senate-20261017-a236a318 --osm "$raw/osm/central-expansion.json" --out "$work/evidence/world"
node tools/world/publish_release.ts --cells $finalCells --terrain "$sourceWork/terrain-monument" --roads "$sourceWork/roads-v2" --gameplay "$sourceWork/gameplay-v2" --assets "$work/assets" --origin $origin --sources "$cfg/sources.json" --config "$cfg/cells.json" --out "$work/releases" --status PILOT --keep
```

For a full replay, substitute `$work/terrain-monument`, `$work/roads` and `$work/gameplay` consistently in verification/publication. Verification reads the same staged `$work/assets` pack that will be published. Its six accepted filenames are `character-snow.glb` (Finn), `character-rain.glb`, `prop-pistol.glb`, `vehicle-lumi-gt.glb`, `vehicle-patrol.glb` and `scenery-trees.glb`; all six final-release hashes match the accepted release exactly. The final pack adds `vehicle-lumi-gt-far-low.glb` (5,791 triangles) and `vehicle-patrol-far-low.glb` (5,877 triangles), textureless derivatives used only by the low preset beyond 30 m with a 3 cm simplifier error bound. Nearby cars and entry animation use the accepted full models. The publisher adds content-hash suffixes to all eight published filenames and records their paths in the manifest.

The low monument tier changes only the supplied monument's meshes, with a 2 cm error bound, preserving the rest of the origin cell's geometry and every texture. The distant tier uses the final detailed cells, licensed atlas-derived vertex colours and no textures; ground and stairs keep their exact vertices, while complex above-ground geometry permits at most 10 cm simplification error. These helpers mutate only their new unpublished working directory and must finish before publication. Do not run a texture repair afterward and retain stale tier descriptors.

`publish_release.ts` hashes and validates the exact assets and writes a content-addressed release plus a `current.json` **inside the specified staging root**. Always use `--keep`; without it the publisher removes other release directories under its output root. The recipe deliberately stages under `data/work`, leaving the live pointer unchanged. Copy the staged candidate into the served world directory for a release-qualified browser review; update the live pointer only after the exact candidate's runtime gates pass. Keep the accepted release available for rollback.

The configured low-preset texture limit remains 160 MiB. `build_cells.ts` and `rebuild_ground.ts` mark an enabled streamed build as `bounded-runtime-window` and explicitly require measured runtime verification; the 533 MiB historical whole-release texture estimate describes disk-wide content, not a successful residency measurement. `cells-v2/budget-policy-update.json` documents the initial ground helper report's correction to this same policy, preserving its prior report hash and unchanged limit.

Use the existing single server, with its actual port supplied explicitly. The browser checks accept a served candidate directory and bind the review URL to its release ID:

```powershell
$servedCandidate = 'apps/game/public/world/REPLACE_WITH_STAGED_RELEASE_ID'
$gameUrl = 'http://127.0.0.1:5317/'
node tools/verify/verify-expansion-browser.mjs --url $gameUrl --release $servedCandidate --preset low --walk --out "$work/evidence/browser-low"
node tools/verify/verify-expansion-browser.mjs --url $gameUrl --release $servedCandidate --preset standard --out "$work/evidence/browser-standard"
$releaseId = (Get-Content -Raw -LiteralPath "$servedCandidate/manifest.json" | ConvertFrom-Json).worldReleaseId
$reviewUrl = "${gameUrl}?review=1&release=${releaseId}&seed=2026&preset=low"
node tools/verify/drive-expansion.ts --url $reviewUrl --release $servedCandidate --out "$work/evidence/drive"
```

Review the captured images, both presets, real travel out and back, repeated cell residency and memory, collision readiness and the existing gameplay journey. Capture-only or teleport fixtures do not prove real traversal. A later source, facade, tier or runtime change creates a new candidate and needs its own affected checks. Browser evidence and final activation remain the release owner's responsibility.

## Ground verification evidence and limits

`data/evidence/expansion-20261017/world-v4-final/world.json` passes all 13 static checks using the final derived-tier index for `cells-v4`, `roads-v2` and `gameplay-v2`: 660,100 full-width lane support probes, 37,063 lane alignment samples, 9,084 cell-seam samples, 1,168 boundary samples, 12,854 accepted-interior comparisons, five source-identified landmarks, six accepted asset hashes and exclusion of unsupported separate-level ways. Full-width sampling is at most 0.25 m across and 0.5 m along. Rays start above decoded visible ground, avoiding false holes from stale lane heights. Visible/colliding surfaces must agree, and adjacent support heights within a shared surveyed carriageway must not differ by more than 0.35 m. There are no carriageway step failures; maximum adjacent height difference is 0.290899 m. The reported Fabianinkatu cross-section drops only 0.002410 m over 0.25 m, versus 1.111608 m before repair; `drive-final/ground-v4-cross-section.json` also compares the four recorded wheel positions.

`final-payload-independent-review.json` verifies all 220 manifest payloads in both the public and built-game copies of `senate-20261017-185c7a1b`, totaling 406,687,255 bytes per copy, against the manifest and working inputs. All 77 removed ways have independent source-node/connection proofs: seven parking portals, seven unbranched continuations, 33 gated/private driveways and 30 isolated tunnel/building-passage approaches. No removed way contains an interior public through-junction; public Fabianinkatu `74307865`, Unioninkatu `149118540` and Kirkkokatu `75509961` remain. This package check does not substitute for browser driving or activation proof.

Maximum lane visual/collision difference is 0.0000104 m; 62 prior interior support misalignments remain corrected. All 125,751 original source-terrain samples are identical except the 59 explicitly permitted monument points. The accepted-interior visual comparison excludes the former boundary's outer 5 m and the monument footprint plus a 5 m margin, where neighboring-source context and the local monument correction legitimately affect ground. The wall repair adds no new comparison exclusion.

Twelve full-width flags outside a shared surveyed carriageway remain explicitly recorded: 11 where OSM Kirkkokatu way `75509961` overlaps the existing Cathedral stair edge near `[-63.349,-138.057]`, and one where Unioninkatu way `149118540` overlaps sidewalk `472003` near `[-74.207,-6.007]`. The affected ground payloads are unchanged by this repair. These graph-to-survey differences require separate disposition; the static PASS does not assert that every nominal lane edge is drivable.

Seven zero-width Rapier ray edge misses are retained as raw diagnostics, not silently discarded: independent HCOL triangle interpolation matches the visible surface; rays 1 mm on both sides align; a centered 1 cm sphere cast also hits the correct ground. `support-edges.json` and the report's `rayEdgeProofs` record the evidence. All other unexplained mismatches still fail. Static downward tests do not prove keyboard driving, visual facade quality, horizontal wall closure or streaming budgets.

The first `world-v1` and `world-v1-above-visual` reports are **superseded diagnostics**: they found the defects that motivated the repair, including 78 lane mismatches up to 0.492 m. `world-v2-first` precedes the independent ray-edge diagnosis; `world-v2` proves the first ground correction, and `world-v3` repeats those earlier checks against the facade-repaired cells. They did not check lane-width continuity and cannot prove the final driving repair. The strengthened `world-v3-wheel-audit` correctly fails with 69 abrupt carriageway steps, up to 2.182 m. `world-v4-initial` verifies the repaired ground with the earlier road graph; `world-v4` binds it to the corrected graph. `ground-v4-world-tests.log` records 77 passing world-tool tests, including a regression that reproduces a metre-high misplaced-wall cut and proves the full wheel track remains supported after reconciliation. Both world/verify TypeScript checks also pass. Final derived tiers and browser driving require their own newly published candidate's evidence.

Useful reference positions come from persistent OSM ways, not guessed labels:

| Place | OSM way | Reference runtime X,Z | Checked nearby road X,Y,Z |
| --- | --- | --- | --- |
| Kluuvikatu | `19746151` | `-266.737,87.982` | `-267.845,-5.234,64.966` |
| Rautatientori | `4247505` | `-533.483,-228.637` | `-532.048,-5.455,-228.710` |
| Station frontage / Kaivokatu | `29690379` | `-602.246,-109.993` | `-603.007,-3.482,-110.048` |
| Teatteriesplanadi | `1530595566` | `-416.150,236.000` | `-417.626,-2.075,203.002` |
| Kappeliesplanadi | `1530595568` | `-116.764,223.163` | `-133.839,-3.010,236.934` |

Use the runtime's supported placement/nearest-lane validation for drop-ins; a place's centroid can lie inside a building or planted area. The actual railway station node is inside the building and is not a spawn point.

## Accepted runtime and local activation

The completed release is active on the ordinary default URL at port 5317. Both
`apps/game/public/world/current.json` and `apps/game/dist/world/current.json`
select `senate-20261017-185c7a1b`. Final checks, opened captures, hashes, activation
and limitations are indexed in `data/evidence/expansion-20261017/completion.json`.

Concurrent vehicle work changed shared application sources during review. The
accepted expansion runtime therefore builds from the exact isolated snapshot
`data/work/expansion-20261017/frozen-candidate`. Do not overwrite the concurrent
shared changes or assume a build from them reproduces this acceptance. Its
244-file inventory is `data/evidence/expansion-20261017/source-snapshot-frozen-final.json`.
From that frozen directory, the following reproduce the accepted bundles without
copying the large public directory or modifying the live server:

```powershell
node node_modules/vite/bin/vite.js build --config apps/game/vite.config.ts --outDir ../../ordinary-build-final
node node_modules/vite/bin/vite.js build --config apps/game/vite.config.ts --mode review --outDir ../../review-build-final
```

The final browser acceptance explicitly uses `HELSINKI_VERIFY_ANGLE=vulkan` on
Chromium 153 / RTX 3070 Ti after diagnosing Windows D3D11 VSync stalls. This is
a verification-browser option, not a shipped game setting. See the benchmark
for traces, the failed attempts, the corrected test driver and final traversal.

The ordinary bundle is `index-CaCVE3GV.js` (SHA-256
`a0e111ce638d1d694223474fc26106dd6c2c96311764cb466c8d047056b4051f`);
review is `index-cgsoDyHf.js` (SHA-256
`0b7cb3f689564afe6c62e802fa2de1df9c6aec91d809729848289f5ade64266c`).
The ordinary page cannot enable review controls through a query parameter.
Previous content is retained for rollback. The pre-activation archive contains
the served review build and old pointers, not the older accepted ordinary binary.
