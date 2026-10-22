// Fresh, source-pinned mobile world derivative. Unchanged payloads are hard-linked; source trees are never modified.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { parseArgs } from 'node:util';
import { encodeCompactTerrain, encodeTerrain, parseTerrain, validateWorldManifest, type FileRef, type WorldManifest } from '../../packages/world-schema/src/index.ts';
import { decodeDeliverySimulation, deliveryGeometryStats } from './lib/delivery-city-payloads.ts';
import { readFacadeGlb } from './lib/facade-glb.ts';
import { buildMobileCityLod, MOBILE_LOD_MAX_COMPARISONS, MOBILE_LOD_MAX_BIN_REFERENCES } from './lib/mobile-city-lod.ts';
const { values } = parseArgs({
    options: {
        source: {
            type: 'string'
        }, out: {
            type: 'string'
        }, release: {
            type: 'string'
        }, report: {
            type: 'string'
        }, sample: {
            type: 'string'
        }, cells: {
            type: 'string'
        }, 'max-world-bytes': {
            type: 'string'
        }
    }
});
assert.ok(values.source && values.out && values.release && values.report, '--source --out --release --report required');
assert.match(values.release, /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/);
const source = path.resolve(values.source), out = path.resolve(values.out), report = path.resolve(values.report);
assert.ok(source !== out && !out.startsWith(source + path.sep));
assert.ok(!fs.existsSync(out) && !fs.existsSync(report) && !fs.existsSync(report + '.progress.jsonl'), 'Use fresh output and report paths');
const sourceBytes = fs.readFileSync(path.join(source, 'manifest.json')), manifest = JSON.parse(sourceBytes.toString()) as WorldManifest & {
    publicationFiles?: FileRef[];
};
assert.deepEqual(validateWorldManifest(manifest), []);
assert.notEqual(manifest.worldReleaseId, values.release);
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const selectedCells = values.cells ? new Set(values.cells.split(',')) : null;
assert.ok(!selectedCells || (selectedCells.size > 0 && [...selectedCells].every(id => manifest.cells.some(cell => cell.id === id))), 'Every selected cell must exist');
assert.ok(!(selectedCells && values.sample), '--cells and --sample are mutually exclusive');
const producer = {
    builderSha256: sha(fs.readFileSync(new URL(import.meta.url))),
    lodSha256: sha(fs.readFileSync(new URL('./lib/mobile-city-lod.ts', import.meta.url))),
};
const selection = selectedCells ? [...selectedCells].sort() : null;
fs.mkdirSync(path.dirname(report), { recursive: true });
fs.writeFileSync(report + '.progress.jsonl', JSON.stringify({ sourceManifestSha256: sha(sourceBytes), producer, selection, maximumComparisonsPerDirection: MOBILE_LOD_MAX_COMPARISONS, maximumSpatialBinReferences: MOBILE_LOD_MAX_BIN_REFERENCES }) + '\n', { flag: 'wx' });
function target(root: string, name: string) {
    assert.ok(name.split('/').every(p => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(p)), 'Unsafe payload path');
    const file = path.resolve(root, ...name.split('/'));
    assert.ok(file.startsWith(root + path.sep));
    return file;
}
function read(ref: FileRef) {
    const file = target(source, ref.path), stat = fs.lstatSync(file);
    assert.ok(stat.isFile() && !stat.isSymbolicLink());
    const bytes = fs.readFileSync(file);
    assert.equal(bytes.length, ref.bytes, ref.path);
    assert.equal(sha(bytes), ref.sha256, ref.path);
    return bytes;
}
const written = new Map<string, FileRef>();
function write(name: string, bytes: Uint8Array) {
    const ref = {
        path: name, bytes: bytes.length, sha256: sha(bytes)
    }, file = target(out, name);
    fs.mkdirSync(path.dirname(file), {
        recursive: true
    });
    fs.writeFileSync(file, bytes, {
        flag: 'wx'
    });
    written.set(name, ref);
    return ref;
}
const next: any = structuredClone(manifest), terrainBefore = decodeDeliverySimulation(read(manifest.terrain), manifest.terrain), terrain = parseTerrain(terrainBefore), compact = encodeCompactTerrain(terrain), terrainAfter = parseTerrain(compact);
assert.deepEqual(encodeTerrain(terrainAfter), encodeTerrain(terrain), 'Lossless height bits changed');
assert.ok(terrain.heights.every(Number.isFinite), 'Terrain must have only finite physical heights');
const stored = gzipSync(compact, {
    level: 6
}), terrainRef = write(`terrain.mobile.${sha(stored).slice(0, 16)}.bin.gz`, stored);
next.terrain = {
    ...manifest.terrain, ...terrainRef, compression: 'gzip', decodedBytes: compact.length, decodedSha256: sha(compact)
};
const textures = new Map((manifest.sharedTextures ?? []).map(ref => [ref.path, ref])), cells: any[] = [];
const maxWorldBytes = Number(values['max-world-bytes'] ?? 960000000);
assert.ok(Number.isSafeInteger(maxWorldBytes) && maxWorldBytes > 0);
const count = selectedCells?.size ?? (values.sample === undefined ? manifest.cells.length : Number(values.sample));
assert.ok(Number.isSafeInteger(count) && count > 0 && count <= manifest.cells.length);
for (const [index, cell] of manifest.cells.entries()) {
    if (values.sample && index >= count)
        break;
    if (selectedCells && !selectedCells.has(cell.id)) continue;
    const ref = cell.visual.lod1 ?? cell.visual.lod0, bytes = read(ref), raw = readFacadeGlb(bytes), images = new Map<string, Uint8Array>();
    for (const image of raw.json.images ?? []) {
        const uri = (image as any).uri;
        if (!uri)
            continue;
        assert.match(uri, /^\.\.\/textures\/[a-f0-9]{64}\.(?:ktx2|png)$/);
        const texture = textures.get(uri.slice(3));
        assert.ok(texture, 'Every image must remain pinned');
        images.set(uri, read(texture));
    }
    const result = await buildMobileCityLod(bytes, images, cell.boundsXZ);
    let after = ref;
    if (result.bytes && result.bytes.length < ref.bytes * .98)
        after = {
            ...ref, ...write(`cells/${cell.id}.mobile-lod1.${sha(result.bytes).slice(0, 16)}.glb`, result.bytes), ...deliveryGeometryStats(result.bytes)
        };
    cells.push({
        index, cell: cell.id, source: ref, output: after, beforeTriangles: ref.triangles, afterTriangles: after.triangles, trialAfterTriangles: result.trialAfterTriangles, changed: after.path !== ref.path, primitives: result.receipts
    });
    fs.appendFileSync(report + '.progress.jsonl', JSON.stringify(cells.at(-1)) + '\n');
    console.log(`${cells.length}/${count} ${cell.id}: ${ref.triangles} -> ${after.triangles} triangles; ${ref.bytes} -> ${after.bytes} bytes`);
}
next.worldReleaseId = values.release;
next.builtAt = new Date().toISOString();
const collectRefs = (value: any, refs = new Map<string, FileRef>()) => {
    const visit = (v: any): void => {
        if (!v || typeof v !== 'object')
            return;
        if (typeof v.path === 'string' && typeof v.sha256 === 'string' && typeof v.bytes === 'number') {
            const old = refs.get(v.path);
            assert.ok(!old || (old.bytes === v.bytes && old.sha256 === v.sha256));
            refs.set(v.path, v);
        }
        for (const child of Object.values(v))
            visit(child);
    };
    visit(value);
    return refs;
};
// Added medium files must fit Pages alongside the full map. Prefer the greatest real triangle saving per extra byte.
// The source detailed/far tiers and texture resources remain available; no district is dropped to make space.
let reservedBytes = [...collectRefs(next).values()].reduce((s, r) => s + r.bytes, 0) + Buffer.byteLength(JSON.stringify(next)) + 1000000;
let budgetRejected = 0;
for (const cell of cells.filter(c => c.changed).sort((a, b) => (b.beforeTriangles - b.afterTriangles) / b.output.bytes - (a.beforeTriangles - a.afterTriangles) / a.output.bytes || a.index - b.index)) {
    if (reservedBytes + cell.output.bytes <= maxWorldBytes) {
        next.cells[cell.index].visual.lod1 = cell.output;
        reservedBytes += cell.output.bytes;
    }
    else {
        const discarded = cell.output.path;
        assert.ok(written.has(discarded));
        fs.unlinkSync(target(out, discarded));
        written.delete(discarded);
        cell.output = cell.source;
        cell.afterTriangles = cell.beforeTriangles;
        cell.changed = false;
        cell.budgetRejected = true;
        budgetRejected++;
    }
}
const summary = {
    schemaVersion: 1, status: values.sample ? 'SAMPLE_NOT_FOR_PUBLICATION' : 'BUILT_PENDING_RUNTIME_REVIEW', sourceRelease: manifest.worldReleaseId, sourceManifestSha256: sha(sourceBytes), release: values.release, producer, selection, terrain: {
        source: manifest.terrain, output: next.terrain, sourceCanonicalSha256: sha(encodeTerrain(terrain)), outputCanonicalSha256: sha(encodeTerrain(terrainAfter)), float32BitsExact: true, storage: 'Prior-row uint32 subtraction, byte planes, gzip; no quantization', fetchChunking: false
    }, cells: {
        totalWorldCells: manifest.cells.length, processed: cells.length, changed: cells.filter(c => c.changed).length, budgetRejected, beforeTriangles: cells.reduce((s, c) => s + c.beforeTriangles, 0), afterTriangles: cells.reduce((s, c) => s + c.afterTriangles, 0), sourceBytes: cells.reduce((s, c) => s + c.source.bytes, 0), outputBytes: cells.reduce((s, c) => s + c.output.bytes, 0)
    }, policy: {
        maxWorldBytes, maximumComparisonsPerDirection: MOBILE_LOD_MAX_COMPARISONS, maximumSpatialBinReferences: MOBILE_LOD_MAX_BIN_REFERENCES, groundErrorMetres: .01, architectureErrorMetres: .04, groundInterpolatedUvColourError: .003, architectureInterpolatedUvColourError: .005, interpolatedNormalComponentError: .05, measurement: 'Both directions: original/candidate vertices, edge midpoints, triangle centroids; exact zero-area triangles do not define rendered coverage; exceeding offline work budgets retains the original', protected: 'All shared meshes and named entrance/stair/bridge/retaining/curb/tram/hero nodes exact; generic ground steep/sharp crease vertices locked; primitive outlines and cell seams unchanged', collisionAndRoads: 'Exact unchanged stored bytes', textures: 'Same licensed texture bytes and retained UV values; existing lower mip tier unchanged'
    }
};
const publication = write('publication/mobile-delivery.json', Buffer.from(JSON.stringify(summary, null, 2) + '\n'));
next.publicationFiles = [...(next.publicationFiles ?? []), publication];
assert.deepEqual(validateWorldManifest(next), []);
const refs = collectRefs(next);
for (const ref of refs.values())
    if (!written.has(ref.path)) {
        read(ref);
        const file = target(out, ref.path);
        fs.mkdirSync(path.dirname(file), {
            recursive: true
        });
        fs.linkSync(target(source, ref.path), file);
    }
const finalBytes = Buffer.from(JSON.stringify(next, null, 1) + '\n');
fs.writeFileSync(path.join(out, 'manifest.json'), finalBytes, {
    flag: 'wx'
});
assert.equal(sha(fs.readFileSync(path.join(source, 'manifest.json'))), sha(sourceBytes));
const worldBytes = finalBytes.length + [...refs.values()].reduce((s, r) => s + r.bytes, 0);
assert.ok(worldBytes <= maxWorldBytes, `Mobile derivative exceeds its declared world budget:${worldBytes}`);
fs.mkdirSync(path.dirname(report), {
    recursive: true
});
fs.writeFileSync(report, JSON.stringify({
    ...summary, manifestSha256: sha(finalBytes), worldBytes, files: refs.size + 1, detail: cells
}, null, 2) + '\n', {
    flag: 'wx'
});
console.log(JSON.stringify({
    ...summary, worldBytes, manifestSha256: sha(finalBytes)
}));
