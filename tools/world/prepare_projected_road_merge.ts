// Prepare an exact reviewable merge input from projected native records and a qualified supported-area document.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {isDeepStrictEqual} from 'node:util';
import {decodeRoadGraph, decodeSimulationPayload, type RoadGraph, type Vec3} from '../../packages/world-schema/src/index.ts';
import {loadGeoJsonPolygons} from './lib/geometry.ts';
import {readSourceFile, sourceSha256, writeSourceJson} from './lib/source-files.ts';
import {inspectRetainedRoadExposure, inspectRetainedPathExposure, type RoadMergeSelection} from './lib/expansion-road-merge.ts';
import {assertOutsideOnlyRoadGraphRepair} from './lib/road-outside-repair.ts';
import {readQualifiedSupportedArea} from './lib/delivery-supported-area.ts';
const {values} = parseArgs({options: {plan: {type: 'string'}, projection: {type: 'string'}, 'native-cells': {type: 'string'}, 'supported-area': {type: 'string'}, out: {type: 'string'}}});
assert.ok(values.plan && values.projection && values['native-cells'] && values['supported-area'] && values.out); assert.ok(!fs.existsSync(values.out), 'Fresh merge preparation output required');
const pin = (file: string) => {const bytes = fs.readFileSync(file); return {file: path.resolve(file), sha256: sourceSha256(bytes)};};
const checked = (ref: {file: string; sha256: string}) => {const bytes = fs.readFileSync(ref.file); assert.equal(sourceSha256(bytes), ref.sha256); return JSON.parse(bytes.toString());};
const sourcePlanPin = pin(values.plan), sourcePlan = checked(sourcePlanPin), projectionPin = pin(values.projection), projection = checked(projectionPin); assert.equal(projection.planSha256, sourcePlanPin.sha256);
const root = sourcePlan.acceptedWorld, manifestPin = pin(path.join(root, 'manifest.json')), manifest = checked(manifestPin); assert.equal(manifestPin.sha256, projection.acceptedManifestSha256);
const original = decodeRoadGraph(await decodeSimulationPayload(readSourceFile(root, manifest.roads), manifest.roads)), accepted = checked(projection.repairedAcceptedRoads) as RoadGraph, candidate = checked(projection.projectedCandidateRoads) as RoadGraph;
const coverage = JSON.parse(readSourceFile(root, manifest.gameplay).toString()); assert.deepEqual(assertOutsideOnlyRoadGraphRepair(original, accepted, coverage), projection.changes);
const areaPin = pin(values['supported-area']); const expanded = {playArea: sourcePlan.expandedCoverage.playArea, supportedArea: readQualifiedSupportedArea({path: areaPin.file, sha256: areaPin.sha256}, {manifestSha256: manifestPin.sha256, originId: manifest.origin.id, gameplay: coverage}, sourcePlan.expandedCoverage.playArea).supportedArea};
const metadata = checked(projection.nativeMetadata), streetPin = pin(metadata.inputs.streetParts.path); assert.equal(streetPin.sha256, metadata.inputs.streetParts.sha256);
const parts = loadGeoJsonPolygons(streetPin.file, manifest.origin.originProjected[0], manifest.origin.originProjected[1], (p, i) => String(p.osan_id ?? p.id ?? i));
const qualification = (record: {id: string; points: readonly Vec3[]}, walking = false) => {
  const p = record.points, b = [Math.min(...p.map(p => p[0])) - 4, Math.min(...p.map(p => p[2])) - 4, Math.max(...p.map(p => p[0])) + 4, Math.max(...p.map(p => p[2])) + 4];
  return {id: record.id, partIds: [...new Set(parts.filter(part => (walking ? ['Ajorata', 'Kevyt liikenne', 'Muu rakenneosa'].includes(String(part.properties.paatyyppi)) : part.properties.alatyyppi === 'Ajorata') && part.bbox[2] >= b[0]! && part.bbox[0] <= b[2]! && -part.bbox[1] >= b[1]! && -part.bbox[3] <= b[3]!).map(part => part.id))]};
};
const exposure = inspectRetainedRoadExposure(accepted, coverage, expanded), oldIds = new Set(accepted.lanes.map(lane => lane.id));
const selection: RoadMergeSelection = {schemaVersion: 1, regions: [metadata.target], acceptedAnchorLaneIds: [sourcePlan.retainedLaneIds[0]], lanes: sourcePlan.newLaneIds.map((id: string) => qualification(candidate.lanes.find(lane => lane.id === id)!)), retainedLanes: exposure.map(tail => qualification(accepted.lanes.find(lane => lane.id === tail.id)!)), connectors: [], seamConnectors: [], retainedConflicts: [], structures: [], levelTransitions: []};
if (sourcePlan.walkingRoutes) {
  selection.footways = sourcePlan.newFootwayIds.map((id: string) => qualification(candidate.footways.find(record => record.id === id)!, true));
  selection.retainedFootways = inspectRetainedPathExposure(accepted.footways, coverage, expanded).map(tail => qualification(accepted.footways.find(record => record.id === tail.id)!, true));
  selection.walkingRoutes = sourcePlan.walkingRoutes;
}
for (const id of sourcePlan.connectorIds) {
  const connector = candidate.connectors.find(connector => connector.id === id)!; assert.ok(connector); const ref = qualification(connector);
  if (oldIds.has(connector.from) || oldIds.has(connector.to)) selection.seamConnectors.push({connector, osmNodeId: Number(connector.node.slice(1)), partIds: ref.partIds, ...(oldIds.has(connector.from) && oldIds.has(connector.to) ? {retainedBoundary: true as const} : {})});
  else selection.connectors.push(ref);
}
// Newly exposed side-street tails are audited, but are not traversal anchors unless an explicit source seam connects them.
selection.acceptedAnchorLaneIds = [...new Set(selection.seamConnectors.flatMap(ref => [ref.connector.from, ref.connector.to]).filter(id => oldIds.has(id)))];
assert.ok(selection.acceptedAnchorLaneIds.length > 0, 'Selected road network has no explicit accepted traversal anchor');
for (const kind of ['nodes', 'lanes', 'connectors', 'parking', 'footways'] as const) {
  const old = new Map(accepted[kind].map(record => [record.id, record]));
  for (const fresh of candidate[kind]) {const prior = old.get(fresh.id); if (!prior || isDeepStrictEqual(prior, fresh)) continue;
    selection.retainedConflicts.push({kind, id: fresh.id, acceptedSha256: sourceSha256(JSON.stringify(prior)), candidateSha256: sourceSha256(JSON.stringify(fresh)), reason: 'Preserve this exact accepted record (or explicitly bound outside-only repair) over the fresh regional rebuild. Every newly exposed retained path requires independent current source/physical qualification; this conflict witness alone authorizes no geometry replacement.'});}
}
const ledgerPin = pin(metadata.inputs.osmLedger.path), ledger = checked(ledgerPin), snapshots = Object.values(ledger.snapshots) as {path: string; sha256: string}[]; assert.equal(snapshots.length, 1);
const osmPin = pin(path.join(path.dirname(ledgerPin.file), snapshots[0]!.path)); assert.equal(osmPin.sha256, snapshots[0]!.sha256);
const indexPin = pin(path.join(values['native-cells'], 'cells.json'));
const job = {schemaVersion: 1, acceptedWorld: root, expectedManifestSha256: manifestPin.sha256, candidateRoads: pin(projection.projectedCandidateRoads.file), osm: osmPin, streetParts: streetPin, expandedSupportedArea: areaPin, nativeCells: {directory: path.resolve(values['native-cells']), indexSha256: indexPin.sha256}, outsideProjection: projectionPin, selection};
fs.mkdirSync(values.out, {recursive: true}); const jobPin = writeSourceJson(values.out, 'merge-plan.json', job);
writeSourceJson(values.out, 'merge-preparation.json', {schemaVersion: 1, status: 'PREPARED_REQUIRES_SOURCE_AND_PHYSICAL_QUALIFICATION', jobPin, projectionPin, areaPin, nativeIndex: indexPin, newLaneIds: sourcePlan.newLaneIds, exposedRetainedLanes: exposure, retainedConflictCount: selection.retainedConflicts.length});
console.log(JSON.stringify({mergePlan: path.resolve(values.out, jobPin.path), newLanes: selection.lanes.length, retainedExposed: exposure.length, conflicts: selection.retainedConflicts.length, nativeIndexSha256: indexPin.sha256}));
