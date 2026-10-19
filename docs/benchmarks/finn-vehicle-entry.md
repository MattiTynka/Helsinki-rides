# Finn vehicle entry, seating and exit — 2026-10-17

Candidate: ordinary bundle `index-BiuSTaqb.js`, SHA-256
`8045be0c7a6dfa9d5e8bf012134e638e764cc6d53381605455df2727be4153a2`.
Active world remains `senate-20261017-15933497`; all 41 payload files match the
previous accepted candidate byte for byte. Source and content are frozen in
`data/evidence/car-entry-20261017/candidate-final2.json`.

The old sequence approached a point inside the door swing, opened both doors,
and hid Finn after 48 ticks regardless of arrival. Its embedded drive pose also
did not fit this cabin. The replacement collision-walks to the driver side,
opens only that door, ducks through the aperture, lowers Finn onto the seat,
brings both feet over the sill, and closes the door on a shared 3.2-second clock.
The driver remains visible. Exit reverses this path with a standing pose ready
underneath, preventing a one-frame return to the old crouched drive pose.

Parking brakes prevent the unoccupied spawn car from rolling down the square's
5% slope before Finn reaches it. Approach has a bounded timeout. Support and door
clearance are checked before boarding/exiting. Interrupted entry restores safe
collision; newly blocked exit returns Finn into the seat. Normal driving and
police controls release the brakes.

## Evidence

- `tests-final2.log`: **167/167 pass**. Includes collision routes from different
  sides, blocked approach, moving/blocked exit, death/cancellation/recovery,
  protected occupied cars, slope parking, native pose continuity and restoration,
  frame interpolation, and the actual CharacterView first-frame exit regression.
  At checkpoint close, concurrent jump/climb test additions brought the suite to
  **170/170** (`tests-at-completion.log`). `candidate-at-completion.json` records
  those test-only changes; all production source and bundle hashes stayed exact.
- `typecheck-final2.log`, `build-final2.log`: pass. Build retains the existing
  large-chunk warning; no new dependency or tool install was required.
- `browser-final2/results.json`: real keyboard walk from ordinary spawn, entry,
  visible seating/driving, exit and a second continuous real-time entry/exit pass.
  No teleport or direct simulation mutation. Chromium 153, 1440×900, no console
  errors. Actual displayed seated skin Y bounds: **0.330814–1.349320 m** in the
  car frame, versus cabin floor approximately 0.321 m and roof liner 1.378 m.
- `car-entry-demo-final.mp4`: the final real-time cycle extracted from the full browser
  video. Full-resolution stills and video frames were opened: duck, trailing leg
  transfer, seated fit and standing after exit are visible without the former
  torso-through-door or exit crouch behaviour.
- `visual-v12/`: three views of the actual packaged skinned Finn/car across eleven
  phases, including cutaways. Additional 97-pose roof and door proximity scans
  check the intermediate poses. Opening arm/hand contact is intentional; unsigned
  proximity is not proof against every microscopic skin intersection. Minimum
  sampled head/hair roof gap is 10.53 mm. The closing hand follows authored reach
  targets; it is not continuously locked to the handle surface.

Native game-rig inspection reports 71 joints, identity transform, no constraints
or drivers, and no draft profile problems. The animation supplement preserves
the native hierarchy, skin and non-hip translations/scales; no character/world
GLB is republished. Pose JSON SHA-256:
`d8ae5fdeddce90586a02ae3c2c6c0b6ffe28370f06fe23782b7b3501bfcec985`.

The workspace already contained a newer jump/climb implementation. It was kept;
stale jump test fixtures were reconciled with that API and intentional hand-climb
behaviour. No jump/climb production code was changed for this task.

- `journey-final2/journey.json`: **2/2 continuous gameplay runs pass**, including
  entering, driving, exit, police pursuit, death/arrest, 12/48 respawn ammunition
  and firing after respawn. Browser and Node replays match (`b58f1665`, 2808 commands;
  `691d0a9c`, 2768 commands), with zero console errors.
- `lifecycle-final2/results.json`: stolen patrol car stays rendered and occupied
  through officer cleanup; Finn remains visible and exits afterward. Six distant
  fall fixtures recover stably onto the map. A settled corpse's upright proxy is
  excluded only from upper doorway tests; bodies still block the standing stage,
  and living/falling people, walls and other cars still block the doorway.

The preview was restarted on strict port 5317 (PID 28520). Opened final browser
frames include entry 45%/75%, seated, after exit, real-time frames 04/07/10,
patrol driving after cleanup and recovered on-map. See `completion.json` for the
final source/content identity and the scope of visual review.

## Reproduce

```powershell
pnpm typecheck
pnpm test
pnpm build
pnpm preview
node tools/verify/verify-car-entry.ts --out data/evidence/NEW-car-entry
node tools/verify/play-journey.ts --url http://127.0.0.1:5317/ --release apps/game/public/world/senate-20261017-15933497 --out data/evidence/NEW-car-journey --runs 2 --max-seconds 90
node tools/verify/verify-vehicle-lifecycle.ts --out data/evidence/NEW-car-lifecycle
```

Use fresh evidence directories. The game preview uses port 5317 with strict port
binding; the independent Finn Motion Lab on port 5173 is a separate application.
