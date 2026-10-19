# Vehicle cleanup crash and respawn recovery

Date: 2026-10-17. Status: **PASS, active locally**.

Content remains `senate-20261017-15933497`. All 41 release files match the accepted
Finn/jump baseline. The ordinary bundle is `index-B2hQqMI_.js`, SHA-256
`7413bfecdb136f1a0f8b98b35cddb864211cd8322331ecb19653c06127ca8293`.
`data/evidence/vehicle-despawn-crash-20261017/candidate-final.json` freezes 86
source/config/test files and the release payloads. No city or character assets
were rebuilt.

## Causes and changes

The reported `syncViews` error is reproduced at the same `game.ts:239` lookup in
`regression-before.log`. A police officer's cleanup deleted its car even when
Finn had taken it. `player.inVehicle` then named a missing entity, and the camera
dereference threw before the next frame could be scheduled. Cleanup now retains
vehicles used or reserved by the player while still removing the retired officer.
An interrupted entry releases its seat reservation. The renderer also handles an
absent vehicle by showing Finn and using the on-foot camera offset.

Respawn previously called `stripAmmo()` after death and `stripAll()` after arrest.
Both endings now reconstruct the configured starting loadout: for this release,
one pistol with 12 rounds loaded and 48 in reserve, initially holstered. Old reload
and firing timers are discarded. Repeated respawns do not accumulate weapons or
ammunition. See [decision 0013](../decisions/0013-vehicle-lifecycle-and-respawn.md)
for the change from the original plan's penalties.

Fall recovery previously used an unchecked nearest-road position; vehicle
recovery did nothing if no road was within 80 metres. Terrain samples outside the
terrain grid could also masquerade as valid ground. `SafeSpawns` now intersects
playable and terrain bounds, clips road candidates to those bounds, verifies
physical ground support and slope, and checks character/chassis clearance and
complete vehicle footprints. It falls back to the verified starting area and a
bounded deterministic search. No valid support causes an explicit error, not
placement into a void. Recovery handles horizontal map exits as well as the kill
height, resets vehicle controls and synchronizes a seated player immediately.
Static Rapier queries are primed before checking the initial spawn. Both authored
hospital/police anchors remain at their original XZ coordinates.

## Verification

- Full suite: **146/146 tests pass**; full workspace typecheck and ordinary build pass.
- New regression coverage includes officer cleanup during entry/driving/exit/death,
  unused-car removal, interrupted entry, renderer fallback, repeated death/arrest
  ammunition and firing, invalid anchors, unsupported terrain/roads, every map edge,
  distant occupied vehicles, and recovery footprint/obstruction checks.
- Ordinary Chromium `153.0.8010.12` at `http://127.0.0.1:5317/`: the focused harness
  kills an officer through weapon damage, enters the patrol car with F, drives
  with W, and waits past the actual 20-second cleanup. The original officer is
  removed at tick 1305; Finn retains the car, displayed frames continue, and exit
  works. This uses a setup teleport and scripted aiming; it is a focused fixture,
  separate from the continuous journeys.
- Six browser fixtures beyond every map edge and at ±10,000 metres recover inside
  the map and remain grounded over 240 further ticks without repeated recovery.
  Zero browser errors. The compiled response matches the local bundle hash.
- Opened `browser-final/driving-after-cleanup.png`: car, streets, buildings, trees
  and HUD remain rendered. Opened `browser-final/recovered-on-map.png`: Finn is
  standing on the authored pavement, with the surrounding scene intact.
- Two continuous native gameplay journeys pass, including death and arrest,
  supported respawn, exactly 12/48 pistol ammunition and firing through real mouse
  input after each ending. Both command recordings replay exactly in Node:
  `b81eaa7e` (death) and `0b2caa20` (arrest). Zero browser errors; 43.0 and 40.8
  simulation seconds respectively. Opened both ending captures: scene and Finn
  remain visible and the HUD shows 11/48 after the verification shot.
- The ordinary preview was rebuilt and restarted on strict port 5317 (PID 42244).
  No 4317 listener exists. `completion.json` binds final checks, source/content
  hashes, opened captures and documentation. Reload `http://127.0.0.1:5317/`.

The preliminary journey's instantaneous Playwright mouse click fell entirely
between simulation ticks. The verification now holds the click for 75 ms, matching
the existing journey's held-input approach. This was a harness correction; the
runtime bundle did not change. Earlier failed logs remain alongside final evidence.

This is a focused local bug-fix verification, not a new full-world performance or
asset acceptance. The existing native test adapter remains present in the ordinary
build. No external publication or commit is performed.
