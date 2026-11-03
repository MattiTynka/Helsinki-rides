# Flight smoothness correction

Baseline: source `3834f9cc579641644671a4049dbce9fa94f394cc`, with the
existing pinned world and optimized aircraft models.

## Measured causes

A sustained keyboard flight reproduced freezes. A Chromium CPU profile with
fourfold CPU slowdown identified two separate costs:

- Live minimap triangle painting explicitly closed every triangle in a growing
  path. Native path closing dominated eight large frames at successive 128 m
  map rows. Omitting explicit closure retains the same filled subpaths and
  removes that repeated cost. A real canvas comparison must preserve every RGBA
  byte for terrain, water, surface classes and building footprints.
- Failed ground-police dispatch at aircraft altitude fell back to two full road
  scans, then retried after 15 simulation ticks. The level-aware lookup must use
  the existing spatial segment index, retaining the three-metre elevation
  tolerance, accept sets, heading ranks and graph-order ties.

The minimap-disabled diagnostic removed the multi-second stalls but retained the
road-search spikes. Hiding the HUD with `hud=0` is not an equivalent diagnostic:
it leaves the minimap painter running.

## Loading strategy

Keep the expanded coarse view and its existing hard budgets. Nearby detail
retains facade textures. The fixed distant backend requests a coarse worker
payload: no unused image copies or UV arrays, and matching colour-only parts
are combined before main-thread geometry construction. The full converted-tile
cache remains intact so a coarse request cannot degrade subsequent near detail.
Collision bytes, source geometry, model assets and world pins remain unchanged.

Do not increase the upstream geometric-error number blindly: selecting a larger
source parent tile does not guarantee fewer retained triangles in a cell.

## Verification

- Regression coverage for local police lookup work, stacked roads, inclusive
  level boundaries, ranking equivalence and current accept membership.
- Minimap empty-result caching remains bounded and refreshes on late input.
- `node --test tools/verify/verify-flight-minimap-canvas.mjs` explicitly runs the
  real-browser pixel and timing comparison; it requires installed Chromium and
  is separate from portable source unit tests.
- Coarse/detail assembly tests verify unchanged source arrays, exact geometry,
  no coarse images/UVs, and full detail after a coarse request.
- Repeat sustained keyboard flight, recording actual presentation times,
  simulation progress, loading counters and CPU samples. Record the slowdown
  proxy separately from ordinary browser performance. Verify the public build
  after source/privacy checks and the existing Pages deployment gates.

Run the sustained-flight check against a pinned review build with an installed
Chromium browser:

```sh
node tools/verify/verify-flight-smoothness.mjs --out <fresh-directory> --preset low
```

It requires continuous simulation progress, bounded samples, a 50 ms frame p99
and a 100 ms maximum by default. Explicit CPU slowdown and profiling options are
diagnostics and must be labelled separately from ordinary performance results.
