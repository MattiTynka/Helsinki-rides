// Texture-only repair over a frozen cell build. Restores original masters and applies only the explicitly
// source-bound facade reconstructions. Experimental repeat erasure is excluded from production exports.
// node tools/world/repair_facades.ts --base FROZEN_CELLS --city-model data/work/m0/citymodel-v2
//   --trees data/work/m0/trees-v1 --config content/helsinki/cells.json --out NEW_DIR
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import sharp from 'sharp';
import { buildAtlases, remapUv, type AtlasInput } from './lib/atlas.ts';
import { encodeKtx2, type RgbaImage } from './lib/gltf.ts';
import { gradeFacade } from './lib/grade.ts';
import { splitBySlope } from './lib/untextured.ts';
import { readFacadeGlb, replaceFacadeImages } from './lib/facade-glb.ts';
import { createFacadeRestorer, facadeRestorationSourceFiles } from './lib/facade-restoration-registry.ts';
import { eraseVegetation, trianglesNearTrees, type PageTriangle, type TreeVolume, type VegetationRepairDiagnostics } from './lib/vegetation.ts';

const { values } = parseArgs({ options: Object.fromEntries(['base', 'city-model', 'trees', 'config', 'out', 'texture-cache', 'pages'].map(k => [k, { type: 'string' as const }])) });
for (const key of ['base', 'city-model', 'trees', 'config', 'out']) if (!values[key]) throw new Error(`--${key} required`);
const option = (key: string) => values[key] as string;
const base = option('base'), out = option('out'), cityDir = option('city-model');
if (existsSync(out)) throw new Error(`${out} exists; use a fresh output directory`);
const readJson = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const indexBytes = readFileSync(path.join(base, 'cells.json')), originalIndex = readJson(path.join(base, 'cells.json'));
const index = structuredClone(originalIndex), report = readJson(path.join(base, 'report.json'));
const cityBytes = readFileSync(path.join(cityDir, 'city-model.json')), city = JSON.parse(cityBytes.toString('utf8'));
const selectedPages = values.pages ? new Set(values.pages.split(',').map(Number)) : null;
if (selectedPages && [...selectedPages].some(p => !Number.isSafeInteger(p) || p < 0 || p >= city.textures.length)) throw new Error('--pages must contain valid source texture indexes');
if (city.binary.sha256 !== report.inputs.cityModelSha256) throw new Error('city model differs from frozen build');
const config = readJson(option('config'));
if (config.cellSize !== index.cellSize) throw new Error('cell size differs from baseline');
if (config.vegetation.mode !== 'restore-original') throw new Error('production texture-only export requires restore-original vegetation mode');
assert.deepEqual(config.facadeGrade, report.facadeGrade, 'facade grade must remain the frozen grade');
const binary = readFileSync(path.join(cityDir, city.binary.file));
if (sha(binary) !== city.binary.sha256) throw new Error('city binary hash mismatch');
const array = (slice: { offset: number; bytes: number }, indices = false) => {
  const data = binary.buffer.slice(binary.byteOffset + slice.offset, binary.byteOffset + slice.offset + slice.bytes);
  return indices ? new Uint32Array(data) : new Float32Array(data);
};
const treeDocument = readJson(path.join(option('trees'), 'trees.json'));
if (treeDocument.originId !== index.originId) throw new Error('tree/cell origin differs');
if (report.inputs.trees && sha(readFileSync(path.join(option('trees'), 'trees.json'))) !== report.inputs.trees) throw new Error('tree input differs from frozen build');
const trees: TreeVolume[] = treeDocument.trees.map((t: { position: number[]; crownRadius: number; height: number }) => ({ x: t.position[0]!, z: t.position[2]!, radius: t.crownRadius, base: t.position[1]!, top: t.position[1]! + t.height }));
const buildings = new Map<string, { texture: number | null; positions: Float32Array; uvs: Float32Array; indices: Uint32Array }[]>();
const nearPages = new Map<number, { tri: PageTriangle; trees: TreeVolume[] }[]>();
for (const building of city.buildings) {
  const parts = building.parts.map((p: { texture: number | null; positions: { offset: number; bytes: number }; uvs: { offset: number; bytes: number }; indices: { offset: number; bytes: number } }) => {
    const positions = array(p.positions) as Float32Array, uvs = array(p.uvs) as Float32Array, indices = array(p.indices, true) as Uint32Array;
    for (let i = 0; i < positions.length; i += 3) { const north = positions[i + 1]!; positions[i + 1] = positions[i + 2]!; positions[i + 2] = -north; }
    for (let i = 1; i < uvs.length; i += 2) uvs[i] = 1 - uvs[i]!;
    if (p.texture !== null) {
      const near = trianglesNearTrees(positions, uvs, indices, trees, config.vegetation);
      nearPages.set(p.texture, [...(nearPages.get(p.texture) ?? []), ...near]);
    }
    return { texture: p.texture, positions, uvs, indices };
  });
  buildings.set(building.id, parts);
}
const hiRes = new Set<number>(report.hiResFacadePages.map((p: { texture: number }) => p.texture));
const solid = (rgb: number[], size: number): RgbaImage => { const data = new Uint8Array(size * size * 4).fill(255); for (let i = 0; i < data.length; i += 4) data.set(rgb, i); return { width: size, height: size, data }; };
const solidImages = new Map([['wall', solid(config.untextured.wall, config.untextured.tileSize)], ['roof', solid(config.untextured.roof, config.untextured.tileSize)]]);
const pageEvidence = new Map<string, unknown>(), masterHashes = new Map<number, string>();
const restoration = await createFacadeRestorer(cityDir, city.textures);
const prepared = new Map<string, Uint8Array>();
const prepare = async (rgba: Uint8Array, w: number, h: number, id: string) => {
  const cacheKey = `${id}:${w}x${h}`;
  if (prepared.has(cacheKey)) return prepared.get(cacheKey)!;
  const match = /^t(\d+)$/.exec(id);
  if (match) {
    const page = Number(match[1]), texture = city.textures[page];
    const master = readFileSync(path.join(cityDir, texture.file)), masterSha256 = sha(master);
    masterHashes.set(page, masterSha256);
    const diagnostics: VegetationRepairDiagnostics = { candidates: 0, changed: 0, decisions: [] };
    eraseVegetation(rgba, w, h, nearPages.get(page) ?? [], config.vegetation, diagnostics);
    const curated = restoration.apply(page, rgba, w, h);
    pageEvidence.set(cacheKey, { page, file: texture.file, masterSha256, size: [w, h], diagnostics, curated });
  }
  const result = await gradeFacade(rgba, w, h, config.facadeGrade);
  prepared.set(cacheKey, result); return result;
};
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
// Existing collision, scenery and runtime terrain files are copied verbatim. Only visual GLB image ranges vary.
cpSync(base, out, { recursive: true, force: false, errorOnExist: true });
const textureCache = values['texture-cache'];
if (textureCache) mkdirSync(textureCache, { recursive: true });
const encoderSourceSha256 = sha(readFileSync('tools/world/lib/gltf.ts'));
const encodedTextures = new Map<string, Uint8Array>();
const preservation = [];
const atlasIdentity: { cell: string; image: string; beforeSha256: string; afterSha256: string; byteExactReuse: boolean }[] = [];
let byteDelta = 0, textureDelta = 0;
for (const cell of index.cells) {
  // Derived colour/geometry tiers must be regenerated from the repaired detailed
  // cells; carrying their previous descriptors would silently show old facades.
  delete cell.visual.lod1;
  delete cell.visual.lod2;
  const file = path.join(base, cell.visual.lod0.path), bytes = readFileSync(file);
  if (sha(bytes) !== cell.visual.lod0.sha256) throw new Error(`${cell.id}: baseline GLB hash mismatch`);
  const raw = readFacadeGlb(bytes), used = new Set<number | string>();
  const sourceParts: { texture: number; positions: Float32Array; uvs: Float32Array; indices: Uint32Array }[] = [];
  for (const record of cell.buildings) {
    if (record.landmark) continue;
    const parts = buildings.get(record.id); if (!parts) throw new Error(`missing original building ${record.id}`);
    for (const part of parts) {
      if (part.texture !== null) { used.add(part.texture); sourceParts.push(part as typeof sourceParts[number]); }
      else {
        const slope = splitBySlope(part.positions, part.indices, config.untextured.wallMaxNormalY);
        if (slope.wall.length) used.add('wall'); if (slope.roof.length) used.add('roof');
      }
    }
  }
  if (selectedPages && ![...used].some(p => typeof p === 'number' && selectedPages.has(p))) {
    const collision = readFileSync(path.join(base, cell.collision.path));
    assert.equal(sha(collision), cell.collision.sha256);
    assert.deepEqual(readFileSync(path.join(out, cell.collision.path)), collision);
    preservation.push({ cell: cell.id, beforeGlbSha256: sha(bytes), afterGlbSha256: sha(bytes), facadeImages: 0, sourceCornerUvChecks: 0, nonImageSemanticsAndPayloads: 'PASS original file byte exact', collisionSha256: sha(collision) });
    continue;
  }
  const inputs: AtlasInput[] = [...used].map(t => {
    if (typeof t === 'string') { const image = solidImages.get(t)!; return { id: `t${t}`, image, width: image.width, height: image.height, cap: image.width }; }
    const image = city.textures[t]; return { id: `t${t}`, file: path.join(cityDir, image.file), width: image.width, height: image.height, cap: hiRes.has(t) ? config.texelCap.facadeHiRes : config.texelCap.facade };
  });
  const atlas = inputs.length ? await buildAtlases(inputs, config.atlasSize, prepare) : null;
  const doc = await io.readBinary(bytes), root = doc.getRoot();
  const facadeNodes = root.listNodes().filter(n => /_facades_\d+$/.test(n.getName()));
  if (facadeNodes.length !== (atlas?.atlases.length ?? 0)) throw new Error(`${cell.id}: reconstructed atlas count differs`);
  const replacements = new Map<number, Uint8Array>();
  let vertexChecks = 0, cellTextureDelta = 0;
  if (atlas) for (const [ai, image] of atlas.atlases.entries()) {
    const node = facadeNodes.find(n => n.getName() === `${cell.id}_facades_${ai}`);
    if (!node) throw new Error(`${cell.id}: facade node${ai} missing`);
    const material = node.getMesh()!.listPrimitives()[0]!.getMaterial()!, texture = material.getBaseColorTexture()!;
    const imageIndex = raw.json.images?.findIndex(t => t.name === texture.getName()) ?? -1;
    if (imageIndex < 0) throw new Error(`${cell.id}: missing named facade image`);
    const oldImage = texture.getImage()!, oldHeader = new DataView(oldImage.buffer, oldImage.byteOffset, oldImage.byteLength);
    if (oldHeader.getUint32(20, true) !== image.width || oldHeader.getUint32(24, true) !== image.height) throw new Error(`${cell.id}: atlas${ai} dimensions differ`);
    // Confirm each original textured corner's position AND remapped UV in the actual frozen geometry. This
    // catches a plausible-looking but differently ordered atlas reconstruction before replacing any image.
    const vertices = new Map<string, { p: number[]; u: number; v: number }[]>(), matrix = node.getWorldMatrix();
    const key = (p: number[]) => p.map(v => Math.floor(v / 0.05)).join(',');
    for (const primitive of node.getMesh()!.listPrimitives()) {
      const positions = primitive.getAttribute('POSITION')!, uv = primitive.getAttribute('TEXCOORD_0')!;
      for (let i = 0; i < positions.getCount(); i++) {
        const p: number[] = []; positions.getElement(i, p);
        const world = [0, 1, 2].map(k => matrix[k]! * p[0]! + matrix[4 + k]! * p[1]! + matrix[8 + k]! * p[2]! + matrix[12 + k]!);
        const tex: number[] = []; uv.getElement(i, tex); const k = key(world), entry = vertices.get(k) ?? []; entry.push({ p: world, u: tex[0]!, v: tex[1]! }); vertices.set(k, entry);
      }
    }
    for (const part of sourceParts) {
      const placement = atlas.placements.get(`t${part.texture}`)!; if (placement.atlas !== ai) continue;
      for (const i of new Set(part.indices)) {
        const p = [...part.positions.subarray(i * 3, i * 3 + 3)], expected = remapUv(placement, image.width, image.height, part.uvs[i * 2]!, part.uvs[i * 2 + 1]!);
        let found = false;
        for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) {
          const entries = vertices.get([Math.floor(p[0]! / .05) + x, Math.floor(p[1]! / .05) + y, Math.floor(p[2]! / .05) + z].join(',')) ?? [];
          if (entries.some(v => Math.hypot(v.p[0]! - p[0]!, v.p[1]! - p[1]!, v.p[2]! - p[2]!) < .03 && Math.abs(v.u - expected[0]) < .0006 && Math.abs(v.v - expected[1]) < .0006)) found = true;
        }
        if (!found) throw new Error(`${cell.id}: reconstructed atlas UV mismatch for page${part.texture}, source vertex${i}`);
        vertexChecks++;
      }
    }
    const cacheKey = sha(JSON.stringify([image.width, image.height, encoderSourceSha256, sha(image.data)]));
    let encoded = encodedTextures.get(cacheKey);
    const cacheFile = textureCache ? path.join(textureCache, `${cacheKey}.ktx2`) : null;
    if (!encoded && cacheFile && existsSync(cacheFile)) {
      encoded = readFileSync(cacheFile);
      const receipt = readJson(`${cacheFile}.json`);
      if (receipt.sha256 !== sha(encoded) || receipt.rawRgbaSha256 !== sha(image.data)) throw new Error('cached atlas receipt/hash mismatch');
    }
    if (!encoded) {
      encoded = await encodeKtx2(image, 'facade');
      if (cacheFile) { writeFileSync(cacheFile, encoded); writeFileSync(`${cacheFile}.json`, JSON.stringify({ sha256: sha(encoded), rawRgbaSha256: sha(image.data), width: image.width, height: image.height, encoderSourceSha256 }) + '\n'); }
    }
    encodedTextures.set(cacheKey, encoded);
    atlasIdentity.push({ cell: cell.id, image: texture.getName(), beforeSha256: sha(oldImage), afterSha256: sha(encoded), byteExactReuse: Buffer.from(oldImage).equals(encoded) });
    replacements.set(imageIndex, encoded); cellTextureDelta += encoded.length - oldImage.length;
  }
  const repaired = replacements.size ? replaceFacadeImages(bytes, replacements) : bytes;
  writeFileSync(path.join(out, cell.visual.lod0.path), repaired);
  byteDelta += repaired.byteLength - bytes.byteLength;
  textureDelta += cellTextureDelta;
  cell.visual.lod0.bytes = repaired.byteLength; cell.visual.lod0.sha256 = sha(repaired);
  const collision = readFileSync(path.join(base, cell.collision.path));
  assert.equal(sha(collision), cell.collision.sha256); assert.deepEqual(readFileSync(path.join(out, cell.collision.path)), collision);
  const measured = report.cells.find((r: { cell: string }) => r.cell === cell.id);
  if (measured) {
    measured.glbBytes = repaired.byteLength;
    if (typeof measured.ktx2Bytes === 'number') measured.ktx2Bytes += cellTextureDelta;
  }
  preservation.push({ cell: cell.id, beforeGlbSha256: sha(bytes), afterGlbSha256: sha(repaired), facadeImages: replacements.size, sourceCornerUvChecks: vertexChecks, nonImageSemanticsAndPayloads: 'PASS exact', collisionSha256: sha(collision) });
  console.log(`${cell.id}: ${replacements.size} facade atlas images; ${vertexChecks} corner/UV checks; geometry/collision exact`);
}
if (typeof report.totals.glbBytes === 'number') report.totals.glbBytes += byteDelta;
if (typeof report.totals.ktx2Bytes === 'number') report.totals.ktx2Bytes += textureDelta;
report.vegetation = { options: config.vegetation, pages: [...pageEvidence.values()], note: config.vegetationNote };
report.facadeRepair = { status: 'EXPORTED_REQUIRES_RUNTIME_REVIEW', method: 'texture-only original master restoration and source-bound architectural reconstruction; automatic erasure disabled', base: path.resolve(base), baseIndexSha256: sha(indexBytes),
  selectedPages: selectedPages ? [...selectedPages] : 'all', derivedLods: 'Invalidated; regenerate from this repaired detailed build before streaming publication',
  source: { cityModelSha256: sha(cityBytes), configSha256: sha(readFileSync(option('config'))), treesSha256: sha(readFileSync(path.join(option('trees'), 'trees.json'))), masterHashes: Object.fromEntries(masterHashes) },
  curated: { modules: restoration.modules, inputs: restoration.inputs, externalInputs: restoration.externalInputs, supportInputs: restoration.supportInputs, sourceSha256: Object.fromEntries(facadeRestorationSourceFiles.map(file => [file, sha(readFileSync(file))])) },
  preservation, unchanged: ['all geometry/accessor/compression bytes and non-image JSON semantics', 'all collision files', 'runtime-terrain.bin', 'scenery.json'],
  limits: 'Only named, reviewed architectural charts are reconstructed; other regions retain original photographed foliage. Donors can have different baked cast shadows; actual post-grade runtime review required. No character/scenery asset payloads are regenerated.' };
for (const file of ['runtime-terrain.bin', 'scenery.json']) if (existsSync(path.join(base, file))) assert.deepEqual(readFileSync(path.join(out, file)), readFileSync(path.join(base, file)));
writeFileSync(path.join(out, 'cells.json'), JSON.stringify(index, null, 1) + '\n');
writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 1) + '\n');
copyFileSync(option('config'), path.join(out, 'facade-repair-config.json'));
writeFileSync(path.join(out, 'preservation.json'), JSON.stringify({ status: 'PASS', candidateIndexSha256: sha(readFileSync(path.join(out, 'cells.json'))), reportSha256: sha(readFileSync(path.join(out, 'report.json'))),
  method: 'Native texture-only export verification; every nonimage semantic/payload and collision preserved', cells: preservation }, null, 2) + '\n');
writeFileSync(path.join(out, 'atlas-reuse.json'), JSON.stringify({ status: 'PASS_RANGE_IDENTITY_MEASURED', base: path.resolve(base), baseIndexSha256: sha(indexBytes), candidateIndexSha256: sha(readFileSync(path.join(out, 'cells.json'))),
  atlasCount: atlasIdentity.length, unchangedAtlasCount: atlasIdentity.filter(i => i.byteExactReuse).length, changedAtlasCount: atlasIdentity.filter(i => !i.byteExactReuse).length,
  method: 'Original and replacement embedded facade image bytes compared during native texture-only export', images: atlasIdentity }, null, 2) + '\n');
const identityFiles = [...facadeRestorationSourceFiles, 'tools/world/repair_facades.ts', 'tools/world/lib/atlas.ts', 'tools/world/lib/gltf.ts', 'tools/world/lib/grade.ts', 'tools/world/lib/vegetation.ts', 'tools/world/lib/facade-glb.ts', 'tools/world/lib/untextured.ts', option('config')];
// The base may itself contain a historical identity sidecar; replace it with this export's actual inputs.
writeFileSync(path.join(out, 'source-identity.json'), JSON.stringify({ status: 'EXPORTED_RUNTIME_REVIEW_PENDING', base: path.resolve(base), baseIndexSha256: sha(indexBytes),
  indexSha256: sha(readFileSync(path.join(out, 'cells.json'))), reportSha256: sha(readFileSync(path.join(out, 'report.json'))),
  sourceSha256: Object.fromEntries(identityFiles.map(file => [file, sha(readFileSync(file))])), masters: restoration.inputs, externalInputs: restoration.externalInputs, supportInputs: restoration.supportInputs,
  verification: 'This sidecar binds export inputs and preservation; source test and runtime review results are recorded separately.', preservation }, null, 2) + '\n');
console.log(`Frozen texture-only candidate: ${out}; ${preservation.length} cells; byte delta${byteDelta}`);
