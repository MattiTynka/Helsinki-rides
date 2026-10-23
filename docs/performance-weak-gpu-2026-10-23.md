# Weak GPUs: tiers, the governor and how to measure

Date: 23 October 2026. Decision:
[0023 weak-GPU performance and texture residency](decisions/0023-weak-gpu-performance-and-texture-residency.md).

Integrated, software and phone GPUs used to get the Standard preset and a HUD that
could not report below 10 fps. The game now picks Low on those GPUs, measures real
frame intervals, lowers the render resolution and then the detail tier while frames
stay GPU-bound, and remembers a lowered tier for the next visit. This note explains
how that behaves, how to override it and how to measure it.

## Presets and detail tiers

The preset (Standard or Low) is fixed for a page load. It decides the cell LOD level,
the texture tier (Low requests the half-resolution `sharedTexturesM1` copies), the
transcode targets and MSAA. On top of it runs a detail tier that can change without a
reload:

| Tier | Detail stream | Fallback stream | Fog / far plane | City materials | Foliage distances | Texture mip drop | Pixel cap |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Standard | 230 m, 28 cells, 160 MiB | 420 m, 42 cells, 96 MiB | 240–420 m | MeshStandard | 1× | none | 2560×1440 |
| Low | 170 m, 16 cells, 96 MiB | 300 m, 28 cells, 64 MiB | 160–300 m | Lambert, batched scenery | 1× | none | 1600×900 |
| Minimal | 110 m, 10 cells, 64 MiB | 220 m, 20 cells, 48 MiB | 110–220 m | Lambert, batched scenery | 0.6× | largest Zstandard level | 1600×900 |

Touch-first devices on the Low tier keep their smaller mobile ranges (140 m / 240 m),
and every mobile tier renders at most 1280×720. The table lives in
`apps/game/src/render/quality-tiers.ts`.

On the Low preset the KTX2 transcoder targets 4 bpp formats (S3TC DXT1/DXT5 or ETC2)
instead of BC7 or ASTC (8 bpp) whenever the GPU supports one of them. On the Minimal
tier, Zstandard-supercompressed KTX2 textures loaded from then on skip their largest
mip level (`OwnedKtx2Loader.setMipDrop`): the remaining levels are the stored bytes,
nothing is re-encoded, and textures whose result would be under 64 px, BasisLZ
textures and PNG images are left alone. Textures already resident keep their levels
until their cell is evicted.

## Automatic choice

With no `?preset=` and no saved choice, the game classifies the WebGL renderer string
(`apps/game/src/device.ts`): integrated Intel (HD, UHD, Iris, and Arc parts without a
discrete model number such as "Arc(TM) Graphics" or 140V/140T), AMD APUs, software
renderers (SwiftShader, llvmpipe, Microsoft Basic Render, Mesa software) and phone GPUs
select Low. Discrete GPUs (including Intel Arc A3xx/A5xx/A7xx, B5xx/B7xx and Arc Pro)
and unknown strings keep the memory and core rules. Touch-first devices always select
Low.

## The governors

Two governors run on rendered frames that are not paused, stalled, loading cells or
hidden:

- **Resolution.** Frames are GPU-bound and slow when the interval is more than 1.32×
  the target (16.7 ms, or 33.3 ms with 30 FPS pacing) while the CPU part stays under
  60 % of it. After 1.5 s of such frames the render scale drops by 0.15 (0.2 at twice
  the target) down to a floor of 50 % on desktops and 60 % on phones. Four seconds of
  fast frames raise it by 0.1, but not within 20 s of a reduction.
- **Detail tier.** Once the scale has rendered at its floor for 3 s of GPU-bound slow
  frames, the tier drops one step (Standard → Low → Minimal), and the HUD shows
  "Lowering graphics detail for smoother play". Only the most recent 3 s count, and the
  frame that triggers the change must itself be GPU-bound, slow and rendered at the
  floor. After any change there is a 60 s cooldown on further demotion. A minute of
  fast frames at full resolution promotes one step, never above the preset's own tier.
  Frames longer than 1 s are stalls and are ignored.

`?dynres=0` turns both off. Review builds keep them off unless `?dynres=1`.

## Remembered tier

In an automatic session (not review), a demotion that is still in force a minute later
is written to `localStorage['helsinki-rides:auto-tier']` (`low` or `minimal`), also on
`pagehide`. The next automatic visit starts there on the Low preset and the loading
screen says "Automatic (Low recommended by your last visit)". A promotion back to the
preset tier clears the key when the preset came from the device estimate; when the
session started from a remembered tier it writes `low`, so the next visit starts at Low
instead of estimating again. A URL or saved preset never reads or writes the key, and
choosing any graphics option on the loading screen or in the pause menu removes it.
The saved manual choice is `localStorage['helsinki-rides:preset']`.

## URL options

| Option | Effect |
| --- | --- |
| `?preset=standard` / `?preset=low` | Fixes the preset for this load; nothing is read or remembered. |
| `?preset=auto` | Review builds only: runs the production estimate (renderer classification) instead of the review default, Standard. Elsewhere it is the same as no parameter. |
| `?dynres=0` / `?dynres=1` | Turns the resolution and tier governors off (production) or on (review builds). |
| `?mipdrop=0` / `?mipdrop=1` | Measurement override: pins the texture mip drop for every load whatever the tier. Other values are ignored. |
| `?mobile=1` | Review: the phone graphics profile on a desktop. |
| `?fps=30` / `?fps=60` | Presentation target. |

There is no `?textures` parameter: the texture tier follows the preset (Low loads the
half-resolution copies, Standard the originals).

## HUD stats line

The stats overlay (shown in production with the HUD) reads, for example:

```
4.2 fps  238 ms frame  12 ms CPU
Low detail  50% resolution
209 calls  426k tris
205 tex  tick 18234
```

The fps and frame interval are measured from presentation timestamps and are no longer
capped at 10 fps. The CPU figure is the main-thread time of the frame; a frame interval
far above it means the GPU is the bottleneck. The second line is the current detail
tier and render scale. Before the player starts, the production line is still empty
(backlog).

## Measuring

`tools/verify/probe-weak-gpu.mjs` measures a compiled review shell served on a loopback
address. Run one Chromium at a time; SwiftShader renders on the CPU and is slow. Any
failure after Chromium launches (no server, a readiness timeout, a game error) closes the
browser, records `failed` in `result.json` and exits 1.

```
node tools/verify/probe-weak-gpu.mjs --url http://127.0.0.1:5329/Helsinki-rides/ --out data/evidence/weak-gpu-base --angle swiftshader
node tools/verify/probe-weak-gpu.mjs --url http://127.0.0.1:5331/Helsinki-rides/ --out data/evidence/weak-gpu-candidate --angle swiftshader --compare data/evidence/weak-gpu-base/result.json
node tools/verify/probe-weak-gpu.mjs --url http://127.0.0.1:5331/Helsinki-rides/ --out data/evidence/weak-gpu-adaptive --angle swiftshader --scenario adaptive --presets standard
node tools/verify/probe-weak-gpu.mjs --url http://127.0.0.1:5331/Helsinki-rides/ --out data/evidence/mipdrop-on --angle d3d11 --presets low --spots "Senate Square" --query mipdrop=1 --compare data/evidence/mipdrop-off/result.json
```

- `--angle swiftshader|d3d11|vulkan`: SwiftShader is the software weak-GPU proxy; d3d11 or
  vulkan use the real GPU. On this Windows machine journeys need vulkan, single pages
  run on d3d11.
- `--scenario fixed` (default) loads `?review=1&preset=<p>&audio=0&dynres=0` once per
  preset and visits every spot. After settling it samples every requestAnimationFrame
  tick for `--seconds` (default 5), together with `presentation().frameTime`, the time of
  the game's last presented frame. A tick at which that time changed is a presentation.
  - `presentedFrames`, `presentationMedianMs` and `presentationP90Ms` are the intervals
    between consecutive presentations. Paced runs (`--query fps=30`, `fps=60` or
    `mobile=1`) therefore count the frames the game drew, not the display's ticks.
  - `rafTicks`, `rafTickMedianMs` and `rafTickP90Ms` are the raw tick cadence, for
    information. Without pacing every tick presents, and both sets agree.
  - A shell whose review API has no `presentation()` with a numeric `frameTime` fails
    the run at once, before settling.
  - It then records `stats()`, `textureMemory()` with `byClass` (`zstd`, `basislz`,
    `image`, `other`), `textureFormats()`, `transcode()`, `residentCells()` and a WebGL
    upload histogram that also works on shells without those calls.
- `--scenario adaptive` loads `?review=1&preset=<p>&audio=0&dynres=1` in a fresh page
  per spot and plays for `--seconds` (default 40). At every rAF tick it records
  `{t, scale, tier, intervalMs}`, where `intervalMs` is the game's own presentation
  interval. Per spot it reports:
  - `resolutionFloor`: the game's configured floor, read once per run from
    `config().resolutionFloor` (0.5 on desktops, 0.6 on phones), never inferred from the
    samples;
  - `floorReachedAtSeconds`: the first frame with `scale <= resolutionFloor + 1e-9`, or
    null when the floor was never reached (or the shell does not report its floor);
  - `firstChange`: the first tier change, or null;
  - `secondsAtFloorBeforeChange`: the contiguous time at the floor immediately before
    that change (0 if the scale had left the floor, null without a change or floor
    arrival);
  - `lowestScale`, for information only.
- `--presets`, `--spots` (comma-separated drop-in labels), `--size` (default 1280x720),
  `--query` (extra parameters such as `mipdrop=1`; it may not set review, preset, audio
  or dynres), `--label`.
- `--compare <result.json>` writes `comparison.json` with one row per preset and spot
  (`tools/verify/lib/weak-gpu-analysis.mjs`). It also reports the texture MiB change and
  both format histograms. Frame intervals and residency are reported as follows:
  - `frameIntervalMs` holds both medians, the change and each side's measure
    (`measureHere`, `measureBaseline`). The measure is `presentations`, or one of two
    labels for results of the older probe, which recorded rAF ticks as `frames` and
    `rafMedianMs`:
    - `rafTicks-uncapped`: a run without pacing, where every tick presented. Every
      recorded `c-`, `c4-` and `c5-` run is of this kind.
    - `rafTicks-paced`: a paced run. Its ticks were not presentations, so the change is
      null and the console says "not comparable".
    - `rafTicks-unknown`: the run has no readable measured URL. It is not comparable
      either.

    Pacing is read from the run's measured URL (`runs[i].url`): `--url` with its own
    parameters, then the probe's parameters and `--query`, with the last value winning.
    The game's rule applies: `fps` exactly 30 or 60, or `mobile=1`. Any other `fps` is
    ignored, as the game ignores it. Presentation-based results compare whatever their
    pacing.

    A side without a finite positive median, such as a window with fewer than two
    presentations, is an insufficient measurement: `insufficientHere` or
    `insufficientBaseline` is true, the change is null, and the console says "not
    comparable: insufficient measurement".
  - Only when both runs report complete `residentCells()` sets is residency proven:
    `residentSource: "residentCells"`, `residencyProven: true`, `residentIdentical`
    true or false, and `residentDifferences` listing each stream's `onlyHere` and
    `onlyBaseline` ids. The console says "resident sets identical" or "resident sets
    DIFFER".
  - Otherwise `residencyProven` is false and `residentIdentical` is null (unknown).
    `residentSource: "renderedCells"` names what was compared instead
    (`renderedIdentical`, `renderedDifferences`), and the console says "residency
    unproven". Equal visible cells do not establish equal residency.
  - A spot or preset measured on one side only becomes an explicit `missingInBaseline` or
    `missingHere` row.

A matched comparison therefore needs `residentCells()` in both shells. To compare against
a tree that predates it (the 23 October baseline is HEAD `0248e34`), build an
instrumented baseline outside the working tree:

1. `git archive <commit> | tar -x -C build/perf-20261023/baseline-<id>`, with no worktree
   or checkout.
2. `pnpm install --frozen-lockfile --offline` inside the copy.
3. Apply only the `residentIds()` (`world/cell-streaming.ts`) and `residentCells()`
   (`testapi.ts`) additions.
4. Build its review shell with a copy of the local Vite config.
5. Check that the bundle contains `residentCells` and lacks strings that only the
   candidate has. The 23 October check searched for `helsinki-rides:auto-tier` and
   `mipDropped`: none in the baseline bundle, both in the candidate's.

The output directory must not exist; `result.json` holds every measurement and the
console shows a summary table.

## Measured sessions

Three sessions measured the 23 October candidate on SwiftShader, Low, at 1280×720.
The table gives the median presented frame interval at Senate Square / Kluuvi /
Esplanadi, with each change against the base of the same session or run pair.
Decision 0023 has the full numbers and evidence paths. None of these runs was paced, so
the older probe's rAF intervals there are presentation intervals.

| Session | Base | Candidate | Change |
| --- | --- | --- | --- |
| First session, existing review shell, residency unproven | 138.9 / 152.7 / 277.9 ms | 104.2 / 111.0 / 194.6 ms | −25.0 / −27.3 / −30.0 % |
| Second session, instrumented baseline, residency proven | 187.5 / 187.5 / 347.3 ms | 118.1 / 121.8 / 215.4 ms | −37 / −35 / −38 % |
| Third session, pair 1, instrumented baseline, residency proven | 180.6 / 173.7 / 305.6 ms | 111.2 / 118.0 / 208.4 ms | −38.4 / −32.1 / −31.8 % |
| Third session, pair 2, instrumented baseline, residency proven | 159.7 / 159.8 / 305.5 ms | 111.1 / 118.0 / 229.2 ms | −30.4 / −26.2 / −25.0 % |

- **Residency.** The first session's base has no `residentCells()`, so its
  rendered-cell comparisons are superseded by the later sessions; its timings stay
  valid. In the third session five of six rows hold identical resident sets. Senate
  in pair 1 differs by one fallback cell at Low's 28-cell cap, and the two base runs
  differ from each other by the same cell.
- **Ceilings.** The literal AC-10 ceilings (Senate ≤ 109.5 ms, Esplanadi ≤ 213.75 ms)
  are met only in the first session. The second session misses both. The third
  session misses Senate in both pairs and Esplanadi in pair 2.
- **Effect.** In every session the candidate's median is 24.98 % to 38.4 % below the
  base of the same session or pair (two rows are −24.98 % before rounding).
- **Texture memory on Low.** The candidate reads 44.36 / 40.81 / 37.01 MiB in every
  fixed run without `?mipdrop`. The SwiftShader base reads 53.99 / 48.52 / 45.45 MiB
  in the second session (residency proven) and 53.99 / 49.08 / 45.45 MiB in the first
  (residency unproven). The third session's two base runs read 48.52 and 49.08 MiB at
  Kluuvi with identical resident sets.
