import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');

function surface(document, buffer, name, height, translation = [0, 0, 0], scale = [1, 1, 1]) {
  const positions = [], indices = [], divisions = 50;
  for (let z = 0; z <= divisions; z++) for (let x = 0; x <= divisions; x++) {
    const px = x / divisions * 10 - 5, pz = z / divisions * 10 - 5;
    positions.push(px, height(px, pz), pz);
  }
  for (let z = 0; z < divisions; z++) for (let x = 0; x < divisions; x++) {
    const a = z * (divisions + 1) + x, b = a + 1, c = a + divisions + 1, d = c + 1;
    indices.push(a, c, d, a, d, b);
  }
  const primitive = document.createPrimitive()
    .setAttribute('POSITION', document.createAccessor().setBuffer(buffer).setType('VEC3').setArray(Float32Array.from(positions)))
    .setIndices(document.createAccessor().setBuffer(buffer).setType('SCALAR').setArray(Uint32Array.from(indices)))
    .setMaterial(document.createMaterial(name).setBaseColorFactor([0.6, 0.4, 0.2, 1]));
  const node = document.createNode(name).setMesh(document.createMesh(name).addPrimitive(primitive)).setTranslation(translation).setScale(scale);
  document.getRoot().listScenes()[0].addChild(node);
  return node;
}

function triangles(node) {
  const matrix = node.getWorldMatrix(), output = [];
  for (const primitive of node.getMesh().listPrimitives()) {
    const positions = primitive.getAttribute('POSITION'), indices = primitive.getIndices();
    for (let i = 0; i < (indices?.getCount() ?? positions.getCount()); i += 3) {
      const triangle = [];
      for (let k = 0; k < 3; k++) {
        const p = positions.getElement(indices ? indices.getScalar(i + k) : i + k, []);
        triangle.push([0, 1, 2].map(axis => Math.fround(matrix[axis] * p[0] + matrix[4 + axis] * p[1] + matrix[8 + axis] * p[2] + matrix[12 + axis])));
      }
      output.push(triangle);
    }
  }
  return output;
}

// Index encoding may cyclically rotate a triangle, which preserves its winding and complete geometry.
function triangleKey(triangle) {
  const keys = triangle.map(vertex => vertex.join(','));
  return [0, 1, 2].map(i => [keys[i], keys[(i + 1) % 3], keys[(i + 2) % 3]].join('|')).sort()[0];
}

function heightAt(triangles, x, z) {
  for (const [a, b, c] of triangles) {
    const denominator = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2]);
    const u = ((b[2] - c[2]) * (x - c[0]) + (c[0] - b[0]) * (z - c[2])) / denominator;
    const v = ((c[2] - a[2]) * (x - c[0]) + (a[0] - c[0]) * (z - c[2])) / denominator;
    if (u >= -1e-7 && v >= -1e-7 && u + v <= 1 + 1e-7) return u * a[1] + v * b[1] + (1 - u - v) * c[1];
  }
  return null;
}

test('distant export preserves complex ground exactly while simplifying a scaled curved building within 10 cm', async t => {
  await MeshoptDecoder.ready;
  const root = path.resolve('data/work');
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(path.join(root, 'distant-simplification-test-'));
  try {
    mkdirSync(path.join(directory, 'visual'));
    const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
    const document = new Document(), buffer = document.createBuffer();
    document.createScene();
    const ground = surface(document, buffer, 'fixture_ground_slabs', (x, z) => Math.sin(x * 4) * Math.cos(z * 4) * 0.3);
    const building = surface(document, buffer, 'curved architecture', (x, z) => 4 + (1 - x * x / 25) * (1 - z * z / 25), [30, 3, 0], [2, 0.5, 1.5]);
    const originalGround = triangles(ground), originalBuilding = triangles(building), source = await io.writeBinary(document);
    const sourcePath = 'visual/fixture.lod0.glb', sourceFile = path.join(directory, sourcePath);
    writeFileSync(sourceFile, source);
    const retainedLow = { path: 'visual/separate-low.glb', bytes: 123, sha256: 'retained-low-descriptor', triangles: 123, drawCalls: 2, atlases: 0, textureBytesEstimate: 0 };
    writeFileSync(path.join(directory, 'cells.json'), JSON.stringify({ cells: [{ id: 'fixture', visual: { lod0: { path: sourcePath, sha256: sha(source), bytes: source.length, triangles: 10000, drawCalls: 2, atlases: 0, textureBytesEstimate: 0 }, lod1: retainedLow } }] }));
    execFileSync(process.execPath, ['tools/world/build_distant_cells.mjs', '--cells', directory], { encoding: 'utf8', timeout: 60000, windowsHide: true });

    assert.equal(sha(readFileSync(sourceFile)), sha(source), 'the detailed source is immutable');
    const index = JSON.parse(readFileSync(path.join(directory, 'cells.json'))), lod = index.cells[0].visual.lod2;
    assert.deepEqual(index.cells[0].visual.lod1, retainedLow, 'distant generation preserves an already verified optional low tier');
    const bytes = readFileSync(path.join(directory, lod.path)), distant = await io.readBinary(bytes);
    assert.equal(sha(bytes), lod.sha256);
    assert.equal(bytes.length, lod.bytes);
    assert.equal(distant.getRoot().listTextures().length, 0);
    assert.equal(lod.textureBytesEstimate, 0);
    assert.equal(lod.atlases, 0);
    assert.equal(lod.drawCalls, 1);
    const output = distant.getRoot().listNodes().filter(node => node.getMesh()).flatMap(triangles);
    assert.equal(lod.triangles, output.length, 'published scheduling cost matches decoded geometry');
    const actualGround = output.filter(triangle => triangle.every(vertex => vertex[0] < 10));
    const actualBuilding = output.filter(triangle => triangle.every(vertex => vertex[0] > 10));
    assert.deepEqual(actualGround.map(triangleKey).sort(), originalGround.map(triangleKey).sort(), 'all 5000 ground triangles stay exact despite exceeding the simplification threshold');
    assert.ok(actualBuilding.length < originalBuilding.length / 2, 'the complex curved architecture actually simplifies');
    let maximumError = 0;
    for (const triangle of originalBuilding) for (const [x, y, z] of triangle) {
      const simplifiedY = heightAt(actualBuilding, x, z);
      assert.notEqual(simplifiedY, null, 'simplification does not open holes in the architectural surface');
      maximumError = Math.max(maximumError, Math.abs(y - simplifiedY));
    }
    assert.ok(maximumError <= 0.10001, `world-space error ${maximumError} exceeds 10 cm`);
    const report = JSON.parse(readFileSync(path.join(directory, 'distant-report.json')));
    assert.deepEqual(report.cells[0].simplified.map(change => change.node), ['curved architecture']);
    assert.equal(report.cells[0].simplified[0].maxErrorMetres, 0.1);
    assert.equal(report.cells[0].simplified[0].after, actualBuilding.length);
    t.diagnostic(JSON.stringify({ groundTrianglesExact: actualGround.length, buildingTrianglesBefore: originalBuilding.length, buildingTrianglesAfter: actualBuilding.length, maximumMeasuredWorldError: maximumError }));
  } finally {
    assert.ok(path.resolve(directory).startsWith(root + path.sep), 'only the isolated work fixture may be deleted');
    rmSync(directory, { recursive: true, force: true });
  }
});
