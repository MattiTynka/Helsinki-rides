# Bounded geography acquisition

`prepare_accepted_coverage.ts` creates the private decoded-ground subtraction input from a pinned native world. It verifies every collision's stored and decoded hashes, native HCOL identity and arrays, recorded collision extent, cell ownership, and unique building owners. Cross-cell building references are retained separately from ownership. It supports the manifest's actual cell count; it does not infer playable coverage from the envelope.

```powershell
node tools/world/prepare_accepted_coverage.ts --source ACCEPTED_WORLD --expected MANIFEST_SHA256 --out FRESH_COVERAGE
node tools/world/prepare_accepted_coverage.ts --source ACCEPTED_WORLD --expected MANIFEST_SHA256 --verify FRESH_COVERAGE
```

The coverage directory contains `cells.json`, exact decoded `collision/*.bin`, `accepted-building-owners.json`, and `coverage-adapter.json`. Pass the directory to `build_cells.ts --exclude-ground-cells`, and pass the original native manifest separately to `--accepted-building-manifest`. Coverage proxies cannot authorize building replacement or serve as a world release. Full-world visual/asset closure remains a separate validation gate.

`acquire_geography.ts` consumes the explicit selected-source job defined in `lib/acquisition-job.ts`. A metadata inspection must choose the bounded tile URLs, their transforms, dataset vintage, projected acquisition envelope, and source/license metadata first. It does not choose a new vintage or broaden geographic scope automatically.

```powershell
node tools/world/acquire_geography.ts --job SELECTED_JOB.json --out FRESH_RAW_DIRECTORY
node tools/world/acquire_geography.ts --job SELECTED_JOB.json --out FRESH_RAW_DIRECTORY --resume
```

The job sets an EPSG:3879 bbox, snapshot name, total network budget, per-payload cap, optional timeout/retry limits, and optional concurrency of one to five (default four). Tile layers provide selected payloads plus native index metadata such as `tilesetVersion` or terrain `layerVersion`, `version`, `zoom`, and `layerJsonSha256`. A metadata selection may reference a cached tile using its root, relative path, byte length and SHA-256. Cache bytes are verified and copied, keeping source inputs independent from writable outputs.

WFS layers use explicit projected partitions, either the building-register or street-part type, a stable identity property, and a feature ceiling of at most 5,000. Full or possibly truncated partitions, incomplete result counts, unexpected CRS/axis order, and nonpolygon features fail the job. Subdivide failed partitions in a reviewed new job. An optional accepted snapshot is retained first; changed duplicates go into `conflicts.json` and never silently replace the accepted record.

OSM layers retain original map responses and verify way nodes and relation members. Closure prefers a relation/way full response over many individual node calls. Its request budget is cumulative across resumes. `closure-incomplete-*.json` names missing references and attempted fetches; it is not a claim of complete coverage. An explicit `--osm-review REVIEW.json` can bind the stopped progress, unchanged job, consumer source hashes and individually hashed nonconsumed aggregation relations. Geometry/access/restriction/bridge relations cannot be excluded. Reviewed output says `reviewed-native-consumers-not-global-osm`; all original raw observations remain. Later amendments explicitly supersede the previous review and preserve consumed request counts. Accepted-base snapshots retain their original reviewed-closure provenance.

Only fixed municipal datasource/WFS and OSM API HTTPS endpoints may be fetched. Credentials, nonstandard ports and redirects are rejected. Requests reserve budget before I/O, stream within byte caps, and time out. A process interrupted during a reservation conservatively keeps that reservation charged on resume. Settlement runs once; journal-write failures do not refund twice. A received overflow chunk is fully charged and an over-budget journal rejects before any resumed fetch. Started concurrent requests settle before a failure returns. No source directory is deleted, and an existing output directory requires explicit resume with the identical job hash. Existing payloads must match their recorded URL, size and SHA-256; unknown files are not adopted.

Outputs are native-compatible per-layer ledgers and snapshot indexes or GeoJSON/OSM documents, original response parts, a progress journal and a final `acquisition-report.json`. The report's status is `ACQUIRED_PENDING_GEOMETRY_AND_CONFLICT_REVIEW`: source download and closure do not prove collision, navigation, terrain seams or gameplay. Accepted building exclusion and producer/version receipts remain mandatory during conversion and append.

Focused checks:

```powershell
node --test tools/world/test/accepted-coverage.test.ts tools/world/test/bounded-acquisition.test.ts
```
