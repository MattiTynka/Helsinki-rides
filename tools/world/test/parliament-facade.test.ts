import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Document } from '@gltf-transform/core';
import { encodeCollisionBundle, type TriMeshCollider } from '../../../packages/world-schema/src/index.ts';
import { makeParliamentFacade, worldTriangleKey, PARLIAMENT_ID } from '../build_parliament_facade.ts';
import { removeSourceWallTriangles, verifySourceCitymodelShell } from '../replace_parliament_facade.ts';

test('world triangle identity accepts cyclic rotation and Float32 equivalence but preserves winding', () => {
  const t = [[1.1, 2, 3], [4, 5, 6], [7, 8, 9]];
  assert.equal(worldTriangleKey(t), worldTriangleKey([t[1]!, t[2]!, t[0]!]));
  assert.equal(worldTriangleKey(t), worldTriangleKey(t.map(v => v.map(Math.fround))));
  assert.notEqual(worldTriangleKey(t), worldTriangleKey([t[0]!, t[2]!, t[1]!]));
});

function sourceFixture() {
  const doc = new Document(), buffer = doc.createBuffer(), scene = doc.createScene();
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 2, 0, 0, 3, 0, 0, 2, 1, 0, 4, 0, 0, 5, 0, 0, 4, 1, 0, 6, 0, 0, 7, 0, 0, 6, 1, 0]);
  const P = doc.createAccessor().setType('VEC3').setArray(positions).setBuffer(buffer);
  const I = doc.createAccessor().setType('SCALAR').setArray(new Uint16Array(Array.from({ length: 12 }, (_, i) => i))).setBuffer(buffer);
  const primitive = doc.createPrimitive().setAttribute('POSITION', P).setIndices(I);
  const mesh = doc.createMesh('source').addPrimitive(primitive), node = doc.createNode('source').setMesh(mesh); scene.addChild(node);
  const keys = [0, 1, 2].map(i => worldTriangleKey([0, 1, 2].map(k => Array.from(positions.slice(i * 9 + k * 3, i * 9 + k * 3 + 3)))));
  return { doc, primitive, node, mesh, P, I, keys, scene };
}

test('targeted removal leaves attributes and a shared original index accessor unchanged', () => {
  const f = sourceFixture(), otherP = f.doc.createAccessor().setType('VEC3').setBuffer(f.doc.getRoot().listBuffers()[0]!).setArray(Float32Array.from(f.P.getArray()!, n => n + 30));
  const other = f.doc.createPrimitive().setAttribute('POSITION', otherP).setIndices(f.I);
  f.scene.addChild(f.doc.createNode('unrelated').setMesh(f.doc.createMesh('unrelated').addPrimitive(other)));
  const before = f.P.getArray()!.slice(), oldIndices = f.I.getArray()!.slice();
  const changes = removeSourceWallTriangles(f.doc, f.keys);
  assert.equal(changes.reduce((n, p) => n + p.removedTriangles, 0), 3);
  assert.deepEqual(Array.from(f.primitive.getIndices()!.getArray()!), [9, 10, 11]);
  assert.deepEqual(f.P.getArray(), before);
  assert.deepEqual(f.I.getArray(), oldIndices);
  assert.equal(other.getIndices(), f.I);
});

test('missing or duplicate source triangles fail before mutating any geometry', () => {
  const absent = sourceFixture();
  assert.throws(() => removeSourceWallTriangles(absent.doc, [...absent.keys.slice(0, 2), 'absent']), /matched 0 times/);
  assert.equal(absent.primitive.getIndices(), absent.I);
  const duplicate = sourceFixture(); duplicate.scene.addChild(duplicate.doc.createNode('ambiguous-instance').setMesh(duplicate.mesh));
  assert.throws(() => removeSourceWallTriangles(duplicate.doc, duplicate.keys), /matched 2 times/);
  assert.equal(duplicate.primitive.getIndices(), duplicate.I);
});

test('source citymodel shell proof rejects missing colliders and altered front barriers', () => {
  const f = sourceFixture(), P = Float32Array.from(f.P.getArray()!);
  const triangles = Array.from({ length: 4 }, (_, i) => [0, 1, 2].map(k => [P[i * 9 + k * 3]!, -P[i * 9 + k * 3 + 2]!, P[i * 9 + k * 3 + 1]!]));
  const c: TriMeshCollider = { id: `cm:${PARLIAMENT_ID}`, group: 'citymodel', ref: PARLIAMENT_ID, positions: P, indices: Uint32Array.from(f.I.getArray()!), triangleTags: new Uint16Array(4) };
  const encode = (colliders: TriMeshCollider[]) => encodeCollisionBundle({ cell: 'fixture', frame: 'X-east,Y-up,Z-south', originId: 'fixture', surfaceTags: ['citymodel'] }, colliders);
  const proof = verifySourceCitymodelShell(encode([c]), triangles, f.keys);
  assert.equal(proof.triangles, 4); assert.equal(proof.originalFrontBarrierRetained, true);
  assert.throws(() => verifySourceCitymodelShell(encode([]), triangles, f.keys), /exactly one original source collider/);
  const reversed = { ...c, indices: Uint32Array.from(c.indices) }; [reversed.indices[0], reversed.indices[1]] = [reversed.indices[1]!, reversed.indices[0]!];
  assert.throws(() => verifySourceCitymodelShell(encode([reversed]), triangles, f.keys), /original source geometry or winding/);
});

test('fourteen columns and all replacement geometry stay within the old facade envelope', () => {
  const frame = { origin: [0, 0] as [number, number], normal: [1, 0] as [number, number], tangent: [0, 1] as [number, number], width: 54.3, bottom: 3.69, top: 37.9 };
  const result = makeParliamentFacade(frame, 11.49, new Array(14).fill(11.4));
  assert.equal(result.centers.length, 14); assert.equal(new Set(result.centers).size, 14);
  assert.equal(result.oculusCount, 15);
  assert.equal(result.lowerArchedBays, 13);
  assert.deepEqual(result.doorBays, [3, 6, 9]);
  assert.ok(result.oculusCenters[0]! < result.centers[0]! && result.oculusCenters.at(-1)! > result.centers.at(-1)!);
  assert.ok(Math.abs(result.shaftTop - result.baseHeight - 17) < 1e-9);
  for (const group of Object.values(result.groups)) {
    assert.ok(group.indices.length > 0);
    for (let i = 0; i < group.positions.length; i += 3) {
      assert.ok(group.positions[i]! <= 0 && group.positions[i]! >= -3.2);
      assert.ok(group.positions[i + 1]! >= 3.69 && group.positions[i + 1]! <= 37.9);
      assert.ok(-group.positions[i + 2]! >= 0 && -group.positions[i + 2]! <= 54.3);
    }
  }
  assert.throws(() => makeParliamentFacade(frame, 11.49, new Array(14).fill(20)), /no source-ground base/);
});

test('lower window glass follows an arched head while the backing plane remains behind it', () => {
  const frame = { origin: [0, 0] as [number, number], normal: [1, 0] as [number, number], tangent: [0, 1] as [number, number], width: 54.3, bottom: 3.69, top: 37.9 };
  const f = makeParliamentFacade(frame, 11.49, new Array(14).fill(11.4));
  const glass = f.groups.glass, u = (f.centers[0]! + f.centers[1]!) / 2, top = f.baseHeight + 3.1;
  const contains = (qU: number, qH: number) => {
    for (let i = 0; i < glass.indices.length; i += 3) {
      const t = glass.indices.slice(i, i + 3).map(id => glass.positions.slice(id * 3, id * 3 + 3));
      if (t.some(v => Math.abs(v[0]! + 3.0) > 1e-7)) continue;
      const [a, b, c] = t.map(v => [-v[2]!, v[1]!] as [number, number]);
      const den = (b![1] - c![1]) * (a![0] - c![0]) + (c![0] - b![0]) * (a![1] - c![1]);
      if (Math.abs(den) < 1e-9) continue;
      const x = ((b![1] - c![1]) * (qU - c![0]) + (c![0] - b![0]) * (qH - c![1])) / den;
      const y = ((c![1] - a![1]) * (qU - c![0]) + (a![0] - c![0]) * (qH - c![1])) / den;
      if (x >= -1e-8 && y >= -1e-8 && x + y <= 1 + 1e-8) return true;
    }
    return false;
  };
  assert.equal(contains(u, top - 0.05), true);
  assert.equal(contains(u + 0.65, top - 0.05), false, 'upper outside corner must remain stone, not rectangular glass');
});
