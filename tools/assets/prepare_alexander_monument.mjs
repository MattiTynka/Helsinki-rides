// Metre calibration and runtime packing of the user-supplied Alexander II monument.
// Source buffers stay immutable. No scene geometry outside this asset is touched.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression, KHRTextureBasisu } from '@gltf-transform/extensions';
import { MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer';
import { encodeToKTX2 } from 'ktx2-encoder';
import sharp from 'sharp';
import { validateBytes } from 'gltf-validator';
import { parseTerrain, sampleTerrain } from '../../packages/world-schema/src/terrain.ts';

const { values } = parseArgs({ options: Object.fromEntries(['config', 'contract', 'release', 'out'].map(k => [k, { type: 'string' }])) });
for (const k of ['config', 'contract', 'release', 'out']) assert.ok(values[k], `--${k} required`);
assert.ok(!existsSync(values.out), 'Use a fresh output directory');
const sha = b => createHash('sha256').update(b).digest('hex');
const config = JSON.parse(readFileSync(values.config)), contract = JSON.parse(readFileSync(values.contract));
const source = readFileSync(config.source); assert.equal(sha(source), config.sourceSha256);
const manifestBytes = readFileSync(path.join(values.release, 'manifest.json')), manifest = JSON.parse(manifestBytes);
assert.equal(manifest.origin.id, config.originId);
assert.deepEqual(manifest.origin.originProjected.slice(0, 2), config.centreProjectedEN);
const terrainBytes = readFileSync(path.join(values.release, manifest.terrain.path)); assert.equal(sha(terrainBytes), manifest.terrain.sha256);
const terrain = parseTerrain(terrainBytes);
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });
const doc = await io.readBinary(source), root = doc.getRoot();
assert.equal(root.listMeshes().length, 4); assert.equal(root.listMaterials().length, 4);
for (const node of root.listNodes()) assert.deepEqual(node.getWorldMatrix(), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const allPrimitives = root.listMeshes().flatMap(m => m.listPrimitives());
const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
for (const p of allPrimitives) {
  const a = p.getAttribute('POSITION').getArray();
  for (let i = 0; i < a.length; i++) { min[i % 3] = Math.min(min[i % 3], a[i]); max[i % 3] = Math.max(max[i % 3], a[i]); }
}
const scale = config.heightMetres / (max[1] - min[1]);
const granite = allPrimitives.find(p => p.getMaterial().getName() === 'Red Finnish granite'); assert.ok(granite);
const granitePositions = granite.getAttribute('POSITION').getArray();
const bottom = []; for (let i = 0; i < granitePositions.length; i += 3) if (Math.abs(granitePositions[i + 1] - min[1]) < 1e-6) bottom.push([granitePositions[i], granitePositions[i + 2]]);
assert.ok(bottom.length >= 8);
const bx = bottom.map(p => p[0]), bz = bottom.map(p => p[1]);
const centre = [(Math.min(...bx) + Math.max(...bx)) / 2, min[1], (Math.min(...bz) + Math.max(...bz)) / 2];

// Least-squares y=a*x+b*z+c; outside the monument's contaminated survey footprint.
const fitPlane = rows => {
  const a = Array.from({ length: 3 }, () => [0, 0, 0, 0]);
  for (const [x, z, y] of rows) { const v = [x, z, 1]; for (let i = 0; i < 3; i++) { for (let j = 0; j < 3; j++) a[i][j] += v[i] * v[j]; a[i][3] += v[i] * y; } }
  for (let i = 0; i < 3; i++) { const pivot = a[i][i]; assert.ok(Math.abs(pivot) > 1e-9); for (let j = i; j < 4; j++) a[i][j] /= pivot; for (let k = 0; k < 3; k++) if (k !== i) { const q = a[k][i]; for (let j = i; j < 4; j++) a[k][j] -= q * a[i][j]; } }
  return a.map(r => r[3]);
};
let samples = [];
for (let z = -config.groundFit.outerRadius; z <= config.groundFit.outerRadius; z++) for (let x = -config.groundFit.outerRadius; x <= config.groundFit.outerRadius; x++) if (Math.hypot(x, z) >= config.groundFit.innerRadius && Math.hypot(x, z) <= config.groundFit.outerRadius) samples.push([x, z, sampleTerrain(terrain, x, z)]);
const initialCount = samples.length; let plane = fitPlane(samples);
for (let i = 0; i < config.groundFit.passes; i++) { samples = samples.filter(([x, z, y]) => Math.abs(y - plane[0] * x - plane[1] * z - plane[2]) <= config.groundFit.rejectAboveMetres); plane = fitPlane(samples); }
const groundY = plane[2], rms = Math.sqrt(samples.reduce((s, [x, z, y]) => s + (y - plane[0] * x - plane[1] * z - groundY) ** 2, 0) / samples.length);
const outMin = [Infinity, Infinity, Infinity], outMax = [-Infinity, -Infinity, -Infinity];
let triangles = 0;
for (const p of allPrimitives) {
  const a = p.getAttribute('POSITION').getArray(), moved = new Float32Array(a.length);
  for (let i = 0; i < a.length; i += 3) for (let axis = 0; axis < 3; axis++) { const v = (a[i + axis] - centre[axis]) * scale + (axis === 1 ? groundY : 0); moved[i + axis] = v; outMin[axis] = Math.min(outMin[axis], moved[i + axis]); outMax[axis] = Math.max(outMax[axis], moved[i + axis]); }
  p.getAttribute('POSITION').setArray(moved); triangles += p.getIndices().getCount() / 3;
}
assert.ok(triangles <= contract.maximumTriangles);
assert.ok(Math.abs(outMax[1] - outMin[1] - config.heightMetres) < contract.heightToleranceMetres);
const footprint = [...new Map(bottom.map(([x, z]) => { const p = [(x - centre[0]) * scale, (z - centre[2]) * scale]; return [p.map(n => n.toFixed(5)).join(','), p]; })).values()].sort((a, b) => Math.atan2(a[1], a[0]) - Math.atan2(b[1], b[0]));
const placement = { sourceBounds: { min, max }, sourceBaseCentre: centre, scale, headingRadians: 0, groundY, boundsRuntime: { min: outMin, max: outMax }, footprintRuntimeXZ: footprint,
  ground: { fit: 'y=a*x+b*z+c', plane, initialCount, samples: samples.length, rms, contaminatedCentreHeight: sampleTerrain(terrain, 0, 0), requiredCorrection: 'Set authored ground/heightfield inside actual footprint to groundY; feather to unchanged terrain for 1 m outside. Do not snap asset to centre terrain survey bump.' } };
for (const node of root.listNodes()) { node.setExtras({ ...node.getExtras(), scale_status: 'CALIBRATED_METRES', placementId: config.id }); }
root.listScenes()[0].setExtras({ asset_scale_status: 'CALIBRATED_METRES', sourceSha256: config.sourceSha256, heightReference: config.heightReference, runtimeAxes: 'X-east,Y-up,Z-south', placement });
root.getAsset().generator = 'Helsinki Alexander metre adapter';
root.getAsset().copyright = 'User-supplied Alexander-improved.glb; original licensing not supplied. Placement derived from City of Helsinki terrain (CC BY 4.0), height reference HAM.';
mkdirSync(values.out, { recursive: true });
const writeJson = (name, data) => writeFileSync(path.join(values.out, name), JSON.stringify(data, null, 2) + '\n');
const uncompressed = await io.writeBinary(doc); writeFileSync(path.join(values.out, 'alexander-placed-uncompressed.glb'), uncompressed);
const sourceValidation = await validateBytes(source, { uri: config.source }); writeJson('source-gltf-validation.json', sourceValidation); assert.equal(sourceValidation.issues.numErrors, 0);
const uncompressedValidation = await validateBytes(uncompressed, { uri: 'alexander-placed-uncompressed.glb' }); writeJson('uncompressed-gltf-validation.json', uncompressedValidation); assert.equal(uncompressedValidation.issues.numErrors, 0);
// Granite is closed architectural geometry, unlike the retained sculptural fragments.
writeJson('granite-collider.json', { schemaVersion: 1, id: config.id, frame: 'X-east,Y-up,Z-south', positions: Array.from(granite.getAttribute('POSITION').getArray()), indices: Array.from(granite.getIndices().getArray()), note: 'Closed source granite tiers/shaft; do not use open sculpture meshes as collision.', sourceSha256: config.sourceSha256 });

const textures = [], textureUses = new Map();
for (const m of root.listMaterials()) { if (m.getBaseColorTexture()) textureUses.set(m.getBaseColorTexture(), 'baseColor'); if (m.getNormalTexture()) textureUses.set(m.getNormalTexture(), 'normal'); }
for (const texture of root.listTextures()) {
  const use = textureUses.get(texture); assert.ok(use);
  const originalImage = texture.getImage(), meta = await sharp(originalImage).metadata();
  const { data, info } = await sharp(originalImage).resize({ width: config.textureCap, height: config.textureCap, fit: 'inside', withoutEnlargement: true }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const silence = process.stdout.write.bind(process.stdout); let encoded;
  process.stdout.write = () => true;
  try { encoded = await encodeToKTX2(data, { isUASTC: true, generateMipmap: true, isPerceptual: use === 'baseColor', isSetKTX2SRGBTransferFunc: use === 'baseColor', isNormalMap: use === 'normal', needSupercompression: true, uastcLDRQualityLevel: 2, qualityLevel: 255, compressionLevel: 2, imageDecoder: async () => ({ width: info.width, height: info.height, data }) }); }
  finally { process.stdout.write = silence; }
  texture.setImage(encoded).setMimeType('image/ktx2');
  textures.push({ name: texture.getName(), use, sourceDimensions: [meta.width, meta.height], dimensions: [info.width, info.height], bytes: encoded.length, sha256: sha(encoded), residentBytesEstimate: Math.ceil(info.width * info.height * 4 / 3) });
}
doc.createExtension(KHRTextureBasisu).setRequired(true);
await MeshoptEncoder.ready;
doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
const packed = await io.writeBinary(doc); writeFileSync(path.join(values.out, 'alexander-monument.glb'), packed);
const packedValidation = await validateBytes(packed, { uri: 'alexander-monument.glb' }); writeJson('packed-gltf-validation.json', packedValidation); assert.equal(packedValidation.issues.numErrors, 0);
// The official validator cannot decode meshopt. Independently load packed bytes and compare all decoded attributes/indices with the uncompressed metre candidate.
const reopened = await io.readBinary(packed), before = await io.readBinary(uncompressed), a = before.getRoot().listMeshes(), b = reopened.getRoot().listMeshes();
assert.equal(a.length, b.length);
let exactAttributes = 0;
for (let i = 0; i < a.length; i++) for (let j = 0; j < a[i].listPrimitives().length; j++) {
  const p = a[i].listPrimitives()[j], q = b[i].listPrimitives()[j];
  const pi = p.getIndices().getArray(), qi = q.getIndices().getArray();
  assert.equal(pi.length, qi.length);
  // Meshopt's triangle codec can rotate a triangle's starting vertex, preserving its three vertices and winding.
  for (let k = 0; k < pi.length; k += 3) assert.ok([0, 1, 2].some(offset => [0, 1, 2].every(t => qi[k + t] === pi[k + (t + offset) % 3])), `Triangle ${i}/${j}/${k / 3} topology changed`);
  for (const semantic of p.listSemantics()) { assert.ok(Buffer.from(q.getAttribute(semantic).getArray().buffer).equals(Buffer.from(p.getAttribute(semantic).getArray().buffer)), `Attribute ${i}/${j}/${semantic} changed`); exactAttributes++; }
}
assert.ok(packed.length <= contract.maximumBytes); const residentBytesEstimate = textures.reduce((s, t) => s + t.residentBytesEstimate, 0); assert.ok(residentBytesEstimate <= contract.maximumTextureResidentBytes);
writeJson('census-spec.json', contract.census);
writeJson('placement.json', { schemaVersion: 1, id: config.id, source: { path: config.source, sha256: config.sourceSha256 }, originId: config.originId, originProjected: manifest.origin.originProjected, placement, sourceRelease: manifest.worldReleaseId, sourceTerrainSha256: manifest.terrain.sha256, references: [{ url: config.heightReference, fact: '10.67 m total monument height', retrieved: '2026-10-17' }, { file: 'models/Alexander/IMG/Front4.jpg', fact: 'Front faces away from Cathedral; reference only' }], integration: { assetId: config.id, node: root.listScenes()[0].listChildren()[0].getName(), position: [0, 0, 0], yaw: 0, scale: [1, 1, 1], glb: 'alexander-monument.glb', collision: 'granite-collider.json', alreadyRuntimePlaced: true }, limits: config.sourceScope });
writeJson('build-report.json', { status: 'ASSET_READY_RUNTIME_INTEGRATION_PENDING', sourceSha256: config.sourceSha256, configSha256: sha(readFileSync(values.config)), scriptSha256: sha(readFileSync(import.meta.filename)), contractSha256: sha(readFileSync(values.contract)), releaseManifestSha256: sha(manifestBytes), triangles, drawCalls: allPrimitives.length, materials: root.listMaterials().length, textures, residentBytesEstimate, placement, compressionProof: { exactDecodedAttributeArrays: exactAttributes, exactTriangleTopologyAndWinding: true, indexStartingVertexMayRotate: true }, output: { file: 'alexander-monument.glb', bytes: packed.length, sha256: sha(packed) }, uncompressed: { file: 'alexander-placed-uncompressed.glb', bytes: uncompressed.length, sha256: sha(uncompressed) }, validation: { source: sourceValidation.issues, uncompressed: uncompressedValidation.issues, packed: packedValidation.issues } });
console.log(JSON.stringify({ triangles, bytes: packed.length, residentBytesEstimate, placement, packedSha256: sha(packed) }, null, 2));
