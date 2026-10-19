# Mannerheimintie and Uspenski expansion

This is the preserved 18 October base recipe and acceptance record. The active
19 October western append is documented in the
[continuation record](city-continuation-2026-10-19.md) and
[current handoff](handoff-2026-10-19.md). The status and counts below describe
the historical base, not the current 276-cell release.

**Status: LIVE_LOCAL_PREVIEW.** The new area covers 3.01 square
kilometres in 237 streamed cells. The active local pack is
`senate-20261018-7fc03703`, manifest SHA-256
`954782564d93cc59a6919c9e598cd77f3813b2b9860d766fe389b0df5d5b089d`.
Its final world, vertical-closure, physical-clearance and GLB gates pass.
All seven fresh affected native jobs pass after the source-backed bank
visual/HCOL closure. The predecessor a706b755 completed all eight native jobs,
but its complete journeys retain that historical identity. Both local pointers
now select 7fc03703; owned preview restart and HTTP identity checks pass on port
5317. Ordinary-build smoke passes all eight checks, and root opened all four
production images. [Final local integration](../data/evidence/district-expansion-20261018/integration-bank-v1.json)
is `PASS_LOCAL_ACTIVE_ORDINARY`; use `http://127.0.0.1:5317/`. Earlier packs,
including f8293760, d68943b0 and 60cc8377, are diagnostic artifacts.

The original ground-authoring build uses the historical frozen inventory
[runtime-source-final-v4.json](../data/evidence/district-expansion-20261018/runtime-source-final-v4.json),
SHA-256 `5aa51d01485872b7ce4483a7d432885b918f9e89432cc376042ca1a7b3941d69`.
That filename is distinct from the selected
[runtime-v6 inventory](../data/evidence/district-expansion-20261018/runtime-source-v6.json),
whose inventory fingerprint is
`593e49cdd532be3f35343e37ed1d2759def8b3619eb9cc9a0fbe71cbfba589cd`.
Its [code checks](../data/evidence/district-expansion-20261018/frozen-checks-v6.json)
pass five TypeScript projects and 365 tests, zero skipped. The
[built bundle receipt](../data/evidence/district-expansion-20261018/runtime-build-v6.json)
and [independent revalidation](../data/evidence/district-expansion-20261018/runtime-build-v6-revalidation.json)
pin review `/assets/index-CggY-Yvi.js` to
`8ee16a7706240a82a766f85051a148cb5d46a3464d5011f598d2da346a9d33ce`
and production `/assets/index-RJvTkfS8.js` to
`d05d80c892ff4e92e10e9265ae84256ce42e213c3148d46db619521509358db5`.
The [namespaced review stage](../data/evidence/district-expansion-20261018/stage-runtime-v6-namespaced.json)
serves `http://127.0.0.1:5317/district-review-v6.html`; its separate asset
path preserves source maps without replacing the ordinary entry or pointers.

Runtime-v6 retains low-preset coarse-cell batching, verifier bend preview and
the optional per-car pose path. It adds exactly two audited renderer edits and
their two required static pose-JSON imports to runtime-v5. Existing Lumi/patrol
defaults and all eight shipped asset definitions/payloads remain unchanged.
New Kaamos/Revontuli GLBs/contracts and parallel central-expansion gameplay are
not shipped. The [compatibility audit](../data/evidence/district-expansion-20261018/runtime-v6-vehicle-compatibility-audit-v1.json)
records that boundary. Historical runtime checks do not certify v6, and code
checks do not establish native GPU/journey acceptance.

The selected final world producers have a separate
[source/check lock](../data/evidence/district-expansion-20261018/bank-producer-lock-v1.json):
225 files in `bank-producer-v1`, at inventory fingerprint
`88b92161bfbc4cf8f9e7c1674ff83a26095926b3052d23d59aacbe16a5a2d1f5`.
All 104 producer tests and both world/verify TypeScript projects pass in the
[final checks](../data/evidence/district-expansion-20261018/bank-producer-final-checks-v1.json).
It extends the historical 222-file
[street producer archive](../data/evidence/district-expansion-20261018/street-producer-lock-v1.json),
inventory `e64f54d470482155e8a2c3bc0a5e83213dd044d0561be6304f2502e4568bc14d`,
whose 96 tests and two TypeScript checks passed. The bank archive retains the
paving/tram producers and binds the same runtime-v6 inputs. Older locks remain
historical evidence, rather than substitutes for this final producer selection.

The area is X `[-1350,800]`, Z `[-950,450]`, or 3.01 square kilometres, using the
existing origin, EPSG:3879/N2000 and 128 m cells. It includes Mannerheimintie,
Lasipalatsi, Parliament, the Music Centre, Finlandia Hall and the Uspenski
Cathedral neighbourhood. The removed 2017 mesh is not an input.

## Selected inputs and outputs

All paths in this table are beneath `data/work/district-expansion-20261018/`
unless another root is given. These outputs are immutable.

| Artifact | Selected path | SHA-256 |
| --- | --- | --- |
| Runtime road graph | `roads-v8/roads.json` | `25ec73e7bf1e063f89f35cdcca427c53be4ce830575c3624c3debcc9017f1c51` |
| Ground-authoring road graph, still pinned | `roads-v6/roads.json` | `f47fbc0ab5974fc41377ba47bf0ee363287baee550bb71222216a0e07b5b798d` |
| Gameplay | `gameplay-v6/gameplay.json` | `673ddd21330afb28bf054c16b8397e164679169e8051bf7f06f204369e14e952` |
| Ground index | `cells-ground-v3/cells.json` | `9867771a4d4b1e9e3f643cd40a83d0b5a50853a6793c9a450e37b2bb1f56f26e` |
| Tree-adjusted index, before LODs | Recorded by the tree execution handoff | `8bafd5101aad5526172167899875011bf58e6d9e0d6432cfcd83507deb96e363` |
| Tree/LOD material-repair base | `cells-trees-final-v1/cells.json` | `3f97fb0da5e498a5be0081257a265aa3e9dfea109cb3417f4edee9450ea865c6` |
| Finlandia material-repair base | `cells-facades-v2/cells.json` | `c1cb6c103b7a54b2327f8793186991ff86b561c137bb2c5716cb6c4be7ef9a5d` |
| Initial coast/dry closures | `cells-closed-v2/cells.json` | `7bd2a345626ee2d56c2f1d79159a9b0fc54d31c4f77bc1d9c337848d78d490e0` |
| Floor-interface closures | `cells-closed-v3/cells.json` | `42c858fd0e83c21c2c63a952b595ddc39f71b258e46151dee4def459c34c12e1` |
| Final residual coast closures | `cells-closed-v4/cells.json` | `579e5d5c748a479858a785d5dff539e085787b9eb53f876f2c5b3f4f8a86d319` |
| Source-face chart index | `cells-charts-v3/cells.json` | `610300aa9966fc60ee412e9777ac6579fb7c742698992bfa74ab00c2f20b5fbb` |
| Reference-guided paving index | `cells-streets-v1/cells.json` | `5508b1714df10e604b686ef73369e1ae585544bc61fefef5d70ef6d344f10de8` |
| Visual tram index | `cells-trams-v1/cells.json` | `0c800253d6a2edf8a29e72d03f025bbf7ed08a75b610ad89ff910cb0956e2c90` |
| Selected final bank/cell index | `cells-abutments-v1/cells.json` | `f3d37e78be20236d6ab970e8d08052ac90fd0f2e3e1491799cfd320f64a8198b` |
| Support terrain, unchanged through the later phases | `cells-abutments-v1/runtime-terrain.bin` | `d67c6811b161fddf947a95f8d26892e4d1ca004ef6f321f03a324251e1bb2b94` |
| Cell configuration | `content/helsinki/district-expansion/cells.json` at repository root | `1da393e80f84c5cd75d57e62cd35da7fba33064afdf14beaa71b507df4f70cb9` |
| Final driving goals | `content/helsinki/district-expansion/drive-plan.json` at repository root | `ca06433d434d740eb1255b630d36b4a9a04106091f1a824f28f049819be21f75` |

The frozen raw root is `data/raw/district-expansion-20261018`. The acquisition
[report](../data/evidence/district-expansion-20261018/acquisition/report.json) and
[README](../data/evidence/district-expansion-20261018/acquisition/README.md) bind
2,494 city tile payloads: 396 building, 1,260 terrain, 276 street-tree and 562
plot-tree tiles. They also bind 1,182 building-register features, 9,708 street
parts and the complete OSM union. Shared city payloads and prior road nodes,
ways and turn restrictions remain exact; three cycling-relation member lists
changed.

The merged model preserves the accepted 418 buildings, 903 texture indices and
7,672,752-byte binary prefix. It adds 820 buildings and 1,193 texture pages. The
terrain has 2,151 by 1,401 one-metre samples; monument preparation changes the
same 59 samples as before. `cells-final` is the frozen detailed-art input:
Alexander is placed in Senate Square, Parliament uses
`parliament-v6-depth/parliament-facade.glb`, and Finlandia has source-bound
restorations on pages 1006, 1008, 1011, 1013 and 1016. The ground rebuild preserves
these building meshes, materials, textures and non-ground collision arrays.
Facade reference use follows [the cleanup protocol](facade-cleanup-protocol.md);
reference photos establish appearance, and no Google image pixels are shipped.

## Source and geometry decisions

- Water removal uses exact surveyed bridge/deck footprints and closed OSM pier
  polygons. It does not create guessed dry land. Katajanokanlaituri bridge
  `24336451` is the explicit drivable bridge; unsupported separate-level and
  ferry-boarding approaches remain source-bound exclusions. Floating Allas sauna
  structures are independently identified by `water-structures.json`.
- Two-way `lanes=1`, unlaned service roads and unlaned living streets retain both
  travel directions on one physical corridor. Supported OSM placement tags
  constrain lane positions; ambiguous tags retain prior geometry with explicit
  diagnostics. Reviewed registrations fit actual surveyed pavement and preserve
  rock, walls, buildings, stairs and legal source tags.
- The raw-deck field is immutable inside source masks `47166`, `481789` and
  `481790`, with an 8 m ordinary-road tie-in. The only additional surface-grade
  corridor is 42.1003 square metres of asphalt in source part `58384` beside
  service `34918441:1`. Ankkurikatu and the park driveway need no extra grade.
- Northern Meritullinkatu is a planted pedestrian throat too narrow for the
  accepted car. Vehicle routing stops at existing node `8879808377`; all southern
  motor driveways remain connected. This is a project-car feasibility limit,
  not a real-world legal closure. Official 2025 orthophoto and the actually opened
  October 2020 Street View panorama `OvR1YLp3Vd7A2vQHsx5VPA` corroborate the
  geometry. Raw pedestrian ways, planting and source artwork remain unchanged.
- Public roads and every retained new-area service road must support the actual
  0.967 m tyre half-width and pass the unchanged 0.35 m continuity threshold,
  regardless of shared survey IDs or missing private-access tags. Historical
  accepted-area conflicts remain visible in the complete reports.
- The unsupported underground-parking entrance chain around portal `317360902`
  and tunnel `51707747` is excluded from runtime routing. Four unnamed,
  unclassified approaches (`28584320`, `216650212`, `317360908`, `317360906`)
  had survived the earlier service-only propagation. They led to a fabricated
  reversing turn against real retaining wall `304050566`. Source artwork,
  named streets and turn restriction `57339` remain unchanged.
- Runtime roads-v8 also suppresses 30 synthetic U-turn connectors at graph cuts
  where the complete source still has an omitted continuation. Real source
  driveway ends retain their existing policy. Against v6, the combined topology
  correction removes ten lanes, 45 connectors and four internal nodes; every
  retained lane, node and connector value stays exact. Ground authoring and its
  corridor/cache pins deliberately remain on v6.

The exact source IDs, registrations and physical-clearance exceptions are bound
by [decision 0019](decisions/0019-mannerheimintie-uspenski-expansion.md),
[the final road handoff](../data/evidence/district-expansion-20261018/road-layout-v8/handoff.json)
and the selected configuration. Source/hash changes require fresh diagnosis;
these declarations are not generic permission to flatten source geometry.

The final drive plan has eleven directed goals and a planned 7,577.04 m loop.
Goal index 9 now uses the actual supported city-bank lane at
`[276.351,160.667]`, radius 3 m, after the westbound `24336451` crossing.
The old Kanavakatu checkpoint depended on an invented U-turn at an excluded
bridge cut. All other goals and the required source bridge remain unchanged.
The [source lock](../data/evidence/district-expansion-20261018/road-layout-v8/source-lock.json)
and [route plan](../data/evidence/district-expansion-20261018/road-layout-v8/route-plan.json)
bind this correction; directed reachability is not a completed driving journey.

## Final facade correction and bounded base review

The native south view exposed two retained foliage remnants in Finlandia chart
`1016-18`. Only their protected-column tops changed from runtime Y 2.2 m to
1.7 m, at along-wall intervals `[1017,1019.6]` and `[1024.3,1027.1]`.
The exposed bands use the existing licensed page 1013/chart `1013-0` granite
donor. Hidden lower entrance pixels and the central upper bank remain exact;
no door, glass layout or geometry is invented. An
[exact HCOL support-envelope proof](../data/evidence/district-expansion-20261018/finlandia-ground-margin-exact-v2.json)
establishes minimum burial of 0.10011 m and 0.39368 m.

The fresh-copy `cells-facades-v2` repair changes exactly 904 native source
texels, all inside those bands; alpha and every other source texel are exact.
Only one embedded detailed facade atlas changes. All 720 copied payloads were
compared: the one affected detailed GLB differs by -316 bytes, while collision,
terrain, scenery, 238 existing LOD descriptors/payloads and all other payloads stay
exact. Its 36 decoded accessors, compressed geometry, UVs, non-image semantics,
materials and eight other embedded images are exact. Historical accepted LOD1
tiers can contain imagery; the affected Finlandia LOD2 is textureless. See the
[repair lock](../data/evidence/district-expansion-20261018/finlandia-material-repair-lock-v2.json),
[source-pixel receipt](../data/evidence/district-expansion-20261018/finlandia-base-v2-pixels/receipt.json)
and [reproduction recipe](../data/evidence/district-expansion-20261018/finlandia-material-repair-recipe-v2.json).

Both final compressed native south images were opened:
[pedestrian framing](../data/evidence/district-expansion-20261018/finlandia-south-final-v1/finlandia-congress-south-yaw3.142-pitch0.06.png)
and [higher framing](../data/evidence/district-expansion-20261018/finlandia-south-final-v1/finlandia-congress-south-yaw3.142-pitch0.30.png).
The exposed green base strip is gone in both. Their
[capture receipt](../data/evidence/district-expansion-20261018/finlandia-south-final-v1/views.json)
binds historical manifest
`8a8fc57f742c968e5ae7f2e90084686624606f39a6450ad57830f1be52f92556`
and the runtime-v3 review bundle
`f15e07603b00b808aba2ecb7670bc2e1d45a72e6413d2f8a2e0b672181c4aacd`.
This is reviewed facade evidence, not runtime-v6 acceptance.

The pictured Uspenski base was checked separately. Nine solid pictured faces
have coincident decoded visual/HCOL intersections; 369 bounded view rays lose
no baseline support, and all 231 vertical probes retain ground. Registered
natural-stone stair `48746` and immediate wall planes match their prior profiles
within 0.002 m. Adjacent road/grass grades did change, so whole-base identity is
not claimed. None of the 20 foundation declarations covers Uspenski. The
[bounded diagnosis](../data/evidence/district-expansion-20261018/uspenski-visible-base-diagnosis-v1.json)
found no introduced hole in those sampled solid faces. It did not cover the
later fixture-007 lateral curb/base opening: that real opening required the
dry-interface closure below. These probes do not establish that the compact
terrain-derived stair is a faithful architectural reconstruction.

## Reproduction recipe

Run from the repository root. Ground authoring uses the original frozen tools
and their frozen configuration; topology v8 uses the separately bound v3 world
tools. Later closure/chart/paving/tram/bank stages use `bank-producer-v1`; the Finlandia
material recipe has its own independent source lock. Use fresh
replay/evidence directories; never overwrite the
selected outputs or edit staged hardlinked payloads. Rebuilt source inputs must
match their recorded hashes before being substituted into later stages.

Upstream source preparation remains reproducible from its ledgers:

```powershell
$raw = 'data/raw/district-expansion-20261018'
$old = 'data/work/expansion-20261017'
$work = 'data/work/district-expansion-20261018'
$frozen = "$work/runtime"
$topology = "$work/runtime-v3"
$cfg = 'content/helsinki/district-expansion'
$authoringCfg = "$frozen/content/helsinki/district-expansion"
$origin = 'content/helsinki/world-origin.json'
$replay = 'data/work/district-expansion-REPLAY'
$evidence = 'data/evidence/district-expansion-REPLAY'
node "$frozen/tools/world/convert_city_model.ts" --ledger "$raw/lod2/ledger.json" --snapshot district-expansion --origin $origin --out "$replay/citymodel-expanded"
node "$frozen/tools/world/merge_city_model.ts" --base "$old/citymodel" --expanded "$replay/citymodel-expanded" --out "$replay/citymodel"
node "$frozen/tools/world/build_terrain.ts" --tiles "$raw/terrain/district-expansion" --ledger "$raw/terrain/ledger.json" --origin $origin --config "$cfg/cells.json" --resolution 1 --out "$replay/terrain"
node "$frozen/tools/world/prepare_monument_ground.ts" --terrain "$replay/terrain" --placement "$old/alexander/v3/placement.json" --out "$replay/terrain-monument"
node "$frozen/tools/world/build_roads.ts" --osm-ledger "$raw/osm/ledger.json" --snapshot district-expansion --origin $origin --config "$authoringCfg/roads.json" --terrain "$work/terrain-monument/terrain.bin" --street-parts "$raw/street-parts/district-expansion.geojson" --out "$replay/roads-authoring-v6"
node "$frozen/tools/world/build_trees.ts" --ledgers "$raw/trees/street/ledger.json,$raw/trees/plot/ledger.json" --snapshot district-expansion --terrain "$work/terrain-monument" --roads "$work/roads-v6/roads.json" --footprints "$raw/building-register/district-expansion.geojson" --models "$old/trees-models/blender-report.json" --config "$cfg/cells.json" --origin $origin --preserve-trees "$old/trees-v2/trees.json" --out "$replay/trees"
node "$frozen/tools/world/build_gameplay.ts" --content "$authoringCfg/gameplay.json" --origin $origin --register "$raw/building-register/district-expansion.geojson" --roads "$work/roads-v6/roads.json" --terrain "$work/terrain-monument/terrain.bin" --out "$replay/gameplay"
```

The selected ground pass starts from the already frozen `cells-final` art base,
not a stale coarse tier. Its fresh output was `cells-ground-v3`:

```powershell
node --max-old-space-size=6144 "$frozen/tools/world/rebuild_ground.ts" --base "$work/cells-final" --terrain "$work/terrain-monument" --footprints "$raw/building-register/district-expansion.geojson" --street-parts "$raw/street-parts/district-expansion.geojson" --osm-ledger "$raw/osm/ledger.json" --osm-snapshot district-expansion --config "$cfg/cells.json" --origin $origin --foundation-repairs "$cfg/foundation-repairs.json" --ground-cache "$replay/pre-coast-ground-cache" --coastal-diagnostics "$evidence/coastal-retries" --out "$replay/cells-ground"
```

The cache fingerprints all authored source/config/tool inputs and verifies the
serialized payload hash. Exact coastal booleans run first; only recognized numeric
failures receive one 0.1 micrometre lattice retry with original-input diagnostics.
The completed pass recovered one such failure, preserving the dry triangle's
original XYZ/UV arrays. See
[ground export integrity](../data/evidence/district-expansion-20261018/ground-v3-result.json)
and [actual precision replay](../data/evidence/district-expansion-20261018/coastal-precision-v3-replay.json).

Run the 21 world checks before tree processing. For a replay, use the fresh
`$replay/cells-ground`; for the selected run this was `$work/cells-ground-v3`:

```powershell
$ground = "$replay/cells-ground"
node --max-old-space-size=6144 "$frozen/tools/verify/verify-expansion-world.ts" --cells $ground --terrain "$work/terrain-monument" --roads "$work/roads-v6/roads.json" --gameplay "$work/gameplay-v6/gameplay.json" --assets "$work/assets" --baseline apps/game/public/world/senate-20261017-185c7a1b --base-terrain "$old/terrain-monument/terrain.bin" --exact-terrain-overlap --osm "$raw/osm/district-expansion.json" --street-parts "$raw/street-parts/district-expansion.geojson" --landmark-plan "$cfg/landmark-plan.json" --coastal-water --supported-bridge-ways 24336451 --water-structures "$cfg/water-structures.json" --out "$evidence/world-ground"
node --max-old-space-size=768 "$work/verify-foundation-closure.mjs" --cells $ground --out "$evidence/foundations.json"
```

Tree authority must be derived from that exact final ground index; an earlier
prospective authority cannot be reused. The completed fresh-copy execution wrote
`cells-trees-final-v1`:

```powershell
$groundIndexSha = (Get-FileHash -LiteralPath "$ground/cells.json" -Algorithm SHA256).Hash.ToLowerInvariant()
$treeTools = 'data/evidence/district-expansion-20261018'
node "$treeTools/check-tree-ground.mjs" --after $ground --out "$evidence/tree-ground.json"
node "$treeTools/audit-tree-intended-sink.mjs" "$evidence/tree-ground.json" "$evidence/tree-soil.json"
node "$treeTools/make-tree-soil-authority.mjs" --audit "$evidence/tree-ground.json" --soil-audit "$evidence/tree-soil.json" --cases "$cfg/tree-soil-cases-v1.json" --out "$evidence/tree-authority.json"
node "$treeTools/run-tree-soil-preflight.mjs" --authority "$evidence/tree-authority.json" --candidate $ground --candidate-index-sha256 $groundIndexSha --out "$replay/cells-trees" --report "$evidence/tree-preflight.json"
node "$frozen/tools/world/reseat_trees.ts" --authority "$evidence/tree-authority.json" --candidate $ground --candidate-index-sha256 $groundIndexSha --out "$replay/cells-trees"
```

The independent preservation audit is candidate-bound:
`verify-final-tree-preservation.mjs` pins the selected paths, counts and fresh
output internally. Its completed result is linked below. A different replay
requires a separately rebound audit, rather than unsupported command-line flags.

Repeat the same complete world command with `--cells "$replay/cells-trees"` and a
fresh evidence directory, then run physical poses after the tree changes:

```powershell
node --max-old-space-size=384 "$work/replay-road-vehicle-poses.mjs" "$work/roads-v6/roads.json" "$replay/cells-trees" "$evidence/road-physical"
node "$frozen/tools/world/build_low_monument_cell.mjs" --cells "$replay/cells-trees" --monument "$old/alexander/v3/alexander-monument.glb"
node "$frozen/tools/world/build_distant_cells.mjs" --cells "$replay/cells-trees"
```

Build the runtime topology separately, without repinning or regenerating the
v6-authored ground corridor. The v3 frozen road builder hash matches the v8
source lock; its application/runtime is still historical evidence:

```powershell
node --max-old-space-size=384 "$topology/tools/world/build_roads.ts" --osm-ledger "$raw/osm/ledger.json" --snapshot district-expansion --origin $origin --config "$topology/content/helsinki/district-expansion/roads.json" --terrain "$work/terrain-monument/terrain.bin" --street-parts "$raw/street-parts/district-expansion.geojson" --out "$replay/roads-runtime-v8"
```

Apply the independently locked material recipe after tree seating and LOD
derivation. Its receipt gives the exact fresh-copy `repair_facades.ts --pages
1016` invocation and the bounded descriptor-preservation finalizer. That
finalizer pins the selected paths; a different replay needs a separately rebound
audit, not unsupported flags. It restores unchanged tier descriptors after
verifying all tier bytes, rather than regenerating their artwork. The completed
selected output is `$work/cells-facades-v2`.

## Required vertical ground closure

Opened captures exposed actual openings that downward support checks did not
cover. Water clipping left banks without vertical shore faces; grade offsets
separated preserved curb/wall bottoms from adjacent floors. Later Music Centre
review found partial, collinear floor-edge overlaps with different millimetre
height profiles. A downward ray can hit a supported floor while a lateral view
sees sky through its boundary. The
[canal diagnosis](../data/evidence/district-expansion-20261018/canal-bank-source-v2.json),
[dry-interface audit](../data/evidence/district-expansion-20261018/ground-interface-seals-citywide-v3.json)
and [Music Centre rays](../data/evidence/district-expansion-20261018/music-parliament-art-diagnosis-v1.json)
bind the separate causes.

These are append-only vertical closures. Qualifiers bind actual visual and HCOL
triangles, source water/decks and protected areas, subtract existing coverage,
and reject ambiguous interfaces. The appender retains old GLB BIN and decoded
attribute/index prefixes, collider item count/order and all existing floor
heights. New faces extend existing ground primitives, HCOL ground items and
LOD2. No horizontal floor or guessed land is introduced. Section polygons mean
outer domain minus the union of holes; an external hole cannot create faces
outside that domain. Vertical station decomposition gives every nondegenerate
Float32 triangle a same-XZ vertex pair and exactly zero normal Y. The earlier
closed-v1 earcut sliver output was rejected and is not selected.

The selected immutable sequence is:

| Phase | Bound authority | Completed result |
| --- | --- | --- |
| Initial coast/dry, `cells-facades-v2` to `cells-closed-v2` | [Coast v3](../data/evidence/district-expansion-20261018/coastal-shore-preflight-v3.json): 4,616 quads/57 cells; [dry v2](../data/evidence/district-expansion-20261018/ground-interface-seals-plan-v2.json): 45,580 polygons, 88,215 exact visual source bindings. | 200,306 vertical triangles; [12 actual compressed lateral rays pass](../data/evidence/district-expansion-20261018/final-ground-closure-rays-v2.json). |
| Floor joins, `cells-closed-v2` to `cells-closed-v3` | [Floor v3](../data/evidence/district-expansion-20261018/floor-interface-plan-v3.json), SHA-256 `f310b30bc57baf2494eb0fb0a8b8c933ece1677584870cbe9e0ff149e0e8321c`: 13,340 sections/122 cells, 7,870 exact visual bindings. | 49,596 triangles; 526 sections collapse safely to zero. [Actual-output proof](../data/evidence/district-expansion-20261018/floor-interface-output-positive-v3.json) verifies prefixes and all 37 Music Centre sky rays now hit compressed LOD0, LOD2 and HCOL. |
| Residual shores, `cells-closed-v3` to `cells-closed-v4` | [Coast v4](../data/evidence/district-expansion-20261018/coastal-shore-plan-v4.json), SHA-256 `050694720a19faa70aa37812807500b8df55b8374fdfef9cc5eb67e64d404cfb`: 39 quads/11 cells. | 142 triangles. [Actual-output proof](../data/evidence/district-expansion-20261018/coastal-actual-output-closed-v4.json) verifies all 228 recorded sky pixels, the three primary concerns and five legacy coast rays against actual compressed faces; 226 other cells remain exact. |

The residual shore correction clips source edge endpoints at actual decoded
triangle boundaries. It closes the remaining canal triangle without moving
bank tops or sealing real bridge spans. Floor and shore qualification have
independent source/overlap audits; their producer locks are
[floor v3](../data/evidence/district-expansion-20261018/floor-interface-producer-lock-v3.json)
and [shore v4](../data/evidence/district-expansion-20261018/coastal-shore-producer-lock-v4.json).
The selected common sealer SHA-256 is
`98f6a98b7c59113674d86e44844629d871ba0a8f8c2254b3d6fba26ea4b98c85`.
Its authority validation includes the source index/report, per-cell receipts,
visual/HCOL bindings, helper dependencies and all declared input hashes.

After **every fresh cell or grade build**, regenerate the authorities from the
actual phase output. Use the separately locked producer snapshot, fresh plans
and fresh output directories. This full rebuild sequence is generic; it is not
a promise of byte identity with the historical multi-stage selection. In this
example `cells-materials` is the fresh Finlandia-repaired build with derived
LOD2, corresponding to selected `cells-facades-v2`:

```powershell
$producers = "$work/bank-producer-v1"
node --expose-gc --max-old-space-size=480 "$producers/tools/world/plan_coastal_shores.ts" --cells "$replay/cells-materials" --config "$cfg/cells.json" --origin $origin --osm "$raw/osm/district-expansion.json" --street-parts "$raw/street-parts/district-expansion.geojson" --out "$evidence/coastal-shores.json"
node --expose-gc --max-old-space-size=480 "$producers/tools/world/plan_ground_interfaces.ts" --cells "$replay/cells-materials" --config "$cfg/cells.json" --origin $origin --street-parts "$raw/street-parts/district-expansion.geojson" --out "$evidence/ground-interfaces.json"
node --expose-gc --max-old-space-size=1536 "$producers/tools/world/seal_ground_interfaces.ts" --cells "$replay/cells-materials" --coast "$evidence/coastal-shores.json" --interfaces "$evidence/ground-interfaces.json" --out "$replay/cells-closed"
node --expose-gc --max-old-space-size=480 "$producers/tools/world/plan_floor_interfaces.ts" --cells "$replay/cells-closed" --config "$cfg/cells.json" --origin $origin --osm "$raw/osm/district-expansion.json" --street-parts "$raw/street-parts/district-expansion.geojson" --out "$evidence/floor-interfaces.json"
node --expose-gc --max-old-space-size=1536 "$producers/tools/world/seal_ground_interfaces.ts" --cells "$replay/cells-closed" --floors "$evidence/floor-interfaces.json" --out "$replay/cells-floors"
node --expose-gc --max-old-space-size=480 "$producers/tools/world/plan_coastal_shores.ts" --cells "$replay/cells-floors" --config "$cfg/cells.json" --origin $origin --osm "$raw/osm/district-expansion.json" --street-parts "$raw/street-parts/district-expansion.geojson" --out "$evidence/residual-shores.json"
node --expose-gc --max-old-space-size=1536 "$producers/tools/world/seal_ground_interfaces.ts" --cells "$replay/cells-floors" --coast "$evidence/residual-shores.json" --out "$replay/cells-shores"
```

Review each plan's rejected/ambiguous cases before applying it. Historical plans
are reusable only if every bound source, payload and report hash still matches;
do not repin them merely to bypass a rejection. The initial selected closure's
historical source is separately archived at
`data/work/district-expansion-20261018/ground-closure-producer-v2`.
Its sealer SHA-256 is
`dedf65645a04062f60765503aa8306d6ac8bc3bb9aea57b6f027cdbe75aabc83`.
The later producer snapshot is the authority for new qualification.

Run floor actual-output verification before facade draw partitioning:

```powershell
node --expose-gc --max-old-space-size=480 "$producers/tools/verify/verify-floor-interface-output.ts" --plan "$evidence/floor-interfaces.json" --cells "$replay/cells-floors" --rays "data/evidence/district-expansion-20261018/music-parliament-art-diagnosis-v1.json" --out "$evidence/floor-output.json"
```

Repeat the independent lateral-ray/prefix checks for dry and shore outputs,
then repeat them on the final compressed candidate as applicable. Earlier
source-plane hits or proposed mesh hits do not replace actual-output proof.

## Original charts on selected untextured source facades

The final chart adapter adds original reference-guided art to 34 existing source
triangles: 14 on the Presidential Palace east face, 18 on the Main Guard south
face/recess/southeast chamfer, and two Parliament lower-wing faces (`665/666`).
Each chart requires exact, bijective detailed/distant source-key ownership;
coplanarity alone cannot admit a neighbouring foundation face. It preserves
every source triangle's coordinates and winding, HCOL, terrain, scenery and all
ground/water/closure geometry. Old atlases, untargeted UVs and palette mappings
remain exact. The intentional changes are target draw partitioning, isolated
UV/material ownership and matching distant vertex colours; distant small-window
geometry is not claimed.

The original procedural CC0 atlas is 768 by 256 pixels, SHA-256
`2a8c76c3a1c17ee5ca8d2c75b72671d4c0d47e47178733c9ca0a86fd2ca581a5`.
Reference photos establish layout; their pixels are not shipped. Three owner
cells each add one detailed and one distant draw. Their complete RGBA mip
fallback is exactly 3 MiB; estimated BC7 storage is 786,576 bytes in total.
Actual native residency remains subject to the unchanged runtime caps.

The [hash-only application rebind](../data/evidence/district-expansion-20261018/facade-chart-profile-rebind-v4.json)
pins the approved chart/profile fields to `cells-closed-v4`; its application
profile SHA-256 is
`31661a26a617269bb171669f485dd9cc4890b0411855777ec5e0bd7ab1b8f9ec`.
The completed fresh-copy output is `cells-charts-v3`; its
[proof](../data/work/district-expansion-20261018/cells-charts-v3/facade-chart-proof.json)
binds all 34 detailed/distant faces and preservation. Replay this selected
application into a fresh output with:

```powershell
node "$producers/tools/world/apply_facade_charts.ts" --base "$work/cells-closed-v4" --city-model "$work/citymodel" --profile "$cfg/facade-charts/canalside-v3/application-profile-closed-v4.json" --config "$cfg/cells.json" --out "$replay/cells-charts"
```

A fresh upstream rebuild needs its own reviewed application-profile binding;
retain source selectors, frames and original art while verifying the actual
new tier keys. Never edit hardlinked staged payloads in place.

## Reference-guided stone paving and tram rails

The subsequent user request explicitly authorizes stone paving in the existing
Senate district as well as Mannerheimintie and Esplanadi. It changes appearance,
not physical ground. Paving and rails proceed from `cells-charts-v3` to
`cells-streets-v1` to `cells-trams-v1`; neither stage rebuilds terrain or
reopens the completed vertical interfaces.

The [surface source profile](../content/helsinki/district-expansion/streets-v1/surface-source-profile.json)
binds 14 regions and 383 explicit municipal stone-paving parts. Additional
Aleksanterinkatu, Unioninkatu, Snellmaninkatu, Katariinankatu and Hallituskatu
parts qualify only inside X/Z `[-100,-290,150,210]`. Asphalt, red cycle paving,
slab sidewalks, planting and stairs remain unchanged. Senate Square's 50
Noppakivi panels (`58148`?`58197`) receive fan/arc cube courses; the separate
concrete perimeter walkway `58145` remains unchanged. Opened Street View
references and their provenance are bound in the
[source ledger](../content/helsinki/district-expansion/streets-v1/source-ledger.json).
No Google pixels are shipped.

Original deterministic 256 by 256 CC0 albedos provide approximately 20 by 10 cm
rectangular setts, 10 cm cubes and separate fan courses with 10 cm radial spacing.
Region world bases keep scale and alignment continuous across cell boundaries.
Ordinary cube/setts share one texture/material per owner; only four Senate cells
also own the fan tile. There are at most two added paving draws per cell and
87,408 BC7 mip bytes per tile owner, at most 174,816 per cell. There is no normal
or displacement map. The opened original previews are
[ordinary stone](../data/evidence/district-expansion-20261018/street-surfaces-v4/original-paving-setts.png)
and [10 cm fan courses](../data/evidence/district-expansion-20261018/street-surfaces-v4/original-paving-fan-cobble.png);
final native appearance remains a separate gate.

The [selected v4 authority](../data/evidence/district-expansion-20261018/street-surfaces-plan-v4.json),
SHA-256 `318668c5bb1b403d5a4bb60a74d00dfd7982a6c8a31f52d10b37dab9d605c9d0`,
selects 26,176 floor triangles in 38 cells. Whole source polygons and literal ROI
bounds govern selection. Native Float32 boundary cases qualify only after an
independent half-ULP world-X/Z rounding proof: every outside fragment is proven
inside one actual source-edge capsule, with only a documented 10 nm clipping
allowance. Diagnostic subdivision does not divide the actual floor. Maximum
observed outside distance is 66.799 micrometres, within its 68.249 micrometre
bound. Real crossings, holes and ambiguity remain rejected.

The [coverage summary](../data/evidence/district-expansion-20261018/street-surfaces-v3/coverage-summary.json)
lists all source parts, all 50 fan panels and all 543 retained faces: 542 partial
and one ambiguous. Fan source area is 4,119.511158 square metres; qualified faces
cover 4,118.854551. One eligible fan face retains its existing cobble:
`c_m01_p00_ground_cobble`, triangle `459`, part `58170`, area
0.534761 square metres, centre `[-8.776411,0.092824,1.583099]`. The additional
0.121846 square-metre raw-footprint difference is not claimed as eligible floor.
The exception preserves existing stone rather than forcing uncertain coverage.

An initial application preflight rejected JSON certificate metadata because
numeric negative zero serializes as zero. The fix canonicalizes only that JSON
metadata comparison; binary source-triangle keys remain exact. No failed output
was created. The [signed-zero replay](../data/evidence/district-expansion-20261018/street-surfaces-v4/actual-signed-zero-replay.json)
and [v3/v4 authority equivalence](../data/evidence/district-expansion-20261018/street-surfaces-v4/authority-equivalence.json)
show unchanged targets, geometry, art and coverage. The
[actual paving proof](../data/work/district-expansion-20261018/cells-streets-v1/ground-resurfacing-proof.json)
verifies 38 detailed tiers, the affected accepted LOD1 and 38 textureless distant
tiers. Positions, winding, HCOL, support terrain, scenery, buildings and closure
geometry remain exact; selected floor UV/material partition and distant colour
are intentional changes.

Generate a fresh authority with the same archived producer that will apply it.
Plans bind producer paths as well as hashes; a historical authority cannot be
silently reused from a different archive path. Review coverage and both previews
before application. For a fresh upstream chart index, first obtain a reviewed
source-profile binding to that exact index, preserving source polygons and art:

```powershell
node --expose-gc --max-old-space-size=384 "$producers/tools/world/resurface_ground.ts" --base "$replay/cells-charts" --street-parts "$raw/street-parts/district-expansion.geojson" --origin $origin --plan "$cfg/streets-v1/surface-source-profile.json" --config "$cfg/cells.json" --out-plan "$evidence/paving-plan.json" --preview "$evidence/original-paving.png"
node --expose-gc --max-old-space-size=512 "$producers/tools/world/resurface_ground.ts" --base "$replay/cells-charts" --street-parts "$raw/street-parts/district-expansion.geojson" --origin $origin --plan "$cfg/streets-v1/surface-source-profile.json" --config "$cfg/cells.json" --authority "$evidence/paving-plan.json" --out "$replay/cells-streets"
```


The [tram source profile](../content/helsinki/district-expansion/streets-v1/tram-source-profile.json)
uses 92 actual OSM tram ways, 4,271.545657 m of axes and two mapped mainlines
in 18 cells. One-metre measuring-face gauge follows the operator's definitions;
head/groove/guard widths and the 3 mm visual lift are rendering approximations,
not an as-built steel survey. No invented road-centreline tracks, sleepers,
ballast or physical bumps are introduced. The
[selected authority](../data/evidence/district-expansion-20261018/street-surfaces-v1/tram-final-plan-v1.json),
SHA-256 `c141a724dfcb1161152e9e9e9b7fc711d2c3c3ce12b10f367e286b39b68767f9`,
binds the actual resurfaced floor and its exact reference-ground multiset.

There are 22,451 detailed and 21,497 coarse rail triangles, one extra detailed
draw per owner and no extra coarse batches. The original 44 by 4 CC0 stripe costs
956 RGBA mip bytes per detailed owner. Earlier prospective caps of 16,000/8,000
correctly blocked the measured scope; the approved authoring caps are
25,000/25,000. Native triangle, draw and memory limits remain unchanged.
The explicit 0.001409 square-metre raw missing fringe is bounded by individual
Float32/Boolean proofs, not a widened floor; the authority records that limit.

```powershell
node --expose-gc --max-old-space-size=512 "$producers/tools/world/plan_tram_visuals.ts" --cells "$replay/cells-streets" --reference-cells "$replay/cells-charts" --origin $origin --profile "$cfg/streets-v1/tram-source-profile.json" --detail-triangle-cap 25000 --coarse-triangle-cap 25000 --out "$evidence/tram-plan.json"
node --expose-gc --max-old-space-size=512 "$producers/tools/world/apply_tram_visuals.ts" --cells "$replay/cells-streets" --plan "$evidence/tram-plan.json" --out "$replay/cells-trams"
node --expose-gc --max-old-space-size=512 "$work/verify-tram-output-v2.mjs" --cells "$replay/cells-trams" --plan "$evidence/tram-plan.json" --out "$evidence/tram-output.json"
```

Require a ready authority with no unresolved problems before applying it. The
[actual compressed tram proof](../data/evidence/district-expansion-20261018/street-surfaces-v1/tram-actual-output-v2.json)
verifies all 36 changed LOD0/LOD2 payload suffixes against the approved rail mesh,
old BIN/accessor/image/material prefixes and every HCOL/terrain/scenery byte.
The other 219 cells remain unchanged. Its negative control checks an actual
wrong appended position, rather than stopping at a stale hash.

## Source-bound bridge-bank completion

After all eight a706b755 native jobs passed, closer review of the Kanavakatu east
abutment still found a real sky band. Nine exact camera rays and 1,005 sky pixels
missed the old LOD0, LOD2 and HCOL. Ordinary downward support checks did not cover
that lateral opening. The [camera diagnosis](../data/evidence/district-expansion-20261018/abutment-exact-rays-v1.json)
binds the actual views; the repair does not dismiss the opening as a dark facet.

The [source-bound bank authority](../data/evidence/district-expansion-20261018/bridge-abutments-plan-v2.json),
SHA-256 `f4e3f6eca41d6cd38a28d00b0433ce83312329279ff78450e5c2729b7bbc7431`,
uses canonical shoreline intervals at actual bridge ends, exact source `Silta`
axes/decks and adjacent dry components. It follows existing decoded bank-top
profiles down to water Y -7.5 m, subtracting legacy face coverage and preserving
open spans. Six source intervals, 13.876106 m in total, produce 23 quads/92
triangles in `c_p02_m07`, `c_p02_p00` and `c_p02_p01`. New vertical faces append
to existing ground primitives, matching distant geometry and existing HCOL ground
items. No floor, handle, collider item/order, texture, material, placement, road
or runtime is changed. HCOL bytes intentionally change by the qualified suffix.

The [actual compressed-output proof](../data/evidence/district-expansion-20261018/bridge-abutments-actual-output-v2.json),
SHA-256 `0907105813a6ac08f780c4e160e9cf799ab8d776d84a49004187aeda18840263`,
verifies all 237 collider-ID lists, exact original typed-array/BIN prefixes,
nine changed payloads and all 1,005 old sky pixels hitting front-facing actual
LOD0, LOD2 and HCOL. The final vertical audit now covers 250,136 triangles, all
with exactly zero normal Y. Natural low-preset captures are bound by
[the seven-view receipt](../data/evidence/district-expansion-20261018/bank-views-low-v1/views.json).
The [opened component review](../data/evidence/district-expansion-20261018/opened-bank-images-v1.json)
binds 28 opened images: seven natural views in each preset plus seven forced
LOD2 views in each preset. Root found the targeted opening absent. Capture
receipts remain `CAPTURED_NOT_REVIEWED`; the separate opened-review receipt
records the verdict. Forced LOD2 views establish component appearance, not
streaming or performance. Another [opened native review](../data/evidence/district-expansion-20261018/opened-bank-native-v1.json)
binds nine selected eastern-walk images and all nine eastern-drive images.

After fresh paving/tram output, derive a new bank authority and review source,
coverage, overlap and ray proofs before appending. The generic sealer consumes
these vertical polygon records through `--floors`; that argument adds no
horizontal floor:

```powershell
node --expose-gc --max-old-space-size=512 "$producers/tools/world/plan_bridge_abutments.ts" --cells "$replay/cells-trams" --config "$cfg/cells.json" --origin $origin --osm "$raw/osm/district-expansion.json" --street-parts "$raw/street-parts/district-expansion.geojson" --rays "data/evidence/district-expansion-20261018/abutment-exact-rays-v1.json" --out "$evidence/bridge-abutments.json"
node --expose-gc --max-old-space-size=1536 "$producers/tools/world/seal_ground_interfaces.ts" --cells "$replay/cells-trams" --floors "$evidence/bridge-abutments.json" --out "$replay/cells-abutments"
```

The independent selected-output checker binds the historical authority hash.
Recheck that exact selected output with the following command; a fresh rebuilt
authority needs a separately reviewed checker binding rather than silently
changing that pin:

```powershell
node --expose-gc --max-old-space-size=512 "$work/verify-bridge-abutment-output-v2.mjs" --cells "$work/cells-abutments-v1" --plan "data/evidence/district-expansion-20261018/bridge-abutments-plan-v2.json" --out "$evidence/bank-output.json"
```

Run the complete 21-check world gate against the final bank output and runtime
roads-v8, followed by physical, vertical, preservation and full GLB checks.
Only then publish. The selected final content passed
[all 21 checks](../data/evidence/district-expansion-20261018/world-bank-v1-final/world.json).
The selected publication command uses the immutable final index:

```powershell
node --max-old-space-size=6144 "$producers/tools/world/publish_release.ts" --cells "$work/cells-abutments-v1" --terrain "$work/terrain-monument" --roads "$work/roads-v8" --gameplay "$work/gameplay-v6" --assets "$work/assets" --origin $origin --sources "$cfg/sources.json" --config "$cfg/cells.json" --out "$replay/releases" --status PILOT --keep
```

For an end-to-end replay, substitute its fresh `$replay/cells-abutments` only after
those exact-output gates pass. The publisher validates every GLB and reference.
Stage its emitted release directory with `stage_release.ts --release
<RELEASE_DIRECTORY> --out <FRESH_STAGE_EVIDENCE_JSON>`. Staging verifies public/dist
bytes and changes neither `current.json`. The selected
[stage receipt](../data/evidence/district-expansion-20261018/stage-bank-v1.json)
binds 7fc03703; publication and staging do not establish native acceptance.

## Completed offline evidence

| Gate | Recorded result |
| --- | --- |
| Historical runtime-v3/v4 code | Five TypeScript projects; v3 351/351 and v4 365/365 tests. [V3](../data/evidence/district-expansion-20261018/frozen-checks-v3.json), [v4](../data/evidence/district-expansion-20261018/frozen-checks-v4.json). These do not certify runtime-v6. |
| Selected runtime-v6 code | Five TypeScript projects; 365/365 tests, zero skipped. [Checks](../data/evidence/district-expansion-20261018/frozen-checks-v6.json). Fresh affected native acceptance and actual local ordinary integration pass. |
| Final bank producers | 225 files pinned; 104/104 producer tests and world/verify TypeScript projects pass. [Lock](../data/evidence/district-expansion-20261018/bank-producer-lock-v1.json). Historical street producers: 222 files, 96 tests/two TypeScript checks. |
| Ground export | 237 cells, 474 payloads, 997,091,060 bytes independently hash-verified. |
| Final world geometry | All 21 checks pass on [cells-abutments-v1 plus runtime roads-v8](../data/evidence/district-expansion-20261018/world-bank-v1-final/world.json): zero support holes, alignment mismatches or mandatory surveyed/public/service tyre steps. The earlier [material-only gate](../data/evidence/district-expansion-20261018/world-final-v8/world.json) is historical. |
| Actual vertical closure | 250,136 added triangles, exact maximum normal Y zero; old HCOL vertices/indices and item order retained. [Final audit](../data/evidence/district-expansion-20261018/vertical-ground-bank-v1.json). Lateral compressed-output proofs are linked above. |
| Foundation closure | 20 declarations, 626 samples, including 214 closure probes; zero failures. [Proof](../data/evidence/district-expansion-20261018/foundation-final-v3.json). |
| Physical car clearance | Final candidate: 512 oriented BODY/SKID queries, zero intersections; 2,412 actual tyre probes, zero missing/off-source support. [Proof](../data/evidence/district-expansion-20261018/road-physical-bank-v1/result.json). The v8 handoff verifies retained tested lane/connector geometry. |
| Tree registration | 310 Y corrections, 10 conditional runtime omissions, 4,079 retained trees and 4,029 trunk colliders; zero unresolved cases. [Execution handoff](../data/evidence/district-expansion-20261018/tree-final-execution-handoff-v1.json). |
| Tree preservation | At the tree-reseating phase: all 810 accepted placements/policies, 237 detailed GLBs, 1,476 non-tree collider arrays and 400 other payloads exact. Raw tree points retained; no invented dry soil. [Independent proof](../data/evidence/district-expansion-20261018/tree-preservation-final-v1.json). |
| LOD derivation | At that phase: one low monument variant and 237 textureless distant cells. All 474 detailed/collision references plus scenery, report, support terrain and tree proof remain byte-exact. [Proof](../data/evidence/district-expansion-20261018/lod-preservation-final-v1.json). |
| Finlandia material preservation | 904 source texels and one embedded atlas change; that phase preserves 36 decoded accessors, collision/terrain/scenery, other images and existing tiers. [Lock](../data/evidence/district-expansion-20261018/finlandia-material-repair-lock-v2.json). Later closures/charts have their own preservation proofs. |
| New source-face charts | 34 exact source faces in three cells, detailed/distant bijection; source coordinates/winding, all HCOL and ground geometry preserved. [Actual adapter proof](../data/work/district-expansion-20261018/cells-charts-v3/facade-chart-proof.json). |
| Stone paving | 26,176 existing faces in 38 cells, 383 source parts; all 50 fan panels accounted for, one 0.534761 square-metre old-cobble face retained. [Actual proof](../data/work/district-expansion-20261018/cells-streets-v1/ground-resurfacing-proof.json), [coverage](../data/evidence/district-expansion-20261018/street-surfaces-v3/coverage-summary.json). |
| Visual tram rails | 92 source ways/4.2715 km/18 cells, 1,000 mm gauge. All 36 actual compressed detailed/distant suffixes and source preservation pass. [Actual proof](../data/evidence/district-expansion-20261018/street-surfaces-v1/tram-actual-output-v2.json). |
| Final bridge-bank suffix | Six source intervals/23 quads/92 triangles in three cells; all 1,005 old sky pixels hit actual front-facing LOD0/LOD2/HCOL. Original arrays and collider IDs/order/handles preserved. [Actual proof](../data/evidence/district-expansion-20261018/bridge-abutments-actual-output-v2.json). |
| Historical complete native suite | a706b755/runtime-v6: all eight jobs pass, including full western/eastern walking, eleven-goal drive/replay and both gameplay endings. [Receipt](../data/evidence/district-expansion-20261018/gpu-suite-closure-v5.json). This is not a new 7fc03703 full-route pass. |
| Fresh affected native acceptance | All seven jobs pass on 7fc03703/runtime-v6. East walk: 212 checks/188 waypoints/1,893.877239 m. Six-goal East drive: zero recoveries, 23,198 ticks, own replay `425b872c`, no divergence. Both gameplay endings/replays pass; streaming failures 10/10. [Suite](../data/evidence/district-expansion-20261018/gpu-suite-bank-v1.json), [final scoped disposition](../data/evidence/district-expansion-20261018/scoped-acceptance-bank-v2.json). |
| Opened final bank/native views | 28 bank component images plus 18 native images opened by root; targeted sky opening absent. [Component review](../data/evidence/district-expansion-20261018/opened-bank-images-v1.json), [native review](../data/evidence/district-expansion-20261018/opened-bank-native-v1.json). Forced coarse views are not performance evidence. |
| Local activation and preview | Both pointers select 7fc03703; ordinary index `a14ba681...`, production runtime `d05d80c8...` in `/district-ordinary-v7-assets/`. Restart v2 owns only game PID 37360/5317; Motion Lab 2344/5173 unchanged. [Activation](../data/evidence/district-expansion-20261018/activation-bank-v1.json), [restart](../data/evidence/district-expansion-20261018/preview-restart-bank-v1.json), [HTTP](../data/evidence/district-expansion-20261018/http-bank-v1.json). All eight ordinary checks and four opened production images pass. [Integration](../data/evidence/district-expansion-20261018/integration-bank-v1.json). |
| Ordinary production UI and opened images | 8/8 checks pass on actual ordinary `d05d80c8...`/7fc03703: adapter absent on default and `?review=1`, 16 of 237 detailed cells at startup and 51 distinct details across three UI drop-ins, HUD/credits present, zero errors. All four PNGs opened by root. [Actual smoke](../data/evidence/district-expansion-20261018/ordinary-bank-v1/results.json), [final integration](../data/evidence/district-expansion-20261018/integration-bank-v1.json). |
| Cross-release prior-input replay | Strict FAIL: first difference tick 35,938; compared fields equal through 35,937. [Immutable comparison](../data/evidence/district-expansion-20261018/bank-replay-v1/comparison.json). It is not relabelled or treated as a new native journey. |
| CPU walking preflight | All 465 original waypoints reached continuously over 5,971.67 m; original 1.4 m radii, no teleport/reset or kill-plane crossing. Peak RSS 380.93 MiB. [Receipt](../data/evidence/district-expansion-20261018/walk-plan-cpu-preflight-v1.json). This uses predecessor manifest `12703e1d` and static native-controller equivalence, not browser traversal of the final candidate. |
| Staged release | 7fc03703: 237 cells, eight assets, 724 payloads, 1,240,551,957 bytes; 483 GLBs validated with zero errors. 725 unique files staged by 1,450 hardlinks, zero copies; pointers unchanged. [Publication](../data/evidence/district-expansion-20261018/publish-bank-v1.log), [stage receipt](../data/evidence/district-expansion-20261018/stage-bank-v1.json). |

All 511 parking spaces in 62 areas and 4,623 footways are exact across the
selected road revisions. The runtime graph has 3,178 lanes, 4,325 connectors and
1,577 nodes. All retained geometry and the entire gameplay payload are exact
to v6. Two fixed hero/patrol placements match the accepted release.
The six generated parked-car locations changed during the initial expansion and
are exact across the subsequent selected gameplay builds; they are not claimed
identical to the October 17 release.

## Completed affected native acceptance and local activation

Earlier browser work remains diagnostic. The predecessor real drive reached
Finlandia and returned to Lasipalatsi, then failed at about 401 seconds on the
Stockmann leg against the real underground-ramp retaining wall. The
[failed journey](../data/evidence/district-expansion-20261018/drive-final-v1/journey.json)
records the unchanged zero-recovery requirement; no recovery was used to turn
that failure into a pass. Its graph had retained an unsupported parking-ramp
chain and a synthetic U-turn. The source-bound topology corrections above
remove that cause. The corrected route later passed in the a706 native suite;
static/CPU planning alone did not establish that outcome. The subsequent bank
candidate has its own affected acceptance below.

An initial strict low-preset Parliament fixture exceeded the unchanged
500,000-triangle limit. Low-preset tree instances now compact against the actual
frustum; runtime-v4 additionally partitions eligible coarse static
meshes into 64 m culling batches while retaining every triangle, attribute,
material and transform. Generic verifier bend-preview steering is included in
the same freeze. These changes do not increase residency, texture, draw or
geometry caps.
These changes are retained in runtime-v6. Its a706b755 suite and the seven final
bank visual/resource/affected-journey jobs pass with their separate scopes.

The Finlandia fixture uses an actual-control detour through source footways
around retaining wall `34000600`. The
[fixture diagnosis](../data/evidence/district-expansion-20261018/finlandia-fixture-route-diagnosis-v1.json)
proves the failed diagonal and successful grounded detour; the main walking
plan is unchanged. The final south material captures are reviewed above, but
their original candidate identity is retained alongside the fresh affected
evidence below.

The complete [a706b755 suite](../data/evidence/district-expansion-20261018/gpu-suite-closure-v5.json)
passed all eight jobs on runtime-v6. It remains historical evidence of those
actual continuous routes, not a new-release full western walk or eleven-goal
drive after HCOL changes.

The [strict prior-input comparison](../data/evidence/district-expansion-20261018/bank-replay-v1/comparison.json)
replays all 50,062 original drive commands in separate old/new worlds. It fails:
old final native hash `f8e65e75`, new `6b61aca5`. All compared public numeric
state, dynamic/kinematic bodies and events match through tick 35,937. At 35,938,
car-1 velocities first differ by about 2.116e-6 m/s; the attached player pose
follows. The native rounded hash still matches at that first differing tick.
No post-35,938 equivalence is claimed, and the original recording stays exact.

Read-only in-memory probes found no chassis/skid contact manifold at that step.
Inputs, force/torque and body state match immediately before the raycast-vehicle
controller call; velocities differ immediately after it, before physics stepping.
Reported wheel/ray results match and the nearest added face is 58.4315 m away.
The changed fixed cell body's automatically computed mass changes from
37,420.2734 to 37,364.6328, with changed raw inverse mass and centre of mass.
Those properties are a candidate mediator of the controller difference; private
controller causality or BVH ordering is not proven. No global mass/density edit
is made to recover the old hash. Probe provenance and limits are explicit in the
[planned acceptance receipt](../data/evidence/district-expansion-20261018/scoped-acceptance-bank-v1.json),
SHA-256 `ef7f342d5125654060095c7ce6d23c367c0025bf8b6c4c33718f0ff990686767`.

Fresh affected native acceptance **PASSES** for 7fc03703/runtime-v6. The
[seven-job suite](../data/evidence/district-expansion-20261018/gpu-suite-bank-v1.json),
SHA-256 `40d524b770303d496d959ddff9aa42fe26ca5c0d49216a7088b9c9b2c1a674ba`,
completed at 2026-10-18T20:17:43.322Z. Its exact unchanged eastern walk passes
212 checks and reaches all 188 waypoints over 1,893.877239 m, followed by all
repeated low fixtures. Both browser/resource presets, all standard fixtures,
both gameplay endings and their replays, and all ten streaming failure checks
pass. The six-goal eastern real-control drive uses zero recoveries; its own
23,198-command recording replays to browser/Node hash `425b872c` without a first
divergence. See the [walking result](../data/evidence/district-expansion-20261018/east-walk-low-bank-v1/results.json),
[drive result](../data/evidence/district-expansion-20261018/east-drive-bank-v1/journey.json)
and [own replay](../data/evidence/district-expansion-20261018/east-drive-bank-v1/replay.json).

The separate [final scoped disposition](../data/evidence/district-expansion-20261018/scoped-acceptance-bank-v2.json),
SHA-256 `8a47610fbdf2f758e75669307163deaf870c4574d8abfee5bec977482baf889c`,
is `PASS_AFFECTED_ACCEPTANCE`. It preserves the immutable v1 plan and strict
cross-release FAIL, rather than replacing either record. Root's
[opened native receipt](../data/evidence/district-expansion-20261018/opened-bank-native-v1.json)
binds 18 actual images: nine selected walk images and all nine drive images.
The bank's 28 opened component views remain separately bound. No new full
western continuous journey or eleven-goal city drive is claimed. The unchanged
western geometry and matched compared-state driving prefix support this
considered scope; old full journeys retain a706 identity. The
[bound route plans](../data/work/district-expansion-20261018/bank-affected-plans-v1.json)
record the exact eastern source geometry and explicit western omission.

Local activation, owned preview restart and HTTP identity **PASS**. The
[activation receipt](../data/evidence/district-expansion-20261018/activation-bank-v1.json),
SHA-256 `ef84742acbc84c8dbc5c980a544386892e01f906a418ba07f262bdbead7561b0`,
records both `apps/game/public/world/current.json` and
`apps/game/dist/world/current.json` selecting 7fc03703. The ordinary index is
`a14ba681c0ec30ee18d61154820fb5495ebf8f2770cdd279be1a729420139d59`;
its `/district-ordinary-v7-assets/index-RJvTkfS8.js` module is the separately
bound production runtime
`d05d80c892ff4e92e10e9265ae84256ce42e213c3148d46db619521509358db5`,
not the review-build module. Rollback index/pointers are preserved in
`activation-rollback-bank-v1-runtime-v6`.

The first restart helper's `Stop-Process` call raised a `NullReferenceException`
without stopping original game PID 30308. The
[failed-attempt receipt](../data/evidence/district-expansion-20261018/preview-restart-cmdlet-failure-v1.json)
records unchanged exact process commands, creation times and both port owners.
The replacement [restart helper v2](../data/work/district-expansion-20261018/restart-game-preview-bank-v2.ps1),
SHA-256 `9b5146129f7dfc7a7471251c172e67f74a0a7e82c859f25713ad71a867f756e6`,
retains the activation/path/full-command/creation/port guards and replaces only
the failed cmdlet with native `taskkill` targeting the single verified PID.
It does not target a process tree or another Node process. The
[successful restart](../data/evidence/district-expansion-20261018/preview-restart-bank-v1.json),
SHA-256 `8f207c840e4c63d6075e449230087b612878a9f7e2cc1bec80a42ff3ecd6ded0`,
records new game PID 37360, created at 23:22:08.731749 Helsinki time on
2026-10-18, owning 5317. Unrelated Motion Lab PID 2344/5173 is unchanged.
The receipt filename stays v1 while its `scriptSha256` binds the actual v2 helper.

The [actual HTTP check](../data/evidence/district-expansion-20261018/http-bank-v1.json)
passes root index, current pointer, exact release manifest and ordinary module
hashes served from loopback 5317 after that restart. It does not establish a
browser journey. The separate [ordinary browser smoke](../data/evidence/district-expansion-20261018/ordinary-bank-v1/results.json)
passes all eight checks on actual production `d05d80c8...` and manifest `95478256...`.
It observes default release 7fc03703, excludes the review adapter on both the
default page and `?review=1`, loads 16 of 237 detailed cells at startup and 51
distinct details across the Lasipalatsi, Uspenski and Esplanadi UI drop-ins,
shows HUD/credits and records zero errors. This is startup/on-demand UI proof,
not another full journey or a production performance benchmark.

The [final integration receipt](../data/evidence/district-expansion-20261018/integration-bank-v1.json),
SHA-256 `39db16e4887d56431a0b2646f55881512019bd8a49f0a721d01c8fcc798f964f`,
is `PASS_LOCAL_ACTIVE_ORDINARY`. It binds activation, actual v2 restart, HTTP,
final scoped acceptance, the native image review and the ordinary results
(SHA-256 `53a7900146931d692a442c3ae1173c1d47f0eecaae1c90bc649aaaed682f4d89`).
Root opened all four ordinary PNGs. Together with the 28 bank component and 18
native images, 50 final views are opened and bound; forced coarse views retain
their component-only limitation. The actual ordinary harness SHA-256 is
`78392e6907dbdd2f108976e491f9461adcd4d6802396edf279e9eeba9722d667`;
the final integration producer is
`813b4b83bc2a2500fc2ab2650a7b389ba8bc34bde3e2e222f5bdf2b6f42719e2`.
The runtime/producer inventories remain those above.

Keep the 160/320 MiB texture limits, 500,000 low-preset settled-view triangle gate
and existing draw/geometry caps unchanged. Historical full-moving samples peaked
at **507,309 walking / 540,663 driving triangles**: settled fixture/browser PASS
does not mean every travel sample stayed under 500,000. Their resource/timing
values remain attached to a706, not the new pack. The whole-release 1,358.6 MiB
texture estimate is not a runtime-window measurement. Record actual startup and
resident collision costs separately; no mobile GPU or shaped 20 Mbps network
result is claimed by these desktop/local runs.

The game preview is `http://127.0.0.1:5317/`. Preserve the accepted rollback
content/runtime and the unrelated Finn Motion Lab on port 5173. This document
records completed scoped native acceptance, local activation/restart/HTTP
identity and ordinary browser/image integration. It does not claim a new full
western journey, mobile acceptance or external hosting.
