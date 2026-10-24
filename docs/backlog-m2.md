# M2 backlog (prioritised)

Date: 2026-10-16, written at the end of plan day 10 once the M1 gate passed. M2 is "police depth" (plan section
16): five stars, witnesses, search and decay, roadblocks, helicopter, cover AI, unit caps; its exit gate is an
external playtest that rates pursuits fair and tense. Priorities: **P0** is needed for that gate or is a defect M2
would otherwise build on; **P1** is visible quality debt inside the pilot; **P2** is pipeline and housekeeping.
Every item names its fixture, acceptance and evidence (plan rule 18.4).

## P0

1. **Road surface bumps on Unioninkatu.** The baked ground mesh has a 0.66 m rise over 1.5 m where Unioninkatu
   meets the square's north-west corner (x −81, z −5) and a kerb face across the lane at z −42; a car at 26 m/s is
   thrown 4 m (`data/logs/journey-m1-*.log` do not hit it, the Node probes in decision 0002 do). Kirkkokatu at
   the police anchor (145, −152) shows the same ridged surface (`data/evidence/journey-m1-try5/run-02-end.png`).
   Fixture: the
   height profile along every lane (terrain and collision probe per metre). Acceptance: no lane sample steps more
   than 0.15 m per metre on a carriageway; kerbs stay on the kerb line. Evidence: the profile report plus a
   full-throttle Node drive on each street with no hop above 0.3 m.
2. **Road graph connectivity.** Pohjoisesplanadi lanes are cut at the one-way boundary and the Senate Square
   service loop is isolated, so units route over 111 of 217 lanes. Fixture: `data/work/m0/roads/report.json`
   (`deadEnds`, `unreachable`, `isolated`). Acceptance: every public-road lane inside the play area belongs to the
   main component or is listed with a reason; well-connected lanes ≥ 90 %. Evidence: the roads report and a
   journey run pursued along Pohjoisesplanadi.
3. **Two-star box-in and spike strips.** The `boxin` state exists but the second unit arrives late from the far
   spawns and nothing stops a moving car. Acceptance: a scripted 2-star drive on Unioninkatu is boxed in within
   45 s in 8 of 10 seeds; a spike strip at a choke point deflates tyres (new entity, collider, tyre damage).
   Evidence: a journey variant log and a capture.
4. **Roadblocks on predicted route edges at three stars.** Predict from the player's lane and heading, park two
   patrol cars across the lane, officers behind the doors. Evidence: a `roadblock` event in the journey log and a
   capture.
5. **Cover AI for officers on foot.** Replace the sidestep with cover points sampled against the collision
   bundle; an officer under fire never stands in the open for more than 40 % of a 3-star engagement. Evidence: a
   journey metric (time in line of fire) and a capture.
6. **Witnesses, search and decay.** Civilian reports today are a timer; real line-of-sight witnesses need the M3
   pedestrians. Until then weight the report chance by the address heat map so crimes in empty courtyards go
   unreported, and make the search end after `decaySeconds` without a sighting at every level (the search state
   and `lastSeen` exist). Evidence: a Node test per star level.
7. **Four and five stars.** Fictional tactical van, helicopter with a spotlight cone as detection, higher accuracy;
   unit caps 7 and 9 with off-screen spawns only (≥ 150 m). Evidence: a journey variant reaching five stars.
   The caps are one table for every preset, so at three stars the low preset runs 5 units against its population
   cap of 3 (`docs/benchmarks/m1-baseline.md`). Decide whether the low preset gets its own table, which makes the
   preset part of a recording's inputs, or whether the plan's low cap is raised.
8. **Pursuit driving at speed.** The AI driver now caps its lock by lateral acceleration (7 m/s²) and brakes
   realistically (brake values are impulses per step); it still clips kerbs when cutting corners at 20 m/s and
   has no obstacle avoidance for parked cars. Acceptance: ten pursuits on the pilot streets without a flipped
   patrol car. Evidence: the Node responder probe extended to ten seeds.
   Root cause of kerb flips, found on the player's car (`data/evidence/journey-m1-try7/run-02-recording.json`,
   Snellmaninkatu at (68.4, −62), straight at 21 m/s with the wheels 0.3 m off the kerb line): a wheel ray landed
   on the 12 cm kerb riser (contact normal y = 0.00). Rapier's raycast vehicle, like Bullet, divides the spring
   force by the normal·ray dot clipped at 0.1 and applies it along that horizontal normal at road level, so one
   tick rolled the chassis at 4 rad/s; with neutral input from that tick the car still ends on its roof. Candidate
   fix, drafted and reverted unverified on 2026-10-16: after `updateVehicle`, if a wheel's contact normal y is below
   0.6, restore the chassis velocities and rerun the update with that wheel's max suspension force and friction
   slip at 0 for the tick. Acceptance adds a straight 21 m/s run along each pilot kerb line with no roll above 10°.
   On 2026-10-24 [decision 0024](decisions/0024-car-rollover-guards.md) fixed that root cause in `Vehicle.step`, for
   the player's, patrol and parked cars alike. A wheel hit on a surface facing more than 60° away from the wheel ray
   is now ignored for the tick, and tyre grip follows the capped suspension load. A car past 60° gets no wheel
   forces, an angular damping of 3 s⁻¹ and, until it is on its roof, a torque that tips it off its side, so it
   settles on its roof instead of rolling on. This addresses the wheel-ray kerb kicks and the inverted roll-on. On
   the test fixture, every 21 m/s run into or along a 12 cm kerb (three cars, 2–4° drift and a 3 cm wobble) stays
   within 8.2° with kicks of at most 0.22 rad/s; before, 5 of the 12 runs ended on the roof. Still open for this
   item's acceptance: the ten-seed pursuit probe and the straight runs along the pilot kerb lines, which are recorded
   by the release run. Obstacle avoidance for parked cars is unchanged.
9. **Playtest kit for the gate.** Review build with seed and preset in the URL, a one-page feedback form (fair and
   tense on a 5-point scale plus free text), five external testers, sessions kept as input recordings
   (`run-NN-recording.json`) so they replay.

## P1

10. **Alexander II statue** (`ART-002`): decision 0005 gave the Cathedral the user's model, drew the grand stairs from
    OpenStreetMap and replaced the terrain with the city layer. The statue still has no source; its base is whatever
    the city terrain records in the middle of the square. Needs a hero model.
11. **Senate Square cobble** is procedural (17 cm setts and 10 cm cobbles in running bond since decision 0005);
    author a 1024 tile if it still reads synthetic. The photo-mesh is ruled out as a source (decision 0005).
12. **Hospital anchor surroundings**: the old respawn at (−88, −60) stood on untextured grey ground beside
    Unioninkatu (`data/evidence/journey-m1-try3/run-01-end.png`); the moved anchor (−84, −60) lands on the
    square's paving, but the grey strip remains and needs its surface tag.
13. **Character animation**: enter and exit car clips, aim-walk blending, hit reactions (crossfades only today).
14. **Audio**: engine, siren and shots are synthesised; licensed samples belong to M6 but the siren matters for the
    M2 playtest.
15. **HUD**: star flash during search, minimap police blips (the arrest ring exists).
16. **Share identical textures at runtime.** Each cell GLB brings its own copy of the shared ground tiles and
    palette: 24.7 of the 148.1 MiB uploaded are byte-identical copies (`data/evidence/browser-m1-low-try2`).
    Key decoded KTX2 textures by content hash in the loader and reuse the first. Acceptance: the browser check's
    duplicate figure is 0 and the uploaded total drops by the same amount.
17. **Transfer to first control is over budget.** The plan caps it at 20 MB (low) and 30 MB (standard) for the
    pilot, which loads completely at start; release `senate-20261016-d9a3be1f` is 62.3 MB, of which the cell GLBs
    are 53.5 MB and their KTX2 textures 50.6 MB (UASTC facades dominate). At 20 Mbit/s that is about 25 s to control
    against 12 to 15 s. The building realism pass (decision 0003) raised the release to 66.4 MB and the transfer to
    66.7 MB (`docs/benchmarks/building-realism.md`); its facade sharpening costs about 1.4 MB and can be dropped
    first if the budget needs it. Dropping the 2017 mesh (decision 0004) brought the transfer to 63.4 MB; the Cathedral
    model, stairs, terraces, walls and the 10 hi-res facade pages (decision 0005) raised it to 76.3 MB
    (`docs/benchmarks/square-surroundings.md`). Options in the plan's order: lower the facade texel cap one step, encode facades as ETC1S
    instead of UASTC, or load the start cell ring first and the rest after control (the M4 streaming rule).
    Acceptance: the browser benchmark gates transfer before first control at both presets. Evidence: the benchmark
    record with facade captures at the same fixed cameras before and after.
    Decision 0023 (23 October 2026) sizes the current options for the 942.9 MB published world: ETC1S facades,
    the M1 copies as the Standard tier, a quarter-resolution tier only after 26 MB is freed, terrain chunking.
    Still an owner decision.

## P2

18. `C:\data` is an empty folder left by a Blender script that resolved an output path from the drive root; the
    script should use repository-relative paths, and the folder needs a manual delete (protected path).
19. ~~`DATA-002`~~: resolved by decision 0005; the terrain and the origin height come from the city terrain layer.
20. LOD1 and LOD2 per cell and collision-first streaming before M4.
21. Inherited evidence from the previous repository (`data/evidence/pilot-v1-run*`, `proof-*`, about 240 MB):
    decide whether to delete.
22. Scene queries in the sim are valid only after the first physics step; `groundPoint` silently falls back to
    the terrain grid before that. Either step once in the constructor or make the fallback explicit.
23. The build-time texture estimate (`tools/world/build_cells.ts`) counts ETC1S at 0.5 byte/texel and shared
    textures once; on a BC7-capable desktop three.js transcodes ETC1S to BC7 (1 byte/texel) and the runtime loads
    every cell's copy, so the estimate reads 97 MiB against 148 MiB measured. Count both cases so the build gate is
    not the optimistic one. On release `57f007bf` it reads 103.5 MiB against 144.8 MiB measured; with 28 hi-res
    pages it read about 130 MiB while the low preset measured 175.4 MiB and failed (decision 0005).
24. `Simulation.recoverVehicle` faces the recovered car along the first segment of the nearest lane rather than
    the segment at the nearest point, so on a curved lane the car can come back pointing across the road. The
    journey harness now uses recovery (decision 0002), so fix it with a Node test on a curved lane.
25. **Untextured LoD2 buildings are flat-coloured boxes.** Aleksanterinkatu 14–18, Snellmaninkatu 8 and one part of
    Rauhankatu 17 have no facade texture in the city's textured LoD2. Since decision 0004 (buildings solely from
    the textured LoD2, no mesh photo bake) they take flat wall and roof colours; since decision 0005 the walls are
    lit plaster (the 80th to 90th luma percentile of the textured walls) rather than the grey-green median, but
    they are still windowless boxes. A newer LoD2 snapshot with textures for them would replace this without code
    changes.
26. ~~**Journey harness fires into its own car.**~~ Fixed on 2026-10-16 in `tools/verify/play-journey.ts`; the gate
    passes 10 of 10 on release `57f007bf` (`journey-57f007bf-4`, `docs/benchmarks/square-surroundings.md`). On
    release `9ef28d77` it stopped twice at run 2 (`journey-lod2only`, `-2`) and on `57f007bf` at run 1 (all 10 shots
    hit car-1 at (63, 43.5), the officer 2.6 m behind it). Three changes: the player steps clear when car-1 lies on
    the line to the officer (`stepClearOf`); on Unioninkatu the harness waits until the patrol car is in direct
    range instead of chasing it the long way round one-way Unioninkatu (`waitForPatrol`; `journey-57f007bf-2` run 2
    stalled at (60, −140)); and that wait holds the handbrake, because S held at a standstill reverses
    (`journey-57f007bf-3` run 4 backed 50 m west off the ground collision; backlog 31).
27. **Car visual meshes fail the hero-asset census** (`data/evidence/census-20261016`, specs in
    `content/assets/census/`): 17 flipped edges on the body and 4 on the front doors, interior non-manifold edges
    (body 413, interior 60, doors 27 each, steering wheel 4, each procedural wheel 32) and 8 degenerate faces on the
    patrol body. Collision is a box, so driving is unaffected; flipped faces can show as holes or dark patches.
    Repair in `tools/blender/build_game_car.py` (`bmesh.ops.recalc_face_normals`, `dissolve_degenerate`, wheel
    construction) and rerun the census, `verify-glb.ts` and the browser check.
28. **Square surroundings, remaining shape limits** (decision 0005): terraces follow the terrain's contours, not
    rectangular flights with cheek blocks; the café terrace top takes the fallback yard finish; a sliver remains
    where the west stairs meet their retaining wall; thin stretched LoD2 wall strips on the Government Palace's south
    facade; overlapping YLRE street parts on the square; the University reads paler than in Street View.
29. ~~**2017 mesh leftovers.**~~ Deleted on 2026-10-16 at the owner's decision (decision 0005): the raw mesh
    mirror, `data/work/pilot-v1`, the pilot-v1 mesh tools and their tests, `tools/world/lib/objmesh.ts`, the 13
    superseded releases and the intermediate `data/work/m0` builds (3.3 GB). Only `senate-20261016-57f007bf`
    remains, so older journey recordings no longer replay.
30. `content/helsinki/cells.json` `atlasNote` reads "4096Â²" (a UTF-8 "²" decoded as Latin-1 and saved again).
31. **The road graph runs past the ground collision, and the pilot edge has no barrier.** The terrain grid and its
    collider cover x −100 to 150, z −290 to 210 (release `57f007bf`); 103 lane points lie outside it, on every side
    (Unioninkatu 22, Pohjoisesplanadi 14, Aleksanterinkatu 6, Kirkkokatu 6, Yliopistonkatu 4 and others). A car that
    drives on falls out of the world: in `journey-57f007bf-3` run 4 the harness reversed west along Aleksanterinkatu,
    left the collision at x ≈ −104 and fell; recovery put it back on the nearest lane point, (−115, 58), also
    outside, so it fell again every few seconds for 40 s (traced with a Node replay of `run-04-recording.json`).
    Clip lanes and recovery points to the collision extent, and close the edge with a barrier collider. Acceptance: no
    lane or recovery point outside the ground collision; a Node drive off each street end stops at the barrier.
32. **HUD stats text is empty before play** (found in the weak-GPU pass, decision 0023). In the production build the
    `#stats` line stays empty on the loading screen while the game is paused, so the tier and frame interval cannot
    be read before the player starts. Acceptance: the line shows the current tier and resolution as soon as the
    world is ready. Evidence: a production-shell capture of the loading screen.
33. **Weak-GPU tiers on real hardware** (decision 0023). The tiers and governors were measured on SwiftShader and an
    RTX 3070 Ti only. Fixture: one Intel UHD/Iris laptop, one AMD APU, one mid-range Android phone and an iPhone with
    `tools/verify/probe-weak-gpu.mjs` (or the HUD stats line on phones). Acceptance: Automatic picks Low on each, the
    governor settles within 30 s without oscillating, and no tier change leaves missing cells. Evidence: probe JSON or
    HUD captures per device.
34. **Minimal-tier mip drop applies to new loads only** (decision 0023). Textures resident when the tier drops keep
    their top level until their cell is evicted, so memory falls gradually while the player moves. Reloading resident
    cells would free it at once but costs a visible reload. Decide after the hardware measurements of item 33.
