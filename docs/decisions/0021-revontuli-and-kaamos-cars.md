# Two more cars: the Revontuli and the Kaamos

Status: implemented and verified locally, 2026-10-18; staged as `senate-20261018-4b5289bb`, live pointer unchanged.
Builds on [decision 0018](0018-finn-car-motion-and-passenger-exit.md) and
[decision 0020](0020-finn-always-gets-out-of-the-car.md).

The owner asked for the cars in `models/bugatti-veyron-fully-rigged` and `models/GT40.*` to be added, rigged so
that Finn can get into them and crawl out of them.

1. **Names.** Plan rule 3 keeps real brands out of the game, so the cars are the fictional **Revontuli** (from
   `models/bugatti-veyron-fully-rigged/source/bugatti.blend`) and **Kaamos** (from `models/GT40.blend`). Grille
   emblems, lettering and number plates are deleted in the build. Assets `vehicle-revontuli` and `vehicle-kaamos`;
   contracts `content/assets/vehicle-{revontuli,kaamos}.contract.json`.
2. **Game models.** `tools/blender/build_extra_cars.py --car revontuli|kaamos` reuses `build_game_car.py`'s nodes
   (CAR_ROOT, CAR_BODY, CAR_INTERIOR, CAR_GLASS, CAR_DETAILS, DOOR_FL/FR, STEERING_WHEEL, WHEEL_*), material
   classes, procedural wheels and sockets, so the runtime treats them like the Lumi GT. Each has its own WINDSHIELD
   node; the renderer's windshield split now leaves such a car alone.
   - Revontuli: scale 0.88 → 4.50 m × 2.02 m × 1.25 m, wheelbase 2.71 m, track 1.70 m, 36,743 triangles,
     1.96 MB. The source wheels hang off rig bones whose parent inverse was set posed: at rest they sit 19 cm
     outboard of the arches, so their hubs are measured with the rig posed (`wheelsPosed`).
   - Kaamos: the source is modelled at about twice life size; scale 0.47 → 4.64 m × 1.98 m × 1.25 m, wheelbase
     2.63 m, track 1.48 m, 43,489 triangles, 1.59 MB. That is about 9% over life size so that Finn fits.
   - No textures (flat materials like the Lumi GT), so the low preset's texture residency is unchanged.
3. **Cabin fit for Finn.** Both cabins are lower and tighter than the Lumi GT's. The build moves the seats (shells,
   rails, mounts) and the wheel:
   - Revontuli: seats 7 cm lower and 15 cm forward; the wheel 12 cm nearer and 8 cm higher.
   - Kaamos: seats 6 cm lower and 15 cm forward; the wheel 25 cm nearer and 10 cm higher; and roof blisters 6 cm
     high over both seats (the racer's own "Gurney bubble"), lifting the roof skin and liner for his head.
   Seated, Finn's head clears the liner by 2.3 cm (Revontuli) and 2.9 cm (Kaamos); arm reach to the wheel is 0.98
   and 0.95 of full length.
4. **Finn's clips per car.** All six clips (`enter`, `exit`, `exitPassenger`, `exitWindshield`, `exitFlipped`,
   `exitFlippedPassenger`) are the Lumi GT's, warped into each cabin by `tools/blender/cabin_warp.py`
   (`build_finn_vehicle_poses.py --target`). Every keyed point moves through a continuous field between measured
   landmarks (seat, sill, beltline, liner, door, wheel, bonnet), timing and durations stay the same, and the solver
   refits the limbs. Per-car tweaks in `data/evidence/cars-20261018/poses/tuning.json` fix what the warp cannot:
   - `add` offsets or (new) `set` values on the keys in a time window: 37 tweaks for the Revontuli, 49 for the Kaamos;
   - a cabin posture for the Kaamos (bowed trunk and neck under its low roof).
   The flipped clips' end stage (`interaction.flippedStage`) now comes from the warped tail's last hips, so a tweak
   that moves where Finn stands also moves the stage the simulation checks. The Lumi GT's own file rebuilds
   byte-identically (`70d9dc33…`).
   - `content/assets/finn-vehicle-poses-revontuli.json` (`aba9d69a…`) and `…-kaamos.json` (`f271109c…`).
   - A car definition picks its set with `interaction.poses`; `stage`, `windshieldStage`, `flippedStage`,
     `doorSweep` and `bonnetPath` come from the same file, so the simulation's clearance checks match the clips.
5. **Gameplay.** Definitions `revontuli` (1,850 kg, 10.5 kN) and `kaamos` (1,250 kg, 8.5 kN) copy the Lumi GT's
   suspension, tyres, brakes, steering, aero and damage; collider, wheels, seat and exits come from each build
   report. They are parked on Senate Square beside the Lumi GT: `car-3` at `[-35.5, 10]` and `car-4` at `[-41, 10]`,
   heading 358°. `content/helsinki/central-expansion/gameplay.json` and
   `content/helsinki/district-expansion/gameplay.json` carry the same entries; no district release ships them yet.
6. **Publishing.** The two cars are optional asset ids in `tools/world/publish_release.ts`; a world whose gameplay
   defines a car must ship its asset, so district releases without them still publish.

Known limits:

- The mesh census fails on topology for both cars, as it does for the Lumi GT and the patrol car (backlog 27):
  non-manifold and flipped edges from the source meshes, and 4 degenerate faces on the Kaamos body. The dimension
  checks pass.
- Skin clearance (REACH 0.12) peaks at 9–10 cm (Revontuli, shoe toes into the forward footwell) and 7–10 cm
  (Kaamos, legs and shoes through the wide sill as they swing over it), against the Lumi GT's accepted 7.3–8.7 cm.
  `data/evidence/cars-20261018/clearance/`.
- During the flipped crawl Finn's legs pass through the far side of the cabin for a moment, as on the Lumi GT.
- With the Kaamos on its roof, its door's roof flap lies close to the ground.

Browser checks (`npm run build:review`, release `senate-20261018-4b5289bb`, real-control recordings replayed;
`data/evidence/cars-20261018/browser/`), node and browser state hashes equal, no console errors:

- PASS: Revontuli and Kaamos upright enter + driver exit; Revontuli and Kaamos flipped crawl-out (driver);
  Revontuli passenger exit when boxed in.
- Not yet run: Kaamos passenger exit when boxed in, and the Kaamos windshield exit (a real-control recording exists:
  `both-car-4`). The batch was stopped when the machine ran low on memory.
- Entering either car, the camera moves 0.56–0.64 m in one tick (the Lumi GT's baseline is 0.14 m). Not yet
  compared with the same scripted boarding of the Lumi GT, so the cause (car or harness) is open.
