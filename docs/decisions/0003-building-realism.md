# 0003 Building realism pass: baked-light facades, matched sun, photo bake, facade grade

Date: 2026-10-16. Status: accepted (recorded by the implementing agent on the user's request to make the buildings
more realistic, checked against Google Street View). The photo bake below is superseded by decision 0004 (buildings
solely from the textured LoD2); the lighting, sun and grade stand.

## What was wrong

Compared with Street View around Senate Square (warm ochre and cream plaster, white trim, dark sheet-metal roofs),
the pilot's buildings read grey-blue and dim, and one block was a flat grey box. Four causes, each measured:

1. **Lighting counted the light twice.** The LoD2 facades are aerial photos and already carry the flight's sun and
   shade. Lit by the M0 sun (2.4) and sky (1.3) with no tone mapping, a wall facing away from the sun received only
   the hemisphere term, about 0.16 to 0.21 of its texture colour in linear light. With `?lighting=unlit` the same
   walls showed their real colours.
2. **The sun came from the wrong side.** Mean facade luminance by wall azimuth over all 124 masters (area-weighted,
   chart padding excluded) is 0.298 for east-facing walls, 0.290 south, 0.239 north and 0.204 west. A fit of
   `a + b·max(0, cos(azimuth − sun))` puts the flight's sun at **127°** (south-east, morning; r² 0.78). The M0 sun
   stood at 233° (south-west), so it lit exactly the walls the photos show in shade.
3. **Haze.** The masters' darkest 0.5 % sits at R 29, G 38, B 44 (91.5 Mpx), a bluish veil from the oblique
   flight that lifts shadows and greys the plaster. The median saturation is 10 %.
4. **Untextured buildings.** Three LoD2 buildings have no facade texture at all: Aleksanterinkatu 14–18 (the City
   Museum block with the Sederholm house, 5 826 m² of walls, on the square's south-east corner), the 1888 part of
   Rauhankatu 17 (National Archives) and Snellmaninkatu 8. They rendered in the city model's flat grey (0.612).

## Decisions

| Change | Where | Detail |
| --- | --- | --- |
| Baked-light facades | `apps/game/src/render/scene.ts` | Materials with the glTF extra `bakedLighting: true` (every facade atlas; the cell builder sets it) take 0.72 of the texture colour as emissive and keep 0.45 as diffuse under the sun and sky. A shaded wall now shows about 0.8 of its photo colour and a sunlit one about 1.05, so faces still turn with the light. Characters, cars and the generated ground keep the M0 lighting. |
| Sun matched to the photos | same | Azimuth 127°, elevation 38° (a summer morning at 60.17° N for that azimuth; elevation is not measurable from the facades). Intensities unchanged. This closes the open point in 0002 ("the sun direction is matched to them rather than free"). |
| Facade grade | `tools/world/lib/grade.ts`, `content/helsinki/cells.json` `facadeGrade` | One global veil, 0.8 × the 0.5th percentile per channel ([23, 30, 35]), subtracted and stretched back, saturation × 1.15 around Rec. 601 luma, then an unsharp mask (σ 0.6 px) after resampling to the texel cap. Applied to every facade and landmark photo atlas. Global, not per texture, so neighbouring buildings from different masters stay consistent. |
| Photo bake | `tools/world/lib/photobake.ts`, `cells.json` `photoBake` | Untextured LoD2 walls and roofs are split into connected planar charts and baked at 10 texels/m from the 2017 mesh: one orthographic ray per texel along the chart normal, the front-facing mesh surface nearest the LoD2 plane within 2.5 m wins (so trees and eaves in front of a wall lose to the wall), texels without a hit are filled from the nearest baked texel. Undersides stay flat. The charts go into the cell's facade atlas, so they cost no extra material; chart PNGs are kept as evidence in the build's `photo-bake/` folder. |

Plan section 4.3 asks for exactly this photo bake, from the **2024** mesh. Only the 2017 mesh is on disk
(decision 0001), so the bake uses 2017; when the 2024 layer is mirrored the same tool re-bakes from it.

What was considered and not done:

- **Raising the facade texel cap** to 1024 px for the square (the plan's mitigation for soft facades) would cost
  about 1 MiB of texture memory and 0.75 MB of transfer per master. The low preset has 8.9 MiB of texture headroom
  left, and transfer to first control already misses its budget (backlog item 17), so the cap stays at 512.
- **Modelled cornices and window reveals.** The plan's art direction is flat LoD2 walls with painted windows; this
  pass keeps it.
- **Procedural facades for the untextured buildings.** Street View gave their colours, but the 2017 mesh has the
  real facades (the City Museum's "MUSEO" window letters, the Sederholm house, the Archives' columns), which the
  plan prefers.

## Street View

Google Street View was used only as a visual reference, by eye: to see what the square looks like, to find which
buildings were wrong, and to judge the result. No imagery, colour samples or geometry from Google is in any
build input or in the release; rule 18.3 is untouched.

## Results

Release `senate-20261016-a847cd26` (cells build `data/work/m0/cells-v3`, log `data/logs/build-cells-v3.log`),
measured with the production review build like the M1 baseline (`docs/benchmarks/building-realism.md`):

- Fixed-camera captures before and after: `data/evidence/browser-realism-standard/before-after.jpg`.
- Photo bake: 221 charts, 2.38 Mtexels. Mesh coverage: Aleksanterinkatu 14–18 74 %, Rauhankatu 17 72 %,
  Snellmaninkatu 8 13 % (it lies mostly north of the mesh cells and of the play area's edge at z −290).
- Draw calls 122 → 123 for all cells (one more atlas page in `c_p00_p00`), at most 12 per cell; triangles
  unchanged except 2 degenerate ones dropped.
- Textures uploaded 148.1 → 151.1 MiB (limit 160 on low). Cell GLBs 53.5 → 57.6 MB; release 62.3 → 66.4 MB.
  The twelve cells without baked buildings grew 1.4 MB in all (the grade and sharpening; UASTC compresses less);
  the three that hold them (`c_p00_p00`, `c_p00_m02`, `c_p00_m03`) grew 2.7 MB, about 2.2 MB of it the bake.
- Simulation inputs identical: terrain, roads, gameplay, hero assets and all 15 collision bundles have the same
  hashes as `senate-20261016-d9a3be1f`. Two journey-gate recordings from `journey-m1-try4`, with only their
  release id rewritten, replay to the recorded hashes (1178cbf3, 0cb8c097). The M1 gate result therefore carries
  over; it was not rerun.
