// Add only an explicitly selected, source-connected public walking circuit to an already qualified milestone mask.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {parseArgs} from 'node:util';
import polygonClipping from 'polygon-clipping';
import {geodeticToGk25, type SupportedArea, type Vec3} from '../../packages/world-schema/src/index.ts';
import {readQualifiedSupportedArea, assertSupportedAreaPreservesAccepted} from './lib/delivery-supported-area.ts';
import {readSourceFile, sourceSha256, writeSourceJson} from './lib/source-files.ts';

const {values} = parseArgs({options: {plan: {type: 'string'}, out: {type: 'string'}}}); assert.ok(values.plan && values.out && !fs.existsSync(values.out), 'Explicit plan and fresh output required');
const pin = (file: string) => {const bytes = fs.readFileSync(file); return {path: path.resolve(file), bytes: bytes.length, sha256: sourceSha256(bytes)};};
const read = (ref: {file: string; sha256: string}) => {const bytes = fs.readFileSync(ref.file); assert.ok(bytes.length < 128_000_000); assert.equal(sourceSha256(bytes), ref.sha256); return JSON.parse(bytes.toString());};
const planPin = pin(values.plan), plan = JSON.parse(fs.readFileSync(values.plan, 'utf8')); assert.equal(plan.schemaVersion, 1); assert.equal(plan.kind, 'source-bound-walking-circuit');
assert.ok(Array.isArray(plan.steps) && plan.steps.length >= 2 && plan.steps.length <= 100); assert.ok(plan.halfWidthMetres >= .5 && plan.halfWidthMetres <= 2);
const manifestPin = pin(path.join(plan.acceptedWorld, 'manifest.json')); assert.equal(manifestPin.sha256, plan.acceptedManifestSha256);
const manifest = JSON.parse(fs.readFileSync(manifestPin.path, 'utf8')), gameplay = JSON.parse(readSourceFile(plan.acceptedWorld, manifest.gameplay).toString());
const authority = {manifestSha256: manifestPin.sha256, originId: manifest.origin.id, gameplay};
const full = readQualifiedSupportedArea({path: plan.publicArea.file, sha256: plan.publicArea.sha256}, authority, plan.expandedPlayArea).supportedArea;
const base = readQualifiedSupportedArea({path: plan.baseArea.file, sha256: plan.baseArea.sha256}, authority, plan.expandedPlayArea).supportedArea;
const osm = read(plan.osm) as {elements: any[]}, elements = new Map(osm.elements.map(element => [`${element.type}/${element.id}`, element])), records = [];
const pieces: polygonClipping.Polygon[] = [], width = plan.halfWidthMetres;
for (let i = 0; i < plan.steps.length; i++) {
  const step = plan.steps[i], previous = plan.steps[(i + plan.steps.length - 1) % plan.steps.length]; assert.equal(previous.toNode, step.fromNode, 'Walking circuit lacks exact shared OSM node connectivity');
  const way = elements.get(`way/${step.wayId}`); assert.ok(way?.nodes && way.tags); const tags = way.tags;
  const access = tags.foot ?? tags.access; assert.ok(access === undefined || ['yes', 'designated', 'permissive'].includes(access), 'Walking way is not publicly accessible');
  assert.ok(['footway', 'path', 'pedestrian', 'living_street', 'cycleway'].includes(tags.highway));
  assert.ok(tags.highway !== 'cycleway' || ['yes', 'designated', 'permissive'].includes(tags.foot), 'Cycle-only path is not pedestrian authority');
  assert.ok((!tags.bridge || tags.bridge === 'no') && (!tags.tunnel || tags.tunnel === 'no') && Number(tags.layer ?? 0) === 0, 'Walking structure/level needs separate qualification');
  const from = way.nodes.indexOf(step.fromNode), to = way.nodes.indexOf(step.toNode); assert.ok(from >= 0 && to >= 0 && from !== to);
  const nodeIds: number[] = way.nodes.slice(Math.min(from, to), Math.max(from, to) + 1); if (to < from) nodeIds.reverse();
  const points = nodeIds.map(id => {const node = elements.get(`node/${id}`); assert.ok(Number.isFinite(node?.lat) && Number.isFinite(node?.lon)); const [e, n] = geodeticToGk25(node.lat, node.lon); return [e - manifest.origin.originProjected[0], 0, manifest.origin.originProjected[1] - n] as Vec3;});
  for (const point of points) pieces.push([Array.from({length: 32}, (_, j) => [point[0] + Math.cos(j * Math.PI / 16) * width, point[2] + Math.sin(j * Math.PI / 16) * width])]);
  for (let j = 1; j < points.length; j++) {const a = points[j - 1]!, b = points[j]!, dx = b[0] - a[0], dz = b[2] - a[2], length = Math.hypot(dx, dz); assert.ok(length > 0 && length < 500);
    const x = -dz / length * width, z = dx / length * width; pieces.push([[[a[0] + x, a[2] + z], [a[0] - x, a[2] - z], [b[0] - x, b[2] - z], [b[0] + x, b[2] + z]]]);}
  records.push({...step, nodeIds, points, sourceWaySha256: sourceSha256(JSON.stringify(way)), highway: tags.highway, access: access ?? 'public-default'});
}
const first = records[0]!.points[0]!; assert.ok(first[0] >= gameplay.playArea.minX && first[0] <= gameplay.playArea.maxX && first[2] >= gameplay.playArea.minZ && first[2] <= gameplay.playArea.maxZ, 'Walking circuit must start within the accepted play area');
assert.ok(records.some(record => record.points.some((p: Vec3) => p[2] > gameplay.playArea.maxZ)), 'Walking circuit never enters the expansion');
const polygons = (area: SupportedArea): polygonClipping.MultiPolygon => area.regions.map(region => [region.outer.map(p => [...p] as [number, number]), ...(region.holes ?? []).map(ring => ring.map(p => [...p] as [number, number]))]);
let corridor: polygonClipping.MultiPolygon = []; for (let i = 0; i < pieces.length; i += 64) corridor = polygonClipping.union(corridor, ...pieces.slice(i, i + 64));
const publicPolygons = polygons(full), composed = polygonClipping.union(polygons(base), polygonClipping.intersection(publicPolygons, corridor)); assert.deepEqual(polygonClipping.difference(composed, publicPolygons), []);
const supportedArea: SupportedArea = {schemaVersion: 1, regions: composed.map((polygon, i) => ({id: `bulevardi-drive-walk-${i}`, outer: polygon[0]!.slice(0, -1), ...(polygon.length > 1 ? {holes: polygon.slice(1).map(ring => ring.slice(0, -1))} : {})}))};
assertSupportedAreaPreservesAccepted(supportedArea, gameplay, plan.expandedPlayArea);
const document = {schemaVersion: 1, kind: 'qualified-expansion-supported-area', acceptedManifestSha256: manifestPin.sha256, originId: manifest.origin.id,
  qualification: {status: 'PASS_SOURCE_QUALIFIED_SUPPORTED_AREA', physicalNavigationStatus: 'PENDING_FOOTWAY_AND_RETAINED_ROAD_QUALIFICATION_AND_ACTUAL_CONTROLS', policy: 'Existing qualified driving mask union source-public intersection of explicit source-connected walking circuit; no hole filling'},
  sourceFiles: [planPin, manifestPin, pin(plan.publicArea.file), pin(plan.baseArea.file), pin(plan.osm.file)], corridorPolicy: {halfWidthMetres: width, endCaps: '32 vertex inscribed circles', records}, supportedArea};
fs.mkdirSync(values.out, {recursive: true}); const result = writeSourceJson(values.out, 'supported-area.json', document); writeSourceJson(values.out, 'walking-circuit.json', {schemaVersion: 1, status: 'SOURCE_CONNECTED_PENDING_PHYSICAL', records, result});
console.log(JSON.stringify({file: path.resolve(values.out, result.path), sha256: result.sha256, publicWayIds: [...new Set(records.map(r => r.wayId))], holes: supportedArea.regions.reduce((sum, r) => sum + (r.holes?.length ?? 0), 0)}));
