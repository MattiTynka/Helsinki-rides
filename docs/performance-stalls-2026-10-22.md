# Gameplay frame-stall correction

This source-only update follows deployed source `db3db601`. It retains the
`senate-20261022-civilian-response` world and its exact manifest
`0bbed03c2ca550c2f957e3d4184af856369b4f06051449acb36534bca37ea337`.
No model, texture, district, civilian count or rendering resolution was reduced.

## Investigation

The previous residency soak paused simulation. It established resource eviction,
but could not establish smooth active gameplay. This investigation adds active
browser frame sampling and CPU profiles, including a deliberately CPU-constrained
run, plus a fixed-command native-world simulation benchmark.

Three concrete costs stood out:

- Collision residency and prefetch repeatedly computed distances between all
  city cells and every actor, including obviously distant pairs.
- Every render frame rescanned building extents for visual selection and again
  for diagnostic snapshots used only to display loading errors.
- Police routing exhausted the reachable road graph after finding a nearby
  destination. Failed patrol and response routes could also bypass retry timers
  and repeat expensive searches every simulation tick.

The civilian manager is bounded at eight civilians. Its added character physics
and animation have a real cost, but the measurements did not show an unbounded
civilian population or spawn search.

## Changes

Collision selection now rejects distant pairs with conservative axis bounds.
Existing resident cells stop checking once retention is established. Exact
Euclidean distances, insertion priorities, ordering and unequal-ring behavior
are retained where they matter. Collision coverage and waiting for missing
ground are unchanged.

Visual streams compute immutable building extents once. A conservative movement
corridor excludes distant cells before detailed ranking. The loading HUD reads
the error state directly instead of requesting full diagnostic snapshots.
Invisible characters skip posed-bound preparation; the current pose and bounds
are prepared before their next visible frame.

Road routing uses a stable priority queue and stops once remaining candidates
cannot improve the known shortest path. Equal-cost ordering remains stable.
Unreachable police destinations respect a two-second retry delay. A completed
patrol or materially moved response destination still plans promptly. Pending
requests and retry timing are included in deterministic state hashes.

## Verification and measurements

Route comparisons include 4,800 generated cases and 158 native-city routes.
Collision and visual-selection tests compare exact results with the preceding
algorithms, including boundaries, ties, unequal rings, moving lookahead,
building ownership and budget pressure. An independent reviewer compared
another 10,000 collision-residency plans without a mismatch.

Residency checks distinguish logical texture objects from shared GPU allocations.
Concurrent KTX2 loads can share storage while sequential loads create separate
storage for identical pixels. The review adapter accounts for current material
maps, bone palettes and compiled material texture uniforms. Quiet endpoints
require every renderer texture to be owned, its storage to be measured, logical
resource counts to remain bounded, and GPU bytes to stay within the existing
preset budget. Raw allocation counts remain in the evidence.

On the development machine, a batch of 158 mixed native routes fell from
896 ms to 131 ms. In a 900-tick stationary Senate simulation with all eight
civilians retained, median tick CPU time fell from 1.89 ms to 1.15 ms and p95
from 3.21 ms to 1.46 ms. These are Node CPU measurements, not browser FPS promises.

A matched 1920-by-1080 standard-preset browser stress run used Chromium CPU
throttling at 4x, with dynamic resolution disabled and the full world retained.
Across 20 seconds standing, 25 seconds holding run, and 15 seconds stopped,
frames longer than 100 ms fell from 80 to 7. Median running-frame interval fell
from 76.5 ms to 41.6 ms, and p95 from 132.0 ms to 76.8 ms. Standing p95 fell
from 111.2 ms to 55.7 ms. CPU-profile start/stop overhead is excluded from these
frame samples. This is a synthetic CPU stress comparison, not a promise of a
particular frame rate on every device or a continuous cross-city driving test.

The original benchmark's pre-edit timing record did not retain a final state
hash. Exact algorithm comparisons and a fresh browser-to-Node command replay
provide separate behavior checks; no before/after hash equivalence is inferred
from timing measurements.

## Further work to measure separately

The next candidates are worker-based Meshopt decoding during district changes,
physics sleeping for genuinely stationary unoccupied cars, and lower animation
update frequency for distant characters. Each needs independent behavior and
frame-time evidence. Four persistent non-shadow muzzle lights also warrant a
GPU comparison on weaker hardware before changing their implementation; their
cost must not be inferred from CPU profiles alone.

The map continues to use the web asset policy in
[the web delivery handoff](handoff-2026-10-20-web-delivery.md): shared compressed
textures, retained reduced-resolution tiers, bounded streaming and verified
release payloads. This update reuses that packet without repacking it.
