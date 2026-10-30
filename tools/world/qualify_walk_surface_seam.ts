// Explicitly qualify a bounded municipal partition seam using current public OSM foot access and serialized native pavement.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {gunzipSync} from 'node:zlib';
import polygonClipping from 'polygon-clipping';
import {geodeticToGk25, parseCollisionBundle, MAX_SIMULATION_PAYLOAD_BYTES, type SupportedArea, type CellDescriptor, type Vec3} from '../../packages/world-schema/src/index.ts';
import {readSourceFile, sourceSha256, writeSourceJson} from './lib/source-files.ts';
import {readQualifiedSupportedArea, assertSupportedAreaPreservesAccepted} from './lib/delivery-supported-area.ts';
import {RoadCollisionSupport, isPublicWalkingGroundTag, type RoadSupportTriangle} from './lib/expansion-road-merge.ts';
const {values} = parseArgs({options: {plan: {type: 'string'}, out: {type: 'string'}}}); assert.ok(values.plan && values.out && !fs.existsSync(values.out));
const pin = (file: string) => {const bytes = fs.readFileSync(file); return {path: path.resolve(file), bytes: bytes.length, sha256: sourceSha256(bytes)};};
const read = (ref: {file: string; sha256: string}) => {const p = pin(ref.file); assert.equal(p.sha256, ref.sha256); assert.ok(p.bytes <= 128_000_000); return JSON.parse(fs.readFileSync(p.path, 'utf8'));};
const planPin = pin(values.plan), plan = JSON.parse(fs.readFileSync(values.plan, 'utf8')); assert.equal(plan.schemaVersion, 1); assert.equal(plan.kind, 'source-native-public-walking-seam');
const r = plan.boundsXZ as [number, number, number, number]; assert.ok(r.length === 4 && r.every(Number.isFinite) && r[2] > r[0] && r[3] > r[1] && r[2] - r[0] <= 3 && r[3] - r[1] <= 3);
assert.ok(plan.maxAddedAreaSquareMetres > 0 && plan.maxAddedAreaSquareMetres <= .00001, 'This narrow seam producer cannot add an area-scale patch');
const walking = read(plan.walkingPlan), manifestPin = pin(path.join(walking.acceptedWorld, 'manifest.json')); assert.equal(manifestPin.sha256, walking.acceptedManifestSha256);
const manifest = JSON.parse(fs.readFileSync(manifestPin.path, 'utf8')), gameplay = JSON.parse(readSourceFile(walking.acceptedWorld, manifest.gameplay).toString()), authority = {manifestSha256: manifestPin.sha256, originId: manifest.origin.id, gameplay};
const base = readQualifiedSupportedArea({path: plan.baseArea.file, sha256: plan.baseArea.sha256}, authority, walking.expandedPlayArea).supportedArea;
const publicArea = readQualifiedSupportedArea({path: walking.publicArea.file, sha256: walking.publicArea.sha256}, authority, walking.expandedPlayArea).supportedArea;
const osm = read(walking.osm), way = osm.elements.find((e: any) => e.type === 'way' && e.id === plan.wayId); assert.ok(way?.nodes && ['yes', 'designated', 'permissive'].includes(way.tags?.foot), 'Seam needs explicit public pedestrian access');
const projection = read(plan.roadProjection); assert.equal(projection.acceptedManifestSha256, manifestPin.sha256); assert.equal(projection.kind, 'source-bound-outside-road-projection');
const projectedRoads = read(projection.repairedAcceptedRoads), projectedFootway = projectedRoads.footways.find((record: any) => record.id === `w${plan.wayId}`); assert.ok(projectedFootway);
function expectedHeight(x: number, z: number) {let distance = Infinity, height = NaN; const points = projectedFootway.points as Vec3[];
  for (let i = 1; i < points.length; i++) {const a = points[i - 1]!, b = points[i]!, dx = b[0] - a[0], dz = b[2] - a[2], squared = dx * dx + dz * dz; if (!squared) continue; const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[2]) * dz) / squared)), gap = Math.hypot(x - a[0] - dx * t, z - a[2] - dz * t); if (gap < distance) {distance = gap; height = a[1] + (b[1] - a[1]) * t;}}
  assert.ok(distance <= walking.halfWidthMetres + .002 && Number.isFinite(height), 'Seam is outside its bound projected walking path'); return height;
}
assert.ok((!way.tags.bridge || way.tags.bridge === 'no') && (!way.tags.tunnel || way.tags.tunnel === 'no') && Number(way.tags.layer ?? 0) === 0);
const from = way.nodes.indexOf(plan.fromNode), to = way.nodes.indexOf(plan.toNode); assert.ok(Math.abs(to - from) === 1 && from >= 0 && to >= 0, 'A seam must bind one explicit adjacent source-node pair');
assert.ok(walking.steps.some((step: any) => step.wayId === plan.wayId && Math.min(way.nodes.indexOf(step.fromNode), way.nodes.indexOf(step.toNode)) <= Math.min(from, to) && Math.max(way.nodes.indexOf(step.fromNode), way.nodes.indexOf(step.toNode)) >= Math.max(from, to)), 'Seam is not on the reviewed walking circuit');
const sourcePoints = [plan.fromNode, plan.toNode].map(id => {const node = osm.elements.find((e: any) => e.type === 'node' && e.id === id); assert.ok(Number.isFinite(node?.lat) && Number.isFinite(node?.lon)); const [e, n] = geodeticToGk25(node.lat, node.lon); return [e - manifest.origin.originProjected[0], manifest.origin.originProjected[1] - n] as [number, number];});
const [a, b] = sourcePoints, dx = b![0] - a![0], dz = b![1] - a![1], length = Math.hypot(dx, dz), width = walking.halfWidthMetres; assert.ok(width >= .5 && width <= 2 && length > 0 && length < 10);
const x = -dz / length * width, z = dx / length * width;
const corridor: polygonClipping.Polygon = [[[a![0] + x, a![1] + z], [a![0] - x, a![1] - z], [b![0] - x, b![1] - z], [b![0] + x, b![1] + z]]], rectangle: polygonClipping.Polygon = [[[r[0], r[1]], [r[2], r[1]], [r[2], r[3]], [r[0], r[3]]]];
const index = read(plan.nativeCells), root = path.dirname(plan.nativeCells.file), faces: polygonClipping.Polygon[] = [], triangles: RoadSupportTriangle[] = [], collisionPins = [];
for (const cell of index.cells as CellDescriptor[]) {
  const bounds = cell.collision.boundsXZ ?? cell.boundsXZ; if (bounds[0] > r[2] || bounds[2] < r[0] || bounds[1] > r[3] || bounds[3] < r[1]) continue;
  const encoded = readSourceFile(root, cell.collision), decoded = cell.collision.compression === 'gzip' ? gunzipSync(encoded, {maxOutputLength: MAX_SIMULATION_PAYLOAD_BYTES}) : encoded;
  if (cell.collision.compression) {assert.equal(sourceSha256(decoded), cell.collision.decodedSha256); assert.equal(decoded.length, cell.collision.decodedBytes);}
  collisionPins.push(pin(path.join(root, cell.collision.path))); const bundle = parseCollisionBundle(Uint8Array.from(decoded)); assert.equal(bundle.header.cell, cell.id); assert.equal(bundle.header.originId, manifest.origin.id);
  for (const collider of bundle.colliders) if (collider.group === 'ground') for (let i = 0; i < collider.indices.length; i += 3) {
    const tag = bundle.header.surfaceTags[collider.triangleTags[i / 3]!]!; if (!isPublicWalkingGroundTag(tag)) continue;
    const points = [0, 1, 2].map(k => Array.from(collider.positions.subarray(collider.indices[i + k]! * 3, collider.indices[i + k]! * 3 + 3)) as Vec3) as [Vec3, Vec3, Vec3];
    if (Math.max(...points.map(p => p[0])) < r[0] || Math.min(...points.map(p => p[0])) > r[2] || Math.max(...points.map(p => p[2])) < r[1] || Math.min(...points.map(p => p[2])) > r[3]) continue;
    const [u, v, w] = points, ux = v[0] - u[0], uy = v[1] - u[1], uz = v[2] - u[2], vx = w[0] - u[0], vy = w[1] - u[1], vz = w[2] - u[2], normal = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx]; if (normal[1]! / Math.hypot(...normal) < .65) continue;
    triangles.push({id: `${cell.id}:${collider.id}:${i / 3}`, tag, points}); faces.push([points.map(p => [p[0], p[2]])]);
  }
}
assert.ok(faces.length > 0 && faces.length < 5000); let ground: polygonClipping.MultiPolygon = []; for (let i = 0; i < faces.length; i += 64) ground = polygonClipping.union(ground, ...faces.slice(i, i + 64));
const polygons = (area: SupportedArea): polygonClipping.MultiPolygon => area.regions.map(region => [region.outer.map(p => [...p] as [number, number]), ...(region.holes ?? []).map(ring => ring.map(p => [...p] as [number, number]))]);
const delta = polygonClipping.difference(polygonClipping.intersection([corridor], [rectangle], ground), polygons(publicArea));
const ringArea = (ring: polygonClipping.Ring) => {const origin = ring[0]!; return Math.abs(ring.reduce((sum, p, i) => {const q = ring[(i + 1) % ring.length]!; return sum + (p[0] - origin[0]) * (q[1] - origin[1]) - (q[0] - origin[0]) * (p[1] - origin[1]);}, 0)) / 2;};
const area = delta.reduce((sum, polygon) => sum + ringArea(polygon[0]!) - polygon.slice(1).reduce((n, ring) => n + ringArea(ring), 0), 0); assert.ok(area > 0 && area <= plan.maxAddedAreaSquareMetres, `Seam addition ${area} square metres exceeds its bound`);
const support = new RoadCollisionSupport(triangles, isPublicWalkingGroundTag), physical = [];
for (const polygon of delta) for (const ring of polygon) for (let i = 0; i < ring.length; i++) for (const fraction of [0, .5]) {const p = ring[i]!, q = ring[(i + 1) % ring.length]!, x = p[0] + (q[0] - p[0]) * fraction, z = p[1] + (q[1] - p[1]) * fraction, y = expectedHeight(x, z), hit = support.at(x, y, z); assert.ok(hit, 'Seam vertex lacks serialized native pavement at the source-bound walking height'); physical.push({x, z, expectedFootwayHeight: y, ...hit});}
const composed = polygonClipping.union(polygons(base), delta), supportedArea: SupportedArea = {schemaVersion: 1, regions: composed.map((p, i) => ({id: `bulevardi-drive-walk-seam-${i}`, outer: p[0]!.slice(0, -1), ...(p.length > 1 ? {holes: p.slice(1).map(ring => ring.slice(0, -1))} : {})}))}; assertSupportedAreaPreservesAccepted(supportedArea, gameplay, walking.expandedPlayArea);
const seam = {wayId: plan.wayId, fromNode: plan.fromNode, toNode: plan.toNode, sourceWaySha256: sourceSha256(JSON.stringify(way)), boundsXZ: r, addedAreaSquareMetres: area, addedPolygons: delta, nativeTriangles: triangles.map(triangle => triangle.id), physical, sourceFootwayAndSerializedNativeGroundQualified: true};
const document = {schemaVersion: 1, kind: 'qualified-expansion-supported-area', acceptedManifestSha256: manifestPin.sha256, originId: manifest.origin.id, qualification: {status: 'PASS_SOURCE_QUALIFIED_SUPPORTED_AREA', physicalNavigationStatus: 'PENDING_COMPLETE_ROAD_WALK_MERGE_AND_ACTUAL_CONTROLS', policy: 'One explicit public-footway/serialized-native-pavement municipal partition seam; added geometry is the exact missing source sliver within the reviewed walking corridor and bounded rectangle'}, sourceFiles: [planPin, pin(plan.walkingPlan.file), pin(plan.baseArea.file), pin(walking.publicArea.file), pin(walking.osm.file), pin(plan.nativeCells.file), pin(plan.roadProjection.file), pin(projection.repairedAcceptedRoads.file), ...collisionPins], seam, supportedArea};
fs.mkdirSync(values.out, {recursive: true}); const result = writeSourceJson(values.out, 'supported-area.json', document); writeSourceJson(values.out, 'seam-qualification.json', {schemaVersion: 1, status: 'PASS_SOURCE_FOOTWAY_SERIALIZED_NATIVE_SEAM', ...seam, result}); console.log(JSON.stringify({file: path.resolve(values.out, result.path), sha256: result.sha256, addedAreaSquareMetres: area, triangles: triangles.length}));
