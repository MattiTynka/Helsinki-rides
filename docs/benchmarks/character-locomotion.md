# Character locomotion verification

Date: 2026-10-17. Candidate: `senate-20261017-fdd3c68a`, based on `senate-20261016-05811e68`.
Historical status: **RETHINK for visual acceptance; withdrawn**. The owner rejected the shoulder/torso pose.
The measured passes in this record do not override that report. The corrected retarget and ground repairs are
recorded separately in [the repair verification record](posture-and-ground-repair.md).

Implementation and reproduction: decision [0007](../decisions/0007-character-locomotion.md) and
[asset pipeline](../asset-pipeline.md#locomotion-retarget-pass).

## Candidate identity

There is no Git HEAD yet; the project remains uncommitted. `data/evidence/locomotion-20261017-candidate.json`
binds 81 source files, the manifest and the retained review JavaScript bundle to SHA-256 hashes.

| Output | SHA-256 | Bytes |
| --- | --- | --- |
| Snow | `41ec25abf70c02c52a06b13af0ebea55b88e4dfb0cec956a7d176bbc21189de5` | 1,575,384 |
| Rain | `bbb0d5425685a27d1659a902f3a312f5b8857ce90eafd6f1d5df07af916994df` | 1,011,924 |

Only these two asset payloads change from the starting release. All city cells and collision, terrain, roads,
gameplay, scenery, cars and pistol match the starting manifest exactly; the release also adds the motion credit.
Proof: `data/evidence/locomotion-20261017-final-glb/world-preservation.json`. The two characters add 460,764 bytes.

## Exported motion

Independent decoder: `tools/verify/verify-character-motion.mjs`. Reports:
`data/evidence/locomotion-20261017-final-{snow,rain}-motion/character-motion.json`.
Source scenes and provenance: `data/work/locomotion-20261017/characters-final/{snow,rain}/`.

Both variants PASS geometry/UV/weight/material/image preservation, rest hierarchy and inverse binds, scale,
all seven non-locomotion clips, loop closure, boundary velocity and skinned-shoe diagnostics. Geometry attributes
and image bytes are identical. Non-locomotion world-position differences are below 0.001 mm.

| Character / gait | Worst sole penetration | Largest inferred support drift | Boundary velocity mismatch |
| --- | --- | --- | --- |
| Snow walk | <0.001 mm | 30.01 mm | 0.3117 m/s |
| Snow run | 0.36 mm | 8.03 mm | 0.0004 m/s |
| Snow sprint | 0.42 mm | 10.08 mm | 0.0002 m/s |
| Rain walk | <0.001 mm | 30.61 mm | 0.2523 m/s |
| Rain run | 0.28 mm | 13.98 mm | 0.0003 m/s |
| Rain sprint | 0.32 mm | 8.41 mm | 0.0002 m/s |

Thresholds: penetration 15 mm, inferred drift 50 mm, support interval at least 80 ms, boundary velocity
0.5 m/s and 180 degrees/s. The highest angular mismatch is 68.73 degrees/s, in walk. Contacts use 120 Hz;
cubic shoe-height checks also include intermediate grid samples and every cubic-key midpoint.
Boundary derivatives use 1 microsecond with a 10 microsecond convergence comparison. The earlier 120 Hz chord
measurement remains a separate diagnostic because ordinary acceleration contributes to chord differences.
Known smooth-cosine and triangle-kink checks validate the distinction; no quality thresholds were relaxed.

The original assets, rechecked with this same verifier, report RETHINK: 41–52 mm sole penetration and substantial
loop velocity mismatch. Original sprint has no qualifying inferred support interval; its reported zero drift
does not mean planted feet. Baseline reports: `data/evidence/locomotion-20261017-self-{snow,rain}-derivative/`.
These are flat-floor measurements, not terrain foot IK or an analytic bound on all cubic extrema.

Pinned Blender 5.2.1 LTS mesh census passes 8/8 checks for each character
(`data/evidence/locomotion-20261017-final-census/`). Native `verify-glb.ts` passes 37/37, and the publisher validates
all 21 release GLBs. Each character retains the existing skinned-mesh-parent validator warning; no validator
errors. Unchanged vehicle topology debt is outside this pass.

## Browser controls and visuals

Review build: `pnpm build:review`, served at `127.0.0.1:4317`, explicit candidate release query.
`verify-locomotion.ts` passes 31/31 checks: Alt walk, diagonal walk, run, sprint, gait changes, turns/reverse,
stop, paused animation, car approach/entry/exit and run after exit. The separate mouse-crime fixture captures
141 moving on-foot officer samples with a natural police response. No console errors.

Evidence: `data/evidence/locomotion-20261017-final-runtime/`. Selected player and officer frames were opened:
opposing arm/leg motion, distinct run/sprint posture and recovery, sprint flight, standing after stop, intact
character meshes. `review-notes.json` lists the exact frames and review limits. `review.html` provides normal
and slow playback of timestamped captures; `video/` contains the full WebM. Continuous-video review is not
claimed by the selected-frame observations.

## Performance

Windows desktop, RTX 3070 Ti, Playwright Chromium 153.0.8010.12, ANGLE D3D11, 1280 by 720, device scale 1. Native
`verify-browser.ts` passes 8/8 checks on each preset. These are this desktop's results, not an integrated-GPU
laptop or the standard preset's 1920 by 1080 reference measurement.

| Preset | Lowest scene average | Worst measured frame p95 | Max draw calls | GPU textures | Ready |
| --- | --- | --- | --- | --- | --- |
| Low | 143 fps | 2.16 ms | 176 / 350 | 150.1 / 160 MiB | 2.9 s |
| Standard | 143 fps | 2.43 ms | 204 / 600 | 150.1 / 320 MiB | 2.9 s |

Reports: `data/evidence/locomotion-20261017-final-{low,standard}/browser.json`.
Cold uncompressed loopback transfer is 77.4 MB to control, still above the plan's 20/30 MB targets; throttled
20 Mbit/s loading and the full city benchmark route were not measured. Existing load-size and duplicate-texture
backlog remains. This motion pass is not a claim that every original plan budget is satisfied.

## Source checks

`pnpm typecheck` PASS; `pnpm test` 26/26 PASS, including five gait/mixer tests. Logs:
`data/evidence/locomotion-20261017-final-typecheck.log` and `locomotion-20261017-final-tests.log`.

## Journey and activation

The native `play-journey.ts --runs 10` gate passes 10/10 on this release and the frozen review bundle. Every run
covers traversal, car entry, Unioninkatu, ramming police, pursuit, exit, shooting, death or arrest, and respawn
without reloading the document. All ten browser command recordings match their fresh Node replay hashes.
There are no console errors; simulation duration is 31.9–44.6 seconds per run, scene averages 143.2–143.9 fps,
minimum sampled fps 105.6, maximum draw calls 210. Report and recordings:
`data/evidence/locomotion-20261017-final-journey/`.

After all gates passed, `current.json` was changed to `senate-20261017-fdd3c68a`, preserving older releases.
The activation check rehashed all 81 candidate source files. Evidence:
`data/evidence/locomotion-20261017-activation.json`.

`pnpm build` then produced the ordinary production build. The default URL at `127.0.0.1:4317/` loads the active
release and both expected character assets, and real Alt/W/Shift keys pass walk/run/sprint/stop checks with
no console errors. The existing adapter only dismisses loading and reads state for this smoke test; pointer lock
and removal of existing test hooks are not claimed. The normal HUD walk capture was opened.
`data/evidence/locomotion-20261017-final-production/production.json` records Chromium and production-bundle identity;
the smoke command is `node data/work/locomotion-20261017/smoke-production.ts` (use a new output directory to repeat).
