# Web delivery handoff — 20 October 2026

Status at the original handoff: LOCAL ONLY, NOT PUBLISHED. The faster build runs on this machine at
http://127.0.0.1:5317/Helsinki-rides/. The live site still serves
`senate-20261020-optimized` as pinned by `content/releases/pages.json`. Nothing
had been pushed; this checkout has no Git remote. Release preparation corrected
the deferred-officer position finding below and adds a regression test. Publish
only from the separately audited export, following the instructions below.

The design and its measurements are in
[decision 0022](decisions/0022-web-delivery-collision-streaming-and-texture-tier.md);
the earlier model work is in [model optimization](model-optimization-2026-10-20.md).
This note records how the work was done and how to rebuild, serve, verify and
publish it.

| Item | Identity |
| --- | --- |
| Source commits | `0835056` (source with the pass), `f2660e8` (collision extents, police model retry) |
| World release | `senate-20261020-optimized-m1-cb` |
| Manifest SHA-256 | `5a3502a4641de1a79dfd40dbb06724b59d4e908d16f3a5218b8e7dcead3f7ebd` |
| World | `build/model-optimization/world/senate-20261020-optimized-m1-cb` (592,846,997 bytes, 1,934 files) |
| Served shell | `build/perf-optimization/production-senate-20261020-optimized-m1-cb` |
| Review shell | `build/perf-optimization/review-senate-20261020-optimized-m1-cb` |
| Pages packet (validated) | `build/perf-optimization/pages-stage-cb`, archive `pages-world-m1-cb.tar.gz` (536,410,482 bytes, SHA-256 `b0af52cd…`) |
| Draft descriptor | `build/perf-optimization/pages-m1-cb.json` (placeholder Release tag) |

Everything under `build/` is ignored by Git, including the helper scripts named
below. They exist only on this machine.

## Why it feels faster

The previous preview on port 5317 served `apps/game/dist`: the runtime before
this pass with the full-resolution local world `senate-20261020-optimized-native`
(1,254,785,388 bytes). The new server uses the web texture set plus the changes
below, so part of the difference is the smaller standard textures, not only
this pass. The two were not measured against each other.

Measured on the same world and shell (local loopback, desktop GPU):

| Startup | Ready | Encoded bytes | Collision at start |
| --- | ---: | ---: | ---: |
| Streamed (default) | 3.0 s | 75.6 MiB | 29 files, 6.0 MiB |
| `?collision=all` | 7.8 s | 116.4 MiB | 304 files, 47.4 MiB |

The previous pass recorded an 11.5 s start for its own runtime. Loopback hides
network latency, so real visitors gain mostly through the smaller downloads.

## How it was done

Each change keeps the simulation deterministic: a recording names the collision
rules it was made under, and the Node replay uses the same rules.

1. **Collision streaming.** Startup used to download and build all 304
   collision cells. [`collision-residency.ts`](../packages/sim/src/collision-residency.ts)
   now plans which cells must be in the physics world from the player, actors
   and fixed anchors, using rings measured to each cell's recorded collision
   extent. Needed cells go in immediately, one further cell per tick, and
   removal happens only outside every keep ring. The browser side,
   [`collision-stream.ts`](../apps/game/src/world/collision-stream.ts),
   prefetches bytes ahead of those rings, four requests at a time into a 64 MiB
   cache. If a tick needs bytes that have not arrived, ticks wait ("Loading
   nearby streets…") instead of stepping without ground. Recordings carry
   `collision: 'residency-2'`.
2. **Collision extents.** A building belongs to one cell but can reach up to
   118.5 m into its neighbours, so measuring grid squares left walls out.
   [`record_collision_bounds.ts`](../tools/world/record_collision_bounds.ts)
   writes a new world that hard-links every payload and adds each cell's
   `collision.boundsXZ`. The Pages stager decodes every bundle again and
   refuses an extent that misses a triangle.
3. **Startup CPU.** Patrol spawn placement ran a breadth-first search from every
   lane, about 1.75 s per simulation. Strongly connected components give the
   same reach counts, and `LaneSegmentIndex` answers nearest-lane queries from a
   32 m grid with the original visiting order and arithmetic
   ([`police.ts`](../packages/sim/src/police.ts),
   [`roads.ts`](../packages/world-schema/src/roads.ts)).
4. **Smaller main bundle.** Rapier's compat build inlines its WebAssembly as
   base64. [`vite.config.ts`](../apps/game/vite.config.ts) emits the identical
   binary as a hashed file and fails the build if the bytes differ. Main
   JavaScript went from 12,603,121 to 8,479,418 bytes. Production pages
   preload the pinned manifest and the Rapier binary.
5. **Repeat visits.** Pages registers `sw.js`
   ([`main.ts`](../apps/game/src/main.ts)): cache-first only for the pinned
   world release and hashed app files; a new release deletes old caches;
   `?sw=0` removes it.
6. **Deferred models.** Rain and the patrol car's two models load after the
   game is playable ([`assets.ts`](../apps/game/src/render/assets.ts),
   [`game.ts`](../apps/game/src/game.ts)). While police within 128 m have no
   model, ticks wait ("Loading the police…"). A failed load is retried after
   2, 4, 8 and 16 s, then every 30 s, requesting only what is missing.
7. **Low-preset texture tier.** [`build_texture_tier.ts`](../tools/world/build_texture_tier.ts)
   adds a copy of each large UASTC texture without its top mip level; the
   remaining bytes are identical and checked. 490 of 506 textures gained a
   copy (292,590,777 → 77,845,827 bytes). Only the low preset requests them.
8. **Preset choice.** The loading screen offers Auto, Standard and Low and
   remembers the choice ([`config.ts`](../apps/game/src/config.ts)). Auto picks
   Low for four or fewer cores or 4 GB or less device memory.
9. **Dynamic resolution.** Outside review builds, render scale drops in 0.15
   steps to 0.6 when frames stay slow while the CPU is not the bottleneck, and
   recovers slowly ([`scene.ts`](../apps/game/src/render/scene.ts); `?dynres=0`
   disables it).
10. **Minimap.** [`hud.ts`](../apps/game/src/ui/hud.ts) draws 256-pixel tiles
    on demand instead of one 66 MB canvas.
11. **Measuring.** Startup sets `helsinki:*` performance marks, and
    [`smoke-pages.mjs`](../tools/verify/smoke-pages.mjs) reports startup bytes
    by category (`--max-startup-mb` sets a ceiling).

## Serving it locally

Commands run from the repository root in Git Bash.

```bash
HELSINKI_OPT_SHELL=build/perf-optimization/production-senate-20261020-optimized-m1-cb \
  node build/perf-optimization/serve-local.mjs
```

[`serve-local.mjs`](../build/perf-optimization/serve-local.mjs) serves the shell
at `/Helsinki-rides/` and worlds from `build/model-optimization/world`, on port
5317 (`HELSINKI_PORT` changes it); `/` redirects to `/Helsinki-rides/`. Use the
review shell instead for `?review=1`. Useful queries: `?preset=low`,
`?collision=all`, `?sw=0`, `?dynres=0`.

The old preview can be restored with
`pnpm --filter @helsinki/game exec vite preview --host 127.0.0.1 --port 5317 --strictPort`
after stopping this server.

## Rebuilding

World derivatives (each output must be new):

```powershell
node tools/world/build_texture_tier.ts --source build/model-optimization/world/senate-20261020-optimized --out build/model-optimization/world/senate-20261020-optimized-m1 --release senate-20261020-optimized-m1 --report build/model-optimization/texture-tier-report.json
node tools/world/record_collision_bounds.ts --source build/model-optimization/world/senate-20261020-optimized-m1 --out build/model-optimization/world/senate-20261020-optimized-m1-cb --release senate-20261020-optimized-m1-cb --report build/model-optimization/collision-bounds-report.json
```

Local shells pinned to a local world, with `worldBaseUrl` null so the world
comes from the same origin ([`local.config.ts`](../build/perf-optimization/local.config.ts)):

```bash
for M in production review; do
  HELSINKI_PERF_RELEASE=senate-20261020-optimized-m1-cb \
    pnpm --filter @helsinki/game exec vite build --config ../../build/perf-optimization/local.config.ts --mode $M
done
```

Output goes to `build/perf-optimization/<mode>-<release>`. Do not use
`pnpm build:pages`: `apps/game/dist-pages/world` holds an old staged world that
Vite cannot delete (EPERM).

Pages packet: [`stage_cb.sh`](../build/perf-optimization/stage_cb.sh) packs the
world as a regular-file USTAR archive ([`pack_world.py`](../build/perf-optimization/pack_world.py)),
writes a descriptor, builds the Pages shell against the public world URL and
runs `tools/release/stage-pages-world.py stage` over both. The last run passed
(`stage-cb.json`). It ran before `f2660e8` was committed and must be rerun
after any source change.

## Verifying

[`verify_cb.sh`](../build/perf-optimization/verify_cb.sh) runs, through
[`run-local.mjs`](../build/perf-optimization/run-local.mjs), the Pages smoke
(also with `?collision=all`), a three-circuit residency soak, two keyboard
journeys with Node replays, the extra-cars check and the long drive. Logs go to
`build/perf-optimization/logs`. Every verifier refuses an existing `--out`, so
move the previous result folders aside first. Journeys need
`HELSINKI_VERIFY_ANGLE=vulkan`, which the script sets.

Fault injection for the deferred models (`run-local.mjs` answers 503 for
matching paths for the first N seconds):

```bash
HELSINKI_FAIL_PATTERN='character-rain|vehicle-patrol' HELSINKI_FAIL_SECONDS=15 HELSINKI_VERIFY_ANGLE=vulkan \
  HELSINKI_QUERY='?review=1&audio=0' HELSINKI_OPT_SHELL=build/perf-optimization/review-senate-20261020-optimized-m1-cb \
  node build/perf-optimization/run-local.mjs build/perf-optimization/verify-deferred-faults.mjs --out build/perf-optimization/deferred-faults-new
```

Source checks: `pnpm test:source` (the `apps/game/test` files run only there,
not under `pnpm test`), `pnpm typecheck`,
`python -m unittest discover -s tools/release/test -p 'test_*.py'` and
`pnpm release:audit`.

Last results on this world: journeys 2/2 (replays `bc1bdbb9`, `de6d5102`),
drive 18,336 ticks without recoveries (`41afda4c`), Revontuli `e587afdb`,
fault injection 6/6, smoke with only the expected `release-info.json` 404 from
the local server, residency soak passing on rerun, 670/670 source tests,
typecheck, 71 release-tool tests (one Windows skip) and the release audit.

## Publishing

The owner authorized publication of this pass on 20 October 2026. This remains
an authoring handoff; the committed descriptor and deployment receipt identify
the actual published source and world.

Follow [releasing and rolling back](public-game-release.md#releasing-and-rolling-back).
Publish from the source export `build/source-release`: its `main` (`f8f8b08`)
is the live source and `origin` is `MattiTynka/Helsinki-rides`. Never push this
workspace: its history is unrelated to the public repository and it keeps the
original Estates photographs, which the export strips of metadata.

1. Rebuild the shells and rerun the checks after the deferred-officer fix below.
2. Copy the 49 files listed in `build/perf-optimization/publish-files.txt`
   into the export. Keep the export's own
   `content/assets/facades/estates/*` and
   `tools/world/lib/estates-facade-restoration.ts`.
3. Upload `pages-world-m1-cb.tar.gz` unchanged as `pages-world.tar.gz` on a new
   Release. Its bytes do not depend on the tag.
4. Write `pages-m1-cb.json` to the export's `content/releases/pages.json`, with
   the placeholder tag in `archiveUrl` replaced by the real one.
5. In the export, run the source checks, `source_release.py audit --images --git`
   and Gitleaks as [source release](open-source-release.md#repeatable-source-export)
   describes, then commit and push `main`.
6. Run the Pages workflow, then `tools/verify/smoke-pages.mjs` against the live
   URL. The packet is 605,616,536 bytes, under the 1 GB Pages limit.

## Open items

- **Review finding corrected during release preparation.** Seated officers keep
  their spawn or boarding position while their car moves. The deferred-model
  readiness check now measures them at their vehicle's current position, falling
  back to their own position if the vehicle is unavailable. The regression in
  `tools/verify/test/game-view-lifecycle.test.ts` covers both stale-position
  directions, the 128 m boundary, officers on foot and missing vehicle references.
- Visual cell streaming still measures grid squares, not model extents.
- Police beyond 128 m are not drawn until their models arrive.
- Finn's shadow blob is missing in frames while ticks wait.
- The residency soak's endpoint texture count moves by about nine between
  circuits; one run failed its allowance of 4 and passed on rerun.
- Throttled-network prefetch is unmeasured; terrain (11.7 MiB) and road and
  scenery JSON (11.4 MiB) still load whole.
- `pages-world-m1.tar.gz`, `pages-stage-m1` and the `senate-20261020-optimized-m1`
  world are superseded by the m1-cb versions.
- The workspace's untracked `.pnpm-store/` is not a release input. Do not copy it
  or the workspace's unrelated history into the export; audit the export itself.
- `game.ts` and `simulation.test.ts` use CRLF line endings; edit them without
  converting the whole file.
