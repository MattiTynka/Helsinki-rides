# Flight systems implementation plan

Goal: make aircraft impacts produce physical crashes, show farther neighbouring
city cells while flying, keep the minimap useful in streamed areas, and provide
a small compass above the minimap.

The starting implementation has an arcade kinematic flight controller, finite
detail/fallback streams, live cells outside the static release, and a north-up
minimap. Preserve that structure and the existing fixed-step simulation.

## Behavior and architecture

- On a real impact, transfer an aircraft to a dynamic Rapier body using its full
  orientation and pre-impact momentum. Contacts should make it skid, bounce and
  roll. Crash state continues without an occupant. Ordinary landings receive
  cushioning; unavailable streamed cells remain a loading hold, never an impact.
  Reuse existing vehicle damage/event patterns with bounded contact damage.
- Keep session-fixed visual LOD backends. During flight, widen only the coarse
  stream with a protected near ring and a forward camera sector. Standard targets
  a 900 m horizontal reach, Low 700 m, Minimal 520 m and mobile Low 560 m.
  Candidate windows, max-cell limits, fog and clipping must follow the same
  policy. Preserve each stream's geometry allowance, texture admission and bounded
  workers, including reservations held by cancelled GPU preparation.
  Live coarse views use session-fixed colour-only massing; nearby detail retains
  facade textures. This lets the wider sector fit the existing texture slices.
- Draw minimap context from the initial release and actual cached live ground,
  water and collision-building geometry. Late arriving data must replace empty
  tiles. Retain bounded map canvases rather than requesting a second map stream.
  Increase the map's useful range in flight, and display a compact cardinal
  heading above it using the aircraft heading while flying.
- Preserve model sources, acknowledgements, privacy scans and production test-API
  exclusion. Model bytes and the pinned world release need not change.

## Work and ownership

- [x] Simulation: crash handoff, contacts, damage, grounded recovery and moving
  wreck collision residency, with focused regression tests.
- [x] Rendering/streaming: optional sector selection and a tier-composed flight
  profile for static and live streams; actual farther-cell residency tests.
- [x] HUD: actual release/live map context, delayed-data invalidation, bounded
  map caches, flight zoom and heading compass, with cardinal/coverage tests.
- [x] Integration: stop driven rotor motion after a crash, expose appropriate
  crash prompts/sound, and preserve pilot alignment to the dynamic rotation.
- [x] Verify real flight, sharp turns, normal landing, physical impacts, minimap
  arrival in a new live area and tier changes; prepare the production build.

Publish the audited exact source commit through the existing Pages workflow and
check its deployed receipt and shell hashes. Deployment evidence stays with the
release run, rather than requiring another source commit to record its own hash.

Simulation and HUD changes have separate file owners; the integration owner
handles Game, cell selection, live-window policy, rendering, release and evidence.
Each subsystem gets a failing focused reproduction before its behavior changes.

## Acceptance

Aircraft crashes retain momentum and settle physically; missing-cell holds do
not crash. Normal keyboard landing remains playable. More coarse cells actually
become resident ahead in flight under hard geometry/texture limits and restore
ground behavior on exit. Live territory gains map surfaces/buildings after its
data arrives. Cardinal headings agree with X east/Z south coordinates, and the
compass stays readable on mobile. Source, release, privacy and browser gates must
pass before the exact commit is pushed and deployed.
