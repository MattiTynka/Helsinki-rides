# 0011 Finn player character and supplied movement

Date: 2026-10-17. Status: accepted and activated locally as `senate-20261017-15933497`.

The owner requested replacing the player with
`Snow_v4.2/Snow/finn12` and the animations used by the
adjacent `game` and `motion` projects. The baseline is the accepted facade release
`senate-20261017-cbd20b69`.

## Source and integration

The Finn12 scene is a modified Blender Studio Snow character, including a reshaped
face, short blond hair, blue eyes and revised skin textures. The supplied game's
`public/assets/finn.glb` is byte-identical to `motion/out/finn.glb` and records
Finn12 as its source. Its SHA-256 is
`2d4516c7efc691fd544b25b5ff66d39e19a0f23a5c3b029dd44785652a9adebd`.

Use that portable export as the integration input. The earlier Snow builder would
reset the Finn facial shape key and select the hidden original hair, so rerunning
it on Finn12 would lose the requested appearance. Preserve the supplied export's
71-joint deform skeleton, geometry, bind pose and eleven animation
tracks. Keep the stable `character-snow` player asset ID for existing manifests;
the displayed model is Finn. Rain officers keep their existing asset and contract.

One explicit source-weight repair is required: 89 lower-neck vertices that are
covered by the shirt in the bind pose inherit the adjacent shirt's barycentrically
interpolated skin weights. The supplied demo itself exhibits collar clipping from
different head/shirt weights. Pose-only adjustments did not clear it. This bounded
patch changes only JOINTS_0/WEIGHTS_0 in `FINN-head_game`; all positions, normals,
UVs, face geometry, other skin weights and original animation arrays remain exact.
The source hash, old/new tuples and garment donors are recorded in
`data/work/finn12-20261017/collar-v1/patch.json`. Independent verification compares
every other byte, and fresh native gait/aim views must validate the repair.

Two fully covered head triangles still intersected the differently triangulated
shirt between vertices. Remove only source head triangle ordinals 11 and 2946,
with index tuples `[1320,6,13]` and `[2896,1589,1582]`. The hidden-face patch proves
325 bind-pose samples per face are beneath the unchanged shirt, at least 9.64 mm
from its true open boundary. No position, normal, UV or visible neckline is edited.
`hidden-collar-v1/patch.json` pins both faces and exact retained index order.

The eleven native clips are idle, walk, jog, run, sprint, walk_back, jog_back,
strafe_left, strafe_right, jog_left and jog_right. Use their supplied calibrated
speeds and common left-strike phase. The simulation continues to own world
translation; source clips are in place. Directional movement and upper-body aim
layering are renderer concerns, with no simulation or input-policy change.

The supplied demo adds its weapon pose procedurally and contains no baked
aim/fire/hit/death/drive/arrested actions. Author these six existing gameplay states
on Finn's actual native rest skeleton. Do not replay old Snow skeleton tracks on
Finn or replace the supplied locomotion with the older procedural walk/run.

Convert oversized source WebP images to mipmapped KTX2: base colour at up to 1024
pixels, linear normal/roughness/metalness maps at up to 512 pixels. Preserve material
properties and use the correct colour-space and normal-map encoder settings.
Retain the supplied geometry and use a specific player budget for this model;
do not weaken Rain's shared skeleton or asset limits.

## Preservation and acceptance

All world cell visuals, collision, terrain, roads, gameplay, scenery, trees, cars,
Rain and the pistol must remain byte-identical to the baseline. The 2017 mesh stays
removed. Original Downloads files are read-only inputs; all new outputs go into
fresh project working/evidence directories.

The asset build must independently verify preserved native geometry, bind data,
rest hierarchy and eleven native animation payloads. Validate the final GLB and
variant contract, census its geometry, inspect actual runtime views of movement,
turning, aiming, reactions and vehicle transitions, and run native performance
presets and gameplay journeys with matching replays against the exact candidate.
Activate locally only after those checks, then rebuild and smoke-test the ordinary
default URL on the single port 5317 server.

Evidence and final status belong in `data/evidence/finn12-20261017/` and the
corresponding benchmark/handoff. Source input fingerprints are in
`data/raw/finn12-20261017/inputs.json`. Final acceptance includes 105 tests,
typecheck, strict source/world preservation, both graphics presets, ten native
journeys with matching replays, and ordinary-build default-URL visual smoke.
`completion.json` records the final local release and evidence hashes.
