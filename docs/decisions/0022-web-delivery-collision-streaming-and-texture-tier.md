# Web delivery: collision streaming and the low-preset texture tier

Date: 20 October 2026. Builds on the
[model and delivery optimization](../model-optimization-2026-10-20.md).

## Decision

Startup no longer downloads and builds the whole collision world. The simulation
inserts and removes collision cells deterministically as the player and actors
move, measuring each cell by the collision extent its manifest records. Large city textures gain a half-resolution copy, used only by the low
preset. A smaller set of runtime changes reduces startup work and repeat-visit
downloads. The published Pages descriptor is unchanged; the texture-tier world
exists locally and is not published.

## Collision residency (`packages/sim/src/collision-residency.ts`)

Recordings name their rules as `collision: 'residency-2'`. A streamed world is
not bit-identical to one that holds every cell, so a replay must use the same
rules; recordings without the field still replay with every cell loaded.

Distances are to each cell's collision extent, `collision.boundsXZ` in the
manifest, not to its grid square: a building belongs to one cell but can reach
far into its neighbours'. In the texture-tier world 231 of 304 cells reach past
their square, by up to 118.5 m. The first rules (`residency-1`) measured squares
and left such walls out; an adversarial review found a player at (-558, -420)
whose ray passed through a building 49 m away. `residency-1` recordings are
refused. A world whose manifest has no extents loads every cell, as before.

| Source | Needed | Inserted ahead | Kept until |
| --- | ---: | ---: | ---: |
| Player (and the respawn anchor during Wasted/Busted) | 128 m | 152 m | 216 m |
| Vehicles and officers on foot | 24 m | 48 m | 96 m |
| Spawn, hospital/police anchors, patrol spawn placements | 32 m | 32 m | 32 m |

Needed cells are inserted immediately; one further cell ahead of need is
inserted per tick. Rapier sees new colliders only after the next step, so a
drop-in holds the player for one step and safe respawn points reject cells that
are not yet registered. Removal happens only
outside every keep ring. The start set is the plan for the initial sources, so
it is the same in the browser and in a Node replay.

The browser prefetches cell bytes ahead of the rules, measuring the same extents
(`apps/game/src/world/collision-stream.ts`):
the player's ring plus 160 m and four seconds of travel, actors' rings plus
48 m, four requests at a time, a 64 MiB cache in which the start cells stay pinned.
When the next tick needs bytes that have not arrived, ticks wait (the HUD says
"Loading nearby streets…") instead of stepping without ground. `?collision=all`
restores the previous load-everything behaviour.

Patrol spawn placement and the well-connected lane set were the start's largest
CPU cost: a breadth-first search from every lane took about 1.75 s per
simulation. Strongly connected components give exactly the same reach counts.
`LaneSegmentIndex` answers `nearestLane` from a 32 m grid, visiting segments in
the original order with the original arithmetic, so its results are identical
to the linear scan.

## Runtime delivery

- Rapier's compat build inlines its WebAssembly as base64. The build now emits
  the identical binary as a hashed asset and fails if the bytes ever differ.
- Production pages preload the pinned manifest and the Rapier binary.
- Pages registers `sw.js`: cache-first only for the pinned world release and
  hashed application assets; a new release deletes old caches; `?sw=0` removes it.
- Rain and the patrol car's two models load after the game is playable; their
  textures are then taken out of the city's texture budget. While police within
  128 m of the player (police sight 90 m, pistol range 120 m) still have no
  model, ticks wait ("Loading the police…"), so no unseen officer drives into,
  arrests or shoots at Finn. A failed load is retried after 2, 4, 8, 16 and then
  every 30 seconds, requesting only the models still missing.
- The loading screen offers Auto/Standard/Low and remembers the choice. Auto
  picks Low for four or fewer cores or 4 GB or less device memory. `?preset=`
  still overrides it.
- Outside review builds, render resolution drops in 0.15 steps to 0.6 when
  frames stay slow while the CPU is not the bottleneck, and recovers slowly
  (`?dynres=0` disables it).
- The minimap draws 256-pixel tiles on demand instead of one 66 MB canvas.
  Each tile overlaps its neighbours by one pixel so subpixel scrolling shows no
  seams.
- Startup sets `helsinki:*` performance marks, and `tools/verify/smoke-pages.mjs`
  reports startup bytes by category (`--max-startup-mb` checks a ceiling).

## Collision extents

`tools/world/record_collision_bounds.ts` writes a fresh derivative that
hard-links every payload and adds each cell's `collision.boundsXZ`: the XZ
extent of every triangle in its decoded collision bundle. The Pages stager
decodes each bundle again and refuses an extent that does not contain all of
its triangles.

## Low-preset texture tier

`tools/world/build_texture_tier.ts` writes a fresh derivative that hard-links
every pinned payload. For each Zstandard UASTC texture of at least 1024 pixels,
it adds `textures-m1/<sha256>.ktx2`: the same file without its top mip level.
The remaining levels, DFD and key/value data are byte-identical, and the tool
compares them before writing. The manifest lists the copies as
`sharedTexturesM1` with their `source`. The low preset requests a copy in place
of its source; standard is unchanged. The Pages stager independently re-checks
every copy against its source.

```powershell
node tools/world/build_texture_tier.ts --source build/model-optimization/world/senate-20261020-optimized --out build/model-optimization/world/senate-20261020-optimized-m1 --release senate-20261020-optimized-m1 --report build/model-optimization/texture-tier-report.json
node tools/world/record_collision_bounds.ts --source build/model-optimization/world/senate-20261020-optimized-m1 --out build/model-optimization/world/senate-20261020-optimized-m1-cb --release senate-20261020-optimized-m1-cb --report build/model-optimization/collision-bounds-report.json
```

Of the 506 shared textures, 490 gained a copy: 292,590,777 bytes become
77,845,827. Nine BasisLZ textures (their levels share codebooks), six small ones
and one PNG are unchanged. With collision extents the derivative
`senate-20261020-optimized-m1-cb` is 592,846,997 bytes with manifest
`5a3502a4641de1a79dfd40dbb06724b59d4e908d16f3a5218b8e7dcead3f7ebd`.

Deferred: rate-distortion re-encoding needs the source images and changes
pixels; quantizing the distant tier's colours and positions changes geometry
that the optimization policy keeps exact, for a small share of transfer.

## Measurements

Local loopback, desktop GPU, `build/perf-optimization/` (ignored). Loopback
timings do not show network latency or stalls; startup bytes do carry over.

| Startup | Ready | Encoded bytes | Collision |
| --- | ---: | ---: | ---: |
| Streamed (default) | 3.0 s | 75.6 MiB | 29 files, 6.0 MiB |
| `?collision=all` | 7.8 s | 116.4 MiB | 304 files, 47.4 MiB |

Measured on `senate-20261020-optimized-m1-cb`. Collision extents add four start
cells (25 files, 5.2 MiB, under `residency-1`).

- Main JavaScript: 12,603,121 → 8,479,418 bytes (1,067,487 gzipped). Rapier's
  3,105,893-byte binary is now a separate, cacheable file.
- Low preset startup: city textures 14.4 → 5.1 MiB, total 71.7 → 61.4 MiB.
  At the Senate endpoint the resident detail textures are 63.0 → 38.1 MiB for
  the same 14 cells; the remainder is mostly 512-pixel BasisLZ ground textures.
- Visual residency stays bounded: three standard circuits (205 geometries) and
  two low circuits on each world (187–189), retained heap 43.7–45.4 MiB. On
  `senate-20261020-optimized-m1-cb`, three standard circuits hold 205 geometries
  and 199 textures, retained heap 44.7–46.1 MiB.

## Verification

- Keyboard journeys 2/2 (Wasted → Meilahti, Busted → Pasila) with Vulkan; both
  Node replays match with `residency-2` collision (`bc1bdbb9`, `de6d5102`).
- Keyboard drive Senate → Kluuvi → Esplanadi → Senate: 18,336 ticks, no
  recoveries, replay `41afda4c` matches.
- Revontuli entry, drive and exit: 1,029-tick replay `e587afdb` matches.
- A pre-change recording with every cell loaded (`e943b1fa`) still replays
  identically; a `residency-1` recording is refused. Two older police journeys
  give the same hashes as the pre-change source, which already differed from
  their recordings.
- At (-558, -420), where the Codex review found the gap, `residency-2` loads
  `c_m05_m02` and a ray meets its building at 49.04 m. The simulation test with
  a building reaching into the next square fails under grid-square distances.
- Officer and patrol downloads answering 503 for 15 s: play continues while
  the patrol is 286 m away; beside it, ticks wait with "Could not load the
  police. Retrying…"; the third attempt loads them and play resumes.
- `pnpm test:source` 670/670, `pnpm typecheck`, release tools 71 (one Windows
  skip), `pnpm release:audit` PASS; the Pages stager accepts the collision-extent packet (1,934 files) and
  checks every recorded extent against its collision triangles.

## Follow-ups

- Prefetch under a throttled network has not been measured; only loopback.
- Terrain (11.7 MiB) and the road and scenery JSON (11.4 MiB) still load whole.
- Shared ETC1S ground textures are counted once per cell handle in the texture
  budget, although Three.js shares their GPU source.
- Resetting a simulation does not free the previous physics world (pre-existing).
- `runStartupJobs` is no longer used by the loader.
- `teleport`, `dropIn` and `step` in the review API may now return a promise.
- Visual cell streaming still measures grid squares, not model extents.
- Police beyond 128 m are not drawn until their models arrive.
- The residency soak's endpoint texture count moves by about nine between
  circuits (pre-change 199, 199, 190; one run 191, 199, 199, which fails the
  allowance of 4; its rerun 199, 199, 199).
