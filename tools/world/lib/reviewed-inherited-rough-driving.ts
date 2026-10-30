import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {decodeRoadGraph, parseCollisionBundle, type RoadGraph, type RoadLane, type WorldManifest, type Vec3} from '../../../packages/world-schema/src/index.ts';
import {decodeDeliverySimulation} from './delivery-city-payloads.ts';
import {sourceFile, sourceSha256} from './source-files.ts';
import {assertHorizontalSubdivision} from './road-horizontal-subdivision.ts';
import {inheritedBundleHash as hash, assertBoundedInheritedGraph, assertInheritedBundleDisjoint, type InheritedBundleWitness} from './inherited-height-bundle-evidence.ts';
import type {InheritedHeightContext, InheritedHeightPin, InheritedHeightWorld} from './reviewed-inherited-road-height.ts';
import {readSerializedRoadFloor} from './serialized-road-floor.ts';
import {loadGeoJsonPolygons} from './geometry.ts';
import {deriveRoadPhysicalEnvelope, inspectRoadPhysicalSupport, RoadCollisionSupport, type RoadCoverage} from './expansion-road-merge.ts';

export const INHERITED_ROUGH_DRIVING_APPROVAL = '4a5ccdf89a062fb38c7ba814f78306ce9883452c79523a437151569e6795a7ac';
export const INHERITED_ROUGH_DRIVING_ARCHIVE = '442cea967302819c9df615a916850116dfc3c9e14fd8f37bc9848529f238162a';
const PACKET = 'acb1bf409dae2ff15a34bd6abae0a6407bf646895911ca61b85f196fd58220f4';
const ORIGINAL = '0e18e55e8730f01144eef72a80decffbb53cdd658222f87a7e8ad6f75f2c4260';
const CURRENT = 'd453fdd79db114c914322f0209121c34819206b294004bdcece2739f0f3b4701';
const IDS = ['24479833:0:f0', '24673380:0:f0', '123813196:0:f1'];
const SOURCE = {osmSha256: 'a6bf71bae890ab60b4249c8546e6b7185ce37c9ede4137e9c4aefbd9a755e65a', streetPartsSha256: '1ac1409cf70cd6c3ad1ab7139fd6f365898d5c654e499616a1892d1b669645b2'};

declare const roughBrand: unique symbol;
export interface ReviewedInheritedRoughDriving {readonly [roughBrand]: true}
interface Case {
  after: RoadLane;
  witness: InheritedBundleWitness;
  physical: any;
  sourcePartIds: string[];
  region: readonly [number, number, number, number];
  floorReceipt: unknown;
  failedPointsSha256: string;
  failedPoints: number;
}
interface Bound {
  originalHash: string;
  currentHash: string;
  originId: string;
  world: InheritedHeightWorld;
  cases: Case[];
  partsPin: InheritedHeightPin;
  verifyInputs: () => void;
}
const authorities = new WeakMap<object, Bound>();
function required(authority: ReviewedInheritedRoughDriving) {
  const bound = authorities.get(authority); assert.ok(bound, 'Unrecognized rough-driving authority'); return bound;
}
const disjoint = (ids: readonly string[]) => assertInheritedBundleDisjoint(ids, IDS);

/** Exact three-record metadata approval. Ordinary flat-frame failures stay
 * failed; a separate complete replay below is required to consume their scope. */
export function readReviewedInheritedRoughDriving(approvalPin: InheritedHeightPin, context: InheritedHeightContext) {
  assert.equal(approvalPin.sha256, INHERITED_ROUGH_DRIVING_APPROVAL, 'Unapproved rough-driving case');
  assert.equal(context.provenanceArchive.sha256, INHERITED_ROUGH_DRIVING_ARCHIVE, 'Unapproved rough-driving archive');
  assert.equal(context.originalWorld.manifestSha256, ORIGINAL); assert.equal(context.currentWorld.manifestSha256, CURRENT);
  assert.deepEqual(context.sourcePins, SOURCE); disjoint(context.otherRegistrationIds);
  assertBoundedInheritedGraph(context.original); assertBoundedInheritedGraph(context.current);
  const ledger = new Map<string, {pin: InheritedHeightPin; cap: number}>(); let totalBytes = 0;
  const checked = (pin: InheritedHeightPin, cap = 16 * 1024 * 1024, retain = false, remember = true): Buffer | undefined => {
    assert.ok(typeof pin.file === 'string' && pin.file.length > 0 && pin.file.length <= 4096); assert.match(pin.sha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(Object.keys(pin).sort(), (pin.bytes === undefined ? ['file', 'sha256'] : ['bytes', 'file', 'sha256']).sort());
    const file = sourceFile(path.dirname(pin.file), path.basename(pin.file)), canonical = fs.realpathSync(file), old = ledger.get(canonical);
    if (old) assert.equal(old.pin.sha256, pin.sha256, 'Conflicting rough-driving input');
    const fd = fs.openSync(file, 'r');
    try {
      const before = fs.fstatSync(fd); assert.ok(before.isFile() && before.size > 0 && before.size <= cap, 'Rough-driving input byte limit');
      if (pin.bytes !== undefined) assert.equal(before.size, pin.bytes);
      if (remember && !old) {totalBytes += before.size; assert.ok(totalBytes <= 1024 * 1024 * 1024 && ledger.size < 2048, 'Rough-driving evidence budget');}
      const digest = createHash('sha256'), chunk = Buffer.allocUnsafe(65536), pieces: Buffer[] = []; let size = 0;
      for (;;) {const n = fs.readSync(fd, chunk, 0, chunk.length, null); if (!n) break; size += n; assert.ok(size <= cap); digest.update(chunk.subarray(0, n)); if (retain) pieces.push(Buffer.from(chunk.subarray(0, n)));}
      const after = fs.fstatSync(fd); assert.equal(size, before.size); assert.equal(after.size, before.size); assert.equal(after.mtimeMs, before.mtimeMs);
      assert.equal(digest.digest('hex'), pin.sha256, 'Approved rough-driving input changed');
      if (remember) ledger.set(canonical, {pin: {...structuredClone(pin), file, bytes: size}, cap});
      return retain ? Buffer.concat(pieces, size) : undefined;
    } finally {fs.closeSync(fd);}
  };
  const json = (pin: InheritedHeightPin, cap?: number): any => JSON.parse(checked(pin, cap, true)!.toString());
  const approval = json(approvalPin, 65536); assert.equal(approval.kind, 'literal-three-inherited-rough-driving-height-metadata-approval');
  assert.equal(approval.packet.sha256, PACKET); assert.equal(approval.provenanceArchive.sha256, INHERITED_ROUGH_DRIVING_ARCHIVE);
  const packet = json(approval.packet), review = json(approval.independentReview), lineageReview = json(approval.independentFailedProbeGeometryReview), replay = json(approval.freshNativeReplay);
  assert.equal(approval.independentReview.sha256, '765b06432457b7a7919dd8285d9de7f622cc63075e4caa46e45b5f10b5ad8e0b');
  assert.equal(approval.independentFailedProbeGeometryReview.sha256, 'e3e546045db0e7f94842d9f8fb8c3b3c24d1c4abd112033b12f7c71360191d15');
  assert.equal(approval.freshNativeReplay.sha256, '086b7ea34d36756a28c8433508aa151b5ed4c63ddff524685956b64aef5fa497');
  assert.equal(replay.pairedScenarios, 54); assert.equal(replay.pairedPhysicalTicks, 44651); assert.equal(replay.allStoredPhysicalAndSteeringTraceBytesReproduced, true);
  assert.equal(lineageReview.clippedFaces, 12); assert.equal(review.checks.verifiedActualNativeFaceRayPairs, 6273);
  assert.deepEqual(packet.cases.map((c: any) => c.id), IDS); assert.deepEqual(approval.records.map((c: any) => c.id), IDS);
  assert.equal(packet.originalWorld.manifestSha256, ORIGINAL); assert.equal(packet.currentWorld.manifestSha256, CURRENT);
  const proofs: any = Object.fromEntries(Object.entries(packet.proofs).map(([key, p]) => [key, json(p as InheritedHeightPin)]));
  const nativeSummary = json(proofs.dynamics.input), mapping = json(context.provenanceArchive, 2 * 1024 * 1024);
  assert.equal(mapping.packetSha256, PACKET); assert.equal(mapping.files.length, 86);
  const archived = new Map<string, string>();
  for (const p of mapping.files) {
    assert.ok(p.kind === 'source' || p.kind === 'producer'); const id = p.kind + ':' + p.name; assert.ok(!archived.has(id)); archived.set(id, p.sha256);
    checked({file: sourceFile(path.dirname(context.provenanceArchive.file), p.path), sha256: p.sha256, bytes: p.bytes}, 4 * 1024 * 1024);
  }
  let visits = 0;
  const provenance = (value: any, depth = 0) => {
    assert.ok(depth <= 64 && ++visits <= 2_000_000);
    if (typeof value === 'number') {assert.ok(Number.isFinite(value)); return;}
    if (!value || typeof value !== 'object') return;
    if (value.files && !Array.isArray(value.files)) for (const [name, digest] of Object.entries(value.files)) assert.equal(archived.get('source:' + name), digest, 'Missing historical rough source');
    for (const [key, child] of Object.entries(value)) {
      if (key === 'producerSha256' || key === 'reviewerSha256') assert.ok([...archived].some(([name, digest]) => name.startsWith('producer:') && digest === child), 'Missing historical rough producer');
      provenance(child, depth + 1);
    }
  };
  for (const p of [packet, review, lineageReview, nativeSummary, ...Object.values(proofs)]) provenance(p);
  for (const p of packet.sourceInputs) checked(p, 64 * 1024 * 1024);
  assert.deepEqual(packet.sourceInputs.map((p: any) => p.sha256).sort(), Object.values(SOURCE).sort());
  const partsPin: InheritedHeightPin = packet.sourceInputs.find((p: InheritedHeightPin) => p.sha256 === SOURCE.streetPartsSha256);
  const mask = json(packet.mask); for (const p of mask.sourceFiles) checked({file: p.path, sha256: p.sha256, bytes: p.bytes}, 64 * 1024 * 1024);
  const manifest = (w: InheritedHeightWorld) => json({file: sourceFile(w.directory, 'manifest.json'), sha256: w.manifestSha256}) as WorldManifest;
  const om = manifest(context.originalWorld), cm = manifest(context.currentWorld);
  const payload = (w: InheritedHeightWorld, ref: {path: string; sha256: string; bytes: number}) => decodeDeliverySimulation(checked({file: sourceFile(w.directory, ref.path), sha256: ref.sha256, bytes: ref.bytes}, 64 * 1024 * 1024, true)!, ref);
  assert.equal(hash(decodeRoadGraph(payload(context.originalWorld, om.roads))), hash(context.original), 'Actual ORIGINAL graph required');
  assert.equal(hash(decodeRoadGraph(payload(context.currentWorld, cm.roads))), hash(context.current), 'Actual CURRENT graph required');
  for (const [w, m] of [[context.originalWorld, om], [context.currentWorld, cm]] as const) {payload(w, m.gameplay); payload(w, m.terrain);}
  const additions = [];
  for (const kind of ['nodes', 'lanes', 'connectors', 'footways', 'parking'] as const) {const old = new Set(context.original[kind].map(r => r.id)); for (const r of context.current[kind]) if (!old.has(r.id)) additions.push({kind, id: r.id, sha256: hash(r)});}
  assert.equal(additions.length, 43); assert.deepEqual(additions, packet.retainedCurrentAdditions);
  const bundles = new Map<string, ReturnType<typeof parseCollisionBundle>>(); let decodedTotal = 0;
  const cells = (w: InheritedHeightWorld, m: WorldManifest, pins: any[]) => {
    assert.ok(pins.length > 0 && pins.length <= 64 && new Set(pins.map(p => p.cell ?? p.id)).size === pins.length);
    for (const p of pins) {
      const id = p.cell ?? p.id, key = w.manifestSha256 + ':' + id, cell = m.cells.find(c => c.id === id); assert.ok(cell); assert.equal(cell.collision.sha256, p.storedSha256);
      if (!bundles.has(key)) {const b = payload(w, cell.collision); decodedTotal += b.length; assert.ok(decodedTotal <= 512 * 1024 * 1024); assert.equal(sourceSha256(b), p.decodedSha256); assert.equal(b.length, p.decodedBytes); const bundle = parseCollisionBundle(b); assert.equal(bundle.header.cell, id); assert.equal(bundle.header.originId, m.origin.id); bundles.set(key, bundle);}
    }
  };
  const actualFace = (w: InheritedHeightWorld, f: any) => {
    const fragments = f.id.replace(/^serialized:/, '').split(':'), id = fragments[0], triangle = Number(fragments.at(-1)), colliderId = fragments.slice(1, -1).join(':'), bundle = bundles.get(w.manifestSha256 + ':' + id); assert.ok(bundle);
    const col = bundle.colliders.find(c => c.id === colliderId); assert.ok(col && Number.isInteger(triangle) && triangle >= 0 && triangle < col.indices.length / 3);
    const points = [0, 1, 2].map(k => Array.from(col.positions.subarray(col.indices[triangle * 3 + k]! * 3, col.indices[triangle * 3 + k]! * 3 + 3)));
    assert.deepEqual(points, f.points, 'Legacy rough floor changed'); assert.equal(bundle.header.surfaceTags[col.triangleTags[triangle]!], f.tag);
  };
  const selected: Case[] = []; let body = 0, nominal = 0, nativeTicks = 0, nativePairs = 0, rayPairs = 0;
  for (const c of packet.cases) {
    const witness = {kind: 'lanes' as const, id: c.id, beforeSha256: c.beforeSha256, afterSha256: c.afterSha256}; assert.deepEqual(witness, approval.records.find((r: any) => r.id === c.id));
    for (const graph of [context.original, context.current]) assert.equal(hash(graph.lanes.find(r => r.id === c.id)), c.beforeSha256);
    assert.equal(hash(c.before), c.beforeSha256); assert.equal(hash(c.after), c.afterSha256); const metadata = ({points, ...rest}: RoadLane) => rest; assert.deepEqual(metadata(c.before), metadata(c.after)); assertHorizontalSubdivision(c.before.points, c.after.points);
    const p = proofs.proposals.results.find((p: any) => p.id === c.id); assert.deepEqual(p.original, c.before); assert.deepEqual(p.proposed, c.after);
    cells(context.originalWorld, om, c.physical.originalFloor.cells); cells(context.currentWorld, cm, c.physical.currentFloor.cells);
    const d = proofs.dynamics.cases.find((d: any) => d.id === c.id), rays = proofs.rays.cases.find((r: any) => r.id === c.id); cells(context.currentWorld, cm, d.cells); cells(context.currentWorld, cm, rays.cells);
    checked({file: rays.raw.file, sha256: rays.raw.sha256}, 32 * 1024 * 1024); rayPairs += rays.rayPairs;
    assert.equal(rays.identityChanges, c.id === '123813196:0:f1' ? 3 : 0); assert.ok(rays.maximumTOIResidualUlps <= 4);
    for (const run of c.nativeRuns) {assert.equal(run.exactNativePoseRotationSpeedTyreAndUndersideTrajectoryPreserved, true); assert.equal(run.zeroContactTicks, 0); assert.equal(run.terrainContacts, 0); assert.ok(run.minimumOrientedUndersideClearance > 0); for (const r of run.rawPair) checked({file: r.file, sha256: r.storedSha256}, 32 * 1024 * 1024); nativeTicks += run.ticks; nativePairs++;}
    const rawPin = c.physical.rawAllFailures, compressed = checked({file: rawPin.file, sha256: rawPin.sha256}, 32 * 1024 * 1024, true)!, decoded = gunzipSync(compressed, {maxOutputLength: 64 * 1024 * 1024}); assert.equal(sourceSha256(decoded), rawPin.decodedSha256); assert.equal(decoded.length, rawPin.decodedBytes);
    const raw = JSON.parse(decoded.toString()); assert.equal(raw.recordId, c.id);
    for (const f of raw.faces) actualFace(f.authority.startsWith('original:') ? context.originalWorld : context.currentWorld, f.triangle);
    const physical = c.physical.diagnostic; assert.equal(physical.heightToleranceMetres, .2); assert.deepEqual(physical.failureCounts, {bodyCollision: physical.failureCount}); assert.equal(physical.nominalLaneEdgeIsNotVehicleEnvelope, true); body += physical.failureCount; nominal += physical.nominalFailureCount;
    const points = raw.misses.map((q: any) => {assert.ok(q.point.length === 3 && q.point.every(Number.isFinite)); return q.point;}); assert.equal(points.length, physical.failureCount + (physical.nominalFailureCounts.laneWidthCollision ?? 0));
    selected.push({after: structuredClone(c.after), witness, physical: structuredClone(physical), sourcePartIds: [...c.sourcePartIds], region: c.physical.currentFloor.region, floorReceipt: structuredClone(c.physical.currentFloor), failedPointsSha256: hash(points), failedPoints: points.length});
  }
  assert.deepEqual({body, nominal, nativeTicks, nativePairs, rayPairs}, {body: 66417, nominal: 1248, nativeTicks: 44651, nativePairs: 54, rayPairs: 6273});
  const verifyInputs = () => {for (const item of ledger.values()) checked(item.pin, item.cap, false, false);};
  const bound: Bound = {originalHash: hash(context.original), currentHash: hash(context.current), originId: context.current.originId, world: structuredClone(context.currentWorld), cases: selected, partsPin: structuredClone(partsPin), verifyInputs};
  const authority = Object.freeze({}) as ReviewedInheritedRoughDriving; authorities.set(authority, bound);
  return {authority, ...inheritedRoughDrivingBaselines(authority, context.original, context.current, context.otherRegistrationIds), witnesses: selected.map(c => structuredClone(c.witness)), verifyInputs,
    receipt: {kind: 'literal-three-rough-driving-height', approvalSha256: INHERITED_ROUGH_DRIVING_APPROVAL, packetSha256: PACKET, originalManifestSha256: ORIGINAL, currentManifestSha256: CURRENT, witnesses: selected.map(c => structuredClone(c.witness)), currentAdditionsPreserved: 43, ordinaryFailuresStillFailed: {body, nominal, toleranceMetres: .2}, exactHistoricalClippedFaces: 12, nativeDynamics: {pairedScenarios: nativePairs, ticks: nativeTicks, rawJavascriptSteeringDifferencesRetained: true}, rayPairs}};
}

export function inheritedRoughDrivingBaselines(authority: ReviewedInheritedRoughDriving, original: RoadGraph, current: RoadGraph, otherRegistrationIds: readonly string[]) {
  const b = required(authority); disjoint(otherRegistrationIds); assertBoundedInheritedGraph(original); assertBoundedInheritedGraph(current);
  assert.equal(hash(original), b.originalHash, 'Rough authority requires its ORIGINAL graph'); assert.equal(hash(current), b.currentHash, 'Rough authority requires its CURRENT graph');
  const corrected = (g: RoadGraph): RoadGraph => ({...structuredClone(g), lanes: g.lanes.map(r => structuredClone(b.cases.find(c => c.after.id === r.id)?.after ?? r))});
  return {originalBaseline: corrected(original), currentBaseline: corrected(current)};
}

export function assertReviewedInheritedRoughDrivingAfter(authority: ReviewedInheritedRoughDriving, lane: RoadLane, otherRegistrationIds: readonly string[]) {
  const b = required(authority); disjoint(otherRegistrationIds); const c = b.cases.find(c => c.after.id === lane.id); assert.ok(c, 'Unlisted rough-driving record'); assert.equal(hash(lane), c.witness.afterSha256, 'Exact reviewed rough AFTER required'); return structuredClone(c.witness);
}

/** Recompute ordinary diagnostics from actual serialized HCOL and pinned public
 * source. The ordered complete failed-point batch must match the sealed batch;
 * no caller-supplied result or support sampler can grant the disposition. */
export function inspectReviewedInheritedRoughDriving(authority: ReviewedInheritedRoughDriving, input: {lane: RoadLane; currentWorld: InheritedHeightWorld; otherRegistrationIds: readonly string[]; coverage: RoadCoverage}) {
  const b = required(authority); assertReviewedInheritedRoughDrivingAfter(authority, input.lane, input.otherRegistrationIds);
  assert.equal(input.currentWorld.manifestSha256, CURRENT); assert.equal(fs.realpathSync(input.currentWorld.directory), fs.realpathSync(b.world.directory), 'Rough disposition belongs to another floor'); b.verifyInputs();
  const c = b.cases.find(c => c.after.id === input.lane.id)!, floor = readSerializedRoadFloor(input.currentWorld, c.region, b.originId); assert.deepEqual(floor.receipt, c.floorReceipt);
  const parts = loadGeoJsonPolygons(b.partsPin.file, 25497350, 6672960, p => String(p.osan_id)), support = new RoadCollisionSupport(floor.triangles), misses: Vec3[] = [];
  const observed = {at(x: number, y: number, z: number) {const hit = support.at(x, y, z); if (!hit) misses.push([x, y, z]); return hit;}};
  const physical = inspectRoadPhysicalSupport(input.lane.id, input.lane.points, input.lane.width, c.sourcePartIds, parts, observed, input.coverage, deriveRoadPhysicalEnvelope(c.physical.vehicleEnvelope.definitions), c.physical.intervals, true);
  assert.deepEqual(physical, c.physical, 'Ordinary rough-road diagnostics changed'); assert.equal(misses.length, c.failedPoints); assert.equal(hash(misses), c.failedPointsSha256, 'Complete exact rough failed-probe batch required'); b.verifyInputs();
  return {physical, disposition: {kind: 'literal-rough-road-native-dynamics-disposition', approvalSha256: INHERITED_ROUGH_DRIVING_APPROVAL, worldManifestSha256: CURRENT, record: structuredClone(c.witness), failedPointCount: misses.length, failedPointBatchSha256: c.failedPointsSha256, ordinaryResultStillFailed: true, ordinaryHeightToleranceMetres: .2, noGenericFloorOrSourcePermission: true}};
}
