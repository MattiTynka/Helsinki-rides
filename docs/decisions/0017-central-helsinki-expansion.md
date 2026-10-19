# Central Helsinki expansion and bounded visual residency

Status: implemented and verified for the bounded expansion, active locally
2026-10-18. Release `senate-20261017-185c7a1b`; ordinary bundle `index-CaCVE3GV.js`.
See [measured results and limits](../benchmarks/central-expansion-streaming.md)
and `data/evidence/expansion-20261017/completion.json`.

The user requested continued city construction beyond the Senate district using
kartta.hel.fi/3d, placement of `models/Alexander/Alexander-improved.glb`, and
loading/unloading city meshes as the player moves to keep memory bounded.

The first contiguous extension covers runtime X -800..150 and Z -450..350:
950 x 800 metres (0.76 square kilometres), including Kluuvi, the railway-station
approach and Esplanadi. The existing district is 250 x 500 metres. The projected
origin, height datum and 128-metre grid stay fixed. This is not the whole-city
M4/Pasila/Meilahti milestone.

Implementation sequence:

1. Snapshot the city's textured LoD2, bare-earth terrain, trees and public-area
   register, plus OSM roads, into isolated source directories with hashes.
2. Preserve the accepted Senate building/texture ordering and source data when
   merging new buildings, so the source-bound facade repairs remain valid.
3. Build contiguous ground, stairs, collision and road connectivity. Exclude
   unsupported tunnels/bridges from the drivable graph; do not flatten them into
   surface roads. Preserve the existing repaired Cathedral and University.
4. Place the supplied Alexander monument at surveyed square centre, calibrated
   to its real height; remove only the inherited terrain bump beneath its base.
5. Produce detailed and textureless distant cells. Stream both within bounded
   ranges; dispose retired geometry, materials and textures, handle stale loads,
   and keep the current cell covered during transitions. The bounded first
   expansion retains deterministic static collision independently of visual
   residency; measure its actual cost.
6. Stage a new release without activating it or deleting the accepted release.
   Check geometry/ground seams, roads, source preservation, all character assets,
   browser visuals, both graphics presets, real traversal out and back, repeated
   residency/memory, and the existing gameplay journey. Activate only after
   these checks, record exact content/source identity and remaining limits.

The removed 2017 mesh remains removed. Existing source imagery is licensed City
of Helsinki data; Google Street View, if needed for a facade repair, is visual
reference only under `docs/facade-cleanup-protocol.md`.
