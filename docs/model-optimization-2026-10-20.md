# Local model and delivery optimization

This change is local only. The published Pages descriptor and hosted release are
unchanged. The optimized derivative is `senate-20261020-optimized`, built from
`senate-pages-20261020-credits-tex1024` (manifest
`f77a471ef50efe09ce7435dad37f8b6329893cf7f34736474c94b0cc40dad75b`).

## Measured content

| Stored content | Before | Optimized |
| --- | ---: | ---: |
| Complete world | 942,316,787 bytes | 514,823,085 bytes |
| Collision and terrain delivery | 174,903,896 bytes | 61,978,265 bytes |
| Detailed city triangles | 4,316,755 | 4,257,250 |
| Distant city triangles | 4,069,967 | 3,110,003 |
| Finn, Rain and three near-car GLBs | 17,664,020 bytes | 13,934,964 bytes |
| Full-resolution local world | 1,686,367,441 bytes | 1,254,785,388 bytes |

All 304 cells remain. The derivative manifest SHA-256 is
`27d697c4c918cea8f03a05d79faad4b8d68be4d30c37249cfe50af3f13818455`.
These are whole-world stored sizes and triangle inventories, not simultaneous
GPU residency or browser transfer measurements.

The separate local derivative `senate-20261020-optimized-native` preserves the
full-resolution images of `senate-20261020-credits`; it does not substitute the
web texture set. Its manifest SHA-256 is
`ef4c4d253ce4b4586bcc80481f5e9732ca4c8ba93cfa2a39d4b3d935c66538a2`.
The web archive is 458,548,712 bytes and remains local. No descriptor, release
asset or Pages deployment has been published by this work.

## Production steps

`tools/world/optimize_release.ts` takes an original, embedded-texture release and
writes a fresh derivative. It checks each source payload's size/hash, processes
one cell at a time and retains unchanged payloads with hard links. Source models,
worlds and the published descriptor are never overwritten.

1. Remove obsolete meshes, accessors and binary ranges left by append-only repair
   operations. Reachable compressed streams and images are copied exactly.
2. Remove exactly duplicated opaque triangles from the detailed city. The
   complete per-corner attributes and winding identify an exact duplicate.
3. Build guarded intermediate/far candidates. Shared boundaries, outlines,
   architectural faces and stair/curb creases are protected. Retained positions
   are Float32 and are not quantized. Intermediate candidates require at least
   2% additional triangle reduction; otherwise they share the detailed file.
   An existing better intermediate landmark remains selected.
4. In distant unlit, opaque, double-sided materials, identical reversed faces
   with identical per-corner attributes are redundant and may also be removed.
   Simplification is accepted only with unchanged boundary graphs and measured
   sample deviation within 1 mm intermediate / 1 cm far limits. These limits
   are verification bounds on samples and Meshopt's error estimate, not a proof
   of the mathematical distance between every point on both surfaces.
5. Store exact encoded city image payloads once in `textures/<sha256>.ktx2`
   or `.png`. GLBs use pinned relative URIs; nearby texture pixels and mip chains
   are unchanged. Browser cells own separate texture handles; immutable decoded
   KTX2 data may be shared through Three.js's reference-counted texture sources.
6. Gzip collision and terrain delivery, pin both stored and decoded sizes/hashes,
   and validate an exact decoded round trip. Physics insertion order is retained.
7. Compress actor buffer views with raw Meshopt and immediately decode/compare
   every changed view byte for byte. No quantization, resampling, clip edits,
   weight edits or node renaming occur. Manifest provenance links the stored
   derivative to the source model used by the car-entry poses.

All three cars have separate far exterior models with a 3 cm error ceiling;
lamp geometry remains exact. They contain 5,791 / 5,877 / 3,935 triangles for
Lumi GT / patrol / Revontuli. Both presets can use these derivatives.

To reproduce from the existing locally prepared web baseline:

```powershell
node tools/world/build_far_vehicles.mjs --assets build/model-optimization/far-input --out build/model-optimization/far-assets-new --vehicles vehicle-lumi-gt,vehicle-patrol,vehicle-revontuli
node tools/world/optimize_release.ts --source build/pages-world-credits/world/senate-pages-20261020-credits-tex1024 --out build/model-optimization/new-world/senate-optimized-new --release senate-optimized-new --report build/model-optimization/new-world-report.json --far-assets build/model-optimization/far-assets-new
```

The far-input directory contains links to the three accepted near-car GLBs named
by their asset IDs. All output and report paths must be fresh. No network or
paid tool is used by these commands. A future archive should use USTAR regular
entries: content-addressed texture paths need its prefix field, whereas GNU
LongLink records are deliberately rejected by the packet verifier.

Pass `--native` when optimizing the original full-resolution local world. This
selects a 2 GB local output ceiling instead of the 950 MB web ceiling; it does
not change the image, geometry or simulation transformations.

## Runtime

Terrain, JSON and collision loading share six request slots. Model loading starts
as soon as the manifest is validated. Startup waits for the playable visual
neighbourhood while remaining selected cells continue loading under the existing
limits. Ordinary traversal still blocks safely if visual coverage is missing.

Before GPU preparation, the streamer reserves the cell's measured texture and
geometry costs. Texture uploads share a 2 ms / two-job frame queue, and shaders
are prepared asynchronously. A cell becomes visible only after preparation.
Cancelled work keeps its slot and budget until it settles, then releases exactly
once. An individual synchronous driver upload can exceed the queue's time budget.
Concurrent KTX2 request/transcode caching must not share a disposable texture
handle across cells: unloading one cell must leave the other's handle alive.

Standard also uses conservative posed-character culling, per-instance scenery
culling and existing whole-card foliage LODs. Close foliage retains its complete
source geometry. Pixel ratio, camera and movement behavior are unchanged.

The complete deterministic collision/terrain world remains resident after
loading. Compression reduces delivery bytes; it does not reduce decoded physics
memory. Collision streaming and newly retopologized NPC bodies are separate
future work. Existing texture and geometry residency limits remain in force.

## Verification

Local build, static preservation, browser and replay evidence is recorded under
the ignored `build/model-optimization/` directory. This includes exact source,
runtime and manifest identities. Fixture drop-ins measure rendering/residency;
real keyboard journeys and their Node replays separately verify gameplay.
The web derivative passes a full manifest/payload closure and preservation audit:
all 304 near meshes, 506 encoded shared textures, decoded physics payloads,
actor accessors and clips remain exact; 1,177 unique GLBs have no validation
errors or added warnings. The two far cells with changed triangulation pass
2,520 bidirectional surface samples, with a maximum measured deviation of
9.721 mm. Near triangle removal preserves all unique oriented faces.

The independent full-resolution local audit also passes all 304 cells and
1,177 GLBs, checking 505 shared images against their original encoded payloads.
It confirms the same exact near geometry, simulation and actor preservation.
The audited source checkout passes 655 portable tests and TypeScript checks;
the release tooling passes 68 Python cases with one Windows-specific skip.
Web production, web review, local production and local review shells build.

The desktop fixture comparison reduced Mannerheimintie's rendered triangles
from 731,441 to 477,689 in the checked view. The three-circuit web residency
test returned to Senate Square without growing geometry or texture allocations
or exceeding residency limits. These are desktop fixture observations, not an
integrated-GPU frame-rate guarantee. Physics remains fully resident.

The final desktop web run starts in 11.487 s versus the baseline's 10.417 s;
the loopback test does not demonstrate a startup-time improvement. Smaller
delivery payloads and bounded background uploads are the confirmed changes.
After the texture-ownership fix, all three return visits retain exactly 205
geometries and 208 textures; retained JavaScript heap stays within 51.0–51.9 MiB.

Actual keyboard car entry, driving and exit replay identically for 1,034 ticks
(`e943b1fa`). Cathedral and University stair checks pass 50/50, including actual
keyboard traversal, visual/collision support probes and browser resource hashes.
Opened captures show continuous repaired stair joins and the character standing
above the upper landing. These stair fixtures do not prove every building or
reachability from the default spawn.
The rebuilt full-resolution local review shell also passes the same real-keyboard
car cycle and identical 1,034-tick replay after the ownership fix.
