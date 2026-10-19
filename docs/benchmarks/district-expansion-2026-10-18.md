# Mannerheimintie and Uspenski district verification

## Candidate 7fc03703 / runtime-v6: locally active, affected acceptance PASS

Status: source/output/static checks, opened bank/native images and all seven
fresh affected native jobs PASS. The suite ran from 19:58:22 to 20:17:43 UTC on
2026-10-18. The completed
[scoped affected-acceptance receipt](../../data/evidence/district-expansion-20261018/scoped-acceptance-bank-v2.json)
records `PASS_AFFECTED_ACCEPTANCE`. Local activation, the owned preview restart,
HTTP identity checks and the ordinary UI smoke are complete. The
[final integration receipt](../../data/evidence/district-expansion-20261018/integration-bank-v1.json)
records `PASS_LOCAL_ACTIVE_ORDINARY` at 20:24:22 UTC; the ordinary game is live at
<http://127.0.0.1:5317/>. The governing
[scoped acceptance plan](../../data/evidence/district-expansion-20261018/scoped-acceptance-bank-v1.json)
preserves the failed old-input comparison and keeps the earlier complete western
walk and eleven-goal drive under their original a706b755 identity.

The active local release is `senate-20261018-7fc03703`, manifest SHA-256
`954782564d93cc59a6919c9e598cd77f3813b2b9860d766fe389b0df5d5b089d`.
Its `cells-abutments-v1` index is
`f3d37e78be20236d6ab970e8d08052ac90fd0f2e3e1491799cfd320f64a8198b`.
Frozen bank-producer-v1 contains 225 files, inventory
`88b92161bfbc4cf8f9e7c1674ff83a26095926b3052d23d59aacbe16a5a2d1f5`,
as bound by [the producer lock](../../data/evidence/district-expansion-20261018/bank-producer-lock-v1.json).
Runtime-v6 remains byte-bound to inventory
`593e49cdd532be3f35343e37ed1d2759def8b3619eb9cc9a0fbe71cbfba589cd`,
review JS `8ee16a7706240a82a766f85051a148cb5d46a3464d5011f598d2da346a9d33ce`
and the namespaced `district-review-v6.html` route. The ordinary JS binding is
unchanged at `d05d80c892ff4e92e10e9265ae84256ce42e213c3148d46db619521509358db5`.

The repair adds 23 double-sided vertical bank quads, 92 triangles per visual
tier/HCOL representation, in `c_p02_m07`, `c_p02_p00` and `c_p02_p01`.
It follows six source-bank intervals totalling 13.876106 m. Original floors,
terrain, roads, gameplay, scenery and eight assets are unchanged; original
collider item order/IDs and typed-array prefixes are retained. Three existing
ground meshes intentionally acquire new collision suffixes. This physical
change is not described as a texture-only repair or whole-physics equivalence.

### Completed checks on 7fc03703

| Check | Actual result | Evidence |
| --- | --- | --- |
| Frozen bank producers | PASS; 104/104 tests, zero skipped; world and verifier typechecks | [bank-producer-final-checks-v1.json](../../data/evidence/district-expansion-20261018/bank-producer-final-checks-v1.json) |
| Serialized release and immutable staging | PASS; 483 GLBs validated; 724 payload files, 1,240,551,957 bytes; pointers unchanged at the staging checkpoint, before activation below | [publish log](../../data/evidence/district-expansion-20261018/publish-bank-v1.log), [stage receipt](../../data/evidence/district-expansion-20261018/stage-bank-v1.json) |
| Actual decoded world | PASS; 21/21 checks | [world-bank-v1-final/world.json](../../data/evidence/district-expansion-20261018/world-bank-v1-final/world.json) |
| Actual vertical closures | PASS; 250,136 triangles across 160 cells; maximum absolute normal Y is zero | [vertical-ground-bank-v1.json](../../data/evidence/district-expansion-20261018/vertical-ground-bank-v1.json) |
| Actual road physical probes | PASS; 512 body/skid queries and 2,412 tyre probes; zero collisions or missing support | [road-physical-bank-v1/result.json](../../data/evidence/district-expansion-20261018/road-physical-bank-v1/result.json) |
| Actual bank suffixes and old sky-ray controls | PASS; all 1,005 original sky-pixel rays hit front-facing decoded LOD0, LOD2 and HCOL, 3,015 hits; 237 collider ID lists checked | [actual-output checker v2](../../data/evidence/district-expansion-20261018/bridge-abutments-actual-output-v2.json), [checker invariants](../../data/evidence/district-expansion-20261018/bridge-abutment-checker-invariant-v2.json) |
| Opened bank images | PASS for the 28 listed images: 14 natural low/standard and 14 forced-distant component views | [opened-bank-images-v1.json](../../data/evidence/district-expansion-20261018/opened-bank-images-v1.json) |

Forced LOD2 captures are component diagnostics only. They establish the displayed
coarse bank geometry in those views, not natural tier selection, streaming or
performance. The natural views use the unmodified release. These opened images
and exact ray controls address the known abutment gap; they do not imply a
whole-map visual inspection. Fresh native acceptance is recorded below.

### Completed local activation and ordinary integration

Both `apps/game/public/world/current.json` and
`apps/game/dist/world/current.json` now select 7fc03703. The ordinary page uses
`/district-ordinary-v7-assets/index-RJvTkfS8.js`, retaining the runtime SHA above;
its index SHA is
`a14ba681c0ec30ee18d61154820fb5495ebf8f2770cdd279be1a729420139d59`.
The previous `senate-20261017-185c7a1b` pointers and ordinary page are retained in
`data/work/district-expansion-20261018/activation-rollback-bank-v1-runtime-v6`.

| Local integration check | Actual result | Evidence |
| --- | --- | --- |
| Activation | Both pointers and the ordinary index changed to the bound new release | [activation-bank-v1.json](../../data/evidence/district-expansion-20261018/activation-bank-v1.json) |
| Owned preview restart | PASS; verified old game PID 30308 replaced by PID 37360 on 5317; motion lab PID 2344 on 5173 preserved | [restart receipt](../../data/evidence/district-expansion-20261018/preview-restart-bank-v1.json), [executed v2 script](../../data/work/district-expansion-20261018/restart-game-preview-bank-v2.ps1) |
| HTTP identities after restart | PASS; ordinary index, current pointer, manifest and namespaced ordinary JS match their recorded hashes | [http-bank-v1.json](../../data/evidence/district-expansion-20261018/http-bank-v1.json) |
| Actual ordinary UI smoke | PASS; 8/8, default Senate startup and three UI drop-ins, HUD/credits present, no browser errors, review API absent even with `?review=1` | [ordinary results](../../data/evidence/district-expansion-20261018/ordinary-bank-v1/results.json) |
| Opened ordinary images and final integration | Root opened all four ordinary PNGs; `PASS_LOCAL_ACTIVE_ORDINARY` | [integration-bank-v1.json](../../data/evidence/district-expansion-20261018/integration-bank-v1.json) |

The first restart attempt's `Stop-Process` exception changed neither verified
process. Its [failure receipt](../../data/evidence/district-expansion-20261018/preview-restart-cmdlet-failure-v1.json)
is retained. The successful v2 script keeps the ownership guards and replaces
only that stop command with native `taskkill` for the single verified game PID.

The ordinary smoke requests 16 detailed cells of 237 at startup and 51 distinct
detailed cells after the Lasipalatsi, Uspenski and Esplanadi UI drop-ins. This is
startup/on-demand-loading evidence, not an extra full journey or mobile
benchmark. Together, root's opened reviews cover 50 new images: 28 bank views,
18 fresh native captures and four ordinary captures. This local acceptance
does not claim an exhaustive visual inspection of the city.

### Strict old-input comparison remains FAIL

[bank-replay-v1/comparison.json](../../data/evidence/district-expansion-20261018/bank-replay-v1/comparison.json)
retains `FAIL_DERIVED_PRIOR_INPUT_EQUIVALENCE`. Compared public state, digest,
events and dynamic-body fields match through tick 35,937, then differ at tick
35,938 while replaying the original 50,062-tick recording. The native hash is
still `4d940f94` on both sides at that first strictly differing tick; the exact
field comparison is stronger than that hash alone. Old/new final hashes are
`f8e65e75` / `6b61aca5`; there is no old post-divergence trajectory claim.

The scoped plan records a read-only diagnosis: inputs, state, forces and torque
match before the raycast vehicle-controller update, while six linear/angular
velocity fields differ immediately after it. The wheels use the rebuilt existing
ground collider. Its automatically computed fixed-body mass properties changed;
those properties are a candidate mediator, not proven private-controller
causality. The nearest added face is approximately 58.43 m away and no chassis/
skid contact manifold was present at the first differing ticks. Distance alone
is not an unaffected-query proof, especially with globally roaming police.
Neither tolerance changes nor global mass/density changes were used to force
the old hash to match.

### Fresh affected native scope

The [seven-job execution receipt](../../data/evidence/district-expansion-20261018/gpu-suite-bank-v1.json)
binds this new manifest and unchanged runtime and records
`PASS_FRESH_AFFECTED_NATIVE_GATES`. None of the a706b755 metrics below is
relabeled as new-release evidence.

| New-release job | Required scope | Result and evidence |
| --- | --- | --- |
| Eastern low keyboard walk plus low fixtures | 188 eastern waypoints out-and-back, then all eight landmark stops in repeated low circuits | PASS; 212/212 checks, 1,893.877239 m, zero forbidden events; 321.082 s route / 380.444 s wrapper; [results](../../data/evidence/district-expansion-20261018/east-walk-low-bank-v1/results.json) |
| Low browser benchmark | Fresh startup, entry/driving and renderer/resource checks | PASS; 9/9, 54.293 s wrapper; [results](../../data/evidence/district-expansion-20261018/browser-low-bank-v1/browser.json) |
| Standard fixtures | All repeated standard view/residency/return fixtures | PASS; 23/23, 64 headings, 61.716 s wrapper; [results](../../data/evidence/district-expansion-20261018/fixtures-standard-bank-v1/results.json) |
| Standard browser benchmark | Fresh standard startup/driving and renderer/resource checks | PASS; 9/9, 54.226 s wrapper; [results](../../data/evidence/district-expansion-20261018/browser-standard-bank-v1/browser.json) |
| Eastern drive and own replay | Six goals, real entry/drive/return/exit, zero recoveries, 700 s cap and 10 m/s target | PASS; nine checkpoints, 3,315.598533 m planned road loop; 417.304 s journey / 429.457 s wrapper; own 23,198-tick replay `425b872c` matches with null first divergence; [journey](../../data/evidence/district-expansion-20261018/east-drive-bank-v1/journey.json), [replay](../../data/evidence/district-expansion-20261018/east-drive-bank-v1/replay.json) |
| Native gameplay journeys | Both endings, two new-release runs | PASS; 2/2, 163.025 s wrapper; wasted/busted recording replays `12086b4a` / `a8536be5`, 4,531 / 2,909 recorded ticks; [journey](../../data/evidence/district-expansion-20261018/native-journey-bank-v1/journey.json), [wasted recording](../../data/evidence/district-expansion-20261018/native-journey-bank-v1/run-01-recording.json), [busted recording](../../data/evidence/district-expansion-20261018/native-journey-bank-v1/run-02-recording.json) |
| Streaming failures | Fresh 404/delay/stale-completion and retry fixtures | PASS; 10/10, 15.012 s wrapper; 20 deliberate 404s, final coverage unblocked with no missing cells, 126.68 MiB texture estimate; [results](../../data/evidence/district-expansion-20261018/stream-failures-bank-v1/results.json) |

### Fresh affected measurements

These numbers belong to 7fc03703/runtime-v6 and the linked fresh receipts above.
The eastern-walk receipt includes startup and repeated low fixtures; its route
clock and 570 moving samples are identified separately. Standard fixtures
remain within their actual 320 MiB texture limit, not a substituted lower limit.

| Recorded measurement | Low | Standard |
| --- | --- | --- |
| Settled fixture heading maximum triangles / calls | 496,740 / 285 | 855,322 / 197 |
| Fixture job maximum over all recorded samples | Included in eastern-walk totals below | 856,669 triangles / 198 calls |
| Short browser benchmark maximum triangles / calls | 467,971 / 275 | 729,703 / 211 |
| Lowest browser benchmark scene average FPS | 143.355 | 137.698 |
| Full walk/fixture job or standard-fixture texture peak | 155.510381 MiB / 160 MiB limit | 240.023631 MiB / 320 MiB limit |
| Short browser benchmark uploaded textures | 152.3 MiB | 231.0 MiB |
| Walk/fixture detail / distant geometry peaks | 26.742027 / 17.745420 MiB | 38.776678 / 23.530220 MiB |
| Repeated return texture estimates | 153.676656 MiB both circuits | 211.597585 MiB both circuits |
| Repeated return renderer textures / geometries | 154 / 347 both circuits | 208 / 293 both circuits |
| Short browser benchmark readiness | 8.230419 s | 8.335224 s |
| Browser benchmark transfer before control | 167.9 MB | 189.8 MB |
| Walk/fixture readiness / started-and-settled | 8.234 / 8.932 s | 8.230 / 8.921 s |
| Walk/fixture transferred bytes at startup | 164,376,144 | 186,334,728 |

The new eastern walk's raw moving maximum is **507,969 triangles**, 250 calls
and 155.510381 MiB textures. Two of its 570 moving samples exceed 500,000
triangles, including tick 2,611 near XZ `[217.208,46.007]`. The settled fixture
headings still pass the 500,000 assertion. The full walk/fixture job has 668
recorded samples and reaches 285 calls. This distinction preserves the same
budget nuance as the historical full-city runs below; the 212/212 result is
not a claim that every moving view meets the triangle limit.

Across those 570 moving samples, FPS minimum / arithmetic mean is
125.975 / 143.356, with no zero or sub-30 FPS samples. Recorded smoothed CPU
frameMs median / nearest-rank p95 / maximum is 3.520 / 3.860 / 5.222 ms.
Sampled draw calls and texture estimates remain below 350 / 160 MiB. These
figures do not measure unsampled frames, total RAM or GPU presentation latency.

The fresh six-goal East drive also has observed moving triangle overruns:
**516,944 triangles**, with four of its 370 driving samples above 500,000.
Maximum sampled calls are 284 and textures 155.759267 MiB. Moving FPS
minimum / arithmetic mean is 119.976 / 143.064; smoothed CPU frameMs
median / nearest-rank p95 / maximum is 3.615 / 4.025 / 4.519 ms. These remain
below the sampled draw/texture and 30-FPS thresholds, but do not constitute a
whole-route triangle-budget PASS. The successful own-release replay does not
replace or overturn the failed cross-release comparison above.

Root opened all 18 new native captures: nine from the eastern walk/fixtures and
all nine eastern-drive checkpoint images, with paths and hashes in
[opened-bank-native-v1.json](../../data/evidence/district-expansion-20261018/opened-bank-native-v1.json).
That review is separate from the 28 bank component/natural views. Both native
gameplay endings restore the pistol to 12 loaded / 48 reserve rounds and verify
real mouse firing after respawn in the same document. Their recording tick
counts include the full recorded command sequence; the journey's elapsed
simulation ticks are separately 4,457 / 2,806. The request-failure run's 20
deliberate 404 console messages are expected, with no unexpected errors claimed.

This is not a new full western walking tour or complete eleven-goal city drive.
Those prior runs and their observed triangle overruns remain historical evidence
below. The completed scoped receipt accepts the bounded bank repair on its
source/prefix/physical/art proofs and seven fresh affected checks while retaining
the strict old-input FAIL. Local activation, restart, HTTP identity checks and
ordinary startup/drop-in integration have their own completed receipts above.
No cross-release replay PASS, new full-western native tour or automatic test
reuse is claimed.

## Historical candidate a706b755 / runtime-v6

Historical status: offline checks and all eight native jobs PASS; activation was
held after the opened drive image exposed the Kanavakatu eastern bridge-bank
opening at source `Silta 48393`. The suite ran from 18:07:02 to 18:52:23 UTC on
2026-10-18. The original
[activation hold](../../data/evidence/district-expansion-20261018/activation-art-hold-closure-v5.json)
forbids activating that candidate while unresolved. The separate 7fc03703 repair
and its completed scoped affected acceptance are recorded above. No a706b755 activation
or rollback-pointer change is claimed. Its raw travel triangle overruns are also
disclosed below; PASS receipts do not prove every-frame budget compliance.
Earlier 717a9536 measurements remain historical.

The staged release is `senate-20261018-a706b755`, manifest SHA-256
`3288dd775f525313b50dc40f39c68d4a6c92eb2ab4e6ee533c137c1fd0ef9646`.
It contains 237 cells over the same 3.01 km² playable rectangle and eight
unchanged hero/scenery assets. The 2017 mesh remains excluded. Its final cell
index is `0c800253d6a2edf8a29e72d03f025bbf7ed08a75b610ad89ff910cb0956e2c90`.

Frozen runtime-v6 inventory:
`593e49cdd532be3f35343e37ed1d2759def8b3619eb9cc9a0fbe71cbfba589cd`.
Frozen street-producer-v1 inventory:
`e64f54d470482155e8a2c3bc0a5e83213dd044d0561be6304f2502e4568bc14d`.
Their receipts are [runtime-source-v6.json](../../data/evidence/district-expansion-20261018/runtime-source-v6.json)
and [street-producer-lock-v1.json](../../data/evidence/district-expansion-20261018/street-producer-lock-v1.json).
Runtime-v6 retains the audited vehicle renderer changes and their required pose
JSON imports; new-car GLBs and the separate live central-expansion gameplay are
not part of this pack. The fresh startup measurements below include these
compiled inputs; earlier runtime-v5 timings are not reused.

The review build is `index-CggY-Yvi.js`, SHA-256
`8ee16a7706240a82a766f85051a148cb5d46a3464d5011f598d2da346a9d33ce`;
the ordinary build is `index-RJvTkfS8.js`, SHA-256
`d05d80c892ff4e92e10e9265ae84256ce42e213c3148d46db619521509358db5`.
[Both emitted builds and their source-map bindings were revalidated](../../data/evidence/district-expansion-20261018/runtime-build-v6-revalidation.json).
The build wrapper's nonzero result followed chunk-size warnings; the independent
receipt checks the actual successful outputs. Shared concurrent work uses other
build artifacts, so this suite owns the namespaced review route
`http://127.0.0.1:5317/district-review-v6.html` and
`/district-review-v6-assets/index-CggY-Yvi.js`, as recorded in
[the namespaced-stage receipt](../../data/evidence/district-expansion-20261018/stage-runtime-v6-namespaced.json).

### Completed offline checks on a706b755

| Check | Actual result | Evidence |
| --- | --- | --- |
| Frozen runtime tests and typechecks | PASS; 365/365 tests, zero skipped; five TypeScript projects | [frozen-checks-v6.json](../../data/evidence/district-expansion-20261018/frozen-checks-v6.json) |
| Frozen street/content producer checks | PASS; 96/96 tests, zero skipped; world and verifier typechecks | [street-producer-final-checks-v1.json](../../data/evidence/district-expansion-20261018/street-producer-final-checks-v1.json) |
| Serialized GLBs and immutable staging | PASS; 483 GLBs validated; 724 payload files, 1,237,882,561 payload bytes; pointers unchanged | [publish log](../../data/evidence/district-expansion-20261018/publish-closure-v5.log), [stage receipt](../../data/evidence/district-expansion-20261018/stage-closure-v5.json) |
| Actual decoded world and retained roads | PASS; all 21 checks, including public/service vehicle footprints, water exclusions, accepted-area preservation and eight byte-exact assets | [world-closure-v5-final/world.json](../../data/evidence/district-expansion-20261018/world-closure-v5-final/world.json) |
| Actual vertical ground closures | PASS; 250,044 triangles across 160 changed cells; maximum absolute normal Y is zero | [vertical-ground-closure-v5.json](../../data/evidence/district-expansion-20261018/vertical-ground-closure-v5.json) |
| Actual road throat/junction vehicle geometry against final HCOL | PASS; 512 body/skid queries and 2,412 tyre probes; zero collisions or missing support | [road-physical-closure-v5/result.json](../../data/evidence/district-expansion-20261018/road-physical-closure-v5/result.json) |

### Producer paving and rail costs

These are exact producer counts and allocation estimates, not observed scene
peaks. Paving changes the appearance of 26,176 existing triangles in 38 cells;
positions, winding and collision remain intact. The 383-part report retains
543 unqualified partial/ambiguous faces with their original material. All 50
Senate fan panels have reported coverage; one 0.534761 m² face near the monument
keeps its original cobble because the bounded native-precision proof did not
qualify it. The raw footprint also includes 0.121846 m² with no eligible rejected
fan face. These exceptions are recorded, not treated as complete square coverage.
See [the surface coverage summary](../../data/evidence/district-expansion-20261018/street-surfaces-v3/coverage-summary.json)
and [actual resurfacing proof](../../data/work/district-expansion-20261018/cells-trams-v1/ground-resurfacing-proof.json).

| Added visual content | Producer-bound cost | Limit or interpretation |
| --- | --- | --- |
| Original regular/fan paving | Two 256² texture variants; 87,408 BC7 mip bytes per variant/owner | At most two extra detailed draws per cell; zero extra distant draws |
| Conservative low paving residency allowance | 3,146,688 BC7 bytes for both variants across 18 resident/incoming owners | Allocation estimate, separate from observed scene texture peaks below |
| Actual Mannerheim tram axes | 92 ways, 4,271.545657 m of source track centreline across 18 cells | Source axes retained; visual-only rails, HCOL unchanged |
| Serialized rail triangles | 22,451 detailed and 21,497 distant triangles | Each below its unchanged 25,000 producer cap |
| Original rail stripe | 44 × 4 pixels; 956 RGBA mip bytes per owner | One extra detailed draw per rail owner; zero extra distant draws |
| Combined final detailed cell draws | Maximum 16 | Unchanged per-cell limit 60; native scene limits remain low 350 / standard 600 |

Rail counts and stripe costs come from the
[final rail plan](../../data/evidence/district-expansion-20261018/street-surfaces-v1/tram-final-plan-v1.json)
and [actual compressed-output verification](../../data/evidence/district-expansion-20261018/street-surfaces-v1/tram-actual-output-v2.json).
The 0.001409 m² source-ribbon coverage remainder is retained in the producer
report; it is not an invented support floor. Static collision is unchanged at
102,900,428 encoded bytes, plus 12,054,232 terrain bytes. These resident physics
costs are separate from streamed visual detail and texture residency.

### Native measurements and acceptance on a706b755

The [exact-candidate suite receipt](../../data/evidence/district-expansion-20261018/gpu-suite-closure-v5.json)
binds the manifest, review bytes and frozen runtime inventory above. All eight
jobs completed successfully. These are behavior and resource-check results;
the separate image finding prevents final visual acceptance.

| Native job | Result | Metrics and visual review |
| --- | --- | --- |
| Low repeated landmark fixtures | PASS; 23/23 | Two circuits, 64 headings; [results](../../data/evidence/district-expansion-20261018/fixtures-low-closure-v5/results.json) |
| Low startup, entry and short driving benchmark | PASS; 9/9 | Three benchmark scenes; [results](../../data/evidence/district-expansion-20261018/browser-low-closure-v5/browser.json) |
| Continuous low keyboard walk | PASS; 490/490 | 5,979.832389 m over 465 waypoints; both routes return to Senate Square with zero forbidden events; [results](../../data/evidence/district-expansion-20261018/walk-low-closure-v5/results.json) |
| Standard repeated landmark fixtures | PASS; 23/23 | Two circuits, 64 headings; [results](../../data/evidence/district-expansion-20261018/fixtures-standard-closure-v5/results.json) |
| Standard startup/driving benchmark | PASS; 9/9 | Actual selected standard preset; [results](../../data/evidence/district-expansion-20261018/browser-standard-closure-v5/browser.json) |
| District drive and replay | PASS; 11 goals, zero recoveries | 7,577.042469 m planned road loop, real entry/return/exit; 900.844 s journey / 914.079 s wrapper; replay `f8e65e75` matches over 50,062 ticks; [journey](../../data/evidence/district-expansion-20261018/drive-final-closure-v5/journey.json), [replay](../../data/evidence/district-expansion-20261018/drive-final-closure-v5/replay.json) |
| Two native gameplay journeys | PASS; 2/2 | Wasted and busted outcomes, respawn ammunition/fire checks and matching replays `ba7fb379` / `3a05dfb0`; [results](../../data/evidence/district-expansion-20261018/native-journey-closure-v5/journey.json) |
| Streaming request failures | PASS; 10/10 | 20 deliberate 404s and two held requests; visible loading/error, blocked unsafe traversal, retry recovery and stale disposal; [results](../../data/evidence/district-expansion-20261018/stream-failures-closure-v5/results.json) |

The continuous walk covers the western Mannerheim route in 683.241 s and
4,070.317977 m, then the Uspenski return route in 323.871 s and 1,909.514412 m.
Its 1,069.775 s receipt includes startup and repeated fixtures as well. The drive
wrapper includes startup/replay overhead beyond the 900.844 s journey clock.
Intentional 404 console messages are expected in the failure fixture; they are
not reported as zero console messages or as unexpected application errors.

### Measured native resources on a706b755

These fresh runs use Chromium 153.0.8010.12, ANGLE Vulkan on an NVIDIA GeForce
RTX 3070 Ti, at 1280 × 720. Source-linked fixture and benchmark receipts are in
the table above. FPS averages are per benchmark scene; uploaded-texture estimates
are separate from renderer allocation counts and browser heap.

| Measurement | Low | Standard |
| --- | --- | --- |
| Fixture job maximum triangles / calls over all recorded samples | 496,740 / 285 | 856,669 / 198 |
| Short native benchmark maximum triangles / calls | 467,971 / 270 | 731,523 / 217 |
| Lowest benchmark scene average FPS | 142.133 | 135.725 |
| Fixture uploaded-texture peak | 153.676656 MiB | 240.023631 MiB |
| Short benchmark uploaded textures | 152.3 MiB | 244.7 MiB |
| Fixture detail / distant geometry peaks | 26.742027 / 17.232016 MiB | 38.776678 / 23.530220 MiB |
| Repeated return texture estimates | 153.676656 MiB both circuits | 211.597585 MiB both circuits |
| Repeated return renderer textures / geometries | 154 / 347, then 154 / 345 | 208 / 293 both circuits |
| Short benchmark readiness | 8.965627 s | 9.325925 s |
| Short benchmark transfer before first control | 167.6 MB | 189.2 MB |
| Fixture readiness / started-and-settled | 12.898 / 13.749 s | 9.703 / 10.431 s |
| Fixture transferred bytes at startup | 164,070,563 | 185,708,219 |

Continuous low travel has a different measured envelope from the settled
fixtures: the walk peaks at **507,309 triangles**, 308 calls and 155.517324 MiB
textures; the drive peaks at **540,663 triangles**, 333 calls and 155.932678 MiB
textures. One of 1,892 walk samples and 13 of 830 drive samples exceed the
500,000-triangle low limit. The walk maximum occurs at tick 43,781 near runtime
XZ `[218.889,45.932]`; the drive maximum occurs at tick 20,721 near
`[-949.968,-286.120]`. These are actual observed overruns, not rounded-to-budget
values. The walk harness asserts triangle/call limits at settled fixture headings;
the drive receipt checks traversal/replay without a triangle-budget assertion.
Their PASS statuses therefore do not establish an all-frame triangle-budget pass.
Draw and texture peaks remain below their low limits. The walking return
allocations are 154 textures / 383 geometries on both circuits.

The following statistics isolate moving-route samples: 1,789 labels beginning
`walk:` and 813 drive samples whose mode is `driving`. Neither subset contains
an uninitialized zero-FPS startup sample. Across all samples, each receipt has
one such startup zero; it is not silently counted as a travel frame rate.

| Moving-route sampled statistic | Walk | Drive |
| --- | --- | --- |
| Minimum / arithmetic mean FPS | 90 / 142.946 | 102 / 142.741 |
| Positive sampled FPS below 30 | 0 | 0 |
| Smoothed CPU frameMs median / p95 / maximum | 3.882 / 4.576 / 6.387 ms | 3.988 / 4.629 / 5.272 ms |
| Maximum submitted calls | 308 | 333 |
| Maximum uploaded-texture estimate | 155.517324 MiB | 155.932678 MiB |

The p95 uses the nearest-rank 95th percentile of the recorded smoothed CPU
statistic. FPS means are arithmetic means of samples, not time-weighted route
averages. These sampled draw/texture/FPS values show no corresponding 350-call,
160-MiB texture or 30-FPS breach; they do not erase the triangle overruns or
measure unsampled frames, total browser/Rapier RAM or GPU presentation latency.

### Opened-image review and activation hold

Two separate pinned reviews record
[25 initial fixture/facade/street images](../../data/evidence/district-expansion-20261018/opened-images-closure-v5.json)
and [all 21 walking captures](../../data/evidence/district-expansion-20261018/opened-walk-images-closure-v5.json).
Each receipt lists that many unique actual image paths. The drive directory
contains 14 PNGs matching its 14 recorded checkpoints, all opened by root;
there is no drive-image PASS disposition while the abutment opening is unresolved.
The specific held image is
[the canal bridge western-approach capture](../../data/evidence/district-expansion-20261018/drive-final-closure-v5/katajanokanlaituri-bridge-western-approach.png).
Behavioral reachability and successful downward support queries do not resolve
this visible gap. No replacement-asset gate rebind is claimed: any later repair
needs an explicit candidate-bound preservation/rebind plan and its required
fresh checks before final acceptance or activation.

Low scene limits remain 500,000 triangles / 350 calls / 160 MiB textures;
standard remains 1,200,000 / 600 / 320 MiB in the frozen native harness. These
are the existing harness limits; none was relaxed for this candidate. The
overruns above remain disclosed alongside the harness outcomes. Native frameMs
measures CPU frame processing, not GPU presentation latency. Desktop loopback
results do not establish mobile performance or the 20 MB / 20 Mbit/s startup
target. Local activation and rollback remain separate root-owned steps after
the unresolved art finding and remaining acceptance concerns are addressed.

## Historical candidate 717a9536 / runtime-v5

Historical status: SUPERSEDED_INCOMPLETE. The 717a9536 suite was stopped for the user's
additional paving and tramway work, as recorded in
[the stopped-suite receipt](../../data/evidence/district-expansion-20261018/gpu-suite-closure-v4-stopped-for-street-work.json).
Only the 23 low fixtures and nine low native browser checks passed; the
continuous walk was interrupted. The measurements below remain bound to
717a9536/runtime-v5 and do not validate the replacement pack, whose final
identity is now recorded above. No full-suite PASS or local activation was claimed.

The historical candidate measured here is senate-20261018-717a9536, manifest SHA-256
4dbc9c9a49557f03b9bddf987df9c61d39dbb54d21e5a182519d2a21de4f140f.
Its playable rectangle is 3.01 km²; 237 cells include the surrounding tiled
coverage. The removed 2017 mesh is absent. Source decisions and reproduction
commands are in [the district build recipe](../district-expansion-build.md).

The frozen runtime-v5 source inventory is
5b1b249872d430469bef11c592775f3846a97159129600bfbb8d94d19d1763c2.
The review entry is index-Dh8cw00i.js, SHA-256
5492107aaae1ad4f8baf2d9866155a26a1d84e08095d8b1795d3c2ca254221e5.
The ordinary entry from the same snapshot is index-CcLGTDfl.js, SHA-256
64a4a0d69a53921c6ade2eab1c3496bf1b12d95eb9e232a88eff1fa3b7280edc.
Their source-map bindings are recorded in
[runtime-build-v5.json](../../data/evidence/district-expansion-20261018/runtime-build-v5.json).
The separate content-producer-v4 inventory is
bc865e6f69069c79c620d9ec48dbb5435a00318205c6313375b3baa12f5dc809;
its receipt retains the filename content-producer-lock-v3.json and explicitly
names the v4 snapshot.

### Completed checks on 717a9536

Evidence is under data/evidence/district-expansion-20261018/. These fresh
results replace the earlier d68943b0 rendering statistics; an earlier candidate's
pass does not validate this release.

| Check | Result | Evidence |
| --- | --- | --- |
| Frozen runtime tests and five TypeScript projects | PASS; 365/365 tests, zero skipped; all five projects | [frozen-checks-v5.json](../../data/evidence/district-expansion-20261018/frozen-checks-v5.json) |
| Frozen content producers | PASS; 66/66 tests, zero skipped; world and verifier typechecks | [content-producer-lock-v3.json](../../data/evidence/district-expansion-20261018/content-producer-lock-v3.json) |
| Published GLBs and immutable staging | PASS; 483 GLBs validated, 724 payload files, 1,217,587,417 payload bytes; no pointers changed | [publish log](../../data/evidence/district-expansion-20261018/publish-closure-v4.log), [stage receipt](../../data/evidence/district-expansion-20261018/stage-closure-v4.json) |
| Actual decoded world and retained roads | PASS; all 21 checks, including public/service vehicle footprints, support, water exclusions and accepted-area preservation | [world.json](../../data/evidence/district-expansion-20261018/world-closure-v4-final/world.json) |
| Actual vertical ground closures | PASS; 250,044 added triangles across 160 changed cells; maximum absolute normal Y is zero | [vertical-ground-closure-v4.json](../../data/evidence/district-expansion-20261018/vertical-ground-closure-v4.json) |
| Actual road throat/junction vehicle geometry against final collision | PASS; 512 body/skid queries and 2,412 tyre probes; zero collisions or missing support | [physical result](../../data/evidence/district-expansion-20261018/road-physical-closure-v4/result.json) |
| Low repeated landmark fixtures | PASS; 23/23 checks, two circuits and 64 headings; stable return allocations | [fixture results](../../data/evidence/district-expansion-20261018/fixtures-low-closure-v4/results.json) |
| Low native startup, car entry and short driving benchmark | PASS; 9/9 checks, including unchanged renderer limits | [browser result](../../data/evidence/district-expansion-20261018/browser-low-closure-v4/browser.json) |
| Opened fixture and facade images | Fourteen actual PNGs opened: all nine early landmarks and all five facade views | [opened-image receipt](../../data/evidence/district-expansion-20261018/opened-images-closure-v4.json) |

Downward support probes cannot establish lateral closure. Candidate 717a9536
added qualified vertical shore, dry-ground-interface and floor-interface faces
to visual and collision payloads. The separate vertical check above validates
the actual serialized triangles. The opened matched views no longer show the
previously measured 228-pixel canal-bank opening or 37-pixel Music Centre seam;
this is evidence for those views, not a claim that every part of the map has
been visually inspected.

### Historical low-preset measurements on 717a9536

The fixture and native benchmark receipts bind the exact manifest and review
runtime above. They use Chromium 153.0.8010.12, ANGLE Vulkan on NVIDIA GeForce
RTX 3070 Ti, at 1280 x 720. Facade captures use 1200 x 850 and are separate
from these performance measurements.

| Fresh low check | Measured | Unchanged limit |
| --- | --- | --- |
| Repeated landmark fixture maximum | 487,094 triangles; 281 draw calls | 500,000; 350 |
| Native startup/short-driving benchmark maximum | 476,570 triangles; 274 draw calls | 500,000; 350 |
| Lowest native benchmark scene average | 142 FPS | 30 FPS |
| Fixture uploaded texture peak | 152.593 MiB | 160 MiB |
| Native benchmark uploaded textures | 151.3 MiB | 160 MiB |
| Same-place renderer allocations, both fixture circuits | 141 textures and 334 geometries each; 152.592992 MiB each | No accumulating return allocations |
| Fixture detail / coarse geometry peaks | 25.807 / 14.630 MiB | 96 / 64 MiB |

The texture estimator separately reports 140 textures at each return, while the
renderer allocation check reports 141; the respective counts and byte estimates
are identical between circuits. These are different accounting surfaces.

The native benchmark reaches readiness in 9.024 seconds and transfers 159.2 MB
before first control on loopback. The independent fixture startup reaches
readiness in 12.403 seconds and started/settled state in 13.039 seconds, with
156,343,367 transferred bytes. Static collision remains resident in deterministic
insertion order: 102,900,428 encoded collision bytes and 12,054,232 terrain
bytes. These desktop loopback runs do not establish the plan's 20 MB /
20 Mbit/s startup target.

The native frameMs statistic measures smoothed CPU frame processing. Its p95
is not GPU frame time or presentation latency. Browser heap and owned-process
snapshots include different memory categories and are not continuous GPU-memory
measurements. Mobile-device performance is not established by these results.

Visual selection streams nearby detail and a textureless distant tier, with
velocity lookahead, cancellation and eviction. Low retains at most 16 detailed
and 28 coarse cells; standard retains at most 28 and 42. Tree instance buffers
follow cell residency. These limits do not load all 237 detailed meshes at
startup; resident collision is a separate cost.

### Superseded native suite and incomplete traversal

The exact-candidate orchestrator receipt is
[gpu-suite-closure-v4.json](../../data/evidence/district-expansion-20261018/gpu-suite-closure-v4.json).
Its last completed entries are the early low fixtures and low native benchmark.
The subsequent continuous walk was interrupted when the suite was stopped;
standard-preset results, the complete district drive and replay, native mission
endings and request-failure fixtures were not completed for this candidate.
Fixture drop-ins do not prove continuous walking or driving reachability.
A replacement street/tram candidate requires its own hash-bound suite; these
earlier results cannot be transferred.

The fourteen opened PNGs confirm the corrected matched bank/Music Centre views
and the approved Palace east, Parliament lower-wing and Guard facade layouts.
The capture review checks actual owner detail draw groups; a loaded texture alone
does not prove that its detailed mesh was rendered. Traversal captures from the
long suite require their own opened-image review.

Visible source limitations remain: low-resolution licensed facade textures,
untextured background buildings at Pohjoisranta 2, Parliament's separate narrow
stair-side return, faceted coastal ground/rocks, compact Uspenski stairs and fine
original triangulation seams. The Guard portico belongs to a separate source
object. The distant tier remains a textureless colour approximation. The facade
charts use original reference-led artwork and do not reproduce reference-photo
pixels. See [the source register](../source-register.md).

Historical staging checkpoint only: the 717a9536 receipt above records
`pointersChanged: false`. It does not describe the current local pointers;
the completed 7fc03703 activation and rollback binding are recorded at the top.
