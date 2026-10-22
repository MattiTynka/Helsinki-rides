# Helsinki-rides

A browser game demo in the GTA mould set in central Helsinki, built from the city's open data per
`docs/Helsinki_Browser_Game_Implementation_Plan_v3.md`. Milestones M0 (baked pilot cells) and M1 (the 60-second
test: walk, take a car, drive, ram a patrol car, pursuit, shoot, be shot at, die or get arrested) are implemented.

The district expansion covers 4.15 km² across 304 cells, from Senate Square toward
Mannerheimintie, Parliament House, the Music Centre and Finlandia Hall, and east
around Uspenski Cathedral and Katajanokka, and west through Kamppi to
Temppeliaukio's public approach. The northern extension adds the public approaches
around Töölöntori, Sandelsinkatu, Välskärinkatu and Runeberginkatu. Hakaniemi is a
separate drop-in context; connected bridge travel is not established. Nearby visual cells stream in as the
player moves; distant cells unload. Static collision remains resident. The 2017
mesh is absent. Esplanadi, Senate streets and qualified central Mannerheimintie
surfaces use reference-led stone paving; northern Mannerheimintie retains the
source asphalt with separately mapped stone islands. Senate Square has fan-pattern cobbles, and Mannerheimintie has
embedded tram rails. See the [district build recipe](docs/district-expansion-build.md)
and [current verification record](docs/benchmarks/city-north-2026-10-19.md) for the
exact candidate, limits and acceptance status. The [city expansion handoff](docs/handoff-2026-10-19.md)
records the local preview, source snapshots and reproducible checks.

Play the desktop browser beta at **[Helsinki Rides](https://mattitynka.github.io/Helsinki-rides/)**.
The full central Helsinki map streams nearby visuals as you travel. The initial
city-data download can take a while. Use WASD to move, Space to jump, and F to
enter or leave a car; the loading screen lists the remaining controls.

The public source repository is `MattiTynka/Helsinki-rides`.
Original code is [MIT-licensed](LICENSE);
third-party material retains its [own licenses](THIRD_PARTY_NOTICES.md).
The source checkout excludes the generated city and supplied character/car/landmark
models. Versioned game-world downloads are distributed separately through
GitHub Releases. Known content credits are retained; the owner will provide the
remaining supplied-asset copyright details. See the
[public beta release record](docs/public-game-release.md).
See the [source release guide](docs/open-source-release.md),
[privacy audit](docs/source-privacy-audit.md) and
[GitHub Pages release plan](docs/github-pages-release-plan.md).
The [local model optimization](docs/model-optimization-2026-10-20.md) documents
the smaller derivative, exact physics/image preservation and reproducible tools.

## Source checkout

Use Node.js 22.18 or newer, Python 3.12 or newer and pnpm 10.28.2.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test:source
python -m unittest discover -s tools/release/test
python tools/release/source_release.py audit --images
pnpm build:pages
```

The Pages build writes a small application shell to `apps/game/dist-pages`.
Without a configured world release it displays setup guidance. It does not
include the city or make a network request for an unconfigured world. Full local
play needs a separately supplied world packet; see **Play** below. The source
test command explicitly lists the asset-dependent checks omitted from this
checkout. `pnpm test` retains the complete local asset test suite.

## Layout

| Path | What |
| --- | --- |
| `apps/game` | Vite + Three.js client: loader, renderer, HUD, input, audio, test API (`window.__HELSINKI_GAME__`) |
| `packages/sim` | Fixed-step 60 Hz simulation on Rapier (deterministic build): characters, vehicles, weapons, wanted state, police |
| `packages/world-schema` | Coordinates (EPSG:3879 ↔ runtime frame), manifest and bundle types, HCOL/HTER binary formats, road index |
| `tools/world` | Offline pipeline: city model conversion, terrain, roads, cells, gameplay bake, release publisher |
| `tools/verify` | Evidence harnesses: hero-asset contracts, browser benchmark and lighting captures, the 60-second journey |
| `tools/blender` | Headless Blender scripts for the hero assets (characters, pistol, cars) and the Cathedral model, pinned to Blender 5.2 |
| `content/helsinki` | Hand-authored content: origin, cell/road/landmark/gameplay tuning, source register |
| `content/assets` | Asset contracts (character skeleton and clips, vehicle nodes and sockets) and mesh census specs |
| `docs` | The plan, decisions, source register, asset pipeline, benchmark records |

## Build the world

```
pnpm install
node tools/world/convert_city_model.ts   # see the file header for arguments
node tools/world/fetch_terrain.ts ...    # offline mirror of the city terrain layer (never requested by the game)
node tools/world/derive_origin_height.ts ...
node tools/world/build_terrain.ts ...
node tools/world/build_roads.ts ...
node tools/world/place_landmark_model.ts ...   # then tools/blender/build_landmark_model.py (docs/asset-pipeline.md)
node tools/world/build_cells.ts ...
node tools/world/build_gameplay.ts ...
```

Each tool's header documents its arguments; `data/logs/` keeps the runs. Hero assets come from the Blender scripts
described in `docs/asset-pipeline.md`; Finn uses its native export and packaging path, while Rain keeps its
accepted retargeted asset. Publish the combined final character directory. Without `--keep`, `publish_release.ts` deletes every other release under
`--out`, and journey recordings replay only against the release they were made on. Buildings come solely from the
textured LoD2 (decision 0004) except the Cathedral's visual, the owner's model (decision 0005); the terrain is the
city terrain layer. The cell builder's flat colours for untextured surfaces, the facade grade, the hi-res facade
rule, entrance terraces and retaining walls are configured in `content/helsinki/cells.json` (decisions 0003 to
0005).

Use the ordered [district recipe](docs/district-expansion-build.md) for the base
and [northern extension record](docs/city-north-2026-10-19.md) for the
current appended inputs and source snapshots, including the preserved
[western continuation](docs/city-continuation-2026-10-19.md). The pipeline includes ground registration, road support, tree
preservation, shoreline and curb closure, facade charts, stone paving and tram rails before
publishing. Always publish to fresh staging with `--keep`, validate that exact
candidate in the game, then activate its matching ordinary build and `current.json`.
`rebuild_ground.ts` replaces ground while preserving buildings;
`repair_facades.ts` replaces facade image payloads while preserving compressed geometry
and collision. Both require a fresh output directory. See their file headers and
[decision 0009](docs/decisions/0009-facade-and-stair-junction-repair.md) and the
[reference-led facade workflow](docs/decisions/0010-reference-led-facade-reconstruction.md).

## Play

```
pnpm dev            # http://127.0.0.1:5317/
```

Use one server at a time on port 5317. `pnpm dev` serves source edits; to inspect a compiled build, stop it,
run `pnpm build`, then `pnpm preview` at the same address. Both commands use a strict port so a second server
cannot silently move to another address.

Click to start. WASD run, hold Alt to walk, Shift sprint, F enter/exit, mouse aim, left button fire, right button aim, R reload,
G holster/surrender, H horn, Space jump (quick double Space for a super jump; jump at a wall while moving toward it to grab the ledge and climb up), Space handbrake in a car,
hold X to recover a stuck car. The drop-in list (top left) teleports to any address or
landmark. URL options: `?preset=low`, `?lighting=unlit`, `?seed=N`. A compiled review
build additionally supports `?review=1` (no HUD overlay, command tracing and mouse
without pointer lock). The ordinary production build never exposes the review API,
including when `?review=1` is supplied.

## Verify

For reference-led facade repairs, follow the [facade cleanup protocol](docs/facade-cleanup-protocol.md).

```
pnpm typecheck
node tools/verify/verify-glb.ts --character data/work/m0/blender-character --car data/work/m0/blender-car --out data/evidence/NEW
node tools/verify/verify-browser.ts --url "http://127.0.0.1:5317/?review=1" --release apps/game/public/world/<id> --out data/evidence/NEW
node tools/verify/verify-locomotion.ts --url "http://127.0.0.1:5317/?review=1" --release apps/game/public/world/<id> --out data/evidence/NEW
node tools/verify/verify-ground-repair.ts --url "http://127.0.0.1:5317/?review=1" --release apps/game/public/world/<id> --cells <matching-cell-build> --out data/evidence/NEW
node tools/verify/verify-wall-joins.ts --release apps/game/public/world/<id> --cells <matching-cell-build> --out data/evidence/NEW
node tools/verify/play-journey.ts --url "http://127.0.0.1:5317/?review=1" --release apps/game/public/world/<id> --out data/evidence/NEW --runs 10
node tools/verify/replay-recording.ts --release apps/game/public/world/<id> --recording data/evidence/<dir>/run-01-recording.json
pnpm test
python -m unittest discover -s tools/world/tests -t tools/world
```

Hero GLBs also get a mesh census on the pinned Blender (specs in `content/assets/census/`, command in
`docs/asset-pipeline.md`).

The journey harness writes one input recording per run (seed plus the encoded command stream); the replay tool runs
it on a fresh Node simulation and must reproduce the recorded state hash.

The browser benchmark gates draw calls, frame rate and the texture bytes actually uploaded, which it measures in the
page. Add `--preset low` for the low-preset budgets (350 draw calls, 160 MiB). It also reports the bytes transferred
up to first control. For that figure, stop the dev server and benchmark the compiled review build (`pnpm build:review`,
then `pnpm preview` and `--url "http://127.0.0.1:5317/?review=1"`), because the dev server's unbundled modules inflate it. Results are
recorded in `docs/benchmarks/` (baseline: `docs/benchmarks/m1-baseline.md`).

Evidence directories are never overwritten. Screenshots are captured, not reviewed, until someone opens them.
