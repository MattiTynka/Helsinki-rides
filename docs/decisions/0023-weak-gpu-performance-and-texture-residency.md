# Weak-GPU performance and texture residency

Date: 23 October 2026. Builds on
[decision 0022](0022-web-delivery-collision-streaming-and-texture-tier.md) and the
[mobile pass](../mobile-2026-10-22.md). How-to and overrides:
[weak-GPU performance note](../performance-weak-gpu-2026-10-23.md).

## Problem

Players on laptops with integrated graphics saw "10 fps" and a city that never got
faster. Three causes, measured on SwiftShader (the software renderer used as a
weak-GPU proxy) at 1280×720 with the live review shell:

1. The frame interval was clamped to 100 ms before it reached the HUD and the
   resolution governor. Anything slower read as 10 fps, and the governor never saw
   the real load.
2. The automatic preset looked only at memory and core counts. An 8-core, 16 GB laptop
   with an Intel iGPU got Standard, which ran at 451 ms (Senate Square) against 146 ms
   on Low.
3. Once the render scale reached its floor, nothing reduced detail further, and every
   visit retried the same settings.

The published world is 942,884,046 bytes against a 960,000,000-byte staging ceiling.
Every lossless reduction has already been made, so this pass reduces GPU residency
and rendering cost, not the download. The download options are listed at the end for
the owner.

## Decision

- **GPU-aware automatic preset** (`apps/game/src/device.ts`, `config.ts`). The WebGL
  renderer string is classified. Integrated Intel and AMD, software and phone GPUs
  select Low. Intel Arc counts as discrete only with a discrete model name: A3xx,
  A5xx or A7xx (with or without M), B5xx or B7xx, or Arc Pro. Bare "Arc(TM) Graphics"
  and 1xxV/1xxT parts are integrated Meteor Lake, Lunar Lake and Arrow Lake GPUs.
  URL and saved presets still win. Review builds keep Standard unless `?preset=auto`.
- **True frame timing.** The HUD and both governors use the measured interval, with a
  1 s stall limit. Catch-up is limited to three ticks after a CPU-bound frame.
- **Cheaper Low preset.**
  - KTX2 transcodes to 4 bpp S3TC or ETC2 instead of 8 bpp BC7 or ASTC when available.
  - City materials become Lambert copies, and the sources are never mutated.
  - The pixel cap is 1600×900 and the resolution floor is 50 % (60 % on phones).
- **Detail tiers without reload.**
  - The tiers are Standard, Low and Minimal (`render/quality-tiers.ts`).
  - A pure `QualityGovernor` (`render/quality-governor.ts`) lowers the tier one step
    after 3 s of GPU-bound slow frames rendered at the resolution floor.
  - It counts only the latest 3 s, and only a frame that itself qualifies can demote.
    The floor state comes from the frame as it was rendered, read before the
    resolution governor changes the scale.
  - A 60 s cooldown follows each change. Promotion needs a minute of fast frames at
    full scale and never goes above the preset.
  - A tier change narrows both visual streams, shortens fog and the far plane,
    rebuilds scenery with the tier's batching and foliage distances, and changes the
    car detail range.
- **Remembered tier.**
  - An automatic production session writes a demotion that held for a minute to
    `helsinki-rides:auto-tier`, and starts the next visit there.
  - When such a session recovers to its preset tier it writes `low`. A session that
    started from the estimate clears the key instead.
  - URL and saved presets and review builds never read or write the key. A graphics
    choice removes it.
- **Runtime top-mip drop on Minimal** (`packages/world-schema/src/ktx2-mips.ts`,
  `world/owned-ktx2-loader.ts`).
  - `dropTopMips` strips the largest levels of a single-image Zstandard KTX2 file. Its
    output is byte-identical to the asset tool's `dropTopMip`. It is browser-safe and
    bounds-checks every offset.
  - `OwnedKtx2Loader.setMipDrop(1)` applies it to textures loaded from then on, when
    the result stays at least 64 px. BasisLZ textures, images and other layouts pass
    through silently.
  - The stripped buffer is memoised per fetched buffer, so the vendor task cache still
    performs one transcode per buffer and keeps one shared source.
  - `?mipdrop=0|1` pins the drop for measurement.
- **Measurement.**
  - `tools/verify/probe-weak-gpu.mjs` runs a fixed and an adaptive scenario.
  - The review API reports `config()`, `transcode()`, `textureFormats()`,
    `textureMemory().byClass`, `cityMaterials()` and `residentCells()`.

Nothing in the simulation package, recordings, the world archive, the manifest schema
or the stager changed.

## Measurements

The candidate is a review shell built from this tree. The evidence comes from three
sessions on the same machine, and every base number below names its session:

- **First session, existing review shell, residency unproven** (`c-*`). The base is
  the existing review shell `build/mobile-20261022/review`. It has no
  `residentCells()`, so its comparisons fall back to rendered cells.
- **Second session, instrumented baseline, residency proven** (`c4-*`). The base is
  HEAD `0248e34` exported with `git archive` outside the working tree and installed
  offline. Only `residentIds()` and `residentCells()` were added to it. Its bundle
  contains `residentCells` and neither `helsinki-rides:auto-tier` nor `mipDropped`.
- **Third session, instrumented baseline, residency proven** (`c5-*`). The same two
  shells were served unchanged, with nothing rebuilt: SwiftShader, Low only, four
  alternating runs (base, candidate, base, candidate). No build, test, Codex job,
  other Chromium or full Defender scan was running, and 5,246 of 16,174 MB were free.

All sessions served release `senate-20261022-mobile-safe-v3` on loopback, with one
Chromium at a time, a 1280×720 viewport and `dynres=0` unless noted.

### Residency

The first session's "resident sets identical (renderedCells)" lines compared rendered
cells only. The second session's comparisons supersede them. The first session's
timings and texture totals stay valid as measurements.

The second and third sessions compare complete `residentCells()` sets on both sides
(`residencyProven: true`):

- **Second session, SwiftShader.** Six rows (Standard and Low at Senate Square, Kluuvi
  and Esplanadi), all six identical.
- **Second session, d3d11.** Six rows, five identical, and six on the rerun, again five
  identical. In both pairs the differing row is Standard at Senate Square, the first
  spot after startup. There, fallback ids at the 42-cell cap differ:
  - first pair: `c_m03_m03`, `c_m04_m01` and `c_m04_p01` against `c_p01_p03`,
    `c_p03_m01` and `c_p03_p00`;
  - rerun: `c_m04_m01` and `c_m04_p01` against `c_p01_p03` and `c_p03_p00`.

  Texture memory in that row is 110.46 MiB on both sides of both pairs. The two base
  runs also differ from each other there, by one cell each way. The two candidate runs
  are identical in all six rows.
- **Third session, SwiftShader Low.** Six rows, five identical. Senate Square in the
  first pair differs by one fallback cell each way (`c_m03_m02` against `c_p02_m02`)
  at Low's 28-cell cap. The two base runs differ from each other by that same cell. The
  two candidate runs are identical at all three spots.

### Frame interval

SwiftShader, Low, median presented frame interval, Senate Square / Kluuvi / Esplanadi.
Each change is against the base of the same session or run pair. None of these runs was
paced, so the older probe's rAF intervals are presentation intervals (see Probe frame
counting below):

| Session | Base | Candidate | Change |
| --- | --- | --- | --- |
| First session, existing review shell, residency unproven | 138.9 / 152.7 / 277.9 ms | 104.2 / 111.0 / 194.6 ms | −25.0 / −27.3 / −30.0 % |
| Second session, instrumented baseline, residency proven | 187.5 / 187.5 / 347.3 ms | 118.1 / 121.8 / 215.4 ms | −37 / −35 / −38 % |
| Third session, pair 1, instrumented baseline, residency proven | 180.6 / 173.7 / 305.6 ms | 111.2 / 118.0 / 208.4 ms | −38.4 / −32.1 / −31.8 % |
| Third session, pair 2, instrumented baseline, residency proven | 159.7 / 159.8 / 305.5 ms | 111.1 / 118.0 / 229.2 ms | −30.4 / −26.2 / −25.0 % |

- **Literal AC-10 ceilings.** The ceilings are Senate ≤ 109.5 ms and Esplanadi
  ≤ 213.75 ms, 25 % below the pre-pass 146 / 285 ms
  (`logs/base-swiftshader-fixed.txt`: 145.8 / 145.8 / 285.1 ms).
  - Only the first session meets both.
  - The second session misses both (118.1 and 215.4 ms).
  - In the third session's pair 1, Senate misses (111.2 ms) and Esplanadi meets
    (208.4 ms).
  - In the third session's pair 2, both miss (111.1 and 229.2 ms).
- **The measured effect is the matched improvement.** Across the 12 Low rows of the
  three sessions, the candidate's median is 24.98 % to 38.4 % below its own base. Two
  rows are −24.98 % before rounding: Senate in the first session and Esplanadi in the
  third session's pair 2.
- **Base timings move more than candidate timings.** Instrumented-baseline medians span
  159.7–187.5 ms at Senate and 305.5–347.3 ms at Esplanadi across the second and third
  sessions. The candidate spans 111.1–118.1 ms and 208.4–229.2 ms.
- **Standard on SwiftShader.**
  - First session, existing review shell, residency unproven: 437.6 / 347.5 / 486.2 ms
    on the base and 430.7 / 347.2 / 486.1 ms on the candidate. Texture totals and
    upload-format histograms are identical.
  - Second session, instrumented baseline, residency proven: 507.1 / 409.8 / 574.5 ms
    on the base and 479.3 / 388.9 / 564 ms on the candidate (−5.5 / −5.1 / −1.8 %).
- **d3d11 (RTX 3070 Ti).** Every d3d11 fixed run of the first and second sessions has a
  median of 6.9 or 7.0 ms, with no console errors.

### Texture memory

Texture memory on Low (`textureMemory().mib`), Senate / Kluuvi / Esplanadi:

| Backend and session | Base | Candidate | Change | Compressed formats, base → candidate |
| --- | --- | --- | --- | --- |
| d3d11, second session, instrumented baseline, residency proven | 73.08 / 66.50 / 61.04 MiB | 44.36 / 40.81 / 37.01 MiB | −39.3 / −38.6 / −39.4 % | BC7 → DXT1 + DXT5 only |
| SwiftShader, second session, instrumented baseline, residency proven | 53.99 / 48.52 / 45.45 MiB | 44.36 / 40.81 / 37.01 MiB | −17.8 / −15.9 / −18.6 % | ASTC + ETC2 → ETC2 RGB8 + RGBA8 only |
| SwiftShader, first session, existing review shell, residency unproven | 53.99 / 49.08 / 45.45 MiB | 44.36 / 40.81 / 37.01 MiB | −17.8 / −16.9 / −18.6 % | as above |

- **Candidate totals** are the same in every fixed run without `?mipdrop`, in every
  session and on both backends. The d3d11 base totals are the same in the first and
  second sessions.
- **SwiftShader base totals vary at Kluuvi.** On Low, Kluuvi reads 49.08 MiB in the
  first session, 48.52 MiB in the second, and 48.52 and 49.08 MiB in the third
  session's two base runs. On Standard, Kluuvi reads 97.81 MiB in the first session
  against 96.69 MiB in the second, and Esplanadi 103.34 against 103.90 MiB.
  - Residency equality across the first and second sessions is unknown, because the
    first session captured no resident sets.
  - Within the second session, base and candidate resident sets are proven identical at
    those spots.
  - In the third session the two base runs hold identical Kluuvi resident sets but
    report 48.52 and 49.08 MiB, so this variance is not a residency difference. Its
    cause was not investigated.
- **The third session's first base run** matches the second session's base cell for
  cell at all three Low spots, with the same totals.
- **Standard texture memory, candidate against base.** d3d11 is identical in both
  sessions (110.46 / 121.49 / 131.24 MiB). SwiftShader is identical in the first
  session and changes by 0 / +1.2 / −0.5 % in the second.
- **Transcode support sets:**
  - d3d11 offers BC7 and DXT; BC7 is turned off on Low.
  - SwiftShader offers ASTC, BC7, ETC1/2 and DXT; ASTC and BC7 are turned off on Low.

### Mip drop and governors

Mip drop: d3d11, Low, Senate Square, first session, with the candidate shell on both
sides, without and with `?mipdrop=1`. `residentCells()` is identical on both sides (14
detail and 28 fallback cells), so residency is proven.

| | Without | With | Ratio |
| --- | ---: | ---: | ---: |
| zstd | 17.26 MiB | 4.32 MiB | 25.0 % |
| basislz | 19.09 MiB | 19.09 MiB | unchanged |
| image | 8.01 MiB | 8.01 MiB | unchanged |
| total | 44.36 MiB | 31.41 MiB | −29.2 % |

Detail-tier governor:

- **SwiftShader, `preset=standard&dynres=1`, Senate.**
  - First session: the render scale steps 1 → 0.8 (3.8 s) → 0.6 (6.7 s) → 0.5 (9.9 s).
    The tier drops to Low at 15.0 s, after 5.1 s at the floor (13 presented frames). No
    cells were missing afterwards.
  - Second session, with the floor read from `config().resolutionFloor` (0.5): the
    floor is reached at 9.2 s, and Low follows at 12.5 s after 3.3 s contiguously at
    the floor.
- **Low at Esplanadi** (slice B, before the floor timing fix,
  `governor-swiftshader-low-esplanadi.json`) reaches Minimal in 11.6 s. Detail cells go
  from 11 to 9 and fallback cells from 27 to 20, with no missing cells.
- **d3d11, Standard with `dynres=1`, second session.** Over 40 s at each of three spots
  the scale stayed at 1 and the tier at Standard, with no console errors. The floor
  (0.5) was never reached (`floorReachedAtSeconds: null`).
- **Production shell, SwiftShader** (slice B, `governor-swiftshader-remember-2.json`).
  - The automatic session demoted to Minimal and wrote it 59.3 s later.
  - The next visit started at Minimal and showed "Automatic (Low recommended by your
    last visit)".
  - Picking Low cleared the key.
- **`verify-mobile.mjs` on the locally built production shell**
  (`logs/c-verify-mobile.txt`): PASS, 150 frames, median 34.2 ms.

### Probe frame counting

This repair followed the adversarial review (finding WG-PROBE-PACED-FRAMES-01) and
final review cycle 3 (WG-PROBE-LEGACY-PACING-01, WG-PROBE-PRESENTATION-API-01 and
WG-PROBE-CLEANUP-01).

- **Before.** The fixed scenario's `frames`, `rafMedianMs` and `rafP90Ms` came from every
  requestAnimationFrame callback. The game draws only when its `FramePacer` allows, and
  with `?fps=30|60` or `?mobile=1` it skips ticks. A paced run therefore reported the
  display's tick cadence as the frame interval, and more frames than the game drew.
- **Now.** The probe reads `presentation().frameTime`, the time of the game's last
  `Game.frame()` call, on every tick. A tick at which it changed is a presentation.
  - `presentedFrames`, `presentationMedianMs` and `presentationP90Ms` are the intervals
    between those times.
  - The raw cadence stays as `rafTicks`, `rafTickMedianMs` and `rafTickP90Ms`.
  - `--compare` names the measure of each side. Presentation-based results compare
    whatever their pacing.
  - An older rAF-tick result compares only when its run was not paced. That is decided
    from the run's measured URL (`runs[i].url`, written after the probe applied `--url`
    and then `--query`, last value winning) by the game's own rule: paced when `fps` is
    exactly 30 or 60, or `mobile=1`. It is never decided from `--query` alone, because
    `--url` can carry pacing too.
  - A side without a finite positive median (for example a window with fewer than two
    presentations) is reported as an insufficient measurement and not comparable, with
    a null change.
  - An older paced run, or one without a readable URL, is reported as not comparable,
    with a null change.
- **Failures.**
  - A shell whose review API has no `presentation()` with a numeric `frameTime` fails
    the run at once, before settling. An exception during sampling fails it as well,
    instead of leaving the page evaluation pending.
  - Every failure after Chromium launches closes the browser. The run then records
    `result.failed`, writes `result.json` and exits 1.
- **The recorded sessions are unaffected.** Every `c-`, `c4-` and `c5-` fixed run measured
  a review shell whose URL carries no `fps` or `mobile` parameter. There the frame rate
  is unset, the pacer interval is 0 and every tick presents, so their rAF intervals are
  presentation intervals. Compared against a new result, all 16 of those files classify
  as "rAF ticks of an uncapped run, each tick a presentation"
  (`logs/c7-historical-measures.txt`).
- **Self-check on the frozen candidate shell.** This is a probe self-check, not an AC-10
  timing session: d3d11, Low, Senate Square, 10 s, `c6-*`.
  - Paced (`mobile=1&fps=30`): 300 presentations, median 32.3 ms, p90 39.0 ms. The same
    window had 1,269 rAF ticks at a median of 8.0 ms, which the older probe would have
    reported as 1,269 frames at 8.0 ms.
  - Uncapped: 1,269 presentations and 1,269 rAF ticks, both with median 8.1 ms and p90
    8.2 ms. Against `c4-d3d11-fixed-candidate` the comparison reads 6.9 ms (older
    probe, rAF ticks of an uncapped run) → 8.1 ms (presentations).
- **Repair checks** (`c7-*`, on the same frozen shell, d3d11, Low, Senate Square):
  - 5 s uncapped against the c6 uncapped run: 625 presentations and 625 rAF ticks,
    median 8.1 ms and p90 8.2 ms. The comparison reads "presentation median 8.1 -> 8.1 ms
    (0 %)", with identical resident sets.
  - Chromium processes: 0 before the run, up to 9 during it and 0 after.
  - Two negative runs, against a closed port (5399, connection refused) and an unsafe
    port (1), both exit 1 with `result.failed` set ("page.goto:
    net::ERR_CONNECTION_REFUSED" and "net::ERR_UNSAFE_PORT"), with 0 Chromium processes
    before and after.
- **Tick cadence.** It was 8.0–8.1 ms in this check, against 6.9–7.0 ms in the first and
  second sessions. In one page, reading `presentation()` on every tick did not change it:
  1,274, 1,258 and 1,268 ticks at medians of 8.0, 8.1 and 8.1 ms, without, with and
  again without the read (`logs/c6-tick-overhead.txt`). The cause of the slower cadence
  was not investigated.

Evidence: `build/perf-20261023/` in the source-release export:

- `c-*` (first session), `c4-*` (second session) and `c5-*` (third session)
  directories, with `logs/c-*.txt`, `logs/c4-*.txt` and `logs/c5-*.txt`;
- the probe self-check `c6-d3d11-fixed-paced`, `c6-d3d11-fixed-uncapped` and
  `logs/c6-*.txt`, and the repair checks `c7-*` with `logs/c7-*.txt`;
- the cross-run checks `logs/c4-d3d11-base-vs-base.txt`,
  `logs/c4-d3d11-candidate-vs-candidate.txt`,
  `logs/c5-swiftshader-base-2-vs-base-1.txt`,
  `logs/c5-swiftshader-candidate-2-vs-candidate-1.txt`,
  `logs/c5-swiftshader-base-1-vs-c4-base.txt` and
  `logs/c5-swiftshader-candidate-1-vs-c4-candidate.txt`;
- the pre-pass measurement `logs/base-swiftshader-fixed.txt`, and `governor-*.json`
  for slice B.

## Residual risks

- No physical integrated-GPU laptop or phone was measured. SwiftShader is a proxy that
  renders on the CPU, so its balance of fill, shading and draw cost differs from a real
  weak GPU. The governor thresholds and the Minimal tier are untested on
  Intel/AMD iGPUs, Mali, Adreno and Apple GPUs (backlog item 33).
- Browsers can mask or generalise the renderer string. Those devices fall back to the
  memory and core rules, and then to the governor.
- Low's 4 bpp transcode visibly softens facades at close range. Standard keeps BC7 and
  ASTC.
- The mip drop affects only textures loaded after the tier change. Resident ones keep
  their top level until eviction (backlog item 34).
- The new tests ran on Node 24 here. Node 22 parity is left to CI and was not checked
  locally.
- At a fallback stream's cell cap, the cells at the edge vary between runs of the same
  shell: Standard's 42-cell cap at Senate on d3d11 (second session) and Low's 28-cell
  cap at Senate on SwiftShader (third session), both seen between two baseline runs.
  A strict cell-for-cell match there is not reproducible.
- SwiftShader timings vary between sessions and runs. The literal AC-10 ceilings were
  met in the first session only; the second and third sessions miss Senate's 109.5 ms
  by 1.6 to 8.6 ms. The matched improvement against the same session's base holds in
  every session.

## Owner options for the download size

None of these were performed. Each one changes published bytes and needs an owner
decision.

1. **ETC1S re-encode of the UASTC facades.** The shared textures are 367 MiB of UASTC
   at about 3.6 bpp (measured). ETC1S lands around 1–1.3 bpp, so the archive drops by
   roughly 2.5–3×. It is lossy and visibly blockier on facade detail. It needs a
   facade capture review at fixed cameras, as decisions 0003 and 0005 did. The runtime
   mip drop does not apply to ETC1S (BasisLZ levels are not independent).
2. **Serve the M1 copies as the Standard tier.** Dropping the full-resolution
   originals saves about 267 MiB, leaving the 100 MiB half-resolution copies. Standard
   would then look like Low's textures with Standard's geometry and materials. It is
   lossless per level, but loses the sharpest level everywhere.
3. **A quarter-resolution asset tier (M2)**, only after one of the above frees at least
   26 MB. Its 534 payloads (25,915,397 bytes) would take any derivative of the pinned
   world to at least 968,799,443 bytes, over both the builder's 950,000,000 and the
   stager's 960,000,000 limits. It also needs composable provenance:
   - the M1→M2 derivation must record its own receipt identity in
     `publication/texture-tier.json` instead of colliding with the M1 receipt;
   - an integration test must derive, stage and verify both tiers together.
4. **Terrain chunking.** Terrain is 15 MiB today. Chunked fetches need an authoritative
   query and residency contract for distant spawn checks and police and recovery
   anchors before they can replace the global grid (see the mobile pass).
