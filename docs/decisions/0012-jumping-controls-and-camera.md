# 0012 Finn jumping, control directions and camera alignment

Date: 2026-10-17. Status: accepted and activated locally; PASS for the requested changes.

The owner requested realistic jumping onto raised surfaces, a quick double-Space
super jump, correct A/D movement, alignment between aiming and the crosshair, and
removal of the doubled/unfocused appearance during running and driving. This
explicitly supersedes the original implementation plan's exclusion of jumping.

The starting content is `senate-20261017-15933497`. Keep Finn's accepted geometry,
skin repairs, native gaits and all city/collision payloads unchanged. New jump
poses are authored against Finn's actual native skeleton and follow the
collision controller. The simulation owns vertical displacement and landing;
animation does not move the player through geometry.

Space on foot starts one normal jump. A second distinct press within 0.28 seconds
upgrades that jump once. Holding Space cannot repeatedly jump or boost. Space
continues to operate the handbrake while driving. Normal apex is approximately
0.9 metres and super-jump apex approximately 2.8 metres above takeoff. The latter
is an intentionally exaggerated ability. Raised surfaces must actually support
the capsule; ceilings and walls remain solid.

The on-foot input basis must agree with screen left/right at every camera yaw.
Aim resolves the actual camera-centre ray against the world, then fires toward
that target from Finn, preserving obstruction and deterministic command replay.
The rendered body, vehicles and camera must share the same interpolated
simulation instant. Simulation, gameplay events and replay hashes remain
authoritative at 60 Hz.

Acceptance: meaningful input/physics/interpolation/aim/animation tests; actual
keyboard single/double/held jumps and elevated landing; runtime pose inspection;
aim/obstruction checks; running and driving frame measurements; applicable native
graphics/journey/replay checks; ordinary-build default-URL smoke. Record source
hashes and unchanged release payloads under
`data/evidence/finn-jump-controls-20261017/`. Keep one server on port 5317.

Final evidence: 134 tests, typecheck, 21 focused browser checks, 56 reviewed jump
captures, both graphics presets, ten gameplay journeys with matching replays and
ordinary default-URL smoke all pass. The ordinary build is `index-Cf8lbKo4.js`.
The preview was restarted on port 5317; no listener remains on 4317. All 116 frozen
source files and 41 unchanged release files are hash-bound in the completion record.
See [the benchmark](../benchmarks/finn-jump-controls.md).
