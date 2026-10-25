// Narrow repair for the supplied head patch moving through the shirt under raised arms.
// Geometry, rest matrices and animation bytes are not altered. The caller owns a fresh GLB buffer.
import assert from 'node:assert/strict';
export function applySnowCollarWeights(glb, patch, sourceSha256) {
  assert.equal(patch.version, 1); assert.equal(patch.sourceSha256, sourceSha256);
  assert.equal(patch.meshName, 'SNOW-head_game'); assert.equal(patch.primitive, 0);
  assert.ok(patch.vertices.length > 0 && patch.vertices.length <= 128, 'Unexpected collar patch size');
  const meshes = glb.json.meshes.filter(m => m.name === patch.meshName);
  assert.equal(meshes.length, 1);
  const primitive = meshes[0].primitives[0];
  assert.equal(primitive.attributes.JOINTS_0, patch.jointAccessor);
  assert.equal(primitive.attributes.WEIGHTS_0, patch.weightAccessor);
  const bin = Buffer.from(glb.bin.buffer, glb.bin.byteOffset, glb.bin.byteLength);
  const before = Buffer.from(bin), allowedBytes = new Set(), seen = new Set(), affectedViews = new Set();
  const jointCount = glb.json.skins[0].joints.length;
  for (const item of patch.vertices) {
    assert.ok(Number.isInteger(item.vertex) && item.vertex >= 0 && !seen.has(item.vertex)); seen.add(item.vertex);
    assert.equal(item.donor.meshName, 'SNOW-shirt_game');
    assert.ok(item.bindSignedSeparationMeters <= 0 && item.bindDistanceMeters <= .015);
    assert.ok(item.weights.every(w => Number.isFinite(w) && w >= 0 && w <= 1));
    assert.ok(Math.abs(item.weights.reduce((a, b) => a + b, 0) - 1) < 1e-6);
    assert.ok(item.joints.every(j => Number.isInteger(j) && j >= 0 && j < jointCount));
    for (const [accessorId, expected, replacement, kind] of [
      [patch.jointAccessor, item.beforeJoints, item.joints, 'joints'],
      [patch.weightAccessor, item.beforeWeights, item.weights, 'weights'],
    ]) {
      assert.equal(expected.length, 4); assert.equal(replacement.length, 4);
      const accessor = glb.json.accessors[accessorId], view = glb.json.bufferViews[accessor.bufferView];
      assert.equal(accessor.type, 'VEC4'); assert.ok(!accessor.sparse && !accessor.normalized && item.vertex < accessor.count);
      assert.equal(view.buffer, 0);
      assert.ok(kind === 'weights' ? accessor.componentType === 5126 : [5121, 5123].includes(accessor.componentType));
      const size = accessor.componentType === 5121 ? 1 : accessor.componentType === 5123 ? 2 : 4;
      const stride = view.byteStride ?? 4 * size;
      const offset = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0) + item.vertex * stride;
      assert.ok(offset >= (view.byteOffset ?? 0) && offset + size * 4 <= (view.byteOffset ?? 0) + view.byteLength);
      affectedViews.add(accessor.bufferView);
      for (let c = 0; c < 4; c++) {
        const at = offset + c * size;
        const old = size === 1 ? bin.readUInt8(at) : size === 2 ? bin.readUInt16LE(at) : bin.readFloatLE(at);
        assert.equal(old, size === 4 ? Math.fround(expected[c]) : expected[c], 'Patch must match original native weights');
        if (size === 1) bin.writeUInt8(replacement[c], at);
        else if (size === 2) bin.writeUInt16LE(replacement[c], at);
        else bin.writeFloatLE(replacement[c], at);
        for (let i = 0; i < size; i++) allowedBytes.add(at + i);
      }
    }
  }
  let changedBytes = 0;
  for (let i = 0; i < bin.length; i++) if (bin[i] !== before[i]) { assert.ok(allowedBytes.has(i), 'Non-collar byte changed'); changedBytes++; }
  return { vertices: seen.size, changedBytes, affectedBufferViews: [...affectedViews], policy: 'Only listed head collar JOINTS_0/WEIGHTS_0 components; all other BIN bytes unchanged.' };
}
