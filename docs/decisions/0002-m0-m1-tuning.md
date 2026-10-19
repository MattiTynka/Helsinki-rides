# 0002 M0/M1 build decisions: textures, physics, police, harness

Date: 2026-10-16. Status: accepted (recorded by the implementing agent; the user chose the fresh build).

## Texture residency (M0 budget)

The first cell build estimated 247 MiB resident textures against the 160 MiB low-preset budget. Three changes
brought the build estimate to **97 MiB** (unique textures, UASTC counted at 1 byte/texel, ETC1S at 0.5, mips
×1.333): photo-bake atlases capped at 512 px (`texelCap.photo`), atlases trimmed to multiples of 128 rows instead
of power-of-two heights, and shared ground tiles / palette counted once per scene. Landmark chunks are simplified
with `simplifyWithAttributes` (64 367 → 29 271 triangles). The scene gate stays at 224 MiB
(`content/helsinki/cells.json`).

The build estimate is a lower bound, not the resident figure. Measured in the browser (`verify-browser`, which
sums the transcoded mip data of every texture in the scene), the pilot uploads **148.1 MiB in 130 textures** on the
RTX 3070 Ti: three.js transcodes ETC1S to BC7 (1 byte/texel) wherever BPTC is supported, and the runtime does not
share identical textures across cells (`KTX2Loader` caches per buffer, and each cell is its own GLB), so 24.7 MiB
are byte-identical copies. This is inside the 160 MiB low-preset budget with 12 MiB to spare; runtime sharing by
content and a corrected estimator are in `docs/backlog-m2.md`. The browser check gates on the measured figure.

## Draw calls on the low preset

The low preset differed from standard only in pixel ratio and antialiasing, and the drive scene drew 395 calls
against its 350 cap (`data/evidence/browser-m1-low`). City cells were not the cause (122 calls for all 15 cells,
at most 12 per cell): each car is about 35 calls (body, glass, interior, two doors, light bar, steering wheel and
four wheels, each split per material), and the pilot parks eight. Following the plan's rule (merge before touching
content), each car now has a far level of detail built at load time: the whole car at rest merged into one
vertex-coloured mesh (colour = base colour × (1 − metalness), interior and steering wheel left out), plus one mesh
per lamp material that shares the instance's lamp materials, so headlights, brake lights and the siren still show.
The switch distance is 30 m on the low preset and 60 m on standard (`vehicleDetailRange`). The drive scene now
draws 169 calls on low. Seen from 40 m on Kirkkokatu the far cars differ from the detailed ones only by slightly
darker paint (`data/evidence/vehicle-lod-m1`: 83 calls on low against 173 on standard for the same view).

## Vehicle model (Rapier raycast vehicle)

- The controller's rolling direction is `normal × axle`; with +Y up the axle is **−X** so the car rolls along the
  asset's +Z and a positive steering angle turns left.
- Wheel connection points sit `restLength − g/(wheels·stiffness)` above the hub so the hub rests at the socket
  height under the car's own weight.
- Rapier keeps user forces until reset: `resetForces` runs every tick before drag and downforce are applied (the
  missing reset produced a 14 m/s "top speed" and a car that sank into the road).
- Impact damage follows the chassis delta-v (`(dv − 1) × 28`, capped 400), not the contact force, so leaning on a
  wall is harmless and a 10 m/s hit costs about a quarter of the car.
- Definitions use the exported car's real geometry: wheels ±0.822 / 0.342 / ±1.333, radius 0.342, seat and exits
  from the sockets.
- The raycast vehicle's brake value is a maximum friction impulse per step (Bullet semantics), not a force.
  Passed as newtons (5200) it stopped the car from 22 m/s in 0.08 s and pole-vaulted it over its front wheels;
  `vehicle.ts` now multiplies the content's newtons by the tick. Braking from 22 m/s takes about 27 m.
- The chassis is two boxes: a body box 0.94 × 0.40 × 2.35 centred 0.95 m up (bottom at 0.55 m) and a massless
  skid box 0.94 × 0.25 × 1.30 within the wheelbase (bottom at 0.35 m). The original single box had its bottom
  0.18 m above the road: on the cambered street its lower edge dragged along the ground and its front corner caught
  kerb faces, which launched cars 2 to 4 m (Node contact traces, 2026-10-16). The remaining hop is a ground-mesh
  ramp at Unioninkatu's square corner (backlog P0-1).
- The AI driver limits its steering lock to 7 m/s² of lateral acceleration (`v² / R`), relative to the vehicle's
  speed-reduced lock, so direct pursuit never turns full lock at 20 m/s.
- On flat ground neither car rolls: full-lock turns and left/right slaloms at 12, 17 and 22 m/s stay within 2.5° of
  level, with the centre of mass at 0.38 m or lowered to 0.15 m (Node probe on a zeroed terrain). Rollovers come
  from the ground: in run 5 of `journey-m1-try5` the player's car slid sideways at 18 m/s into the kerb on Aleksanterinkatu's
  south side (x 16 to 26, z 52 to 56), lifted two wheels, hit the facade and came to rest on its roof (replayed from
  `run-05-recording.json`). The centre of mass therefore stays where it is; the ground surface is backlog P0-1.

## Police

- Characters are in the `bullet` filter group so officers' and the player's hitscan rays hit capsules.
- Units route only over "well-connected" lanes (forward reach ≥ 60 % of the best lane: 111 of 217); the patrol
  spawn points in content are the north end of Unioninkatu, the east end of Aleksanterinkatu, the north end of
  Snellmaninkatu and the west end of Kirkkokatu. The first patrol of a quiet city always takes the first beat and
  drives the length of its own street before roaming, which is what makes the 60-second test reproducible.
- A spawning unit snaps to the nearest well-connected lane that runs the way the content heading points (same
  heading penalty as the road index), facing along that lane segment. The route follower starts at the first route
  point ahead of the car and skips nearby points behind it: lanes come whole from the router, and the earlier
  "nearest point" start sent responding units into a three-point turn that reversed them into the Cathedral
  terrace, where they flipped or stalled (`data/logs/journey-m1-try3.log` shows four units never arriving; after
  the fix three of five reach the square within 25 s in the Node probe).
- Officers fire only at three stars or more and only while the player is armed: aiming, or having fired in the last
  1.5 s. Holstering is surrender, so the arrest path exists at three stars.
- On foot an officer that stops closing in for 0.75 s sidesteps (alternating sides) to get around a car.
- Crimes are debounced per type (fire 1.5 s, shootAtPolice 2.5 s, drawWeapon 10 s) so an emptied magazine is one
  report; taking an unlocked parked car is a crime only when an officer sees it.

## Lighting A/B

Cells are published lit (`lighting: lit-facades`): baked LoD2 base colour under a warm directional sun from the
south-west (intensity 2.4) and a sky hemisphere (1.3), no tone mapping, roughness 1 / metalness 0. The unlit variant
is a load-time material swap (`?lighting=unlit`) kept for the review captures in `data/evidence/browser-*`. Lit was
chosen because the photo-baked landmark meshes are always unlit and the hero assets (flat-colour cars, baked
characters) need the sun to read against the facades; without it the cars look pasted on. Open: facade shadows are
baked into the city textures (afternoon), so the sun direction is matched to them rather than free.
Superseded in part by decision 0003: the facades' baked sun was measured at 127° (morning, south-east, not
afternoon), the scene sun now stands there, and facade photos are lit mostly through emissive.

## Journey harness

`tools/verify/play-journey.ts` plays the 60-second test through Playwright's keyboard (WASD, Shift, F, S) and mouse
buttons; the camera yaw/pitch are set through the test API because headless Chromium cannot grant pointer lock.
Each run starts a fresh simulation on the same page (`__HELSINKI_GAME__.reset()`), the browser's encoded command
trace is replayed in Node and the state hashes must match (collision cells are added in manifest order on both
sides so collider handles agree). Endings alternate: odd runs die (Meilahti hospital), even runs surrender (Pasila
police station). The hash, command log and digest trace are read in one page evaluate: read separately, the loop
ticked between the reads and the second run of `journey-m1-try2` failed its replay with identical digests. Each run
writes `run-NN-recording.json` (seed, release, commands, hash), which `tools/verify/replay-recording.ts` replays.
The end capture waits 0.6 s after the respawn: taken on the first poll, it caught the 0.15 s crossfade out of the
arrest or death clip, and the half-blended pose (arms straight out) looked like a missing animation.

The harness drives like a player, including recovery: a car on its side or roof for more than a second, or still
wedged after two reverse-out attempts, gets the game's recover control (hold X), which places it upright on the
nearest lane, and the log says so. Without it, `journey-m1-try5` stopped at run 5 (4 of 10): the car lay on its
roof for 30 s while the ram and pursuit checks timed out, because the old stuck test only fired while the throttle
was held. `journey-m1-try6` then stopped at run 7 (6 of 10): chasing the patrol north on Snellmaninkatu at 21 m/s, a
route replan put the aim behind the car, the harness braked at full lock, and the car spun into the west facade at
(61, −123) (replayed: the body box's front corner against a `buildings` collider of `c_p00_m01`). It then rocked back
and forth between two plans that alternated between the junction's lanes, never stopped for the stuck test's 1.5 s,
and the ram timed out. The harness now brakes in a straight line when the aim is behind it above 8 m/s, and
recovers when the car has not moved 5 m in 6 s. With that, `journey-m1-try7` stopped at run 2 (1 of 10): the
recoveries worked (two at the same junction, which the harness still enters at 21 m/s because it does not brake
ahead of corners), but driving south 0.9 m off the lane centre the car rode the Snellmaninkatu kerb and rolled
(root cause and a candidate fix in backlog item 8). The user accepts car flips for this milestone (2026-10-16), so
the gate's ram and pursuit checks can fail on a flip; try4's 10 of 10 is the last full pass on this release and
simulation code (the later changes are render-only: vehicle far LOD and the texture-memory test API).

## Placeholder anchors

The first police anchor (120, −170) was inside a Kruununhaka block: the ground probe runs on the static collision
and put the respawned player on a roof 28 m up (`data/evidence/journey-m1-try2/run-02-end.png`), which the distance
check did not catch. Both anchors now sit on the carriageway edge: the ambulance bay at (−84, −60) on Unioninkatu
and the police van at (145, −152) on Kirkkokatu at the district's east edge. The journey harness also checks that
the respawned player stands within 2.5 m of the terrain height. Note for probes: scene queries are valid only after
the first physics step, so `groundPoint` falls back to the terrain grid during construction.
