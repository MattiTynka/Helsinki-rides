# Live city cells from kartta.hel.fi/3d: plan

Date: 30 October 2026. Status: design only, not implemented. Base: `d302e89` on `city-expansion-southwest`, world `helsinki-20261030-hietalahti-optimized-v1`.

## Goal

When Snow walks or drives toward ground the release world does not cover, the browser fetches the City of Helsinki's own 3D data from kartta.hel.fi/3d. It converts that data into the game's cell format and inserts it before Snow arrives, so the city continues instead of ending.

"Missing cells" means every 128 m square of the world grid that has no manifest cell:

- the 153 empty slots inside the current rectangle: 113 in the north-west block and 40 in the south-west block (928 slots, 775 cells);
- everything outside the rectangle, up to the edge of the city's tilesets. That is about 23 × 23 km, or roughly 32,000 squares.

Why live instead of more release cells:

- It needs no Blender or append pipeline.
- It needs no 1.2 GB world candidate on a disk that is 99% full.
- It needs no publish cycle.

The price is a raw quality tier. Live cells get no hand-made repairs, as listed under "What live cells will not have".

## Measured on 30 October 2026

| Item | Finding |
| --- | --- |
| Building layer | `datasource-data/e5e7158a-…/tileset.json`, the textured LoD2 layer the pipeline already uses. 3D Tiles 1.1, `tilesetVersion` 306008215668, root modified 29 Oct 2026. A quadtree of external tileset JSONs, 5–6 hops from the root to a leaf. Leaves have geometric error 1.25 m and span 40–110 m. |
| Tile content | GLB with `KHR_texture_basisu` (ETC1S KTX2, **one mip level**), `EXT_mesh_features` per-vertex feature ids, and `EXT_structural_metadata`. Each feature's `id` is `BID_<uuid>`, the same id the manifest uses for its buildings. Features also carry address, `VTJ_PRT`, height and storeys. |
| Browser access (CORS) | `datasource-data` echoes the request's Origin; tested with `https://mattitynka.github.io` and `http://127.0.0.1:5419`. Geoserver WFS and WMS answer `*`. Bodies are brotli-encoded with `cache-control: public, max-age=0` and an ETag, so every request revalidates. |
| Terrain | `datasource-data/4383570b-…`, quantized-mesh 1.0 with octvertexnormals, geographic TMS zoom 0–18. Layer version 1.1708423032937557 is the same Feb 2024 data as the release terrain. A zoom-18 tile is about 38 × 76 m and about 10 KB. A cell needs 8–12 tiles. |
| WFS, one cell | Building footprints (`avoindata:Rakennukset_alue_rekisteritiedot`): 9 features, 24 KB, 0.18 s. Street and green parts (`avoindata:YLRE_Katu_ja_viherosat_kaikki_alue`): 38 polygons, 131 KB, 0.18 s, classed as Ajorata, Jalankulkualue, Nurmikko, Koroke, cycle paths, Pysäköintialue, Tukimuuri and so on. Sea polygons: `avoindata:Maavesi_merialue`. |

Cost of one dense cell just north of the map edge (x 0…128, z −2432…−2304), by the geometric error at which refinement stops. Coarser tiles also cover neighbouring cells:

| Stop at error | Tiles | Download | Triangles | Texels |
| --- | ---: | ---: | ---: | ---: |
| 1.25 m (leaves) | 7 | 7.49 MB | 3,443 | 46.3 M (about 44 MiB at 8 bpp) |
| 2.5 m | 4 | 2.68 MB | 3,826 | 13.8 M |
| 5 m | 2 | 1.59 MB | 5,446 | 5.5 M |
| 10 m | 2 | 3.17 MB | 18,738 | 5.2 M |
| 20 m | 1 | 3.13 MB | 22,504 | 2.6 M |

For comparison, a release cell is about a 1.8 MB GLB, with a texture estimate of about 4.5 MB and about 50k triangles. Walking the tileset and downloading the leaf set took about 0.9 s from this machine.

Getting the data is not the hard part. The hard parts are texture memory, deterministic physics, and what the city model does not contain: bridges, kerbs and a road graph.

## Design

### 1. A live cell is a missing cell of the same grid

- A live cell uses the same 128 m grid, the same ids (`cellId(cx, cz)`), and the same origin and runtime frame.
- A square is live when it has no manifest cell and lies inside the tileset region.
- A live cell produces the same two payloads as a release cell: HCOL v2 collision bytes and a THREE visual. So the following keep one code path each:
  - `StaticWorld` insertion;
  - `CollisionStream`;
  - `CellVisualStream`;
  - the city materials;
  - the budgets.
- Only the byte source changes: a `LiveCellSource` running in a worker replaces the release host.
- The converter becomes browser-safe shared code, used by both the Node tools and the game so the numbers match exactly. It ports:
  - `tools/world/lib/quantized-mesh.ts`;
  - the GLB, feature and ECEF→GK25 projection code in `convert_city_model.ts`;
  - `encodeCollisionBundle`.

  It lives in `packages/world-schema` or a new package. Network code, traversal and caching live in `apps/game/src/world/live/`.

### 2. Split collision from visuals

This is the key decision.

- **Collision must arrive first.** The simulation stops ticking until a needed collision cell is present.
  - Collision inputs per cell are small: about 10 terrain tiles (about 100 KB), WFS footprints (about 25 KB) and sea polygons. They take about 0.3–0.5 s.
- **Visuals can arrive late.** They are large, and arriving late only causes pop-in.
- **Building collision uses WFS footprints extruded into prisms.** Release cells also use `collider: "prism"`.
  - The LoD2 leaves are not used for collision: a dense leaf set is 7.5 MB, mostly texture, for 3.4k triangles.
  - Prism height comes from the register's storey count (`i_kerrlkm` × 3.2 m + 3 m). Snow's climb reaches only 0.3–1.5 m, so roof accuracy does not matter for play.
  - Collision bytes must never depend on when the visual happened to load.

### 3. Building a collision cell

This runs in a worker and must be deterministic.

- **Ground**
  - Sample the quantized mesh on the release terrain's 1 m lattice with the same sampler `build_terrain.ts` uses. That gives a 129 × 129 grid and an HCOL `ground` trimesh of about 32k triangles.
  - Inside the rectangle, take heights straight from the resident `TerrainGrid`. The values are then identical and there is no seam.
  - On the rectangle edge, boundary vertices copy the grid's edge row.
- **Sea**
  - Drop ground quads whose centre lies in a sea polygon.
  - Falling into the sea uses the existing kill-height recovery.
- **Buildings**
  - A building belongs to the cell that contains its footprint centroid.
  - Footprints are clipped to the square plus 32 m. The cell's collision extent is therefore known before any download, which the residency planner needs.
  - Skip every building whose `BID_…` id or VTJ id is already in the manifest.
- **Output**
  - HCOL v2 bytes and their SHA-256.

### 4. Residency and determinism

- **Live squares in the residency plan.** `CollisionResidency.plan` iterates a fixed list today. Extend it to also enumerate live squares within `keep` (216 m) of each source.
  - That is about 25 squares per source, each with extent square ± 32 m.
  - The result is still a pure function of simulation state, so the browser and the replay insert and remove cells on the same ticks.
- **Recordings.**
  - Recordings carry `live: 'kartta-live-1'`, plus one event per inserted live cell: tick, id, SHA-256 and source versions.
  - A replay gets identical bytes from either an exported live-cell bundle saved with the recording, or a rebuild from the current sources.
  - A hash mismatch fails loudly with "live source changed" and never diverges silently.
  - Node and Chrome both run V8's fdlibm maths. Check this by hashing the same cell in both.
- **Failure.**
  - A needed live cell that fails three retries (offline, or the server is down) is inserted as an empty cell, and that is recorded.
  - Snow then falls and recovers, as at the edge today. The game never freezes indefinitely waiting on the city's server.
- **Prefetch.**
  - `CollisionStream` already prefetches the player's want ring (152 m), plus a 160 m margin, plus 4 s of velocity.
  - At 30 m/s, a new row of about three cells is needed every 4.3 s.
  - A collision build takes about 0.5 s per cell with four running at once.
- **Ground height outside the grid.**
  - `groundHeight()` clamps to the release grid's edge outside it. It has six call sites, in `game.ts`, `safe-spawn.ts`, `simulation.ts` and `world.ts`.
  - Outside the grid it must fall back to resident live ground, or to a physics ray. Otherwise spawn, camera and recovery heights are wrong.

### 5. Building a visual cell

- **Level of detail by distance**, using the tileset's own geometric error:
  - 1.25 m leaves only within about 60 m, and only on foot;
  - 2.5 m out to the detail radius (110–230 m, depending on tier);
  - 5–10 m out to the fallback radius (220–420 m);
  - 20–40 m as an optional skyline ring beyond that.
  - The Low preset never loads leaves and uses the compact BC1/ETC2 transcode.
  - The tiles have no mips, so coarser tiles at distance also stand in for mipmapping and avoid shimmer.
- **Splitting coarse tiles.**
  - Coarse tiles cover several cells. Split each tile's triangles into per-cell meshes by building centroid, using the feature id.
  - Each cell can then show and hide on its own, and the release world's own buildings are culled by id.
  - Split meshes share their tile's textures, and each texture is counted once in the budget.
- **Materials.**
  - Build live meshes with the same city material classes and attribute set that `adaptCityMaterial` gives release cells.
  - Add the live variant to `render/warmup.ts`. Otherwise the first sight of a live cell compiles a new shader and brings back the stutter fixed in `d302e89`.
  - Untextured LoD2 parts get the district median wall and roof colour, as decided in 0004.
- **Uploads.** A dense leaf cell has about 50 KTX2 images. Spread them over frames through the per-frame budget in `render/upload-queue.ts`.
- **Ground visual.**
  - A terrain mesh painted by YLRE class: carriageway, sidewalk, lawn, cycle path, parking. It uses the release paving textures, with skirts on the cell edges.
  - An aerial photo is the alternative; see the decisions below.
- **No blocking on visuals.** Live cells never block rendering, so `missingVisualCoverage` must ignore them. Only collision may stall the game.
- **One budget.**
  - Static and live cells share the same texture and geometry budgets through one `CellVisualStream`.
  - The stream gets a candidate provider: static cells plus live squares near the focus, found through a grid hash. It must not iterate about 32,000 squares every frame.

### 6. Network, caching and courtesy

- **What may be fetched.**
  - Fetch only from `datasource-data` and the geoserver.
  - Allow-list the two layer ids (textured LoD2 and 2021 terrain). Never fetch the 2017 reality mesh; that is the owner's rule.
- **Request limits.** At most four concurrent requests to kartta.hel.fi, aborted when Snow moves away, with retry and backoff.
- **Version check.** At session start, read the root tileset's `tilesetVersion` and the terrain `layer.json` version.
- **Cache.**
  - Converted collision and visual payloads go into a Cache Storage namespace named `helsinki-live:<versions>:<converter>`.
  - Revisits are then instant, and the city's servers see each tile once per player.
  - Keep this separate from the service worker, whose allow-list covers only the world host.
- **Attribution.** The credits already list the same City of Helsinki sources under CC BY 4.0. Add "streamed from kartta.hel.fi/3d".

## What live cells will not have

- **Bridges.** The terrain model is bare earth and has no bridge decks. Snow cannot cross to Lauttasaari and falls into the water. The release world's bridges were rebuilt by hand.
- **Small structures.** Kerbs, stairs, retaining walls and terraces are missing. YLRE `Tukimuuri` polygons could add walls later.
- **Road graph.** Without one there are:
  - no traffic, parked cars, pedestrians or police patrols;
  - police pursuit that stops at the graph's edge;
  - no streets on the minimap. YLRE carriageways could be drawn there.
- **Facade and tree work.** There are no facade repairs, some facades are untextured or blurry, and there are no trees unless the city's tree layers are added.
- **Recovery anchors.** They are all static, so recovering far out in a live area moves Snow a long way back.

## Phases

0. **Spike (throwaway).**
   - Show live tiles beyond the north edge at 2.5 m error, visual only.
   - On Standard and Low, measure download, upload time, GPU MiB and frame time.
1. **Playable (the goal).**
   - Collision payload, the residency extension, empty cells on failure, and recording events.
   - Live visuals with distance detail levels and shader warm-up.
   - Result: Snow can walk and drive into Töölö and Kallio.
2. **Looks and robustness.**
   - YLRE ground paint, the sea surface and the ground-height fallback.
   - Minimap streets and the Cache Storage layer.
3. **Optional.** Skyline ring, trees, bridges, traffic.

## Decisions for the owner

1. **Ground look.**
   - **YLRE surface classes (recommended):** matches the current ground.
   - **Aerial photo** (`avoindata:Ortoilmakuva` WMS): recognisable quickly, but cars, shadows and leaning roofs are baked into the ground.
2. **Replays when the city republishes data.**
   - **Save the live bundle with each recording (recommended).**
   - **Accept** that old recordings stop replaying.
3. **Reach.** The whole city (the tilesets cover about 23 × 23 km), or a ring, for example 2 km, around the release map.
4. **Which phase 3 items**, if any.

## Risks

- **The city's service.** kartta.hel.fi has no stated SLA or rate limit. CORS could be tightened at any time; the game then falls back to today's edge.
- **Weak GPUs.** Leaves cost about 44 MiB of texture per dense cell. Only the distance rule keeps this inside the Low budget.
- **Seam steps.** Steps are possible where release ground was re-authored at the rectangle edge.
  - Measure them in phase 1.
  - If a carriageway step exceeds 5 cm, snap the boundary to the neighbouring release HCOL ground.
- **Data drift.** The release snapshots date from 19 October 2026. A building rebuilt since then under a new id could appear twice at the seam. Centroid ownership limits this to boundary squares.

## Acceptance

The owner tests these in the game:

- Drive north out of the map at full speed with no "Loading the city…" stall.
- Walk around a live block and into its courtyard; buildings block Snow.
- Cross back over the seam with no bump over 5 cm and no fall.
- Standard and Low stay inside their texture budgets.
- A recorded run into a live area replays exactly.
