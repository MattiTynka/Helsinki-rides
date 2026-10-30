import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {encodeCollisionBundle, gk25ToGeodetic, polylineLength, type RoadGraph, type RoadLane, type RoadConnector, type Vec3} from '../../../packages/world-schema/src/index.ts';
import {deriveRoadPhysicalEnvelope, mergeQualifiedRoads, RoadCollisionSupport, type RoadMergeSelection, type RoadSupportTriangle, type RoadSourceElement, type RoadCoverage} from '../lib/expansion-road-merge.ts';
import {sourceSha256} from '../lib/source-files.ts';
import type {LocalPolygon} from '../lib/geometry.ts';

function fixture() {
  const vehicleDefinitions = [{id: 'fixture-car', collider: {halfExtents: [.94, .4, 2.35] as Vec3, centre: [0, .95, -.07] as Vec3}, wheelRadius: .342, wheelWidth: .29, suspension: {restLength: .2, maxTravel: .2, stiffness: 30, damping: 4, compression: 4}, wheels: [{socket: 'front', position: [.822, .342, 1.333] as Vec3, steer: true, drive: true, handbrake: false}, {socket: 'rear', position: [-.822, .342, -1.333] as Vec3, steer: false, drive: true, handbrake: true}]}];
  const vehicleEnvelope = deriveRoadPhysicalEnvelope(vehicleDefinitions);
  const originProjected: Vec3 = [25497350, 6672960, 7.5];
  const lane = (id: string, wayId: number, from: string, to: string, points: Vec3[]): RoadLane => ({id, wayId, from, to, points, length: polylineLength(points), name: 'fixture', highway: 'residential', surface: 'asphalt', speedLimit: 8, width: 3, index: 0, count: 1});
  const oldForward = lane('1:0:f0', 1, 'n1', 'n2', [[0, 0, 1.5], [10, 0, 1.5]]), oldBackward = lane('1:0:b0', 1, 'n2', 'n1', [[10, 0, -1.5], [0, 0, -1.5]]);
  const newForward = lane('2:0:f0', 2, 'n2', 'n3', [[10.5, 0, 1.5], [20, 0, 1.5]]), newBackward = lane('2:0:b0', 2, 'n3', 'n2', [[20, 0, -1.5], [10.5, 0, -1.5]]);
  const connector = (from: RoadLane, to: RoadLane): RoadConnector => ({id: `${from.id}>${to.id}`, node: from.to, from: from.id, to: to.id, turn: from.wayId === to.wayId ? 'u-turn' : 'straight', points: [from.points.at(-1)!, to.points[0]!], length: polylineLength([from.points.at(-1)!, to.points[0]!])});
  const oldTurn = connector(oldBackward, oldForward), newTurn = connector(newForward, newBackward), outward = connector(oldForward, newForward), returning = connector(newBackward, oldBackward);
  const nodes = [0, 10, 20].map((x, i) => ({id: `n${i + 1}`, position: [x, 0, 0] as Vec3, kind: 'junction' as const}));
  const accepted: RoadGraph = {schemaVersion: 2, originId: 'fixture', source: {id: 'old', sha256: 'a'.repeat(64), attribution: 'fixture', license: 'ODbL'}, nodes: nodes.slice(0, 2), lanes: [oldForward, oldBackward], connectors: [oldTurn], parking: [], footways: []};
  const candidate: RoadGraph = {...accepted, source: {...accepted.source, id: 'new', sha256: 'b'.repeat(64)}, nodes, lanes: [...accepted.lanes, newForward, newBackward], connectors: [...accepted.connectors, newTurn]};
  const osmNodes: RoadSourceElement[] = nodes.map(node => {const [lat, lon] = gk25ToGeodetic(originProjected[0] + node.position[0], originProjected[1] - node.position[2]); return {type: 'node', id: Number(node.id.slice(1)), lat, lon};});
  const osm = {elements: [...osmNodes, {type: 'way', id: 1, nodes: [1, 2], tags: {highway: 'residential'}}, {type: 'way', id: 2, nodes: [2, 3], tags: {highway: 'residential'}}] as RoadSourceElement[]};
  const parts: LocalPolygon[] = [{id: 'road-part', bbox: [-10, -10, 30, 10], rings: [[[-10, -10], [30, -10], [30, 10], [-10, 10]]], properties: {alatyyppi: 'Ajorata'}}];
  const triangles: RoadSupportTriangle[] = [{id: 'face1', tag: 'road:asphalt', points: [[-10, 0, -10], [-10, 0, 10], [30, 0, 10]]}, {id: 'face2', tag: 'road:asphalt', points: [[-10, 0, -10], [30, 0, 10], [30, 0, -10]]}];
  const selection: RoadMergeSelection = {schemaVersion: 1, regions: [[9, -5, 25, 5]], acceptedAnchorLaneIds: [oldForward.id], lanes: [newForward, newBackward].map(lane => ({id: lane.id, partIds: ['road-part']})),
    connectors: [{id: newTurn.id, partIds: ['road-part']}], seamConnectors: [outward, returning].map(connector => ({connector, osmNodeId: 2, partIds: ['road-part']})), retainedConflicts: [], structures: [], levelTransitions: []};
  const acceptedCoverage: RoadCoverage = {playArea: {minX: -10, maxX: 10.25, minZ: -10, maxZ: 10}}, expandedCoverage: RoadCoverage = {playArea: {...acceptedCoverage.playArea, maxX: 25}};
  return {accepted, candidate, acceptedCoverage, expandedCoverage, vehicleDefinitions, vehicleEnvelope, osm, originProjected, parts, support: new RoadCollisionSupport(triangles), selection, triangles};
}

test('qualified road merge preserves all accepted records and proves directed out-and-back paths', () => {
  const f = fixture(), before = structuredClone(f.accepted), result = mergeQualifiedRoads(f);
  assert.deepEqual(f.accepted, before); assert.deepEqual(result.graph.lanes.slice(0, 2), before.lanes); assert.deepEqual(result.graph.connectors.slice(0, 1), before.connectors);
  assert.deepEqual(result.graph.source, before.source); assert.equal(result.graph.lanes.length, 4); assert.equal(result.receipt.boundaryWitnesses.length, 2);
  assert.equal(result.receipt.status, 'PASS_SOURCE_QUALIFIED_ROAD_MERGE_PENDING_RUNTIME'); assert.ok(result.receipt.physical.every(proof => proof.samples > 0 && proof.maxHeightDeviation === 0));
});

test('accepted drift fails unless both exact conflict hashes are witnessed, and never replaces old bytes', () => {
  const f = fixture(), changed = structuredClone(f.candidate); (changed.lanes[0] as {name: string}).name = 'fresh source name'; f.candidate = changed;
  assert.throws(() => mergeQualifiedRoads(f), /Unexplained accepted lanes conflict/);
  f.selection.retainedConflicts.push({kind: 'lanes', id: changed.lanes[0]!.id, acceptedSha256: sourceSha256(JSON.stringify(f.accepted.lanes[0])), candidateSha256: sourceSha256(JSON.stringify(changed.lanes[0])), reason: 'Preserve accepted lane while extending only new source identities'});
  const result = mergeQualifiedRoads(f); assert.deepEqual(result.graph.lanes[0], f.accepted.lanes[0]); assert.equal(result.receipt.retainedConflicts.length, 1);
});

test('coincident coordinates do not authorize a join without the same OSM node identity', () => {
  const f = fixture(); const changed = structuredClone(f.candidate); (changed.lanes[2] as {from: string}).from = 'n4';
  (changed.nodes as {id: string; position: Vec3; kind: 'junction'}[]).push({id: 'n4', position: [10, 0, 0], kind: 'junction'});
  f.osm.elements.push({...f.osm.elements[1]!, id: 4}); f.osm.elements.find(e => e.type === 'way' && e.id === 2)!.nodes = [4, 3];
  (changed.lanes[3] as {to: string}).to = 'n4'; f.candidate = changed;
  assert.throws(() => mergeQualifiedRoads(f), /n4|shared OSM/);
});

test('unqualified levels, bridge access, one-way reversal and turn restrictions fail closed', () => {
  const level = fixture(); level.osm.elements.find(e => e.type === 'way' && e.id === 2)!.tags!.layer = '1'; assert.throws(() => mergeQualifiedRoads(level), /stacked-road/);
  const bridge = fixture(); bridge.osm.elements.find(e => e.type === 'way' && e.id === 2)!.tags!.bridge = 'yes'; assert.throws(() => mergeQualifiedRoads(bridge), /Unqualified bridge/);
  const privateWay = fixture(); privateWay.osm.elements.find(e => e.type === 'way' && e.id === 2)!.tags!.access = 'private'; assert.throws(() => mergeQualifiedRoads(privateWay), /Non-public/);
  const oneWay = fixture(); oneWay.osm.elements.find(e => e.type === 'way' && e.id === 2)!.tags!.oneway = 'yes'; assert.throws(() => mergeQualifiedRoads(oneWay), /reverses source one-way/);
  const restricted = fixture(); restricted.osm.elements.push({type: 'relation', id: 50, tags: {type: 'restriction', restriction: 'no_straight_on'}, members: [{type: 'way', ref: 1, role: 'from'}, {type: 'node', ref: 2, role: 'via'}, {type: 'way', ref: 2, role: 'to'}]}); assert.throws(() => mergeQualifiedRoads(restricted), /violates OSM/);
});

test('full vehicle width must have municipal carriageway and road collision at the correct level', () => {
  const missing = fixture(); missing.support = new RoadCollisionSupport([]); assert.throws(() => mergeQualifiedRoads(missing), /lacks road collision/);
  const wrongLevel = fixture(); wrongLevel.support = new RoadCollisionSupport(wrongLevel.triangles.map(triangle => ({...triangle, points: triangle.points.map(p => [p[0], p[1] + 4, p[2]]) as [Vec3, Vec3, Vec3]}))); assert.throws(() => mergeQualifiedRoads(wrongLevel), /lacks road collision/);
  const narrow = fixture(); narrow.parts[0]!.rings[0] = [[-10, -2], [30, -2], [30, 2], [-10, 2]]; assert.throws(() => mergeQualifiedRoads(narrow), /full-width\/body source support/);
});

test('a source-bound public parking aisle still requires complete physical road support', () => {
  const f = fixture(), way = f.osm.elements.find(e => e.type === 'way' && e.id === 2)!;
  way.tags = {highway: 'service', service: 'parking_aisle'};
  for (const lane of f.candidate.lanes) if (lane.wayId === 2) (lane as {highway: string}).highway = 'service';
  f.parts[0] = {...f.parts[0]!, properties: {paatyyppi: 'Ajorata', alatyyppi: 'Pys\u00e4k\u00f6intialue', aluetieto: 'Katu', alueen_nimi: 'Reviewed square'}};
  assert.throws(() => mergeQualifiedRoads(f), /Non-carriageway/);
  const review = {kind: 'municipal-public-parking-aisle' as const, partId: 'road-part', partSha256: sourceSha256(JSON.stringify(f.parts[0])), streetName: 'Reviewed square', ways: [{id: 2, sha256: sourceSha256(JSON.stringify(way))}], reason: 'The named public municipal parking aisle is explicitly identified by both sources'};
  for (const ref of [...f.selection.lanes, ...f.selection.connectors, ...f.selection.seamConnectors]) ref.surfaceReviews = [review];
  const result = mergeQualifiedRoads(f);
  assert.equal(result.receipt.surfaceEligibilityWitnesses?.length, 5);
  assert.deepEqual(result.graph.lanes.slice(0, f.accepted.lanes.length), f.accepted.lanes);
  f.support = new RoadCollisionSupport([]);
  assert.throws(() => mergeQualifiedRoads(f), /lacks road collision/);
});

test('new lanes without a directed return path are rejected even when weakly connected', () => {
  const f = fixture(); f.selection.seamConnectors.pop(); assert.throws(() => mergeQualifiedRoads(f), /out-and-back/);
});

test('exact supported-area segment checks reject a narrow hole between lane sample points', () => {
  const f = fixture(); f.expandedCoverage = {...f.expandedCoverage, supportedArea: {schemaVersion: 1, regions: [{id: 'fixture', outer: [[-10, -10], [25, -10], [25, 10], [-10, 10]], holes: [[[15.01, 1.49], [15.02, 1.49], [15.02, 1.51], [15.01, 1.51]]]}]}};
  assert.throws(() => mergeQualifiedRoads(f), /crosses unsupported geography/);
});

test('a tiny hole wholly inside the vehicle footprint is rejected even off the lane centreline', () => {
  const f = fixture(); f.expandedCoverage = {...f.expandedCoverage, supportedArea: {schemaVersion: 1, regions: [{id: 'fixture', outer: [[-10, -10], [25, -10], [25, 10], [-10, 10]], holes: [[[15.01, 2.2], [15.02, 2.2], [15.02, 2.21], [15.01, 2.21]]]}]}};
  assert.throws(() => mergeQualifiedRoads(f), /swept body/);
});

test('vehicle support envelope includes a wider secondary usable vehicle and centre offsets', () => {
  const f = fixture(), larger = structuredClone(f.vehicleDefinitions[0]!); larger.id = 'second-car'; larger.collider.halfExtents[0] = 1.2; larger.collider.centre[2] = -.3;
  const envelope = deriveRoadPhysicalEnvelope([...f.vehicleDefinitions, larger]); assert.equal(envelope.bodyHalfWidth, 1.3); assert.equal(envelope.bodyHalfLength, 2.75); assert.deepEqual(envelope.definitionIds, ['fixture-car', 'second-car']);
});

test('new supported geography may join two retained lanes at an explicitly accepted boundary', () => {
  const f = fixture(), retained = {...f.candidate, nodes: f.candidate.nodes.map(node => node.id === 'n2' ? {...node, kind: 'boundary' as const} : node)};
  f.accepted = retained; f.candidate = structuredClone(retained); f.selection.lanes = []; f.selection.connectors = [];
  f.selection.seamConnectors = f.selection.seamConnectors.map(ref => ({...ref, retainedBoundary: true}));
  assert.throws(() => mergeQualifiedRoads(f), /retained lane/i);
  f.selection.retainedLanes = retained.lanes.slice(2).map(lane => ({id: lane.id, partIds: ['road-part']}));
  const result = mergeQualifiedRoads(f); assert.deepEqual(result.graph.lanes, retained.lanes); assert.deepEqual(result.graph.nodes, retained.nodes);
  assert.equal(result.receipt.selectedLaneIds.length, 0); assert.ok(result.receipt.boundaryWitnesses.every(witness => witness.kind === 'retained-boundary'));
  f.selection.seamConnectors[0]!.retainedBoundary = undefined;
  assert.throws(() => mergeQualifiedRoads(f), /retained-only connection/);
});

test('retained lane tails with clamped old heights require explicit source-bound repair', () => {
  const f = fixture(), retained = structuredClone(f.candidate);
  for (const lane of retained.lanes.slice(2)) for (const point of lane.points) point[1] = 4;
  f.accepted = retained; f.candidate = structuredClone(retained); f.selection.lanes = []; f.selection.connectors = [];
  f.selection.seamConnectors = f.selection.seamConnectors.map(ref => ({...ref, retainedBoundary: true}));
  f.selection.retainedLanes = retained.lanes.slice(2).map(lane => ({id: lane.id, partIds: ['road-part']}));
  assert.throws(() => mergeQualifiedRoads(f), (error: Error & {retainedAudit?: {physical?: {samples: number; failureCount: number}}[]}) => {
    assert.match(error.message, /source-bound.*repair/i); assert.equal(error.retainedAudit?.length, 2);
    assert.ok(error.retainedAudit!.every(result => result.physical!.samples > 100 && result.physical!.failureCount > 0), 'Every exposed retained tail is sampled, including after the first failure'); return true;
  });
});

test('road merge CLI binds native input hashes and emits a verifiable retained-record receipt', t => {
  const f = fixture(), root = fs.mkdtempSync(path.join(os.tmpdir(), 'road-merge-cli-')), acceptedRoot = path.join(root, 'accepted'), nativeRoot = path.join(root, 'native');
  t.after(() => fs.rmSync(root, {recursive: true, force: true})); fs.mkdirSync(acceptedRoot); fs.mkdirSync(nativeRoot);
  const json = (file: string, value: unknown) => {const bytes = Buffer.from(JSON.stringify(value)); fs.writeFileSync(file, bytes); return {file, sha256: sourceSha256(bytes)};};
  const acceptedRef = json(path.join(acceptedRoot, 'roads.json'), f.accepted), osmRef = json(path.join(root, 'osm.json'), f.osm);
  const candidate = {...f.candidate, source: {...f.candidate.source, sha256: osmRef.sha256}}, candidateRef = json(path.join(root, 'candidate.json'), candidate);
  const streetRef = json(path.join(root, 'street-parts.geojson'), {type: 'FeatureCollection', features: [{type: 'Feature', properties: {osan_id: 'road-part', alatyyppi: 'Ajorata'}, geometry: {type: 'Polygon', coordinates: [f.parts[0]!.rings[0]!.map(([x, y]) => [x + f.originProjected[0], y + f.originProjected[1]])]}}]});
  const bytes = encodeCollisionBundle({originId: 'fixture', frame: 'X-east,Y-up,Z-south', cell: 'c0', surfaceTags: ['road:asphalt']}, [{id: 'ground', group: 'ground', ref: null,
    positions: Float32Array.from(f.triangles.flatMap(triangle => triangle.points.flat())), indices: Uint32Array.from([0, 1, 2, 3, 4, 5]), triangleTags: Uint16Array.from([0, 0])}]);
  for (const directory of [acceptedRoot, nativeRoot]) fs.writeFileSync(path.join(directory, 'ground.bin'), bytes);
  const cell = {id: 'c0', boundsXZ: [-10, -10, 30, 10], collision: {path: 'ground.bin', bytes: bytes.length, sha256: sourceSha256(bytes), boundsXZ: [-10, -10, 30, 10]}};
  const nativeRef = json(path.join(nativeRoot, 'cells.json'), {originId: 'fixture', cells: [cell]});
  const gameplay = json(path.join(acceptedRoot, 'gameplay.json'), {...f.acceptedCoverage, vehicleDefinitions: f.vehicleDefinitions});
  const manifest = json(path.join(acceptedRoot, 'manifest.json'), {origin: {id: 'fixture', originProjected: f.originProjected}, roads: {path: 'roads.json', bytes: fs.statSync(acceptedRef.file).size, sha256: acceptedRef.sha256}, gameplay: {path: 'gameplay.json', bytes: fs.statSync(gameplay.file).size, sha256: gameplay.sha256}, cells: [cell]});
  const supportedArea = json(path.join(root, 'supported-area.json'), {schemaVersion: 1, kind: 'qualified-expansion-supported-area', acceptedManifestSha256: manifest.sha256, originId: 'fixture', qualification: {status: 'PASS_SOURCE_QUALIFIED_SUPPORTED_AREA'}, sourceFiles: [{path: streetRef.file, bytes: fs.statSync(streetRef.file).size, sha256: streetRef.sha256}], supportedArea: {schemaVersion: 1, regions: [{id: 'fixture', outer: [[-10, -10], [25, -10], [25, 10], [-10, 10]]}]}});
  const plan = json(path.join(root, 'plan.json'), {schemaVersion: 1, acceptedWorld: acceptedRoot, expectedManifestSha256: manifest.sha256, candidateRoads: candidateRef, osm: osmRef, streetParts: streetRef,
    nativeCells: {directory: nativeRoot, indexSha256: nativeRef.sha256}, expandedSupportedArea: supportedArea, selection: f.selection});
  const out = path.join(root, 'out'), script = fileURLToPath(new URL('../merge_expansion_roads.ts', import.meta.url));
  const result = spawnSync(process.execPath, [script, '--plan', plan.file, '--out', out], {encoding: 'utf8'}); assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(fs.readFileSync(path.join(out, 'road-merge-receipt.json'), 'utf8')), merged = fs.readFileSync(path.join(out, 'roads.json'));
  assert.equal(receipt.mergedRoadsSha256, sourceSha256(merged)); assert.equal(receipt.acceptedManifestSha256, manifest.sha256); assert.equal(receipt.nativeCellsIndexSha256, nativeRef.sha256);
  assert.deepEqual(JSON.parse(merged.toString()).lanes.slice(0, 2), f.accepted.lanes);
  fs.appendFileSync(osmRef.file, ' '); const drift = spawnSync(process.execPath, [script, '--plan', plan.file, '--out', path.join(root, 'drift')], {encoding: 'utf8'});
  assert.notEqual(drift.status, 0); assert.match(drift.stderr, /Road merge source hash drift/); assert.equal(fs.existsSync(path.join(root, 'drift')), false);
});
