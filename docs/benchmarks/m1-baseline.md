# M1 baseline benchmark

Date: 2026-10-16. Release `senate-20261016-d9a3be1f` (15 pilot cells around Senate Square). Plan section 12 sets
the budgets; this record is the first measurement against them and the baseline later milestones compare to.

## Setup

| Item | Value |
| --- | --- |
| Build | Production review build (`pnpm build:review`), served by `vite preview` on loopback, uncompressed |
| Browser | Playwright Chromium, headless, 1280 × 720, device scale factor 1, ANGLE on Direct3D 11 |
| GPU string | `ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Ti (0x00002482) Direct3D11 vs_5_0 ps_5_0, D3D11)` |
| Machine | Windows 11 desktop, RTX 3070 Ti, Node 24.11.1 |
| Command | `node tools/verify/verify-browser.ts --url "http://127.0.0.1:4317/?review=1" --release apps/game/public/world/senate-20261016-d9a3be1f --out data/evidence/<new dir> [--preset low]` |
| Evidence | `data/evidence/browser-m1-standard-final`, `data/evidence/browser-m1-low-final` (reports and captures); logs in `data/logs/verify-browser-m1-*-final.log` |

Caveats:

- This GPU is well above both reference machines (integrated laptop GPU for low, GTX 1660 class for standard).
  Frame rates here say nothing about the low preset's target machine; draw calls, triangles, texture bytes and
  transfer do carry over.
- Both presets were measured at 1280 × 720. The standard preset's reference resolution is 1920 × 1080.
- Frame rate tops out at about 144 fps in every scene, which looks like a cap rather than the renderer's limit, so
  the frame-time p95 is the figure to watch.
- The plan's fixed route (Senate Square, Unioninkatu, Aleksanterinkatu, Esplanadi, Market Square quay and back,
  with cold and warm cache) is not automated yet. The benchmark covers three scenes with a cold cache: the spawn
  view, Unioninkatu, and a short drive (about 40 m).

## Results

Low preset (pixel ratio 1, no antialiasing, cars beyond 30 m drawn as one merged mesh plus lamps):

| Scene | fps avg | fps min | frame p95 | Draw calls | Triangles | Textures |
| --- | --- | --- | --- | --- | --- | --- |
| Spawn (lit) | 143 | 104 | 2.54 ms | 87 | 174,651 | 48 |
| Unioninkatu | 144 | 144 | 2.44 ms | 113 | 231,502 | 131 |
| Drive | 144 | 144 | 2.46 ms | 169 | 325,390 | 131 |

Standard preset (pixel ratio up to 1.5, antialiasing, far car mesh beyond 60 m):

| Scene | fps avg | fps min | frame p95 | Draw calls | Triangles | Textures |
| --- | --- | --- | --- | --- | --- | --- |
| Spawn (lit) | 142 | 99 | 2.72 ms | 87 | 174,651 | 48 |
| Unioninkatu | 144 | 144 | 2.91 ms | 203 | 261,049 | 131 |
| Drive | 144 | 144 | 2.88 ms | 181 | 331,404 | 131 |

The loading screen cleared after 2.5 s (low) and 2.8 s (standard) on loopback. Neither run logged a console
error.

## Against the plan's budgets

| Measure | Low budget | Low measured | Standard budget | Standard measured | Verdict |
| --- | --- | --- | --- | --- | --- |
| Frame target | 30 fps, p95 ≤ 40 ms | 143 fps, p95 ≤ 2.54 ms | 60 fps, p95 ≤ 22 ms | 142 fps, p95 ≤ 2.91 ms | Pass on this GPU only (see caveats) |
| Visible triangles | about 500,000 | ≤ 325,390 | about 1.2 million | ≤ 331,404 | Pass |
| Draw calls per frame | ≤ 350 | ≤ 169 | ≤ 600 | ≤ 203 | Pass |
| City cell draw calls | ≤ 60 per cell | ≤ 12 per cell (122 for all 15) | ≤ 100 per cell | same | Pass |
| Resident textures (compressed, mips) | ≤ 160 MiB | 148.1 MiB | ≤ 320 MiB | 148.1 MiB | Pass (12 MiB headroom on low) |
| Population caps (cars / police) | 15 / 3 | 8 civilian cars; police up to 5 at three stars | 35 / 7 | same | Police over the low cap at three stars |
| Transfer to first control | ≤ 20 MB | 62.5 MB | ≤ 30 MB | 62.5 MB | **Fail** |
| Time to control at 20 Mbit/s | 12 s | about 25 s (computed) | 15 s | about 25 s (computed) | **Fail** |

Notes on the rows:

- **Textures.** The figure is what the browser uploaded: the transcoded mip data of every texture in the scene,
  summed by the test API's `textureMemory()`. three.js transcodes ETC1S to BC7 on this GPU, so ETC1S costs
  1 byte per texel. Of the 148.1 MiB, 24.7 MiB are byte-identical copies of shared ground tiles and the palette,
  one copy per cell (backlog item 16). The build-time estimate of 97 MiB is a lower bound (backlog item 23).
- **Draw calls.** Before the far car mesh, the low preset's drive scene drew 395 calls against 350. Each detailed
  car is about 35 calls (decision 0002).
- **Transfer.** The whole pilot loads before control. The release is 62.3 MB: 53.5 MB of cell GLBs (almost all
  KTX2 textures), 4.9 MB of hero assets, 3.2 MB of collision, plus terrain, roads and gameplay. The JavaScript
  bundle is 5.2 MB raw, 1.9 MB gzipped (Rapier's WebAssembly is inlined). `vite preview` does not compress, so
  62.5 MB is an upper bound for a compressing host. The KTX2 payload barely compresses, though, so even
  compressed the budget is missed by about a factor of two. Options in the plan's order are in backlog item 17.
  Time to control is computed as 62.5 MB × 8 / 20 Mbit/s; it was not throttled and measured.
- **Population.** The simulation uses one table of police caps for every preset (`wanted.unitCaps`
  [1, 3, 5, 7, 9]), because preset-dependent caps would make the deterministic simulation depend on a render
  setting. At three stars the low preset can therefore have 5 units against its cap of 3. M1 has no traffic or
  pedestrians: the civilian cars are 2 placed plus up to 6 parked.

## Journey gate frame rates

The 10-run journey gate (`tools/verify/play-journey.ts`, dev server, standard preset) reports frame rates while
it plays. In `journey-m1-try4` (10 of 10 passed, before the far car mesh) every run averaged about 144 fps, with a
minimum of at least 100 fps and at most 438 draw calls. The later runs are recorded in decision 0002:
`journey-m1-try6` passed 6 of 10 and `journey-m1-try7` 1 of 10, both stopped by the harness driving into a
junction or riding a kerb and flipping. The user accepted car flips for this milestone.

## Earlier runs on the dev server

`browser-m1-try2` (standard) and `browser-m1-low-try2` (low) ran against the unbundled dev server. Their
transfer figure (81.1 MB) includes Vite's development modules, and resource timing then kept only 250 entries,
so it is not comparable. The benchmark now raises that buffer and reports the transfer at first control
separately from the session total.
