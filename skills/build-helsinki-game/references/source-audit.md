# Provenance, verified facts and limits

## Provenance

The helpers in this skill (`localize_obj.py`, `validate_world.py`, `blender/census_spec.py`, `blender/mesh_census.py`, `test_pipeline.py`) and the templates in `assets/` were written for it and are released under the skill's MIT licence. The Helsinki implementation plan supplies project scope and the provisional budgets in [verification](verification.md). Public geodata, rig, texture and animation rights must be checked per actual asset; the licence of a script says nothing about the data it processes.

## Design decisions

1. **Coordinate precision:** `localize_obj.py` streams an OBJ in float64 and subtracts a confirmed projected origin before Blender/float32 import, recording hashes and bounds. It does not reproject. ENU→runtime mapping and asset-forward conventions are kept distinct ([world pipeline](world-pipeline.md)).
2. **Four city representations:** visual, collision, pedestrian-nav and vehicle-road data have independent outputs and acceptance checks. `validate_world.py` checks staged manifest structure, grid and file integrity; it intentionally does not claim to decode those formats.
3. **Gameplay animation:** in-place foot motion is checked against a simulated root trajectory; loop seams, blending, controller ownership, entry/exit and glTF round-trip acceptance are explicit. Python drivers, DQ skinning and Bendy Bones are not assumed to survive export ([gameplay animation](gameplay-animation.md)).
4. **Mesh census:** `census_spec.py` (pure-Python spec validation and judging) and `mesh_census.py` (Blender entry point) measure topology, transforms and size before any picture is judged ([Blender workflow](blender-workflow.md)).
5. **Excluded on purpose:** paid video/lip-sync providers, public tunnels and movie delivery do not produce interactive game assets, and the skill does not impose model, routing or cost preferences.

## Blender facts verified 2026-10-16

Prompted by a public write-up on model-written Blender scripts: a benchmark of 30 headless scripting tasks over four Blender builds and ten models saw scripts that ran fall from 91% on 3.6 to 70% on 5.0 and scripts that also named what had changed fall from 81% to 35%; compositor, boolean-solver and sequencer tasks scored zero on 5.0; temperature 0 was not deterministic. Its claims were checked before anything was adopted:

- Verified on Blender 5.2.1 LTS (2026-08-25 build, bundled Python 3.13.13): `BLENDER_EEVEE` is the only EEVEE identifier; `gpu.init()` exists and a `GPUOffScreen` can be created under `--background` (OpenGL backend); the glTF exporter exposes no scale or unit option (`export_yup` only); OBJ import exposes `global_scale`, `forward_axis` and `up_axis`; the boolean modifier and `mesh.intersect_boolean` default to `EXACT`; `obj.evaluated_get(depsgraph).to_mesh()` returns modifier results (Solidify: 6 to 12 faces) without `modifier_apply`; `mesh.select_all` and `mesh.remove_doubles` still run headless with an active object, so the write-up's claim that every mesh operator fails in background is too strong; `--python-exit-code` and `--` behave as `blender --help` states.
- Verified in official release notes: 5.0 renamed `BLENDER_EEVEE_NEXT` to `BLENDER_EEVEE` and removed the legacy action API and BGL; 5.2 added `gpu.init()` and moved Geometry Nodes modifier inputs. blender.org listed 5.2.2 LTS as current.
- Taken from the write-up without rechecking: the 4.0–4.5 change rows, the 5.1 Python switch, `FAST` to `FLOAT`, and the MCP-server security notes (secondary sources only).
- Not adopted: 3D-printing wall, overhang and clearance figures, the 3D-Print Toolbox extension, provider pricing and model choice; none apply to a browser game.

## Evidence

- Census semantics on 5.2.1: a clean cube and a 32×16 UV sphere report zero everywhere; one flipped face reports 4 flipped edges; two interpenetrating cubes report 12 overlap pairs; an open 2×2 grid with a stray vertex and a zero-area triangle reports 11 non-manifold (boundary) edges, 1 loose vertex and 1 degenerate face.
- Live census runs (2 threads, at most 0.19 GiB peak RSS, 3–5 s each): a graybox car `.blend` measured 10 meshes with 72 checks; its body reports 2 shells and 8 self-overlap pairs (two joined boxes), every other part including the collider one closed shell and 0 pairs; `--fail-on-threshold` returned exit code 3. A box-built prop GLB imports as 216 split vertices and 54 open shells because the importer stores a vertex per flat-shaded face and its own merge cannot join differing normals; welding at 1e-6 m in the measured copy (now the GLB default) gives 72 vertices, 9 closed shells, 0 boundary edges and 176 overlap pairs across 57 faces.
- A fresh-context agent followed this skill against a synthetic EPSG:3879/N2000 OBJ and metadata, without being given expected findings. It produced a local ENU OBJ and conversion record, verified source/output hashes, preserved the face, checked both 1 m edges, and correctly marked Blender import INCOMPLETE when no executable was found. This was a synthetic import-preparation trial, not a real city or playable-game test.
- Offline suite: `test_pipeline.py` runs 15 tests without Blender, network or credentials; the symlink test skips where the account cannot create symlinks.

## Limits

- Python files parse and compile without `bpy`; that does not establish Blender API compatibility.
- No six-view contact sheet is implemented. The census was not run on a city tile, a rigged character or a Rapier collider in the browser. The 4.0–4.5 rows remain unverified leads.
- The self-overlap test counts parts that touch or interpenetrate without sharing vertices, so composite props need a per-part census or an accepted pair count rather than a blanket zero.
- Full glTF validation, road/nav semantic validation, hostile native-file sandboxing and target-device performance are beyond these helper tests. Do not turn a green helper report into game-release approval.
