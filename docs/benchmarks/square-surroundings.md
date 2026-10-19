# City terrain, the Cathedral model and the square's surroundings: benchmark against LoD2-only

Date: 2026-10-16. Release `senate-20261016-57f007bf` (cells `data/work/m0/cells-v13`, terrain
`data/work/m0/terrain-v2`) against `senate-20261016-9ef28d77` (cells-v4; `docs/benchmarks/lod2-only.md`), decision
0005. Same setup: production review build served by `vite preview` on loopback, Playwright Chromium headless at
1280 × 720, RTX 3070 Ti, no desktop Chrome tab rendering the game.

## Build

| Measure | 9ef28d77 (cells-v4) | 57f007bf (cells-v13) |
| --- | --- | --- |
| Register matching | 60 matched, 3 unmatched | 60 matched, 3 unmatched |
| City cell draw calls | 115, at most 11 per cell | 118, at most 11 per cell |
| Cell triangles (visual) | 65,348 | 150,593 (Cathedral model 38,754; stairs, terraces and walls) |
| Collision triangles | 47,696 | 51,012 |
| Cell GLBs / release | 54.9 MB / 62.3 MB | 67.7 MB / 75.2 MB |
| Build texture estimate | 90.1 MiB | 103.5 MiB |
| Hi-res facade pages | none | 10 (square-facing rule) |

## Browser

| Scene | 9ef28d77 standard | 57f007bf standard (`browser-surroundings-v13-standard`) | 57f007bf low (`browser-surroundings-v13-low`) |
| --- | --- | --- | --- |
| Spawn (lit) | 143 fps, p95 1.92 ms, 83 calls | 143 fps, p95 3.05 ms, 85 calls, 221,186 tris | 142 fps, p95 2.58 ms, 85 calls |
| Unioninkatu | 144 fps, p95 2.25 ms, 200 calls | 144 fps, p95 3.17 ms, 200 calls, 306,510 tris | 144 fps, p95 2.75 ms, 110 calls |
| Drive | 144 fps, p95 2.18 ms, 176 calls | 144 fps, p95 2.93 ms, 180 calls, 392,539 tris | 144 fps, p95 2.79 ms, 172 calls |
| Textures uploaded | 129.8 MiB, 123 textures | 144.8 MiB, 126 textures (24.7 MiB byte-identical copies) | 144.8 MiB (limit 160) |
| Transfer to first control | 63.4 MB | 76.3 MB | 76.3 MB (budget 20 MB: **fail**, backlog 17) |

Both presets PASS 8 of 8 checks with no console errors. The frame rate is capped by the display at about 144 fps, so
the p95 rise (about 1 ms) is the measurable cost. The intermediate release `senate-20261016-81987ee7`, with 28 hi-res
pages, measured 175.4 MiB on the low preset and failed its 160 MiB limit (`browser-surroundings-low`); the
square-facing rule (decision 0005) brought it to 144.8 MiB. The build estimate is 41 MiB below the measurement
(backlog 23).

## Hero-asset census

`mesh_census.py` from the build skill on Blender 5.2.1, each GLB re-imported, against the specs in
`content/assets/census/` (reports in `data/evidence/census-20261016`):

| Asset | Result |
| --- | --- |
| Cathedral (`model-v4`) | PASS 11 of 11: closed (0 boundary, non-manifold, flipped or degenerate), 9 shells, size 62.575 × 62.537 × 53.685 m against 62.575 × 62.537 × 53.685 m computed from the STL under `placement.json` |
| Snow, Rain | PASS 8 of 8 each: no interior non-manifold, flipped, loose or degenerate geometry; heights 1.861 and 1.670 m |
| Pistol | PASS 9 of 9: closed, 9 shells |
| Lumi GT, patrol | **FAIL** 12 and 13 checks: 17 flipped edges on the body and 4 on the front doors, interior non-manifold edges (body 413, interior 60, doors 27 each, steering wheel 4, each procedural wheel 32), 8 degenerate faces on the patrol body. Body size matches the build report (1.9155 × 4.7325 × 1.2795 m). The cars collide as a box, so this is visual-mesh debt (backlog 27). |

The glTF importer adds a 2 m `Icosphere` bone shape to the character scenes; it is not in the GLBs, so the character
specs name their meshes.

## Journey gate

`journey-57f007bf-4`: PASS 10 of 10, 0 console errors (`data/logs/journey-57f007bf-4.log`). Every run passed spawn,
walk, enter car, Unioninkatu, ram, pursuit, exit, fire, shot at, wasted (5) or busted (5), respawn and no reload,
and replayed in Node to its browser hash. Average 143 to 144 fps, lowest frame 97 fps (run 1), at most 195 draw
calls, 29.6 to 42.7 s of simulation. In 8 runs the player stepped clear of car-1 before firing.

The three gates before it failed on the journey harness, not the game (backlog 26). The harness stops at the first
failed run.

| Gate | Result | Cause | Harness change |
| --- | --- | --- | --- |
| `journey-57f007bf` | 0 of 10 | Run 1 `fireAtPolice`: a Node replay shows all 10 shots hit the player's own car 1.4 m in front of the player at (63, 43.5), the officer 2.6 m behind it | Step clear of the own car before firing |
| `journey-57f007bf-2` | 1 of 10 | Run 2 `ramPolice`: the chase went the long way round one-way Unioninkatu and stalled at (60, −140) | Wait on Unioninkatu until the patrol car is in direct range |
| `journey-57f007bf-3` | 3 of 10 | Run 4: the wait held S at a standstill, which reverses; the car backed 50 m west, left the ground collision at x ≈ −104 and kept falling (backlog 31) | Brake with S only while rolling forward; hold the handbrake once stopped |
