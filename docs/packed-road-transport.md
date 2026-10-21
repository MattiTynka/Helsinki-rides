# Lossless road delivery

Native floor registration adds road knots where the actual surface changes its
linear profile. Every source X/Z vertex, source topology and required floor knot
is retained. Coordinates are not rounded to make the download smaller.

New releases may store roads as `roads.<hash>.bin.gz`. The manifest uses the same
`SimulationFileRef` contract as terrain and collision: stored byte count/SHA-256,
`compression: gzip`, and independent decoded byte count/SHA-256. Browser startup,
Node replay and release staging validate these pins before parsing. The decoded
packed transport must fit **8,000,000 bytes**; the existing general simulation
decode/expanded logical graph ceiling remains **64 MiB**. Legacy JSON road graphs
remain readable. Gameplay JSON and recording commands are unchanged.

`packages/world-schema/src/packed-roads.ts` owns encoding and logical decoding.
`HROADS01` contains a bounded UTF-8 metadata header, a shared string dictionary,
fixed schema2 record columns and contiguous little-endian **Float64 XYZ** values.
Each point's double precision value survives literally. Numeric metadata also
preserves negative zero. Decoding returns the original ordinary schema2
`RoadGraph`; simulation code and recordings never consume packed tables.

The 32-byte fixed header is:

| Offset | Value |
| --- | --- |
|0|Eight ASCII bytes `HROADS01`|
|8|Little-endian uint32 transport version 1|
|12|UTF-8 JSON header byte count|
|16|XYZ point count|
|20|Reserved uint32, zero|
|24|Float64 data offset, aligned to 8 bytes|
|28|Total decoded transport byte count|

Alignment padding is zero. Metadata records reference contiguous, nonoverlapping
point intervals in nodes/lanes/connectors/parking/footways order. Fixed field
names, row widths, dictionary indices, finite coordinates, record/point counts,
expanded size and logical road links are validated. Unexpected fields and unsafe
prototype keys fail. The Pages stager independently validates the packed envelope
and all physical doubles. A transport change requires fresh browser startup,
real input journeys and deterministic Node replay on the final release.

The road coordinator first writes a private diagnostic plan. Its decoded road
size measures the packed transport separately from the equivalent JSON size.
Source/native qualification, the 1 mm floor profile check, exact old chord
protection and world/file budgets remain independent gates. A smaller transport
does not qualify an unresolved floor or an unsupported public route.
