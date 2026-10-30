---
name: build-helsinki-game
description: Build or improve an original GTA-like browser game set in Helsinki, including Helsinki geodata preparation, headless Blender assets and animation, GLB export, tiled Three.js worlds, driving and walking gameplay, and runtime verification. Use for implementation plans, playable slices, asset production, city import, optimization or debugging in this project. Do not use as a cinematic video generation workflow or claim a game is complete from Blender renders alone.
---

# Build Helsinki Game

Deliver the requested Helsinki game change with reproducible assets and evidence. This workflow is adapted for GPT-6 Astra (`gpt-6-astra`) in Codex. The caller selects the model and reasoning effort; this skill does not switch the running session or require another model. Blender authors offline assets where the project's pipeline uses it; the browser owns simulation, input and rendering.

## Astra working contract

- Follow the user's requested scope and accepted repository decisions ahead of this skill's defaults, within the host's instructions and security boundaries. A plan stays a plan; a read-only review stays read-only; an implementation request continues through the applicable verification and handoff.
- Infer routine, reversible choices from the repository and proceed. Ask only when missing information changes scope, authorization or an otherwise unresolved consequential choice. Existing authorization carries forward. If a skill instruction actually blocks work, link it, quote the requirement and explain the specific missing condition while completing independent authorized work.
- Start from the current implementation and evidence. Read [Project integration](references/project-integration.md) when entering this repository or resuming after a handoff. Treat templates, provisional budgets and historical audit results as guidance, not overrides or current measurements.
- Use available tools directly and batch independent reads. For substantial work with independent interfaces, delegate bounded exploration, implementation or review when collaboration is available and permitted. Give each writer distinct file ownership and tell them to preserve others' edits; integrate and verify their results. Keep small changes local and serialize Blender jobs and shared asset/release writes. Use the session's authorized model routing; an Opus worker is not a prerequisite.
- Choose verification from the changed behavior and the claimed outcome. Complete required project gates; do not repeat passing checks or expand into unrelated gates without a change, failure or concrete unresolved concern. See [Verification](references/verification.md).
- Keep updates and the final handoff concise: result, changed paths, evidence, remaining gaps. Continue the active task after status questions or context compaction, using the recorded candidate and next step. Do not infer success from elapsed time, a screenshot filename or a tool's exit code alone.

## Read by task

| Current work | Read |
| --- | --- |
| Existing repository, resumed work, native contracts and commands | [Project integration](references/project-integration.md) |
| Project setup, scope or next milestone | [Game workflow](references/game-workflow.md) |
| Helsinki coordinates, datasets, city tiles | [World pipeline](references/world-pipeline.md) |
| Web asset optimization, new-city delivery, texture tiers, streaming or release | [Web optimization](references/web-optimization.md) |
| Blender execution, release pin, source scenes, mesh census, export | [Blender workflow](references/blender-workflow.md) |
| Character rig, walk/run or vehicle entry | [Gameplay animation](references/gameplay-animation.md) |
| Tests, captures, budgets, handoff | [Verification](references/verification.md) |
| Origin of inherited helpers and known limits | [Source audit](references/source-audit.md) |

Read only the routes relevant to the task. Confirm tool/API versions locally; consult current official documentation when compatibility is uncertain. Historical machine observations in the supplied archives are leads, not current environment facts.

## Working defaults

Use these only where the current project has no accepted choice. In this repository, the implementation plan, decisions and native schemas take precedence; G0–G5 in the game workflow are starter dependencies, not replacements for its M0/M1/M2 milestones.

- New project: TypeScript, Vite, Three.js/WebGL2, Rapier at a fixed 60 Hz simulation step. Use an existing compatible stack when present. Pin installed versions. No runtime dependency on Blender, Python or a paid generation provider.
- Start around Senate Square with roughly 500 × 500 metres, then extend toward the planned central Helsinki area after measured streaming and performance gates. First playable loop: walk → enter car → drive → exit → complete a delivery → recover/restart.
- Single-player first. Traffic, pedestrians, police pursuit and more missions follow a functioning traversal loop. Multiplayer is a separately scoped extension.
- Hybrid city: geographic data for recognizable layout and distant massing; authored near-field roads, curbs, doors, props and landmark repairs. Aerial photogrammetry is not a ready-made drivable surface.
- City Blender coordinates: metres, X east, Y north, Z up after subtracting one recorded projected origin. glTF/runtime: X east, Y up, Z south. Asset-local forward may be +Z; it is not geographic north. Apply conversion exactly once.
- Keep visual meshes, collision geometry, pedestrian navigation and vehicle road graphs separate. Dynamic cars use simple convex/compound colliders, never their full visual mesh.
- Preserve sources, licenses, hashes and build inputs. Do not invent missing CRS, heights, lane topology, permissions or measurements.
- Blender scripts target one pinned release, write to `bpy.data`/`bmesh` rather than UI operators, keep one Blender unit = 1 m, name their boolean solver and end with measured census asserts before any render. API names remembered from training are release-specific leads; see [Blender workflow](references/blender-workflow.md).

## Execution loop

1. Inspect repository instructions, current state, actual files, existing tests and available tools. Resolve the active build and current asset revision. Bind uncommitted work to file/content hashes as well as any available Git revision; preserve unrelated edits.
2. Identify the acceptance conditions and affected interfaces for the requested change. For broad work, stage it into verifiable milestones and continue through the authorized scope; do not stop after the first small slice when more was requested.
3. Reuse contracts: world origin/CRS/height datum, asset axes and sockets, simulation step, tile format, target hardware, source ledger. Use [contract templates](assets/) only for missing contracts; nulls and placeholders are not release evidence.
4. When changing the coordinate or art pipeline, prove it on a small area and one representative asset. Subtract global coordinates before float32 import; validate an east/north/up marker and metre scale after actual GLB load. Reuse unchanged pipeline evidence only when its inputs and tool versions still match.
5. Implement gameplay against graybox collision. Produce Blender assets in a separate working copy, export and inspect, then integrate. Keep artistic and gameplay changes independently diagnosable. For web assets and geography appends, apply the native optimization and Standard/Low delivery path described in [Web optimization](references/web-optimization.md); verify the final game loads that optimized asset set.
6. Validate affected behavior with the project's native tools. For visual/gameplay/platform claims, open actual runtime captures, play through real controls and measure performance as applicable. Recheck affected evidence after final asset changes. Fixture teleports and renders are not proof of playable progression.
7. Save scripts, input versions, manifests, build ID and concise results. Report PASS, RETHINK or INCOMPLETE for the specific milestone and name any missing evidence.

## Helpers

Resolve `SKILL_ROOT` to this installed directory. Commands below are tool forms, not literal shell variables to invent from user data. See linked references for complete examples and prerequisites.

| Helper | Use and limits |
| --- | --- |
| `scripts/localize_obj.py` | Streaming float64 translation of confirmed projected ENU OBJ vertices before Blender. Does not reproject, tile, repair geometry or package MTL/textures. |
| `scripts/validate_world.py` | Verify the bundled template's tile schema, coordinate contract, payload paths, references, bytes and SHA-256. Not a validator for the repository's native release manifest; does not decode payloads or prove navigation/performance. |
| `scripts/run-blender.mjs` | Node 22+ launcher with timeout/logs, bounded container mode and Windows executable discovery. Reviewed bundled inspections may run on host; generated scripts default to isolation. |
| `scripts/blender_probe.py` | Small saved-scene/render probe. Its output must be visually opened before accepting the rendering path. |
| `scripts/blender/inspect_rig.py` | Inspect actual rigs, actions, controls and driver requirements before animation. Requires compatible slotted-action APIs. |
| `scripts/blender/animkit.py` | Optional Blender authoring library for actions, controls, poses and contacts. Not a runtime animation library. |
| `scripts/blender/motion_qa.py` | Reopen a saved scene and measure a declared motion spec. New `qa_spec.py` rejects empty/out-of-range checks. Gameplay blend/loop/contact checks still belong in-engine. |
| `scripts/blender/mesh_census.py` | Count non-manifold, flipped, loose, degenerate and self-overlapping geometry, shells, size and transforms in a .blend or GLB against a JSON spec, with a Blender release check. Proves topology and scale, not appearance, collision behaviour or glTF conformance. |
| `scripts/inspect-glb.mjs` | Bounded GLB structure and selected budget checks. Not a full glTF validator or runtime benchmark. |
| `scripts/capture-review.mjs` | Optional local Playwright capture for `__GAME_TEST__` v2 in `assets/game-test-api.d.ts`; output is CAPTURED_NOT_REVIEWED. This repository uses its own `__HELSINKI_GAME__` adapter and harnesses; do not replace them to fit this helper. |

## Completion rules

Do not overwrite user source scenes, enable embedded scripts, install tools, spend provider budget, switch models or publish because a helper suggests it. Follow existing session authorization and the environment's tool rules. Do not bypass an unavailable browser or execution capability through another channel.

A new skyline, isolated car model or cinematic shot is not a completed GTA-like game. A completed milestone must match its stated interaction, geography and platform claims. No Blender executable means Blender execution remains INCOMPLETE; perform the useful preparation and tests that are available, then name the exact remaining check.
