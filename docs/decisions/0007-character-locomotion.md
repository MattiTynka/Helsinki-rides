# 0007 Character locomotion

Date: 2026-10-17. Scope: improve Snow's and Rain's walk, run and sprint, using the existing game skeleton.

## Motion source and adaptation

Use the free Standard edition of [Quaternius Universal Animation Library](https://quaternius.itch.io/universal-animation-library),
CC0-1.0: `Walk_Loop`, `Jog_Fwd_Loop` and `Sprint_Loop`. The downloaded archive, original in-place and root-motion
GLBs, license and SHA-256 ledger are under `data/raw/quaternius-animation/ual1-standard-20261017/`.
No paid edition, Blender add-on or runtime animation dependency is required.

`retarget_locomotion.py` opens a separate copy of each generated character scene. `locomotion_retarget.py` reads
the source GLB as data, converts its axes, and retargets world-space poses with the target's rest skeleton and
limb lengths. After the owner's rejection, torso balance, collar placement and mean arm carriage retain the
target's original motion; bounded, mean-relative source dynamics are added in the target's anatomical frame.
The original absolute-direction retarget incorrectly copied the source's swept-back shoulders and excessive
forward lean. Leg IK adapts support and recovery to the
game's 1.4/3.6/6 m/s speeds; fitting actual skinned shoe vertices accounts for the different footwear.
The saved scene uses dense 120 Hz LINEAR keys; a deterministic GLB postpass adds periodic walk/run/sprint cubic
tangents after making quaternion signs continuous. Final GLB hashes and
provenance describe this difference from the authoring scene.
The source's exaggerated jogging stride is adapted to the game's cadence rather than slowing playback to match it.
`content/assets/locomotion.motion.json` records this policy. The controller owns horizontal displacement.

Only `walk`, `run` and `sprint` are replaced. Meshes, weights, UVs, materials, textures, rest skeleton, sockets,
and the other seven clips are compared independently against the previous exported GLBs. The original generated
scenes remain inputs; rerunning the base character generator must be followed by the retarget pass described in
`docs/asset-pipeline.md`.

## Runtime movement

All three gaits share one normalized foot phase. Adjacent gaits blend by measured speed, including collision
slowdowns, with stride distance derived from the loaded clip durations. Changing gait does not reset either
foot; stopping freezes the cycle while the pose settles to idle. Full-body reactions retain their existing
one-shot and clamped behavior. Character animation uses the simulation's pause and slow-motion clock.

WASD still runs and Shift sprints. Alt exposes the existing walking speed on a keyboard; diagonal input is
normalized before scaling so Alt plus two direction keys stays at walking speed. Vehicle controls retain their
existing behavior. The same character renderer drives officers.

## World integration

The original motion pass started from `senate-20261016-05811e68` and changed only the characters. The later
owner-reported ground defects are repaired separately in [decision 0008](0008-posture-and-ground-repair.md),
which also records the corrected posture and final combined release. Building geometry and facade images,
roads, gameplay, tree assets/placements, cars and the pistol retain their baseline content. The 2017 mesh
remains removed. Unfinished facade/tree revisions are not included.

## Verification scope

`verify-character-motion.mjs` decodes the exported GLBs independently, compares the preserved content and samples
the skinned shoes and joint transforms at 120 Hz, with additional shoe samples between keys. Loop closure,
boundary derivatives, 120 Hz chord velocities, penetration and inferred support drift are separate measurements.
Finite-interval chord differences include ordinary acceleration; they are not the boundary derivative check.
Near-floor marker intervals are a flat-floor diagnostic; they do not prove
terrain-aware foot placement. There is no terrain foot IK in this change.

`verify-locomotion.ts` records actual Alt/W/Shift/A/S/D/F input, gait transitions, stop, pause, car entry/exit and
a separate natural officer-response fixture. It saves command/state traces, WebM video, timestamped frames and
a normal/slow playback viewer. Its fixture teleport is not evidence of playable progression. The native browser
benchmark and real-control journey remain separate gates, bound to the final release.

## Result

Original visual acceptance: **RETHINK**. The owner rejected the shoulder/torso pose. This exposed a gap in the
original visual review despite passing numerical checks. See decision 0008 for the cause and corrective work.

The withdrawn release was `senate-20261017-fdd3c68a`. Both character motion checks and mesh censuses passed;
native asset checks pass 37/37, controls 31/31, browser checks 8/8 on both presets, and the real-control journey
10/10 with matching offline replays. The ordinary build also passes its default-release keyboard smoke test.
Measurements, source identity, exact evidence locations and limits are in
[the locomotion verification record](../benchmarks/character-locomotion.md).
