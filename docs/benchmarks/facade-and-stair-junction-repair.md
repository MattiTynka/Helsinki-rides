# Facade and stair junction repair verification

Date: 2026-10-17. **PASS for the reported repairs; active local release
`senate-20261017-605a392e`**, replacing `senate-20261017-4090689c`.
See [decision 0009](../decisions/0009-facade-and-stair-junction-repair.md).

## Negative controls and rejected intermediate

The old release reproduces the owner's University facade damage and Cathedral west
pier opening in native runtime captures. The expanded exported-geometry verifier
finds 50 missing side rays and 20 folded cap triangles. These tests supplement the
earlier downward support probes, which could not see a vertical opening.

Evidence: `data/evidence/repairs-20261017-facade-before/`,
`repairs-20261017-oblique-before/` and `repairs-20261017-wall-shape-before/`.

Ground-only candidate `senate-20261017-f917b810` closes the reported opening and
large folded sheet. Its 6,974 side rays, 30 landing-access rays and face-planarity
checks pass, but native traversal fails the west ascent (49/50 total checks),
and a small pointed endpoint cap remains visible. This candidate is rejected.
The capsule stalls near `[-34.42, 10.584, -54.33]` at the final landing lip;
an independent fixed-step collision probe reproduces the failure while the old
release completes the same route. Numeric geometry checks do not override these
runtime defects.

The failed evidence remains under `data/evidence/repairs-20261017-ground-v4-runtime/`
and `repairs-20261017-wall-hole-v4-retry/`. No failed evidence is overwritten.

Ground candidate `senate-20261017-624b9697` (v5) passes all 50 runtime checks and
6,989 side rays; three fixed-step approaches clear the former ascent stall.
However, opening `repairs-20261017-ground-v5-runtime/frames/cathedral-west-up-walk-end.png`
reveals a small blue triangular gap at the top wall endpoint. It is also rejected
for final activation. The combined texture candidate `senate-20261017-f202f3c8`
inherits that ground geometry and stays unactivated.

The next rejected candidate was `senate-20261017-a5ab21c4`, from ground cells-v6 and the
texture-only `data/work/facade-junction-20261017/cells-v3`. Closing both width ends
of each adjusted landing fixes the new seams without changing their top triangles,
treads, grade or movement-controller settings. The expanded negative control finds
83 missing landing/camera rays on v5. This intermediate exported candidate passes all
7,267 rays across ten flights, with zero skipped stations or backface-only hits,
planar wall caps and all 30 intended landing-access rays clear. Reports:
`repairs-20261017-wall-landing-v5/` and `repairs-20261017-wall-final-v6/`.

Closer inspection then identifies an additional narrow slit at each finite wall
end. Eleven frozen camera rays reproduce missing front- and two-sided intersections
on v6; an expanded four-end audit adds 25 missing outer-end rays. All 40 probes
at the two inner ends already pass. The cause is a missing vertical return
across the wall's actual 10 mm cut, not a larger terrain opening. This candidate
also stays unactivated and is superseded by the bounded endpoint repair. Negative control:
`repairs-20261017-wall-final-v6-both-ends/`.

Ground cells-v7 adds only the bounded vertical end returns. Its source proof
passes all eleven frozen camera rays, 75 finite-end probes and 30 open-access
probes. Every nonvertical physical triangle equals v6 at Float32 precision;
treads, fitted landings and top support remain unchanged. The focused rotated
corner regression fails at both orientations when only this repair is disabled.
Evidence: `data/evidence/repairs-20261017-endpoint-v7/returns.json`.

## Final candidate identity

Final candidate: `senate-20261017-605a392e`, combining
`data/work/repairs-20261017/cells-v7` and the texture-only
`data/work/facade-junction-20261017/cells-v4`. There is no Git HEAD.
`data/evidence/facade-junction-20261017/candidate-accepted.json`
binds 116 source/configuration files, the final manifest and compiled review bundle.
The prior `candidate-v7.json` differs only in `tools/verify/play-journey.ts`, whose
automated driving repair is explained below. Game source, compiled review bundle
and release manifest remain identical across those two bindings.
`final-v7-preservation.json` verifies all 40 release payload hashes and unchanged
roads, gameplay, scenery and six character/car/weapon/tree assets. The native
publisher validates all 21 GLBs. Content is 79.6 MB; estimated unique texture
residency is 103.5 MiB. Draw budget remains 118 total, at most 11 per cell.

Ground export preservation checks retain decoded building geometry, UVs, materials,
images and non-ground colliders. The texture pass then verifies 28,662 source
corner/UV matches and exact non-image JSON/compressed payload/collision preservation
in all 15 cells. `cells-v4/atlas-reuse.json` proves all 26 facade KTX2 payloads
match the reviewed final-policy texture set. Direct comparison also preserves
92 protected physical buffer views/images and 369 meshopt payloads, all collision
files, support terrain and scenery. Ground seams retain 1,125 matching
boundary pairs (179 stair/wall pairs) with exactly zero decoded separation; all
15 University seam rays hit (`ground-v7-seams.json` under the final evidence directory).

`pnpm typecheck` passes and `pnpm test` passes 48/48, with no skipped tests.
Logs: `data/evidence/facade-junction-20261017/{typecheck,tests}-accepted.log`.

## Final geometry and native views

The final compressed release passes all 7,353 front-face side, landing and finite-end
rays across ten flights, with no missing or skipped stations and no backface-only
hits. All 30 intended access-opening rays remain clear; both wall-cheek planes pass.
Report: `data/evidence/repairs-20261017-wall-final-v7/wall-joins.json`.

Root opened the exact final lower-pier view, both landing sides, the upper platform
view and the real-control west ascent end. The large opening, folded projection,
triangular landing seam and thin endpoint slits are absent in those views. The
character's feet are above the treads/landing. This is selected-view acceptance,
not a claim of inspecting every city surface. Opened paths and limitations are
recorded in `data/evidence/facade-junction-20261017/root-visual-review.json`.

`repairs-20261017-ground-final-v7/ground-repair.json` passes 50/50 checks, including
six real-keyboard ascent/descent routes at Cathedral centre, Cathedral west and the
University. Served collision bytes match the manifest and browser errors are zero.
The matching lower and reverse upper endpoint captures keep identical positions and
cameras: the respective 207 and 75 sky-colour pixels in the old slit regions become
zero (`repairs-20261017-views-final-v7/endpoint-pixel-comparison.json`). This pixel
comparison supplements, rather than replaces, the geometric rays and opened views.

Root also opened the full final University corner in
`repairs-20261017-final-facade-v7/university-ne-reference-road-yaw-1.047-pitch0.40.png`.
Windows, pilasters and cornice bands are coherent and the diamond plaster patches
are gone. The previously reviewed licensed-source reconstruction is unchanged:
all 26 atlas payloads match the approved texture set byte-for-byte. The Street View
references and architectural observations are linked in decision 0009.

## Native performance and gameplay

Compiled review build, 1280 x 720, Chromium on NVIDIA GeForce RTX 3070 Ti through
ANGLE/D3D11. Each preset passes 8/8 checks with no console errors. These are local
hardware measurements, not low-end-device evidence.

| Preset | Ready | Lowest scene average | Maximum draws | Uploaded textures | Gate |
| --- | --- | --- | --- | --- | --- |
| Standard | 3.12 s | 142.43 fps | 187 / 600 | 150.1 / 320 MiB | PASS |
| Low | 3.15 s | 142.42 fps | 178 / 350 | 150.1 / 160 MiB | PASS |

Reports: `data/evidence/facade-junction-20261017/{standard,low}/browser.json`.
Both transfer 79.9 MB before control, including existing character/runtime assets;
24.7 MiB of uploaded textures are byte-identical duplicates. These existing size
costs remain recorded, not presented as resolved by the repair. Benchmark captures
are captured but not visually reviewed; the exact repair views above were opened.
The final `journey-accepted/journey.json` passes 10/10 consecutive gameplay runs
and all 150 checks, with five death and five arrest outcomes. Every recording
replays to its browser hash in a fresh Node simulation. Durations are 39.6–52.2 s
of simulation; minimum sampled FPS is 98.78 and maximum draw count is 216. There
are no browser errors. Failed earlier evidence is retained separately below.

The first journey attempt is retained in `journey/` with status FAIL. Its driver
missed the patrol and held reverse for 1,796 of the 1,800 recorded ticks from
40 to 70 seconds, so it followed at the car's 8 m/s reverse limit. The old test
logic requested reverse solely because a target was behind the car and compared
unsigned speed when braking. The verifier now uses signed forward speed, brakes
before a fast turn and then turns forwards at reduced speed, including direct
pursuit. It keeps real keyboard input and every original acceptance threshold.
No game controls, physics, police logic or release assets change for this harness
repair. The failed trace replays exactly on its own candidate; the comparison
against the older world is retained under `journey-diagnosis/`.
Both worlds reproduce zero ram events and zero stars through the failed ram window.
Their closest patrol gaps differ by only 7.5 micrometres at the same tick; vehicle
positions differ by less than 8 micrometres through the parked wait. This isolates
the missed interception from the repaired stair geometry. Later replay trajectories
diverge, so cross-release physics identity is not claimed.

## Activation and ordinary build

Source/manifest identity was rechecked, then `current.json` changed to 605a392e
at 11:45:27 UTC. The owned review server was stopped, `pnpm build` completed and
the ordinary compiled preview restarted on strict loopback port 5317. No 4317
listener remains. `production-smoke/smoke.json` verifies the plain default URL,
real Alt+W walking, the served manifest and production bundle hashes, all 21 served
GLB hashes and zero console errors. Root opened `default-game-walking.png`.
`activation.json` records the final state; `candidate-accepted.json` binds sources.

Ordinary bundle: `index-BoIo7M4U.js`, SHA256
`e049bcf1da9771a861061d4b9d32a4bba024693eda788dd9a0e0ad8c5f80ebff`.
The existing large-chunk build warning remains. Earlier releases are retained;
nothing is committed. Open `http://127.0.0.1:5317/` without a pinned `release=` query.

## Facade policy and preservation

The original broad tree erase damaged architecture. The repaired atlas starts from
untouched licensed masters. A conservative automatic-copy candidate still proposed
97 texels at a window/pilaster boundary without clear evidence of foliage, so that
candidate was rejected and automatic foliage removal is excluded from the final
production path. The reported University's lower elevation is
reconstructed from a matching five-bay wing on the same source page, with a source
hash guard. Upper architecture and unrelated charts remain intact before grading.
Google Street View supplies visual reference only; no Google pixels enter assets.

The texture-only writer verifies reconstructed atlas placement against original
building positions and UVs, then substitutes image ranges without recompressing
geometry. It checks exact non-image GLB semantics, physical/compressed payload
bytes, collision, terrain and scenery preservation. Source tests reject broad
canopies and ambiguous donors, check protected University pixels and reject changed
master bytes.

Other heavily occluded source photographs can still contain painted foliage. The
curated University's donor has different baked shadows. This pass does not claim
complete city reconstruction, district-wide removal of every photographed tree,
terrain-aware foot IK or resolution of the existing transfer-size debt.
