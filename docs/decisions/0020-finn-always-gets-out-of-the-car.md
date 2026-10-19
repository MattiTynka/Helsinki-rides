# Finn always gets out of the car

Status: implemented and verified locally, 2026-10-18. Extends [decision 0018](0018-finn-car-motion-and-passenger-exit.md)
and replaces its "both doors blocked still gives `vehicleExitBlocked`" rule. See
[the benchmark](../benchmarks/finn-vehicle-exits.md).

The owner reported that with the car on its roof Finn could not get out at all; the HUD said the doors were blocked.
They asked that the doors open no matter what. If the driver's door really is blocked, Finn should leave by the
passenger seat or break the windshield. The cause was `beginExit`: it only tested the doorways of a car whose up axis
was above 0.9, so a car on its roof had no way out. A car upright with both doors blocked had none either.

1. **Exit order by posture.** `vehicleExitClips(vehiclePosture(v))` lists the ways out in the order F tries them.
   - Upright (up Y ≥ 0.9): driver's door, passenger door, then the windshield.
   - On its roof (up Y ≤ −0.7): crawl out of the driver's door, else the passenger door.
   - Each route has its own clearance check (`vehicleExitClearance`), with support and free space at the clip's end
     stage. The door routes keep the 0018 swept-door samples, which on a car on its roof cover the door's swing and
     the gap Finn crawls through. The windshield checks three samples over the bonnet and the nose.
2. **Last resort: squeeze out.** If no route is clear, or the car lies on its side or is badly tilted (no authored
   clip), Finn is put on the nearest clear ground (`safeSpawns.character`).
   - `vehicleExitSqueezed` is emitted and the HUD says "Squeezed out of the car."
   - There is no clip for it, so he appears there.
   - F never leaves Finn seated any more. `vehicleExitBlocked` now only means an exit was interrupted: the car was
     hit, moved, rolled, or the way out became blocked. The exit then unwinds into the seat and the next F picks a
     route again.
3. **Three new clips** in `content/assets/finn-vehicle-poses.json` (schema 2, same file and runtime as 0018):
   - `exitWindshield` (5.2 s). The 0018 climb across, then from the passenger seat (authored on the driver's side
     without the wheel, then mirrored):
     - Brace on the armrest and cushion, knees up behind the dash, and two kicks with both feet.
     - The second kick breaks the glass at 2.46 s.
     - Feet onto the dash, a bridge, the hands up past the chest to the header.
     - Slide out feet first on his back, sit up on the bonnet leaning on his hands, shuffle to the nose, and drop
       off in front. He stands at car-local `[-0.3, 0, 2.75]`, facing forward.
   - `exitFlipped` (6.04 s). Hanging upside down:
     - Hands off the wheel onto the liner, the belt lets go, and he rolls forward onto all fours facing the door.
     - He pushes the door open and crawls out behind it (ten steps).
     - He kneels up, stands, steps back out of the door's swing, and swings it shut.
     - He stands at `[±1.52, roof, −0.88]`; his heading goes through the car's actual rotation.
   - `exitFlippedPassenger` (6.3 s). He rolls the other way and crawls across under the console, then plays the
     mirrored tail through `DOOR_FR`.
4. **The windshield stays broken.**
   - `Vehicle.windshieldBroken` is simulation state: it is in the snapshot and survives an interrupted exit.
   - At load the renderer splits the windshield triangles out of the merged `CAR_GLASS` mesh into a `WINDSHIELD`
     node, by position and facing, and hides that node on a broken car.
   - A `windshieldBreak` event plays a burst of glass noise.
5. **Prompts** name the route: climbing across, kicking out the windshield, crawling out, crawling across.
6. **Camera height during the interaction** comes from the ground the car stands on: under the wheels, or the roof
   plane of a car on its roof. The hidden capsule sits 0.45 m under the seat, which is 0.15 m off the ground in an
   upright car but 0.30 m upside down. That made the on-foot rig drop 0.45 m in two ticks at the end of a flipped
   exit. The upright handoff drop goes from 0.06 m per tick to 0.03 m.

Pose rules learnt here (on top of 0018's):

- `pole` is not a held parameter: it interpolates straight between its keys. Interpolating between nearly opposite
  poles passes through the arm axis and flips the elbow. Add waypoints so it turns round the side.
- When a hand changes from one palm target to a very different one while it is still oriented (orient > 0), the
  target can pass 180° from the forearm and the wrist snaps. Relax the hand (orient 0), change the palm target
  while it is relaxed, then orient it again.
- An auto palm with the forearm nearly parallel to `pn` is ill-conditioned (hands down onto the liner). Use a
  fixed palm there.
- A mirrored tail is authored on the driver's side: its authored left hand is the final right hand.
- The builder now reports any joint turning 0.65 rad or more between samples, the runtime test's limit, as a
  problem, so the strict build fails on a pop.

Acceptance:

- The joint checks pass, and no per-sample turn in a new clip reaches 0.6 rad.
- Skin clearance is measured at every frame. The changed passages' contact sheets have been opened.
- The sim tests cover each route: driver, passenger, windshield, flipped driver, flipped passenger and the
  squeeze-out.
- A flipped exit plays in the browser from a real-control kerb flip, with a matching Node hash.
- The keyboard entry/exit, the box-in passenger exit and the journey gate still pass.
