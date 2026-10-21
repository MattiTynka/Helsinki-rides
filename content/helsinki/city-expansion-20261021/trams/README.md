# New-strip physical tram source selection

`source-selection-v1.json` accounts for every mapped physical tram way intersecting the new north and south strips. It is a source selection, not a rendered-coverage claim. The exact licensed geometry is in `../osm-public-v1.json`. See `source-ledger-v1.json` for the ODbL notice and pinned acquisition chain.

The public-street candidates retain the source 1,000 mm gauge, original way node order and exact projected XZ coordinates. The two strip bounds clip rendering without modifying the source ways. Twenty-one accepted way continuations require decoded existing-ribbon subtraction at the boundary. The accepted interior remains protected. Thirty-three `service=yard` depot tracks are explicitly outside this public-street overlay scope. Two `bridge=yes`, `layer=2` ways over Junatie need separate final deck, collision and bank qualification. Original source records are retained for both holdback groups.

HSL and Street View are reference-only. The HSL map establishes recognizable corridors; it is schematic and supplies no placement or elevation. No reference image pixels are distributed.

The immutable `tools/world/prepare_delivery_tram_profile.ts` and `tools/world/apply_delivery_tram_visuals.ts` remain the delivery producers. A final profile must bind the actual expanded manifest, publish its selected geometry extract, preserve the accepted rail masks, prove matching rendered/HCOL and coarse-tier support, and meet existing budgets before application.
