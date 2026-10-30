# Handoff: map expansion, web optimization and publishing

Date: 30 October 2026. This records the completed Hietalahti release and the workflow used to produce it. Further map expansion was stopped at the user's request. Viikki remains deferred.

Later application update: the user requested removal of all invisible geographic traversal boundaries. See [Free traversal without geographic fences](free-traversal-2026-10-30.md). The optimized world described below is unchanged; the application no longer uses the qualified coverage mask as a player movement fence.

## Repositories and source of truth

The working repository and the D: authoring backup served different purposes. The backup is the dated `BackUP_HP-Home_2025-12-14/Apps/Helsinki-rides` copy on D:. It supplied historical documents, authoring inputs and pipeline context. It was kept read-only. A file existing there did not establish that the deployed game used it.

The initial ground truth was GitHub `MattiTynka/Helsinki-rides` and the actual public Pages release. Before changing content, I bound the deployed source commit, release descriptor, manifest, archive and runtime. The previous live source was `03d072e0f549f27de7bc45eb62d16d30ed42517f`, with world `senate-20261025-civilian-flee` and manifest `0e18e55e8730f01144eef72a80decffbb53cdd658222f87a7e8ad6f75f2c4260`.

I compared the two local copies by purpose, content hashes, manifests, source ledgers and dependency references. Authoring masters, downloaded geodata, native city packets, optimized delivery payloads and deployed assets are separate inventories. Similar names or a newer timestamp do not prove equivalence. Missing inputs downloaded with the user's authorization were kept in local data/work areas and bound to their source records.

Implementation ran in the isolated `build/city-expansion-southwest/source` checkout. Generated candidates, caches and evidence lived in sibling `work` and `evidence` directories. A separate clean promotion checkout under `work/release-wrap-promotion-v1/source` held only the selected source ancestry. This preserved unrelated changes/deletions in the owner's original checkout and avoided publishing private data or exploratory artifacts. Git ownership exceptions were command-scoped with `git -c safe.directory=...`; global Git configuration was not changed.

The feature commit is `063b456281c5bc1bc0779184e09806aaceb87c93`; its merge is `cc452800a9ca3327229ad0f61dd75005631a8ba8`. The deployed application source is `3a1528c8df028b6be95f22d26b859b587b7b5db7`, which adds only the final production-verifier correction to that merge. This handoff may be committed afterward without changing those deployed application bytes.

## Geography workflow

Read the current `build-helsinki-game` skill and its project-integration, world-pipeline, web-optimization and verification references. Repository schemas, decisions and accepted release contracts take precedence over starter examples. The skill's optimization route was updated during this work to describe the native web delivery and further-optimization strategies.

1. Bind the deployed baseline and the proposed area. Inventory licensed source inputs, CRS/origin/height datum, road data, native packets, required assets and actual playable coverage before generating a candidate.
2. Use the browser and Google Street View to understand street appearance, directions and recognizable details. Street View is visual reference, not an asset source or authoritative collision/height measurement. Preserve the distinction between a checked view and an unverified assumption. If desktop integration is unavailable, record the gap and do independent local work; do not invent a Street View check.
3. Use the native city preparation and append producers, including `append_delivery_city.ts` and the `delivery-city` libraries. Prepare and optimize new cells separately, then append them to a pinned accepted world. Preserve accepted cells and source masters. Do not rerun an entire-world optimizer incidentally for each new neighborhood.
4. Preserve the recorded coordinate conversion: localized geographic authoring uses metres with east/north/up axes; runtime/glTF uses X east, Y up, Z south. Convert once. Keep visual geometry, terrain, collision, pedestrian support and vehicle graphs distinct. Collider extents can cross their owner cell, so owner-square membership alone cannot establish collision coverage.
5. Admit playable coverage only after terrain, collider continuity, supported-area vertices and road connections qualify. Visual buildings outside the mask are not completed navigation. Use fresh candidates and separate receipts for proposed repairs; never restamp old evidence as a newer producer's output.
6. Inspect Standard and Low in the actual renderer, then traverse admitted seams using real walking and vehicle controls, turn around, return and replay the recording. Fixture drop-ins help inspect assets; they do not prove travel through the expanded area.

This release completes the first Hietalahti area, including the bounded Bulevardi/Hietalahdenranta return loop. Wider South/West visuals are integrated. Eira, Kaivopuisto and Ruoholahti navigation was not admitted as a completed four-district expansion. The parking-junction and Laivasillankatu w282 proposals remain private and unapplied. Resume those or Viikki only after a new scope decision.

See [the expansion plan](city-map-expansion-plan-2026-10-29.md), [progress](city-map-expansion-progress-2026-10-29.md), [the current optimization record](asset-optimization-2026-10-30.md), [the public skill's web optimization guide](https://github.com/MattiTynka/Helsinki-rides/blob/3a1528c8df028b6be95f22d26b859b587b7b5db7/skills/build-helsinki-game/references/web-optimization.md) and [the release scope](release-hietalahti-optimized-2026-10-30.md). The older `docs/model-optimization-2026-10-20.md` was consulted in the D: backup; it is historical context, not a file in this curated public source tree.

## Web asset optimization

Measure the unique reachable manifest closure by category before optimizing. Distinguish encoded transfer/storage, decoded simulation memory and actual GPU allocation. A smaller archive does not establish a lower GPU budget.

- Preserve the native geometry contracts, seams, winding, source positions, material references and LOD error bounds. Use existing Meshopt/native cleanup rather than arbitrary decimation or coordinate quantization.
- Externalize shared encoded textures by content hash. Retain independently owned runtime handles/reference accounting. Build the native Standard/Low pair; where supported, Low uses preserved encoded mip extraction. Validate final dimensions/mips and actual GPU upload, not just KTX2 file structure.
- Same-resolution texture RDO is a quality change. Bind the native source atlas/model/configuration, qualify caches with `qualify_native_atlas_rdo_cache.ts`, and require the source qualification when applying them. Keep cache locators and authoring paths outside the publication world. Check actual material reachability, alpha semantics, gutters and both tiers before accepting a saving.
- Use `recompress_delivery_simulation.ts` for explicitly requested further lossless gzip storage optimization. Compare every decoded terrain/road/HCOL byte, collision ordering and extents. Record compressor versions; preserve the previous representation where recompression offers no saving.
- Revalidate the final complete world with the native independent verifier and browser/runtime tools. Geometry, encoded texture, stored hash and decoded hash proofs are different checks.

| Final measurement | Bytes |
| --- | ---: |
| Complete world: 775 cells, 4,833 files | 1,230,863,991 |
| Validated compressed release archive | 1,055,631,192 |
| Pages shell payload before its release receipt | 14,843,451 |
| Final lossless simulation-payload saving | 33,011,432 |
| Final net world saving, including proof overhead | 32,836,356 |
| Earlier texture RDO gross saving | 16,172,617 |

The final compression derivative preserves all 777 decoded terrain/road/collision payloads exactly against structural parent `d453fdd79db114c914322f0209121c34819206b294004bdcece2739f0f3b4701`. The earlier texture pass keeps dimensions and mip chains; neither same-resolution RDO nor gzip compression is claimed as a GPU-memory saving. Original masters and previous candidates remain available.

## Publishing a world larger than the Pages budget

The solution uses two branches of the same GitHub repository. `main` carries curated source; Pages serves its generated small application shell. `world-assets` carries immutable world payloads in its own asset history. Runtime URLs pin the exact asset commit, never the moving branch name. GitHub Releases provides the validated archive used by CI.

| Release identity | Value |
| --- | --- |
| World release | `helsinki-20261030-hietalahti-optimized-v1` |
| Manifest SHA256 | `4ef949372affa569adc21c1701b1509bd856c3c583245cfbfc71781d626b64b3` |
| Asset commit | `b79144e3de2ed9cf1702a5ddc1ad4fa18a4a47c9` |
| Archive tag | `hietalahti-optimized-20261030` |
| Archive SHA256 | `7726349a6a9119ea7e53830c796f5f70cd91df235c293cd45a3e4ad3b26a6a12` |
| Descriptor SHA256 | `ba7f2de00111e8016fa955b068345fd061ba084a10caca1ef95b4b3c45befaec` |
| Production application JS SHA256 | `5a424190218e02653d327868a5fa87d3cf39387d9f3b5a91299fd75191c30124` |

The committed descriptor is `content/releases/pages.json`. This release uses the bounded `github-raw` external profile. Existing Pages limits were retained; the descriptor separately bounds the shell, archive and external world. Preflight measured the actual Git objects and push pack: largest blob 44,853,454 bytes and push pack 1,050,265,613 bytes. The full 1.231 GB world is therefore not placed inside the Pages artifact, and startup streams the required cells rather than downloading the entire city.

Publication sequence:

1. Curate source with `tools/release/source_release.py`, then audit source, reachable selected history, image metadata, archive members, decompressed metadata and the shell. Keep private caches, logs, home paths, credentials and downloaded authoring data out of the public closure. Use the approved public Git identity.
2. Build the immutable asset repository and archive from the exact validated world. Independently compare all payloads and archive members. Measure the actual push, then publish the asset commit and archive before activating their descriptor.
3. Check every hosted payload with `verify-github-raw-world.py`: HEAD/GET status, bytes/hash, browser CORS behavior, gzip representation and missing-object behavior. Native `.bin.gz`/`.hcol.gz` files must retain their stored-byte contract; an unintended HTTP Content-Encoding would change what the browser receives.
4. Commit the descriptor and source; merge in the clean promotion checkout. Audit the complete selected source ancestry without fetching unrelated asset refs into that audit checkout. Push with an exact expected-head lease to avoid overwriting a concurrent update.
5. Wait for source CI, then dispatch the existing Pages workflow. It loads the descriptor's pinned Vite environment, builds production, downloads and validates the archive, stages the external world separately, rechecks all hosted objects, and uploads only the shell to Pages.
6. Verify the actual public `release-info.json`, original loaded JS, original application manifest Fetch, visible controls, on-demand loading, attribution, cold/warm cache behavior and production review-hook exclusion. Open the captures. A green build or local staging result alone is not a live deployment proof.

Useful commands from the selected source checkout:

```powershell
pnpm typecheck
pnpm test:source
python -m unittest discover -s tools/release/test -p 'test_*.py'
gh workflow run pages.yml --repo MattiTynka/Helsinki-rides --ref main
gh run view 41050449123 --repo MattiTynka/Helsinki-rides
```

For a new release, inspect the current native CLI arguments and use fresh output paths. Let the descriptor validation/workflow supply `VITE_WORLD_BASE_URL`, `VITE_WORLD_RELEASE` and `VITE_WORLD_MANIFEST_SHA256`; an unpinned local Vite build can select a different world. On Windows, use a short staging path when content-addressed filenames exceed MAX_PATH. The successful local staging here used `build/s1`, preserving the failed long-path attempt separately.

## Verification and troubleshooting

Candidate-specific checks include portable source and release tooling, typechecking, independent world/privacy/decoded-payload checks, all 4,833 hosted objects, 13/13 native scenes in each of Low and Standard, a real-controls Hietalahti drive/return with zero recoveries and exact deterministic replay, and a complete 626/626-step walking circuit of approximately 3.144 km. The walking captures were opened. Detailed frame/residency measurements belong to the review-build evidence; ordinary production UI smoke is a separate gate. Two full 30-minute four-district residency soaks were not run after broader expansion was stopped.

One release-checking issue was in Chromium/CDP readback, not the published manifest: reading the preload's text body through CDP re-encoded Finnish UTF-8, producing different bytes. The application's original Fetch body was correct. `tools/verify/lib/original-fetch-response.ts` now observes a bounded clone of that original Response without refetching or normalizing text; existing JS identity remains based on the original script response. Cold and warm production checks use those raw bytes.

On a warm service-worker navigation Chromium reports a parser link preload and the application's Fetch separately. The verifier requires one original application clone and accepts the auxiliary preload only with explicit protocol provenance, matching document/frame/loader and distinct unique roles. It does not choose a response by the expected hash. Duplicate actual fetches, ambiguous evidence and extra responses remain rejected. Fourteen focused tests, typecheck, actual cold/warm replay and independent review passed before this correction was committed.

Final source CI: [41050099795](https://github.com/MattiTynka/Helsinki-rides/actions/runs/41050099795). Application deployment: [41050449123](https://github.com/MattiTynka/Helsinki-rides/actions/runs/41050449123). Public game: [Helsinki rides](https://mattitynka.github.io/Helsinki-rides/).

Deployment `41050449123` completed successfully. The live default URL returned the expected source, asset and manifest tuple. All eight ordinary-production browser checks passed, including original cold/warm Fetch identity, visible controls, on-demand loading, credits, no browser errors and production review-hook exclusion. Both live captures were opened.

Private evidence remains under `build/city-expansion-southwest/evidence`, with producers/candidates under the sibling `work` directory. The final `SHIP-REPORT-20261030.json` binds the source, asset, archive, world, CI/deployment and live proofs. Failed setup/diagnostic attempts were retained separately; their receipts were not rewritten into passes.

## Rollback and continuation

The previous live descriptor and source/world tuple were preserved in `release-wrap-rollback-v1`. If rollback is required, restore that exact descriptor in a new reviewed source commit and redeploy through the existing Pages mode. Keep both immutable archives and asset commits available. Do not force-rewrite published source or asset history.

For later expansion, start by reading the current deployed receipt and this handoff, then bind a new baseline. Reuse verified producers and unchanged contracts, but qualify the new geography and its final asset/runtime pair independently. Keep the D: backup read-only, preserve the owner's worktree, use fresh outputs, retain Standard/Low delivery and real-controls return journeys, and maintain the explicit boundary between completed playable coverage and deferred proposals.
