# 0001 Fresh build in this repository, with recorded deviations from plan v3

Date: 2026-10-16. Status: accepted (user decision).

## Decision

`GTA-Helsinki-Fable` is a fresh implementation of `docs/Helsinki_Browser_Game_Implementation_Plan_v3.md`. The
previous repository (`../GTA-Helsinki`) is a read-only reference for contracts and
constants; no source files are copied from it. Inherited `tools/` and `data/` in this folder are kept; the Blender
city path (`tools/blender/build_city_district.py` and `tools/blender/district/`) is retired per plan section 4 and
stays only as history. Git was initialised on request; nothing is committed unless asked.

## Target

M0 (pilot cells through the cell builder) and M1 (the 60-second test) from plan section 16, on the pilot area
`E 25497250-25497500, N 6672750-6673250` around Senate Square, origin `senate-square-statue-v1`.

## Deviations and why

| Plan item | Deviation | Reason |
| --- | --- | --- |
| City terrain layer from the 3D Tiles stream as ground baseline (3, 4.1) | Ground baseline sampled from the 2017 photo-mesh cells already on disk (`data/work/pilot-v1/cells`), lowest surface per 1 m, building interiors filled from their perimeter | The terrain layer is not mirrored; the plan's M0 task is to evaluate the stream layer against this terrain, which stays open (`DATA-002`) |
| Landmark detail from the 2024 photo-mesh, 2017 where scaffolded (4.3) | All landmark detail (Cathedral, terrace, stairs, Alexander II statue) from the 2017 mesh | Only the 2017 mesh is on disk; the Cathedral is explicitly 2017 in the plan anyway. Superseded by decision 0004: buildings solely from the textured LoD2, no mesh cut-outs |
| City tree layer (4.3) | No trees in M0/M1 | Layer not mirrored; no gameplay dependency before M3 |
| LOD1/LOD2 per cell (4.1 step 8) | LOD0 only | The pilot loads completely at start (section 5); LODs matter from M4 streaming |
| `packages/data` (15) | Loaders live in `apps/game/src/world`, transforms in `packages/world-schema` | Three packages are enough for the pilot; split when GTFS and radio loaders arrive (M3/M6) |
| Digitransit geocoding (2, 11) | Drop-in address search uses the city building register addresses baked into `gameplay.json` | No registration needed, no network in the public game, covers every address in the released area |
| Mixamo characters (2) | Blender Studio Snow (player) and Rain (officers) exported through a baked game skeleton | User-supplied rigs; CC BY credit recorded |
| Fictional vehicle brands (6, 18) | The user-supplied Mustang rig is the sports car; badges, lettering and plates are removed on export and the definition is named `lumi-gt` | User instruction; brand marks never ship |
| Blender container (skill) | Blender 5.2.1 runs on the host through the skill runner with thread and memory caps, one job at a time | No container engine in this environment; inputs are the user's own files |
| KTX2 via `toktx`/`basisu` (4.1 step 7) | KTX2 via the `ktx2-encoder` npm package (Basis Universal WASM) in Node | Neither CLI is installed; same codec, recorded version 0.6.0 |

## Open issues

- `DATA-002`: compare the city terrain layer with the mesh-derived terrain once mirrored.
- `ART-002`: Cathedral hero model to replace the 2017 mesh cut-out later.
