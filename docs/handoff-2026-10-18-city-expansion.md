# Central Helsinki district expansion — 18 October 2026

Superseded for current runtime/content identity by the
[19 October continuation handoff](handoff-2026-10-19.md). The 18 October
acceptance evidence below remains bound to its original release.

The requested expansion reaches west along Mannerheimintie through Lasipalatsi,
Parliament House, Helsinki Music Centre and Finlandia Hall, and east around
Uspenski Cathedral and Katajanokka. It covers 3.01 km² in 237 cells. The 2017
mesh remains absent. Existing Senate Square, Alexander monument, Finn/Rain and
current Lumi/patrol assets are preserved.

Selected content: `senate-20261018-7fc03703`, manifest SHA-256
`954782564d93cc59a6919c9e598cd77f3813b2b9860d766fe389b0df5d5b089d`.
There are 724 payloads, 1,240,551,957 bytes and 483 validated GLBs. This is the
complete disk pack, not startup transfer or resident graphics memory.

The preceding `a706b755` passed eight native jobs, but a final opened drive image
exposed a bank opening at Kanavakatu's eastern bridge abutment. That candidate
was held before activation. The selected candidate repairs it using actual
bridge endpoints, source dry-land adjacency and the canonical shore boundary.
All 1,005 former sky-pixel rays now hit front-facing detailed/coarse visuals and
HCOL. Original geometry prefixes and other payloads remain exact. Fresh scoped
native acceptance and local ordinary integration pass; the build is active at
[the game preview](http://127.0.0.1:5317/). See
`bridge-abutments-actual-output-v2.json` and the acceptance section.
Do not activate the superseded a706b755. Older `d68943b0`, `60cc8377`, `f8293760` and
`9da4aff9` packs are diagnostic candidates with visible defects; never activate
them. `717a9536` is superseded by the paving/tram work and has incomplete native
acceptance. All earlier candidates remain immutable for comparison.

## Build identity

| Item | Exact input or evidence |
| --- | --- |
| Geometry | `data/work/district-expansion-20261018/cells-abutments-v1/cells.json`, SHA `f3d37e78be20236d6ab970e8d08052ac90fd0f2e3e1491799cfd320f64a8198b` |
| Runtime source snapshot | `runtime-source-v6.json`, inventory `593e49cdd532be3f35343e37ed1d2759def8b3619eb9cc9a0fbe71cbfba589cd` |
| Review module | `index-CggY-Yvi.js`, SHA `8ee16a7706240a82a766f85051a148cb5d46a3464d5011f598d2da346a9d33ce` |
| Ordinary module | `index-RJvTkfS8.js`, SHA `d05d80c892ff4e92e10e9265ae84256ce42e213c3148d46db619521509358db5` |
| Content producer snapshot | `bank-producer-lock-v1.json`, snapshot `bank-producer-v1`, 225 files, inventory `88b92161bfbc4cf8f9e7c1674ff83a26095926b3052d23d59aacbe16a5a2d1f5` |
| Runtime checks | Five TypeScript projects and 365 tests pass, zero skipped: `frozen-checks-v6.json` |
| Changed producer checks | 104 focused tests plus world/verification TypeScript checks pass: `bank-producer-final-checks-v1.json` |

Evidence paths in this document are under
`data/evidence/district-expansion-20261018/` unless stated otherwise. Source
snapshots and all earlier candidates remain separate immutable directories.
There is no Git HEAD for this workspace; the inventories identify the source.

The v6 runtime preserves the compatible shared vehicle work. Its audit binds two
new renderer files and their two required pose JSONs in addition to v5. Current
Lumi/patrol assets retain their exact routes and door timings. New Kaamos/Revontuli
model contracts remain WIP on disk and are not shipped in this city pack; their
pose registry inputs are compiled into the compatible runtime. Do not revert the
shared work. See `runtime-v6-vehicle-compatibility-audit-v1.json`.

## Geography, appearance and collision

The source uses the recorded EPSG:3879/N2000 origin, runtime X east, Y up and Z
south. The expanded bounds are X −1350..800 and Z −950..450 metres. Accepted
interior source data remains protected. Roads use `roads-v8`, gameplay uses
`gameplay-v6`, and terrain uses the Alexander-integrated `terrain-monument`.
Unsupported separate-level approach lanes were excluded; no synthetic bridge or
new legal road access was invented.

Boundary repairs are appended from actual source profiles. They close the
exposed coastal banks, dry curb/soil interfaces and qualified small floor
junctions without flattening source grades. Final actual HCOL checks find
250,136 appended triangles with an exactly vertical normal (normal Y = 0).
The coast helper now clips positive source-edge overlap across intermediate
coastline vertices. This fixes the photographed 228-pixel sky triangle; all 228
old-miss/new-hit rays pass in detailed meshes, coarse meshes and HCOL. The Music
Centre's 37-pixel junction gap is also closed. Original data prefixes and the
unchanged cells are checked independently before facade partitioning.

The subsequent bridge-bank repair qualifies complete OSM bridge axes against
city bridge footprints, actual water-to-land endpoints and ordinary dry-road
adjacency. Six canonical-shore intervals, 13.876 m in total, add 23 quads / 92
triangles in three cells. It does not close bridge midspans or open water. Each
wall follows the exact source floor profile; all original floor triangles,
collider IDs/order and geometry prefixes are preserved. The compressed-output
checker verifies 3,015 front-facing hits for the former 1,005 sky pixels across
LOD0, LOD2 and HCOL, with no new horizontal faces or draw/material allocations.
Twenty-eight fresh images were opened at the main bank, north cell seam and
northern source footbridge. Fourteen are natural low/standard views; fourteen
force the real coarse payloads through an explicitly diagnostic manifest and
establish component appearance only: `opened-bank-images-v1.json`.

Presidential Palace east, Main Guard south/recess/southeast and Parliament's
south lower wing have original procedural facade charts based on opened official
and museum references. Google Maps/Street View was initially unavailable for
those facade checks; the source ledger records the actual alternatives. Reference photograph pixels
are not shipped. The final three-owner chart allocation is exactly 3 MiB of
RGBA plus mip fallback. Isolated target faces are drawn once, retaining source
positions and winding. Coarse meshes use vertex colours without new textures.
Twenty-five images of the preceding paving build were opened, including street-level
paving, the square reached using keyboard movement, and the canal-side facades;
see `opened-images-closure-v5.json` and the [facade protocol](facade-cleanup-protocol.md).

The subsequent paving work uses five opened Google Street View/Maps panoramas
at Mannerheimintie, both Esplanadi sides, Aleksanterinkatu and Senate Square,
checked against municipal street-part polygons. The 383 explicitly selected
stone parts produce 26,176 resurfaced triangles across 38 cells. Rectangular
setts and small cobbles have different metre scales; the square's 50 selected
panels use curved fan patterns. Slab walks, asphalt, grass, stone inserts and the
monument ring remain separate. Selection retains 543 partial or ambiguous
triangles; one 0.535 m² square face retains its existing cobble material. These
are conservative material-selection limits, not new openings. Geometry and
collision are unchanged by resurfacing. Artwork is original CC0, with no Google
pixels in the game.

Mannerheimintie's central rails follow 92 complete OSM ways over 4.27 km across
18 cells. Their running faces use the operator's 1,000 mm gauge. Thin head,
groove and guard strips follow actual ground grades; distant rails use vertex
colours. This is embedded visual track, without running trams or overhead wires.
The actual-output check validates all 36 detailed/coarse tier suffixes and
preservation of all 237 collision files. Source references, authoring and output
proofs are in `street-surfaces-v1/` and the original 222-file street producer
archive. The final 225-file archive also includes the bridge-bank repair.

## Streaming and practical limits

Nearby visual cells load progressively with lookahead, request cancellation,
retry and eviction. Low retains at most 16 detailed and 28 coarse cells;
standard retains at most 28 and 42. The entire 237-cell detailed map is not
loaded at startup. Static collision and terrain remain resident for deterministic
simulation; visual streaming does not imply collision streaming.

Source LoD2 roofs, faceted ground/rock, low-resolution licensed textures and
compact Uspenski stairs remain approximations. Some original background
buildings were untextured. The narrow separate Parliament stair return is still
source fallback. Fine original triangulation seams remain visible on some
surfaces. This expansion does not claim every facade rebuilt or every possible
map opening audited.

The desktop measurements use Chromium 153.0.8010.12, ANGLE Vulkan and RTX 3070 Ti,
1280×720, seed 2026. They do not prove mobile performance or the plan's
20 MB / 20 Mbit/s startup target. CPU `frameMs` is not GPU presentation latency.
See the [benchmark record](benchmarks/district-expansion-2026-10-18.md).

## Acceptance and local preview

All 21 selected-candidate world checks pass, including accepted area preservation,
lane/wheel and bridge support, coastline exclusions, landmarks and cell boundaries:
`world-bank-v1-final/world.json`. Physical route sampling passes 512 body/skid
queries and 2,412 tyre probes: `road-physical-bank-v1/result.json`.

The old complete native suite remains historical under a706b755:
`gpu-suite-closure-v5.json` records the 5,979.832 m walk, eleven-goal drive,
both mission endings and streaming failure recovery. A strict Node replay of
that drive's inputs against both packs is retained as
`FAIL_DERIVED_PRIOR_INPUT_EQUIVALENCE` in `bank-replay-v1/comparison.json`.
Compared public numeric state/body/event fields match through tick 35,937;
car velocity first differs by about 2.1 micrometres/s at tick 35,938 inside the
raycast vehicle update. The wheels use a rebuilt existing ground collider whose
automatic fixed-body mass properties changed. No direct new-wall contact was
found; the nearest appended face is 58.43 m away. The precise private controller
mechanism remains unproven. No tolerance, old recording edits or global physics
changes were used to conceal the failure.

The considered affected scope in `scoped-acceptance-bank-v1.json` therefore calls
for a fresh 188-waypoint eastern walk, all repeated low fixtures, standard
fixtures, both browser/resource presets, a six-goal eastern drive with its own
recording/replay, both mission endings and streaming failure recovery. Those
seven jobs pass in `gpu-suite-bank-v1.json`, with the final considered acceptance
in `scoped-acceptance-bank-v2.json`. The eastern walk covers 1,893.877 m through
188 waypoints and passes 212 checks. The six-goal eastern drive uses a planned
3,315.599 m road loop, reaches nine checkpoints including entry/exit, needs zero
recoveries and matches its own 23,198-tick browser/Node replay (`425b872c`, no
first divergence). Both gameplay endings and their replays pass, as do all ten
streaming recovery checks. This is not a new
complete western walk or eleven-goal whole-city drive. Original geometry/source
prefixes, static/physical checks and exact bank artwork checks supplement these
fresh behavioral checks. The strict old-input replay failure remains explicit.

The low preset's 500,000-triangle assertion applies to settled fixture views.
Historical moving samples reached 507,309 on foot and 540,663 driving; fresh
eastern samples reached 507,969 and 516,944 respectively. Sampled moving draw
calls, textures and FPS stayed within their respective limits.
The benchmark separates those old measurements from the selected build's fresh
checks and records the actual scope without a blanket whole-route budget claim.

The guarded `activate-bank-runtime-v1.mjs` completed after validating the pack,
source, static checks, opened images and scoped acceptance. Rollback files are
preserved. Both active pointers now select 7fc03703. The unchanged ordinary v6
module is served under `/district-ordinary-v7-assets/`; its index hash is
`a14ba681c0ec30ee18d61154820fb5495ebf8f2770cdd279be1a729420139d59`.

The first restart helper's PowerShell stop cmdlet failed without changing either
process. This is preserved in `preview-restart-cmdlet-failure-v1.json`. The new
`restart-game-preview-bank-v2.ps1` retained all activation, command, creation-time
and port guards and replaced only that stop operation with the native Windows
command for the single verified game PID. It successfully replaced 30308 with
37360 on port 5317; Finn Motion Lab PID 2344 on port 5173 remained unchanged.
Do not rerun an old hardcoded helper against the new process.

`http-bank-v1.json` verifies the actual index, active pointer, manifest and
ordinary JavaScript bytes. The ordinary browser smoke passes 8/8 checks through
the visible UI, including Mannerheimintie, Uspenski and Esplanadi drop-ins,
HUD/credits and no browser errors. The review API remains absent even with
`?review=1`. Startup requested 16 detailed cells out of 237; the three drop-ins
raised cumulative distinct detail requests to 51. This is on-demand loading,
not a claim that all 51 remain resident.

All four ordinary captures were actually opened. Together with 28 bank views
and 18 selected native walking/driving captures, 50 images of this candidate
were opened; the 14 forced-coarse bank views remain component-only evidence.
`integration-bank-v1.json` binds the completed local integration chain with
status `PASS_LOCAL_ACTIVE_ORDINARY`. Reload the game with Ctrl+F5 to replace any
older code and world retained by an already-open tab.

The ordered reproduction commands are in
[district-expansion-build.md](district-expansion-build.md). Shared vehicle work
and its decision records remain separate from this handoff.
