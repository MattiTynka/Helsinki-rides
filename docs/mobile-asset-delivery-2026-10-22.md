# Mobile asset delivery

This pass builds on the current municipal city packet and the delivery protocol in
[the web delivery handoff](handoff-2026-10-20-web-delivery.md). It adds no map source,
photographs, models, motion data or licensing assumptions.

## Terrain transport and memory

The existing terrain contains 7,968,289 one-metre Float32 samples. HTER version 2
stores each sample's exact 32 bits as an unsigned difference from the corresponding
sample in the previous row, followed by four byte planes. Ordinary gzip then
compresses this reversible layout. Heights are never rounded, resampled or
quantized. Signed zero is preserved.

On the source packet, gzip storage falls from 24,168,565 to 15,795,170 bytes
(34.6%). Both representations produce the same canonical HTER version 1 SHA-256:
`b3283d543591f45bcaf27ba7ca1223589594c12a0a7a85e543d639ee79f4695f`.
The decoded transport is 31,873,184 bytes in either format. Existing HTER v1
releases and replays remain supported.

`loadWorldData` parses terrain before constructing `StaticWorld` and retains the
resulting immutable height grid. The compact transport buffer can then be
collected, and resetting the simulation reuses the parsed heights. HTER v1 can
use an aligned immutable view without copying; ordinary authoring calls retain
an independent, zero-offset array. Payload hashing and gzip streaming also avoid
unconditional whole-file copies while retaining their size and digest checks.

This is **whole-grid transport**, not terrain chunk streaming. Police placement,
pedestrian planning, safe spawns and recovery queries currently sample the grid
outside the player's immediate surroundings. Introducing missing terrain samples
would require authoritative coverage for all those queries, plus a replay-bound
physics residency protocol. The single Rapier fallback heightfield remains the
same size and topology. Unit verification compares native heightfield bytes,
off-grid support rays and 300 fixed physics steps between v1 and v2 inputs.

## Textured intermediate geometry

`tools/world/mobile_delivery.ts` derives a fresh immutable packet. Unchanged
payloads are validated against their existing size/SHA-256 and hard-linked into
the new output. Original files are never rewritten. The existing detailed and
distant tiers, map coverage, collision, roads, texture bytes, source ledger and
low-resolution texture tier remain available.

The builder attempts index-only simplification of the current intermediate tier
(or detailed tier when no intermediate exists):

- Generic ground: at most 0.01 m measured surface error and 0.003 interpolated
  UV/colour component error.
- Ordinary architecture: at most 0.04 m and 0.005 respectively.
- Normal interpolation: a separate 0.05 component ceiling; retained normal
  values are exact.
- Authored entrances, stairs, bridges, retaining walls, curbs, tram geometry and
  landmarks are protected by node/material identity. Steep generic ground
  triangles and geometric creases sharper than five degrees lock their vertices.
- Primitive outlines, holes and cell seam vertices remain fixed. Both source to
  candidate and candidate to source tests sample every non-degenerate triangle's
  vertices, edge midpoints and centroid. Exact zero-area triangles do not define
  rendered coverage.

These are measured sample bounds, not a continuous geometric error proof. A
candidate that cannot satisfy a check keeps its original primitive. A separate
file is emitted only when both triangle and file-size savings exceed 2%.
The publication receipt reports actual accepted cells; an aliased original tier
must not be described as a newly simplified mesh.

Serialization verifies the protected geometry again using exact per-corner
attribute bits and winding. Meshopt's triangle codec can cyclically rotate a
triangle's indices, so the check canonicalizes that equivalent rotation without
allowing reversed winding, changed corners or changed draw order. Licensed image
bytes are checked after reloading the serialized GLB, then externalized under
their original content-addressed texture references.

Additional intermediate files are selected by triangle saving per added byte,
within the declared world budget. The default is 960,000,000 bytes, matching the
release stager. A full map or source texture is never removed to fit another LOD.

The final scoped packet retains all 515 cells. Eight candidate cells were
recomputed, and two qualified: `c_m01_p03` (17,253 to 16,281 triangles) and
`c_p00_p03` (12,981 to 12,589). Every other cell retains its previous intermediate
tier. This is a modest local geometry reduction, not a city-wide geometry gain.
The packet is 942,884,046 bytes. The larger mobile improvement in this asset pass
is the smaller exact terrain download and avoidance of unnecessary memory copies.

Offline measurements stop after 2,000,000 candidate comparisons per direction or
1,000,000 spatial bin references per primitive. Exceeding either deterministic
work limit retains the original. All shared meshes are protected before any
mutation, preventing a later named stair/landmark instance from inheriting a
change through another node that shares its mesh.

Build into fresh paths, using the current source packet:

```powershell
node tools/world/mobile_delivery.ts --source <source-world> --out <fresh-world> --release <new-release-id> --report <fresh-report> --max-world-bytes 960000000
```

`--sample N` is for development only. It marks its output
`SAMPLE_NOT_FOR_PUBLICATION`. A full build is still pending runtime visual review
until the affected streets, stairs, facades and bridges have been viewed in the
game. Structural checks do not replace that review.

`--cells id1,id2` explicitly limits optimization candidates while retaining the
entire source map; its receipt records the candidate selection and total world
cell count. A private JSONL progress log binds every result to the source
manifest and builder/algorithm hashes. The scoped release was freshly computed
from its source, rather than accepting cached trial output as proof.

## Bounded decoding and disk caching

One `GlbLoader` queue bounds the combined cell/character/vehicle fetch and parse
work. Mobile uses one slot; ordinary desktop uses two. A cancelled queued district
does not start fetching. A parse already in progress retains its slot and returns
its resources to the existing owner for disposal after cancellation.

The Pages service worker now maintains an LRU cache of at most 128 immutable
payloads and 96 MiB of actual response-body bytes. Individual entries are capped
at 32 MiB, and at most two response copies can be pending. Compressed HTTP
`Content-Length` is not trusted as the resident size. Cache accounting and writes
serialize, stale release caches are removed, and interrupted writes are reconciled
against the persisted index. Quota or cache-read failure falls back to the network.
This bounds the application's Cache Storage usage; the browser manages its
ordinary HTTP cache independently.

No Meshopt decoding worker is added in this pass. The installed decoder's worker
API creates Blob workers; those need explicit lifecycle and browser fault testing
before introducing another asynchronous resource owner. Bounded scheduling and
smaller verified payloads are implemented here.
