# Cumulative south and west preparation

These are unpublished packets against the original 515-cell accepted manifest. `scope-cumulative.json` records the original terrain/cell/source envelopes separately from actual new ownership. South A+B+C owns `[-1792,768,800,1792]`; west D owns `[-2816,-384,-1792,1152]`. Both use terrain `[-2816,-2304,800,1792]`. The original east source/cell halo ending at 896 is not new playable land. Composition order is south, then west; emitted replacement regions assign the shared frontier corner once.

Stage A v2's original pinned preparation/configuration bytes were archived before changing the adapter at `../evidence/producer-snapshots/stage-a-build-v2/`. Do not use Stage A's larger rectangular terrain as the accepted authority for later packets.

Run from the isolated `source` checkout. All output paths must be fresh. Commands below are a reproducible sequence, not evidence that the builds passed. Serialize geometry/asset production.

## Shared inputs

The completed seven-layer acquisition is `../sources/raw-v2`, snapshot `southwest-cumulative-20261029`. Its canonical job SHA-256 is `4d5919585b1ac08076179a7c0ff5a6d41ace0e431934219662b0969330928339`.

The v2 terrain index is byte-identical to v1 (`fd41a14477fe83c45f616a4974cd1c581b56bde599f996be9199d632c6818fcb`). Therefore the shared raw terrain may use the explicitly qualified immutable v1 terrain snapshot and its existing single-sample parent-LOD qualification. Its original ledger, snapshot, producer, input hashes and fallback receipt remain in provenance; the adapter also binds the v2 acquisition ledger. Do not relabel v1 terrain as freshly generated from v2, or reuse the old Stage A raw grid without a producer receipt for these cumulative profiles.

```powershell
node tools/world/build_terrain.ts --tiles ../sources/raw-v1/terrain/southwest-20261029 --ledger ../sources/raw-v1/terrain/ledger.json --origin content/helsinki/world-origin.json --config content/helsinki/southwest-20261029/cells-cumulative.json --resolution 1 --source-fallback content/helsinki/southwest-20261029/terrain-single-sample-fallback.json --out ../work/raw-terrain-cumulative-v1

node tools/world/convert_city_model.ts --ledger ../sources/raw-v2/lod2/ledger.json --snapshot southwest-cumulative-20261029 --origin content/helsinki/world-origin.json --out ../work/city-model-cumulative-v1
```

The raw terrain command requires the pinned parent tile, metadata, comparison and download receipt under `../evidence/terrain-hole/`, and the original pinned scope. Any changed pin requires explicit renewed qualification. Every other missing primary sample still fails.

## Prepare each packet

```powershell
node tools/world/prepare_expansion_build.ts --phase plan --scope content/helsinki/southwest-20261029/scope-cumulative.json --profile content/helsinki/southwest-20261029/build-cumulative-south.json --region cumulative-south-abc --sources ../sources/raw-v2 --snapshot southwest-cumulative-20261029 --accepted-world ../accepted-world/world/senate-20261025-civilian-flee --accepted-coverage ../evidence/accepted-coverage --accepted-source-terrain "../sources/terrain-source-v1" --tree-profile ../../../data/work/expansion-20261017/trees-models/blender-report.json --tree-asset ../../../data/work/expansion-20261017/assets/scenery-trees.glb --converted-model ../work/city-model-cumulative-v1 --raw-terrain ../work/raw-terrain-cumulative-v1 --out ../work/cumulative-south-build-v1

node tools/world/prepare_expansion_build.ts --phase plan --scope content/helsinki/southwest-20261029/scope-cumulative.json --profile content/helsinki/southwest-20261029/build-cumulative-west.json --region cumulative-west-d --sources ../sources/raw-v2 --snapshot southwest-cumulative-20261029 --accepted-world ../accepted-world/world/senate-20261025-civilian-flee --accepted-coverage ../evidence/accepted-coverage --accepted-source-terrain "../sources/terrain-source-v1" --tree-profile ../../../data/work/expansion-20261017/trees-models/blender-report.json --tree-asset ../../../data/work/expansion-20261017/assets/scenery-trees.glb --converted-model ../work/city-model-cumulative-v1 --raw-terrain ../work/raw-terrain-cumulative-v1 --out ../work/cumulative-west-build-v1
```

Each `build-job.json` contains structured `commands` (`program` plus argv `args` and explicit `dependsOn`). Execute them sequentially from the same source checkout. They prepare distinct source/runtime grids, select new whole BID owners while protecting accepted BID/VTJ identities, filter new trees, and build native cells with explicit bridge exclusions. The sequence then archives the native index/report, runs the mandatory `build_distant_cells.mjs --cells <native-directory>`, and prepares delivery cells after checking that the coarse builder preserved all detailed descriptors. Native `streaming.lod2` configuration alone does not generate the distant geometry. The source mask is assembled only within each actual ground-work domain. A new VTJ shared across different packets fails for source-owner review; no arbitrary deduplication is performed.

Completed v2 currently reports no vector/OSM conflicts. If a later acquisition reports conflicts, provide an exact hash-bound `--conflict-review` with status `QUALIFIED_FOR_EXPANSION_SOURCE_BUILD`, the canonical acquisition job hash, `regionIds` containing both cumulative IDs, all nonzero `{id,sha256}` conflict reports, and the reviewed disposition.

After native builds, delivery staging, source-qualified supported-area geometry, approved road merges/repairs, exact accepted-content checks, tree/physical support, runtime journeys and performance remain required. The terrain rectangle and packet envelopes do not establish those gates.
