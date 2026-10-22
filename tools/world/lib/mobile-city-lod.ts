// Index-only mobile visual LODs. Physics, textures, protected architecture and every retained vertex stay exact.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Logger, NodeIO, type Document, type Primitive } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression } from '@gltf-transform/extensions';
import { compactPrimitive, prune, weldPrimitive } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import { decodeDeliveryCityGlb, deliveryGeometryStats } from './delivery-city-payloads.ts';
import { compactGlb } from './compact-glb.ts';
import { externalizeCellImages } from './shared-textures.ts';
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const ids = (p: Primitive) => Uint32Array.from(p.getIndices()?.getArray() ?? Array.from({
    length: p.getAttribute('POSITION')!.getCount()
}, (_, i) => i));
const key = (p: Float32Array, i: number) => `${p[i * 3]},${p[i * 3 + 1]},${p[i * 3 + 2]}`;
const protectedName = (name: string) => /(?:landmark|monument|alexander|senate_entrance|stair|steps|bridge|retaining|curb|kerb|tram)/i.test(name);
export const MOBILE_LOD_MAX_COMPARISONS = 2_000_000;
export const MOBILE_LOD_MAX_BIN_REFERENCES = 1_000_000;
function normal(p: Float32Array, a: number, b: number, c: number) {
    const ux = p[b * 3]! - p[a * 3]!, uy = p[b * 3 + 1]! - p[a * 3 + 1]!, uz = p[b * 3 + 2]! - p[a * 3 + 2]!, vx = p[c * 3]! - p[a * 3]!, vy = p[c * 3 + 1]! - p[a * 3 + 1]!, vz = p[c * 3 + 2]! - p[a * 3 + 2]!;
    const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx], s = Math.hypot(...n);
    return n.map(v => s ? v / s : 0);
}
function edges(indices: Uint32Array, p: Float32Array) {
    const map = new Map<string, {
        a: number;
        b: number;
        normals: number[][];
        count: number;
    }>();
    for (let t = 0; t < indices.length; t += 3) {
        const n = normal(p, indices[t]!, indices[t + 1]!, indices[t + 2]!);
        if (n.every(v => v === 0))
            continue;
        for (let k = 0; k < 3; k++) {
            const a = indices[t + k]!, b = indices[t + (k + 1) % 3]!, ka = key(p, a), kb = key(p, b), edgeKey = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`, e = map.get(edgeKey) ?? {
                a, b, normals: [], count: 0
            };
            e.count++;
            e.normals.push(n);
            map.set(edgeKey, e);
        }
    }
    return map;
}
function outline(indices: Uint32Array, p: Float32Array) {
    return [...edges(indices, p)].filter(([, e]) => e.count !== 2).map(([k, e]) => `${k}:${e.count}`).sort();
}
/** Bidirectional source/candidate surface and interpolated-attribute checks at vertices, edges and centroids.
 * Spatial bins keep this bounded to nearby triangles, including vertical architectural faces. */
function measure(before: Uint32Array, after: Uint32Array, p: Float32Array, attrs: Float32Array, stride: number, limit: number, attributeLimit: number, onFailure?: (detail: unknown) => void) {
    const bins = new Map<string, number[]>(), size = 1;
    let references = 0, comparisons = 0;
    for (let t = 0; t < after.length; t += 3) {
        const v = [after[t]!, after[t + 1]!, after[t + 2]!], xs = v.map(i => p[i * 3]!), zs = v.map(i => p[i * 3 + 2]!);
        for (let x = Math.floor((Math.min(...xs) - limit) / size); x <= Math.floor((Math.max(...xs) + limit) / size); x++)
            for (let z = Math.floor((Math.min(...zs) - limit) / size); z <= Math.floor((Math.max(...zs) + limit) / size); z++) {
                if (++references > MOBILE_LOD_MAX_BIN_REFERENCES) {
                    onFailure?.({ reason: 'spatial-reference-work-budget', maximum: MOBILE_LOD_MAX_BIN_REFERENCES });
                    return null;
                }
                const k = `${x},${z}`, bin = bins.get(k) ?? [];
                bin.push(t);
                bins.set(k, bin);
            }
    }
    let maxDistance = 0, maxAttribute = 0;
    for (let t = 0; t < before.length; t += 3) {
        if (normal(p, before[t]!, before[t + 1]!, before[t + 2]!).every(v => v === 0))
            continue;
        for (const weights of [[1, 0, 0], [0, 1, 0], [0, 0, 1], [.5, .5, 0], [0, .5, .5], [.5, 0, .5], [1 / 3, 1 / 3, 1 / 3]]) {
            const old = [before[t]!, before[t + 1]!, before[t + 2]!], xyz = [0, 1, 2].map(k => old.reduce((s, i, j) => s + p[i * 3 + k]! * weights[j]!, 0)), expected = Array.from({
                length: stride
            }, (_, k) => old.reduce((s, i, j) => s + attrs[i * stride + k]! * weights[j]!, 0));
            let best = Infinity, bestAttr = Infinity;
            for (const q of bins.get(`${Math.floor(xyz[0]! / size)},${Math.floor(xyz[2]! / size)}`) ?? []) {
                if (++comparisons > MOBILE_LOD_MAX_COMPARISONS) {
                    onFailure?.({ reason: 'triangle-comparison-work-budget', maximum: MOBILE_LOD_MAX_COMPARISONS });
                    return null;
                }
                const a = after[q]!, b = after[q + 1]!, c = after[q + 2]!, A = [p[a * 3]!, p[a * 3 + 1]!, p[a * 3 + 2]!], U = [0, 1, 2].map(k => p[b * 3 + k]! - A[k]!), V = [0, 1, 2].map(k => p[c * 3 + k]! - A[k]!), W = xyz.map((v, k) => v - A[k]!), dot = (u: number[], v: number[]) => u.reduce((s, x, k) => s + x * v[k]!, 0), d00 = dot(U, U), d01 = dot(U, V), d11 = dot(V, V), d20 = dot(W, U), d21 = dot(W, V), d = d00 * d11 - d01 * d01;
                if (Math.abs(d) < 1e-20)
                    continue;
                const v = (d11 * d20 - d01 * d21) / d, w = (d00 * d21 - d01 * d20) / d, u = 1 - v - w;
                if (Math.min(u, v, w) < -1e-7 || Math.max(u, v, w) > 1 + 1e-7)
                    continue;
                const distance = Math.hypot(...xyz.map((x, k) => x - (u * A[k]! + v * p[b * 3 + k]! + w * p[c * 3 + k]!)));
                if (distance > limit + 1e-7)
                    continue;
                let attribute = 0;
                for (let k = 0; k < stride; k++)
                    attribute = Math.max(attribute, Math.abs(expected[k]! - (u * attrs[a * stride + k]! + v * attrs[b * stride + k]! + w * attrs[c * stride + k]!)));
                if (attribute <= attributeLimit + 1e-7 && distance + attribute < best + bestAttr) {
                    best = distance;
                    bestAttr = attribute;
                }
            }
            if (!Number.isFinite(best)) {
                onFailure?.({
                    triangle: t / 3, point: xyz, expected, nearbyTriangles: (bins.get(`${Math.floor(xyz[0]! / size)},${Math.floor(xyz[2]! / size)}`) ?? []).length
                });
                return null;
            }
            maxDistance = Math.max(maxDistance, best);
            maxAttribute = Math.max(maxAttribute, bestAttr);
        }
    }
    return {
        maxDistance, maxAttribute
    };
}
function semantic(p: Primitive) {
    const h = createHash('sha256');
    const attributes = p.listSemantics().sort().map(name => ({
        name, accessor: p.getAttribute(name)!
    }));
    for (const { name, accessor } of attributes)
        h.update(JSON.stringify([name, accessor.getType(), accessor.getComponentType(), accessor.getNormalized()]));
    const vertices = new Map<number, string>();
    const vertex = (index: number) => {
        if (!vertices.has(index)) {
            const bytes = attributes.map(({ accessor }) => {
                const array = accessor.getArray()!, size = accessor.getElementSize(), value = array.subarray(index * size, (index + 1) * size);
                return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('hex');
            });
            vertices.set(index, bytes.join(':'));
        }
        return vertices.get(index)!;
    };
    // Meshopt's triangle index codec may cyclically rotate a triangle. This preserves its
    // exact ordered Float32 corners, winding, UV/normal/colour bits and draw order.
    const indices = ids(p);
    for (let i = 0; i < indices.length; i += 3) {
        const corners = [vertex(indices[i]!), vertex(indices[i + 1]!), vertex(indices[i + 2]!)];
        const rotations = [0, 1, 2].map(k => [corners[k], corners[(k + 1) % 3], corners[(k + 2) % 3]].join('|'));
        h.update(rotations.sort()[0]!);
    }
    return h.digest('hex');
}
function protectedSemantic(doc: Document) {
    return doc.getRoot().listNodes().flatMap(n => (n.getMesh()?.listPrimitives() ?? []).map((p, i) => ({
        key: `${n.getName()}:${i}`, matrix: n.getWorldMatrix(), semantic: semantic(p)
    }))).sort((a, b) => a.key.localeCompare(b.key));
}
export interface MobileLodReceipt {
    node: string;
    before: number;
    after: number;
    accepted: boolean;
    reason: string;
    maxErrorMetres: number;
    measuredErrorMetres: number;
    measuredAttributeError: number;
    lockedVertices: number;
    rejection?: unknown;
}
export async function buildMobileCityLod(bytes: Uint8Array, images: ReadonlyMap<string, Uint8Array>, bounds: readonly [
    number,
    number,
    number,
    number
]) {
    await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready, MeshoptSimplifier.ready]);
    const doc = await decodeDeliveryCityGlb(bytes, images);
    doc.setLogger(new Logger(Logger.Verbosity.ERROR));
    assert.equal(doc.getRoot().listSkins().length, 0);
    assert.equal(doc.getRoot().listAnimations().length, 0);
    const imageHashes = doc.getRoot().listTextures().map(t => sha(t.getImage()!)).sort(), receipts: MobileLodReceipt[] = [], preserved = new Map<string, {
        matrix: number[];
        semantic: string;
    }>();
    // A mesh may be instanced by a protected node later in traversal. Protect all shared meshes
    // before any mutation rather than snapshotting already-modified geometry at its second instance.
    const meshUses = new Map<object, number>();
    for (const node of doc.getRoot().listNodes()) {
        const mesh = node.getMesh();
        if (mesh) meshUses.set(mesh, (meshUses.get(mesh) ?? 0) + 1);
    }
    for (const n of doc.getRoot().listNodes())
        for (const [pi, p] of (n.getMesh()?.listPrimitives() ?? []).entries()) {
            const name = [n.getName(), n.getMesh()!.getName(), p.getMaterial()?.getName() ?? ''].join(' '), before = ids(p).length / 3, ground = /_ground_/.test(name), limit = ground ? .01 : .04, receipt: MobileLodReceipt = {
                node: `${n.getName()}:${pi}`, before, after: before, accepted: false, reason: 'protected', maxErrorMetres: limit, measuredErrorMetres: 0, measuredAttributeError: 0, lockedVertices: 0
            };
            receipts.push(receipt);
            const sourceSemantic = semantic(p), keep = () => preserved.set(receipt.node, {
                matrix: n.getWorldMatrix(), semantic: sourceSemantic
            });
            if ((meshUses.get(n.getMesh()!) ?? 0) > 1 || protectedName(name) || p.getMode() !== 4 || p.listTargets().length || p.getMaterial()?.getAlphaMode() === 'BLEND' || before < 16 || !n.getWorldMatrix().every((v, i) => v === [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1][i]) || p.listSemantics().some(s => !['POSITION', 'TEXCOORD_0', 'NORMAL', 'COLOR_0'].includes(s))) {
                keep();
                continue;
            }
            // Clone first; a rejected candidate must preserve its original arrays and indices exactly.
            const trial = p.clone();
            // Primitive.clone shares accessor children. Give each trial independent arrays before weld/compact;
            // another protected primitive may refer to the very same original accessor.
            for (const semantic of trial.listSemantics()) {
                const original = trial.getAttribute(semantic)!;
                trial.setAttribute(semantic, original.clone().setArray(original.getArray()!.slice()));
            }
            if (trial.getIndices()) {
                const original = trial.getIndices()!;
                trial.setIndices(original.clone().setArray(original.getArray()!.slice()));
            }
            weldPrimitive(trial, {
                overwrite: true
            });
            const position = trial.getAttribute('POSITION')!;
            if (!(position.getArray() instanceof Float32Array) || position.getNormalized()) {
                trial.dispose();
                keep();
                continue;
            }
            const positions = position.getArray() as Float32Array, old = ids(trial), vertices = position.getCount(), locks = new Uint8Array(vertices), attributes = trial.listSemantics().filter(s => s !== 'POSITION').map(s => trial.getAttribute(s)!), stride = attributes.reduce((s, a) => s + a.getElementSize(), 0), packed = new Float32Array(vertices * stride);
            // UV/colour error is measured directly. Normals use a separate 0.05 component ceiling,
            // rather than applying a subpixel texture-coordinate threshold to quantized lighting normals.
            for (let i = 0; i < vertices; i++) {
                let offset = i * stride;
                for (const a of attributes) {
                    const values = a.getElement(i, []), weight = trial.getAttribute('NORMAL') === a ? (ground ? .06 : .1) : 1;
                    packed.set(values.map(v => v * weight), offset);
                    offset += values.length;
                }
            }
            for (const e of edges(old, positions).values())
                if (e.count !== 2 || e.normals.some(v => v.reduce((s, x, i) => s + x * e.normals[0]![i]!, 0) < .9961946980917455))
                    locks[e.a] = locks[e.b] = 1;
            for (let i = 0; i < old.length; i += 3) {
                const a = old[i]!, b = old[i + 1]!, c = old[i + 2]!, normalY = normal(positions, a, b, c)[1]!;
                if (ground && normalY < .85)
                    locks[a] = locks[b] = locks[c] = 1;
            }
            for (let i = 0; i < vertices; i++)
                if (Math.abs(positions[i * 3]! - bounds[0]) < 1e-5 || Math.abs(positions[i * 3]! - bounds[2]) < 1e-5 || Math.abs(positions[i * 3 + 2]! - bounds[1]) < 1e-5 || Math.abs(positions[i * 3 + 2]! - bounds[3]) < 1e-5)
                    locks[i] = 1;
            receipt.lockedVertices = locks.reduce((s, x) => s + x, 0);
            const target = Math.max(3, Math.floor(old.length * (ground ? .35 : .25) / 3) * 3), [candidate, error] = MeshoptSimplifier.simplifyWithAttributes(old, positions, 3, packed, stride, Array(stride).fill(1), locks, target, limit, ['LockBorder', 'ErrorAbsolute', 'Sparse', 'Permissive']);
            if (candidate.length >= old.length || error > limit + 1e-7) {
                receipt.reason = 'no-valid-reduction';
                trial.dispose();
                keep();
                continue;
            }
            const sourceOutline = outline(old, positions), candidateOutline = outline(candidate, positions);
            if (JSON.stringify(candidateOutline) !== JSON.stringify(sourceOutline)) {
                receipt.reason = 'outline-differs';
                receipt.rejection = {
                    sourceEdges: sourceOutline.length, candidateEdges: candidateOutline.length, removed: sourceOutline.filter(e => !candidateOutline.includes(e)).slice(0, 3), added: candidateOutline.filter(e => !sourceOutline.includes(e)).slice(0, 3)
                };
                trial.dispose();
                keep();
                continue;
            }
            const attributeLimit = ground ? .003 : .005, fail = (detail: unknown) => {
                receipt.rejection = detail;
            }, forward = measure(old, candidate, positions, packed, stride, limit, attributeLimit, fail), reverse = forward ? measure(candidate, old, positions, packed, stride, limit, attributeLimit, fail) : null;
            if (!forward || !reverse) {
                receipt.reason = 'surface-or-attributes-unverified';
                trial.dispose();
                keep();
                continue;
            }
            trial.setIndices(doc.createAccessor().setBuffer(doc.getRoot().listBuffers()[0]!).setType('SCALAR').setArray(Uint32Array.from(candidate)));
            compactPrimitive(trial);
            const mesh = n.getMesh()!, order = mesh.listPrimitives();
            for (const item of order)
                mesh.removePrimitive(item);
            for (const item of order)
                mesh.addPrimitive(item === p ? trial : item);
            p.dispose();
            receipt.accepted = true;
            receipt.reason = 'bidirectional-surface-attribute-and-outline-pass';
            receipt.after = candidate.length / 3;
            receipt.measuredErrorMetres = Math.max(forward.maxDistance, reverse.maxDistance);
            receipt.measuredAttributeError = Math.max(forward.maxAttribute, reverse.maxAttribute);
        }
    const beforeTriangles = deliveryGeometryStats(bytes).triangles, afterTriangles = receipts.reduce((s, r) => s + r.after, 0);
    if (afterTriangles >= beforeTriangles * .98)
        return {
            bytes: null, receipts, beforeTriangles, afterTriangles: beforeTriangles, trialAfterTriangles: afterTriangles
        };
    await doc.transform(prune({
        propertyTypes: ['Accessor'], keepAttributes: true, keepLeaves: true
    }));
    doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({
        method: EXTMeshoptCompression.EncoderMethod.QUANTIZE
    });
    const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
        'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder
    }), embedded = await io.writeBinary(doc), reopened = await io.readBinary(embedded);
    assert.deepEqual(reopened.getRoot().listTextures().map(t => sha(t.getImage()!)).sort(), imageHashes, 'Licensed image bytes changed');
    const after = new Map(protectedSemantic(reopened).map(r => [r.key, r]));
    for (const [key, expected] of preserved) {
        const actual = after.get(key);
        assert.ok(actual, `Protected primitive missing:${key}`);
        assert.equal(actual.semantic, expected.semantic, `Protected geometry changed:${key}`);
        assert.deepEqual(actual.matrix, expected.matrix);
    }
    const external = externalizeCellImages(embedded);
    for (const image of external.images)
        assert.ok(imageHashes.includes(image.sha256), 'Unexpected texture emitted');
    const output = compactGlb(external.bytes).bytes;
    assert.equal(deliveryGeometryStats(output).triangles, afterTriangles);
    return {
        bytes: output, receipts, beforeTriangles, afterTriangles, trialAfterTriangles: afterTriangles
    };
}
