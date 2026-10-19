# 0005 City terrain, the user's Cathedral model and the Senate Square surroundings; no 2017 mesh anywhere

Date: 2026-10-16. Status: accepted (user decisions: "yes, replace the terrain with the city layer"; "For cathedral
model use models/Helsinki-cathedral-lowpoly.stl / You must get rid of 2017 mesh completely"; "Not only cathedral but
also other places as buildings around senate square look really bad"). Street View stayed a by-eye reference only.

## Decision

The released world no longer depends on the 2017 photo-mesh in any build step. The terrain and the origin height come
from the city terrain model, the Cathedral's visual from the user's model, and the ground around the square draws the
steps and walls that the smooth terrain cannot show.

| Was (decisions 0001, 0003, 0004) | Now |
| --- | --- |
| Terrain: lowest 2017 mesh surface per 1 m, filtered | The city terrain model, layer `2021_terrain` (quantized-mesh, zoom 18, 80 tiles), sampled linearly inside its triangles on the 1 m grid, heights as delivered (`build_terrain.ts`). `fetch_terrain.ts` mirrors the tiles for offline tooling; the game never requests `kartta.hel.fi` (rule 18.3). Resolves `DATA-002`. |
| Origin `senate-square-statue-v1`, height 7.29 m from the mesh | `senate-square-statue-v2`: same E/N, height 7.50 m from a least-squares plane through the terrain model on an 8–20 m annulus (1 057 of 1 064 samples, RMS 0.052 m; `derive_origin_height.ts`) |
| Cathedral visual: the textured LoD2 | `models/Helsinki-cathedral-lowpoly.stl` placed on its register building (`place_landmark_model.ts`): centred on the footprint, turned to its edge direction (3.0°), scaled per axis so the plan above the base plate matches the footprint extent and the height matches the LoD2 top. `tools/blender/build_landmark_model.py` gives it three flat materials (plinth, wall and roof colours from the LoD2 building's own texels) and bakes light with Cycles into one 2048² texture (38 754 triangles). The building record and its register-prism collider stay the LoD2's. The corner pavilions stay LoD2. |
| Grand stairs: a ramp of terrain | Treads and risers from the OpenStreetMap steps ways that carry a width and a step count: the grand stairs (46 steps, 65 m wide, 0.185 m risers on 0.36 m treads) and the 15-step flight (0.137 m risers). Drawn only; the smooth terrain stays their collision, within half a riser of every tread. |
| Entrance steps at doors: slab pyramids | 13 entrance terraces: terrain bumps more than 0.2 m above the terrain's 4 m flat-disk opening, outside footprints, within 1 m of a footprint and 1.5 m of an OSM steps way, grown by 1 m, sliced along the terrain contours into 0.16 m levels. Drawn only; the terrain's own 1 m grid squares are their collision. |
| Retaining walls: 1–2 m ramps of terrain | 21 of the 37 OSM `barrier=retaining_wall` ways in the play area (521 m, median heights 0.5–5.3 m): segments whose sides, read 2 m out, differ by at least 0.5 m cut the ground along their line; each side keeps its level up to the line and a vertical face joins them. Drawn and colliding (authored ground, not visual building geometry). |
| Facade grade gamma 1.0, saturation 1.15 | Gamma 0.8, saturation 1.25: walls in shade read olive and dark against Street View; sunlit cream walls must not clip |
| Untextured walls: the median textured wall (99/106/101), which read grey-green | The mean of the 80th to 90th luma percentile of the same samples (212/210/195), lit plaster. Roofs unchanged. |
| Facade pages capped at 512 px | Pages of the seven buildings within 20 m of a Senaatintori street part keep 1000 px when at least half the page is wall, at least 30 % of that wall faces the square (outward normal within 60° of the direction to the origin) and the cap would leave fewer than 15 texels per metre: 10 pages |
| Square paving: coarse procedural tiles | Setts 17 cm and cobbles 10 cm in running-bond rows with rounded edges, stone tints within about 12 % (still seeded procedural, `tools/world/lib/textures.ts`) |

Configuration lives in `content/helsinki/cells.json` (`entranceTerraces`, `retainingWalls`, `texelCap`,
`untextured`, `facadeGrade`, each with a note) and `content/helsinki/landmarks.json` (`models`, `hiResFacadesVtj`).

## Why the facing rule

The first version kept 28 pages at full resolution. The build estimate read about 130 MiB, but the browser measured
175.4 MiB of uploaded textures on the low preset against its 160 MiB budget (release `senate-20261016-81987ee7`,
`data/evidence/browser-surroundings-low`). Pages that mostly face away from the square are seen only from the side
streets, where 512 px holds up; keeping the 10 square-facing pages measured 144.8 MiB with the square's facades
unchanged in the fixed-camera captures.

## Limits accepted

- Terraces follow the terrain's contours, so they read as stepped landings rather than rectangular flights with
  cheek blocks; the café terrace top takes the fallback yard finish; a sliver remains where the west stairs meet
  their retaining wall.
- The Cathedral's dark strips at the drum are openings in the STL itself.
- The University looks paler than in Street View, a few thin stretched LoD2 wall strips remain on the Government
  Palace's south facade, and Aleksanterinkatu's facades are soft at close range (source resolution).
- Some YLRE street parts overlap on the square.
- The four untextured LoD2 buildings are still windowless boxes (backlog 25). The Alexander II statue is still
  missing (`ART-002`).

## What still references the 2017 mesh

Nothing. No build step of the release reads it, and on 2026-10-16, at the owner's decision, the raw mirror
(`data/raw/helsinki-mesh-2017`), the inherited pilot data (`data/work/pilot-v1`) and the inherited pilot-v1 tools that
read the mesh were deleted (`tools/world/fetch_mesh_cells.py`, `localize_cells.py`, `objmesh.py`, `derive_origin.py`,
`plan_district.py`, `build_proof_release.py`, `tools/world/lib/objmesh.ts`, `tools/blender/build_city_district.py`,
`build_city_proof.py`, `tools/blender/district/`, `tools/build-district.sh`, `tools/build-proof.sh`, and the Python
tests of those modules), together with the superseded releases and intermediate builds. Evidence and benchmark
records that name them are history; their recordings no longer replay.

## Results

Release `senate-20261016-57f007bf` (cells `data/work/m0/cells-v13`, log `data/logs/build-cells-v13.log`); details in
`docs/benchmarks/square-surroundings.md`. Browser check PASS 8 of 8 on both presets: 144.8 MiB uploaded textures
(limit 160 low, 320 standard), at most 172 (low) and 200 (standard) draw calls, about 142 fps in the lowest scene.
Transfer to first control rose from 63.4 MB (release `9ef28d77`) to 76.3 MB. The Cathedral GLB passes its mesh
census (closed, 9 shells, size within 1 mm of the STL under the placement). The M1 journey gate passes 10 of 10
(`journey-57f007bf-4`) after three journey-harness fixes (backlog 26). The gates before them failed on harness
faults, and one of those runs exposed the missing pilot-edge barrier (backlog 31).
