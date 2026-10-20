// Produce a fresh, immutable-world derivative. This command does not activate or publish it.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {gzipSync} from 'node:zlib';
import {NodeIO, type Primitive} from '@gltf-transform/core';
import {ALL_EXTENSIONS} from '@gltf-transform/extensions';
import {MeshoptDecoder} from 'meshoptimizer';
import {decodeSimulationPayload, encodeTerrain, parseTerrain, parseCollisionBundle, validateWorldManifest, type FileRef, type SimulationFileRef, type WorldManifest} from '../../packages/world-schema/src/index.ts';
import {type FrontierMesh} from './lib/frontier-ground.ts';
import {patchGroundCollision, retainGroundOutsideRectangle} from './lib/ground-region-patch.ts';
import {replaceGroundGlb, type GroundAttributeArray, type GroundGlbReplacement} from './lib/replace-ground-glb.ts';
import {lowerTerrainUnderGround, type GroundPiece} from './lib/ground.ts';
import {entranceCells, palaceEntrance, universityEntrance, type GroundTriangle, type EntrancePatch} from './lib/senate-entrances.ts';
import {appendEntranceGlb, entranceTextures} from './lib/senate-entrance-glb.ts';
import {readFacadeGlb} from './lib/facade-glb.ts';

const BASE_MANIFEST_SHA256 = '5a3502a4641de1a79dfd40dbb06724b59d4e908d16f3a5218b8e7dcead3f7ebd';
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const {values} = parseArgs({options: {source: {type: 'string'}, out: {type: 'string'}, release: {type: 'string'}, report: {type: 'string'}, only: {type: 'string', default: 'both'}}});
assert.ok(values.source && values.out && values.release && values.report, '--source, --out, --release and --report required');
assert.ok(['university', 'palace', 'both'].includes(values.only), '--only must be university, palace or both');
assert.match(values.release, /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/);
const source = path.resolve(values.source), out = path.resolve(values.out), reportPath = path.resolve(values.report);
assert.ok(!fs.existsSync(out) && !fs.existsSync(reportPath), 'Output and report must be fresh');
assert.ok(!out.startsWith(source + path.sep) && !source.startsWith(out + path.sep) && out !== source, 'Source and output must be disjoint');
const sourceManifestBytes = fs.readFileSync(path.join(source, 'manifest.json'));
assert.equal(sha(sourceManifestBytes), BASE_MANIFEST_SHA256, 'Repair must derive from the exact deployed m1-cb world');
const manifest = JSON.parse(sourceManifestBytes.toString()) as WorldManifest & {publicationFiles?: FileRef[]};
assert.deepEqual(validateWorldManifest(manifest), []);
assert.equal(manifest.worldReleaseId, 'senate-20261020-optimized-m1-cb');
const safe = (root: string, name: string) => {
  assert.ok(name.split('/').every(part => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part)), 'Unsafe payload path');
  const file = path.resolve(root, ...name.split('/')); assert.ok(file.startsWith(root + path.sep)); return file;
};
function read(ref: FileRef) {
  const file = safe(source, ref.path), stat = fs.lstatSync(file); assert.ok(stat.isFile() && !stat.isSymbolicLink());
  const bytes = fs.readFileSync(file); assert.equal(bytes.length, ref.bytes, ref.path); assert.equal(sha(bytes), ref.sha256, ref.path); return bytes;
}
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({'meshopt.decoder': MeshoptDecoder});
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const fromPrimitive = (p: Primitive): FrontierMesh => ({
  attributes: Object.fromEntries(p.listSemantics().map(s => [s, p.getAttribute(s)!.getArray()! as GroundAttributeArray])),
  components: Object.fromEntries(p.listSemantics().map(s => [s, p.getAttribute(s)!.getElementSize()])),
  normalized: Object.fromEntries(p.listSemantics().map(s => [s, p.getAttribute(s)!.getNormalized()])),
  indices: Uint32Array.from(p.getIndices()!.getArray()!),
});
const trianglesOf = (mesh: FrontierMesh): GroundTriangle[] => Array.from({length: mesh.indices.length / 3}, (_, t) => [0, 1, 2].map(k => Array.from(mesh.attributes.POSITION!.subarray(mesh.indices[t * 3 + k]! * 3, mesh.indices[t * 3 + k]! * 3 + 3))) as unknown as GroundTriangle);
const triangleKey = (triangle: GroundTriangle) => triangle.map(p => {
  const b = Buffer.alloc(12); p.forEach((v, i) => b.writeFloatLE(v === 0 ? 0 : v, i * 4)); return b.toString('hex');
}).sort().join('');
const nearDocuments = new Map<string, Awaited<ReturnType<NodeIO['read']>>>();
const allGround: GroundTriangle[] = [];
const roadGround: GroundTriangle[] = [];
for (const cell of manifest.cells.filter(c => ['c_m01_m01', 'c_m01_p00', 'c_p00_m01', 'c_p00_p00'].includes(c.id))) {
  read(cell.visual.lod0); const document = await io.read(safe(source, cell.visual.lod0.path)); nearDocuments.set(cell.id, document);
  for (const node of document.getRoot().listNodes()) if (node.getMesh() && node.getName().includes('_ground_')) {
    assert.deepEqual(node.getWorldMatrix(), identity, 'Repair requires baked world ground coordinates');
    for (const primitive of node.getMesh()!.listPrimitives()) {
      const triangles = trianglesOf(fromPrimitive(primitive)); allGround.push(...triangles);
      if (/_ground_(?:setts|cobble|asphalt)$/.test(node.getName())) roadGround.push(...triangles);
    }
  }
}
const patches: EntrancePatch[] = [...(values.only !== 'palace' ? [universityEntrance(allGround)] : []), ...(values.only !== 'university' ? [palaceEntrance(allGround, roadGround)] : [])];
const authored = entranceCells(patches, manifest.cellSize);
const textures = await entranceTextures();
const affected = new Set<string>();
for (const piece of authored) affected.add(piece.cell);
const intersects = (tri: GroundTriangle, patch: EntrancePatch) => {
  const xs = tri.map(p => p[0]), zs = tri.map(p => p[2]), [x0, z0, x1, z1] = patch.region;
  return Math.min(...xs) < x1 && Math.max(...xs) > x0 && Math.min(...zs) < z1 && Math.max(...zs) > z0;
};
// Actual ground can cross its cell's nominal rectangle. Include every colliding owner that reaches a patch.
for (const cell of manifest.cells) {
  const bundle = parseCollisionBundle(await decodeSimulationPayload(read(cell.collision), cell.collision));
  for (const collider of bundle.colliders) if (collider.group === 'ground' || collider.group === 'kerbs') {
    const mesh: FrontierMesh = {attributes: {POSITION: collider.positions}, components: {POSITION: 3}, normalized: {POSITION: false}, indices: collider.indices};
    if (trianglesOf(mesh).some(triangle => patches.some(patch => intersects(triangle, patch)))) affected.add(cell.id);
  }
}
const outputs = new Map<string, Uint8Array>(), changes: Record<string, unknown>[] = [];
function add(name: string, bytes: Uint8Array): FileRef {
  const ref = {path: name, bytes: bytes.length, sha256: sha(bytes)};
  const prior = outputs.get(name); assert.ok(!prior || sha(prior) === ref.sha256, `Conflicting output ${name}`); outputs.set(name, bytes); return ref;
}
for (const texture of textures) {
  const ref = add(texture.path, texture.bytes);
  (manifest as any).sharedTextures = [...(manifest.sharedTextures ?? []), ref];
}
function simulation(name: string, bytes: Uint8Array): SimulationFileRef {
  const stored = gzipSync(bytes, {level: 6}), hash = sha(stored);
  return {...add(`${name}.${hash.slice(0, 12)}.gz`, stored), compression: 'gzip', decodedBytes: bytes.length, decodedSha256: sha(bytes)};
}
function counts(bytes: Uint8Array) {
  const json = readFacadeGlb(bytes).json as any; let triangles = 0, drawCalls = 0;
  for (const n of json.nodes) if (n.mesh !== undefined) for (const p of json.meshes[n.mesh].primitives) { triangles += json.accessors[p.indices].count / 3; drawCalls++; }
  return {triangles, drawCalls};
}
function clipRegions(mesh: FrontierMesh, select?: (triangle: GroundTriangle) => boolean) {
  let next = mesh;
  for (const patch of patches) {
    const current = next, selected = select ? trianglesOf(current).map(select) : null;
    next = retainGroundOutsideRectangle(current, patch.region, selected ? t => selected[t]! : undefined).mesh;
  }
  return next;
}
for (const cell of manifest.cells.filter(c => affected.has(c.id))) {
  const before = structuredClone(cell), pieces = authored.filter(p => p.cell === cell.id);
  const near = nearDocuments.get(cell.id) ?? await io.read(safe(source, cell.visual.lod0.path));
  const groundKeys = new Set<string>();
  for (const n of near.getRoot().listNodes()) if (n.getMesh() && n.getName().includes('_ground_')) for (const p of n.getMesh()!.listPrimitives()) for (const triangle of trianglesOf(fromPrimitive(p))) groundKeys.add(triangleKey(triangle));
  const transformed = new Map<string, FileRef & ReturnType<typeof counts>>();
  for (const [tier, ref] of Object.entries(cell.visual)) {
    const prior = transformed.get(ref.path); if (prior) {Object.assign(ref, prior); continue;}
    const input = read(ref), doc = tier === 'lod0' ? near : await io.read(safe(source, ref.path)), replacements: GroundGlbReplacement[] = [];
    if (tier !== 'lod2') {
      for (const node of doc.getRoot().listNodes()) if (node.getMesh() && node.getName().includes('_ground_')) {
        assert.deepEqual(node.getWorldMatrix(), identity);
        for (const [primitiveIndex, primitive] of node.getMesh()!.listPrimitives().entries()) {
          const mesh = clipRegions(fromPrimitive(primitive));
          replacements.push({nodeName: node.getName(), primitiveIndex, attributes: mesh.attributes, indices: mesh.indices});
        }
      }
    } else {
      let appended = false;
      for (const node of doc.getRoot().listNodes()) if (node.getMesh()) {
        assert.deepEqual(node.getWorldMatrix(), identity);
        for (const [primitiveIndex, primitive] of node.getMesh()!.listPrimitives().entries()) {
          const original = fromPrimitive(primitive), tris = trianglesOf(original);
          if (!tris.some(triangle => groundKeys.has(triangleKey(triangle)))) continue;
          let mesh = clipRegions(original, triangle => groundKeys.has(triangleKey(triangle)));
          assert.deepEqual(Object.keys(mesh.attributes).sort(), ['COLOR_0', 'POSITION']);
          if (!appended) {
            const positions = Array.from(mesh.attributes.POSITION!), colours = Array.from(mesh.attributes.COLOR_0!), indices = Array.from(mesh.indices);
            for (const piece of pieces) {
              const colour = /iron|grille|lamp/.test(piece.tag) ? [.018, .022, .025] : piece.tag.includes('university-apron') ? [.07, .07, .075] : [.30, .29, .26];
              for (const id of piece.indices) {indices.push(positions.length / 3); positions.push(...piece.positions.slice(id * 3, id * 3 + 3)); colours.push(...colour);}
            }
            mesh = {...mesh, attributes: {POSITION: Float32Array.from(positions), COLOR_0: Float32Array.from(colours)}, indices: Uint32Array.from(indices)}; appended = true;
          }
          replacements.push({nodeName: node.getName(), primitiveIndex, kind: 'distant-ground', attributes: mesh.attributes, indices: mesh.indices});
        }
      }
      assert.ok(appended || !pieces.length, `No exact ground correspondence in distant ${cell.id}`);
    }
    const replaced = await replaceGroundGlb(input, replacements), bytes = tier === 'lod2' ? replaced : appendEntranceGlb(replaced, pieces, textures), hash = sha(bytes);
    const next = {...add(`cells/${cell.id}.${tier}.${hash.slice(0, 16)}.glb`, bytes), ...counts(bytes), ...(tier !== 'lod2' ? {
      atlases: (ref as any).atlases + textures.length,
      textureBytesEstimate: (ref as any).textureBytesEstimate + textures.length * 256 * 256 * 4 * 4 / 3,
    } : {})};
    transformed.set(ref.path, next); Object.assign(ref, next);
  }
  let collision = await decodeSimulationPayload(read(cell.collision), cell.collision);
  for (const patch of patches) collision = patchGroundCollision(collision, patch.region, entranceCells([patch], manifest.cellSize).filter(p => p.cell === cell.id)).bytes;
  const bundle = parseCollisionBundle(collision); let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const collider of bundle.colliders) for (const id of collider.indices) {const x = collider.positions[id * 3]!, z = collider.positions[id * 3 + 2]!; x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x); z1 = Math.max(z1, z);}
  Object.assign(cell.collision, simulation(`cells/${cell.id}.entrances.hcol`, collision), {triangles: bundle.colliders.reduce((n, c) => n + c.indices.length / 3, 0), boundsXZ: [x0, z0, x1, z1]});
  changes.push({cell: cell.id, before, after: structuredClone(cell), authoredPieces: pieces.length});
}
const terrainBytes = await decodeSimulationPayload(read(manifest.terrain), manifest.terrain), terrain = parseTerrain(terrainBytes), lowered = lowerTerrainUnderGround(terrain, authored), changedTerrain: {x: number; z: number; before: number; after: number}[] = [];
for (let i = 0; i < terrain.heights.length; i++) if (!Object.is(terrain.heights[i], lowered.heights[i])) {
  const x = terrain.x0 + i % terrain.nx * terrain.resolution, z = terrain.z0 + Math.floor(i / terrain.nx) * terrain.resolution;
  assert.ok(patches.some(p => x >= p.region[0] && x <= p.region[2] && z >= p.region[1] && z <= p.region[3]), 'Safety change must stay within the entrance repair');
  changedTerrain.push({x, z, before: terrain.heights[i]!, after: lowered.heights[i]!});
}
Object.assign(manifest.terrain, simulation('terrain.entrances.bin', encodeTerrain(lowered)));
(manifest as any).worldReleaseId = values.release; (manifest as any).builtAt = new Date().toISOString();
const summary = {
  schemaVersion: 1, sourceRelease: 'senate-20261020-optimized-m1-cb', sourceManifestSha256: BASE_MANIFEST_SHA256,
  derivativeRelease: values.release, patches: patches.map(({id, region, observations}) => ({id, region, observations})),
  preservation: {unselectedGroundOutsideRegionsExact: true, nonGroundGeometryMaterialsAndImagesExact: true, nonGroundCollidersExact: true, wholeMapAndTextureTiersRetained: true},
  changes, loweredSafetySamples: changedTerrain.length, changedTerrain,
  status: 'BUILT_RUNTIME_AND_VISUAL_REVIEW_REQUIRED',
};
const note = add('publication/senate-entrances.json', Buffer.from(JSON.stringify(summary, null, 2) + '\n'));
(manifest as any).publicationFiles = [...(manifest.publicationFiles ?? []), note];
assert.deepEqual(validateWorldManifest(manifest), []);
const refs = new Map<string, FileRef>();
function collect(value: unknown) {
  if (!value || typeof value !== 'object') return;
  const v = value as Record<string, unknown>;
  if (typeof v.path === 'string' && typeof v.sha256 === 'string' && typeof v.bytes === 'number') {
    const ref = v as unknown as FileRef, prior = refs.get(ref.path); assert.ok(!prior || prior.sha256 === ref.sha256); refs.set(ref.path, ref);
  }
  for (const next of Object.values(v)) collect(next);
}
collect(manifest); fs.mkdirSync(out, {recursive: true});
for (const ref of refs.values()) {
  const file = safe(out, ref.path); fs.mkdirSync(path.dirname(file), {recursive: true}); const bytes = outputs.get(ref.path);
  if (bytes) fs.writeFileSync(file, bytes, {flag: 'wx'}); else {read(ref); fs.linkSync(safe(source, ref.path), file);}
  assert.equal(sha(fs.readFileSync(file)), ref.sha256);
}
const finalManifest = Buffer.from(JSON.stringify(manifest, null, 1) + '\n'); fs.writeFileSync(path.join(out, 'manifest.json'), finalManifest, {flag: 'wx'});
assert.equal(sha(fs.readFileSync(path.join(source, 'manifest.json'))), BASE_MANIFEST_SHA256);
fs.mkdirSync(path.dirname(reportPath), {recursive: true});
fs.writeFileSync(reportPath, JSON.stringify({...summary, manifestSha256: sha(finalManifest), worldBytes: finalManifest.length + [...refs.values()].reduce((n, r) => n + r.bytes, 0), files: refs.size + 1}, null, 2) + '\n', {flag: 'wx'});
console.log(JSON.stringify({status: summary.status, release: values.release, manifestSha256: sha(finalManifest), affectedCells: [...affected], lowerSafetySamples: changedTerrain.length}));
