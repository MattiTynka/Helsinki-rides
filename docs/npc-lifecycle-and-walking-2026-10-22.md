# NPC death and pedestrian movement

This correction continues from deployed source `6537f59` and retains the world
selected by `content/releases/pages.json`. It changes simulation and presentation
code; it does not add model downloads, textures or animation payloads.

Lethal damage now publishes the death state and stops horizontal walking in the
same tick, including vehicle contacts resolved after pedestrian AI. Snapshots
include the fixed-step time since death. The renderer gives that terminal state
priority over an old walking clip and samples the collapse from simulation time.
Once on the floor, a dead actor stays there until normal corpse retirement.
Creating another view of an existing corpse does not replay a standing pose.

A fatal hit during an existing knockdown continues toward the floor from the
displayed pose. It cannot run the surviving actor's get-up backwards into a
standing corpse. Paused renders hold their pose. A genuine reset or respawn with
`alive=true` starts normal animation again. Surviving, nonlethal knockdowns still
recover; this change does not make every pistol hit lethal.

Pedestrians now finish turning to within about seven degrees of travel before
stepping. Their checked route direction and native support/traffic probes stay
authoritative. Planned route-end stops brake at two metres per second squared,
then pause and reverse. Unsupported ground and obstacles still stop movement
immediately.

Route progress now follows the capsule's actual position along a bounded local
part of its assigned path. Previously, sideways controller corrections counted
as forward progress. A small accumulated error could alternate endpoint and
lookahead reversals forever, leaving a pedestrian standing still. Projection
uses cached route segments and retains the native movement safety checks.

Each civilian gets a deterministic identity-based gait phase, keeping the existing
distance-matched cadence and source loops while avoiding synchronized steps.
Small head and chest corrections anticipate turns; they restore before the next
mixer sample and never alter the hips or feet. They are disabled during hits,
collapse, airborne motion and vehicle poses. No correction accumulates between
frames or advances while paused.

Regression checks cover lethal hits during falling, floor hold and recovery;
same-tick lethal vehicle impacts; recreated native and legacy corpse views;
repeated terminal and paused samples; real respawn; gait phase/cadence; procedural
restoration; and a sixty-second supported route with repeated, bounded stops and
reversals. `tools/verify/verify-npc-lifecycle.ts` adds actual-game walking, stopping,
turning and lethal-shot captures for the black Rain, white Rain and original Snow
civilians, including late death poses and paused renders. Its player placement
fixtures are recorded separately from normal movement and firing inputs.

The keyboard journey pauses during offline replay preparation and starts each
run from a fresh seed. Disk and CPU preparation time no longer advances patrols
before the measured run; movement, timing, frame-rate and replay requirements
are unchanged.

The existing web delivery policy in
[the handoff](handoff-2026-10-20-web-delivery.md) continues to apply: bounded
streaming, compressed assets, preserved attribution and the unchanged audited
world packet. Screenshots and device measurements remain candidate-specific
evidence rather than proof of every street, rig or device.
