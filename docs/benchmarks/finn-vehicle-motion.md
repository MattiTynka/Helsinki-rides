# Finn car motion, camera blend and passenger exit — 2026-10-18

Decision [0018](../decisions/0018-finn-car-motion-and-passenger-exit.md). Release `senate-20261017-185c7a1b`
(unchanged). Pose asset `content/assets/finn-vehicle-poses.json` SHA-256
`64e768a2b428ff3f2af736933e7fdadfb748a6c7cfee322366f06b8f2c6d5444`. It is the strict build in
`data/work/car-motion-20261018-v62/`, and its clips are identical to the reviewed draft `poses-v62.json`.
Ordinary bundle `index-CEw-fZP3.js`, SHA-256 `c018295a9a45cc26f4d800417753723b470c88fe82cb14e5191ecb88404227c2`.
The browser checks ran on the review build of the same source (`npm run build:review`), because the ordinary
build has no test API.

## Evidence

- `npm run typecheck` passes and `npm test` passes **225/225**. The native-animation tests now allow for the
  five-decimal rotation storage (unit norm < 2e-5, first-frame angle < 1e-6, normalised seated seam). The per-sample
  discontinuity test (< 0.65 rad) is unchanged, and it caught real forearm flips during authoring.
- Pose report (`data/work/car-motion-20261018-v62/report.json`): no joint-limit problems in any clip. Minimum
  roof gap is 6.3 mm (entry), 7.1 mm (exit), 5.6 mm (climb) and 7.5 mm (passenger tail). The climb-to-exit and
  enter-to-exit seams are both 0.0. No per-sample rotation jump reaches 0.65 rad.
- Skin clearance of the packaged Finn skin against the packaged Lumi GT at every 30 Hz frame
  (`data/evidence/car-motion-20261017/clearance-v62.json`, `REACH=0.12`). Deepest contact per clip and body part:

  | Clip | Shoes | Pants | Shirt | Skin |
  | --- | --- | --- | --- | --- |
  | enter | ≤ 4.6 cm (below the deepest listed contact) | 4.5 cm seat | 4.6 cm seat | 7.3 cm, the hand on the door edge it pulls |
  | exit | 5.5 cm door trim at 1.03 s | 4.6 cm seat | 3.9 cm | 3.3 cm |
  | exitPassenger | 6.4 cm console top (climb) | 7.5 cm armrest perch | 6.7 cm armrest | 4.3 cm |

  About 4.5 cm is the cushion compression of the seated baseline. The earlier v53/v54 measurements used a coarser
  stride and missed the leg-swing frames. At every frame, v54 had shoes 7.9/8.1/8.7 cm into the door trim. v62
  removes the entry contact and halves the others. The right foot's entry target moved inboard and back, the pelvis
  tips back so hip flexion stays under 140°, the door swings on to 84% once released, and the exit foot turns out of
  the door earlier.
- Contact sheets of the packaged skin: `visual-v62/`, with outside, knee and footwell views for each clip. They were
  opened. Knees fold forward over the feet, the head ducks under the rail, and the climb reads as a cramped
  perch-and-step behind the glass.
- `car-motion-20261018/browser-entry-v62/`: **PASS**. Real keyboard from the ordinary spawn: approach, entry, seated
  bounds (shoes above the 0.321 m floor, hair under the 1.378 m liner), driving, exit with the passenger door
  shut, and a continuous real-time repeat. `car-motion-demo-realtime.mp4` is that real-time cycle.
- `car-motion-20261018/browser-boxin-v62/`: **PASS**. The passenger exit runs in the browser. `boxin-tools/find_boxin.ts`
  boards through a recorded keyboard journey, then searches throttle and steer drives until the driver's doorway is
  blocked by real city geometry. Here that is the Senate Square terrace wall, after a half-throttle drive with
  steer −0.4 for 251 ticks. F then chooses the passenger side through the simulation's own rule. The browser plays
  the same commands through the fixed-step API: hash `9f30257a` matches Node, the only exit side is `passenger`,
  Finn ends on foot, and there are no console errors. Per-tick camera motion stays at or below 0.07 m and
  0.08° while exiting, and at or below 0.13 m and 1° while entering. That is a smooth ease of about 6 m/s, with
  about ±2 cm per-tick wobble. `passenger-exit-demo.mp4` is built from every second tick.
- `car-motion-20261018/journey-v62-vulkan/`: **2/2 journeys pass**, all checks, with exact replays `ded22659`
  (3174 commands) and `2f7c8c4c` (2887 commands). Average 142 fps, no console errors. Both runs left by the
  driver's door, because the harness retreats before pressing F. The passenger path is covered by the box-in run above.

Journeys on this machine need `HELSINKI_VERIFY_ANGLE=vulkan`, as the expansion gate used. With the d3d11 default,
the same build averaged 55 fps (min 19), fell behind wall-clock time and failed its timeouts
(`journey-v54/`, a diagnostic run, not a regression).

## Limitations

- The climb perches on the console armrest. Pants and shirt sink 6.7–7.5 cm into the armrest padding, and the
  stepping shoes 6.4 cm into the console top. Moving the feet further rearward only moved the shoe contact
  and broke the hip-flexion limit (v63). It is hidden behind the glass from the chase camera.
- The exit shoe still brushes the door trim by 5.5 cm for about two frames as the right foot crosses the sill.
  Opening the door wider during the exit would move the door-frame grab the left hand closes it with.
- The pulling hand's fingers overlap the door edge by up to 7.3 cm at entry 0.77 s (a grip).
- After a hard stop the chase camera is still catching up when an exit starts, so the first second of a
  passenger exit is seen from far behind.

## Reproduce

```powershell
pnpm typecheck; pnpm test
npm run build:review          # serve apps/game/dist on 5317
node tools/verify/verify-car-entry.ts --out data/evidence/NEW-entry
$env:HELSINKI_VERIFY_ANGLE='vulkan'
node data/evidence/car-motion-20261018/boxin-tools/browser_boxin.ts data/evidence/car-motion-20261018/boxin-tools/boxin.json data/evidence/NEW-boxin
node tools/verify/play-journey.ts --release apps/game/public/world/senate-20261017-185c7a1b --out data/evidence/NEW-journey --runs 2
npm run build                 # restore the ordinary bundle
```
