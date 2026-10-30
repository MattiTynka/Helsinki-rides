// Read-only physical diagnostic for explicitly selected projected road records. This is not a release receipt.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {gunzipSync} from 'node:zlib';
import {parseCollisionBundle, pointAlong, polylineLength, type RoadGraph, type Vec3} from '../../packages/world-schema/src/index.ts';
import {loadGeoJsonPolygons, pointInPolygon} from './lib/geometry.ts';
import {sourceSha256, readSourceFile, writeSourceJson} from './lib/source-files.ts';
import {deriveRoadPhysicalEnvelope, RoadCollisionSupport, inspectRoadPhysicalSupport, inspectRetainedRoadExposure, type RoadSupportTriangle} from './lib/expansion-road-merge.ts';
import {qualifyPublicParkingAisleParts} from './lib/reviewed-vehicle-surfaces.ts';
import type {RoadMergeSelection, RoadSourceElement} from './lib/expansion-road-merge.ts';
import {readSerializedRoadFloor} from './lib/serialized-road-floor.ts';
import {prepareRoadMergeReviews, type RoadMergeReviewInputs} from './lib/road-merge-reviews.ts';
const {values} = parseArgs({options: {plan: {type: 'string'}, projection: {type: 'string'}, 'native-cells': {type: 'string'}, 'supported-area': {type: 'string'}, 'merge-plan': {type: 'string'}, ids: {type: 'string'}, out: {type: 'string'}}});
assert.ok(values.plan && values.projection && values['native-cells'] && values.out); assert.ok(!fs.existsSync(values.out));
const pin = (file: string) => {const bytes = fs.readFileSync(file); return {file: path.resolve(file), bytes: bytes.length, sha256: sourceSha256(bytes)};};
const planPin = pin(values.plan), plan = JSON.parse(fs.readFileSync(values.plan, 'utf8')), receiptPin = pin(values.projection), receipt = JSON.parse(fs.readFileSync(values.projection, 'utf8'));
assert.equal(receipt.planSha256, planPin.sha256); const checked = (ref: {file: string; sha256: string}) => {const bytes = fs.readFileSync(ref.file); assert.equal(sourceSha256(bytes), ref.sha256); return JSON.parse(bytes.toString());};
const root = plan.acceptedWorld, manifestPin = pin(path.join(root, 'manifest.json')); assert.equal(manifestPin.sha256, receipt.acceptedManifestSha256);
const manifest = JSON.parse(fs.readFileSync(manifestPin.file, 'utf8')), accepted = checked(receipt.repairedAcceptedRoads) as RoadGraph, candidate = checked(receipt.projectedCandidateRoads) as RoadGraph;
const metadata = checked(receipt.nativeMetadata), streetPartsPin = pin(metadata.inputs.streetParts.path); assert.equal(streetPartsPin.sha256, metadata.inputs.streetParts.sha256);
const indexPin = pin(path.join(values['native-cells'], 'cells.json')), index = JSON.parse(fs.readFileSync(indexPin.file, 'utf8'));
const acceptedCoverage = JSON.parse(readSourceFile(root, manifest.gameplay).toString());
const vehicleEnvelope = deriveRoadPhysicalEnvelope(acceptedCoverage.vehicleDefinitions);
let supportedAreaPin: ReturnType<typeof pin> | undefined;
if (values['supported-area']) {supportedAreaPin = pin(values['supported-area']); const document = JSON.parse(fs.readFileSync(supportedAreaPin.file, 'utf8')); assert.equal(document.acceptedManifestSha256, manifestPin.sha256); plan.expandedCoverage.supportedArea = document.supportedArea;}
const parts = loadGeoJsonPolygons(streetPartsPin.file, manifest.origin.originProjected[0], manifest.origin.originProjected[1], (p, i) => String(p.osan_id ?? p.id ?? i));
const mergePlanPin = values['merge-plan'] ? pin(values['merge-plan']) : undefined;
let mergeSelection: RoadMergeSelection | undefined, reviewedWays: Map<number, RoadSourceElement> | undefined, mergeReviewInputs: RoadMergeReviewInputs | undefined, mergeOsm: {elements: RoadSourceElement[]} | undefined;
if (mergePlanPin) {
  const merge = checked(mergePlanPin);
  assert.equal(merge.expectedManifestSha256, manifestPin.sha256); assert.equal(merge.candidateRoads.sha256, receipt.projectedCandidateRoads.sha256);
  assert.equal(merge.nativeCells.indexSha256, indexPin.sha256); assert.equal(merge.streetParts.sha256, streetPartsPin.sha256);
  assert.equal(merge.expandedSupportedArea.sha256, supportedAreaPin?.sha256); assert.equal(merge.osm.sha256, candidate.source.sha256);
  const osm = checked(merge.osm) as {elements: RoadSourceElement[]}; reviewedWays = new Map(osm.elements.filter(e => e.type === 'way').map(e => [e.id, e]));
  mergeSelection = merge.selection;
  mergeReviewInputs = merge; mergeOsm = osm;
}
const lanes = [...plan.retainedLaneIds.map((id: string) => accepted.lanes.find(lane => lane.id === id)!), ...plan.newLaneIds.map((id: string) => candidate.lanes.find(lane => lane.id === id)!)], connectors = plan.connectorIds.map((id: string) => candidate.connectors.find(connector => connector.id === id)!);
assert.ok([...lanes, ...connectors].every(Boolean)); const points: Vec3[] = [...lanes.flatMap(lane => lane.points), ...connectors.flatMap((connector: any) => connector.points)];
const bounds = [Math.min(...points.map(p => p[0])) - 6, Math.min(...points.map(p => p[2])) - 6, Math.max(...points.map(p => p[0])) + 6, Math.max(...points.map(p => p[2])) + 6];
const triangles: RoadSupportTriangle[] = [], collisionInputs = [];
let finalFloor: ReturnType<typeof readSerializedRoadFloor>['receipt'] | undefined;
if(receipt.serializedFloorWorld){
 const prior=receipt.serializedFloor.region,scope=[Math.min(bounds[0]!,prior[0]),Math.min(bounds[1]!,prior[1]),Math.max(bounds[2]!,prior[2]),Math.max(bounds[3]!,prior[3])]as[number,number,number,number];
 const floor=readSerializedRoadFloor(receipt.serializedFloorWorld,scope,manifest.origin.id);
 finalFloor = floor.receipt;
 for(const t of floor.triangles)triangles.push(t);for(const cell of floor.receipt.cells)collisionInputs.push({kind:'final',...cell});
 for(const cell of receipt.serializedFloor.cells)assert.ok(floor.receipt.cells.some(c=>c.cell===cell.cell&&c.decodedSha256===cell.decodedSha256),'Diagnostic final HCOL changed from projected authority');
}else{
for (const source of [{id: 'accepted', root, cells: manifest.cells}, {id: 'native', root: values['native-cells'], cells: index.cells}]) for (const cell of source.cells) {
  const b = cell.collision.boundsXZ ?? cell.boundsXZ; if (b[2] < bounds[0]! || b[0] > bounds[2]! || b[3] < bounds[1]! || b[1] > bounds[3]!) continue;
  const stored = readSourceFile(source.root, cell.collision), bytes = cell.collision.compression === 'gzip' ? gunzipSync(stored, {maxOutputLength: 64 * 1024 * 1024}) : stored;
  if (cell.collision.decodedSha256) assert.equal(sourceSha256(bytes), cell.collision.decodedSha256);
  const bundle = parseCollisionBundle(Uint8Array.from(bytes)); assert.equal(bundle.header.originId, manifest.origin.id); assert.equal(bundle.header.cell, cell.id);
  collisionInputs.push({kind: source.id, cell: cell.id, sha256: cell.collision.sha256});
  for (const collider of bundle.colliders) if (collider.group === 'ground') for (let i = 0; i < collider.indices.length; i += 3) {
    const tag = bundle.header.surfaceTags[collider.triangleTags[i / 3]!]!; if (!tag.startsWith('road:')) continue;
    const vertices = [0, 1, 2].map(k => Array.from(collider.positions.subarray(collider.indices[i + k]! * 3, collider.indices[i + k]! * 3 + 3)) as Vec3);
    triangles.push({id: `${source.id}:${cell.id}:${collider.id}:${i / 3}`, tag, points: vertices as [Vec3, Vec3, Vec3]});
  }
}
}
const support = new RoadCollisionSupport(triangles), exposure = inspectRetainedRoadExposure(accepted, acceptedCoverage, plan.expandedCoverage), proofs = [], sourcePartQualifications = [];
const hasReviews = !!(mergeReviewInputs?.bridgeLevelInventory || mergeReviewInputs?.walkingSurfaceReviews || mergeReviewInputs?.transitCrossingReviews);
assert.ok(!hasReviews || finalFloor && receipt.serializedFloorWorld && mergeSelection && mergeOsm, 'Reviewed road diagnostic needs actual final serialized authority');
const reviews = hasReviews ? prepareRoadMergeReviews(mergeReviewInputs!, {world: receipt.serializedFloorWorld, cells: finalFloor!.cells, triangles, originalCandidate: checked(receipt.originalCandidateRoads), projectedCandidate: candidate, originalCandidatePin: receipt.originalCandidateRoads, sourcePins: {osmSha256: candidate.source.sha256, streetPartsSha256: streetPartsPin.sha256}, parts, osm: mergeOsm!, selection: mergeSelection!, read: (ref, cap = 128 * 1024 * 1024) => {assert.ok(fs.statSync(ref.file).size <= cap); const bytes = fs.readFileSync(ref.file); assert.equal(sourceSha256(bytes), ref.sha256); return bytes;}}) : undefined;
const requestedIds = values.ids?.split(',');
if (requestedIds) assert.ok(requestedIds.length > 0 && requestedIds.length <= 1000 && new Set(requestedIds).size === requestedIds.length && requestedIds.every(id => [...lanes, ...connectors].some(record => record.id === id)), 'Diagnostic IDs must be unique records in the pinned projection plan');
for (const record of [...lanes, ...connectors].filter(record => !requestedIds || requestedIds.includes(record.id))) {
  const p = record.points as readonly Vec3[], b = [Math.min(...p.map(p => p[0])) - 4, Math.min(...p.map(p => p[2])) - 4, Math.max(...p.map(p => p[0])) + 4, Math.max(...p.map(p => p[2])) + 4];
  const reference = mergeSelection && [...mergeSelection.lanes, ...mergeSelection.retainedLanes ?? [], ...mergeSelection.connectors, ...mergeSelection.seamConnectors.map(ref => ({...ref, id: ref.connector.id}))].find(ref => ref.id === record.id);
  const selected = reference?.partIds ?? parts.filter(part => part.properties.alatyyppi === 'Ajorata' && part.bbox[2] >= b[0]! && part.bbox[0] <= b[2]! && -part.bbox[1] >= b[1]! && -part.bbox[3] <= b[3]!).map(part => part.id);
  const wayIds = record.wayId ? [record.wayId] : [candidate.lanes.find(lane => lane.id === record.from)!.wayId, candidate.lanes.find(lane => lane.id === record.to)!.wayId];
  const surfaceReviews = reference?.surfaceReviews ?? [];
  assert.ok(surfaceReviews.every(review => selected.includes(review.partId)));
  const eligibleParking = surfaceReviews.length ? qualifyPublicParkingAisleParts(surfaceReviews, parts, reviewedWays!, wayIds) : [];
  const width = record.width ?? Math.max(lanes.find(lane => lane.id === record.from)!.width, lanes.find(lane => lane.id === record.to)!.width); sourcePartQualifications.push({id: record.id, partIds: selected});
  try {
    const intervals = exposure.find(tail => tail.id === record.id)?.intervals;
    const proof = inspectRoadPhysicalSupport(record.id, p, width, selected, parts, reviews?.reviewedRoadSupports.get(record.id) ?? support, plan.expandedCoverage, vehicleEnvelope, intervals, true, new Set(eligibleParking.map(part => part.partId)), reviews?.reviewedSurfaces.get(record.id)?.parts);
    let minimumSupportedHalfWidth = width / 2, limitingSample: unknown = null;
    if (proof.nominalFailureCounts.laneWidthSource || proof.nominalFailureCounts.laneWidthCollision) {
      const replacements = reviews?.reviewedSurfaces.get(record.id)?.parts ?? [], selectedParts = [...parts.filter(part => selected.includes(part.id) && !replacements.some(p => p.id === part.id)), ...replacements];
      for (const [from, to] of intervals ?? [[0, polylineLength(p)]]) for (let i = 0, steps = Math.max(1, Math.ceil((to - from) / .25)); i <= steps; i++) {
        const s = from + (to - from) * i / steps, {point, tangent} = pointAlong(p, s);
        const supported = (offset: number) => {const x = point[0] - tangent[1] * offset, z = point[2] + tangent[0] * offset; return selectedParts.some(part => pointInPolygon([x, -z], part.rings)) && !!support.at(x, point[1], z);};
        for (const sign of [-1, 1]) if (!supported(sign * width / 2)) {
          let lo = 0, hi = width / 2; for (let step = 0; step < 20; step++) {const mid = (lo + hi) / 2; if (supported(sign * mid)) lo = mid; else hi = mid;}
          if (lo < minimumSupportedHalfWidth) {minimumSupportedHalfWidth = lo; limitingSample = {stationMetres: s, centre: point, lateralSign: sign};}
        }
      }
    }
    proofs.push({...proof, laneWidthEnvelopeDiagnostic: {nominalWidth: width, sampledMaximumUniformWidth: minimumSupportedHalfWidth * 2, limitingSample, changesAuthorized: false}});
  }
  catch (error) {proofs.push({id: record.id, error: (error as Error).message});}
}
fs.mkdirSync(values.out, {recursive: true});
const failed = proofs.filter(proof => 'error' in proof || proof.failureCount);
writeSourceJson(values.out, 'road-support-diagnostic.json', {schemaVersion: 1, status: 'SERIALIZED_HCOL_AND_MUNICIPAL_SUPPORT_DIAGNOSTIC_RUNTIME_PENDING', ...(requestedIds ? {selectedDiagnosticRecordIds: requestedIds, unselectedRecordsNotRechecked: true} : {}), ...(mergePlanPin ? {mergePlanPin} : {}), ...(reviews ? {reviewedSourceAndLevels: reviews.receipt} : {}), planPin, projectionReceipt: receiptPin, manifestPin, nativeIndex: indexPin, streetParts: streetPartsPin, supportedAreaPin, vehicleEnvelope, collisionInputs, sourcePartQualifications, proofs});
console.log(JSON.stringify({records: proofs.length, failed: failed.map(proof => ({id: proof.id, ...('error' in proof ? {error: proof.error} : {failures: proof.failureCounts, first: proof.failures[0]})})), collisionCells: collisionInputs.length}));
