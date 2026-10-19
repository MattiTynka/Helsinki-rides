# Finn's car motion, camera blend and passenger-side exit

Status: implemented and verified locally, 2026-10-18. Supersedes the motion and exit parts of
[decision 0014](0014-finn-vehicle-entry.md); its approach, staging and safety rules stay. See
[the benchmark](../benchmarks/finn-vehicle-motion.md). The both-doors-blocked rule in point 2 is replaced by
[decision 0020](0020-finn-always-gets-out-of-the-car.md) (windshield, flipped-car and squeeze-out exits).

The owner asked for a better way in and out of the car: "the way his legs bend is super creepy". The 0014 exit
was the entry played backwards, and the camera switched between the on-foot and car rigs. When police boxed in the driver's door, F only reported `vehicleExitBlocked`.
That stopped the journey gate at 5/10 (decision 0016).

1. **Three authored clips, no reversed playback.** `tools/blender/build_finn_vehicle_poses.py` writes `enter`
   (3.8 s), `exit` (2.8 s) and `exitPassenger` (4.3 s) to `content/assets/finn-vehicle-poses.json` (schema 2).
   Knees track over the toes and fold forward. Each foot carries a world-planted or shin-following orientation,
   and the joint ranges are checked against anatomical limits on every frame. Only an interrupted exit runs backwards.
2. **Passenger exit.** F tries the driver's door first. If that doorway, its standing stage or the upper
   door samples are blocked, it tries the passenger side with the same clearance rule, mirrored. Finn climbs
   across the cabin (left hand on the wheel, right hand on the passenger cushion, a perch on the console armrest, one
   leg and then the other over the low console ahead of the cushions), then plays the mirrored driver exit through
   `DOOR_FR`. The clip ends facing the rear, mirrored. Both doors blocked still gives `vehicleExitBlocked`, and the HUD
   says so.
3. **Camera blend.** The chase and on-foot rigs blend on the interaction clock. Entry eases in over the last
   45% of the clip, and an exit eases out over the first 60%. Both share one heading, so the camera swings round
   behind Finn instead of cutting through the car. While the car layer poses Finn, the on-foot rig follows his
   rendered hips, not the hidden capsule.
4. **Interaction progress is interpolated per frame**, like positions, so the pose and the door do not step at the
   60 Hz tick.

Car-local metres as in 0014 (+X driver side, +Y up, +Z forward). The standing stage moved to `[1.45,0,-0.95]`.
Pose rules that cost several iterations:

- Contacts (foot, grip, door ride and the other HELD params) hold their value until the key just before their next
  key. A new key anywhere changes that interval. Key every intermediate contact value explicitly.
- A riding hand blends a static grip toward the door-borne point. Both must describe the same point at the start of
  the blend, or the wrist sweeps through the cabin.
- The auto palm faces `pn`, with the fingers following the forearm. A `pn` parallel to the forearm degenerates. Twists
  beyond ±180° wrap and show as a flip; the per-sample discontinuity test (<0.65 rad) catches them.
- The centre stack is solid from the floor to the dash for z 0.3–0.6. Only the low console ahead of the cushions
  (z 0.0–0.2, top about 0.62–0.68 m) can be stepped over.

Acceptance: native-rig joint checks pass, with no per-sample rotation jump of 0.65 rad or more. Skin clearance of
the packaged skin against the packaged car is measured at every 30 Hz frame, not a coarser stride. The visual
sheets are opened. The real-keyboard browser entry/exit passes. The passenger exit is played in the browser from a
real-control drive against city geometry, with a matching Node hash. The journey gate passes with exact replays.
