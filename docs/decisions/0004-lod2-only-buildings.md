# 0004 Buildings solely from the textured LoD2; no 2017 mesh in building or landmark visuals

Date: 2026-10-16. Status: accepted (user decision: "Use solely textured LoD2").

## Decision

Every building surface in the cells comes from the city's textured LoD2 model and nothing else. The 2017 photo-mesh
is no longer read by the cell builder:

| Was (decisions 0001, 0003) | Now |
| --- | --- |
| Cathedral, its terrace, grand stairs and corner pavilions cut out of the 2017 mesh; the three LoD2 Cathedral buildings (`103027179C`, `103027180D`, `103027181E`) dropped | The three LoD2 buildings, textured, register-matched with prism colliders. Terrace and stairs are ground on the terrain heightfield. |
| Alexander II statue cut out of the 2017 mesh, with a mesh collider | No statue (no LoD2 source). A hero model is `ART-002`. |
| Untextured LoD2 walls and roofs photo-baked from the 2017 mesh (`tools/world/lib/photobake.ts`) | Flat colours split by face slope, the plan's interim rule (section 4.3), see below. The photo-bake tool and its test are removed. |

`content/helsinki/landmarks.json` records the per-landmark sources; `build_cells.ts` no longer takes `--mesh-cells`.

## Untextured surfaces

Four LoD2 buildings have no facade texture at all (Aleksanterinkatu 14–18, Snellmaninkatu 8, one part of
Rauhankatu 17 and a 12-triangle outbuilding), and two textured ones have a stray untextured face. Their walls and
roofs (split at |normal Y| = 0.3) take one colour each: the area-weighted per-channel median over all textured LoD2
walls (160 450 m², RGB 99/106/101) and roofs (63 837 m², RGB 106/114/113) in the city model, sampled at 4 points
per m² from the raw masters with chart padding excluded (`content/helsinki/cells.json`, `untextured`). The colours
are 32 px tiles in the cell's facade atlas, so the facade grade and the baked-light material (decision 0003) treat
them like their neighbours and they cost no extra draw call. Undersides keep the city model's flat grey.

## What still uses the 2017 mesh

The terrain heightfield (lowest surface per 1 m, filtered; decision 0001) and the origin height. LoD2 has no ground,
and the city terrain layer is not mirrored (`DATA-002`). With the cut-outs gone, two mesh-derived terrain shapes
are now visible: the statue's stepped base is a low faceted mound in the middle of the square, and the terrace and
stairs are a plain ramp. Replacing the terrain is a separate decision.

## Results

Release `senate-20261016-9ef28d77` (cells `data/work/m0/cells-v4`, log `data/logs/build-cells-v4.log`); details in
`docs/benchmarks/lod2-only.md`. Register matching: 60 matched (was 57 plus 3 dropped), 3 unmatched. City cell draw
calls 123 → 115. Textures uploaded (standard) 151.1 → 129.8 MiB; transfer to first control 66.7 → 63.4 MB.
Collision changed (statue and terrace mesh colliders gone, Cathedral prisms added), so the M1 journey recordings
no longer replay to their hashes and the gate was rerun twice: 1 of 10 each time. Run 1 passed both times. Run 2
failed `fireAtPolice` both times because the harness fired into the player's own car, which stood between the
player and the patrol car. The gate therefore does not pass on this release; see the benchmark record.
