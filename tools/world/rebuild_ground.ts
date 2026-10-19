// Replace authored ground while preserving the existing building meshes, facade textures, and non-ground
// colliders. This repair route uses the same ground assembly as build_cells; it never reruns facade processing.
// node tools/world/rebuild_ground.ts --base data/work/m0/cells-v14 --terrain data/work/m0/terrain-v2
//   --footprints data/raw/helsinki-building-register/senate-district.geojson
//   --street-parts data/raw/helsinki-street-parts/senate-district.geojson --osm-ledger data/raw/osm/ledger.json
//   --osm-snapshot senate-district --config content/helsinki/cells.json --origin content/helsinki/world-origin.json --out NEW_DIR
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { serialize, deserialize } from 'node:v8';
import { NodeIO, type Document } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression } from '@gltf-transform/extensions';
import { mergeDocuments, prune, unpartition } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import { encodeCollisionBundle, encodeTerrain, parseCollisionBundle, parseTerrain, type CellDescriptor, type TriMeshCollider } from '../../packages/world-schema/src/index.ts';
import { buildDistrictGround, type CachedGroundAssembly, type GroundAssemblyCache } from './lib/district-ground.ts';
import { loadGeoJsonPolygons } from './lib/geometry.ts';
import { flatNormals, GlbBuilder } from './lib/gltf.ts';
import { type Finish, type GroundPiece } from './lib/ground.ts';
import { groundTexture } from './lib/textures.ts';
import { createGroundSupportSampler } from './lib/carriageway-grade.ts';
import { buildFoundationClosure, foundationMaterial, type FoundationRepair } from './lib/foundation-closure.ts';

const { values } = parseArgs({ options: Object.fromEntries([
  'base', 'terrain', 'footprints', 'street-parts', 'osm-ledger', 'osm-snapshot', 'config', 'origin', 'out', 'foundation-repairs', 'ground-cache', 'coastal-diagnostics',
].map(k => [k, { type: 'string' as const }])) });
for (const k of ['base', 'terrain', 'footprints', 'street-parts', 'osm-ledger', 'osm-snapshot', 'config', 'origin', 'out']) {
  if (!values[k]) throw new Error(`--${k} is required`);
}
const option = (k: string) => values[k] as string;
const out = option('out'), base = option('base');
if (existsSync(out)) throw new Error(`${out} exists; use a new output directory`);
const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const origin = readJson(option('origin'));
const config = readJson(option('config'));
const baseIndex = readJson(path.join(base, 'cells.json')) as { originId: string; cellSize: number; cells: CellDescriptor[] };
const baseReport = readJson(path.join(base, 'report.json'));
const foundationSpec = values['foundation-repairs'] ? readJson(values['foundation-repairs']) as {
  schemaVersion: number; baseCellsIndexSha256: string; sourceProofs: {path:string; sha256:string}[]; repairs: FoundationRepair[];
} : null;
if (foundationSpec) {
  assert.equal(foundationSpec.schemaVersion, 1);
  assert.equal(foundationSpec.baseCellsIndexSha256, sha(readFileSync(path.join(base, 'cells.json'))));
  assert.ok(Array.isArray(foundationSpec.sourceProofs) && foundationSpec.sourceProofs.length >= 2);
  for (const proof of foundationSpec.sourceProofs) assert.equal(sha(readFileSync(proof.path)), proof.sha256, `Changed foundation source proof: ${proof.path}`);
  assert.ok(Array.isArray(foundationSpec.repairs) && foundationSpec.repairs.length > 0 && foundationSpec.repairs.length <= 100);
  for (const repair of foundationSpec.repairs) {
    const cell = baseIndex.cells.find(c => c.id === repair.cell);
    assert.ok(cell?.buildings.some(b => b.id === repair.building && b.vtj === repair.vtj), 'Foundation repair must identify a source building in its exact frozen cell');
    assert.ok(typeof repair.reason === 'string' && repair.reason.length > 0);
    for (let i = 0; i <= 100; i++) {
      const [a,b] = repair.edgeRuntime, x = a[0] + (b[0] - a[0]) * i / 100, z = a[2] + (b[2] - a[2]) * i / 100;
      assert.ok(!(x >= -800 && x <= 150 && z >= -450 && z <= 350), 'Foundation repair must leave the accepted district intact');
    }
  }
}
const terrainMeta = readJson(path.join(option('terrain'), 'terrain.json'));
const terrainBytes = readFileSync(path.join(option('terrain'), terrainMeta.file));
if (sha(terrainBytes) !== terrainMeta.sha256 || baseReport.inputs.terrainSha256 !== terrainMeta.sha256) throw new Error('terrain does not match baseline build');
if (baseIndex.originId !== origin.id || baseIndex.cellSize !== config.cellSize) throw new Error('origin/cell size does not match baseline');
for (const [input, key] of [['footprints', 'footprints'], ['street-parts', 'streetParts']] as const) {
  if (sha(readFileSync(option(input))) !== baseReport.inputs[key]) throw new Error(`${input} does not match baseline`);
}
const terrain = parseTerrain(terrainBytes);
const footprints = loadGeoJsonPolygons(option('footprints'), origin.originProjected[0], origin.originProjected[1], (p, i) => String(p['vtj_prt'] ?? `register-${p['id'] ?? i}`));
let cacheAudit: Record<string, unknown> | null = null;
let groundCache: GroundAssemblyCache | undefined;
if (values['ground-cache']) {
  const cacheRoot = path.resolve(values['ground-cache']);
  assert.ok(cacheRoot.startsWith(path.resolve('data/work') + path.sep), 'Ground cache must stay inside data/work');
  mkdirSync(cacheRoot,{recursive:true});
  groundCache = {
    read(fingerprint) {
      assert.match(fingerprint,/^[a-f0-9]{64}$/);
      const metadataPath = path.join(cacheRoot,`${fingerprint}.json`);
      if (!existsSync(metadataPath)) return null;
      const metadata = readJson(metadataPath);
      assert.equal(metadata.schemaVersion,1); assert.equal(metadata.fingerprint,fingerprint);
      assert.match(metadata.path,/^[a-f0-9]{64}\.bin$/);
      const bytes = readFileSync(path.join(cacheRoot,metadata.path));
      assert.equal(bytes.length,metadata.bytes); assert.equal(sha(bytes),metadata.sha256);
      const cached = deserialize(bytes) as CachedGroundAssembly;
      assert.ok(Array.isArray(cached.ground?.pieces) && Array.isArray(cached.ground?.kerbs) && cached.ground.stats && 'carriagewayGrade' in cached);
      cacheAudit = {...metadata,status:'HIT',metadataSha256:sha(readFileSync(metadataPath))};
      return cached;
    },
    write(fingerprint,value) {
      const bytes = serialize(value), digest = sha(bytes), file = `${digest}.bin`, binaryPath = path.join(cacheRoot,file);
      if (existsSync(binaryPath)) assert.equal(sha(readFileSync(binaryPath)),digest);
      else writeFileSync(binaryPath,bytes,{flag:'wx'});
      const metadata = {schemaVersion:1,fingerprint,path:file,sha256:digest,bytes:bytes.length,
        method:'V8 serialization of exact authored ground and grade statistics before coastal clipping; all authoring sources and inputs fingerprinted'};
      const metadataPath = path.join(cacheRoot,`${fingerprint}.json`);
      writeFileSync(metadataPath,JSON.stringify(metadata,null,2)+'\n',{flag:'wx'});
      cacheAudit = {...metadata,status:'CREATED',metadataSha256:sha(readFileSync(metadataPath))};
    },
  };
}
const coastalDiagnostics = values['coastal-diagnostics'] ? path.resolve(values['coastal-diagnostics']) : null;
if (coastalDiagnostics) {
  assert.ok(coastalDiagnostics.startsWith(path.resolve('data/evidence') + path.sep), 'Coastal diagnostics must stay inside data/evidence');
  assert.ok(!existsSync(coastalDiagnostics),'Use a fresh coastal diagnostics directory'); mkdirSync(coastalDiagnostics,{recursive:true});
}
let retryWitnesses = 0;
let built: ReturnType<typeof buildDistrictGround>;
try {
  built = buildDistrictGround({ terrain, footprints, originProjected: origin.originProjected, config, groundCache,
    osmLedger: option('osm-ledger'), osmSnapshot: option('osm-snapshot'), streetParts: option('street-parts'), log: console.log,
    onCoastalRetry: witness => {
      retryWitnesses++;
      if (coastalDiagnostics) writeFileSync(path.join(coastalDiagnostics,`retry-${String(retryWitnesses).padStart(4,'0')}.json`),JSON.stringify(witness,null,2)+'\n',{flag:'wx'});
      console.log(`coastal precision retry ${retryWitnesses}: exact input witness captured`);
    } });
} catch (error) {
  if (coastalDiagnostics) writeFileSync(path.join(coastalDiagnostics,'failure.json'),JSON.stringify({error:String(error),details:(error as {details?:unknown}).details??null},null,2)+'\n',{flag:'wx'});
  throw error;
}
const { ground, stairs, terraces, walls, register, conflicting } = built;
if (built.osmSnap.sha256 !== baseReport.inputs.osm.sha256) throw new Error('OSM snapshot does not match baseline');
const cellIds = new Set(baseIndex.cells.map(c => c.id));
for (const p of [...ground.pieces, ...ground.kerbs]) if (!cellIds.has(p.cell)) throw new Error(`ground extends outside baseline cells: ${p.cell}`);

await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready]);
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
const groundName = (name: string) => /_ground_/.test(name);
// Digest the actual decoded building attributes, placement and embedded images before and after serialization.
function buildingIdentity(doc: Document): string {
  const h = createHash('sha256');
  for (const node of doc.getRoot().listNodes().filter(n => n.getMesh() && !groundName(n.getName())).sort((a, b) => a.getName().localeCompare(b.getName()))) {
    h.update(JSON.stringify([node.getName(), node.getWorldMatrix()]));
    for (const p of node.getMesh()!.listPrimitives()) {
      for (const semantic of p.listSemantics().sort()) {
        const a = p.getAttribute(semantic)!; h.update(JSON.stringify([semantic, a.getType(), a.getNormalized()]));
        const data = a.getArray()!; h.update(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      }
      const ix = p.getIndices()?.getArray(); if (ix) h.update(new Uint8Array(ix.buffer, ix.byteOffset, ix.byteLength));
      const m = p.getMaterial();
      h.update(JSON.stringify(m ? [m.getName(), m.getBaseColorFactor(), m.getMetallicFactor(), m.getRoughnessFactor(), m.getAlphaMode(), m.getDoubleSided(), m.getExtras(), m.listExtensions().map(e => e.extensionName)] : null));
      const image = m?.getBaseColorTexture()?.getImage(); if (image) h.update(image);
    }
  }
  return h.digest('hex');
}
mkdirSync(path.join(out, 'visual'), { recursive: true });
mkdirSync(path.join(out, 'collision'), { recursive: true });
const cells: CellDescriptor[] = [];
const preservation: { cell: string; buildingsSha256: string; nonGroundColliders: number }[] = [];
const textures = new Map<string, { bytes: number; texels: number; resident: number }>();
const groundSupport = foundationSpec ? createGroundSupportSampler([...ground.pieces, ...ground.kerbs]) : null;
const foundationAudits: ReturnType<typeof buildFoundationClosure>['audit'][] = [];
let totalDrawCalls = 0, totalTextureBytes = 0, totalTextureTexels = 0;
for (const cell of baseIndex.cells) {
  const visualBytes = readFileSync(path.join(base, cell.visual.lod0.path));
  const collisionBytes = readFileSync(path.join(base, cell.collision.path));
  if (sha(visualBytes) !== cell.visual.lod0.sha256 || sha(collisionBytes) !== cell.collision.sha256) throw new Error(`${cell.id}: baseline payload hash mismatch`);
  const doc = await io.readBinary(visualBytes), identity = buildingIdentity(doc);
  const scene = doc.getRoot().listScenes()[0]!;
  for (const node of doc.getRoot().listNodes()) if (groundName(node.getName())) node.dispose();
  await doc.transform(prune());
  const original = parseCollisionBundle(collisionBytes);
  const surfaceTags = [...original.header.surfaceTags];
  const tag = (name: string) => { let index = surfaceTags.indexOf(name); if (index < 0) { index = surfaceTags.length; surfaceTags.push(name); } return index; };
  const colliders: TriMeshCollider[] = original.colliders.filter(c => c.group !== 'ground' && c.group !== 'kerbs');
  const gPos: number[] = [], gIdx: number[] = [], gTags: number[] = [];
  const finishes = new Map<Finish, { positions: number[]; uvs: number[]; indices: number[] }>();
  const add = (p: GroundPiece) => {
    if (p.use !== 'collision') {
      let m = finishes.get(p.finish); if (!m) { m = { positions: [], uvs: [], indices: [] }; finishes.set(p.finish, m); }
      // Separate triangle corners for crisp stair risers and flat shading, as in the full builder.
      for (const i of p.indices) { m.indices.push(m.positions.length / 3); m.positions.push(...p.positions.slice(i * 3, i * 3 + 3)); m.uvs.push(...p.uvs.slice(i * 2, i * 2 + 2)); }
    }
    if (p.use !== 'visual') {
      const offset = gPos.length / 3;
      for (const v of p.positions) gPos.push(v);
      for (const i of p.indices) gIdx.push(offset + i);
      for (let t = 0; t < p.indices.length; t += 3) gTags.push(tag(p.tag));
    }
  };
  for (const p of [...ground.pieces, ...ground.kerbs]) if (p.cell === cell.id) add(p);
  const builder = new GlbBuilder(cell.id);
  for (const [finish, m] of finishes) {
    const positions = Float32Array.from(m.positions), indices = Uint32Array.from(m.indices);
    await builder.addMesh({ name: `${cell.id}_ground_${finish}`, positions, indices, normals: flatNormals(positions, indices), uvs: Float32Array.from(m.uvs), materialName: `ground_${finish}` },
      { name: `${cell.id}_ground_${finish}`, texture: groundTexture(finish, config.groundTextureSize), textureKind: 'roof', unlit: false, roughness: 1 });
  }
  // Every finish shares one position grid. Per-mesh grids round matching stair/wall/yard edges differently,
  // opening bright cracks even when the authored floating-point vertices are identical.
  const groundDoc = await io.readBinary(await builder.toGlb(config.copyright, undefined, 'exact'));
  const map = mergeDocuments(doc, groundDoc);
  const importedScene = map.get(groundDoc.getRoot().listScenes()[0]!)! as typeof scene;
  for (const node of importedScene.listChildren()) scene.addChild(node);
  importedScene.dispose();
  for (const repair of foundationSpec?.repairs.filter(r => r.cell === cell.id) ?? []) {
    const material = foundationMaterial(doc, repair), closure = buildFoundationClosure(repair, (x,z) => groundSupport!(x,z)?.height ?? null);
    // A selected source gap can already be closed by the final adjacent grade.
    // In that case record zero work rather than adding a hidden duplicate face.
    if (!closure.indices.length) { foundationAudits.push(closure.audit); continue; }
    const buffer = doc.getRoot().listBuffers()[0]!, positions = Float32Array.from(closure.positions), indices = Uint32Array.from(closure.indices);
    const primitive = doc.createPrimitive().setMaterial(material)
      .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(positions).setBuffer(buffer))
      .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(Float32Array.from(flatNormals(positions, indices))).setBuffer(buffer))
      .setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(Float32Array.from(closure.uvs)).setBuffer(buffer))
      .setIndices(doc.createAccessor().setType('SCALAR').setArray(indices).setBuffer(buffer));
    const mesh = doc.createMesh(`${cell.id}_ground_foundation_${foundationAudits.length}`).addPrimitive(primitive);
    scene.addChild(doc.createNode(mesh.getName()).setMesh(mesh));
    const offset = gPos.length / 3;
    for (const v of closure.positions) gPos.push(v);
    for (const i of closure.indices) gIdx.push(offset + i);
    for (let i = 0; i < closure.indices.length; i += 3) gTags.push(tag('building:foundation'));
    foundationAudits.push(closure.audit);
  }
  await doc.transform(unpartition(), prune());
  // A second octahedral normal filter changes the preserved landmark normals. Encode existing accessor
  // values directly; do not run a second quantization or filtering pass over the building meshes.
  doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
  const bytes = await io.writeBinary(doc);
  const decoded = await io.readBinary(bytes);
  if (buildingIdentity(decoded) !== identity) throw new Error(`${cell.id}: building content changed during ground-only rebuild`);
  colliders.push({ id: `g:${cell.id}`, group: 'ground', ref: null, positions: Float32Array.from(gPos), indices: Uint32Array.from(gIdx), triangleTags: Uint16Array.from(gTags) });
  const col = encodeCollisionBundle({ originId: origin.id, frame: 'X-east,Y-up,Z-south', cell: cell.id, surfaceTags }, colliders);
  const check = parseCollisionBundle(col);
  for (const before of original.colliders.filter(c => c.group !== 'ground' && c.group !== 'kerbs')) {
    const after = check.colliders.find(c => c.id === before.id)!;
    for (const field of ['positions', 'indices', 'triangleTags'] as const) {
      const a = before[field], b = after[field];
      if (sha(new Uint8Array(a.buffer, a.byteOffset, a.byteLength)) !== sha(new Uint8Array(b.buffer, b.byteOffset, b.byteLength))) throw new Error(`${cell.id}: preserved collider ${before.id} changed`);
    }
  }
  let drawCalls = 0, triangles = 0, textureTexels = 0, residentTextureBytes = 0;
  for (const mesh of decoded.getRoot().listMeshes()) for (const prim of mesh.listPrimitives()) { drawCalls++; triangles += (prim.getIndices()?.getCount() ?? 0) / 3; }
  for (const texture of decoded.getRoot().listTextures()) {
    const image = texture.getImage()!;
    const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
    const texels = view.getUint32(20, true) * view.getUint32(24, true);
    const dfd = view.getUint32(48, true), uastc = image[dfd + 12] === 166;
    textureTexels += texels;
    const resident = Math.round(texels * (uastc ? 1 : 0.5) * 1.333);
    residentTextureBytes += resident;
    totalTextureBytes += image.byteLength;
    textures.set(sha(image), { bytes: image.byteLength, texels, resident });
  }
  totalTextureTexels += textureTexels;
  const visualPath = `visual/${cell.id}.lod0.glb`, collisionPath = `collision/${cell.id}.bin`;
  writeFileSync(path.join(out, visualPath), bytes); writeFileSync(path.join(out, collisionPath), col);
  cells.push({ ...cell, visual: { lod0: { ...cell.visual.lod0, path: visualPath, sha256: sha(bytes), bytes: bytes.byteLength, triangles, drawCalls, textureBytesEstimate: residentTextureBytes } },
    collision: { path: collisionPath, sha256: sha(col), bytes: col.byteLength, triangles: colliders.reduce((n, c) => n + c.indices.length / 3, 0) } });
  totalDrawCalls += drawCalls;
  preservation.push({ cell: cell.id, buildingsSha256: identity, nonGroundColliders: colliders.length - 1 });
  console.log(`${cell.id}: preserved buildings and ${colliders.length - 1} colliders; ${drawCalls} draws, ${triangles} triangles`);
}
const runtimeTerrain = encodeTerrain(built.runtimeTerrain);
writeFileSync(path.join(out, 'runtime-terrain.bin'), runtimeTerrain);
const supportTerrain = { path: 'runtime-terrain.bin', bytes: runtimeTerrain.byteLength, sha256: sha(runtimeTerrain) };
if (existsSync(path.join(base, 'scenery.json'))) copyFileSync(path.join(base, 'scenery.json'), path.join(out, 'scenery.json'));
const residentMiB = [...textures.values()].reduce((n, t) => n + t.resident, 0) / 2 ** 20;
const report = { ...baseReport, builtAt: new Date().toISOString(),
  repair: { base, baseIndexSha256: sha(readFileSync(path.join(base, 'cells.json'))), configSha256: sha(readFileSync(option('config'))),
    sourceHashes: Object.fromEntries(['tools/world/rebuild_ground.ts', ...readdirSync('tools/world/lib').filter(file => file.endsWith('.ts')).sort().map(file => `tools/world/lib/${file}`)].map(p => [p, sha(readFileSync(p))])),
    method: 'replace authored ground only; preserve decoded building geometry/materials/images and exact non-ground colliders', preservation,
    preCoastalGroundCache:cacheAudit,
    foundationRepairs: foundationSpec ? { path:values['foundation-repairs'], sha256:sha(readFileSync(values['foundation-repairs']!)), audits:foundationAudits } : null },
  supportTerrain, stairs: { registerOptions: config.registerStairs, register: register.flights, flights: stairs.flights, overlappingNotDrawn: [...conflicting] },
  entranceTerraces: { options: config.entranceTerraces, terraces: terraces.terraces }, retainingWalls: { options: config.retainingWalls, walls: walls.walls, registerAlignment: built.wallAlignment }, ground: ground.stats,
  carriagewayGrade: built.carriagewayGrade,
  coastal: built.coastal ? { ...built.coastal, waterPieces: undefined, waterCellCount: built.coastal.waterPieces.length,
    note: 'Source-backed coastline, surveyed structural decks and explicit closed pier footprints. Water has no collider; source terrain is unchanged.' } : null,
  cells: cells.map(c => ({ cell: c.id, drawCalls: c.visual.lod0.drawCalls, triangles: c.visual.lod0.triangles, collisionTriangles: c.collision.triangles })),
  totals: { cells: cells.length, drawCalls: totalDrawCalls, ktx2Bytes: totalTextureBytes, textureTexels: totalTextureTexels, uniqueTextures: textures.size, residentTextureMiBEstimate: Math.round(residentMiB * 10) / 10 },
  budgets: { drawCallsPerCellMax: Math.max(...cells.map(c => c.visual.lod0.drawCalls)), drawCallsPerCellLimit: config.budgets.drawCallsPerCell,
    residentTextureLimitMiB: config.budgets.lowPresetTextureMiB,
    residencyMode: config.streaming?.enabled === true ? 'bounded-runtime-window' : 'entire-release',
    runtimeResidencyVerification: config.streaming?.enabled === true ? 'REQUIRED: both presets, travel and return' : null,
    pass: cells.every(c => c.visual.lod0.drawCalls <= config.budgets.drawCallsPerCell) && (config.streaming?.enabled === true || residentMiB <= config.budgets.lowPresetTextureMiB) } };
writeFileSync(path.join(out, 'cells.json'), JSON.stringify({ ...baseIndex, cells }, null, 1) + '\n');
writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 1) + '\n');
console.log(`Ground repair built: ${cells.length} cells, ${residentMiB.toFixed(1)} MiB textures; budgets ${report.budgets.pass ? 'PASS' : 'FAIL'}`);
