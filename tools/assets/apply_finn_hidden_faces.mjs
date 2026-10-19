// Remove only pinned head triangles fully hidden beneath the shirt at bind.
import assert from 'node:assert/strict';
export function applyFinnHiddenFaces(glb, patch, sourceSha256) {
  assert.equal(patch.version, 1); assert.equal(patch.sourceSha256, sourceSha256);
  assert.equal(patch.meshName, 'FINN-head_game'); assert.equal(patch.primitive, 0);
  assert.equal(patch.triangles.length, 2, 'Only the two evidenced collar islands may be removed');
  const mesh = glb.json.meshes.find(m => m.name === patch.meshName);
  assert.equal(mesh.primitives[0].indices, patch.indexAccessor);
  const a = glb.json.accessors[patch.indexAccessor], v = glb.json.bufferViews[a.bufferView];
  assert.equal(a.type, 'SCALAR'); assert.ok(!a.sparse && !a.normalized && !v.byteStride);
  assert.equal(a.byteOffset ?? 0, 0); assert.equal(v.buffer, 0);
  assert.ok([5123, 5125].includes(a.componentType)); assert.equal(a.count % 3, 0);
  const size = a.componentType === 5123 ? 2 : 4;
  assert.equal(v.byteLength, a.count * size);
  assert.equal(glb.json.accessors.filter(x => x.bufferView === a.bufferView).length, 1, 'Dedicated index view required');
  const bin = Buffer.from(glb.bin.buffer, glb.bin.byteOffset, glb.bin.byteLength), offset = v.byteOffset ?? 0;
  const indices = Array.from({ length: a.count }, (_, i) => size === 2 ? bin.readUInt16LE(offset + i * size) : bin.readUInt32LE(offset + i * size));
  const removed = new Set();
  const expectedFaces = [[6, 13, 1320], [1582, 1589, 2896]];
  for (const item of patch.triangles) {
    assert.ok(Number.isInteger(item.triangleIndex) && item.triangleIndex >= 0 && item.triangleIndex < a.count / 3 && !removed.has(item.triangleIndex));
    assert.deepEqual(indices.slice(item.triangleIndex * 3, item.triangleIndex * 3 + 3), item.indices);
    const ordered = [...item.indices].sort((x, y) => x - y);
    assert.ok(expectedFaces.some(face => JSON.stringify(face) === JSON.stringify(ordered)), 'Unexpected hidden face');
    removed.add(item.triangleIndex);
  }
  const retained = indices.filter((_, i) => !removed.has(Math.floor(i / 3)));
  const originalCount = a.count, originalByteLength = v.byteLength;
  retained.forEach((value, i) => { if (size === 2) bin.writeUInt16LE(value, offset + i * size); else bin.writeUInt32LE(value, offset + i * size); });
  bin.fill(0, offset + retained.length * size, offset + originalByteLength);
  a.count = retained.length; v.byteLength = retained.length * size;
  if (a.min) a.min = [Math.min(...retained)];
  if (a.max) a.max = [Math.max(...retained)];
  return { triangles: patch.triangles, indexAccessor: patch.indexAccessor, bufferView: a.bufferView, originalCount, retainedCount: a.count, originalByteLength, retainedByteLength: v.byteLength, policy: 'Exact retained triangle order; only two fully covered source head faces removed. No vertex attributes changed.' };
}
