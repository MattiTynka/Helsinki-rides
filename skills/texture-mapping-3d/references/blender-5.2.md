# Working with Blender 5.2 from an agent

How this skill drives Blender, and what to keep doing if you extend `scripts/tm3d.py`. Most of it
generalises the practice in the `build-helsinki-game` skill; the version facts were checked by
probes against Blender 5.2.1 LTS.

## Contents
1. Launch contract
2. Read before you write
3. Data API first, operators only where proven
4. Blender 5.x facts that bite scripts
5. Evaluated meshes, poses and modifiers
6. Images, colour and UDIM
7. Evidence: census, invariants, contact sheets
8. Extending tm3d.py

## 1. Launch contract

Always go through `scripts/run_blender.py`. It:

- Finds the binary in this order: `--blender`, then the `BLENDER_PATH` environment variable, then `BLENDER_PATH` in `./.env` (it reads only that key), then the standard install folder for the pinned release, then `PATH`. It runs `--version` and refuses any binary whose release does not match `--require` (default `5.2`).
- Starts Blender as `blender --background --factory-startup --disable-autoexec --python-exit-code 1 --python tm3d.py -- --require 5.2 <command> ...`:
  - `--factory-startup` ignores the user's startup file and add-ons.
  - `--disable-autoexec` stops scripts embedded in the .blend from running.
  - `--python-exit-code 1` turns a Python exception into a non-zero exit code instead of a "successful" run that printed a traceback.
- Removes environment variables whose names contain TOKEN, SECRET, PASSWORD or API_KEY before starting Blender.
- Writes the full log to `--log-dir` (default `./tm3d-logs`) and echoes only `[tm3d]` lines and errors. On failure it prints the last 15 log lines.

Exit codes:

| Code | Meaning |
|---|---|
| 0 | OK |
| 1 | Python error inside Blender |
| 2 | Launcher problem (no matching Blender, bad arguments) |
| 3 | `verify` found an invariant broken |
| 4 | `selftest` failed |
| 124 | Timeout |

Inside Blender, `tm3d.py` asserts `bpy.app.version[:2]` against `--require` again. A different minor release is a different API surface. Upgrading means rerunning `selftest` and reading the release notes, not editing the pin until it stops complaining.

## 2. Read before you write

- Open .blend files with `use_scripts=False`. Analysis commands (`inspect`, `calibrate`, `project`, `handoff`, `transfer`, `verify`) never save.
- `apply` is the only command that writes a .blend. It uses `save_as_mainfile(copy=True)` to a path that must not exist yet. The user's file is never overwritten, and a rerun cannot clobber an earlier result.
- Every run writes to a fresh directory (`fresh_dir` refuses a non-empty one). Keep runs side by side, for example `runs/cal1`, `runs/cal2`, and compare them.
- Missing texture files are common in files moved between machines (Rain's studio file stored paths nine folders up). `open_blend` repairs them in memory by basename, searching:
  - the .blend's folder, then `textures/` beside it, then its subfolders;
  - any `--texture-dir` you pass.

  The repairs are reported, never saved, unless `apply --repair-paths` is given. Tell the user about broken paths: that is their file's problem, and fixing it silently would hide it.

## 3. Data API first, operators only where proven

Use `foreach_get` and `foreach_set` with numpy for vertices, loops, UVs, normals and pixels. Use `evaluated_get(depsgraph).to_mesh()` for deformed geometry, and `mathutils.bvhtree.BVHTree.FromPolygons` for occlusion. A BVH `ray_cast` costs about 1.2 µs and `find_nearest` about 9 µs from Python.

Operators that work headless in 5.2 and that this skill uses:

- `wm.open_mainfile` and `wm.save_as_mainfile(copy=True)`
- `object.mode_set`, `mesh.select_all`, `mesh.remove_doubles`
- `uv.smart_project`
- `export_scene.gltf` and `import_scene.gltf` (`merge_vertices=True` on import)

Avoid operators that need a 3D viewport or window context (`paint.image_from_view`, most screen and view3d ops). If you need one, test it headless with a probe first.

This skill does not use the bake operator. In 5.x it bakes only into image nodes that are both selected and active, and it needs Cycles. Projection, transfer and compositing are done in numpy, which is deterministic and does not depend on render settings.

## 4. Blender 5.x facts that bite scripts

- `Material.use_nodes` is deprecated (new materials always get a node tree). Read `material.node_tree` and don't write `use_nodes`.
- The `Mix` node (`ShaderNodeMix`) has typed duplicate sockets (Factor float/vector; A/B as float, vector and RGBA). Only linked sockets matter. Follow the link actually present, and treat any scalar input (`socket.type == 'VALUE'`) as a factor. A ColorRamp `Fac`, a Mix `Factor` and a Math input all steer a colour; they are not one.
- Bake pass types are COMBINED, AO, SHADOW, POSITION, NORMAL, UV, ROUGHNESS, EMIT, ENVIRONMENT, DIFFUSE, GLOSSY and TRANSMISSION. There is no base-colour pass; route base colour through Emission and bake EMIT if you ever need the bake operator.
- The glTF exporter's `export_materials` enum is EXPORT, PLACEHOLDER, VIEWPORT or NONE. glTF has no UDIM, so the exporter splits tiles into separate images.
- The EEVEE engine id is `BLENDER_EEVEE` (5.0 renamed it from `BLENDER_EEVEE_NEXT`).

## 5. Evaluated meshes, poses and modifiers

- **Pose:** the texture must line up with the pose in the reference images. `--pose current` uses the file's current pose at `--frame`; `--pose rest` puts every armature in rest position. AI turnarounds are usually T- or A-pose, so a T-pose file (like `rain_tpose_studio.blend`) is the right input.
- **Two evaluations:**
  - Texel geometry (`md_frag`) is evaluated with Mask modifiers off, so skin hidden under clothes still gets a position and keeps its texels.
  - Visibility, silhouettes and previews (`md_vis`) use the modifiers as rendered, so masked-away skin neither occludes clothing nor pokes through in previews. Calibration evaluates without Subdivision Surface for speed; the outline barely changes.
- **Which meshes:** only meshes that render are used (object and collection render flags and view-layer exclusion are honoured). When any of them is rigged (Armature modifier or armature parent), only the rigged meshes count. Studio floors, backdrops and props stay out of silhouettes and occlusion. Override this with `--objects REGEX` / `--exclude REGEX`; `calibrate` stores the final list in `views.json`.
- **UV layer:** the layer a texture uses is the one its image node samples: the render-active layer unless a UV Map node names another. The edit-active layer is irrelevant. Mapping nodes and Box projection are reported as unsupported.

## 6. Images, colour and UDIM

- `image.pixels` returns stored values. Byte images are sRGB-encoded and float images linear. Blend in linear light and write sRGB PNGs.
- Socket colours (`default_value`) are already scene-linear. Don't linearise them twice.
- `image.pixels` reaches only the first UDIM tile. Read and write each tile as its own file (`name.1001.png`, `name.1002.png`, ...). To relink a tiled image, load the first tile file and set `source = 'TILED'`.
- Accessing `image.size` loads the file. It reports `[0, 0]` when the file is missing, which is how broken paths show up.
- Image node colour space: keep the original image's colour space when replacing it. New base-colour images are sRGB.

## 7. Evidence: census, invariants, contact sheets

The order is numbers first, then invariants, then pictures. Previews never come first.

1. `inspect` is the census:
   - character meshes and excluded meshes;
   - UV layers and their UDIM tiles;
   - modifiers and shape keys;
   - armatures;
   - base-colour targets with their role (primary, secondary, factor);
   - image path repairs.

   Read it before choosing a route.
2. `verify` fingerprints every render mesh before and after: geometry, UVs, vertex weights, shape keys, modifiers, material slots, parenting and world matrix, plus each armature's bones. Any difference is a failure (exit 3); report it rather than explaining it away.
3. Contact sheets come last:
   - `calibrate_<view>.png`: reference | rigid camera fit | after warp.
   - `verify_<view>.png`: reference seen through the warp | before | after.
   - `verify_orbit*.png` and `verify_posed*.png`.

   Open them with the Read tool and look. Numbers (IoU, MAE) rank candidates, but they do not prove that a face landed on the face.

## 8. Extending tm3d.py

- Keep pure-numpy algorithms in `tm3d_lib.py`. It has no `bpy` import, so `tests/test_lib.py` runs with any Python that has numpy (`python -m unittest discover -s tests`).
- Keep `bpy` glue in `tm3d.py`. After changing it, run `selftest`, which builds a scene, renders exact references, then runs calibrate, project, handoff, transfer, apply and verify, and checks numeric thresholds.
- Scratch probes belong in a scratch folder, run with the same launcher flags.
