# Reference-led facade reconstruction

Task date: 2026-10-17. Baseline: `senate-20261017-605a392e`.
Status: **PASS for the named reconstructed elevations; activated locally**.

## Problem and approach

The owner's screenshot shows Topelia's east elevation, where the original aerial
texture projects tree crowns and their shadows across windows. The earlier repair
removed destructive automatic erasure but left these source-image occlusions.

The new pass identifies individual buildings and elevations, checks Google Maps
Street View and clear architectural references, then reconstructs obscured detail
from licensed same-building images. Original window centres, doors and continuous
architectural bands constrain each repair. Google imagery is reference only.
See [decision 0010](../decisions/0010-reference-led-facade-reconstruction.md).

## Reviewed preparation

- The 51 baseline native images were opened; findings and exact fixtures are in
  `data/evidence/facade-cleanup-20261017/baseline-review.md`.
- Topelia's main street elevation has matching nine-bay wings. Its side building
  has distinct north and south window spacing. Two dark north-side shapes were
  confirmed as real porches and are protected, including their doors and steps.
- Library side elevations use eleven panels between twelve pilasters, with three
  window axes and three lunettes, rather than repeating the front elevation.
- The old Bank has seven arched axes and a central entrance; the modern west annex
  has a separate window grid. Low granite courses are authored using stone grain
  from the same building, without repeating photographed lamps or foreground.
- Kirkkokatu 16's two lower rows have arched glass heads. Street View exposed a
  misreading of the dark source texture; the rejected rectangular candidate is
  retained as preparation evidence, and the corrected arches use licensed source
  pixels from the same building's clear east wall.
- Rauhankatu 19's west wall has twelve tall hall windows and twelve short basement
  windows. Its south entrance and other elevations stay exact. Kirkkokatu 12 uses
  a seven-bay north grid with its western drive passage preserved as a distinct bay.
- Kirkkokatu 14 preserves its Jugend upper architecture and unique rough-stone
  gateway. The lower window groups are asymmetric, and are reconstructed separately.
- The House of the Estates uses two credited CC BY 4.0 photographs by Josefiina
  Alanen. The original city textures were scaffold wrapped. Its four-column front,
  three-bay recessed side centres and five-arch rear have separate mappings.
- Holy Trinity Church's south wall has five tall window axes, alternating
  triangular hoods and circular ornaments, plus a separate tower-base window.
  Its curved east apse remains original: available references do not resolve the
  full arrangement of openings and painted false windows. This is an explicit
  remaining source-photo limitation, not a reconstructed blank wall.

Diagnostic candidate `senate-20261017-a10539dd` was not activated. Matching runtime
views exposed additional Bank side-wall crowns and a mottled retained paired bay
at Kirkkokatu 16; these were corrected before the final export. Prepared images
are retained, including rejected iterations, so acceptance does not rely on a
single flattering angle. New detail fixtures include an actual keyboard approach
to the Estates rear at `[144.002, 1.064, -192.964]`. Earlier attempts at X160 were
outside the documented X150 play boundary and are retained as invalid fixture
evidence, not interpreted as a facade regression.

The next staged candidate, `senate-20261017-90f682c6`, was also held after review:
a separate 2.88m Bank return on page34 still had a crown, the Estates' generic rear
corner mapping included a photographed low rail, and the nearby church's low wall
had baked foliage. These are concrete source-chart findings, not geometry changes.
The Bank return and Estates base receive bounded corrections, and the church is
checked against its corresponding Street View before its architecture is authored.

Prepared source panels are not release acceptance. Final compressed runtime views,
payload preservation, native performance checks and ordinary-build smoke results
must be recorded below before changing the active local release.

## Preservation contract

The texture-only exporter starts from
`data/work/facade-junction-20261017/cells-v4`. It substitutes facade image payloads
after validating source-position/UV correspondence. All compressed geometry,
non-image GLB semantics, collision files, runtime terrain and scenery remain exact.
Character, car and tree assets are the accepted prior assets. The 2017 mesh stays
removed. No runtime gameplay or renderer changes are needed for this repair.
All 41 runtime, simulation and schema source files match the task baseline
(`runtime-source-preservation.json` in the evidence directory).

The 118 registered trees already match the 118 published instances. The surveyed
street rows remain independent meshes; no duplicate trees are added to hide walls.

## Final candidate

Candidate: **`senate-20261017-cbd20b69`**, from
`data/work/facade-cleanup-20261017/cells-v3`, published in
`data/work/facade-cleanup-20261017/final-world-v3` with `--keep`.
Manifest SHA-256:
`87e7227b751579854a9df149aa7961a18b5bfb18d94cd7d9a3df326edf8216f6`.

All evidence below is under `data/evidence/facade-cleanup-20261017/`.
`final-v3-freeze.json` records the exact export command. The 47-file frozen
snapshot contains production code, configuration, both licensed photographs and
19 city masters. `accepted-candidate.json` binds 141 source/configuration files
and the review bundle; its verification passed after the native gates.

| Check | Final candidate result |
| --- | --- |
| Repository typecheck and tests | PASS; 81/81 tests, `accepted-typecheck.log`, `accepted-tests.log` |
| Publisher and glTF validation | PASS; 21 GLBs, 15 cells, 6 assets, 40 payloads, `accepted-publish.log` |
| Ground, collision, roads, gameplay, scenery and hero assets | 25 payloads byte-identical to 605a392e, `accepted-preservation.json` |
| Building geometry and original UV correspondence | All compressed non-image data exact; 28,662 checks |
| Facade atlases | 26 total; 14 byte-identical to the original baseline; 24 byte-identical to held v2 |
| Standard preset | 8/8 checks; 142 lowest scene-average FPS, 187 maximum draw calls |
| Low preset | 8/8 checks; 143 lowest scene-average FPS, 178 maximum draw calls |
| GPU texture upload | 150.1 MiB on both presets, below the 160 MiB low-preset ceiling |
| Real-control journeys | 10/10, 150 checks, 10 matching Node replays, zero console errors |

Performance was measured in the compiled review build on this machine's NVIDIA
GeForce RTX 3070 Ti through Chromium/ANGLE. Reports are `accepted-standard/browser.json`
and `accepted-low/browser.json`; the journeys are `accepted-journeys/journey.json`.
The 79.8 MB transfer to first control is an observed pilot limitation, not a claim
that the original 20 MB delivery target has been met. No mobile performance claim.

## Visual scope and remaining limits

Final native captures use the same recorded street fixtures and keyboard approaches.
The root opened all 27 principal and 6 church views, recorded in
`root-visual-review-cbd20b69.json`. The 12 street-extension views were independently
opened and recorded in `accepted-street-extensions/independent-review-motion-analysis.json`.
The independent 36-view review in `independent-review-cbd20b69.json` also passed:
Bank's narrow return crown and the Estates' photographed corner balustrades are
visibly closed, with protected openings intact. All **81 final facade PNGs** were
opened and individually hash-bound across these three review records.
Visual fixture captures are separate from the ten continuous gameplay journeys.

The Topelia east front is clean across both wings and its central architecture.
The Library side rhythm, Bank's distinct front/return/annex patterns, Kirkkokatu
12/14/16's different openings, Rauhankatu 19's hall windows, the Estates' separate
elevations and the church's confirmed south windows retain their reviewed layouts.

The church's unresolved east apse still contains photographed foliage. Its full
window/false-window arrangement could not be established from the available
references; its service door, cupola and all page23 charts remain original.
Other unconfirmed courtyard charts, original LoD2 roof approximations, close-view
texture softness and terrain outside the western play boundary are retained.
This is acceptance of the named reconstructed elevations, not a claim that every
photographic occlusion or geometry defect in the city has been eliminated.

## Activation and ordinary build

`activation.json` records the local pointer change after all candidate gates.
`pnpm build` completed, then the project's preview was restarted at
`http://127.0.0.1:5317/`. `production-smoke/smoke.json` verifies the default URL,
real keyboard walking, exact compiled bundle, all 21 served GLBs and zero browser
errors. Its walking screenshot was opened. Public and compiled pointers both
select cbd20b69. `server-restart-after.json` verifies new PID13864 on5317 and no
listener on4317. The initial Stop-Process error and strict-port refusal were
resolved by stopping the already verified PID5992 with taskkill; no second port
was started. Nothing was committed or published externally.
`completion.json` binds the completed gates, three opened-image reviews,
production smoke, server verification and final source snapshot by SHA-256.
