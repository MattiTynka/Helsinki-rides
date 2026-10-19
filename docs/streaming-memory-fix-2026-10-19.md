# Travel and memory retention

The browser beta reported severe lag after extended travel. The investigation
checked actual visual eviction, decoded assets, actor lifetimes and production
diagnostic recording against the pinned 304-cell Pages world.

## Findings and changes

Visual distance eviction was already active. A three-circuit baseline across
seven districts retired 1,126 cell views. Returns to Senate Square settled at
178 renderer geometries and 126 textures, with retained JavaScript heap around
56–58 MiB. This did not reproduce an accumulating city-cell cache.

The investigation did find resource-lifetime problems:

- Obsolete requests continued downloading and decoding before their stale
  results were discarded. Requests now receive an AbortSignal when their cell
  leaves the selected area. Downloads abort immediately. Decoding that has
  already started retains its concurrency slot until completion, and its
  result is disposed without mounting. Cancellation does not become a failed
  load or trigger a retry. Each tier still has at most two physical loads.
- Retired vehicles detached from the scene but did not dispose their private
  lamp-material clones or shadow geometry. Retired characters did not dispose
  their cloned skeleton palette textures or shadow geometry. Both now release
  those owned resources exactly once and unbind character mixer state. Shared
  source geometry, materials, textures and the shared shadow material remain
  available to other actors.
- The ordinary build retained every encoded input command indefinitely.
  Replay command/event/digest history is now a build capability enabled only
  for review builds and the development server. Ordinary play retains no such
  history, including with a review query parameter. Command quantization and
  current-frame gameplay/audio events are unchanged.
- Cell disposal now closes each unique owned ImageBitmap after disposing its
  texture. The current city's affected PNG strips are tiny; this is complete
  cleanup rather than an explanation of the reported severe lag.

The existing distance rings and hard limits remain: standard uses up to 28
detailed cells and 42 coarse cells; LOW uses up to 16 and 28. Texture caps remain
320/160 MiB, with separate geometry caps. Cell resources are evicted before new
ones are admitted. Cell-owned scenery instance buffers follow visual residency.
The complete deterministic collision/terrain world remains resident, preserving
support, vehicle contacts and replay ordering.

## Verification

All 589 portable source tests pass. Ownership regressions exercise 40 repeated
actor spawn/despawn cycles with no remaining owned allocations. Cancellation
tests cover fetch/body abort, late decoding, leaving and returning to one cell,
retry/disposal, physical concurrency and shared image ownership. Recording tests
cover long ordinary input sequences and exact review command preservation.

The native failed-request fixture passes all ten checks: deliberately missing
cells block traversal with a loading message, retries restore coverage, and old
destination requests are cancelled. The test retained complete nearby coverage
and stayed inside the 320 MiB standard texture cap.

`tools/verify/verify-streaming-residency.mjs` adds repeated labelled routes,
quiet return-to-start measurements, forced-GC heap samples, renderer allocation
counts and native texture/geometry budgets. Its fixture routes are not claimed
as continuous driving evidence. Source/runtime/manifest hashes, browser details,
actual duration, network events and frame timing are recorded in each report.
Gameplay journeys and ordinary public-site checks are separate gates.

Local evidence is kept under ignored `build/release-audit/`. Existing baseline
captures and reports remain separate from the corrected candidate. Changes are
application-only: the published world archive, terrain, collision and all model
and animation payloads retain their existing hashes.

## Publication

The corrected source is mirrored into the audited release checkout and deployed
through the manual Pages workflow using the existing pinned world archive.
Ordinary production checks must confirm the deployed source identity and the
absence of review capabilities. An already open game continues running its old
JavaScript until it is reloaded.
