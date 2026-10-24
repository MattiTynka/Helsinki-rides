# Headless Blender to browser assets

## Inspect the actual environment

Run Node/Python version checks and resolve Blender through explicit `--blender`, `BLENDER_PATH`, project `.env`'s BLENDER_PATH, standard Windows/macOS locations, then PATH. Do not print the whole `.env`. Earlier success on another machine does not prove this environment has Blender or a working container; probe again. Python 3.10+ suffices for the offline helpers. Blender scripts use Blender's Python, not `pip install bpy`.

Use the existing live Blender/MCP connection only if the task needs the user's open scene and that connection is healthy. Do not restart a user session to make automation work. Headless conversion is the repeatable default for game assets. Do not claim a rendered frame is a GUI screenshot. Both the official Blender Lab MCP add-on (Blender 5.1+) and the community `blender-mcp` server run model-written Python inside Blender without guards over plain localhost TCP (port 9876) with no authentication, and the official page reportedly recommends a VM (secondary sources, 2026-10-16; not read from blender.org). Keep an MCP session a dev-box convenience for the user's open scene, never expose the port, and keep the headless runner as the repeatable path.

Confirm the executable and its release first:

```bash
BLENDER_EXECUTABLE --background --factory-startup --version
```

Substitute absolute paths; quote paths with spaces. On PowerShell use a single line or its own continuation syntax, not Bash backslashes. Before accepting rendering, render one small saved scene to a new directory, open the PNG and record the version and engine used. Failure of EEVEE does not prove Blender cannot perform non-rendering geometry conversion; diagnose capabilities separately.

## Pin one release and make the run prove it

Model-written Blender Python targets whichever release dominated its training data, the API has moved at every release since 4.0, and a render hides the difference. A public benchmark of headless scripting tasks (30 tasks, four builds, ten models, one assert per task) saw scripts that ran fall from 91% on 3.6 to 70% on 5.0, scripts that also named what had changed fall from 81% to 35%, and compositor, boolean-solver and sequencer tasks score zero on 5.0. Record the target release as `MAJOR.MINOR` with the asset revision, set `BLENDER_PATH` in the project `.env` so discovery cannot drift to another installed build, and have every script assert `bpy.app.version[:2]` against that target before doing work (the census helper takes `require_version`). State the release in any prompt that generates a script and ask for the list of APIs it used that changed since 4.0. Always pass `--python-exit-code 1`: without it a traceback leaves Blender's exit status at zero, and arguments execute in order (a `.blend` loaded after `-o` replaces that output path; everything after `--` reaches `sys.argv`).

| Release | Changed | Use instead |
| --- | --- | --- |
| 4.0 | Context-override dicts, `Mesh.calc_normals`, Python OBJ/PLY IO removed | `bpy.context.temp_override(...)`, `wm.obj_import`/`wm.obj_export` |
| 4.1 | Auto-smooth and `calc_normals_split` removed; STL moved to `wm.stl_export` | `mesh.set_sharp_from_angle(...)` |
| 4.2–4.5 | EEVEE identifier `BLENDER_EEVEE_NEXT`; `blend_method` → `surface_render_method`; `MANIFOLD` boolean solver added (4.5) | Probe enums; never hardcode the engine id |
| 5.0 | EEVEE identifier back to `BLENDER_EEVEE`; boolean `FAST` → `FLOAT`; legacy action API (`action.fcurves`, `action.groups`, `action.id_root`) and BGL removed; `scene.node_tree` → `compositing_node_group` | Slotted actions and channelbags; `gpu` module |
| 5.1 | Bundled Python 3.11 → 3.13 | Wheels and extensions must match that exact Python |
| 5.2 | `gpu.init()` added for GPU work under `--background`; Geometry Nodes modifier inputs moved to `modifier.properties.inputs` | |

Provenance, checked 2026-10-16: the 5.0 and 5.2 rows were read in the official release notes; `BLENDER_EEVEE` as the only EEVEE id, Python 3.13, `gpu.init()` and the `EXACT` boolean default were verified on the installed 5.2.1 LTS; blender.org listed 5.2.2 LTS as current. The 4.0–4.5 rows, the 5.1 Python switch and `FAST` → `FLOAT` come from the benchmark write-up and were not rechecked. Rows are leads about a release, not facts about the installed build; probe before relying on them.

## Isolation and resources

Reviewed scripts may run on the host with `--factory-startup --disable-autoexec` and an environment stripped of tokens, keys and connection strings. Open untrusted .blend inputs, and run newly generated production scripts, in an isolated container or VM: no network, read-only root, narrowly mounted input folders, explicit writable output folders, CPU/memory/process caps. `--disable-autoexec` alone is not a Python sandbox. Never enable scripts embedded in downloaded assets by habit.

A container image should install an official Blender Linux x64 archive pinned by a version and SHA-256 verified on blender.org. Do not copy version assertions or checksum strings from old notes as current facts. Do not weaken CPU/memory/pids limits to get past a failed check, and treat Windows mounts, UID write permissions and software EEVEE as unverified until a probe in that container succeeds. Avoid all-city runs; start with one tile, 2 threads, bounded memory and low-resolution diagnostics. Check free disk/RAM before scaling.

Run generated scripts on the host only when the session already authorizes that; never run code from untrusted assets there. Preparation, contract work and offline tests can proceed without Blender.

## Source scene structure

Keep immutable original input and a new working .blend. Named collections make selection deliberate: `VISUAL`, `COLLISION`, `SOCKETS`, `EXPORT_RIG`, `AUTHORING`, `QA_MARKERS`. Never export the whole working scene implicitly. Do not apply armature transforms destructively after animation; establish rest scale first and use a dedicated export rig when needed.

For city geometry, localize before import and retain ENU numeric axes. For prop/character assets, declare local up/forward and pivot separately. A car needs chassis pivot/centre-of-mass metadata, correctly centred wheel pivots, seat anchors, entry/exit and camera sockets. Socket orientation matters as much as position. Object scale should be intentional, usually unit scale, with no unexplained negative/mirrored transforms.

For static city meshes: repair playable surfaces → simplify with border constraints → UV/material bake → generate and visually compare LODs → export. Decimation ratio alone is not quality assurance. Preserve landmark silhouette, rooflines and connected roads. Keep large static decorative meshes out of dynamic physics. Instanced props should share mesh/material data and be partitioned for useful culling.

## Scripts write to data, not buttons

Operators are the UI. In a `--background` run an operator that needs a window, area, region or selection fails its poll with `RuntimeError: ... context is incorrect` and no reason, and even a successful operator returns only `{'FINISHED'}`, never data. Generated geometry scripts build and edit with `bpy.data` and `bmesh`, and read modifier results through `obj.evaluated_get(depsgraph).to_mesh()` instead of `bpy.ops.object.modifier_apply`. Operators proven headless on 5.2.1 may stay: primitive add, `mode_set`, `join`, `parent_set(type="ARMATURE_AUTO")`, `object.bake`, `wm.obj_import`, `export_scene.gltf`, and on 5.2.1 `mesh.select_all`/`mesh.remove_doubles` with an active object; wrap area-dependent operators in `bpy.context.temp_override(...)` and set the active object and selection explicitly first. Name the boolean solver: `EXACT` survives overlapping and coplanar input, `MANIFOLD` works only on manifold meshes, `FLOAT` has no support for overlapping geometry. On 5.2.1 the modifier and `mesh.intersect_boolean` default to `EXACT`; state it anyway.

## Units and scale

One Blender unit is one metre; three facts make a 100× error silent. `primitive_cube_add` defaults to a 2-unit edge and `size=` is the full edge. `unit_settings.scale_length` changes display only; geometry and the glTF exporter ignore it. OBJ and STL carry no units, so pass `global_scale`, `forward_axis` and `up_axis` explicitly on import and export. The glTF exporter has no scale or unit option (verified on 5.2.1: `export_yup` is its only axis option), so Blender units leave 1:1 as metres into Three.js and Rapier. Declare conversion constants such as `MM = 0.001` once at the top of a script and keep every dimension, clearance and socket offset a named module-level parameter, so a review patch changes constants and never structure.

## Census before pictures

Non-manifold edges, flipped faces, loose or wire geometry, zero-area faces, self-intersections, hidden inner shells and wrong scale all render perfectly. Measure them before opening any image:

```bash
BLENDER_EXECUTABLE --background --factory-startup --disable-autoexec --python-exit-code 1 --python SKILL_ROOT/scripts/blender/mesh_census.py -- --blend WORK/car.blend --spec WORK/car-census.json --output WORK/car-census-report.json --fail-on-threshold
```

`--glb` imports a file with the bundled glTF importer, measures only the imported meshes and first welds co-located vertices in the measured copy (`weld_distance`, default 1e-6 m for GLB input, 0 for `.blend`): glTF stores a separate vertex per normal or UV discontinuity and the importer's own merge cannot join vertices with different normals, so unwelded a flat-shaded box reads as six open shells (a box-built prop measured 54 open shells raw, 9 closed shells welded). The spec declares `require_version`, per-count `limits`, `dimensions` with a tolerance, `unit_scale` and `applied_transforms`; a limit on a count that was not measured fails. Choose limits per representation: collision and convex-hull sources need zero loose, wire or degenerate geometry, zero flipped edges and a declared shell count; open visual sheets (terrain, foliage cards, photogrammetry) legitimately have boundary edges, so limit `nonmanifold_interior_edges` rather than `nonmanifold_edges`. Self-overlap is a BVH pair test bounded by `max_faces`; on 5.2.1 a clean 32×16 sphere reports 0 pairs and two interpenetrating cubes 12. Parts that interpenetrate or touch without sharing vertices count (a graybox car body of two joined boxes reports 8 pairs; its single-box collider 0), so composite props need a per-part census or an accepted pair count rather than a blanket zero. Meshes from generative 3D services are often non-manifold by design: census them harder, then repair with `bmesh.ops` (`remove_doubles`, `recalc_face_normals`, `holes_fill`, `dissolve_degenerate`), fix scale and orientation, then boolean, then remesh only if topology is needed. The census proves topology, transforms and size, not appearance, collision behaviour, materials or glTF conformance.

## Export contract

Read the installed Blender glTF exporter options or version-matched [official exporter manual](https://docs.blender.org/manual/en/latest/addons/import_export/scene_gltf2.html). Use a small export/import probe instead of assuming keyword arguments. Newer action APIs and glTF options can differ from older scripts. [ActionSlot](https://docs.blender.org/api/current/bpy.types.ActionSlot.html), [ActionChannelbag](https://docs.blender.org/api/current/bpy.types.ActionChannelbag.html) and [anim_utils](https://docs.blender.org/api/current/bpy_extras.anim_utils.html) describe current action concepts; installed capability checks still decide compatibility.

- GLB for initial runtime assets; perform the city Z-up→Y-up mapping once. Bake evaluated constraints into exportable node/bone transforms or supported morph animation; do not ship a requirement for Python drivers.
- Do not assume Blender dual-quaternion deformation, Bendy Bones, constraints, procedural shaders, Geometry Nodes or arbitrary driver expressions execute in Three.js. Bake/convert and verify the actual exported result. Export only required deformation bones and attachments; dropping control bones must preserve the evaluated motion.
- Use a restricted material palette with baked base color/normal/roughness as required. Check color-space flags, tone mapping, normals/tangents, alpha mode and shadow behavior in-engine. A Blender beauty render is not the reference for matching pixels across different lighting pipelines.
- First verify an uncompressed GLB. Then evaluate Meshopt and KTX2 with supported browser loaders and compare error, decoding time and texture residency. Compression is not a substitute for geometry/material reduction. Record exact tools/versions and options.
- Use full glTF validation in the project, and check each export against per-asset budgets (bytes, scene triangles, materials, joints). Adopt measured project limits rather than universal numbers.

 Finish by loading the export in the real runtime and checking scale, heading, materials, sockets, collision alignment and animations.

## Look second: contact sheet and patch loop

Render for the contact sheet, not for the verdict. On 5.2+ `gpu.init()` enables offscreen GPU drawing under `--background` (verified on 5.2.1 with an OpenGL backend); six named orthographic views (front, back, left, right, top, three-quarter) tiled into one image cost far less than a full render and are enough to judge proportion against stated dimensions, feature placement, floating or fused parts and anything the spec did not ask for. Cycles draws nothing offscreen; use EEVEE or Workbench. Keep the existing probe and review renders for lighting and material checks.

Iterate as spec → generate → execute with the exit code wired → census → six views → patch → export. A critique of the sheet judges only what the census cannot; a patch changes constants in the parameter block and returns a diff, never a restructure; a failed assert goes back to the parameter and a rejected export goes back to generation with the report in context. The same benchmark found temperature 0 not deterministic across identical runs, so treat small pass-rate differences as noise and keep the per-task assert as the arbiter.

## Vegetation adaptation

Build representative birch/spruce assets with shared atlases, attached branches and four-sided review. Check reverse-side normals, alpha mip fringes and silhouette at actual LOD distances before adding more polygons. Wind must use consistent visible/shadow deformation and padded instance bounds. Ground placement must exclude roads, water and building interiors. Keep shader changes scoped to vegetation and verify them against the installed Three.js source rather than copying a global normal-flip patch.
