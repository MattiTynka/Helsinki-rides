// Register a newly authored two-lane road against explicitly reviewed municipal carriageway polygons.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {decodeRoadGraph, decodeSimulationPayload, geodeticToGk25, polylineLength, validateRoadGraph, type Vec3} from '../../packages/world-schema/src/index.ts';
import {loadGeoJsonPolygons} from './lib/geometry.ts';
import {measurePairedRoadAlignment, pairedAlignedRoadPoints} from './lib/measured-road-alignment.ts';
import {readSourceFile, sourceSha256, writeSourceJson} from './lib/source-files.ts';

const {values} = parseArgs({options: {plan: {type: 'string'}, out: {type: 'string'}}});
assert.ok(values.plan && values.out && !fs.existsSync(values.out));
const pin = (ref: {file: string; sha256: string}, cap = 128_000_000) => {
  const stat = fs.lstatSync(ref.file); assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= cap);
  const bytes = fs.readFileSync(ref.file); assert.equal(sourceSha256(bytes), ref.sha256); return bytes;
};
const planBytes = fs.readFileSync(values.plan); assert.ok(planBytes.length < 1_000_000);
const plan = JSON.parse(planBytes.toString()); assert.equal(plan.schemaVersion, 1);
assert.deepEqual(Object.keys(plan).sort(), ['schemaVersion', 'acceptedWorld', 'acceptedManifestSha256', 'candidateRoads', 'osm', 'streetParts', 'wayId', 'sourceWaySha256', 'partIds', 'bounds', 'physicalLaneWidthMetres', 'reason'].sort());
assert.ok(Number.isSafeInteger(plan.wayId) && typeof plan.reason === 'string' && plan.reason.length > 20 && plan.reason.length < 2000);
const manifest = JSON.parse(pin({file: path.join(plan.acceptedWorld, 'manifest.json'), sha256: plan.acceptedManifestSha256}, 8_000_000).toString());
const accepted = decodeRoadGraph(await decodeSimulationPayload(readSourceFile(plan.acceptedWorld, manifest.roads), manifest.roads));
const original = decodeRoadGraph(pin(plan.candidateRoads)), graph = structuredClone(original);
const osm = JSON.parse(pin(plan.osm).toString()), way = osm.elements.find((e: any) => e.type === 'way' && e.id === plan.wayId);
assert.ok(way?.nodes?.length >= 2 && way.nodes.length <= 10_000); assert.equal(sourceSha256(JSON.stringify(way)), plan.sourceWaySha256);
assert.equal(graph.source.sha256, plan.osm.sha256); assert.equal(graph.originId, manifest.origin.id);
assert.equal(way.tags.lanes, '2', 'Only an explicitly two-lane source way is eligible');
assert.ok(!['yes', '1', '-1'].includes(way.tags.oneway) && !way.tags.bridge && !way.tags.tunnel && Number(way.tags.layer ?? 0) === 0);
for (const key of ['access', 'vehicle', 'motor_vehicle']) assert.ok(way.tags[key] === undefined || ['yes', 'designated', 'permissive'].includes(way.tags[key]), 'Source vehicle access is restricted');
assert.ok(!Object.keys(way.tags).some(key => key.startsWith('placement')), 'Explicit source placement needs its own interpretation');
const nodes = new Map<number, any>(osm.elements.filter((e: any) => e.type === 'node').map((e: any) => [e.id, e]));
const axis: Vec3[] = way.nodes.map((id: number) => {
  const node = nodes.get(id); assert.ok(node && Number.isFinite(node.lat) && Number.isFinite(node.lon));
  const [east, north] = geodeticToGk25(node.lat, node.lon); return [east - manifest.origin.originProjected[0], 0, manifest.origin.originProjected[1] - north];
});
pin(plan.streetParts); assert.ok(Array.isArray(plan.partIds) && plan.partIds.length > 0 && new Set(plan.partIds).size === plan.partIds.length);
const allParts = loadGeoJsonPolygons(plan.streetParts.file, manifest.origin.originProjected[0], manifest.origin.originProjected[1], p => String(p.osan_id));
const parts = plan.partIds.map((id: string) => {const part = allParts.find(p => p.id === id); assert.ok(part && part.properties.alatyyppi === 'Ajorata' && part.properties.alueen_nimi === way.tags.name, 'Source carriageway identity differs'); return part;});
const lanes = graph.lanes.filter(lane => lane.wayId === plan.wayId); assert.equal(lanes.length, 2);
const forward = lanes.find(lane => lane.id === `${plan.wayId}:0:f0`), backward = lanes.find(lane => lane.id === `${plan.wayId}:0:b0`);
assert.ok(forward && backward && lanes.every(lane => lane.count === 1 && lane.index === 0 && !accepted.lanes.some(old => old.id === lane.id)));
assert.equal(forward.width, backward.width); assert.equal(forward.from, `n${way.nodes[0]}`); assert.equal(forward.to, `n${way.nodes.at(-1)}`);
assert.equal(backward.from, forward.to); assert.equal(backward.to, forward.from);
const gameplay = JSON.parse(readSourceFile(plan.acceptedWorld, manifest.gameplay).toString());
let physicalHalfWidth = 0, physicalHalfLength = 0;
for (const definition of gameplay.vehicleDefinitions) {
  for (const box of [definition.collider, ...definition.collider.skid ? [definition.collider.skid] : []]) {physicalHalfWidth = Math.max(physicalHalfWidth, Math.abs(box.centre[0]) + box.halfExtents[0]); physicalHalfLength = Math.max(physicalHalfLength, Math.abs(box.centre[2]) + box.halfExtents[2]);}
  for (const wheel of definition.wheels) {physicalHalfWidth = Math.max(physicalHalfWidth, Math.abs(wheel.position[0]) + definition.wheelWidth / 2); physicalHalfLength = Math.max(physicalHalfLength, Math.abs(wheel.position[2]) + definition.wheelRadius);}
}
assert.ok(Number.isFinite(plan.physicalLaneWidthMetres) && plan.physicalLaneWidthMetres <= forward.width && plan.physicalLaneWidthMetres >= 2 * (physicalHalfWidth + .1 + .025), 'New lane width must contain every usable vehicle and its existing clearance');
assert.ok(plan.bounds.sourceHalfEnvelopeMetres >= plan.physicalLaneWidthMetres / 2 + physicalHalfWidth + .1 + .025, 'Both lanes, every usable body/tyre envelope, existing clearance and authoring reserve are required');
assert.ok(plan.bounds.longitudinalHalfEnvelopeMetres >= physicalHalfLength + .1 + .025, 'Full longitudinal vehicle overhang must participate in the source alignment');
const profile = measurePairedRoadAlignment(axis, parts, plan.bounds), changes: unknown[] = [];
assert.ok(2 * plan.physicalLaneWidthMetres + .05 <= profile.minimumSourceWidthMetres, 'Measured carriageway cannot contain the declared pair of lane widths');
for (const [record, points] of [[forward, pairedAlignedRoadPoints(axis, profile, plan.physicalLaneWidthMetres / 2)], [backward, pairedAlignedRoadPoints(axis, profile, -plan.physicalLaneWidthMetres / 2).reverse()]] as const) {
  const before = structuredClone(record), after = {...record, width: plan.physicalLaneWidthMetres, points, length: polylineLength(points)};
  Object.assign(record, after); changes.push({kind: 'lanes', id: record.id, beforeSha256: sourceSha256(JSON.stringify(before)), afterSha256: sourceSha256(JSON.stringify(after)), before, after});
}
for (const connector of graph.connectors) if (lanes.some(lane => lane.id === connector.from || lane.id === connector.to)) {
  assert.ok(!accepted.connectors.some(old => old.id === connector.id), 'Accepted connector cannot be registered');
  const from = graph.lanes.find(lane => lane.id === connector.from)!, to = graph.lanes.find(lane => lane.id === connector.to)!;
  assert.equal(from.to, connector.node); assert.equal(to.from, connector.node);
  const before = structuredClone(connector), a = before.points[0]!, b = before.points.at(-1)!, targetA = from.points.at(-1)!, targetB = to.points[0]!;
  const shiftA = [targetA[0] - a[0], targetA[2] - a[2]], shiftB = [targetB[0] - b[0], targetB[2] - b[2]];
  assert.ok(Math.max(Math.hypot(...shiftA), Math.hypot(...shiftB)) <= plan.bounds.maximumShiftMetres + .001, 'Connector endpoint displacement exceeds the reviewed road registration');
  const length = polylineLength(before.points); let along = 0;
  const points = before.points.map((point, i): Vec3 => {
    if (i) along += Math.hypot(point[0] - before.points[i - 1]![0], point[2] - before.points[i - 1]![2]);
    const t = length ? along / length : i / (before.points.length - 1);
    return [point[0] + (1 - t) * shiftA[0]! + t * shiftB[0]!, point[1], point[2] + (1 - t) * shiftA[1]! + t * shiftB[1]!];
  });
  points[0] = [...targetA]; points[points.length - 1] = [...targetB];
  const after = {...connector, points, length: polylineLength(points)}; Object.assign(connector, after);
  changes.push({kind: 'connectors', id: connector.id, sourceNode: connector.node, shiftA, shiftB, beforeSha256: sourceSha256(JSON.stringify(before)), afterSha256: sourceSha256(JSON.stringify(after)), before, after});
}
assert.deepEqual(validateRoadGraph(graph), []);
// Validate source bytes again before writing an authoring receipt.
pin(plan.candidateRoads); pin(plan.osm); pin(plan.streetParts);
fs.mkdirSync(values.out, {recursive: true}); const roadRef = writeSourceJson(values.out, 'roads-source-registered.json', graph);
const receipt = {schemaVersion: 1, kind: 'municipal-measured-two-lane-registration', status: 'REGISTERED_PENDING_NATIVE_PROJECTION_COMPLETE_FOOTPRINTS_AND_TRAVEL', planSha256: sourceSha256(planBytes), acceptedManifestSha256: plan.acceptedManifestSha256,
  originalCandidateRoads: plan.candidateRoads, osm: plan.osm, streetParts: plan.streetParts, wayId: plan.wayId, sourceWaySha256: plan.sourceWaySha256, partIds: plan.partIds, reason: plan.reason,
  physicalHalfWidth, physicalHalfLength, physicalLaneWidthMetres: plan.physicalLaneWidthMetres, existingClearanceMetres: .1, authoringReserveMetres: .025, profile, changes, registeredRoads: {...roadRef, file: path.resolve(values.out, roadRef.path)},
  acceptedRecordsEdited: false, sourceNodeIdentitiesPreserved: true, physicalLaneCountPreserved: true, producerSha256: sourceSha256(fs.readFileSync(import.meta.filename)), helperSha256: sourceSha256(fs.readFileSync(new URL('./lib/measured-road-alignment.ts', import.meta.url)))};
const receiptRef = writeSourceJson(values.out, 'road-registration-receipt.json', receipt);
console.log(JSON.stringify({receipt: path.resolve(values.out, receiptRef.path), sha256: receiptRef.sha256, changes: changes.length, maximumShiftMetres: profile.maximumShiftMetres, minimumSourceWidthMetres: profile.minimumSourceWidthMetres, status: receipt.status}));
