---
name: build-helsinki-game
description: Build or improve an original GTA-like browser game set in Helsinki, including Helsinki geodata preparation, headless Blender assets and animation, GLB export, tiled Three.js worlds, driving and walking gameplay, and runtime verification. Use for implementation plans, playable slices, asset production, city import, optimization or debugging in this project. Do not use as a cinematic video generation workflow or claim a game is complete from Blender renders alone.
---

# Build Helsinki Game

Deliver a bounded, playable milestone with reproducible assets and evidence. Blender is the offline authoring and conversion tool; the browser owns simulation, input and rendering. Preserve the existing repository and user decisions. This skill is a workflow plus tested helpers, not a prebuilt city importer or game engine.

## Read by task

| Current work | Read |
| --- | --- |
| Project setup, scope or next milestone | [Game workflow](references/game-workflow.md) |
| Helsinki coordinates, datasets, city tiles | [World pipeline](references/world-pipeline.md) |
| Blender execution, release pin, source scenes, mesh census, export | [Blender workflow](references/blender-workflow.md) |
| Character rig, walk/run or vehicle entry | [Gameplay animation](references/gameplay-animation.md) |
| Tests, captures, budgets, handoff | [Verification](references/verification.md) |
| Provenance, verified Blender facts and known limits | [Source audit](references/source-audit.md) |

Read only the routes relevant to the task. Confirm tool/API versions locally; consult current official documentation when compatibility is uncertain.

## Working defaults

- New project: TypeScript, Vite, Three.js/WebGL2, Rapier at a fixed 60 Hz simulation step. Use an existing compatible stack when present. Pin installed versions. No runtime dependency on Blender, Python or a paid generation provider.
- Start around Senate Square with roughly 500 × 500 metres, then extend toward the planned central Helsinki area after measured streaming and performance gates. First playable loop: walk → enter car → drive → exit → complete a delivery → recover/restart.
- Single-player first. Traffic, pedestrians, police pursuit and more missions follow a functioning traversal loop. Multiplayer is a separately scoped extension.
- Hybrid city: geographic data for recognizable layout and distant massing; authored near-field roads, curbs, doors, props and landmark repairs. Aerial photogrammetry is not a ready-made drivable surface.
- City Blender coordinates: metres, X east, Y north, Z up after subtracting one recorded projected origin. glTF/runtime: X east, Y up, Z south. Asset-local forward may be +Z; it is not geographic north. Apply conversion exactly once.
- Keep visual meshes, collision geometry, pedestrian navigation and vehicle road graphs separate. Dynamic cars use simple convex/compound colliders, never their full visual mesh.
- Preserve sources, licenses, hashes and build inputs. Do not invent missing CRS, heights, lane topology, permissions or measurements.
- Blender scripts target one pinned release, write to `bpy.data`/`bmesh` rather than UI operators, keep one Blender unit = 1 m, name their boolean solver and end with measured census asserts before any render. API names remembered from training are release-specific leads; see [Blender workflow](references/blender-workflow.md).

## Execution loop

1. Inspect repository instructions, current state, actual files, existing tests and available tools. Resolve the active build and current asset revision. For planning, state assumptions; do not create a game when only a plan was requested.
2. Pick the smallest milestone that advances the requested outcome. Write its acceptance conditions and affected interfaces before expanding content. Ask only for information that changes a consequential choice and cannot be inferred.
3. Pin contracts: world origin/CRS/height datum, asset axes and sockets, simulation step, tile format, target hardware, source ledger. Use [contract templates](assets/) as drafts; nulls and placeholders are not release evidence.
4. Prove the coordinate and art pipeline on a small area and one representative asset. Subtract global coordinates before float32 import; validate an east/north/up marker and metre scale after actual GLB load.
5. Implement gameplay against graybox collision. Produce Blender assets in a separate working copy, export and inspect, then integrate. Keep artistic and gameplay changes independently diagnosable.
6. Validate affected behavior, open actual runtime captures, play through real controls, and measure performance on the claimed platform. Recheck after final asset changes. Fixture teleports and renders are not proof of playable progression.
7. Save scripts, input versions, manifests, build ID and concise results. Report PASS, RETHINK or INCOMPLETE for the specific milestone and name any missing evidence.

## Helpers

Resolve `SKILL_ROOT` to this installed directory. Commands below are tool forms, not literal shell variables to invent from user data. See linked references for complete examples and prerequisites. Blender entry points run directly: `blender --background --factory-startup --disable-autoexec --python-exit-code 1 --python SCRIPT -- ARGS`. For rig inspection, retargeting and locomotion clips use the `motion-design` skill.

| Helper | Use and limits |
| --- | --- |
| `scripts/localize_obj.py` | Streaming float64 translation of confirmed projected ENU OBJ vertices before Blender. Does not reproject, tile, repair geometry or package MTL/textures. |
| `scripts/validate_world.py` | Verify tile grid, coordinate contract, separate payload paths, source references, actual byte sizes and SHA-256. Does not decode payloads or prove navigation/performance. |
| `scripts/blender/mesh_census.py` | Count non-manifold, flipped, loose, degenerate and self-overlapping geometry, shells, size and transforms in a .blend or GLB against a JSON spec, with a Blender release check. Proves topology and scale, not appearance, collision behaviour or glTF conformance. |

## Completion rules

Do not overwrite user source scenes, enable embedded scripts, install tools, spend provider budget, switch models or publish because a helper suggests it. Follow existing session authorization and the environment's tool rules. Do not bypass an unavailable browser or execution capability through another channel.

A new skyline, isolated car model or cinematic shot is not a completed GTA-like game. A completed milestone must match its stated interaction, geography and platform claims. No Blender executable means Blender execution remains INCOMPLETE; perform the useful preparation and tests that are available, then name the exact remaining check.
