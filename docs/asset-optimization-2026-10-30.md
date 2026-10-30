# Southwest asset optimization checkpoint

> User stop, 30 October: further map expansion is deferred. Wrap up, commit, merge and ship only the completed playable scope and integrated optimized assets. Broader southern/western navigation, private parking/w282 proposals and Viikki are outside this release.

Status: local derivatives validated; final game/content integration and publication remain pending. The deployed world is unchanged. Decimal MB/GB are used below.

## Measured storage

| Candidate | World bytes | Meaning |
| --- | ---: | --- |
| Complete southern/western staging | 1,311,824,831 | 775 cells; first qualified gameplay mask only |
| Lossless changed-city compaction | 1,262,756,324 | Removes unreachable append resources; protects accepted visual hashes |
| Additional lossless simulation compression | 1,229,966,600 | Exact decoded terrain, road graph and collision bytes |

The net reduction is 81,858,231 bytes (6.24%), including the additional proof files. This does not establish final playability or a frame-rate improvement. The current candidate still exceeds the unchanged 950 MB world budget for Pages.

Compaction changed 121 city visuals and removed 49,589,860 payload bytes. The producer checked exact active decoded accessors, images, materials, UVs, transforms, scenes, encoded reachable semantics, idempotence and Khronos conformance. Accepted visual payload hashes remain literal. The content manifest is `da3132691bc9e532bbab56695a2f5caf75517f4134d124fe83aea6d96ffd5e1b`.

Simulation compression changed 748 payloads and saved another 32,964,864 payload bytes. Both native application and independent Python verification compared all 777 terrain/road/collision decoded payloads exactly. Collision metadata, extents and order, and every other visual/texture/actor/scenery/gameplay reference remain unchanged. The complete native inventory, decoded-payload and privacy validator passes. The manifest is `0e25d706b7390067c545afec8619bc3e0a6c9f83b807cf95ba8c2da882d9c34e`.

## Texture evidence and next selection

Textures occupy 631,525,254 bytes in the original complete staging: 496,762,417 Standard and 134,762,837 Low. Every one of the 1,095 Standard and 1,077 Low references is reachable. No texture becomes unused after raw GLB compaction. There is consequently no orphan-texture saving to claim.

Same-resolution UASTC RDO experiments retain dimensions and mip levels. Five actual-world decoded-mip samples saved a weighted 5.79% at q1 and 8.61% at q2. An exact original-source replay of three new native atlases saved 9.39% at q2. Aggressive q8 diagnostics saved only 10.61–14.34% on the sampled ordinary/hero textures. These are encoded-byte measurements, not approved game assets or whole-world forecasts. RDO changes pixels and may change alpha, so qualification must inspect every material use, including masking and blending. GPU block allocation is unchanged by these same-resolution settings.

Further work prioritizes exact-source q2 candidates for new South/West atlases, preserves all original masters, and requires actual Standard/Low runtime comparison before adoption. Broader accepted-texture re-encoding or resolution changes need a separately reviewed derivative. A smaller archive alone does not justify facade detail loss.

## Opened runtime comparison and source qualification

The Merikatu/Neitsytpolku sample has now been opened in the actual game: three matching views for baseline and candidate in both Standard and Low, twelve images in total. The changed owner cell was rendered in every frame. This scoped comparison found no additional visible damage to facade layout, colour, windows, doors or corners. Existing source blur remains visible. These were explicitly paused visual fixtures outside the first playable mask; they establish relative compression appearance, not navigation or final map acceptance.

Texture dimensions, mip counts and GPU block allocation remain unchanged. The scene-material texture estimate was 77.94 MiB in Standard and 30.27 MiB in Low for both sides. This diagnostic counts logical texture handles and is not the renderer GPU-allocation census; shared Source/GL handles can reduce actual resident storage. The q2 pass reduces encoded transfer/storage, not GPU memory. Lower resolution is already provided by the native Low tier; no further resolution reduction is part of this pass.

The complete batch now contains all 240 eligible new Standard atlases across 180 owner-cell jobs (120 South and 60 West). Every original native atlas and baseline mip was reproduced before encoding; all 180 caches have sealed canonical source qualifications. Existing accepted city atlases remain protected.

The complete cached Standard/Low pairs shrink from 142,499,728 to 126,327,111 bytes: 16,172,617 bytes saved (11.35%), with every selected pair smaller. Supplemental source proofs add 647,523 compressed bytes. These are complete cache measurements, not final-world net savings: final application must account for its receipt, manifest, live reference closure and protected authored facade chart. The modest reduction does not make the expanded world fit the unchanged Pages limit. Dimensions, mip counts and GPU allocation remain unchanged.

Each final cache also requires an independently generated canonical source qualification. The qualifier reconstructs raw atlas pixels, checks the original native image and every baseline mip, resolves only actual selected model/native inputs inside their canonical roots, and pins the encoded derivative payloads. Historical Windows path-role mistakes are corrected in separate supplemental proofs while the original cache and encoder producer bytes remain unchanged. Final application must use `--require-source-qualification`, with every cache and supplemental proof hash pinned.

Eight implementation/test files were frozen for independent review. All target hashes matched and the five focused tests passed, including changed source pixels, wrong source/cache pins, same-byte unreferenced files, junction escapes and bounded binary errors. The source-qualified sample manifest `ec868dcc05fa2f9f82894d6af83597d966197af1088fa0a2470b942c60b36587` has exactly the runtime payloads of the browser-reviewed sample; only provenance metadata differs. Full integration is complete as recorded below. Representative final views and deployment checks remain pending.

## Reproduction and implementation

For a full native-atlas batch, pass `--cache-list <file> --cache-list-sha256 <sha256> --require-source-qualification` to `apply_delivery_native_atlas_rdo.ts`, alongside its world, immutable-world, output, release and delivery-budget arguments. This avoids Windows' command-line length limit. The bounded list replaces all repeated cache/qualification flags; each entry still passes the same source, pixel, native baseline, mip and payload checks.

```json
{
  "schemaVersion": 1,
  "kind": "qualified-native-atlas-cache-list",
  "entries": [{
    "cache": "../cache-directory",
    "cacheSha256": "<cache.json SHA256>",
    "qualification": "../source-proof/qualification.json",
    "qualificationSha256": "<qualification.json SHA256>"
  }]
}
```

The list is limited to 512 KiB and 512 entries. Relative paths resolve from its directory; existing paths are resolved canonically, and duplicate cache directories are rejected. Keep the fresh world output outside the list directory and every input directory. Public receipts contain the list digest and entry count, not private input paths. The original repeated flags remain supported for smaller jobs.

- `tools/world/compact_delivery_city.ts` uses the existing decoded city proof and protects the deployed visual hashes. Pages retains its original limit; a larger private external candidate needs an explicit bounded delivery mode.
- `tools/world/recompress_delivery_simulation.ts` accepts an optional hash-pinned gzip candidate cache. It selects a smaller representation only after exact bounded decompression and byte comparison. Cached bytes are untrusted until validated against the actual source reference and decoded content.
- Python 3.14's installed zlib-ng and Node's zlib produce materially different sizes for this collision data at the same level. The actual cache records the compressor/runtime versions and generator digest. Both outputs use the existing gzip decoding protocol; no runtime format, position quantization or physics simplification was introduced.
- Changed simulation filenames retain `.hcol.gz` or `.bin.gz`, as required by the native publication allowlist. Earlier experimental outputs remain separate and are not release candidates.
- Focused compaction tests (7), simulation compression tests (3), world typecheck, full native payload validation, and independent source/decoded-byte comparisons pass. Final routes, renderer/GPU checks, moving performance, production build, publication and live verification remain separate gates.

Local evidence is under `build/city-expansion-southwest/evidence/`: `cumulative-asset-size-profile-v1.json`, `cumulative-delivery-storage-opportunities-v2.json`, `cumulative-city-compacted-integrity-v1`, `cumulative-simulation-gzip9-integrity-v3`, `cumulative-simulation-gzip9-independent-v3.json`, and `simulation-recompression-independent-review-v1.json`. Completed producer closures and the compression-cache recipe are archived under `producer-snapshots/`.

The opened comparison is recorded in `rdo-merikatu-opened-review-v1.json`. Source-contract review and focused-test evidence are `native-rdo-independent-review-v2.json` and `native-rdo-independent-focused-v2.log`; the metadata-only sample comparison is `cumulative-native-rdo-sample-v3-validation.json`.

Complete texture counts and source-proof overhead are recorded in `native-rdo-complete-measurement-v1.json`. The final 180-entry list is `native-rdo-final-application-input-v1/cache-list.json`, SHA256 `3e1e788c0eb56ac540f5fae1de99aecfb95dd0a018ff99af2cef0bc481eb3d05`. Its archive preserves every original cache, supplemental proof and 29 distinct historical producer-file versions; encoded payloads remain in their immutable cache directories and were all rehashed during packaging. The list implementation and negative controls passed independent review in `native-rdo-independent-review-v3.json`. Final-world application is complete as recorded below.

The subsequent read-only Meshopt census binds the shore candidate `fddfbfa3f85ac81fd8374769bf94284eb04fee2072dc34908de3874b0c142c22`. All 584 new or changed city payloads (119,448,556 bytes) already use compressed active buffer views, with no raw active views to compress. The 969 protected accepted payloads contain only 637,524 raw active bytes across five payloads. This establishes no substantial additional raw-buffer compression opportunity; it is not a saving forecast. The complete inventory is `city-meshopt-opportunities-v1.json`.

## Integrated texture application

The complete source-qualified batch is applied to the cumulative facade/tree/bridge world. The parent manifest is `511be2942861b9b79de7fc90bb5e5bd4f4d9217911de6828e4f9cab02521b60b`; the derivative is `a6872e68f4a96898d5a915dc99cf3cfb01ce82b4ec6f45bafb8932eb0a4032be`. It changes 180 owner visuals, retaining all geometry/BIN/material state and simulation references. There are 241 qualification occurrences because one selected pair is shared; the batch contains 240 unique Standard/Low pairs.

The complete world shrinks from 1,275,350,156 to 1,260,008,277 bytes: **15,341,879 bytes net** after source proofs, application receipt, manifest and reachable reference closure. Native inventory, decoded-payload and privacy validation passes for all 4,827 files. Dimensions and mip levels are preserved, so this saving affects transfer/storage rather than GPU texture memory. The world remains above the unchanged Pages limit. Later geometry/road repairs must compose on this optimized parent, and final game acceptance remains pending.

Application evidence is `cumulative-city-native-rdo-v1-process.json`, `cumulative-city-native-rdo-current-v1-publication.json` and `cumulative-city-native-rdo-integrity-v1/result.json`. The actual current 31-file producer closure is archived independently of historical sample receipts; final application uses the current nested-public-island schema fix. The original source caches and historical producers remain preserved.

The integrated Eiranranta and Ruoholahti canal comparison is now opened: 24 actual game images covering two locations, three angles, baseline/candidate and Standard/Low. Changed owner draws are present in every capture. No additional visible facade, edge or colour damage attributable to compression was found; source blur, blank sidewalls and patchwork ground remain on both sides. Small presentation differences prevent pixel-identical screenshot claims. These private paused fixtures do not establish navigation or frame-rate acceptance. Evidence: `rdo-integrated-opened-review-v1.json`, SHA256 `72024c37071d0319c504b2e4325aeeb89eaebbef502de8ac2f25ff67fcaa66a3`.

Independent application review confirms all 240 unique pairs, 180 changed GLBs, original BIN and all other GLB JSON except selected image URIs, protected accepted Standard/Low images, the authored facade chart and every simulation/gameplay/tree reference. All 5,854 reviewed pins remain stable. Evidence: `cumulative-native-rdo-independent-review-v1.json`, SHA256 `8003f292ab608972a2e3441703512f35d14e67edb9363142c9f02a402adb8204`.

For GPU-memory decisions, inspect the existing renderer-backed `textureOwnership()` census and its shared allocation accounting. The older `textureMemory().duplicateMiB` hashes logical texture contents; it does not by itself demonstrate duplicate GPU allocations or a further deduplication opportunity. Existing Low mode already uses reduced encoded mip tiers and compact transcode targets where supported. No new runtime resolution or sampler change is included in this texture pass.

The integrated byte census separates the remaining costs:

| Category | Stored bytes |
| --- | ---: |
| Standard textures | 483,491,187 |
| Low textures | 132,181,744 |
| City GLBs | 385,057,700 |
| Collision | 142,754,183 |
| Publication proofs | 35,818,755 |
| Other, including terrain, actors and manifest | 80,704,708 |

The largest individual object is the stored terrain at 44,858,350 bytes; every object is below 100 MiB. This object-size census does not make the complete 1.26 GB world fit Pages, and is separate from repository/pack/serving limits. The next lossless storage step is fresh simulation recompression after final ground and graph repairs. Evidence: `integrated-delivery-census-v1.json`.

The native benchmark now records raw successive animation-frame intervals and actual renderer-backed texture ownership at every measured scene endpoint, including optional district stops. Its original FPS/draw/triangle/logical-texture gates are retained, with additional complete-ownership, measured-storage and actual GPU-byte checks. Endpoint snapshots are separate from the longer residency soak. The frame collector starts from the first animation-frame timestamp, avoiding an invalid first interval between different timestamp sources.

A short Standard baseline run on the original accepted world (`0e18e55e8730f01144eef72a80decffbb53cdd658222f87a7e8ad6f75f2c4260`) passes 12/12 checks on the RTX 3070 Ti/D3D11 at 1280x720. Scene averages are approximately 121-124 FPS. The four-second driving measurement records frame-interval p50/p95/p99 of 8.1/8.9/17.1 ms, maximum 19.2 ms, and 111.36 MiB of actual GPU texture allocation at its endpoint, with zero unaccounted or unmeasured textures. Original loaded runtime and manifest response hashes match. Evidence: `native-baseline-benchmark-standard-v3/browser.json`; screenshots remain captured but unreviewed. This verifies the measurement path on the old city, not expanded-map performance or a long-run guarantee. Final Standard/Low district measurements, moving travel and residency checks remain pending.

The later seam and road-grade candidate `fe78e6a00102dc33f80c9685b1b204465c2d21e5d470ef20586ca1dddd3817c2` retains both optimized texture tables literally. An independent active scene/material traversal checks all 1,553 city visual payloads: all 1,096 Standard atlases remain reachable and all 1,078 Low mappings have reachable sources. Their stored totals remain 483,491,187 and 132,181,744 bytes. All texture payloads are rehashed; actor and scenery asset references also remain literal. Evidence: `optimized-textures-through-road-repairs-v1.json`, SHA256 `af83e503d5100faab5e88aaf85a83596503174acf318a32dcd446a40258080ae`.

The remaining active embedded city images total 1,878,739 unique encoded bytes: eight are already KTX2, and the ninth is a 110-byte 44x4 PNG. These preserved authored images account for only a small residual cost; they do not reveal a large uncompressed-image opportunity. Evidence: `embedded-city-image-census-v1.json`. Final lossless simulation recompression and measured residency remain the next optimization gates.

## Low foliage trial and expanded resource views

The candidate changes only Low's foliage LOD scale from 1 to 0.8: existing whole-tree card transitions move from 120/240 m to 96/192 m, with the existing hysteresis. Standard, texture resolution, source geometry, streaming distances and rendering resolution remain unchanged. The 35 affected quality, culling and LOD checks and game typecheck pass. This is a provisional renderer change pending final actor, travel and native performance gates.

Four locations were measured at six matching orientations in each candidate preset. Each orientation has ten settled samples with complete measured GPU ownership. The private fixture retains all final-city assets but removes the supported-area mask for paused inspection; it is never a publication candidate. It remains at tick zero without populated actors, so these measurements do not establish frame-rate or gameplay acceptance.

| Location | Worst Low triangles, scale 1 | Worst Low triangles, scale 0.8 |
| --- | ---: | ---: |
| Hietalahdenranta | 387,830 | 371,150 |
| Eiranranta | 495,453 | 477,013 |
| Merikatu | 437,832 | 413,032 |
| Ruoholahti canal | 493,302 | 462,662 |

All eight matched Low before/after images were opened. Nearby trees, trunks and canopy outlines remain intact in these views; distant card changes are subtle. The candidate stays below the unchanged 500,000-triangle Low limit in these paused samples. Actors and movement may add cost and still require final testing. Evidence: `low-foliage-lod-trial-v1/review.json`, `expanded-asset-resource-probe-low-v1/result.json` and `expanded-asset-resource-probe-low-v2/result.json`.

The unchanged Standard preset reaches 744,749 triangles and 207 draw calls at most across 240 paused samples. Actual texture allocation ranges from 49.95 to 69.12 MiB, with zero unaccounted or unmeasured textures. All four worst-orientation Standard captures were opened individually. Source facade blur, blank walls and patchwork ground remain visible; these views establish no new compression comparison. Evidence: `expanded-asset-resource-probe-standard-v2/opened-review.json`.

No encoded-byte or GPU texture-memory saving is attributed to the foliage setting. The next storage pass remains fresh lossless simulation compression after final navigation and ground edits. Further texture resolution reduction requires a separately measured derivative and visual comparison; no such reduction is currently applied.

The installed and repository skill guides now explicitly cover instanced foliage LOD/hysteresis, renderer-backed texture ownership, and the limits of paused resource fixtures. Both copies of `references/web-optimization.md` match SHA256 `46d423927298406e9ce7a9be0be2480a6345acb8b8e70063aa227540c5b16eb3`; both skill structural validators pass.

The later east walking-seam world `d453fdd79db114c914322f0209121c34819206b294004bdcece2739f0f3b4701` also retains the optimized texture tables and all material/image state literally. It adds 60 small pavement faces to each visual tier without another draw, with complete native inventory/privacy validation passing for 4,832 files / 1,263,700,347 bytes. The added geometry still requires the final performance checks; the paused Low/Standard resource measurements above bind their earlier explicit asset fixture. Evidence: `east-walking-seam-serialized-independent-review-v2.json` and `cumulative-city-east-walking-seam-integrity-v1/result.json`.


## Running Low baseline with actor evidence

The original accepted city was rerun in Low with the provisional foliage scale 0.8. The native benchmark passes all 13 checks, including original loaded bundle/manifest identity, advancing simulation, entry and 48 metres of driving, unchanged triangle/draw/FPS limits, complete measured GPU ownership and no browser errors. Scene averages range from approximately 123 to 127 FPS; the measured peak is 403,923 triangles / 257 draw calls. This is a short baseline on the RTX 3070 Ti/D3D11, not an expanded-district or long-run result.

The benchmark now records simulation start/end ticks, sampled character/vehicle/police counts and endpoint actor IDs. Civilians and a police unit are present in the baseline simulation throughout the measured scenes. State presence does not imply every actor is visible. The paused native residency harness also records actor counts while retaining its explicit paused-inspection scope. Verification typecheck and syntax checks pass.

Spawn and driving captures from the two latest Low baseline runs were opened; the remaining captures stay unreviewed. The generic benchmark drive ends at the Cathedral steps and does not establish a successful city route. Existing facade blur remains. Evidence: `native-baseline-benchmark-low-foliage-v4/browser.json` and `low-baseline-actor-census-root-review-v1.json`. Final four-district populated moving tests and both 30-minute residency soaks remain pending; no further texture-resolution reduction is applied.

## Current integrated stored-byte census

The d453 structural world contains 4,832 files and 1,263,700,347 bytes (1.264 GB / 1.177 GiB): 2,171 KTX2 files occupy 615,590,935 bytes; 1,566 GLBs occupy 406,303,504 bytes; the remaining 1,095 files occupy 241,805,908 bytes. These count actual stored files once, rather than overlapping material references. Census: `integrated-asset-size-checkpoint-v1.json`.

The latest texture pass saves 16,172,617 gross encoded bytes at unchanged dimensions/mips, with 15,341,879 net world bytes saved after proof overhead. Later physical repairs explain the larger current total relative to the optimized parent. No GPU-memory reduction is attributed to same-resolution RDO. Final lossless simulation compression must run after ground/navigation integration; earlier trial savings cannot be subtracted from this census as though already applied. Nothing from this expansion has been shipped.
