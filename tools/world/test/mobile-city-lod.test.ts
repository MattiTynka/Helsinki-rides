import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { Document, NodeIO, type Primitive } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import { validateBytes } from 'gltf-validator';
import { buildMobileCityLod } from '../lib/mobile-city-lod.ts';
import { decodeDeliveryCityGlb, embedDeliveryImages } from '../lib/delivery-city-payloads.ts';
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function fixture(hole = false, sharedProtectedMesh = false) {
    await Promise.all([MeshoptEncoder.ready, MeshoptDecoder.ready]);
    const doc = new Document(), scene = doc.createScene(), buffer = doc.createBuffer(), material = doc.createMaterial('original'), texture = doc.createTexture('licensed-source').setImage(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jFz8AAAAASUVORK5CYII=', 'base64')).setMimeType('image/png');
    material.setBaseColorTexture(texture);
    const make = (name: string, pos: Float32Array<ArrayBuffer>, uv: Float32Array<ArrayBuffer>, indices: Uint32Array<ArrayBuffer>) => {
        const primitive = doc.createPrimitive().setAttribute('POSITION', doc.createAccessor().setBuffer(buffer).setType('VEC3').setArray(pos)).setAttribute('TEXCOORD_0', doc.createAccessor().setBuffer(buffer).setType('VEC2').setArray(uv)).setIndices(doc.createAccessor().setBuffer(buffer).setType('SCALAR').setArray(indices)).setMaterial(material);
        scene.addChild(doc.createNode(name).setMesh(doc.createMesh(name).addPrimitive(primitive)));
    };
    const size = 16, positions: number[] = [], uv: number[] = [], indices: number[] = [];
    for (let z = 0; z <= size; z++)
        for (let x = 0; x <= size; x++) {
            positions.push(x, 0, z);
            uv.push(x / 8, z / 8);
        }
    for (let z = 0; z < size; z++)
        for (let x = 0; x < size; x++) {
            if (hole && x >= 6 && x < 10 && z >= 6 && z < 10)
                continue;
            const a = z * (size + 1) + x, b = a + 1, c = a + size + 1, d = c + 1;
            indices.push(a, c, b, b, c, d);
        }
    make('cell_ground_slabs', Float32Array.from(positions), Float32Array.from(uv), Uint32Array.from(indices));
    if (sharedProtectedMesh) scene.addChild(doc.createNode('cell_ground_stairs_shared').setMesh(scene.listChildren()[0]!.getMesh()));
    for (const name of ['cell_ground_stairs', 'cell_ground_bridge', 'cell_landmark_cathedral'])
        make(name, Float32Array.of(2, 0, 2, 2, .3, 2, 3, .3, 2, 2, .3, 3), Float32Array.of(0, 0, 0, 1, 1, 1, 1, 0), Uint32Array.of(0, 1, 2, 1, 3, 2));
    doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
    return new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder }).writeBinary(doc);
}
function triangleKeys(p: Primitive) {
    const indices = p.getIndices()!.getArray()!, positions = p.getAttribute('POSITION')!, uv = p.getAttribute('TEXCOORD_0')!, keys: string[] = [];
    for (let t = 0; t < indices.length; t += 3)
        keys.push([0, 1, 2].map(i => [positions.getElement(indices[t + i]!, []), uv.getElement(indices[t + i]!, [])]).map(p => JSON.stringify(p)).join('|'));
    return keys;
}
function boundary(p: Primitive) {
    const indices = p.getIndices()!.getArray()!, position = p.getAttribute('POSITION')!, edges = new Map<string, number>();
    for (let t = 0; t < indices.length; t += 3)
        for (let i = 0; i < 3; i++) {
            const key = [position.getElement(indices[t + i]!, []).join(','), position.getElement(indices[t + (i + 1) % 3]!, []).join(',')].sort().join('|');
            edges.set(key, (edges.get(key) ?? 0) + 1);
        }
    return [...edges].filter(([, n]) => n !== 2).sort();
}
test('real mobile intermediate LOD reduces dense surfaces with exact retained UVs, textures and protected stairs/bridges/heroes', async () => {
    const original = await fixture(), sourceHash = hash(original), result = await buildMobileCityLod(original, new Map(), [0, 0, 16, 16]);
    assert.ok(result.bytes);
    assert.ok(result.afterTriangles < result.beforeTriangles * .5);
    assert.equal(hash(original), sourceHash);
    const before = await decodeDeliveryCityGlb(original), images = new Map<string, Uint8Array>();
    for (const texture of before.getRoot().listTextures())
        images.set(`../textures/${hash(texture.getImage()!)}.png`, texture.getImage()!);
    const after = await decodeDeliveryCityGlb(result.bytes, images), nodes = new Map(after.getRoot().listNodes().map(n => [n.getName(), n]));
    for (const node of before.getRoot().listNodes()) {
        const p = node.getMesh()!.listPrimitives()[0]!, q = nodes.get(node.getName())!.getMesh()!.listPrimitives()[0]!;
        if (node.getName() === 'cell_ground_slabs') {
            assert.deepEqual(boundary(q), boundary(p));
            const source = new Set(Array.from({ length: p.getAttribute('POSITION')!.getCount() }, (_, i) => JSON.stringify([p.getAttribute('POSITION')!.getElement(i, []), p.getAttribute('TEXCOORD_0')!.getElement(i, [])])));
            for (let i = 0; i < q.getAttribute('POSITION')!.getCount(); i++)
                assert.ok(source.has(JSON.stringify([q.getAttribute('POSITION')!.getElement(i, []), q.getAttribute('TEXCOORD_0')!.getElement(i, [])])));
        }
        else
            assert.deepEqual(triangleKeys(q), triangleKeys(p), 'Protected architecture must remain exact');
    }
    assert.deepEqual(after.getRoot().listTextures().map(t => hash(t.getImage()!)), before.getRoot().listTextures().map(t => hash(t.getImage()!)));
    assert.ok(result.receipts.filter(r => r.accepted).every(r => r.measuredErrorMetres <= .01 && r.measuredAttributeError <= .003));
    const validation = await validateBytes(embedDeliveryImages(result.bytes, images));
    assert.equal(validation.issues.numErrors, 0, JSON.stringify(validation.issues.messages));
});
test('mobile simplification keeps the exact internal hole outline instead of filling missing surfaces', async () => {
    const original = await fixture(true), result = await buildMobileCityLod(original, new Map(), [0, 0, 16, 16]);
    assert.ok(result.bytes);
    const before = await decodeDeliveryCityGlb(original), images = new Map(before.getRoot().listTextures().map(t => [`../textures/${hash(t.getImage()!)}.png`, t.getImage()!])), after = await decodeDeliveryCityGlb(result.bytes, images);
    assert.deepEqual(boundary(after.getRoot().listMeshes()[0]!.listPrimitives()[0]!), boundary(before.getRoot().listMeshes()[0]!.listPrimitives()[0]!));
});

test('a later protected instance prevents an earlier generic node from mutating their shared mesh', async () => {
    const original = await fixture(false, true);
    const result = await buildMobileCityLod(original, new Map(), [0, 0, 16, 16]);
    assert.equal(result.bytes, null, 'Shared mesh must retain its exact original for both instances');
    assert.equal(result.afterTriangles, result.beforeTriangles);
    assert.ok(result.receipts.filter(r => r.node.startsWith('cell_ground_slabs:') || r.node.startsWith('cell_ground_stairs_shared:')).every(r => !r.accepted && r.after === r.before));
});
