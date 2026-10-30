// Preserve exact larger source geometry separately from the runtime's bounded supported-area admission contract.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {parseArgs} from 'node:util';
import polygonClipping from 'polygon-clipping';
import {validateSupportedArea, type SupportedArea, type Vec3} from '../../packages/world-schema/src/index.ts';
import {loadGeoJsonPolygons, bbox} from './lib/geometry.ts';
import {readSourceFile, sourceSha256, writeSourceJson} from './lib/source-files.ts';
const {values} = parseArgs({options: {plan: {type: 'string'}, routes: {type: 'string'}, 'half-width': {type: 'string', default: '5'}, out: {type: 'string'}}}); assert.ok(values.plan && values.out && !fs.existsSync(values.out));
const pin = (file: string) => {const bytes = fs.readFileSync(file); return {path: path.resolve(file), bytes: bytes.length, sha256: sourceSha256(bytes)};};
const planPin = pin(values.plan), plan = JSON.parse(fs.readFileSync(values.plan, 'utf8')); assert.equal(plan.schemaVersion, 1); assert.equal(plan.kind, 'municipal-public-surface-selection');
const manifestPin = pin(path.join(plan.acceptedWorld, 'manifest.json')); assert.equal(manifestPin.sha256, plan.acceptedManifestSha256); const manifest = JSON.parse(fs.readFileSync(manifestPin.path, 'utf8')), gameplay = JSON.parse(readSourceFile(plan.acceptedWorld, manifest.gameplay).toString()); assert.ok(!gameplay.supportedArea);
const partsPin = pin(plan.streetParts.path), exclusionsPin = pin(plan.groundExclusions.path); assert.equal(partsPin.sha256, plan.streetParts.sha256); assert.equal(exclusionsPin.sha256, plan.groundExclusions.sha256);
const excluded = JSON.parse(fs.readFileSync(exclusionsPin.path, 'utf8')); assert.equal(excluded.source.sha256, partsPin.sha256); assert.equal(excluded.originId, manifest.origin.id);
const names = new Set(plan.streetNames), classes = new Set(plan.surfaceClasses), region = plan.region as [number, number, number, number]; assert.ok(names.size > 0 && names.size <= 150 && !classes.has('Silta'));
const parts = loadGeoJsonPolygons(partsPin.path, manifest.origin.originProjected[0], manifest.origin.originProjected[1], (p, i) => String(p.osan_id ?? i)), selected = parts.filter(part => {const b = bbox(part.rings); return names.has(part.properties.alueen_nimi) && classes.has(part.properties.paatyyppi) && b[0] <= region[2] && b[2] >= region[0] && -b[3] <= region[3] && -b[1] >= region[1];}); assert.ok(selected.length && selected.length < 20_000);
const polygons = selected.map(part => part.rings.map(ring => ring.map(([x, n]) => [x, -n] as [number, number]))), rectangle = (r: readonly number[]): polygonClipping.Polygon => [[[r[0]!, r[1]!], [r[2]!, r[1]!], [r[2]!, r[3]!], [r[0]!, r[3]!]]];
const unionBatchSize = plan.unionBatchSize ?? 64; assert.ok(Number.isInteger(unionBatchSize) && unionBatchSize >= 1 && unionBatchSize <= 20_000);
let union: polygonClipping.MultiPolygon = []; for (let i = 0; i < polygons.length; i += unionBatchSize) union = polygonClipping.union(union, ...polygons.slice(i, i + unionBatchSize));
let extension = polygonClipping.intersection(union, rectangle(region)); const omitted = excluded.parts.flatMap((part: any) => part.polygonsRuntimeXZ) as polygonClipping.Polygon[]; for (let i = 0; i < omitted.length; i += 64) extension = polygonClipping.difference(extension, ...omitted.slice(i, i + 64));
const a = gameplay.playArea, old = rectangle([a.minX, a.minZ, a.maxX, a.maxZ]), composed = polygonClipping.union([old], extension), connected = composed.filter(polygon => polygonClipping.intersection([polygon], [old]).length); assert.equal(connected.length, 1);
const sourceFiles = [planPin, manifestPin, partsPin, exclusionsPin]; let result = connected, routePolicy: unknown = null, routeConstraint: polygonClipping.MultiPolygon | null = null;
if (values.routes) {
  const routePin = pin(values.routes), routes = JSON.parse(fs.readFileSync(values.routes, 'utf8')); assert.equal(routes.acceptedManifestSha256, manifestPin.sha256); const roadsPin = pin(routes.candidateRoads.file); assert.equal(roadsPin.sha256, routes.candidateRoads.sha256);
  const roads = JSON.parse(fs.readFileSync(roadsPin.path, 'utf8')), ids = new Set([...routes.retainedLaneIds, ...routes.newLaneIds]), connectorIds = new Set(routes.connectorIds), records = [...roads.lanes.filter((lane: any) => ids.has(lane.id)), ...roads.connectors.filter((connector: any) => connectorIds.has(connector.id))];
  const width = Number(values['half-width']); assert.ok(width >= 3 && width <= 8); const pieces: polygonClipping.Polygon[] = [];
  for (const record of records) {const points = record.points as Vec3[]; for (const p of points) pieces.push([Array.from({length: 32}, (_, i) => [p[0] + Math.cos(i * Math.PI / 16) * width, p[2] + Math.sin(i * Math.PI / 16) * width])]);
    for (let i = 1; i < points.length; i++) {const p = points[i - 1]!, q = points[i]!, dx = q[0] - p[0], dz = q[2] - p[2], length = Math.hypot(dx, dz); if (!length) continue; const x = -dz / length * width, z = dx / length * width; pieces.push([[[p[0] + x, p[2] + z], [p[0] - x, p[2] - z], [q[0] - x, q[2] - z], [q[0] + x, q[2] + z]]]);}}
  let corridor: polygonClipping.MultiPolygon = []; for (let i = 0; i < pieces.length; i += 64) corridor = polygonClipping.union(corridor, ...pieces.slice(i, i + 64)); routeConstraint = polygonClipping.union([old], corridor); result = polygonClipping.union([old], polygonClipping.intersection(connected, corridor)); sourceFiles.push(routePin, roadsPin); routePolicy = {widthMetres: width, recordIds: records.map((record: any) => record.id), nativeProjectionAndCollision: 'PENDING'};
}
assert.deepEqual(polygonClipping.difference([old], result), []);
// Boolean clipping can produce nonzero roundoff slivers. Preserve the exact residual
// as a blocker, rather than deleting it or upgrading an approximate subset to PASS.
const initialSourceContainmentResidual = polygonClipping.difference(result, connected);
let intersectionContainmentNormalization: unknown = null;
if (initialSourceContainmentResidual.length) {
  const before = result, clipped = polygonClipping.intersection(before, connected);
  // A second intersection can normalize floating clipping artifacts. Every resulting
  // point must still lie in BOTH original constraints; no source hole can be filled.
  const additions = polygonClipping.difference(clipped, before), lostAccepted = polygonClipping.difference([old], clipped), remaining = polygonClipping.difference(clipped, connected), outsideCorridor = routeConstraint ? polygonClipping.difference(clipped, routeConstraint) : [];
  if (!lostAccepted.length && !remaining.length && !outsideCorridor.length) {
    result = clipped; intersectionContainmentNormalization = {operation: 'one additional intersection with identical exact public source polygons; final subset of original source and original corridor independently checked', initialResidual: initialSourceContainmentResidual, removed: polygonClipping.difference(before, clipped), changedWithinOriginalConstraints: additions, removedAcceptedGeometry: lostAccepted, remainingOutsideSource: remaining, remainingOutsideCorridor: outsideCorridor};
  }
}
const sourceContainmentResidual = polygonClipping.difference(result, connected);
const supportedArea: SupportedArea = {schemaVersion: 1, regions: result.map((p, i) => ({id: `source-area-${i}`, outer: p[0]!.slice(0, -1), ...(p.length > 1 ? {holes: p.slice(1).map(ring => ring.slice(0, -1))} : {})}))};
const expandedPlayArea = {minX: Math.min(a.minX, region[0]), minZ: Math.min(a.minZ, region[1]), maxX: Math.max(a.maxX, region[2]), maxZ: Math.max(a.maxZ, region[3])}, validationErrors = validateSupportedArea(supportedArea, expandedPlayArea), perRegion = supportedArea.regions.map(r => ({id: r.id, holes: r.holes?.length ?? 0, outerVertices: r.outer.length, vertices: r.outer.length + (r.holes ?? []).reduce((sum, ring) => sum + ring.length, 0)}));
const document = {schemaVersion: 1, kind: 'expansion-public-source-geometry', acceptedManifestSha256: manifestPin.sha256, originId: manifest.origin.id,
  qualification: {status: sourceContainmentResidual.length ? 'SOURCE_GEOMETRY_PENDING_EXACT_CONTAINMENT' : validationErrors.length ? 'SOURCE_GEOMETRY_EXCEEDS_CURRENT_RUNTIME_CONTRACT' : 'PASS_EXACT_SOURCE_GEOMETRY_ADMISSION_PENDING', physicalNavigationStatus: 'PENDING_ALL_RETAINED_AND_NEW_ROAD_WALK_NATIVE_AND_RUNTIME_GATES', exactSourceGeometryPreserved: !sourceContainmentResidual.length, noHoleFilling: true, validationErrors, sourceContainmentResidual, intersectionContainmentNormalization},
  sourceFiles, selectedPartIds: selected.map(part => part.id), streetNames: [...names], region, expandedPlayArea, routePolicy, excludedDisconnectedComponents: composed.length - connected.length, perRegion, supportedArea};
fs.mkdirSync(values.out, {recursive: true}); const ref = writeSourceJson(values.out, 'source-area.json', document); console.log(JSON.stringify({file: path.resolve(values.out, ref.path), sha256: ref.sha256, status: document.qualification.status, perRegion, selectedParts: selected.length, disconnectedExcluded: document.excludedDisconnectedComponents}));
