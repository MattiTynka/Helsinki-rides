# Helsinki Open-World Game: Implementation Plan

_Prepared for the project owner | 16 October 2026 | Version 3, supersedes version 2 of the same day_

## Decision record

| Version | World source | Why it was replaced |
| --- | --- | --- |
| v1, 15 Oct | City of Helsinki 2017 photo-mesh plus generated facades, pre-baked 2 km² district, courier delivery as the first loop | Mesh unusable at street level; the first loop was not GTA; combat and arrest were optional |
| v2, 16 Oct morning | Google Photorealistic 3D Tiles streamed for the whole metropolitan area | Judged insufficient for Helsinki buildings on inspection; per-session cost; nothing derived from the tiles may be stored, which blocks baked collision and offline processing |
| v3, this document | City of Helsinki textured LoD2 buildings from the city's own 3D Tiles stream (the one kartta.hel.fi/3d loads), CC BY 4.0 as confirmed by the city on request; the city's terrain, tree and 2024 photo-mesh layers from the same stream for ground, vegetation and landmark detail; OpenStreetMap for roads and gameplay data | Current |

Version 3 keeps everything in version 2 that was about the game (the 60-second test, police and wanted system, city life, missions, radio, HUD, agent rules) and replaces the world sections. The pilot starts from the 20 LoD2 building models already on disk in `data/raw/helsinki-lod2/senate-district/`, not from the whole city. The converter `tools/world/convert_city_model.ts` is the core of the world pipeline and grows into the tile builder described in section 4.

## 1 Product definition

A realistic open-world crime sandbox set in the real city of Helsinki, playable in a desktop browser. The player drops into a real address, walks, takes vehicles on land, water and in the air, and is pursued by a police force that behaves like a plausible Finnish police force until the player's own violence escalates the response. The first release covers central Helsinki district by district; the whole city is the target, and the city's own data covers all of it.

### Pillars

- **Real geography.** Every street, station, hospital and harbour is where it is. Buildings are the city's surveyed LoD2 models with their real facades; nothing is relocated.
- **Consequences.** A wanted system in which arrest and death are real outcomes with real locations.
- **Freedom of movement.** On foot, cars, boats from real harbours, a helicopter, a light aircraft from Malmi, a ride on a real tram.
- **Ambience.** Real radio stations, HSL trams and buses on their real route shapes, the Suomenlinna ferry.

### What realistic means here

Real places and plausible behaviour, not photoreal characters. Police escalate in stages and shoot only in response to the player's weapons. Pedestrians report crimes. Driving is arcade-tuned but masses, speeds and braking distances stay plausible. LoD2 buildings have flat walls with photographic facades: windows and doors are painted, not modelled, and the game never pretends otherwise with fake interiors. Stylised characters and vehicles in a surveyed city is the art direction.

### The 60-second test (milestone 1 acceptance)

Spawn at Senate Square or any address inside the released area. Walk ten metres. Take a spawned car. Drive onto Unioninkatu. Ram a patrol car and receive one star. Be pursued with lights and sirens. Fire a pistol at the patrol car and reach three stars. Be shot at. Exit the car and fire back from cover. Then either die, fade out and respawn at the hospital anchor, or stop, be approached and arrested, and respawn at the police anchor. All of it without a page reload at 30 FPS or better on the standard preset. Until the districts containing Meilahti and Pasila are released, the hospital and police anchors are placeholders at the district edge that name the real destination on screen (section 8). If any step is missing, nothing else gets built.

### Out of scope for 1.0

Multiplayer (section 13), building interiors, a scripted story campaign, voice acting, mobile, weather and a day-night cycle, destructible environment, anything outside the city of Helsinki including Helsinki-Vantaa airport (section 6 names the fallback).

## 2 Architecture

| Layer | Technology | Responsibility |
| --- | --- | --- |
| Rendering | Three.js (WebGL2), TypeScript, Vite | Pre-baked world cells and every game object in one scene |
| Buildings | City of Helsinki textured LoD2, read from the city's 3D Tiles stream (3D Tiles 1.1, KTX2 textures), reprocessed offline by `convert_city_model.ts` | Visual buildings; collision for buildings without a register prism |
| Ground | City terrain layer from the same stream as the baseline; authored road, junction, kerb and sidewalk surfaces from OSM centrelines on top | Driving and walking surfaces |
| Detail | City 2024 photo-mesh layer (photo bake for untextured buildings, landmark ground features such as the Senate Square terrace, stairs and statue); 2017 mesh where 2024 shows scaffolding; city tree layer for instanced vegetation | Landmark fidelity and vegetation |
| Collision | Rapier (JavaScript and WASM): terrain heightfield, road trimeshes, building register prisms, LoD2 trimeshes where no prism exists, kerbs | Vehicles, characters, bullets |
| Simulation | Own fixed-step simulation at 60 Hz in a package free of Three.js | Vehicles, characters, weapons, AI, wanted state |
| Semantic data | OpenStreetMap extract, Helsinki building register (WFS), HSL GTFS shapes, baked at build time | Road and footway graphs, POIs, footprints and heights, routes |
| Geocoding | Digitransit geocoding API (Pelias) | Drop-in address search within released districts |
| Characters | Mixamo rigs and animations as glTF; Blender Studio Snow or Rain optionally converted for hero characters | Player, police, pedestrians |
| Audio | Web Audio mixer; HTML audio element for radio streams from the radio-browser catalogue | Engines, weapons, sirens, ambience, radio |
| UI and saves | DOM HUD, Canvas minimap from the baked road graph, IndexedDB | HUD, menus, progress |
| Hosting | Static site and world cells on a CDN; no backend in 1.0 | Client, baked cells, models |

### Three representations, as in version 1

Visual (LoD2 cells, detail meshes, props), physical (heightfield, road trimeshes, prisms, kerbs) and semantic (road lanes, footways, navmesh, anchors) share coordinates and stable building ids but are baked, streamed and budgeted separately. Collision never comes from visual geometry except for buildings that have no register prism, and that exception is recorded per building. The browser never parses 3D Tiles, CityGML or OSM at runtime; it loads baked cells.

### Coordinate frame

ETRS-GK25 (EPSG:3879) and N2000 for all working data, a surveyed origin near Senate Square recorded in the world manifest, local metres with +X east, +Y up, −Z north, double precision until vertex buffers are written. The converter's placement chain (glTF Y-up → tile transform → ECEF → geodetic → EPSG:3879 → local) stays exact with no fitting. The stream's heights agree with N2000 to about 0.2 m, which means the tiler treated N2000 heights as ellipsoidal; keep that as a permanent test with three control points (Cathedral, Railway Station, Market Square quay) so a re-tiling by the city cannot shift the world silently.

### Simulation loop

Fixed 60 Hz step, tick-stamped input commands, render interpolation, catch-up capped at four steps, paused while the tab is hidden. `packages/sim` imports nothing from Three.js and runs in Node for tests.

## 3 World data and licences

| Source | Use | Acquisition and constraint |
| --- | --- | --- |
| City 3D Tiles stream: textured LoD2 layer | All buildings | CC BY 4.0, confirmed by the city on request; file the confirmation (date, sender) in the source register. Mirror per release into `tools/world/raw/` with tileset URL, layer name, download date and checksums. The public game never requests kartta.hel.fi |
| Same stream: terrain layer | Ground baseline | Same licence; evaluate against the current terrain in M0, since LoD2 wall bottoms come from this survey |
| Same stream: 2024 photo-mesh | Photo bake for untextured buildings, landmark ground features, optional far scenery | Same licence; Cathedral drum is scaffolded in 2024, so the Cathedral uses the 2017 OBJ mesh or a hero model |
| Same stream: tree layer | Instanced trees | Same licence; positions and heights only, own tree models |
| The 20 GLBs in `data/raw/helsinki-lod2/senate-district/` | Pilot input for M0 and M1 | Record which stream tiles and feature ids they came from and when; they are the frozen pilot edition until the mirror replaces them |
| Helsinki building register (WFS) | Footprints, heights, ids for collision prisms and matching | CC BY 4.0; pin layer names and query extent |
| OpenStreetMap extract | Roads, footways, crossings, POIs, water, parking, names | ODbL; dated extract; baked graph published with the notice |
| HSL GTFS | Tram and bus route shapes | CC BY 4.0 |
| Digitransit geocoding | Address search | Registration, rate limits |
| radio-browser.info | Station catalogue | Free; streams are the broadcasters' own; non-commercial first |
| Mixamo, Kenney, purchased models | Characters, props, vehicles | Record each licence; keep source files out of the public repository |

### OpenStreetMap queries

Bake the pilot polygon now and the whole city of Helsinki in M4 (envelope longitude 24.78 to 25.26, latitude 60.08 to 60.30). Drivable roads with `oneway`, `lanes`, `maxspeed`, `surface`, `tunnel`, `bridge`, `layer`, `access`, `name`, `name:sv`; footways, pedestrian areas, steps, crossings and sidewalk tags; `railway=tram`; `amenity=police` filtered to public stations (Pasila, Itäkeskus, Malmi; verify by hand); `amenity=hospital` with `emergency=yes` (Meilahti campus, Haartman, Malmi); `aeroway` including `disused:aeroway` for Malmi; harbours, marinas, ferry terminals and piers; water and coastline; parking polygons and lanes; taxi ranks; industrial land; suburb and neighbourhood boundaries. Appendix A has the query sketch. Tunnels stay open in this version because the ground is authored, unlike the photogrammetry case; `tunnel=yes` edges get an authored tunnel surface or are closed per edge in `closures.json`.

## 4 The world pipeline

Resumable stages: fetch, normalise, patch, build, optimise, validate, publish. Each stage has an input hash and a tool-version record. Manual corrections are GeoJSON or JSON patches in `content/helsinki/`, never an unsaved Blender session. Blender is used only for hero assets and the photo bake, not for city buildings.

### 4.1 `convert_city_model.ts` becomes the cell builder

1. **Read.** 3D Tiles 1.1 content from the mirror or from the 20 pilot GLBs. Preserve per-feature metadata (`ratu`, `vtj_prt`, address, storeys) from `EXT_structural_metadata` or the batch table as the building's primary id.
2. **Transcode once.** KTX2/Basis to PNG masters under `data/work/` (not in Git). Never re-encode from JPEG; every shipped texture derives from a master.
3. **Place.** The exact chain from section 2, then assign each building to its 128 m cell by footprint centroid; buildings crossing a cell border belong to the cell containing their centroid and are listed in both cells' descriptors.
4. **Match.** Wall-based matching against register footprints (median wall offset ≤ 0.5 m, ≥ 30 % of outline inside, ≥ 90 % wall coverage), with the register id as the primary key where present and the geometric test as fallback. Emit a per-cell report: matched, ambiguous, unmatched. The pilot's 57 of 57 at 5.5 cm median is the baseline; the thresholds are not final until a perimeter-block district with courtyards and passages has been run.
5. **Ground.** Sample the baked terrain along each wall; add a skirt strip from the wall bottom to 0.3 m below the lowest ground within 1.5 m. The skirt is its own strip with a plinth colour or the bottom texel row repeated; the facade texture is never stretched.
6. **Atlas.** Shelf-pack all facade and roof rectangles of a cell into 4096² atlases with 16 px gutters, cap facade texels near the source resolution (512 px for a typical facade, 1024 px where the source supports it), remap UVs, merge the cell's buildings into one mesh per atlas.
7. **Encode.** KTX2 with full mip chains: UASTC for facades, ETC1S for roofs (`toktx --genmipmap` or `basisu -mipmap`). Meshopt-compressed geometry. One GLB per cell per LOD.
8. **LODs.** LOD0 as above; LOD1 the same geometry with a quarter-resolution atlas; LOD2 untextured LoD2 with per-face average colours from the masters. Far skyline may use the 2024 mesh at its coarsest level once the licence note covers it.
9. **Collision.** Register prisms per matched building; LoD2 trimesh for unmatched or landmark buildings, flagged `citymodel` collider; kerbs and road surfaces from the road builder.
10. **Validate.** `verify-glb` with the existing texture-memory check (224 MiB scene limit), plus draw calls per cell, triangle counts, finite values, UV bounds, missing textures, bounds inside the cell, metadata present, licence record present. A failed check fails the build.

### 4.2 Roads, junctions and sidewalks

As in version 1: OSM centrelines to a lane graph, explicit junction polygons, lane connectors, stop lines, sidewalks, crossings and kerbs; road profile fitted to the terrain and smoothed with a grade cap and crest and sag radii; bridge decks and underpasses as separate surfaces. The existing roads file keeps sampling lane heights from the rebuilt collision. Every pilot junction is inspected by hand; district expansion (section 12) uses the automated builder with a quality floor and hand inspection on mission routes only.

### 4.3 Landmarks and detail

Per-landmark source decisions are recorded in `content/helsinki/landmarks.json`: Cathedral from the 2017 mesh (pre-scaffolding) within its footprint, later a hero model; Senate Square terrace, stairs and the Alexander II statue from the 2024 mesh cut 0.5 m from building footprints; untextured LoD2 buildings get a photo bake from the 2024 mesh and until then flat colours split by face slope. Trees come from the city tree layer as instances of three own tree models by height class.

### 4.4 Lighting decision

Facade textures carry baked light from the source flight. Decide in M0 with an A/B at fixed cameras: unlit building materials with lit characters and vehicles, against lit materials with the sun matched to the baked shadow direction. Whichever wins, the choice is recorded and all later bakes inherit it. Blob shadows under vehicles and characters either way; no shadow maps on buildings in the low preset.

### 4.5 Expansion engine

After the pilot, mirror the city's LoD2 tileset once per release and run the cell builder over the whole city; the visual layer then covers all of Helsinki without further manual work. Roads, collision and navigation are built by the automated road builder for every cell and reach the quality floor (drivable, no holes, correct one-ways, kerbs); priority districts get hand inspection. Release districts as contiguous polygons with valid exits. The metric that decides how far this scales is developer hours per new playable square kilometre; record it from the second district on.

## 5 Packaging and streaming

128 m cells with independent visual, collision and navigation blobs, content-hashed URLs, a global manifest with bounds, LODs and source versions. The pilot district loads completely at start. From M4, collision-first streaming as in version 1: request the current cell, the movement corridor and a safety ring first; visual detail after the minimum collision set is ready; at 30 m/s keep at least 150 m of forward look-ahead; never remove a collider in use; never let a vehicle fall through an unloaded street; hysteresis and LRU eviction; generation tokens for cancelled loads.

## 6 Player, vehicles and movement

Rapier vehicle controller with raycast suspension on one dynamic body per car; kinematic capsule character controller; the state machine onFoot, enteringVehicle, driving, exitingVehicle, recovering; spring-follow driving camera 7 to 9 m behind and 3.5 to 5 m up, pitched down 18 to 25°, swept against collision; on-foot camera 4 m back and 2.2 m up. Vehicle definitions are validated data files with engine curve, drag, grip, handbrake, steering curve, mass, centre of mass and damage states (smoke at 30 %, fire at 10 %, explosion five seconds after zero).

- **Cars:** compact, sedan, estate, van, taxi, sports, SUV, patrol car, tactical van; fictional brands; masses 1,200 to 2,500 kg, 140 to 230 km/h, braking from 100 km/h in 40 to 55 m. Parked cars spawn in OSM parking areas and along parking lanes in a 150 to 400 m ring. Taking an occupied car makes the driver flee and counts as a witnessed crime.
- **On foot:** walk, run, sprint, swim; no jumping. Enter and exit through a 0.8 s fade.
- **Boats:** Eteläsatama, Katajanokka and the Kauppatori quays are inside or next to the pilot, so boats come early: spawn at marinas and piers, buoyancy on a water plane at N2000 zero, shore collision from the baked coastline, 10 to 25 m/s. Swimming lasts 60 s in Baltic water before drowning.
- **Air:** a helicopter from helipads and the police; a light aircraft from Malmi, which is inside the city and has runway geometry in OSM, presented as the abandoned field it is. Helsinki-Vantaa is in Vantaa and outside the city's data; when the time comes, extrude OSM footprints with heights for the airport area, or evaluate Vantaa's own 3D model and its licence. Not in 1.0.
- **Trams:** traffic from M3, boardable as a passenger from M5.

## 7 Combat, health and death

- Weapons: fists, pistol, submachine gun, shotgun. Hitscan with spread and recoil, head shots, ammunition, pickups at fictional locations and drops from police.
- Health 100 plus armour, slow regeneration to half. Hit reactions and a death animation; no gore.
- Wasted: two seconds of slow motion, fade, respawn at the hospital anchor, lose armour and ammunition, pay a fee. Wanted level cleared.

## 8 Police and the wanted system

### Anchors before the real buildings exist

The pilot district has no hospital and no police station; Haartman and Meilahti are 3 km away, Pasila 4 km. Until M4 releases the corridor that contains them, `content/helsinki/anchors.json` holds placeholder anchors at the district edge: an ambulance bay and a police van, each with the real destination's name on the Wasted or Busted screen. When a district containing the real building is released, its anchor replaces the placeholder automatically because anchors are resolved by nearest released POI.

### Detection

Pedestrians and drivers with line of sight report a crime after three to six seconds; police units with line of sight react at once. Crimes carry star weights: taking a car, ramming, hitting a pedestrian, drawing a weapon, firing, shooting at police, killing.

### Escalation, tuned to be plausibly Finnish

| Stars | Response | Rules of engagement |
| --- | --- | --- |
| 1 | Nearest patrol responds, lights and siren, follows and attempts a stop | No weapons. Arrest when the player stops or is on foot |
| 2 | Two to three cars, boxing-in and low-speed ramming, spike strips at choke points | No weapons unless fired upon |
| 3 | Armed response, officers draw weapons, roadblocks on predicted route edges | Fire only if the player is armed or has fired |
| 4 | Tactical unit in a fictional van, police helicopter with spotlight tracking | Fire on sight at an armed player |
| 5 | Maximum units, higher accuracy and aggression | No military, ever |

### Busted, search and decay

Busted: on foot within 3 m of an officer not under fire for two seconds, or stopped and boxed in for three seconds at one or two stars. Fade, respawn at the police anchor, weapons confiscated, a fine, wanted level cleared. Losing line of sight turns pursuit into a search around the last known position; heat decays on per-level timers from 20 s at one star to 150 s at five. Courtyards, underpasses, parks and the shoreline are the cover the pilot offers; officers never know a hidden player's exact position.

### Police AI

Per-unit finite-state machine: patrol, respond, pursue (graph routing until within 80 m with line of sight, then direct steering), box-in, foot engage with cover points sampled against collision, arrest, search, return. Unit caps by star level 1, 3, 5, 7, 9. Units come from a station anchor within 2 km, otherwise spawn off-screen on roads at least 150 m away. Pursuit cars use the same vehicle physics with top speed slightly below the player's class and limited rubber-banding.

## 9 City life

- **Traffic:** kinematic lane followers at posted limits, simple junction priority, yielding to trams, 25 to 40 active cars on the standard preset; brake, honk and swerve for the player; dynamic for three seconds on collision.
- **Pedestrians:** 30 to 50 active on the footway navmesh baked with Recast, crossing at crossings, density from the shop and amenity heat map; reactions look, film, flee, report. A vehicle hit is a stumble and a report, not gore.
- **HSL vehicles:** trams and buses on GTFS shapes with stop pauses; trams are heavy.
- **Sea and sky:** the Suomenlinna ferry, idle boats in harbours, airliners on a spline approach with no collision.

## 10 Missions and progression (from milestone 7)

Dynamic and systemic. Courier or parcel delivery is not a mission type and is not built before milestone 7, not even as a test harness; the police chase is the test harness. Car theft orders delivered to fictional garages on real industrial land; getaway driver; vigilante; taxi from real ranks; random events. Progression through money, a garage, weapon unlocks and safe houses at real addresses with no interiors. Saves in IndexedDB with migrations and file export. Mission text never names a real business as a target.

## 11 HUD, UI and onboarding

- Drop-in screen: address search limited to released districts, landmark list, random location, last position, a content notice (violence, PEGI 16 equivalent).
- HUD: rotating Canvas minimap from the baked roads and POIs, stars, health and armour, weapon and ammunition, radio toast, money, objective text, district name; a visible boundary of the released area on the minimap.
- Wasted and Busted screens naming the real place.
- Settings: quality presets, remappable keyboard and gamepad, audio sliders, mouse capture that Escape releases, subtitles, reduced camera motion, colour-safe markers.
- Credits: City of Helsinki (CC BY 4.0, the exact attribution text the city asks for), OpenStreetMap contributors, HSL, radio-browser, Mixamo, Blender Studio if used, every purchased pack.

### Radio

radio-browser.info catalogue (servers resolved through DNS, descriptive User-Agent, `json/stations/bycountrycodeexact/FI`, keep `lastcheckok=1`, `https` streams, mp3 or aac), curated to a dial of eight to twelve Helsinki stations verified by hand and re-verified nightly, with a bundled royalty-free fictional station as fallback. Audio starts after the first user gesture; HTML audio element, no CORS needed. Radio Garden is not used: no public API, and its terms do not cover this.

## 12 Performance budgets

Measured on a fixed route through the pilot (Senate Square, Unioninkatu, Aleksanterinkatu, Esplanadi, Market Square quay and back) with cold and warm cache, median and 95th percentile frame time. The report's measurements on an RTX 3070 Ti (city GLB 10.5 MB, 85k city triangles, p99 7 to 14 ms, 169 MiB texture memory, 780 to 911 draw calls) are the recorded baseline; the two regressions are what M0 fixes.

| Measure | Low preset | Standard preset |
| --- | --- | --- |
| Reference hardware | 16 GB laptop, integrated GPU, 1280 by 720 | 16 GB desktop, GTX 1660 class, 1920 by 1080 |
| Frame target | 30 FPS, p95 at most 40 ms | 60 FPS, p95 at most 22 ms |
| Visible triangles | about 500,000 | about 1.2 million |
| Draw calls per frame | at most 350 (city cells at most 60) | at most 600 (city cells at most 100) |
| Resident texture memory (compressed, with mips) | at most 160 MiB, verified by `verify-glb` against a 224 MiB scene limit | at most 320 MiB |
| Population caps | 15 cars, 20 pedestrians, 3 police | 35 cars, 45 pedestrians, 7 police |
| Transfer to first control (pilot) | at most 20 MB | at most 30 MB |
| Time to control at 20 Mbit/s | 12 s | 15 s |

Decision rules: if draw calls exceed the cap, merge further (one mesh per cell per atlas) before touching content; if texture memory exceeds the cap, lower the facade texel cap one step; if the frame target is missed after that, reduce population, then the collision detail of distant cells.

## 13 Multiplayer: deferred

With a pre-baked world an authoritative server is possible again: it loads the same collision and road cells without textures, as version 1 described (Node, Colyseus, Rapier, 60 Hz server physics, 20 Hz snapshots, client prediction and reconciliation). Not before 1.0. Keep entity ids, tick numbers and serialisable state so that door stays open.

## 14 Legal and attribution

- City of Helsinki data: CC BY 4.0 for the LoD2, terrain, tree and mesh layers read from the stream, as confirmed by the city. Keep the confirmation in the source register; attribute exactly as the city asks; mark adaptations (atlasing, re-encoding, skirts) as changes; do not imply endorsement. Mirror once per release; the public game serves its own copies.
- OpenStreetMap: ODbL; credit and publish the baked graph. HSL GTFS: CC BY 4.0. Digitransit: its terms of use.
- Radio streams: broadcasters' public streams; non-commercial release first and broadcaster consent before monetisation.
- Police identity: fictional emblem, generic blue and white livery; lawyer review of lettering before any commercial release.
- Real signage in facade textures is part of the city's licensed data and stays untouched; mission text never targets a named real business. No real people.
- Mixamo royalty-free for games; Blender Studio rigs CC-BY with the required credit; purchased packs per their licence. Source files stay out of the public repository.
- Privacy: no per-user location telemetry; aggregate counters only.

## 15 Code organisation and interfaces

| Path | Owns |
| --- | --- |
| apps/game | Vite app, Three.js scene, cameras, input, HUD, audio, settings, cell streaming coordinator |
| packages/sim | Fixed-step world: entities, vehicles, characters, weapons, wanted state, AI. No Three.js imports |
| packages/world-schema | Cell manifest, road graph, anchors, provenance and content validators |
| packages/data | Loaders for baked cells, OSM, GTFS and radio JSON; EPSG:3879 to local transforms with tests |
| tools/world | `convert_city_model.ts` (cell builder), road builder, terrain import, register matcher, `verify-glb`, mirror fetcher |
| tools/blender | Hero assets and the photo bake only |
| content/helsinki | Pilot polygon, `landmarks.json`, `anchors.json`, `closures.json`, vehicle definitions, spawn tables, mission data, landmark list |
| data/raw, data/work | Mirrored tiles, the 20 pilot GLBs, PNG masters, register extracts; outside Git |
| tests | Sim unit tests on synthetic ground, transform fixtures, headless journey runs |
| docs | This plan, decision record, source register, benchmark records |

Interfaces to stabilise early: `WorldManifest`, `CellDescriptor` (bounds, visual LODs, collision blob, navigation blob, building ids, hashes), `BuildingRecord` (register id, LoD2 feature id, match status, collider kind, texture status), `RoadGraph`, `GroundQuery`, `Entity`, `WantedState`, `GameEvent`, `Save`.

## 16 Milestones

Person-days for one experienced JavaScript developer with coding agents and occasional art help; not calendar promises. Add 20 to 30 percent contingency, mostly for road authoring and AI tuning.

| Milestone | Effort | Deliverable and exit gate |
| --- | --- | --- |
| M0 Pilot cells | 3 to 5 days | The 20 GLBs through the full cell builder: metadata preserved, register matching report, skirts, per-cell atlases, KTX2 with mips, LODs, collision, `verify-glb` green. Lighting A/B decided. Gate: city cells under 60 draw calls and under 160 MiB on the low preset, p95 within budget on the pilot route |
| M1 The 60-second slice | 10 to 15 days | On foot, enter and exit, pistol, health, two patrol units with pursue, arrest and shoot, Wasted and Busted with placeholder anchors, minimal HUD, drop-in by address inside the pilot. Gate: the 60-second test passes ten times in a row |
| M2 Police depth | 8 to 12 days | Five stars, witnesses, search and decay, roadblocks, helicopter, cover AI, unit caps. Gate: external playtest rates pursuits fair and tense |
| M3 City life | 10 to 15 days | Traffic, pedestrians, parked-car spawning, HSL trams and buses, ferry, airliners. Gate: population caps hold the frame budget |
| M4 Expansion engine and the first corridor | 12 to 18 days | Mirror of the city tileset, whole-city visual cells, automated road builder with a quality floor, collision-first streaming, release of the corridor Kluuvi, Kamppi, Töölö, Meilahti and Pasila so that hospital and police anchors become the real buildings. Gate: drive Senate Square to Pasila police station and Meilahti without holes; hours per square kilometre recorded |
| M5 Air and sea | 8 to 12 days | Boats, helicopter, light aircraft at Malmi, water plane, swimming and drowning, tram riding |
| M6 Radio, HUD, saves | 6 to 10 days | Radio dial, full HUD and minimap, settings, saves, drop-in screen, credits |
| M7 Missions and progression | 8 to 12 days | Car theft orders, getaway, vigilante, taxi, random events, garage, money |
| M8 Release hardening | 8 to 12 days | Presets, browsers, content notice, telemetry, deploy and rollback, benchmark record |

M0 to M8 total 73 to 111 person-days before contingency, roughly 18 to 28 weeks with it. The slice (M0 plus M1) is three to four weeks. This is longer than version 2 because world expansion is now our cost rather than Google's; in exchange there is no per-session cost, collision is exact and baked, and the facades are real. Decision points: after M0, accept the look or fall back to generated facades for near buildings; after M1, tune until the chase is enjoyable; after M4, decide the release polygon for 1.0 from the measured hours per square kilometre; after M8, choose between more districts and multiplayer.

## 17 The first ten working days

| Day | Work | Output |
| --- | --- | --- |
| 1 | Source register: the city's licence confirmation, stream layers and URLs, the 20 GLBs' origin and checksums. Converter: preserve feature metadata, PNG masters | Register entries; masters for all 20 buildings |
| 2 | Converter: cell assignment, register matching report, skirts as separate strips, collision export | Match report for the pilot; prisms and `citymodel` colliders |
| 3 | Converter: per-cell atlas, KTX2 with mips, LODs, merged meshes; `verify-glb` draw-call and texture checks | Pilot cells under budget; before and after numbers |
| 4 | Lighting A/B at fixed cameras; terrain comparison (city terrain layer against the current terrain); benchmark route | Recorded lighting decision; M0 gate |
| 5 | OSM bake for the pilot polygon and the city-wide POI set; placeholder anchors; minimap canvas | `content/helsinki` populated; anchors named |
| 6 | Character on foot (Mixamo), enter and exit, drop-in by address inside the pilot | Walk from Senate Square to a car and drive away |
| 7 | Pistol, health, Wasted and the hospital anchor | Die on Aleksanterinkatu, wake up at the ambulance bay naming Meilahti |
| 8 | Police unit FSM: patrol, pursue, arrest; one and two stars; Busted and the police anchor | Get arrested on Unioninkatu, wake up at the police van naming Pasila |
| 9 | Three stars: police fire when fired upon, foot engagement, cover points; witnesses, heat decay, search, HUD stars | Survive and lose a three-star pursuit |
| 10 | Run the 60-second test ten times, record, fix, write the M2 backlog | Recording, benchmark baseline, prioritised backlog |

## 18 Working rules for coding agents

1. Read this document first. The 60-second test is the definition of done for milestone 1; the exit gates define the others.
2. Forbidden before milestone 7: courier, parcel or delivery missions, checkpoint races, time trials, in any form including test harnesses.
3. Forbidden always: Google 3D Tiles or CesiumJS in the runtime; requesting kartta.hel.fi from the public game; routing around a 403 or 503 on a data service (stop and report instead); collision derived from visual geometry except the recorded `citymodel` cases; fitting or nudging georeferenced data; language-model calls in the game loop; real vehicle brands, real police emblems, real business names in mission text.
4. Every ticket names its fixture, its acceptance criterion and its evidence: a screenshot, an input recording or a headless journey log. A claim without evidence is not done.
5. Keep `packages/sim` free of Three.js. Keep coordinates in the local frame everywhere except the transform module.
6. The texture-memory and draw-call checks in `verify-glb` are release gates; raising a limit requires a recorded decision.
7. Blender runs only for hero assets and the photo bake, one job at a time in the memory-capped container; city buildings never pass through it.
8. Pin tool versions. Every data acquisition goes into the source register with date, licence and checksum before it is used.

## 19 Risks

| Risk | Early signal | Response |
| --- | --- | --- |
| Facades too soft or flat at street level | M0 captures at 3 m | Raise the facade texel cap where the source supports it; photo-bake relief into normal maps later; raise the camera floor |
| Register matching breaks at scale | Ambiguity rate climbs in perimeter blocks | Use register ids first; refine thresholds; fall back to `citymodel` colliders per building |
| Terrain and LoD2 disagree | Gaps or buried doors | Adopt the city terrain layer; skirts; per-building ground patches |
| Road authoring dominates expansion | Hours per square kilometre above budget | Automated builder quality floor; hand inspection only on mission routes; smaller release polygon |
| Texture memory or draw calls regress | `verify-glb` fails | Merge further, lower texel cap, stricter LOD switching |
| City re-tiles or changes the stream | Control-point test fails, mirror diff | Mirror per release; the game ships its own copies; re-run the pipeline |
| Police feel unfair | Playtest complaints | Debug views for line of sight and routes, unit caps, decay timers |
| Radio streams die | Silence | Nightly verification, fallback station |
| Scope drifts back to missions | Delivery code appears | Rule 2 in section 18; the M1 gate |
| Legal challenge on police marks or radio | Letter | Fictional emblem from day one; non-commercial until consents and counsel are in place |

## 20 Costs

- World data: free under CC BY 4.0. No per-session fees.
- Static hosting and CDN: EUR 10 to 60 per month for a beta; whole-city cells are a few hundred megabytes to a few gigabytes once atlased and compressed; typical session transfer to be measured, target under 200 MB.
- Local working storage: 100 to 300 GB for the mirror, masters and builds. Build machine RAM is the current constraint; the Blender-free city path reduces it.
- Vehicle, weapon and prop models: EUR 500 to 2,000; Snow or Rain conversion three to five days each if wanted.
- Development tooling and coding assistance: EUR 100 to 300 per month.

## Appendix A: Overpass query sketch

Build-time only. Replace the bounding box with the pilot polygon now and the city envelope in M4. Store raw responses with date and checksum under `tools/world/raw/` and keep them out of Git.

```
[out:json][timeout:180];
(
  way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$"]({{bbox}});
  way["highway"~"^(footway|pedestrian|path|steps|cycleway)$"]({{bbox}});
  node["highway"="crossing"]({{bbox}});
  way["railway"="tram"]({{bbox}});
  nwr["amenity"="police"]({{bbox}});
  nwr["amenity"="hospital"]["emergency"="yes"]({{bbox}});
  nwr["aeroway"~"^(aerodrome|runway|helipad)$"]({{bbox}}); nwr["disused:aeroway"]({{bbox}});
  nwr["harbour"="yes"]({{bbox}}); nwr["leisure"="marina"]({{bbox}});
  nwr["amenity"="ferry_terminal"]({{bbox}}); way["man_made"="pier"]({{bbox}});
  nwr["amenity"="parking"]({{bbox}}); nwr["amenity"="taxi"]({{bbox}});
  way["natural"="water"]({{bbox}}); way["natural"="coastline"]({{bbox}});
  rel["boundary"="administrative"]["admin_level"~"^(8|9|10)$"]({{bbox}});
);
out body; >; out skel qt;
```

## Appendix B: Cell builder output contract

For each 128 m cell, `convert_city_model.ts` writes: `visual/<cell>.lod0.glb`, `.lod1.glb`, `.lod2.glb` (KTX2 textures with mips, Meshopt geometry, one mesh per atlas); `collision/<cell>.bin` (prisms, `citymodel` trimeshes, kerbs); `cell.json` with bounds, building ids, per-building `BuildingRecord`, atlas list, texel caps used, source tile ids and dates, and the licence record id. Validation fails the build on: missing metadata, unmatched building without a `citymodel` collider, texture outside the atlas, draw calls above the per-cell cap, texture memory above the scene limit, geometry outside the cell bounds by more than 2 m, or a missing licence record.

## Appendix C: Sources

- City of Helsinki, Helsinki 3D: https://www.hel.fi/en/decision-making/information-on-helsinki/maps-and-geospatial-data/helsinki-3d
- 3D models of Helsinki (open data catalogue): https://avoindata.fi/data/en/dataset/helsingin-3d-kaupunkimalli
- City of Helsinki 3D map viewer (the stream's consumer): https://kartta.hel.fi/3d
- Helsinki open geographic data and WFS: https://www.hel.fi/en/decision-making/information-on-helsinki/maps-and-geospatial-data/make-better-use-of-geospatial-data/open-geographic-data
- OpenStreetMap copyright and ODbL: https://www.openstreetmap.org/copyright
- HSL open data and GTFS: https://www.hsl.fi/en/hsl/open-data
- Digitransit geocoding API: https://digitransit.fi/en/developers/apis/3-geocoding-api/
- KTX-Software (toktx) and Basis Universal: https://github.com/KhronosGroup/KTX-Software and https://github.com/BinomialLLC/basis_universal
- Rapier vehicle and character controllers: https://rapier.rs/docs/user_guides/javascript/vehicle_controller/
- Recast Navigation JS: https://github.com/isaac-mason/recast-navigation-js
- radio-browser API: https://api.radio-browser.info/
- Mixamo FAQ: https://helpx.adobe.com/creative-cloud/faq/mixamo-faq.html
- Blender Studio Snow and Rain rigs: https://studio.blender.org/characters/
- Versions 1 and 2 of this plan and the 16 October 2026 LoD2 integration report.
