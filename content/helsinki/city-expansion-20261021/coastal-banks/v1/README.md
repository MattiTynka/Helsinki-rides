# Native coastal bank closure

This pass closes visible gaps below the municipal ground at real water
boundaries in the new northern strip. It runs after inland-water separation.
It uses the public OpenStreetMap v3 source and the exact inland v2 profile
hashes in `profile.json`. The ground remains City of Helsinki CC BY 4.0 data;
water boundaries retain OpenStreetMap contributors' ODbL 1.0 attribution.

The existing coastal qualifier finds the highest encoded dry ground edge at
each canonical water boundary. It subtracts existing vertical coverage and
preserves open wet-side bridge and pier spans. Each supporting visual triangle
must have a literal collision twin. Artificial map-rectangle edges cannot
authorize a quay, and the accepted old strip cannot receive new walls.

New faces extend exactly vertically from that native cut to the existing sea
plane. They reuse the corresponding ground material. Both winding directions
are present in rendered and solid geometry. The builder appends geometry and
collision data while retaining original GLB buffers, accessors, resources and
collision prefixes. It does not move horizontal floors, change the coastline,
change the sea elevation, or alter the terrain, road graph, scenery or gameplay.

Run `tools/world/close_delivery_coastal_banks.ts` with an immutable input world,
its manifest hash, the public OSM source, this profile and its exact hash, and
a fresh output directory. The world must already carry the qualified inland
v2 profile. Each changed GLB passes structural validation. The public receipt
records the source floor triangles, shoreline qualification, preservation
proofs and producer inventory. Existing delivery limits remain mandatory.

Acceptance also requires native physics side probes from both directions,
exact preservation of unrelated payloads and Standard/Low visual review. A
nearby unchanged original wall can intercept a side ray first. Such an
occlusion must reproduce the same native hit in the original world and the
new triangle must separately pass the unchanged 1 mm native hit gate. These
cases are recorded individually; they cannot excuse missing new collision.
Final release checks bind these results to the complete combined world.
