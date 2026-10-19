# Building realism pass: benchmark against the M1 baseline

Date: 2026-10-16. Release `senate-20261016-a847cd26` against `senate-20261016-d9a3be1f` (decision 0003). Same setup
as `docs/benchmarks/m1-baseline.md`: production review build served by `vite preview` on loopback, Playwright
Chromium headless at 1280 × 720, RTX 3070 Ti.

The frame-rate averages in this session top out near 130 fps rather than the baseline's 144, for both releases, so
the old release was measured again in the same session as the A/B reference (`browser-realism-ab-old-release`).
Read the frame-time p95, as the baseline advises.

## Standard preset

| Scene | Old release (same session) | New release | New release, second desktop Chrome tab closed |
| --- | --- | --- | --- |
| Spawn (lit) | 128 fps, p95 2.38 ms, 87 calls | 126 fps, p95 2.54 ms, 87 calls | 128 fps, p95 2.20 ms, 87 calls |
| Unioninkatu | 130 fps, p95 2.53 ms, 203 calls, 261,049 tris | 128 fps, p95 3.12 ms, 203 calls, 260,850 tris | 130 fps, p95 2.61 ms, 203 calls, 260,850 tris |
| Drive | 130 fps, p95 2.56 ms, 183 calls | 127 fps, p95 2.97 ms, 184 calls | 131 fps, p95 2.66 ms, 184 calls |
| Evidence | `browser-realism-ab-old-release` | `browser-realism-standard` | `browser-realism-standard-3` |

`browser-realism-standard` and `browser-realism-standard-2` ran while a copy of the game was rendering in a
desktop Chrome tab on the same GPU; `-3` and the old-release run had that tab closed.

## Low preset

| Scene | Baseline (`browser-m1-low-final`) | New release (`browser-realism-low`, desktop Chrome tab open) |
| --- | --- | --- |
| Spawn (lit) | 143 fps, p95 2.54 ms, 87 calls | 127 fps, p95 2.23 ms, 87 calls |
| Unioninkatu | p95 2.44 ms, 113 calls, 231,502 tris | p95 2.34 ms, 113 calls, 231,303 tris |
| Drive | p95 2.46 ms, 169 calls, 325,390 tris | p95 2.48 ms, 169 calls, 325,388 tris |

## Budgets

| Measure | Before | After | Budget (low / standard) | Verdict |
| --- | --- | --- | --- | --- |
| Draw calls per frame | ≤ 169 low, ≤ 203 standard | ≤ 169 low, ≤ 203 standard | 350 / 600 | Pass |
| City cell draw calls | 122 in all, ≤ 12 per cell | 123 in all, ≤ 12 per cell | 60 / 100 per cell | Pass |
| Textures uploaded | 148.1 MiB, 130 textures | 151.1 MiB, 131 textures | 160 / 320 MiB | Pass (8.9 MiB headroom on low) |
| Transfer to first control | 62.5 MB | 66.7 MB | 20 / 30 MB | **Fail**, as before (backlog item 17) |
| Load to ready (loopback) | 2.5 to 2.8 s | 2.4 to 3.8 s | — | — |

All runs passed 8 of 8 checks with no console errors. Logs: `data/logs/verify-browser-realism-*.log`.
