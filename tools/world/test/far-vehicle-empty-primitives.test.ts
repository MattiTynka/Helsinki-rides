import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Document, NodeIO} from '@gltf-transform/core';
import {ALL_EXTENSIONS} from '@gltf-transform/extensions';
import {MeshoptDecoder} from 'meshoptimizer';

test('distant-car generation removes collapsed trim, retains exact lamps and produces no empty accessors', async () => {
  const taskDirectory = mkdtempSync(path.join(tmpdir(), 'helsinki-far-empty-'));
  try {
    const assets = path.join(taskDirectory, 'assets'), output = path.join(taskDirectory, 'far'); mkdirSync(assets);
    const document = new Document(), buffer = document.createBuffer('accepted');
    function primitive(materialName: string, points: number[], indices: number[]) {
      const positions = document.createAccessor().setBuffer(buffer).setType('VEC3').setArray(new Float32Array(points));
      const normals = new Float32Array(points.length); for (let i = 1; i < normals.length; i += 3) normals[i] = 1;
      const normal = document.createAccessor().setBuffer(buffer).setType('VEC3').setArray(normals);
      const index = document.createAccessor().setBuffer(buffer).setType('SCALAR').setArray(new Uint16Array(indices));
      return document.createPrimitive().setAttribute('POSITION', positions).setAttribute('NORMAL', normal).setIndices(index)
        .setMaterial(document.createMaterial(materialName).setBaseColorFactor([.3, .4, .5, 1]));
    }
    const body = primitive('car_body', [-1, 0, -2, 1, 0, -2, 1, 0, 2, -1, 0, 2], [0, 2, 1, 0, 3, 2]);
    // Above the simplification threshold, but the whole isolated piece is much smaller than 3 cm.
    // Meshopt can remove it completely; the original bug serialized its zero-count attributes.
    const repeatedTriangles = Array.from({length: 30}, () => [0, 2, 1]).flat();
    const octahedron = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    const trimPoints = [[0, 2, 4], [4, 2, 1], [1, 2, 5], [5, 2, 0], [4, 3, 0], [1, 3, 4], [5, 3, 1], [0, 3, 5]].flatMap(face => {
      const [a, b, c] = face.map(i => octahedron[i]!);
      const midpoint = (p: number[], q: number[]) => p.map((v, i) => (v + q[i]!) / 2);
      const ab = midpoint(a!, b!), ac = midpoint(a!, c!), bc = midpoint(b!, c!);
      return [a!, ab, ac, ab, b!, bc, ac, bc, c!, ab, bc, ac].flat().map(v => v * .001);
    });
    const trim = primitive('car_trim', trimPoints, Array.from({length: trimPoints.length / 3}, (_, i) => i));
    const lamp = primitive('car_lamp_head', [0, .5, 1, .2, .5, 1, 0, .5, 1.2], repeatedTriangles);
    document.createScene('game').addChild(document.createNode('CAR_BODY').setMesh(document.createMesh().addPrimitive(body).addPrimitive(trim).addPrimitive(lamp)));
    const original = await new NodeIO().writeBinary(document), source = path.join(assets, 'vehicle-revontuli.glb'); writeFileSync(source, original);
    execFileSync(process.execPath, [fileURLToPath(new URL('../build_far_vehicles.mjs', import.meta.url)), '--assets', assets, '--out', output, '--vehicles', 'vehicle-revontuli'], {encoding: 'utf8'});
    const report = JSON.parse(readFileSync(path.join(output, 'report.json'), 'utf8')).reports[0];
    assert.equal(report.validatorErrors, 0); assert.ok(report.after <= 6500); assert.equal(report.maxErrorMetres, .03);
    const removed = report.nodes.find((node: any) => node.material === 'car_trim'); assert.equal(removed.after, 0); assert.ok(removed.measuredErrorMetres <= .03);
    assert.deepEqual(readFileSync(source), Buffer.from(original), 'Accepted source asset must remain untouched');
    await MeshoptDecoder.ready;
    const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({'meshopt.decoder': MeshoptDecoder});
    const far = await io.readBinary(readFileSync(path.join(output, 'vehicle-revontuli-far-low.glb')));
    assert.ok(far.getRoot().listAccessors().every(accessor => accessor.getCount() > 0));
    const farLamp = far.getRoot().listMeshes().flatMap(mesh => mesh.listPrimitives()).find(p => p.getMaterial()?.getName() === 'car_lamp_head')!;
    assert.ok(farLamp); assert.equal(farLamp.getIndices()!.getCount(), repeatedTriangles.length);
    // Reordering may rotate triangle indices or reorder vertices, so compare the rendered triangles.
    function triangles(p: typeof lamp) {
      const positions = p.getAttribute('POSITION')!, indices = p.getIndices()!, result: string[] = [];
      for (let i = 0; i < indices.getCount(); i += 3) {
        const vertices = [0, 1, 2].map(k => positions.getElement(indices.getScalar(i + k), []).join(','));
        result.push([0, 1, 2].map(k => [vertices[k], vertices[(k + 1) % 3], vertices[(k + 2) % 3]].join('|')).sort()[0]!);
      }
      return result.sort();
    }
    assert.deepEqual(triangles(farLamp), triangles(lamp));
    assert.deepEqual(farLamp.getMaterial()!.getBaseColorFactor(), lamp.getMaterial()!.getBaseColorFactor());
  } finally {
    assert.ok(path.dirname(taskDirectory) === path.resolve(tmpdir()) && path.basename(taskDirectory).startsWith('helsinki-far-empty-'));
    rmSync(taskDirectory, {recursive: true, force: true});
  }
});
