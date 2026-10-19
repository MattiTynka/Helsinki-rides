# House of the Estates facade reconstruction

The production inputs are `front-2021.jpg`, `park-2022.jpg`, `wall-mapping.json` and `credits.json`. The original licensed JPEGs are immutable. The shared facade authoring loader validates their SHA-256 hashes and decodes them once; `tools/world/lib/estates-facade-restoration.ts` deterministically projects samples through the original wall UV triangles. No network request is required to rebuild.

The 2021 front and 2022 rear photographs are by Josefiina Alanen, CC BY 4.0. See `credits.json` for titles, source URLs, license URLs, hashes and changes. Preserve the attribution in runtime credits and any redistributed derived facade textures.

Other DSC05064/05070/05072 photographs and RGBA preparation experiments here are research inputs, not production dependencies. Their CC0 metadata is retained in the two Commons metadata files. The south reference and official restoration report remain in evidence only; their pixels are not used.

The original photogrammetric UV walls were fully scaffold wrapped. Front projection preserves the four columns, three doors and unique crest. Rear restoration preserves five tall arches and triplet clerestories; side restoration uses three rectangular recessed upper bays and separate projecting corner bays, shorter middle rectangles and small basement arches. Foreground occluders are reconstructed from clean exact-building donors. This restores photographic architectural legibility on existing planar geometry; it does not sculpt the portico.

Native close and oblique review is required before accepting the generated atlas. The source rooftop page 57 and geometry/colliders remain unchanged.
