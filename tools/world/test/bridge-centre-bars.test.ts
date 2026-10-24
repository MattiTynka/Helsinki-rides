import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Document} from '@gltf-transform/core';
import {encodeCollisionBundle, parseCollisionBundle} from '../../../packages/world-schema/src/index.ts';
import {buildReconstructedBridge, type BridgeFace, type ReconstructedBridge} from '../lib/bridge-reconstruction.ts';
import {centreBarKeyCounts, centreBarTriangleKey, legacyBridgeCentreBars, legacyCentreBarCells, planCentreBarVisualRemoval, removeCentreBarCollision, countCentreBarCollisionTriangles} from '../lib/bridge-centre-bars.ts';

const bridge: ReconstructedBridge = {id: 'hakaniemensilta', name: 'Bridge fixture', kind: 'two-level-composite',
  stations: [{x: 20, z: 20, roadY: 1, leftOuter: 10, rightOuter: 10, roadHalfWidth: 6, lowerWalkDrop: 2},
    {x: 20, z: 32, roadY: 1.2, leftOuter: 10, rightOuter: 10, roadHalfWidth: 6, lowerWalkDrop: 2}],
  sourcePartIds: [1], waterY: -7.5, curbHeight: .12, crossfall: .02,
  parapet: {kind: 'steel', height: 1.1, thickness: .08}, architectureStartMetres: 2, architectureEndMetres: 10,
  approachMetres: 2, deckThickness: .45, references: ['fixture'], qualifications: ['fixture']};

function interleavedSource() {
  const bars = legacyBridgeCentreBars(bridge), next = buildReconstructedBridge(bridge);
  const outer = next.filter(f => f.material === 'steel' && f.role === 'railing').slice(0, 3);
  assert.equal(outer.length, 3);
  const faces = bars.flatMap((f, i) => i === 1 ? [f, outer[0]!, outer[1]!] : [f]); faces.push(outer[2]!);
  return {bars, outer, faces};
}
function document(faces: readonly BridgeFace[]) {
  const doc = new Document(), buffer = doc.createBuffer(), material = doc.createMaterial('bridge-original-steel');
  const positions = doc.createAccessor().setType('VEC3').setBuffer(buffer).setArray(Float32Array.from(faces.flatMap(f => f.points.flat())));
  const indices = doc.createAccessor().setType('SCALAR').setBuffer(buffer).setArray(Uint32Array.from({length: faces.length * 3}, (_, i) => i));
  const primitive = doc.createPrimitive().setAttribute('POSITION', positions).setIndices(indices).setMaterial(material);
  doc.createScene().addChild(doc.createNode('fixture_bridge_architecture_steel').setMesh(doc.createMesh().addPrimitive(primitive)));
  return doc;
}

test('new bridge producer leaves the carriageway open and preserves its outer rails, glass and road floor', () => {
  for (const coarse of [false, true]) {
    const keys = centreBarKeyCounts(legacyBridgeCentreBars(bridge, coarse)), faces = buildReconstructedBridge(bridge, {coarse});
    assert.ok(keys.size > 0);
    assert.equal(faces.filter(f => keys.has(centreBarTriangleKey(f.points))).length, 0);
    assert.ok(faces.some(f => f.material === 'steel' && f.role === 'railing' && f.collision));
    assert.ok(faces.some(f => f.material === 'glass' && f.collision));
    assert.ok(faces.some(f => f.role === 'road' && f.collision));
  }
});

test('exact multiset removal keeps interleaved outer rails sharing the same material and primitive', () => {
  const {bars, faces, outer} = interleavedSource(), keys = centreBarKeyCounts(bars), doc = document(faces);
  const result = planCentreBarVisualRemoval(doc, keys, false);
  assert.equal(result.proof.removedTriangles, bars.length);
  assert.equal(result.edits.length, 1);
  const keep = result.edits[0]!.indices;
  assert.deepEqual(Array.from(keep), faces.flatMap((f, i) => outer.includes(f) ? [i * 3, i * 3 + 1, i * 3 + 2] : []));
  assert.equal(keep.length, 9);
  assert.deepEqual(Array.from(doc.getRoot().listMeshes()[0]!.listPrimitives()[0]!.getIndices()!.getArray()!), Array.from({length: faces.length * 3}, (_, i) => i), 'Input geometry was mutated');
});

test('collision removal retains positions and filters tags in lockstep with noncontiguous kept triangles', () => {
  const {bars, faces, outer} = interleavedSource(), keys = centreBarKeyCounts(bars), positions = Float32Array.from(faces.flatMap(f => f.points.flat()));
  const indices = Uint32Array.from({length: faces.length * 3}, (_, i) => i), tags = Uint16Array.from(faces, f => outer.includes(f) ? 0 : 1);
  const source = {id: 'bridge-reconstruction:fixture:props:0', group: 'props' as const, ref: null, positions, indices, triangleTags: tags};
  const unrelated = {id: 'unrelated-building', group: 'buildings' as const, ref: 'house', positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]), triangleTags: new Uint16Array([2])};
  const bytes = encodeCollisionBundle({originId: 'fixture', frame: 'X-east,Y-up,Z-south', cell: 'fixture', surfaceTags: ['outer-wall', 'centre-bar', 'building']}, [source, unrelated]);
  const result = removeCentreBarCollision(bytes, keys), after = parseCollisionBundle(result.bytes);
  assert.equal(result.proof.removedTriangles, bars.length);
  assert.deepEqual(after.colliders[0]!.positions, positions);
  assert.deepEqual(after.colliders[0]!.indices, Uint32Array.from(faces.flatMap((f, i) => outer.includes(f) ? [i * 3, i * 3 + 1, i * 3 + 2] : [])));
  assert.deepEqual(after.colliders[0]!.triangleTags, new Uint16Array([0, 0, 0]));
  assert.deepEqual(after.colliders[1], unrelated); assert.equal(countCentreBarCollisionTriangles(result.bytes, keys), 0);
  assert.deepEqual(parseCollisionBundle(bytes).colliders[0]!.indices, indices, 'Input collision was mutated');
});

test('source drift, including an additional duplicate centre face, is refused', () => {
  const bars = legacyBridgeCentreBars(bridge), keys = centreBarKeyCounts(bars);
  assert.throws(() => planCentreBarVisualRemoval(document([...bars, bars[0]!]), keys, false), /match the payload exactly/);
  assert.throws(() => planCentreBarVisualRemoval(document(bars.slice(1)), keys, false), /match the payload exactly/);
});

test('cell-clipped key inventories preserve detailed duplicate caps and separate coarse keys', () => {
  const shifted = {...bridge, stations: bridge.stations.map(s => ({...s, z: s.z + 100}))};
  const detailed = legacyCentreBarCells(shifted), coarse = legacyCentreBarCells(shifted, true);
  assert.ok(detailed.size === 2 && coarse.size === 2);
  assert.ok([...detailed.values()].some(keys => [...keys.values()].some(n => n > 1)), 'Detailed internal caps retain their multiplicity');
  assert.ok([...coarse.values()].every(keys => [...keys.values()].every(n => n === 1)));
});
