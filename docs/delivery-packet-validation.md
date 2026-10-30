# New-cell delivery validation

`tools/verify/verify-delivery-packet.mjs` validates a native cell packet against its new-only delivery derivative and the immutable accepted world. It requires all three expected SHA-256 values and a fresh evidence directory disjoint from every input directory. It does not modify input assets.

Run from this source checkout. This is the actual first-packet command, using the archived detailed-plus-distant native input:

```powershell
node --expose-gc tools/verify/verify-delivery-packet.mjs --native ../work/stage-a-native-with-distant-v1 --optimized ../work/stage-a-delivery-v2 --accepted ../accepted-world/world/senate-20261025-civilian-flee --expected-native-index 334e5e29101fae3bea1c134f6918048f36dd85890650e3741409bf63a195123d --expected-optimized-index dc870cb2c72c3ad6a9701b40c703a8d747265f234a7ee21d18b30a65cb5fa7c8 --expected-accepted-manifest 0e18e55e8730f01144eef72a80decffbb53cdd658222f87a7e8ad6f75f2c4260 --out ../evidence/stage-a-packet-check-fresh
```

The validator checks complete optimized and accepted payload inventories, unique and equal cell sets, owner exclusions, decoded collision identity, GLB validation, near geometry and attributes, coarse geometry preservation, material/node invariants, encoded Standard/Low mip bytes, draw budgets and unchanged inputs/validator sources. It permits a new packet to contribute new owners to an existing edge cell; accepted building identities remain forbidden. Appending and proving that combined cell is a separate gate.

Geometry comparisons reuse the native optimized-world verifier's predicates in `lib/delivery-packet-oracle.mjs`. The only texture identity mapping is independently justified by exact retained encoded mip bytes. Changed coarse faces use the native bidirectional sampled error checks; this is not a continuous Hausdorff proof.

A passing result is `PASS_STATIC_DELIVERY_PACKET_PENDING_WORLD_APPEND_AND_RUNTIME`. It does not certify final terrain/frontier composition, tree soil, navigation, bridge levels, browser appearance, real controls or performance. `bindings-before.json` and `result.json` record the actual files and limits. Later packets require their own exact paths and hashes; do not reuse the first packet's success or pins.

Protected existing trees can be selected for inspection with either legacy whole-width `bands` or explicit XZ `regions` in `inspect_delivery_frontier_trees.ts`. Use the final append receipt's replacement rectangles for western/corner work. Selection uses the complete transformed canopy envelope, including overhang; it never moves existing anchors or colliders.
