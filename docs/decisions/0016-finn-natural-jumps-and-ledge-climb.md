# 0016 Natural Finn jumps and a ledge grab-and-pull-up

Date: 2026-10-17. Status: implemented and verified locally. See
[the benchmark](../benchmarks/finn-jump-climb.md).

The owner asked for Finn to jump, and especially super jump, and climb more
naturally. They chose a GTA-style ledge grab and pull-up. Stairs and per-foot
terrain placement stay out of scope. This supersedes the "no hand-led mantling"
boundary of [0012](0012-jumping-controls-and-camera.md). It also replaces the
earlier rule that a normal jump cannot get onto a 1.4 m platform.

Content stays `senate-20261017-15933497`. Finn's accepted GLB
(`c54802ad…fe86`), skin, the eleven native gaits and every world payload remain
byte-identical. The new motion is authored data on Finn's actual 71-joint rest
hierarchy, in `content/assets/finn-jump-poses.json` (pose format version 2).

1. **Jumps.** Each normal and super phase has a standing variant and two running
   variants, one per push-off foot. The running variants are latched when the
   feet leave the ground. A long super-jump flight crossfades into a looping
   `air_loop` instead of holding one frozen pose. Landing strength follows the
   simulation's impact speed. A hard super landing uses its own absorbing pose,
   and running landings hand the stride phase back to the gait.
2. **Ledge grab (simulation).** A rising or falling jump that moves toward a
   wall grabs a top 0.3–1.5 m above the current feet when all of these hold:
   - the apex would not clear the top by 0.15 m;
   - a wall face lies within 60° of the movement direction;
   - flat standing support exists beyond the edge;
   - swept capsule casts are clear from the grab point to the top.

   This gives ledges up to about 2.4 m above the take-off ground for a normal
   jump and about 4.3 m for a super jump. Thin walls, fences and slabs over
   the top are refused. The climb takes 0.5 s + 0.5 s/m, rising beside the wall
   and then moving over the edge. It runs through the kinematic controller, so
   if something blocks the path Finn lets go and falls. Movement, aiming, firing,
   reloading and car entry are disabled while his hands are on the ledge.
   A `climb` event is emitted and the climb is part of the replayed state.
3. **Ledge climb (presentation).** Three authored climbs are blended linearly by
   ledge height:
   - `climb_low` (0.5 m) and `climb_mid` (1.0 m) step a foot onto the top;
   - `climb_high` (1.5 m) hangs, presses up, brings a knee onto the edge and
     stands.

   After the mixer, a two-bone arm IK pins both palms to the real edge, weighted
   by each variant's grip curve. The authored hand orientation is kept.

Kimodo (text-free, pelvis-height-constrained) was tried first and rejected.
Its standing and super jumps missed the constrained rise, giving small hops or a
floating body. Only the running jump followed the path, and it looked too stiff
to be an improvement. The repository's CC0 animation clips have no usable jump
or climb. The poses are therefore hand-keyed in Blender with the existing
anatomical two-bone IK, as in 0012.

Acceptance:
- simulation tests for the reach limits, thin-wall/slab refusal and replay;
- numerical pose checks (leg and arm reach, wall contact, bone lengths);
- opened multi-view climb and jump captures at every ledge height;
- a real-keyboard grab at an existing city wall;
- both graphics presets;
- ten gameplay journeys with matching replays;
- content identity for the release files and Finn.

Evidence is in `data/evidence/finn-jump-climb-20261017/`.
