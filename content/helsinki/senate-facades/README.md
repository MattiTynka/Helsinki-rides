# Senate source-wall charts

These original CC0-1.0 textures replace selected constant-colour source walls.
They are material charts on the original municipal triangles, without geometry,
collision, roof or tree changes. Google Street View and the City's architectural
photograph establish appearance only; none of their pixels are reproduced.
Each `v1/<VTJ>/source-ledger.json` records the observations and remaining limits.

The frozen baseline is deployed source `9bbbba7fecaf3ae4bb478aeae9b17b5baf8d9389`,
world `senate-20261020-optimized-m1-cb`, manifest
`5a3502a4641de1a79dfd40dbb06724b59d4e908d16f3a5218b8e7dcead3f7ebd`.
The municipal source JSON and BIN hashes are pinned in `plan.json`; a different
city conversion requires explicit source-face requalification.

| Source record | Restored planes | Deliberately unmodified |
| --- | --- | --- |
| `103017637K`, Aleksanterinkatu 14–18 | North square frontage: east salmon Brummer14, centre yellow Remander16, west pale Sederholm18 | Katariinankatu frontage, courtyards and roof. The source mesh lacks Sederholm's projecting north pediment. |
| `103036705N`, `BID_fc7cc496-989f-4aa4-af91-5425569ba6c4` | Archive south central portico and its two set-back wings | Rear, side and narrow inset return planes; the other already-textured source record at this address. |
| `1030368080`, Porthania | Public south courtyard and three distinct east street-wall zones | Outer north/west faces, low east return, unobserved courtyard returns and roofs. |
| `103036707R`, address-labelled Snellmaninkatu8 | None: physical rear-wing reference remains unresolved | Entire original source record. The address search identifies a different frontage and is not evidence for this building. |

Reproduce the original atlas and source selectors with the pinned city conversion
and deployed world in local directories. Use a fresh output directory:

```powershell
node tools/world/author_senate_facade_charts.ts --plan content/helsinki/senate-facades/plan.json --city-model <pinned-city-model-directory> --baseline <deployed-world-directory> --out <fresh-art-directory>
```

For optimized delivery worlds, apply each shipped profile after independent
entrance/ground repairs, again writing a fresh directory:

```powershell
node tools/world/apply_delivery_facade_charts.ts --baseline <deployed-world-directory> --current <fresh-repaired-world-directory> --city-model <pinned-city-model-directory> --profile content/helsinki/senate-facades/v1/103017637K/profile.json --out <fresh-payload-directory>
```

Repeat for `103036705N` and `1030368080`. Each `patches.json` contains replacement
payload file references and the complete updated owner-cell descriptor. The
release assembler copies those payloads into a fresh derivative and replaces
only the corresponding cell entry. It retains all unrelated payload references,
reduced-texture mappings, terrain, scenery, and collision. Never edit an immutable
world or hard-linked payload in place.

The adapter checks the original source-building triangle keys, rebinds them to
the current LOD0/LOD1/LOD2 drawing indices, and preserves original physical BIN
bytes, external image descriptors, all other UVs, coordinates and winding. New
atlases are embedded KTX2, at most 768 pixels per side. The distant tier keeps its
original geometry and samples colours instead of adding texture residency.

Passing these assertions is preparation for runtime review. Inspect pedestrian
front/close/oblique views and both returns, actual walking, compressed texture
appearance, GPU memory and errors on the final combined world before acceptance.
