# Posture and ground repair verification

**Historical result, reopened:** the owner's later close view reproduced a vertical opening at the
Cathedral west pier on this exact release. The downward support probes and selected views below did
not establish closure from the side. `verify-wall-joins.ts` and matching oblique runtime captures now
record that negative control; see [decision 0009](../decisions/0009-facade-and-stair-junction-repair.md).

Date: 2026-10-17. **Historical acceptance, later reopened; tested release `senate-20261017-4090689c`.** Implementation:
[decision 0008](../decisions/0008-posture-and-ground-repair.md).

## Identity and preservation

There is no Git HEAD. `data/evidence/repairs-20261017-final-identity/candidate.json` binds 93 source/configuration
files, the final manifest and the retained compiled review bundle. `world-preservation.json` records unchanged
roads, gameplay, scenery, cars and pistol; the ground rebuild report proves decoded building geometry,
transforms, normals, UVs, indices, materials/images and non-ground colliders preserved in all 15 cells.

Final inputs: `data/work/repairs-20261017/cells-v3`, `release-assets/characters` under that same repair directory,
baseline terrain-v2/roads-v2/gameplay-v5, original cars, and the frozen previously published tree asset.
The publisher validates 21 GLBs; 40 files total 77.3 MB with 103.5 MiB estimated unique resident textures.
Original authoring scenes and earlier releases remain available; no 2017 mesh or unfinished facade/tree rebuild.

| Character | Final GLB SHA-256 | Bytes |
| --- | --- | --- |
| Snow | `611ce9283bf9e0a0032ba7c6a71f51ffef69f8df3db9a5580b141eb6a9b0c4e2` | 1,710,344 |
| Rain | `b5b8fc25dc6f5a8893fb6e7107b98948c6c7c4491c975ff2dd4bb0121ed6522e` | 1,146,876 |

## Corrected motion

The absolute source-collar transfer and excess forward torso pitch caused the owner's rejected posture.
Snow's corrected mean hip-to-head lean is 2.95/9.56/16.54 degrees for walk/run/sprint, versus original target
2.90/9.78/16.67 and rejected 12.8/28.1/41.7. Walk collar sweep is -2.75 degrees, versus original -2.77 and
rejected -41.36. The source arm swing is retained relative to target anatomy and mean carriage.

Both independent exported-motion checks pass unchanged thresholds: meshes, weights, rest rig, materials,
images and seven other clips preserved; periodic boundary derivative mismatch at most 0.000415 m/s and
0.074 degrees/s; inter-key sole penetration below 0.5 mm; inferred flat-floor support drift at most 30.7 mm.
Reports: `data/evidence/repairs-20261017-{snow,rain}-v3/character-motion.json`.
Native asset validation passes 37/37. Pinned Blender 5.2.1 censuses pass Snow 8/8, Rain 8/8 and pistol 9/9.
Reports: `repairs-20261017-final-native-glb/` and `repairs-20261017-final-mesh-census/` under `data/evidence`.
Existing skinned-mesh-parent warnings remain; no GLB validator errors.

`repairs-20261017-motion-runtime/` records 31/31 real-control checks with zero browser errors: Alt walk,
diagonals, run, sprint, transitions, stopping, pause, turning/reversing and car entry/exit. It uses release
`6062690e` with the exact final character bytes and compiled runtime; the subsequent world-only change
preserves Float32 ground positions. Final-release stair traversal and gameplay checks are separate below.
Selected-frame observations and exact opened files are in its `review-notes.json`; front/side full-cycle
export renders are under `data/work/repairs-20261017/characters/{snow,rain}-v3/review/`.
Frame review is not continuous-video review. Flat-floor contact diagnostics are not terrain-aware foot IK.

## Stairs, wall joins and collision

Final exported-mesh/Rapier and real-control verifier: **50/50 PASS**, zero browser errors, in
`data/evidence/repairs-20261017-ground-final/ground-repair.json`. It decodes actual GLB coordinates and checks
1,170 tread probes across nine register flights. Visible treads agree with collision to the printed 0.0000 m
precision (maximum discrepancy 0.000001907 m); no raw-terrain collider protrudes above them. Six real-keyboard routes ascend and descend the
Cathedral centre, Cathedral west edge and University; every route reaches its target with capsule feet above
visible support. Fixture teleport is recorded separately from actual approach and stair traversal.

Opened final runtime views show closed Cathedral west joins and top landing, Snow's legs above stone, and
straight University treads. Exact files and review limitations are in the ground evidence's `review-notes.json`.
Supplemental real controls reach the western top stone with full legs visible; crossing through the raised
mid-stair sidewall is correctly blocked. `side-wall-traversal.json` records successful and blocked approaches.
The source safety field is copied and conservatively lowered at 5,169 samples beneath authored support;
original terrain data remains unchanged. Runtime support SHA-256:
`c380e6336f409e5765a76174b9050816b003f458068d3309e607ec9965fa67ec`.

Negative control on the original `05811e68` world fails 20 of 29 geometry checks: maximum visual/support
disagreement 2.1346 m at the Cathedral and 0.465 m at the University, with University tread height spread
1.2949 m. Evidence: `repairs-20261017-ground-v1-negative/`. The rejected character-only release had identical
city files. These comparisons identify the pipeline fault; they do not diminish the owner's reported problem.

An intermediate shared-per-cell quantization fix still left cross-cell holes. Independent v2 rays missed the
University surface on z=0; cells-v3 preserves exact Float32 positions. Its 1,064 shared boundary pairs,
including 179 stair/wall pairs, have exactly zero decoded separation. All 15 boundary rays hit.
Evidence/reproducer: `data/evidence/repairs-20261017-ground-v3-seams/`; the failing v2 evidence is retained.

## Source gates

`pnpm typecheck` PASS and `pnpm test` 32/32 PASS. Logs:
`data/evidence/repairs-20261017-typecheck.log` and `repairs-20261017-tests.log`.
The added checks exercise tread/collision alignment, wall closure, clipped support, finite safety fields and
shared edges through actual compressed GLB export across different materials and separate cells.

## Browser performance

Native compiled-build checks pass **8/8 on each preset** with zero browser errors, on this Windows RTX 3070 Ti
desktop at 1280 by 720, device scale 1, ANGLE D3D11. These are not integrated-GPU laptop or 1080p measurements.
The recorded Chromium version is 153.0.8010.12.

| Preset | Lowest scene average | Worst measured frame p95 | Max draw calls | GPU textures | Ready |
| --- | --- | --- | --- | --- | --- |
| Standard | 141.6 fps | 4.57 ms | 186 / 600 | 150.1 / 320 MiB | 6.4 s |
| Low | 142.4 fps | 2.34 ms | 178 / 350 | 150.1 / 160 MiB | 3.6 s |

Reports: `data/evidence/repairs-20261017-final-{standard,low}/browser.json`. Transfer to control is 78 MB over
unthrottled loopback, above the original 20/30 MB targets; 24.7 MiB of uploaded textures are duplicate content.
That existing size debt is not closed by this repair. Throttled-network loading and the full city route are
not claimed.

## Journey, activation and production smoke

The final compiled release passes **10/10 native journey runs**, with no page reload between runs and zero
browser errors. Every browser command recording matches a fresh Node replay. Routes cover initial movement,
car entry, Unioninkatu, ramming police, pursuit, exit, firing, being fired at, alternating death/arrest and
respawn. Simulation time is 40.6–45.4 seconds per run; measured averages 134.7–143.8 fps, minimum sampled
92.0 fps, maximum 220 draw calls. Evidence: `data/evidence/repairs-20261017-final-journey/`.

After acceptance, `current.json` was set to `4090689c`, the ordinary production build was regenerated and the
preview process restarted on **5317**. No listener remains on 4317. A fresh default-URL load without a release
query passes seven smoke checks, including click-to-play, real Alt/W/Shift gait controls, expected release,
served production-bundle identity and zero browser errors. Additional assertions verify both served character
hashes and the manifest against local final files. The served production bundle differs from the retained
review bundle, as expected. Report/script/screenshots: `data/evidence/repairs-20261017-production/`.
`data/evidence/repairs-20261017-final-identity/activation.json` binds the acceptance reports and records the
single server; all 93 frozen source/configuration hashes still match after activation.

The repaired views and sampled player/officer poses were reviewed; this is not exhaustive city inspection or
continuous-video acceptance. Existing facade/tree art defects, transfer-size debt, rigid hand poses and terrain
foot IK remain outside this repair's claim. No source scenes were overwritten and nothing is committed.
