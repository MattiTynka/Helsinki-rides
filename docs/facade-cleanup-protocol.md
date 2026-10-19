# Facade cleanup protocol

Recorded 2026-10-17 from the accepted reference-led facade reconstruction.
Use this protocol when tree crowns, scaffolding or other photographed foreground
objects are baked into a building texture. It implements
[decision 0010](decisions/0010-reference-led-facade-reconstruction.md).
The [verification record](benchmarks/reference-led-facade-reconstruction.md)
contains the completed run's results; this document describes how to repeat the work.

The method is to identify the real elevation, establish its architectural layout
from references, reconstruct only the affected texture regions, then inspect the
final compressed result in the game. The successful pass used offline TypeScript
image reconstruction over licensed source images. It did not regenerate the city
in Blender or change its geometry.

## 1. Establish the baseline and diagnose the defect

1. Read `apps/game/public/world/current.json`, the selected manifest, the latest
   handoff and relevant decisions. Record the release ID, manifest SHA-256,
   source/configuration hashes, asset inputs and server URL. A release ID alone
   does not identify the renderer or simulation code.
2. Capture the reported view in the native game. Record player position, camera
   heading/pitch, preset and release. Open the image and inspect nearby elevations,
   corners, narrow returns and the wall base, not only the reported front view.
3. Match the building to its city-model ID, address, elevation, texture page and
   UV charts. A chart is the texture region assigned to particular wall triangles;
   one page can contain several buildings or unrelated parts of the same building.
4. Determine whether the defect is photographed foliage, a real architectural
   feature, cast shadow, texture transparency, missing geometry or collision.
   Inspect the source image and model mapping before choosing a repair.
5. Create fresh working and evidence directories. Preserve original masters,
   baseline captures and rejected candidates. Do not overwrite accepted outputs.

Actual holes, stair geometry and foot support need their responsible geometry or
collision repair; facade repainting cannot fix them. Keep those changes separately
diagnosable. Preserve the accepted ground, stairs, collision, character and car
assets during texture work. The removed 2017 mesh must stay removed.

## 2. Inspect the corresponding real place

Open the actual building in Google Maps Street View. Match the street side and
orientation to the game, then inspect a front view and both ends where possible.
Use a second angle, another capture date or leafless-season imagery when trees,
vehicles or scaffolding obscure important details. The newest image is not always
the clearest architectural reference.

For every reference, record:

- Building name/address and city-model ID; elevation and game coordinates.
- Reference URL or panorama ID, latitude/longitude, heading and capture date.
- Observed window axes and spacing, storeys, arches, doors, porches, pilasters,
  cornices, plinths, corner returns and any asymmetry.
- Which details are directly visible, corroborated elsewhere or still unresolved.
- Whether the source is visual reference only or licensed for production pixels.

Consult official building-history drawings, archive photographs or clear licensed
photographs where Street View cannot resolve the layout. Do not infer that a dark
shape is a tree: Topelia's north porches were real architecture, and Rauhankatu 19's
small south-base silhouettes were bicycles/objects. Both were preserved.

Google imagery is visual reference only in this workflow. Do not copy it into
production textures. Production pixels come from the licensed city masters,
separately licensed compatible photographs or original authored detail. Record
external image URLs, author, licence, exact file hash and modifications in the
[source register](source-register.md), source ledger and applicable asset credits.
The Estates repair used two credited CC BY 4.0 photographs because its city masters
were covered by scaffolding.

## 3. Specify the architecture and repair boundary

Before editing pixels, write a small plan for each elevation:

| Item | Required decision |
| --- | --- |
| Target | Building ID, source pages, triangle/chart IDs and bounded repair regions |
| Layout | Window/door count, centres, widths, heights, storey bands and wall divisions |
| Protected detail | Entrances, porches, steps, unique bays, ornaments, roof and unaffected charts |
| Donors | Exact clean source regions and evidence that their architecture matches |
| Material | Plaster/stone samples, masonry scale and illumination adjustment |
| Limits | Occluded or uncertain features and the additional reference needed |
| Review views | Front, close, oblique, both returns, base and adjacent shared charts |

Prefer an intact corresponding bay from the same building. Match its architecture,
not merely its colour. A side wall may differ from the front, and opposite wings
may have different spacing. Unique entrances must not become repeated windows.
Preserve arched versus rectangular heads and paired versus single windows.

For blank wall or stone, use clean material from that building and author the
confirmed bands/joints at plausible scale. Keep masonry approximation explicit;
an authored joint pattern is not a survey. Do not bring a donor's photographed
lamp, rail, pot, wire, tree or foreground object into the reconstructed wall.

If references remain insufficient, identify the exact unresolved chart and keep
searching for suitable evidence. Do not invent a blank wall or window count to
make a screenshot look clean. Any area left unresolved must remain an explicit
limitation of the delivered repair. In the recorded run, the church's south wall
was reconstructed, but the east apse retained its original photography and service
door because the full opening/painted false-window arrangement was unresolved.

## 4. Implement a bounded, reproducible reconstruction

Use the shared
[`facade-restoration-registry.ts`](../tools/world/lib/facade-restoration-registry.ts)
and [`FacadeRestorationModule`](../tools/world/lib/facade-restoration-types.ts)
contract. Both full cell builds and texture-only repairs must apply the same
registered reconstruction; avoid a one-off generated image that the next build loses.

1. Add or update the building-specific module in `tools/world/lib/`. Declare target
   pages, all donor pages, external photographs and mapping/support files.
2. Pin native source hashes and dimensions. Reject mismatched inputs instead of
   applying old coordinates to a new image. Include new source/support files in
   the recorded source identity.
3. Read donors from immutable, native-resolution originals. Write to the separate
   ungraded target buffer; never sample a previously patched output as a donor.
4. Map the confirmed layout into the target charts. Clip every write to the
   intended wall triangles/regions and protect unrelated charts on shared pages.
   Check UV orientation so physical east/west and source-image left/right agree.
5. Match donor illumination to the target elevation without flattening its
   architectural detail. Preserve alpha and the existing global facade grade.
   Inspect seams, boundary blends, cast shadows and repeated patterns.
6. Save before/after panels and changed-pixel evidence. Add focused tests for the
   meaningful invariants: wrong-source rejection, writes outside the target,
   protected openings, alpha preservation and relevant architectural distinctions.
   Check native source resolution and the actual production texture size.

Keep `content/helsinki/cells.json` vegetation mode at `restore-original` for this
production path. Generic colour-mask erasure, blur, broad plaster patches and
unverified bay repetition are not this protocol. The recorded pass changed zero
texels through automatic erasure; named architectural reconstruction supplied the
repairs. Tests establish constraints, not visual quality.

## 5. Handle trees as separate world objects

Compare the real locations, city tree register and published scenery instances.
Check position, scale, yaw and ground support before adding anything. In the
recorded run, all 118 registered trees already matched the 118 published instances,
so no additional trees were needed.

If references establish a missing tree, place a separate tree instance with suitable
ground support and pedestrian/vehicle clearance. Treat that scenery change as an
additional verified change; it no longer satisfies a texture-only preservation
claim. Never add trees to conceal an incorrect facade or duplicate an existing row.

## 6. Export without disturbing accepted geometry

Use [`repair_facades.ts`](../tools/world/repair_facades.ts) over a verified frozen
cell build. It reconstructs the original atlas layout, checks source-position/UV
correspondence and replaces only embedded facade image payloads. It preserves
compressed geometry and non-image GLB semantics instead of reserializing the whole
scene through a mesh exporter.

The accepted run used the inputs below. For a new task, first verify that they are
still the appropriate baseline and choose a fresh `NEW` directory; these are not
instructions to overwrite the historical run.

An appended city can contain atlases from several separate cell builds. In that
case, `repair_facades.ts` cannot reconstruct the combined layout from a unioned
building list. Use `repair_owner_facades.ts` with a source-bound owner plan: each
owner retains its original city model, build config, page packing and baseline
encoded image hash. Resolve images through the owning node, material, texture
and numeric image index; image names are not unique after append. Before any
art change, require a byte-identical reconstruction of each existing encoded
atlas. Preserve the appended LOD1/LOD2 descriptors and all unselected images.

The October 19 adapter is tested against both real owners at Malminkatu 3/5.
Its draft plan remains reference-pending; this adapter validation does not mean
those elevations have been restored. A qualified plan must name the registered
restoration modules, hashed architectural references and bounded permitted pixel
regions before it can write a fresh output.

```powershell
node tools/world/repair_facades.ts --base data/work/facade-junction-20261017/cells-v4 --city-model data/work/m0/citymodel-v2 --trees data/work/m0/trees-v1 --config content/helsinki/cells.json --texture-cache data/work/facade-cleanup-NEW/encoded-atlases --out data/work/facade-cleanup-NEW/cells-v1
```

Inspect `report.json`, `preservation.json`, `atlas-reuse.json` and
`source-identity.json`. Confirm geometry/accessor/compression bytes and non-image
semantics, collision, runtime terrain and scenery are unchanged. Compare other
published assets against the accepted release too. Record changed atlases and
byte-exact reuse. Cache reuse must be bound to final graded RGBA, dimensions and
encoder identity; a filename alone is insufficient.

Run the affected source checks, then `pnpm typecheck` and `pnpm test` for the final
candidate. Publish to a fresh **staging root** using the existing world publisher
and `--keep`, with the verified terrain, roads, gameplay and accepted asset inputs.
The publisher performs native manifest/budget and glTF validation.

`publish_release.ts` writes `current.json` under its `--out` root. Therefore, do not
publish an unreviewed candidate directly to the active public root. Copy only its
named release directory into `apps/game/public/world/` for review, preserving the
active pointer. Rebuild the review application after staging the release.
Preserve prior releases; never prune them as an incidental cleanup step.

## 7. Review the actual compressed game and iterate

Use `pnpm build:review` and the native `window.__HELSINKI_GAME__` harness. Review
the candidate through `?review=1&release=<candidate-id>` on the single preview
server at `http://127.0.0.1:5317/`. Confirm the loaded manifest and compiled bundle.
Use fresh evidence outputs for every candidate.

Open matching before/after captures at pedestrian height, including front-on,
close, oblique, base, narrow return and corner views. Walk toward the changed
building with actual controls. Check every changed elevation and protected feature,
plus neighbouring charts sharing a modified page. Look for remaining foliage,
duplicated foreground objects, wrong window rhythm, erased doors, seams, misplaced
stone courses and details lost during downsampling/compression.

Record which PNGs were actually opened, their hashes, findings and disposition.
An exported panel, generated screenshot, green test or successful tool exit is
not visual acceptance. Fix concrete findings and export another immutable
candidate. The recorded pass held two intermediate releases after runtime review
found foliage on a narrow Bank return and photographed rails at Estates corners.

Run native performance and gameplay checks serially against that exact candidate.
Templates below require the actual candidate ID and fresh output paths:

```powershell
node tools/verify/verify-browser.ts --url "http://127.0.0.1:5317/?review=1&release=<candidate-id>" --release apps/game/public/world/<candidate-id> --out data/evidence/facade-cleanup-NEW/standard --preset standard
node tools/verify/verify-browser.ts --url "http://127.0.0.1:5317/?review=1&release=<candidate-id>" --release apps/game/public/world/<candidate-id> --out data/evidence/facade-cleanup-NEW/low --preset low
node tools/verify/play-journey.ts --url "http://127.0.0.1:5317/?review=1&release=<candidate-id>" --release apps/game/public/world/<candidate-id> --out data/evidence/facade-cleanup-NEW/journeys --runs 10
```

Check actual uploaded texture memory, draw calls, frame rate, transfer size and
browser errors. Require matching replays of the journey recordings. Fixture
teleports help inspect facades but do not establish playable progression. Use the
compiled review build for transfer/performance claims; a dev server changes the
measurement. Recheck affected evidence after any final source or asset change.

## 8. Activate, smoke-test and hand off

1. Freeze the accepted source/configuration inventory, source-image hashes,
   manifest, review bundle and evidence. Verify that they still match the candidate
   that passed the checks and opened-image review.
2. Save the previous active pointer, then select the accepted local release.
   Build the ordinary application with `pnpm build`.
3. Restart only this project's verified preview process on port 5317 using
   `pnpm preview`. Confirm the previous process stopped and the replacement serves
   the new build. Keep strict-port behaviour; do not create a second server on
   port 4317 to work around a stale process.
4. Smoke-test the default URL without a release override. Verify public and
   compiled pointers, served manifest/assets and bundle identity, actual keyboard
   walking and browser errors. Open the resulting screenshot.
5. Update the handoff and benchmark with scope, exact identities, completed
   checks, opened views, unresolved areas and evidence paths. Local activation
   does not imply an external deployment.

The reference run's
[`completion.json`](../data/evidence/facade-cleanup-20261017/completion.json)
binds the final evidence for `senate-20261017-cbd20b69`: 81 tests, 81 opened facade
captures, 21 validated/served GLBs, both performance presets and ten journeys with
matching replays. These counts describe that run; they are not substitutes for
covering the actual elevations and risks in the next repair.

## Missing source textures on shared fallback materials

An untextured source wall needs a different treatment from foliage baked into a
photograph. First trace actual runtime triangles through their cell, source
building ID, VTJ, material and UVs. A constant UV on the shared `wall` tile is not
a facade chart. Editing that tile would repaint unrelated buildings.

Use unobstructed references to identify the exact elevation, roof steps,
storeys, window rhythm and entrances. Adjacent source records can represent
different wings of one compound: a portico on one record is not evidence for
columns on its long canal-side neighbour. Mark unknown features rather than
repeating guessed windows. Keep the reference photos outside shipped assets;
author original pixels or use separately licensed production art.

For existing source faces, `apply_facade_charts.ts` accepts a pinned chart profile
with exact triangle keys, projection axes, art hashes and references. It removes
only those drawing indices from the shared primitive and draws the same
coordinates and winding once with an isolated atlas. Existing BIN data, images,
untargeted UVs, collision, ground closures and scenery remain preserved. The
textureless distant tier needs explicit source-face correspondence and matching
vertex colours; it must not be regenerated wholesale after ground repairs.

Apply the chart to a fresh unpublished cell copy. Never patch an immutable
staged payload in place: public and compiled release directories may share
hardlinks. Record the source/preservation proof, validate the resulting GLBs,
then review the compressed candidate at street level and measure actual texture
memory and draw calls. Source diagnosis and a correct chart preview alone do not
establish runtime acceptance.

## Per-elevation handoff template

```text
Building / address / city-model ID:
Elevation / source pages / chart or triangle IDs:
Baseline release + manifest/source hashes:
Observed defect and classification:
Street View location / panorama / heading / capture date:
Corroborating references and production licences:
Confirmed layout and protected features:
Donor inputs + hashes / authored details / repair bounds:
Tree-register versus published-instance check:
Module / configuration / tests:
Candidate release + manifest/source hashes:
Preservation checks and opened runtime images:
Performance / journeys / replay / ordinary-build smoke:
Remaining uncertainties or unmodified regions:
Disposition: PASS for named scope / RETHINK / INCOMPLETE
```
