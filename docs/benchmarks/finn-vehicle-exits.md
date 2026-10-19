# Finn always gets out: windshield, flipped-car and squeeze-out exits — 2026-10-18

Decision [0020](../decisions/0020-finn-always-gets-out-of-the-car.md).

- Release `senate-20261017-185c7a1b` (unchanged).
- Pose asset `content/assets/finn-vehicle-poses.json`, SHA-256
  `70d9dc3362fc4736310dc41a8115c5847b3d967e3dac564d8fc7b594c2faae01`. It is the strict build in
  `data/work/car-exit-20261018-v9/`, byte-identical to the reviewed draft `data/evidence/car-exit-20261018/poses-v9.json`.
  `enter`, `exit`, `exitPassenger` and the seated pose are byte-identical to the 0018 asset.
- Ordinary bundle `index-BxEkCle4.js`, SHA-256 `25e492792a4fd6f30279dc9a1c14133ba6748610c3ccc31260eb4d9d5e552797`.
- Browser checks ran on the review build of the same source.

## Evidence

All paths are under `data/evidence/car-exit-20261018/` unless stated.

**Tests.** `npm run typecheck` passes and `npm test` passes **276/276**. A final run passed 280/280; the extra tests
come from a concurrent edit to `tools/world/test/foundation-closure.test.ts` outside this work. New sim tests (`packages/sim/test/simulation.test.ts`):

- Both doors boxed in: Finn kicks out the windshield. The glass breaks on the authored tick, and he stands in front
  of the bumper.
- Car on its roof: he crawls out of the driver's door.
- Car on its roof with the driver's side blocked: he crawls out of the passenger door.
- Car on its roof with both sides blocked: he is squeezed out onto clear ground.
- A moving car still brakes before any door opens.

The native-animation tests (`tools/verify/test/native-vehicle-animation.test.ts`) now cover:

- All six clips: durations, end stages, seated seams, the 0.65 rad per-sample discontinuity limit, and each clip
  opening only its own door (none for the windshield).
- Hiding the broken windshield.

**Pose report** (`data/work/car-exit-20261018-v9/report.json`):

- No joint-limit or reach problems, and all seams 0.0.
- No joint in a new clip turns 0.6 rad or more between samples. The worst is in the unchanged `exit` (0.648).
- Flipped clips keep every joint above the roof plane (min 2.2 cm). The windshield exit keeps the head under the
  liner until it is past the header (min 4.8 cm).
- The first install (v8) failed the runtime discontinuity test with forearm and elbow flips of up to 2.5 rad. v9
  fixes them with the rules in 0020 and costs the flipped exits 0.30 s.

**Skin clearance** of the packaged skin against the packaged Lumi GT at every 30 Hz frame (`clearance-v9.json`,
`REACH=0.12`):

| Clip | Shoes | Pants | Shirt | Skin | Hair |
| --- | --- | --- | --- | --- | --- |
| exitWindshield | 6.4 cm | 7.5 cm | 6.7 cm | 5.6 cm | 1.0 cm |
| exitFlipped | 8.7 cm footwell, 0.67 s | 4.6 cm | 5.6 cm | 5.4 cm door trim | 7.6 cm door trim, 1.03 s |
| exitFlippedPassenger | 7.3 cm | 4.7 cm | 4.2 cm | 5.5 cm | 5.5 cm |

The windshield clip's pants, shirt and shoe contacts are the 0018 climb across (armrest perch and console).

**Contact sheets** (all opened):

- `visual-v9-drop/`: hands off the wheel and onto the liner, then the roll onto all fours.
- `visual-v9-door/`: door push and the hand's return.
- `visual-v9-getup/`: sit back, tall kneel, step through.
- `visual-v9-across/`: the roll toward the passenger side.
- `visual-v9-header/`: kicks, feet on the dash, hands up past the chest to the header.
- The earlier `visual-w23/` shows the whole windshield and flipped-passenger exits from the bonnet, cowl, cut-away,
  low and side views.

**`browser-flip/`: PASS.**

- `exit-tools/find_flip.ts` boards through the 0018 recorded keyboard journey. It drives flat out with steer +0.04:
  at 21 m/s a kerb riser rolls the car (backlog-m2 item 8) onto its roof at tick 1456. It settles, then F.
- The browser plays the same commands through the fixed-step API:
  - Hash `d7cd047c` matches Node, the only exit route is `driver` (`exitFlipped`), and Finn ends on foot.
  - No console errors.
  - Camera steps: at most 0.053 m per tick while exiting and 0.087 m at the on-foot handoff. Before the
    camera-height fix the handoff step was 0.23 m.
- `sheet.png` shows the door opening, the crawl out, standing and the door shut.
- The search's straight-ahead drive also ends on the roof, with no clear way out. That run took the squeeze-out and
  ended on foot. It was seen in Node only.

**Other browser checks:**

- `browser-boxin/`: **PASS**. The 0018 box-in (Senate Square terrace wall) still leaves by the passenger door. Hash
  `9f30257a` matches, and the on-foot handoff step improves from 0.063 m to 0.026 m.
- `browser-entry-v9/`: **PASS**. Real-keyboard approach, entry, seated bounds, driving, exit and a real-time repeat.
- `journey-v9-vulkan/`: **2/2 journeys pass**, with exact replays `bd28a7c4` (2971 ticks) and `5ec60fc3` (2914
  ticks). Average 135 fps, no console errors.

## Limitations

- **The windshield exit was not played in the browser.** Two bounded real-control searches (`exit-tools/find_both.ts`,
  45 drives) found no spot on this release where the car stops with both doorways blocked. Both block only while
  passing through tight gaps, and braking carries the car clear. The route is covered by the sim test, the renderer
  test and the sheets.
- **Police box-ins do not block both doors yet.** A follow-up search started from the v9 journey's real ram
  (`exit-tools/find_police.ts`, `find_police2.ts`) ran 224 drives in Node: 32 fixed and 160 random drives after the
  ram, plus 32 chases that keep ramming, five of which reached two stars or more. None left both doors blocked by a
  stopped car. `boxIn` parks each unit 6.5 m ahead of
  or behind Finn's car, never beside a door. A patrol car blocks a door only when a collision leaves it there.
  Meanwhile, a car stopped within 6.5 m of the needed units for 3 s at one or two stars is busted (25 of the 32
  chases ended that way).
- **The squeeze-out is a teleport** with no animation. The test car cannot rest on its side: its centre of mass is
  outside the side face and it tips onto its roof. So in practice the squeeze-out is reached when every route is
  blocked.
- **Far LOD:** past the preset's detail range the merged far level still draws the windshield.
- **Upside-down footwell contacts:** the drop puts the shoes 8.7 cm into the upside-down footwell for a few frames.
  The hair brushes the door trim by 7.6 cm during the roll. Retracting the feet further broke the hip-flexion limit.
- **Long clips:** the exits take 5.2–6.3 s, and an interruption (car hit or moved) unwinds them.

## Reproduce

```powershell
pnpm typecheck; pnpm test
npm run build:review          # serve apps/game/dist on 5317
$env:HELSINKI_VERIFY_ANGLE='vulkan'
node data/evidence/car-exit-20261018/exit-tools/browser_exit.ts data/evidence/car-exit-20261018/exit-tools/flip.json data/evidence/NEW-flip driver
node data/evidence/car-exit-20261018/exit-tools/browser_exit.ts data/evidence/car-exit-20261018/exit-tools/boxin.json data/evidence/NEW-boxin passenger
node tools/verify/verify-car-entry.ts --out data/evidence/NEW-entry
node tools/verify/play-journey.ts --release apps/game/public/world/senate-20261017-185c7a1b --out data/evidence/NEW-journey --runs 2
npm run build                 # restore the ordinary bundle
```

The contact sheets come from `render-clips.mjs <version> <clips> <views> <count>`. Set `WINDOW=a,b` to limit it to a
share of each clip and `SUFFIX` to name the output directory.
