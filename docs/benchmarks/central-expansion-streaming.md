# Central Helsinki expansion and streaming

PASS for the bounded central expansion, active locally on 2026-10-18 at
`http://127.0.0.1:5317/`. The default is `senate-20261017-185c7a1b`, ordinary
bundle `index-CaCVE3GV.js`. Final evidence is indexed by
`data/evidence/expansion-20261017/completion.json`. Earlier failures below are
retained as diagnostics; the final results are explicitly identified.

The expanded playable rectangle is X -800..150, Z -450..350 (950 x 800 m),
including Kluuvi, Esplanadi and the railway-station frontage. It uses 69 visual
ownership cells on the existing 128 m grid. Six cells own buildings crossing
the playable rectangle. The original 63 Senate buildings and 124 source texture
pages remain the prefix of the merged source, so the accepted facade mappings
keep their identity. The 2017 mesh is not an input.

## Resource policy

| Resource | Low | Standard |
| --- | --- | --- |
| All retained textures, including hidden shared templates | 160 MiB | 320 MiB |
| Detailed cell radius / maximum count | 170 m / 16 | 230 m / 28 |
| Detailed geometry buffers | 96 MiB | 160 MiB |
| Distant radius / maximum count | 300 m / 28 | 420 m / 42 |
| Distant geometry buffers | 64 MiB | 96 MiB |
| Decode concurrency, per tier | 2 | 2 |

Movement predicts up to three seconds/180 metres ahead, with a small retention
margin to avoid repeated loads at cell boundaries. Actual decoded mip and buffer
sizes decide admission. Old cells are disposed before new ones enter the scene.
Both detailed and textureless distant cells unload; tree instance buffers follow
the loaded cell set. Distant groups are hidden when detail is present. Camera
far clipping follows the opaque end of the fog.

If neither visual tier covers the ground within 12 m, real-time simulation and
animations pause, show a loading/retry message, and resume without accumulated
time after coverage returns. Death, arrest, below-map and out-of-area states
remain able to recover. Review-only explicit simulation steps retain their
deterministic replay contract.

Static collision remains resident for this bounded 0.76 km² release. Its payload
is about 15.84 MiB, plus a 2.91 MiB terrain grid; these are payload sizes, not
Rapier's total runtime allocation. The measured browser heap and graphics memory
must be reported separately. Expanding to the whole city requires a separate
collision-streaming design; this change does not claim that milestone.

## Geometry and asset checks

`data/evidence/expansion-20261017/world-v3/world.json` passes all 11 offline checks:
41,290 road samples, 9,084 cell-seam samples, 1,168 boundary samples and 12,854
accepted-interior visual comparisons. Maximum road visual/support difference is
0.000023 m. Seven exact-edge ray misses are recorded separately and validated
against decoded collision triangles, rays 1 mm either side and a centred sphere
cast. They are not silently removed from the results.

Entrance terrace treads now provide their own collision. The global safety
heightfield stays below authored ground instead of protruding through it at local
terrain peaks. These fixes remove the initial candidate's 78 lane mismatches,
including a 49 cm mismatch near the station. Non-ground geometry, encoded facade
images and the monument collider survive the ground-only rebuild unchanged.

The supplied Alexander II model is calibrated to 10.67 m and placed at square
centre facing south. Only 59 source-terrain samples beneath its footprint and
one-metre feather change. Standard retains 152,638 monument triangles; the low
variant retains 38,532 with a 2 cm simplifier error limit and identical textures.
Distant complex architecture uses a 10 cm error limit; ground remains exact.
Source sculpture omissions are retained. Finn, Rain, pistol, both cars and tree
templates remain byte-identical to the accepted release.

Low adds two optional textureless distant-car derivatives (5,791 / 5,877
triangles), used beyond the existing 30 m transition. All lamp geometry remains
exact; the simplifier error limit is 3 cm. Low also groups the unchanged tree
instances in 32 m batches within their 128 m owner cells, allowing tighter
frustum culling. All 810 placements and tree templates remain unchanged.

The final Esplanadi repair changes two atlas images only. Source-bound charts
677, 697, 698, 699 and 701 remove projected trees/scaffolding from identified
facades. All non-image content and collision remain exact. Street View could
not be opened in this environment; municipal museum and building-control
references are recorded in `esplanadi-facades/source-v9/review.json`. Google
imagery is not included in game textures. Lower shop interiors at number 35 are
simplified; number 31 repeats verified clean architectural bays. Unrepaired
new buildings retain the aerial source's limited close-up detail.

## Runtime evidence and limits

Diagnostic candidate `senate-20261017-3469f19e` established bounded startup,
successful eviction and identical return allocations after two fixture circuits:
153.34 MiB textures and 87 textures/176 geometry allocations at both Senate
returns. Fixtures establish residency, not continuous travel. The initial
continuous walk reached Kluuvi but its return line intersected a building corner;
the corrected street-following route must pass before acceptance.

The diagnostic failure harness passed deliberate missing tiles, movement held
while uncovered, recovery after retry and disposal of late old-district loads.
That result does not substitute for final-candidate checks. A legal 2.67 km driving
loop follows Senate–Kluuvi–Stockmann eastern frontage–Eteläesplanadi–Senate.
The station is checked on foot/with labelled fixtures: an OSM-compliant return
drive from its frontage needs a detour beyond this rectangle. Source turn
restrictions remain enforced.

## Historical candidate v3 measurements (rejected for ground defect)

Content: `senate-20261017-69ef6997`; manifest SHA-256
`a5d73cb61f87907e4a16d3a0587314d1ad613cc9282917e404981f6a2ef1e4ad`.
Review runtime: `index-cgsoDyHf.js`, SHA-256
`0b7cb3f689564afe6c62e802fa2de1df9c6aec91d809729848289f5ade64266c`.
The 406.9 MB stored pack includes every cell and optional tier; it is not loaded
as one scene. All 147 GLBs pass the format validator with zero errors.

The candidate-v3 real-keyboard walking route crosses the former boundary into Kluuvi
and returns through seven waypoints without reset/teleport. All seven pass in
`browser-low-final/results.json`, with 219 movement samples and no browser errors
or missing nearby coverage. Textures peak at 155.34 MiB on that route.

| Two fixture circuits / 24 headings | Low | Standard |
| --- | --- | --- |
| Checks | 43/43 PASS | 43/43 PASS |
| Startup detailed / distant cells (of 69) | 12 / 28 | 16 / 40 |
| Maximum detailed / distant resident cells | 15 / 28 | 21 / 42 |
| Maximum retained textures | 154.01 MiB | 261.68 MiB |
| Maximum detailed / distant geometry | 14.41 / 9.28 MiB | 22.88 / 12.88 MiB |
| Same-view return textures | 153.34 MiB both times | 201.68 MiB both times |
| Same-view return GPU textures / geometries | 141 / 202 both times | 186 / 258 both times |
| Observed browser JS heap range | 255.04-425.15 MiB | 317.51-616.13 MiB |

Evidence: `browser-low-final-matched/` and `browser-standard-final/`. The first
walking harness also ran fixture comparisons but initially compared unequal
view histories: only its first circuit looked in all four directions. The
retained texture bytes were identical, but lazy GPU uploads differed. That
failed allocation assertion is retained in `browser-low-final/`. The corrected
harness warms the same four headings on both visits, retains the same strict
allocation tolerance, and passes. No runtime change was needed for this finding.

The opened low captures cover the monument, return route, Kluuvi, Ateneum,
station frontage, Kaisaniemenkatu and Esplanadi. Ground and curbs are connected
in those views, Finn stands on the surface, the supplied monument is visible,
and the repaired Esplanadi facades no longer show projected trees. A separate
24-view v3 probe peaks at 387,835 low triangles/189 calls. Standard fixture
views peak at 732,505 triangles/176 calls. Texture limits are unchanged.

Heap observations include simulation, decoded buffers and JavaScript objects;
they are not total process RAM or total GPU memory. These short repeated routes
establish resource retirement, not an hours-long soak or low-memory mobile
certification. Final driving, failure-recovery, native gameplay and ordinary
activation results are added below when their checks finish.

The candidate-v3 real-keyboard driving harness (`drive-final/`) reported a pass: 2.67 km in 334.8 s,
with entry and exit, 20,085 ticks and an exact Node replay hash `dd4ec87b`. The
controller was capped at 10 m/s, not the car's maximum speed. It used one explicit
X recovery after eight seconds without progress near X -158.245, Z 133.696;
the report retains this event. Exact replay and wheel probes subsequently found
a 1.11 m ground drop within the Fabianinkatu lane near X -157.6, Z 133.7. The
centreline visual/support tests missed it because both representations shared
the same discontinuity. `drive-final/wheel-ground-diagnosis.json` records the
cross-section and wheel positions. **This is a real ground defect and blocks
activation of candidate v3.** A corrected ground build and wider lane probes
are required; the recovery is not accepted as a clean driving pass.
There were no falls, browser errors, coverage
pauses or missing nearby detail samples. Maximum observed submissions were
433,420 triangles/222 calls; textures peaked at 155.34 MiB. The isolated selector
test also covers a 60 m/s lookahead corridor, but this is not a maximum-speed
browser drive claim.

`streaming-failures-final/` passed 10/10 checks on the same manifest/runtime.
Twenty-eight deliberately failed GLB requests produced a readable retry message.
Holding W while uncovered left tick and position unchanged; restoring requests
resumed tick 11 to 91. Two late detailed and two late distant loads were disposed
after a destination change. Final texture residency was 154.01 MiB, with no
unexpected browser errors. These are labelled teleport/failure fixtures;
the separate driving and walking records establish continuous travel.

The native browser benchmark passes 8/8 for each preset on the NVIDIA RTX
3070 Ti / D3D11, Chromium 153.0.8010.12, 1280 x 720 viewport, seed 2026:

| Native spawn / Unioninkatu / drive samples | Low | Standard |
| --- | --- | --- |
| Lowest scene average FPS | 143.6 | 139.4 |
| Maximum submitted triangles | 490,307 | 710,752 |
| Maximum draw calls | 243 | 217 |
| Local first-ready time | 4.27 s | 4.98 s |
| Transfer before first control | 104.4 MB | 124.5 MB |

Evidence: `native-low-final/browser.json`, `native-standard-final/browser.json`.
Their `frameMsP95` is the game's smoothed work-time statistic, not a raw
presentation-interval trace. These are desktop 720p measurements, including the
standard preset, not a 1080p or integrated/mobile GPU certification. Local
transfer timing does not establish the plan's 20 Mbit/s startup target: the
measured initial transfer itself exceeds the historical 20 MB target. Further
startup asset/physics partitioning is needed for that separate download goal.

The first native journey (`journeys-final/`) also remains a failed diagnostic.
An exit began, then correctly unwound when chassis speed rose to 0.331 m/s above
the 0.3 m/s safety threshold. All measured doorways were clear. The harness had
held S before F and never retried after `vehicleExitBlocked`, so subsequent
combat/respawn checks never reached their intended state. Exact replay
`21b8df08` and `exit-diagnosis.json` bind that finding. The harness now lets F
perform its built-in stop and makes bounded retries through real controls;
the runtime's door and motion safety rules remain intact. A subsequent retry-only
diagnostic passed the first run but still bounced on the second. The final
harness actually retreats at least 6 m over 3 seconds, brakes and waits for a
stable stop before F. Both diagnostic journeys then passed in 48.1/46.8 seconds
with exact replays `ddb5b1f5` / `ad0daff4`; the 75-second limit is unchanged.

## Repaired candidate v4

Content `senate-20261017-185c7a1b`, manifest SHA-256
`96a66fa54e20c3f7d8ece20b651d12549276d315753350f20152de371be89312`,
comes from `cells-v4`, `roads-v2`, `gameplay-v2` and the same eight asset files.
All 147 GLBs validate with zero errors; the stored pack is 406.7 MB. The review
runtime remains byte-identical to `index-cgsoDyHf.js` above.

The failed road cut came from OSM retaining wall 87053923 crossing current
surveyed carriageway 56749. The ground builder now reconciles that wall to
narrow surveyed wall 470907. Exactly one wall changes; source terrain remains
exact. At Z 133.7, X -157.75 to -157.5, the former 1.111608 m drop becomes a
2.41 mm height difference. The real lower driveway stays lower, with its cut
beyond the drivable lane edge. Only collision cells `c_m02_p00` and `c_m02_p01`
change. All non-ground geometry, facade images and monument collision remain
exact; 79 safety-heightfield samples change beneath the corrected geometry.

`world-v4-final/world.json` passes 13 checks, including 660,100 full-width lane/wheel
probes and 37,063 centreline samples. The new probes start above decoded visual
ground and check support and continuity separately. All 69 former abrupt
carriageway steps are eliminated; no support mismatches remain. The 12 residual
lane-registration flags are recorded explicitly: 11 at the existing Kirkkokatu
stair/road boundary and one at a Unioninkatu sidewalk. Their ground is unchanged;
this result does not certify that every OSM lane offset matches every curb.

Routing no longer includes unsupported underground access ramps and closed
driveways merely because their short surface approach lacks a `tunnel` tag.
`road-approaches.ts` follows explicit parking-entrance nodes, isolated tunnel
connections and gated/private driveway nodes, stopping propagation at public
junctions and ordinary roads. Four focused tests cover those boundaries. The
report records 77 excluded ways from the previous graph; public streets remain,
and junction merging reduces the graph to 960 lanes / 1,232 connectors. Gameplay,
including original spawn points, cars, mission and patrol, remains byte-exact.

All 222 tests and the complete TypeScript check pass. The final runtime checks
below bind this repaired candidate; candidate v3 remains diagnostic.

### Final v4 diagnostics and source isolation

The first v4 drive (`drive-v4-final/`) crossed the corrected Fabianinkatu
strip with zero recoveries, zero missing-coverage pauses and no browser errors.
It then exceeded the unchanged 240-second return-leg deadline after browser
frame delivery slowed. Its 18,346-tick recording replays exactly as `98cb0255`.
This is retained as a failed diagnostic, not a completed drive. Passive frame
interval, visibility and task-duration probes are used for the next attempt;
the application and test deadlines are not changed to conceal the failure.

`streaming-failures-v4-final/` passes all 10 checks on the final manifest and
review bundle. The initial v4 walking attempt also timed out during slow frame
delivery; its residency checks passed. The initial standard fixture test observed
fewer GPU allocations on its second return despite identical retained texture
bytes: its fixed 150 ms heading waits did not guarantee a rendered frame. The
harness now waits for actual rendered frames and the camera's settling interval,
with the same resource tolerances. These initial results remain in
`browser-low-v4-final/` and `browser-standard-v4-final/`.

During these checks, another session began changing Finn's vehicle interactions,
camera and simulator in the shared workspace. Those edits are preserved. This
expansion candidate is isolated in `data/work/expansion-20261017/frozen-candidate`:
all 240 inventoried source files match `source-snapshot-v4.json`, except explicitly
recorded verification-only instrumentation. Concurrently changed application files
were recovered byte-for-byte from the tested bundle's source map and verified
against the earlier hashes. Local package imports resolve to the isolated packages.
The isolated candidate passes typecheck and all 222 tests; see `frozen-checks/`.
This does not certify the other session's unfinished changes.

### Browser scheduling diagnosis

`scheduling-baseline/trace.json` attributes the long gaps to Chromium's
`GpuVSyncThread` / `WaitForVSync Sleep`: the longest 2,115.8 ms animation-frame
gap coincides with a 2,115.7 ms VSync sleep. The game renderer's longest main-thread
task was 7.56 ms, with no long-task events or long GC pause. Headful mode,
frame-rate flags and fresh installed Chrome/Edge profiles reproduced the stalls.
The machine-wide display/power settings were not changed.

The same Chromium 153 executable and exact game bundle using NVIDIA ANGLE Vulkan
produced 601 simulation ticks and 1,415 frames in 10.002 seconds, with 7 ms p95
and 20.8 ms maximum frame intervals, no long tasks and no VSync sleep events.
See `scheduling-vulkan/`. The final verification commands explicitly set
`HELSINKI_VERIFY_ANGLE=vulkan`; the helper's default remains `d3d11`.
This is a test-browser backend choice, not a shipped game change or a claim
that this Windows D3D11 timing issue is fixed for all browsers.


### Final v4 gameplay regression

`journeys-v4-frozen-final/journey.json` passes both real-control journeys, all
18 checks each, on the final release and frozen simulator. Wasted/respawn takes
45.65 simulation seconds with matching browser/Node replay `64b9e34d`;
busted/respawn takes 46.83 seconds with matching replay `1bf2abd1`. Each run
walks, enters and drives, provokes pursuit, retreats more than 6 m, exits on
the first attempt, fires, respawns on supported ground with 12/48 ammunition,
and fires again through mouse input. No browser errors occurred. The existing
75-second simulation limit is unchanged. `journeys-v4-frozen-final-binding.json`
records the exact bundle and the explicit NVIDIA Vulkan test backend.

### Final v4 streaming and native measurements

`browser-low-v4-vulkan/results.json` passes 50/50 checks, including all seven
continuous keyboard walking waypoints out to Kluuvi and back. Its 211 movement
samples contain no missing nearby ground, browser errors or resource-budget
violation. `browser-standard-v4-vulkan/results.json` passes 43/43 fixture checks.
Both fixture circuits now settle actual rendered views before comparison.

| Final repeated-view checks | Low, including walking | Standard |
| --- | --- | --- |
| Startup detail / distant cells, of 69 | 12 / 28 | 16 / 40 |
| Maximum detail / distant resident cells | 15 / 28 | 21 / 42 |
| Maximum retained textures | 155.34 MiB | 261.68 MiB |
| Maximum detail / distant geometry buffers | 14.87 / 9.54 MiB | 22.87 / 12.87 MiB |
| Same-view return texture memory, both visits | 153.34 MiB | 201.68 MiB |
| Same-view GPU textures / geometries, both visits | 141 / 202 | 186 / 258 |
| Observed JS heap range | 239.60–386.82 MiB | 289.64–489.96 MiB |
| Maximum of 24 heading views, triangles / draw calls | 382,993 / 181 | 738,065 / 188 |

The native benchmark passes 8/8 checks for each preset, using Chromium
153.0.8010.12, NVIDIA RTX 3070 Ti through ANGLE Vulkan, seed 2026 and **1280 x 720
for both presets**. Evidence: `native-low-v4-vulkan/` and
`native-standard-v4-vulkan/`.

| Native spawn / street / drive samples | Low | Standard |
| --- | --- | --- |
| Lowest scene average FPS | 143.7 | 124.0 |
| Maximum submitted triangles | 490,305 | 710,752 |
| Maximum draw calls | 242 | 217 |
| Local first-ready time | 5.18 s | 5.74 s |
| Transfer before first control | 104.4 MB | 124.5 MB |
| Retained textures at final native sample | 151.7 MiB | 271.0 MiB |

The earlier limits still apply: these are short desktop checks, not a mobile,
1080p-standard, total-process-RAM, hours-long-soak or 20 Mbit/s startup
certification. The ordinary and review builds reproduced from the isolated
source have the expected identical runtime hashes: ordinary `index-CaCVE3GV.js`
(`a0e111ce638d1d694223474fc26106dd6c2c96311764cb466c8d047056b4051f`) and review
`index-cgsoDyHf.js` (`0b7cb3f689564afe6c62e802fa2de1df9c6aec91d809729848289f5ade64266c`).

### Final drive and ordinary activation

`drive-v4-frozen-tracking-final/journey.json` passes the full 2,663.37 m directed
loop through Kluuvi, Stockmann's eastern frontage and Esplanadi, returning to
Senate Square and exiting on foot. It uses real keyboard input, no teleports,
no explicit stepping and zero recovery commands. Browser traversal takes
308.5 seconds; the unchanged limits are 240 seconds per leg and 600 overall.
All 18,503 recorded ticks replay exactly as `60a4d922`. The 307 samples peak
at 447,354 triangles, 224 draws and 155.68 MiB retained textures, with no missing
coverage holds or browser errors. The 43,276 frame intervals include no gap
over 100 ms; the maximum is 69.4 ms.

The earlier Vulkan attempt in `drive-v4-frozen-final/` is a failed diagnostic.
Its full A/D pulses oscillated across the narrow lane edge into the lower
entrance. Dense replay isolated the steering error: there were no chassis
contacts before a wheel left the supported carriageway. The verification
driver now feeds back steering angle and yaw rate, with 20 ms keyboard polling;
runtime physics, ground, speed target and recovery/deadline gates are unchanged.
The final crossing audit covers both former failure positions, with 592 wheel
rays, zero missing support and zero chassis/skid contacts. The outer tire
footprint stays within the 1.5 m half-lane (maximum 1.3805 m). The target speed
cap is 10 m/s; measured speed briefly reaches 10.22 m/s on the grade.

The final source inventory contains 244 files and has SHA-256
`036e06e483c63661f93ac346466010f11f3b30c8fc9a1ab11abe5982ca720c82`.
All remain exact in the frozen candidate; the final complete TypeScript check
also passes after the verification-driver changes. Fresh ordinary and review
builds reproduce the expected bundle hashes. The shared workspace's concurrent
vehicle changes were preserved and are outside this acceptance.

`production-active-final/results.json` passes all eight ordinary-page checks:
the default release is the expansion, only 16 of 69 detailed cells are requested
at startup, travel to Esplanadi requests new cells, HUD and credits render, and
the review adapter remains absent even with `?review=1`. There are no browser
errors. The ordinary Senate and Esplanadi captures were opened and reviewed;
`opened-captures-v4.json` records the individual views and their limits.

The single game preview was restarted on strict port 5317, PID 30308. Port 5173
continues to belong to the independent Finn Motion Lab. The first launch used
an incorrect Vite executable path and failed before serving; its connection
refused smoke is retained under `production-final/`. The corrected launch uses
`apps/game/node_modules/vite/bin/vite.js`; the subsequent ordinary smoke passes.

`activation.json` records both live pointers and the pre-activation review
archive. The prior content release `senate-20261017-a236a318` is retained for
content rollback with the compatible ordinary runtime. The archived previous
server binary is the review build, not the original accepted ordinary binary.
Neither historical package size nor these bounded texture/geometry budgets
are a total-browser-memory guarantee. Collision remains resident and further
startup-download reduction remains future work.
