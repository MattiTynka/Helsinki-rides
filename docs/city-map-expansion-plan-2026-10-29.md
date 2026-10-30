# Southern and western Helsinki map expansion implementation plan

> User stop, 30 October: further map expansion is deferred. Wrap up, commit, merge and ship only the completed playable scope and integrated optimized assets. Broader southern/western navigation, private parking/w282 proposals and Viikki are outside this release.

Status: implementation plan, 29 October 2026. No game, asset, source snapshot or deployment has been changed by preparing this plan.

Expand the deployed Helsinki Rides world into **Hietalahti, Eira, Kaivopuisto and Ruoholahti**, as selected by the user. Preserve the existing city and gameplay while adding connected streets, pedestrian routes, buildings, waterfronts and scenery. Meilahti, Pasila, Viikki, all of Jätkäsaari, new vehicle types, interiors and new missions are outside this expansion. This geographic choice takes precedence over the older M4 roadmap's northern corridor.

## 1. Baseline and workspace

Use the exact source and world pair verified from GitHub and the live Pages receipt in this session:

| Item | Authority |
| --- | --- |
| Source | `MattiTynka/Helsinki-rides`, commit `03d072e0f549f27de7bc45eb62d16d30ed42517f` |
| World | `senate-20261025-civilian-flee` |
| Manifest SHA-256 | `0e18e55e8730f01144eef72a80decffbb53cdd658222f87a7e8ad6f75f2c4260` |
| Archive SHA-256 | `455b41d735ab6c36240448d99f0ca951410c4759ed02ccc9247bea71120dd0b1` |
| World inventory | 515 cells, 3,372 files, 944,391,123 bytes |
| Grid and origin | 128 m; EPSG:3879 / N2000; `[25497350, 6672960, 7.5]` |
| Runtime axes | X east, Y up, Z south; metres |
| Cell envelope | X `[-1920,896]`, Z `[-2304,768]`; this envelope is not a guarantee of playable coverage |

References: [source commit](https://github.com/MattiTynka/Helsinki-rides/commit/03d072e0f549f27de7bc45eb62d16d30ed42517f), [pinned deployment descriptor](https://github.com/MattiTynka/Helsinki-rides/blob/03d072e0f549f27de7bc45eb62d16d30ed42517f/content/releases/pages.json), [live receipt](https://mattitynka.github.io/Helsinki-rides/release-info.json).

The served manifest hash was independently verified in this session. The complete archive and every payload still need verification when preparing the implementation baseline. Recheck the live receipt and remote main at implementation start; a later deployment requires an explicit reconciliation with this plan.

Create an isolated source checkout under `build/city-expansion-southwest/source` from that deployed commit. Do not restore or push the authoring workspace's unrelated Git history. Its many existing deletions and remaining assets must be preserved. Keep an immutable accepted world, new working outputs and evidence beside the new checkout under `build/city-expansion-southwest/`.

The baseline world, prepared new cells and final append output must occupy the **same volume** while the current append code uses hardlinks. Alternatively implement a hash-verified `EXDEV` copy fallback first. Never mutate retained hardlinked payloads in place; write changed payloads to new content-addressed files. Check free disk space before archive extraction or acquisition; no disk cleanup is part of this plan.

### Reconcile the two asset stores

| Store | Reuse | Required treatment |
| --- | --- | --- |
| D: `build/npc-ship-20261026/source` | Source checkout matching the deployed commit; current bridge/facade/tram tooling and contracts | Use as a verified source reference or clone base; do not replace it with D root's older source |
| D: `data/raw/` and `data/work/city-expansion-20261021/` | City LoD2, terrain, building register, street parts, trees, OSM, source ledgers and conversion masters | Intersect each dataset's actual coverage with the new polygon; reuse only verified, compatible records |
| C: `data/work/expansion-20261017/trees-models/blender-report.json` and companion `assets/scenery-trees.glb` | Accepted tree profile and exact tree asset; GLB hash matches the live world | Preserve and bind both; do not substitute a visually similar tree |
| C: `data/work/m0/blender-scenery/scenery-trees.blend` | Editable tree source | Preserve original; copy for any new authoring |
| C: older terrain, landmark/facade work and city models | Historical build inputs and reusable source material | Treat as candidate inputs, not as the deployed result |

The C-only old north terrain is a historical dependency, not the current runtime terrain. In particular, D's Oct21 `terrain-source-v1/terrain.bin` has the same byte length as the deployed decoded heightfield but a different hash. Build the preservation baseline from the **live manifest's decoded terrain**. Identify authoring terrain separately. Never replace it merely because dimensions match.

Move-sensitive producer/cache metadata must receive newly generated receipts binding the new paths, producer versions and source hashes. Do not edit old evidence to make relocated files appear verified.

**Exit:** a baseline receipt, complete payload verification, resolved source-path inventory, locked tool versions and a locally running build of the deployed source/world pair.

## 2. Geographic rollout

Derive a coverage map from the actual 515-cell manifest, decoded collision and road connectivity. Overlay licensed source coverage and proposed routes. Mark each area as accepted, new, repair required, or excluded. Hietalahti and northern portions of the selected districts may overlap existing coverage; only the delta is new work.

Store an explicit EPSG:3879 target polygon, grid cell list, seam bands, route endpoints and exclusions before acquisition. Use complete intersecting building ownership and a source acquisition halo, initially one 128 m cell; obtain complete road/water relations beyond that halo where necessary. Do not turn the whole bounding rectangle into land or claim its area as playable.

| Stage | Scope | Playable acceptance |
| --- | --- | --- |
| A: first connected extension | A selected 16–32-cell delta from accepted Bulevardi coverage toward Hietalahti and southern Punavuori | Walk and drive out of the accepted world, cross the new seams, turn around and return with real controls |
| B: Eira and southern Punavuori | Continue the network through the selected southern streets to Merikatu/Eiranranta approaches | Connected streets and sidewalks; supported building bases, crossings, waterfront edges and recovery |
| C: Kaivopuisto and remaining Ullanlinna connections | Join the southern route to Kaivopuisto and the accepted eastern city through source-confirmed public roads and paths | A continuous southern loop; parks/paths distinct from vehicle routes; no artificial land across water |
| D: Ruoholahti | Extend west from Hietalahti through the confirmed Ruoholahti street network and canal-side paths | A connected western loop with individually verified canal crossings and approaches |

Sixteen to thirty-two cells represent 0.262–0.524 km² of grid area, not a promise of that much playable land. Select the exact first packet after the coverage and storage forecast. Complete all four stages for the requested geographic outcome; the first packet is a risk-reduction milestone, not completion of the whole request.

The exact southern/western boundary must be recorded at Stage A. Exclude harbour-only access, unsupported tunnels, inaccessible yards and unverified bridge connections by named source IDs. Include both approaches to a supported crossing. Keep shoreline, canal and open spans intact. Do not automatically extend to all of Jätkäsaari or islands.

## 3. Delivery and pipeline work required first

### Capacity decision

The deployed stager permits 960,000,000 world bytes and 980,000,000 complete-site bytes, but the append adapter and archive preparer still enforce 950,000,000 world bytes. The current world therefore has only **5,608,877 bytes** of room through the append path. Every decoded simulation payload is separately limited to 64 MiB. More cells, a wider heightfield and a larger manifest can hit different limits.

Measure the first packet's unique texture, geometry, collision, terrain, graph and metadata costs before scaling. Forecast all four stages, including the Low texture tier, complete shell, file count, manifest size and decoded payload sizes. Do not count compressed transfer size as GPU memory or decoded terrain size.

A small packet may remain on Pages if it fits the existing end-to-end limits while retaining accepted assets. For the full selected area, the recommended design is **the existing Pages application shell plus an immutable static world-asset origin**, selected through the existing world-base URL configuration. Prepare a provider-neutral upload inventory and validation design; provider selection, budget, provisioning and external publication remain separate decisions before those actions.

For an external asset origin, preserve the existing Pages mode and add an explicit delivery mode with its own bounded storage budget. Specify CORS for the game origin, content types, content-addressed caching, compressed-file handling, failure recovery, manifest hash verification and rollback. Retain all existing source/privacy and payload-integrity checks. Do not merely raise the Pages limits or reduce accepted texture quality until the build passes. Keep current decoded-resource limits unless a separately verified runtime change justifies a new contract.

### Required producer changes

| Change | Relevant interface | Acceptance |
| --- | --- | --- |
| Manifest-driven accepted coverage | New reusable helper replacing the historical `prepare-accepted-coverage-v1.mjs` dependency | Works with the actual 515+ cells; verifies decoded collision and owner IDs; no hardcoded 304-cell assertion |
| South and west append support | `tools/world/lib/delivery-city-append.ts`, `frontier-ground.ts`, append-plan contract | Explicit axis/side per region; supports one region and south+west regions; handles their shared corner without duplicate ground |
| Remove historical paired-strip assumption | Append currently requires exactly two opposite north/south strips | Support the chosen bounded regions without adding an artificial north strip; preserve the old supported case |
| Preserve later repairs | Current accepted bridge, facade, tram, terrain and gameplay payloads | All unaffected refs/hash-identical; changed seam payloads have explicit source-bound differences |
| Reproducible acquisition | New parameterized version of Oct21 bounded acquisition logic | Fresh destinations, approved source hosts, retries/timeouts, byte budgets, complete WFS/OSM results, recorded vintages/hashes |
| Delivery-mode support if needed | Release descriptor/schema, preparation/staging tools, CI, runtime URL/loading checks | Same payload closure checks in both modes; deployable shell and immutable world remain an exact pair |

The existing append code calls `planCityFrontier(..., 'z')` and asserts two opposite strips. The southwest expansion needs both restrictions addressed, not just a larger rectangle in a configuration file. Add focused cases for a single south strip, a west strip, their corner, holes/exclusions, a bridge intersecting the seam and replaying the old north/south case.

Use `append_delivery_city.ts` for new-only optimization and append. Do not re-run `optimize_release` over the accepted world. Do not use the older `stage_release.ts` as the deployment validator: its release-name and payload assumptions do not cover this deployed packet.

**Exit:** a tested producer change, a precise first-packet polygon and a measured delivery design that can support the planned release.

## 4. Acquire only missing source data

For each new region, obtain textured LoD2 buildings, compatible terrain, building-register footprints, street-part polygons, street/plot tree positions and a complete dated OSM extract. Reuse audited D snapshots wherever their geography, vintage and provenance are suitable; the existing central-city acquisition is not evidence that all four new districts are covered.

Preserve dataset URL, layer/vintage, capture/download dates, projected extent, CRS, vertical datum, units, license, attribution, input hashes and conversion versions. Helsinki documents textured LoD2 and the ETRS-GK25/N2000 contract in its [3D data documentation](https://www.hel.fi/en/decision-making/information-on-helsinki/maps-and-geospatial-data/helsinki-3d), and provides the [official WFS entry points](https://www.hel.fi/en/decision-making/information-on-helsinki/maps-and-geospatial-data/make-better-use-of-geospatial-data/open-geographic-data). Verify the selected layer's metadata at acquisition.

Exclude accepted building owners before appending a newer city-model vintage. Preserve existing building IDs, texture/chart mappings, collision identities and road records. Where different source dates disagree, keep the discrepancy as a source-bound patch decision rather than silently refreshing the accepted city.

Implementation clarification, 30 October: the broad boundary audit found 29 retained lane/footway records whose protected boundary heights already differ from the original deployed HCOL by more than the existing 0.20 m road-support tolerance. The original and final physical floors agree at those failing boundaries; the append did not introduce these offsets. For example, one Laivasillankatu boundary has approximately 1.347 m of inherited graph-height error. Lane/footway Y participates in runtime level and spawn selection, so these errors require a separately reviewed metadata repair. Evidence: `build/city-expansion-southwest/evidence/south-protected-frontier-comparison-v1.json`, SHA256 `0bdc4d27c3d2c257f00efe2fbebf349f277bbff214f0d88399c9d14de585cc0a`.

Allow only literal, independently reviewed wrong-Y intervals bound to the original accepted graph and original/final serialized HCOL, with complete triangle-level witnesses. Preserve IDs, source/access metadata, every horizontal piecewise curve, endpoints in XZ, widths, lengths, topology, address data, all 43 first-area additions and already-qualified first-area portions. Keep world geometry and terrain unchanged. Verify nearest-XZ/route/address choices and actual spawn/walking results: previously valid placements retain their actual native positions; any formerly invalid placement becoming valid needs an explicit disposition. A source-bound correction is an exception to old-Y byte preservation, not a generic accepted-record waiver, and does not relax physical tolerances or close ordinary streets to hide a failed gate. The first concrete correction and its strict authority contract remain subject to independent review before application.

The first Laivasillankatu packet qualifies the numerical meaning of native-position preservation: changing a ray's graph-derived origin can change Float32 Rapier subtraction even when the actual native collider, triangle closure, normal, XZ and heading are unchanged. Its 1,413 paired rays retain all 157 previously valid spawns with at most 0.000000469338 m of position difference, each independently bounded by the literal four-TOI-ULP arithmetic envelope plus origin quantization. This is an exact packet-specific rounding allowance, not bit-identical pose evidence or a general physical tolerance. Sixteen formerly invalid spawns become valid explicitly; none becomes invalid. Any unchanged original-floor flat-frame failure remains a failure with a separate literal disposition and actual native-dynamics evidence. The generic 0.20 m sampler is unchanged.

Exact Hietalahdentori service-corridor clarification: root approval `plaza-service-root-approval-v1.json` separately permits 16 literal directed service records from OSM ways 314403243, 1271953696, 1271953697, 1561008519 and 1561008520; their exact swept clips on public square parts 46642/512496 and six small parking margins on 507355; and 347 literal native raised-asphalt/road-setts face entries restricted to each named clipped domain. It grants no whole plaza, general sidewalk, new outside connector or legal-access permission. Normal and 0.20 m body limits remain unchanged.

Four exact Y-only corrections (314403243:1:f0/b0 and 1271953697:0:f0/b0) preserve ordered XZ, endpoints, non-point metadata, topology, all unrelated records and all 43 current additions. Independent replay reproduces 72 native pairs / 32,366 paired ticks with literal physical fields, 882 valid placements and 7,938 rays; steering arithmetic differences remain explicit. All 22 old lane-body and 100 old connector misses remain FAIL with literal original/current floor and exact inherited dispositions. Three distinct opaque source/floor/Y roles must enforce these scopes; future physical context and final connected gameplay remain separate gates. Approval SHA256: `27c7fd57756403aba0047aff545226a50ec5e5a6a75f63c5f5c4bb28486b4945`.


Exact Uudenmaankatu driveway-crossing clarification: root approval `udenmaankatu-crossing-root-approval-v1.json`, SHA256 `90eecd777aff1c481f47b01e80192fe47654302b88f2b57a0d6d451826255a84`, permits only two literal directed records of OSM way1204623899 and their exact admitted footprint clips across public sidewalk59319, between ordinary carriageway parts59311/46532. Separate opaque source and floor capabilities retain the original sidewalk properties and restrict 17 native face entries per record to their literal clipped domains. Ordinary original/current outside-only preservation passes; no protected-Y baseline, private continuation, whole-sidewalk permission or connector waiver is added. Six native out/reverse-back traversals pass. The old U-turn's 2,120 failed body probes and all six endpoint source rotations remain rejected. A later physical/mask context requires explicit qualification.

Actual current-state preservation also covers the seven already-repaired original records, separately from the43 added first-area records. Derive and hash-bind these repairs from the original/current graphs; verify ordinary outside-only preservation, retain nonpoint metadata/topology and protect current playable chords. Ordinary new projection starts from the actual current record. Existing literal approved AFTER authorities retain precedence. Restoring current repairs is not an extra Y exception or source/floor grant, and original515 retained-tail accounting remains independently required.

Exact inherited-lane repair clarification: Kopernikuksentie records `123812227:0:f0` and `123812227:0:b0` may receive the two literal source-contained inward registrations in root approval `kopernikuksentie-registration-root-approval-v1.json`. The authored lateral shifts are at most 0.50 m / 0.25 m; independent continuous bounds include only one nanometre of numerical rounding. This explicitly changes protected old XZ for these two records. Their endpoints, source nodes, access, width, metadata lengths, topology, all other current records and all 43 first-area additions remain literal. Actual new polyline lengths are separately disclosed; metadata lengths retain existing route costs.

The fixed proposal passes fresh ordinary source/body/continuous-sweep tests, an independent continuous parallel-corridor calculation and all six actual native uphill/brake/reverse-downhill traversals. Its source-connected reference is limited to the two lanes and literal adjacent approach/connector XZ; it writes no approach/connector Y and grants no other source or closed-tail permission. The 175/160 standalone endpoint-clamped body failures and 642/538 nominal diagnostics remain recorded. All 1,134 sampled old/new flat-yaw population spawns stay rejected under the unchanged steep-hill rule. Eight local nearest-lane choices change; all 1,958 address and 196 route comparisons remain unchanged. This repair requires a distinct opaque horizontal-registration authority for both original and actual current baselines; it must never enter the height-only current-baseline slot. Other preservation/source/body gates remain active, and any later physical/mask context needs its own exact qualification. Approval SHA256: `072ed5712ea412fd7a66acae5e4f732000716fd6f6516b70fa77a82f206ab8b1`.


Later implementation clarification: a concrete source-contained registration may adjust the previously unplayable first anchor of retained Itämerenkatu lane 86957349:0:f0. The exact reviewed proposal sets it back 6 m along the old path, tapers the bounded south adjustment to zero by original station 15 m, and recomputes only that record's geometric length from 43.136 to 37.12772913784751 m. Every original/current playable 3D chord, final endpoint, accepted node, parallel lane and sole inside outgoing connector remains literal; no accepted incoming connector exists. Root approval binds the exact before/after hashes, ordinary carriageway parts 41721/651951, actual d453 HCOL, full-body/source/mask checks and all nine parallel vehicle sweep pairs. Only its separately reviewed opaque adapter may apply this one outside endpoint/length exception; other endpoint, connector or source-node rules remain active. Evidence: `build/city-expansion-southwest/evidence/itameri-retained-outside-root-approval-v1.json`, SHA256 `1c633114dcc228d509d8dfd01e4422b5e4bede2baa0ee20579027f6087c9d856`.
 Root approval: `build/city-expansion-southwest/evidence/laivasillankatu-inherited-y-root-approval-v1.json`, SHA256 `9045504e445aad57acfcdb12da65e680d455f65ecd3a1294250cbfbe67bc0a8f`.

The legacy fetchers may delete or overwrite a same-named snapshot. Use new job-specific output names, destination-existence guards and resumable hash checks. No acquisition command should point at the only copy of a source dataset.

**Exit:** complete bounded source snapshots, coverage report, source-conflict report, reproducible ledgers and no unexplained missing tiles or truncated feature queries.

## 5. Google Street View survey and visual work

Use browser access for visual inspection. Street View informs appearance and identifies discrepancies; municipal/OSM source geometry and reviewed authored patches establish the game geometry. Google imagery is visual reference only and must not become game textures.

Reconnaissance already opened in this session includes official Google imagery at Bulevardi 23 and **Bulevardi 54**, both dated August 2024. The Bulevardi 54 view shows the brick elevation, an opening between buildings, mixed paved surfaces and curb transitions that must remain distinct in the build. [Bulevardi 54 panorama](https://www.google.com/maps/@60.1620458,24.9305312,3a,75y,137.31h,90t/data=!3m7!1e1!3m5!1s1hASrVaQnLNB9ilQ_CXw8w!2e0!7i16384!8i8192).

Official August 2024 imagery at **Merikatu 1**, labelled `1 Havsgatan` in the panorama, was also opened. It shows a stone base with arched openings, projecting entrance surrounds, an asphalt sidewalk and curb-side parking. Preserve those architectural distinctions; parked cars obscure some curb/ground detail, so this view alone cannot certify the ground geometry. [Merikatu 1 panorama](https://www.google.com/maps/@60.1559729,24.9495535,3a,75y,0.42h,90t/data=!3m7!1e1!3m5!1sc6QTedRp-PF2dROAn8IQmA!2e0!7i16384!8i8192).

The Hietalahti market gallery initially returned contributor panoramas from 2017/2018, including an interior. Those are not evidence of current street-level conditions. Always record provider and capture date, and confirm the actual street/elevation before accepting a reference. A 2026 inspection of a 2024 image does not make it 2026 imagery.

Create a browser survey ledger keyed to source building/road IDs, with panorama URL/ID, coordinates, heading, capture date, viewpoint, observations, uncertainty and matching game camera. Inspect:

- Hietalahti/Bulevardi: accepted/new seam, market-hall exterior, street materials, rails, curb transitions and facade returns.
- Eira/Punavuori: street gradients, public passages, plinths, entrances, retaining walls and tree locations.
- Kaivopuisto/Ullanlinna: park paths, road/footpath separation, rock/ground transitions, waterfront edges and connections back into the city.
- Ruoholahti: canal edges, bridge decks and both abutments, tram/street interfaces, public paths and industrial-block facades.

Survey every planned seam, crossing, bridge, significant surface/grade change and hero facade. Use front and oblique views; inspect a second date or angle where foliage or construction obscures detail. Mark unresolved details and keep affected routes excluded until supported. Exact lane widths/heights must come from suitable source geometry or explicitly labelled authored measurements, not perspective guesses.

Follow `docs/facade-cleanup-protocol.md` from the authoring reference: identify building, elevation, texture page and UV charts; define protected doors/windows/returns; reconstruct only affected regions using licensed masters or original detail; inspect the final compressed result in the game. Preserve existing repaired facades and sanitize publishable metadata as in the deployed source. Use Blender only for designated landmark/prop repairs, against the project's pinned release and asset contracts.

**Exit per stage:** survey ledger, facade/landmark backlog with resolved blockers, opened before/after game views and no Google pixels in production assets.

## 6. Build the playable geography

Keep four separately validated outputs: visual cells, physical ground/colliders, pedestrian connectivity and the vehicle road graph. Preserve the current native schema and `__HELSINKI_GAME__` verification interface.

1. Convert only new buildings with float64 transforms until local vertex buffers are written. Check east/north/up, metre scale and three existing geographic control points after actual load.
2. Extend source terrain separately from runtime safety terrain. Copy accepted runtime samples bit-exact outside named seam patches. Do not reconstruct accepted bridge decks from bare-earth terrain.
3. Build source-backed carriageways, sidewalks, curbs, crossings, ramps and necessary retaining/shore walls. Preserve water clipping and open spans. Validate ground, facade bases and visual/collision seams independently.
4. Merge roads with stable IDs and explicit connections across the accepted boundary. Respect one-way/access/bridge/tunnel/layer distinctions. Confirm full-width tyre/body support, turning clearance and no stacked-road joins. Retain explicit closures for unsupported edges.
5. Build connected pedestrian paths and crossings using the current navigation/population representation. Preserve old civilians and police behavior; add new population only to verified supported locations, within existing population budgets. Do not scale active NPC counts with total map area.
6. Reuse accepted instanced trees, trunks and props; verify soil support, public-path clearance and no duplicate source instances. Tree placement cannot conceal a facade defect.
7. Produce detailed/coarse cells and new Standard/Low texture tiers. Preserve old accepted payloads; record allowed append-only changes in seam cells. Update playable-boundary checks, address drop-ins and map display from supported coverage, not merely an enlarged rectangular envelope.

For the south/west corner, compose ground subtraction and seam ownership once. Prove no double collider, missing triangle, duplicated building/tree or discontinuous terrain where the two append regions meet. Current lowered safety terrain may change only within the declared, measured seam policy; no blanket height-tolerance increase.

**Exit per stage:** native manifest/GLB/decoded-world checks, per-representation seam proof, route connectivity, accepted-world preservation report and staged candidate identity. This is still not a gameplay or performance PASS.

## 7. Runtime and release acceptance

For each final staged candidate, bind source revision/dirty-file hashes, manifest, producer lock, browser/version, device, preset, route and recordings. Use a fresh build of the native review mode; production output remains separately checked.

| Gate | Required evidence |
| --- | --- |
| Integrity and preservation | Every payload hash/size verified; baseline assets and unaffected cells unchanged; explicit changed-cell/terrain/road diff; correct source credits |
| Connected travel | Real-control walk and drive from the old city into each new stage and back, both directions over seams; no fixture teleport as reachability proof |
| Southwest routes | Bulevardi–Hietalahti loop; southern Eira/Kaivopuisto loop back into accepted streets; Ruoholahti loop; paths confirmed during the source survey |
| Difficult geometry | Curbs, slopes, stairs/ramps, waterfront, canal bridge approaches, passages, collisions and safe recovery; no navigation across water/stacked levels |
| Streaming resilience | Maximum permitted speed, U-turn, delayed/failed request, cancellation/retry, unload/reload and background-tab resume; no unsupported actors |
| Existing gameplay | Current native Wasted/Busted journeys, civilian behavior and police traversal; same-candidate recordings and replays; accepted city revisited |
| Resource stability | Repeated route and a proposed 30-minute soak; compare resources at the same settled locations; no accumulating colliders, jobs, GPU objects or NPCs |
| Production | Fresh cold/warm loads, correct source/world receipt, working addresses/credits/error recovery, production review hooks excluded |

Current native budgets: Low **500,000 triangles, 350 draws, 160 MiB textures**, 96/64 MiB detailed/coarse geometry; Standard **1.2 million triangles, 600 draws, 320 MiB textures**, 160/96 MiB detailed/coarse geometry. The native FPS gate is at least 30 FPS. Preserve the actual harness's sampling semantics; do not label settled-view acceptance as an all-frame guarantee. Record p50/p95/p99 frame times and worst moving samples in addition to required gates. Compare startup transfer/time and decoded resources to the pinned baseline on the same named device/network. Desktop checks do not prove mobile performance.

A failed old-recording replay after a collision change remains a failure of cross-release equivalence; do not relax it into PASS. Produce new candidate-bound travel/gameplay evidence and document the precise accepted difference. Small source-only checks and screenshots do not replace real traversal.

Publish only a completely staged, reviewed source/world pair when publication is authorized. Upload immutable world objects first, verify served hashes, then switch the shell/descriptor. Retain the old source/world tuple for rollback, including service-worker/cache-version behavior. Never mutate the existing live release directory. If a gate fails, keep that region unreleased and repair it; do not delete baseline content or weaken limits to hide the failure.

## 8. Implementation units and command recipes

Suggested sequence: baseline and coverage → delivery forecast and producer repairs → Stage A sources/survey/build → Stage A runtime gates → Stages B/C/D using the same pipeline → full-area acceptance → publication handoff. Source acquisition and browser survey can proceed independently after the target is fixed; shared asset builds, Blender jobs and final release writes remain serialized.

Ownership for a future delegated implementation: producer/coverage tools; delivery/schema/runtime loading; geography/road/scenery configuration; browser references/facade repairs; independent validation. Each writer must have distinct files and preserve other changes. Integration owns final manifest and release descriptor writes.

These commands are verified against the deployed source interfaces. Run from the isolated implementation checkout **after** its frozen dependencies and named input files exist. Uppercase names below are required input placeholders, not files created by this planning task. Producer changes described above must land before the final southwest append.

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test:source
python -m unittest discover -s tools/release/test -p 'test_*.py'

node tools/world/convert_city_model.ts --ledger LOD2_LEDGER --snapshot SNAPSHOT --origin content/helsinki/world-origin.json --out FRESH_MODEL
node tools/world/build_terrain.ts --tiles TERRAIN_TILES --ledger TERRAIN_LEDGER --origin content/helsinki/world-origin.json --config NEW_EXTENT_JSON --resolution 1 --out FRESH_RAW_TERRAIN
node tools/world/build_roads.ts --osm-ledger REVIEWED_OSM_LEDGER --snapshot SNAPSHOT --origin content/helsinki/world-origin.json --config NEW_ROADS_CONFIG --terrain EXTENDED_TERRAIN_BIN --street-parts STREET_GEOJSON --out FRESH_ROADS

node tools/world/append_delivery_city.ts --native-cells NATIVE_CELLS --expected-index INDEX_SHA --accepted-world ACCEPTED_PACKET --expected-manifest BASE_MANIFEST_SHA --out FRESH_DELIVERY_CELLS --receipt FRESH_PREPARE_RECEIPT
node tools/world/append_delivery_city.ts --plan APPEND_PLAN_JSON --out FRESH_WORLD --receipt FRESH_APPEND_RECEIPT

pnpm build:review
node tools/verify/verify-browser.ts --url "http://127.0.0.1:5317/?review=1" --release NEW_WORLD --preset low --out FRESH_LOW_EVIDENCE
node tools/verify/verify-district-expansion.mjs --url "http://127.0.0.1:5317/?review=1" --release NEW_WORLD --plan ROUTE_PLAN --runtime-sha256 RUNTIME_SHA --preset low --out FRESH_ROUTE_EVIDENCE
node tools/verify/verify-streaming-residency.mjs --url "http://127.0.0.1:5317/?review=1" --runtime-sha256 RUNTIME_SHA --manifest-sha256 MANIFEST_SHA --preset low --out FRESH_STREAMING_EVIDENCE
node tools/verify/play-journey.ts --url "http://127.0.0.1:5317/?review=1" --release NEW_WORLD --runs 10 --out FRESH_JOURNEY_EVIDENCE
node tools/verify/replay-recording.ts --release NEW_WORLD --recording FRESH_JOURNEY_EVIDENCE/run-01-recording.json

python tools/release/source_release.py audit --images --git
python tools/release/stage-pages-world.py validate --descriptor content/releases/pages.json
```

The preview URL must belong to a separately started, owned server serving this exact candidate, not an arbitrary existing process on that port. Configure the world release/base/hash as required by the review build. Repeat applicable browser/route/resource checks for Standard. Run focused new producer tests and the complete applicable asset/world suites after their inputs are present; portable source tests explicitly do not prove all asset suites passed. For a Pages-contained candidate, finish with the existing pinned Pages build and full `stage-pages-world.py stage`; for an external-world candidate, add and run the equivalent mode-specific closure/staging gate.

`build_cells.ts` additionally requires the reviewed city model, terrain, footprints, street parts, landmarks, OSM ledger/snapshot, config/origin, fresh output, tree placements, ground region, accepted-coverage exclusions (`--exclude-ground-cells`), ground-cache output and accepted-building manifest. It also needs a **separate source-bound bridge/unsupported-ground exclusion JSON through `--ground-exclusions`**. This is distinct from accepted-cell subtraction; the delivery preparation requires `report.groundExclusions`, and append verifies its hash against native-cache metadata. Bind both exclusions inputs in the new job receipt. Generate these inputs from the new job configuration; do not copy the historical Oct21 paths and 304-cell assumptions into a new command.

Every milestone produces a concise receipt with **PASS, RETHINK or INCOMPLETE**, changed paths, input/output hashes, opened views, actual checks, unresolved issues and next runnable step. The final deliverable is all four selected regions connected to the deployed city, with reproducible inputs and candidate-bound acceptance evidence; this document alone does not claim that outcome has been implemented.
