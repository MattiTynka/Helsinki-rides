# Verification and acceptance

## Evidence types

| Evidence | What it establishes | What it does not |
| --- | --- | --- |
| Offline helper tests | Parsing, checks, math and mocked orchestration | A Blender or browser integration worked |
| Blender probe / saved-scene QA | This executable and scene evaluated the measured outputs | Export/runtime equivalence or game performance |
| GLB/manifest checks | Declared structure/counts and actual file hashes | Visual quality, semantic correctness or full format conformance |
| Mesh census | Non-manifold, flipped, loose, degenerate and self-overlap counts, shells, size and transforms of the measured objects on the stated Blender release | Appearance, collision behaviour, materials, glTF conformance or that the right objects were exported |
| Opened runtime captures | Appearance of the recorded build/view/state | Reachability through player controls |
| Real-control journey | The tested interaction path works | Every mission or every device works |
| Device performance trace | Measured frame times and resource behavior on named hardware | Mobile performance from desktop emulation |

Bind evidence to source revision, content hash/build ID, browser/version, device, graphics preset, viewport, seed and route. A new asset export invalidates evidence for affected visuals/performance. Store concise observations and unresolved defects; do not manufacture approvals or label budget targets as achieved measurements.

## Target budgets inherited from the project plan

These are provisional targets, not observations from the skill audit:

| Preset | Target | p95 frame time ceiling | Visible triangles | Draw calls | Resident texture budget |
| --- | --- | --- | --- | --- | --- |
| Low | 720p, 30 FPS | 40 ms | 500,000 | 350 | 256 MiB |
| Standard | 1080p, 60 FPS | 22 ms | 1,200,000 | 600 | 512 MiB |

A p95 ceiling allows occasional slower frames; it is not a guarantee that every frame achieves the nominal FPS. Record p50/p95/p99, long tasks, upload/decode/collider costs and retained resources over a repeated route. Initial playable content target: ≤20 MB transferred and ≤15 seconds at 20 Mbit/s under an explicitly stated latency/cache setup. The network-only lower bound is not the load-time measurement. Texture budget means estimated GPU residency, not compressed file bytes. Establish a concrete reference laptop/browser before claiming either preset passed.

## Required scenarios for the slice

1. Confirm coordinate marker, geographic control points, scale, north and height after GLB export/import. Census collision meshes and hero assets numerically before any visual review.
2. Fresh start with real keyboard/pointer controls: walk, run, enter car, accelerate, turn, brake, collide, recover, exit, finish a delivery. Also fail/retry and save/reload. Inspect pointer-lock and focus behavior.
3. Cross tile seams at maximum permitted speed, brake/turn back, retry a failed request, simulate slow fetch/decode, unload/reload and resume from a hidden tab. No unsupported actor or vanished ground.
4. Inspect a sidewalk, curb, stair/accessible route, junction, bridge/underpass when present, waterfront boundary and landmark from reachable cameras.
5. Validate near NPC navigation and car lane connectivity separately, including blocked routes and no crossing between road levels. Verify pursuit loses/reacquires using its intended information.
6. Repeat the route long enough to expose retained GPU resources, duplicate colliders, ghost NPCs and accumulating jobs. Record actual duration; do not call a short pass a soak test.
7. Reopen production output from a fresh load, verify asset identity, remove dev-only state mutators, check credits and loading/error recovery. Run only affected checks for small later edits.

## Optional capture adapter

Expose a development-only test API (for example `window.__GAME_TEST__`) with a compiled build ID that includes asset identity. Use named scenarios such as `senate-square`, `street-seam`, `vehicle-entry` and `npc-walk`. Wait for required tiles, textures, shaders and a real rendered frame. Compile the adapter out of production; a query parameter is not a production access-control boundary.

Drive captures with a pinned project Playwright dependency and allowed browser tooling. Capture only loopback same-origin content and block cross-origin requests and service workers; that does not verify a CDN deployment. Write each run to a new directory. A capture is not reviewed until you open the images and record observations. State-reset/teleport scenarios remain separate from real-control journeys. Follow the active environment's browser restrictions even if this helper is available.

## Bundled helper regression checks

```bash
python SKILL_ROOT/scripts/test_pipeline.py
```

These tests intentionally need no Blender executable, network, credentials or paid provider. They cover geospatial precision, invalid inputs, manifest integrity/paths and census-spec checks. Run a Blender render probe, export round trip, real browser journey and target hardware tests separately when available.
