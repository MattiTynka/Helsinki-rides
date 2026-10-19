# Buildings solely from the textured LoD2: benchmark against the realism pass

Date: 2026-10-16. Release `senate-20261016-9ef28d77` (cells `data/work/m0/cells-v4`) against
`senate-20261016-a847cd26` (decision 0004). Same setup as `docs/benchmarks/building-realism.md`: production review
build served by `vite preview` on loopback, Playwright Chromium headless at 1280 × 720, RTX 3070 Ti, no desktop
Chrome tab rendering the game.

## Build

| Measure | a847cd26 (cells-v3) | 9ef28d77 (cells-v4) |
| --- | --- | --- |
| Register matching | 57 matched, 3 unmatched, 3 dropped for the Cathedral cut-out | 60 matched (Cathedral 0 to 3 mm), 3 unmatched |
| City cell draw calls | 123, at most 12 per cell | 115, at most 11 per cell |
| Cell triangles (visual) | 92,711 | 65,348 |
| Collision triangles | 76,696 | 47,696 |
| Cell GLBs / release | 57.6 MB / 66.4 MB | 54.9 MB / 62.3 MB |

## Browser

| Scene | a847cd26 standard (`browser-realism-standard-3`) | 9ef28d77 standard (`browser-lod2only-standard`) | 9ef28d77 low (`browser-lod2only-low`) |
| --- | --- | --- | --- |
| Spawn (lit) | 128 fps, p95 2.20 ms, 87 calls | 143 fps, p95 1.92 ms, 83 calls | 142 fps, p95 2.12 ms, 83 calls |
| Unioninkatu | 130 fps, p95 2.61 ms, 203 calls | 144 fps, p95 2.25 ms, 200 calls, 235,160 tris | 144 fps, p95 1.85 ms, 110 calls |
| Drive | 131 fps, p95 2.66 ms, 184 calls | 144 fps, p95 2.18 ms, 176 calls | 144 fps, p95 2.28 ms, 163 calls |
| Textures uploaded | 151.1 MiB, 131 textures | 129.8 MiB, 123 textures | 129.8 MiB (limit 160) |
| Transfer to first control | 66.7 MB | 63.4 MB | 63.4 MB (budget 20 MB: **fail**, backlog 17) |

All browser runs passed 8 of 8 checks with no console errors. Fixed-camera captures before and after:
`data/evidence/browser-lod2only-standard/before-after-1.jpg` (spawn north and east, Cathedral steps) and
`before-after-2.jpg` (spawn south and west, Unioninkatu, Snellmaninkatu).

## Journey gate

Collision changed, so the M1 recordings of `journey-m1-try4` no longer replay to their hashes on this release (run 01
replays to bbf64b5a instead of 1178cbf3, run 02 to 3ca9e238 instead of 0cb8c097); the 10-run gate was rerun.

- `journey-lod2only`: 1 of 10. Run 1 passed every step. Run 2 passed every step but `fireAtPolice`: a Node replay
  of its recording shows all 9 shots hit the player's own car, parked between the player and the patrol car on
  Aleksanterinkatu (61, 51), so the 3 stars came from public firing, not from shooting at the police. That is the
  harness's aim, not the changed colliders (the nearest, the statue's, was about 80 m away). The harness steers live,
  so each run's route differs; run 2 also needed one car recovery at (60, −140).
- `journey-lod2only-2`: 1 of 10, the same way. Run 2's 10 shots all hit the player's own car at (67, 40) with the
  patrol car behind it at (67.5, 46).

In both, run 2 reached Unioninkatu at about (−70, 43) and the chase then took the long way round (Aleksanterinkatu,
Snellmaninkatu, back), ramming the patrol car at the square's south-east corner; in `journey-m1-try4` and `-try6`
run 2 reached Unioninkatu at about (−63, 31) and rammed it there. `journey-m1-try7` on the old colliders took the
same long way in run 2 and failed `ramPolice`. The gate's harness, not the world, decides this step; the fix (aim
past the player's own car, or step aside before firing) is harness work and was not done.
