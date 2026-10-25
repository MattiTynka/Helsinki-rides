# Helsinki Rides browser beta content

Original project code and documentation: MIT, Helsinki-rides contributors.
Separately attributed assets and databases retain their own terms.

Buildings, terrain, municipal registers and tree data: City of Helsinki,
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), modified and converted
for the game. Exact source identities, versions, changes and credits are in
`../manifest.json`. The removed 2017 city mesh is not included.

House of the Estates photographs: Josefiina Alanen, via Wikimedia Commons,
CC BY 4.0, cropped, reprojected and reconstructed. Pohjoisesplanadi 31 facade
photograph: Marja Valtonen / Helsinki City Museum, CC BY 4.0, modified. The
manifest supplies the individual source records and full adaptation notices.

Snow and Rain base characters: Blender Studio, CC BY 4.0, modified. The native
player Snow and Poliisi Rain are supplied adaptations. The supplied native movement
exports record NVIDIA Kimodo provenance; the generator code's license is not
represented as a license for its model checkpoint or motion output. The
checkpoint revision was not supplied.

Lumi GT and the patrol car are adapted from
[Ford Mustang Gt 500 With pro Rig FOR FREE!](https://sketchfab.com/3d-models/ford-mustang-gt-500-with-pro-rig-for-free-f26a29f766844f46910547d6d2cc291d)
by [NoOb StUfFs](https://sketchfab.com/NoObStUfFs),
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
Revontuli is adapted from
[Bugatti Veyron fully rigged.](https://sketchfab.com/3d-models/bugatti-veyron-fully-rigged-5ca18dc84d074655966a6fe7165aa157)
by the same author, CC BY 4.0. Author and license identities were verified
against Sketchfab's public API on 20 October 2026. The game removes brand marks,
lettering, number plates and source textures; modifies geometry, materials,
wheels and cabin fit; and adds gameplay sockets and fitted Snow interaction poses.
The patrol variant adds its own paint and lamps.

Helsinki Cathedral: original model by Dany Sánchez / MiniWorld3D, optimized
by Jukka Seppänen (@kijaidesign),
[original model listing](https://www.printables.com/model/486571-helsinki-cathedral-finland).
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) according to the
project owner's declaration for the supplied model. The game adapts scale,
placement, materials and baked lighting. The exact supplied version's original
license remains to be independently retrieved; authorship is corroborated.

Kaamos / GT40 is excluded from this packet following the project owner's
20 October 2026 report that its source restricts redistribution.

The Alexander monument, custom character modifications and movement exports
were supplied by the project owner, who requested public game distribution and
will provide the remaining copyright information. Complete redistribution
terms for these remaining supplied adaptations are pending. This notice does
not grant new rights in third-party assets. Exact evidence and adaptation
records are in the repository's
[asset credit ledger](https://github.com/MattiTynka/Helsinki-rides/blob/main/content/releases/asset-credits.json).

Original project paving, rail artwork, selected procedural facade charts and
other explicitly identified original artwork retain their recorded CC0-1.0
dedications. Research-only photographs and Google imagery are not packaged as
production textures. Full source and attribution records are available in
[the source register](https://github.com/MattiTynka/Helsinki-rides/blob/main/docs/source-register.md)
and the manifest.

## OpenStreetMap database

Contains information from OpenStreetMap, which is made available here under the
[Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/).
Map data copyright OpenStreetMap contributors; see
[OpenStreetMap copyright and attribution](https://www.openstreetmap.org/copyright).

The source publication extract is provided as `osm-source.json.gz`, a standard
gzip file containing UTF-8 Overpass JSON. Unneeded contact tags and contributor
account metadata are removed; geometry and road-building inputs are retained.
The adjacent `osm-source-ledger.json` identifies the original acquisition,
publication transformation and hashes. `../manifest.json` identifies the
generated `roads.*.json` database, which is also freely downloadable with this
packet. Original project code is separately licensed from these databases.

`osm-source-recipe.json` records the transformations and source tool locations.
The source snapshot, derived road graph, manifest and notices remain available
under the versioned game-world directory for this beta.

## Web texture adaptation

This Pages packet selects existing smaller mip levels from city KTX2 atlases
above 1024 pixels. Retained compressed mip data is copied exactly; no new
photographic content is added. Geometry, collision and gameplay are preserved.
The unchanged original desktop source world and its SHA-256 are identified in
the repository's public-release record.
