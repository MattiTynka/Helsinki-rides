# 0008 Posture, stairs and ground joins

Date: 2026-10-17. Scope: repair the owner's reported shoulder/torso pose, Cathedral west-side holes and buried
legs, and irregular University stairs. The rejected motion release is retained for diagnosis, not used as an
accepted visual reference. Active local release: `senate-20261017-4090689c`.

## Causes and repair

The first retarget copied absolute source collar directions and excessive torso pitch. Snow's source and
target proportions differ: the resulting shoulders sat behind a forward-pitched chest. The corrected retarget
samples the original target actions first, retains their pelvis/torso/clavicle balance and mean arm carriage,
and adds bounded mean-relative source motion. Leg IK, shoe fitting and phase-aligned runtime blending remain.
All three exported gaits now use periodic cubic tangents. Original scenes, meshes, skin, rest skeleton,
materials and the seven other actions are preserved. See decision 0007 and the asset pipeline for reproduction.

The ground defects were real: old stair treads were visual geometry over a different coarse collision surface.
Width-varying raw terrain also produced uncapped stair cheeks. Wall cuts and wall/ground sampling did not share
edge coordinates. A negative-control check against `senate-20261016-05811e68` reproduces metre-scale support
disagreements; the initial character-only release had identical city payloads. This does not excuse the defects
or the insufficient earlier visual review.

`buildDistrictGround` is the common assembly for both full builds and ground-only repair. Register stair
outlines determine straight flights; each tread, riser and side face has matching collision. Ground is clipped
against the same stair boundaries and joined to them; wall caps, cut ends and their actual neighboring ground
are closed. The separate low-resolution safety heightfield is lowered beneath these authored surfaces while
the original terrain remains the height source. The publisher verifies and carries the matching safety field.

Position quantization opened additional cracks between materials and independently exported cells. Authored
ground now retains its exact Float32 positions through meshopt compression; normals and eligible UVs still
quantize. Both build routes select this mode. A real compressed-GLB regression test covers separate materials
and separate cells. Independent checks of the final cells find zero displacement in 1,064 shared boundary pairs
and close every previously missed University boundary ray.

## Preserve unrelated work

`rebuild_ground.ts` replaces only ground nodes and ground/kerb colliders in frozen cells-v14. It proves equality
of decoded building geometry, transforms, normals, UVs, indices, materials and image bytes before and after
serialization, plus exact non-ground collider arrays. Scenery placements and the previously published tree
asset are copied unchanged. Cars, pistol, roads and gameplay are unchanged. Neither the unfinished facade
erase nor newer tree models are rebuilt. The removed 2017 mesh is not restored.

Final inputs are `data/work/repairs-20261017/cells-v3` and
`data/work/repairs-20261017/release-assets/characters`, plus the frozen baseline roads/gameplay/cars and
`data/work/locomotion-20261017/release-assets/scenery`. The source scenes and all earlier diagnostic releases
remain available. Nothing is committed; the owner commits.

## Local server

The former two addresses were a source dev server on 5317 and a compiled preview on 4317. Both could serve
different code/content. The obsolete preview was stopped. Dev and preview now both require port 5317 with
`--strictPort`, so they cannot silently run side by side. Stop one before starting the other. The normal URL
is `http://127.0.0.1:5317/`; a `release` query intentionally pins an older candidate.

## Acceptance

Use decoded exported surfaces versus actual Rapier support, real keyboard stair ascents/descents, opened
runtime captures, character preservation/motion/census checks, native browser budgets and the repeated journey.
Evidence and limits are recorded in [the repair verification record](../benchmarks/posture-and-ground-repair.md).
Flat-floor shoe QA does not establish terrain-aware foot IK; the repair addresses incorrect world support and
the rejected upper-body posture. Broad city art improvements and original transfer-budget debt remain separate.
