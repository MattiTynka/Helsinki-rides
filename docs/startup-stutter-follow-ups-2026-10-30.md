# Startup stutter: follow-ups (2026-10-30)

The startup stutter fix (plan: `docs/startup-stutter-plan-2026-10-30.md`) was play-tested by the owner on 2026-10-30 with no stutters at the start. The work stopped before these points; they are ideas for a later pass, none affects play today.

## 1. Unit tests the plan asks for

None of the new game code has its own tests yet. Add:

- **Warm-up (`render/assets.ts`, `render/warmup.ts`):** an asset is not reported present while its `prepare` is pending; a rejected `prepare` leaves it absent and retryable; a car and its `-far-low` variant arriving in either order, a far-low failure, and load concurrency 1 and 2 never publish unprepared or disposed far geometry.
- **Deferred models (`game.ts loadDeferredAssets`):** a failed first load still enables Play; a later retry succeeds and recomputes texture accounting; overlapping callers share one attempt.
- **Audio (`audio/audio.ts`):** `start()` after `prepare()` resumes the existing context instead of creating a second one; a failed `prepare()` falls back to creating it on the click.
- **Skin cache (`render/skinned-culling.ts`):** an independent clone reuses the cached analysis, and culling results equal the uncached ones.
- **Police lane cache (`packages/sim/src/police.ts`):** cached lane membership equals the uncached search.

## 2. Police lane cache assumes the road network never changes

`connectedLaneIds` caches lane reachability per `RoadIndex` (WeakMap). Nothing in the game changes a road index after it is built, so this is safe today. If roads ever change at runtime (expansion, closures), the cache returns stale lanes: drop it for that index, or rebuild the index instead of mutating it. A guard or a test for this belongs with item 1.

## 3. First-visit audio is still built during the Play press

`prepare()` builds the audio graph at boot only when the browser already allows audio (an earlier interaction). On a first visit it waits for the first press, so the roughly 90 ms construction still lands in the Play press. This was chosen to avoid the browser's autoplay console warning. Alternative: create the context suspended at boot regardless, and fall back to lazy creation if that fails; check that no console error appears without the autoplay override.

## Also open

- Harness runs the plan lists (AC-2 matrix, model wait, max frame interval, budgets) were not run on the final code.
- The stored replay recording `evidence/release-wrap-hieta-drive-low-v1` predates commit 6d49a13 and no longer matches (hash d8b397ba on current code); re-record it.
- Two map-data tests (Kopernik, plaza-road append) failed before this work and still fail.

Details: run dossier `.git/opus-opus-sol/20261030T130444Z-.../release.md` and final review `reviews/07-final-review.md`.
