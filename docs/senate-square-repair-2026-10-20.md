# Senate Square entrances and missing facades

Recorded 20 October 2026. The repair starts at the actual deployed
source commit `9bbbba7fecaf3ae4bb478aeae9b17b5baf8d9389`, with world
`senate-20261020-optimized-m1-cb` and manifest SHA-256
`5a3502a4641de1a79dfd40dbb06724b59d4e908d16f3a5218b8e7dcead3f7ebd`.
The unrelated authoring repository history is not a publishing source.

## Diagnosis and repair boundaries

The University entrance combines distinct register parts into one wide flight.
The Government Palace also contains flights inferred in the wrong direction.
The irregular surrounding ground remains in the optimized delivery: decoding
the before/after meshes showed the same unique ground triangles. Repairs must
replace the affected surfaces and their collision together. The Palace perimeter
approaches are reconstructed as pedestrian ramps with the source curb alignment
and street/terrace height anchors. Their subdivisions are authored approximations;
the original noisy driveway sheets are not claimed to remain unchanged.

The Palace repair includes the whole surveyed curb rather than cutting a small
rectangle through it. The first visual candidate exposed retained wedges beside
the flights. Further checking found that triangulation can discard boundary
points that are collinear in plan but differ in height. The repair retains those
stations and closes the actual cut edges, including layered original floors;
matching a few sampled top heights alone is insufficient to establish a closed
join. New collision uses the same authored support surfaces as the visuals.

There are two separate texture problems. Three's GLTFLoader tolerates a failed
texture request and returns a material without its map; accepting that result
as a resident cell prevents the normal retry. A completion hook now rejects
incomplete loaded materials and disposes the rejected result. Separately, four
source buildings contain shared constant-colour wall tiles rather than facade
photography. These require isolated, source-bound charts; repainting their
shared fallback tile would affect unrelated buildings.

## Architectural references

Google Street View was inspected in the browser. It is appearance reference
only: no Google pixels are included in production textures. Counts and relative
dimensions below are visual reconstruction observations, not a survey.

| Place | Panorama and date | Observations |
| --- | --- | --- |
| University, Unioninkatu 34 | [IQJ0fJOOhTjz_4nEZ8JIAQ](https://www.google.com/maps/@?api=1&map_action=pano&pano=IQJ0fJOOhTjz_4nEZ8JIAQ&heading=259.93), August 2024 | Wide lower granite flight with eight risers; flat intermediate landing; narrower upper steps, with the upper portion divided into three door bays by square piers. Large granite sides support the lamps. |
| Government Palace, Snellmaninkatu 1 | [BUK0H3Kabg3u9WBVC-pg3Q](https://www.google.com/maps/@?api=1&map_action=pano&pano=BUK0H3Kabg3u9WBVC-pg3Q&heading=71.7), August 2024 | Granite terrace front and geometric iron railing, short stair flights and stone lamp piers. Preserve the real vehicle approach behind the terrace. |
| City Museum, Aleksanterinkatu 14–18 | [BuvcPILQ9NFQkdsZIJHe4A](https://www.google.com/maps/@?api=1&map_action=pano&pano=BuvcPILQ9NFQkdsZIJHe4A&heading=199.84), August 2024 | Yellow three-storey Remander building in the middle with seven upper window axes; central middle-storey pediments; asymmetric ground-floor doors. White Sederholm at the west and salmon Brummer at the east are separate elevations. Building names and address association are corroborated by the City's K4 study below. |
| National Archives, Rauhankatu 17 | [yoCqw1K73FLOkY5yCIzL2g](https://www.google.com/maps/@?api=1&map_action=pano&pano=yoCqw1K73FLOkY5yCIzL2g&heading=355), August 2024 | Rusticated pale ground floor on a granite plinth; three central doors; giant fluted columns over the centre and pilasters on the wings, tall divided windows. |

Address geocoding alone is insufficient: the source record labelled
Snellmaninkatu 8 is a rear building near 60.172207, 24.952261. The address search
instead opens the Bank of Finland frontage farther south. Its architecture must
not be copied onto that rear source record.

A second [Street View check from Unioninkatu](https://www.google.com/maps/@?api=1&map_action=pano&pano=Jq6ACSa7W-Mc2JFtytnyvQ&heading=90),
August 2024, shows the intervening Topelia frontage, which hides the rear annex.
There was no panorama at the annex's west-wall coordinates. That source record
retains its original material pending a reliable view; windows from the Bank or
Topelia must not be invented there.

The City's [K4 building study](https://www.hel.fi/static/helsinki/paatosasiakirjat/Kh2005/Esityslista33/Liitteet/Kaupungintalokorttelin_K4_tilaselvitys%2C_25.5.2005.pdf)
identifies the north-front sequence and prevents swapping the Sederholm and
Brummer elevations when reading a south-facing panorama.

## Acceptance

The release candidate is `senate-20261020-reference-repair-v3`, manifest SHA-256
`18e40f69a271f037b6b23b257fee437cb5716fad68c10cff808833a142ee7607`.
It retains all 304 map cells and the reduced-texture delivery tier. The closed
world inventory contains 1,938 files and 599,919,882 bytes. The descriptor in
`content/releases/pages.json` pins the regular-file archive and its digest.

The accepted scope is the University's subdivided entrance, the Palace's two
east-facing end flights, terrace, complete curb and pedestrian approaches, and
the three facade groups described above. The per-elevation
[source ledgers](../content/helsinki/senate-facades/README.md) explicitly retain
unobserved sides, roofs and the rear annex as limitations. Opening dimensions
and ornamental details are original approximations fitted to the municipal
planes, not survey measurements or a photographic reproduction.

Local evidence is retained under ignored `build/senate-repair-20261020/`.
`verification-v6.json`, `palace-perimeter-v6-final.json` and the final packet
validation bind the ground repair, collision and unchanged source resources.
They include 324 step probes, 421 accessible terrace probes, 2,164 boundary
profiles, 125 curb rays and closure checks for all 19 original layered boundary
discontinuities. Changed GLBs have no Khronos validation errors.

The final combined review uses `runtime/final-v3-standard/` and
`runtime/final-v3-low/`, with actual source, bundle, manifest and payload hashes.
Standard runs ten keyboard ascent/descent routes, including the two bent ramps;
Low checks the changed entrances, facade fronts, close views and oblique views.
Runtime images require human inspection; budget and HTTP checks alone are not
appearance acceptance. Production and hosted smoke are separate from the local
review. The published source and world are identified by the live
[deployment receipt](https://mattitynka.github.io/Helsinki-rides/release-info.json).

Publication repeats the portable source suite, TypeScript checks, release-tool
tests, image/history privacy audit and Gitleaks. The source export preserves its
own sanitized Estates photographs and hash pins. The unrelated authoring Git
history is never pushed.
