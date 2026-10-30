// Conservative milestone mask: accepted support UNION (qualified public support INTERSECT reviewed road corridor).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {parseArgs} from 'node:util';
import polygonClipping from 'polygon-clipping';
import {type SupportedArea, type Vec3} from '../../packages/world-schema/src/index.ts';
import {readSourceFile, sourceSha256, writeSourceJson} from './lib/source-files.ts';
import {assertSupportedAreaPreservesAccepted, readQualifiedSupportedArea} from './lib/delivery-supported-area.ts';
const {values} = parseArgs({options: {plan: {type: 'string'}, projection: {type: 'string'}, 'public-area': {type: 'string'}, 'half-width': {type: 'string'}, out: {type: 'string'}}});
assert.ok(values.plan && values.projection && values['public-area'] && values['half-width'] && values.out); assert.ok(!fs.existsSync(values.out));
const halfWidth = Number(values['half-width']); assert.ok(Number.isFinite(halfWidth) && halfWidth >= 3 && halfWidth <= 8, 'Explicit 3–8m corridor half-width required');
const pin = (file: string) => {const bytes = fs.readFileSync(file); return {path: path.resolve(file), bytes: bytes.length, sha256: sourceSha256(bytes)};};
const planPin = pin(values.plan), plan = JSON.parse(fs.readFileSync(values.plan, 'utf8')), projectionPin = pin(values.projection), projection = JSON.parse(fs.readFileSync(values.projection, 'utf8')); assert.equal(planPin.sha256, projection.planSha256);
const acceptedRoot = plan.acceptedWorld, manifestBytes = fs.readFileSync(path.join(acceptedRoot, 'manifest.json')), manifest = JSON.parse(manifestBytes.toString()); assert.equal(sourceSha256(manifestBytes), projection.acceptedManifestSha256);
const acceptedCoverage = JSON.parse(readSourceFile(acceptedRoot, manifest.gameplay).toString()), areaPin = pin(values['public-area']);
const full = readQualifiedSupportedArea(areaPin, {manifestSha256: projection.acceptedManifestSha256, originId: manifest.origin.id, gameplay: acceptedCoverage}, plan.expandedCoverage.playArea).supportedArea;
const polygons = (area: SupportedArea): polygonClipping.MultiPolygon => area.regions.map(region => [region.outer.map(point => [...point] as [number, number]), ...region.holes?.map(hole => hole.map(point => [...point] as [number, number])) ?? []]);
const b = acceptedCoverage.playArea, prior: polygonClipping.MultiPolygon = acceptedCoverage.supportedArea ? polygons(acceptedCoverage.supportedArea) : [[[[b.minX, b.minZ], [b.maxX, b.minZ], [b.maxX, b.maxZ], [b.minX, b.maxZ]]]];
const acceptedBytes = fs.readFileSync(projection.repairedAcceptedRoads.file), candidateBytes = fs.readFileSync(projection.projectedCandidateRoads.file); assert.equal(sourceSha256(acceptedBytes), projection.repairedAcceptedRoads.sha256); assert.equal(sourceSha256(candidateBytes), projection.projectedCandidateRoads.sha256);
const accepted = JSON.parse(acceptedBytes.toString()), candidate = JSON.parse(candidateBytes.toString());
const records = [...plan.retainedLaneIds.map((id: string) => accepted.lanes.find((lane: any) => lane.id === id)), ...plan.newLaneIds.map((id: string) => candidate.lanes.find((lane: any) => lane.id === id)), ...plan.connectorIds.map((id: string) => candidate.connectors.find((connector: any) => connector.id === id))]; assert.ok(records.every(Boolean));
const pieces: polygonClipping.Polygon[] = [];
for (const record of records) {
  const raw = record.points as Vec3[], points = raw.filter((p, i) => {
    if (i === 0 || i === raw.length - 1) return true;
    const a = raw[i - 1]!, q = raw[i + 1]!, cross = (p[0] - a[0]) * (q[2] - p[2]) - (p[2] - a[2]) * (q[0] - p[0]); return Math.abs(cross) > 1e-9;
  });
  for (const point of points) pieces.push([Array.from({length: 32}, (_, i) => [point[0] + Math.cos(i * Math.PI / 16) * halfWidth, point[2] + Math.sin(i * Math.PI / 16) * halfWidth])]);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!, c = points[i]!, dx = c[0] - a[0], dz = c[2] - a[2], length = Math.hypot(dx, dz); if (!length) continue;
    const x = -dz / length * halfWidth, z = dx / length * halfWidth;
    pieces.push([[[a[0] + x, a[2] + z], [a[0] - x, a[2] - z], [c[0] - x, c[2] - z], [c[0] + x, c[2] + z]]]);
  }
}
let corridor: polygonClipping.MultiPolygon = []; for (let i = 0; i < pieces.length; i += 64) corridor = polygonClipping.union(corridor, ...pieces.slice(i, i + 64));
const publicPolygons = polygons(full), clipped = polygonClipping.intersection(publicPolygons, corridor), composed = polygonClipping.union(prior, clipped);
assert.deepEqual(polygonClipping.difference(composed, publicPolygons), [], 'Loop mask adds unsupported source land');
const supportedArea: SupportedArea = {schemaVersion: 1, regions: composed.map((polygon, i) => ({id: `bulevardi-loop-${i}`, outer: polygon[0]!.slice(0, -1), ...(polygon.length > 1 ? {holes: polygon.slice(1).map(ring => ring.slice(0, -1))} : {})}))};
assertSupportedAreaPreservesAccepted(supportedArea, acceptedCoverage, plan.expandedCoverage.playArea);
const document = {schemaVersion: 1, kind: 'qualified-expansion-supported-area', acceptedManifestSha256: projection.acceptedManifestSha256, originId: manifest.origin.id,
  qualification: {status: 'PASS_SOURCE_QUALIFIED_SUPPORTED_AREA', physicalNavigationStatus: 'PENDING_ALL_EXPOSED_RETAINED_ROADS_AND_RUNTIME', policy: 'Exact accepted support union intersection of qualified municipal public mask and explicit loop corridor; no gap filling or added land'},
  sourceFiles: [areaPin, projectionPin, planPin, pin(projection.repairedAcceptedRoads.file), pin(projection.projectedCandidateRoads.file)],
  corridorPolicy: {halfWidthMetres: halfWidth, endCaps: '32-vertex inscribed circles', walkingClearance: '5m corridor half-width includes maximum accepted vehicle footprint and room for a walking route, only where the qualified public mask supplies land; runtime admission and walking collision still require verification', recordIds: records.map(record => record.id)}, supportedArea};
fs.mkdirSync(values.out, {recursive: true}); const result = writeSourceJson(values.out, 'supported-area.json', document);
writeSourceJson(values.out, 'corridor-policy.json', {schemaVersion: 1, sourcePublicArea: areaPin, projection: projectionPin, halfWidthMetres: halfWidth, polygons: corridor, sourceSubsetProof: true, acceptedPreservationProof: true, result});
console.log(JSON.stringify({file: path.resolve(values.out, result.path), sha256: result.sha256, regions: supportedArea.regions.length, holes: supportedArea.regions.reduce((sum, region) => sum + (region.holes?.length ?? 0), 0)}));
