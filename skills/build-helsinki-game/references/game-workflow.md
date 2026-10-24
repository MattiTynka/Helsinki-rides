# Game implementation workflow

Use the user's existing Helsinki implementation plan when available. Defaults here support a compact original urban sandbox, not a full commercial GTA clone. Retain original characters, missions, UI and audio; use licensed geographic data to establish Helsinki.

## Milestones and exits

| Milestone | Work | Exit evidence |
| --- | --- | --- |
| G0 Feasibility | Repo/tools, source ledger, one small city extract, coordinate marker, graybox car | Verified metre scale/north/up, reproducible source conversion, measured small-scene browser load |
| G1 Traversal | Walk/run, camera, collider world, one car, seats/entry/exit, pause/reset | Real controls complete walk-drive-exit loop, blocked-exit handling and collision recovery |
| G2 Helsinki slice | About 500×500 m around Senate Square, recognizable landmark, drivable corridors, tile loader | Four representations align; high-speed seam, failed request and unload/reload checks pass |
| G3 Game loop | One delivery mission, traffic/peds, pursuit/search/escape, local saves | Start/fail/retry/success/reload journey with no fixture-only progression |
| G4 Expansion | Extend the accepted area, reusable prop/vehicle/NPC families, more missions | Same budgets hold over a long route and after repeated loops |
| G5 Release | Production hooks removed, device/browser tests, credits, fresh build | Evidence belongs to shipped code and asset revision; launch path verified |

These are dependencies, not fixed duration promises. If game feel or import performance fails G0/G1, fix it before producing a city full of assets. A five-day feasibility sprint is a planning option; do not label its target dates as completed work.

## Runtime boundaries

Suggested new-project modules: `src/sim/`, `src/world/`, `src/render/`, `src/input/`, `src/ui/`, `src/audio/`, `src/platform/`; offline assets in `art/source`, `art/scripts`, `art/manifests`; outputs under `public/assets` only after validation. Reuse established layouts. Keep Three.js objects and DOM out of authoritative rule state. Typed IDs join visual entities, Rapier bodies and persistent semantic records.

Fixed 60 Hz simulation with render interpolation and bounded catch-up; clear held inputs on blur, pause and disconnect. Consume one-shot enter/interact actions once, not on each catch-up tick. A fixed step alone is not proof of cross-browser determinism. Use seeded randomness only where reproducibility is needed, with separate decorative and gameplay streams.

### Player and car

Define on-foot → entering → seated → exiting states plus recovery. Entry reserves a seat and vehicle; check proximity, relative speed, door access and animation alignment. Exit tests capsule clearance and ground support on alternative points; a blocked exit stays seated with feedback. Move camera/input ownership atomically; repeated input cannot create duplicate occupants or bodies. A door animation alone does not move authoritative player state.

Use Rapier character movement and a measured arcade vehicle controller (raycast wheels or an appropriate simple model). Tune acceleration, braking, steering response, traction, suspension, centre of mass and recovery on graybox streets. Use convex/compound dynamic colliders. Vehicle visual forward and wheel axes must be explicit. Wheel roll comes from signed travelled distance/radius, steering from simulation. Character world movement comes from the controller for in-place locomotion.

### City life and missions

Traffic follows a validated directed road graph, junction occupancy/priority, stopping distances and recovery from blockage. Pedestrians use nav routes plus local avoidance and crossings. Simulate nearby agents fully; use cheaper route progression or suspension farther away. Pool rendering resources without recycling stable mission IDs accidentally.

Police: idle/patrol → investigate → pursue → search → disengage. Use last-seen position and scoped perception rather than omniscient pursuit. Begin with one readable wanted-level loop and recovery. Mission state machines define activation, checkpoints, completion exactly once, failure, retry and persisted progress. Keep mission content data-driven with validated references to places/entities.

Saves are versioned and validated; define migrations, corruption fallback and denied-storage behavior. Pause simulation when appropriate on background tabs. Audio starts with a user gesture. Provide readable retry for failed asset loading and an honest WebGL recovery/reload path.

## Deferred features

Multiplayer, full interiors, destruction, detailed combat, winter/snow and photoreal crowds are separate extensions. If multiplayer becomes required, make authority explicit, serialize commands/state, validate server inputs and plan snapshot interpolation/prediction; do not promise physics determinism across clients. Do not introduce a server merely for local saves.

## Project memory

Maintain a concise current-state file with build ID, accepted geographic scope, origin, source revision, implemented mechanics, target device, last evidence and next blocker. Record consequential choices such as root-motion policy or tile-size changes once in a decision file. Record actual tool/model usage only if requested or needed for cost management; do not hardcode a model choice.
