# Individually qualified sloping facade floors

The generic facade author retains its less-than-one-metre street-floor range gate. A genuinely sloped, individually observed facade may instead bind a finite source registry entry through its plan:

```json
"observedGroundProfile": {
  "kind": "named-source-floor-profile",
  "path": "ground-profile.json",
  "sha256": "SHA256_OF_THE_EXACT_ENTRY_BYTES"
}
```

The file must live inside `content/assets/facades/new-area/`, including after resolving symlinks. It is limited to 256 KiB and its exact hash is required. `tools/world/lib/delivery-new-area-facades-ground-registry.ts` checks these entry fields:

| Field | Required evidence |
| --- | --- |
| `schemaVersion` | Literal `1` |
| `id`, `building`, `source` | Exact plan ID, joint BID/VTJ/owner identity, source JSON/bin hashes and origin |
| `sourceFacets` | Ordered `{part, triangle, key}` for every selected original native triangle |
| `frame` | Exact original `{origin, axis, width, minY, maxY}` after source selection |
| `manifestSha256` | Exact world used for the actual native ground sampling |
| `datum` | `{nativeRoofY, offset}`; roof must equal selected source `maxY`, sum defines one horizontal opening datum |
| `nineFloorSamples` | Nine literal complete native visual/HCOL sample objects returned by `probeHameentieStreetGround`; positions, cell/triangle keys and heights must remain identical |
| `qualification` | `artSha256` and `referencesSha256` are SHA-256 of `JSON.stringify(plan.art)` / `JSON.stringify(plan.references)`, plus nonempty appearance observations from the actual opened reference |
| `finish` | Explicit observed `plinthHeight`, RGB `plinthColour`, and `floorFollowingGlazingIndices` array (empty for ordinary level ground windows) |

Build entries only after matching the actual reference to the exact source elevation and choosing its horizontal floor-band datum. A preflight ground census alone does not qualify architecture, public access or window placement. Unvisited facades and private courts remain pending. Shared storeys around a corner should use the same physical datum, expressed relative to each selected native roof.

The author samples the actual world again and rejects changed floors, sample positions, source facets, neighboring buildings, unknown IDs, source geometry, roof levels, reference/art changes or manifest. Fresh post-road/tram integration therefore requires fresh entries if any actual floor proof changed. No generic geometry or ground tolerance is widened.

The renderer uses only the already-observed `art.groundOpenings`. Ordinary ground windows keep level heads and sills. Only glazing indices explicitly qualified as storefront glass follow the street at their lower edge; their heads remain level. Doors/passages start at the measured local floor, and each door retains its explicit observed height, so a long street slope cannot stretch an entrance to four or five metres. Openings below the actual floor reject. The source-following stone base is drawn behind openings. Custom per-building architectural details run afterward. It creates no new geometry, doors, collision, storeys or unseen windows. Ordinary Standard/Low runtime images still require review after authoring.
