// Replace only the three hash-bound flat Parliament front-wall triangles in a
// fresh unpublished cell copy. All remaining decoded attributes/materials and
// every encoded image remain exact. The original citymodel shell collider stays.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Document, NodeIO, type Accessor, type Primitive } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions';
import { mergeDocuments, unpartition } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import { validateBytes } from 'gltf-validator';
import { parseCollisionBundle, type CellDescriptor } from '../../packages/world-schema/src/index.ts';
import { PARLIAMENT_ID, PARLIAMENT_VTJ, readParliamentSource, worldTriangleKey } from './build_parliament_facade.ts';

const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const json = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const arrayHash = (a: Accessor) => { const v = a.getArray()!; return sha(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)); };
function triangleHash(a: Accessor) {
  const I = a.getArray()!, triangles: number[][] = [];
  for (let i = 0; i < I.length; i += 3) { const t = [Number(I[i]), Number(I[i + 1]), Number(I[i + 2])], k = t.indexOf(Math.min(...t)); triangles.push([t[k]!, t[(k + 1) % 3]!, t[(k + 2) % 3]!]); }
  return sha(JSON.stringify(triangles));
}
function geometryProof(doc: Document) {
  return doc.getRoot().listMeshes().map(m => ({ name: m.getName(), primitives: m.listPrimitives().map(p => ({
    mode: p.getMode(), material: p.getMaterial()?.getName(), indices: p.getIndices() ? triangleHash(p.getIndices()!) : null,
    attributes: p.listSemantics().sort().map(s => { const a = p.getAttribute(s)!; return { semantic: s, type: a.getType(), component: a.getComponentType(), normalized: a.getNormalized(), hash: arrayHash(a) }; }),
  })) }));
}
const nodeProof = (doc: Document) => doc.getRoot().listNodes().map(n => ({ name: n.getName(), world: n.getWorldMatrix(), mesh: n.getMesh()?.getName() ?? null, extras: n.getExtras() }));
const textureProof = (doc: Document) => doc.getRoot().listTextures().map(t => ({ name: t.getName(), mime: t.getMimeType(), hash: sha(t.getImage()!), extras: t.getExtras() }));
const materialProof = (doc: Document) => doc.getRoot().listMaterials().map(m => ({
  name: m.getName(), base: m.getBaseColorFactor(), emissive: m.getEmissiveFactor(), roughness: m.getRoughnessFactor(), metallic: m.getMetallicFactor(),
  alpha: m.getAlphaMode(), cutoff: m.getAlphaCutoff(), doubleSided: m.getDoubleSided(), normalScale: m.getNormalScale(), occlusionStrength: m.getOcclusionStrength(),
  extras: m.getExtras(), extensions: m.listExtensions().map(e => e.extensionName).sort(),
  textures: [m.getBaseColorTexture(), m.getMetallicRoughnessTexture(), m.getNormalTexture(), m.getOcclusionTexture(), m.getEmissiveTexture()].map(t => t ? { name: t.getName(), hash: sha(t.getImage()!) } : null),
}));

/** The facade is visual-only. Its three old front faces must stay in the exact
 * source shell collider, which blocks entry at the former flat front plane. */
export function verifySourceCitymodelShell(bytes: Uint8Array, sourceTriangles: readonly (readonly (readonly number[])[])[], frontKeys: readonly string[]) {
  const bundle = parseCollisionBundle(bytes), matches = bundle.colliders.filter(c => c.ref === PARLIAMENT_ID);
  assert.equal(matches.length, 1, 'Parliament must retain exactly one original source collider');
  const c = matches[0]!;
  assert.equal(c.id, `cm:${PARLIAMENT_ID}`); assert.equal(c.group, 'citymodel');
  assert.equal(c.indices.length / 3, sourceTriangles.length);
  const actualKeys: string[] = [];
  for (let i = 0; i < c.indices.length; i += 3) actualKeys.push(worldTriangleKey([0, 1, 2].map(k => Array.from(c.positions.slice(c.indices[i + k]! * 3, c.indices[i + k]! * 3 + 3)))));
  const expectedKeys = sourceTriangles.map(t => worldTriangleKey(t.map(v => [v[0]!, v[2]!, -v[1]!])));
  assert.deepEqual(actualKeys, expectedKeys, 'Parliament collision differs from the original source geometry or winding');
  assert.ok(c.triangleTags.every(i => bundle.header.surfaceTags[i] === 'citymodel'), 'Parliament source collision tags changed');
  for (const key of frontKeys) assert.equal(actualKeys.filter(k => k === key).length, 1, 'Original front wall barrier must remain exactly once in collision');
  return { id: c.id, group: c.group, triangles: sourceTriangles.length, orderedSourceTriangleKeysExact: true, sourceWindingExact: true, originalFrontBarrierRetained: true,
    limitation: 'Original source shell, not a filled register prism; the visual portico remains blocked at the former flat source wall' };
}

/** Fail closed on absent, duplicated, instanced or non-indexed source matches. */
export function removeSourceWallTriangles(doc: Document, expectedKeys: readonly string[]) {
  assert.equal(expectedKeys.length, 3); assert.equal(new Set(expectedKeys).size, 3);
  const keys = new Set(expectedKeys), counts = new Map(expectedKeys.map(k => [k, 0]));
  const matches = new Map<Primitive, Set<number>>();
  for (const node of doc.getRoot().listNodes()) {
    const M = node.getWorldMatrix();
    for (const p of node.getMesh()?.listPrimitives() ?? []) {
      if (p.getMode() !== 4) continue;
      const P = p.getAttribute('POSITION'), I = p.getIndices(); if (!P || !I) continue;
      for (let i = 0; i < I.getCount(); i += 3) {
        const vertices = [0, 1, 2].map(k => {
          const v = P.getElement(I.getScalar(i + k), []);
          return [M[0]! * v[0]! + M[4]! * v[1]! + M[8]! * v[2]! + M[12]!, M[1]! * v[0]! + M[5]! * v[1]! + M[9]! * v[2]! + M[13]!, M[2]! * v[0]! + M[6]! * v[1]! + M[10]! * v[2]! + M[14]!];
        });
        const key = worldTriangleKey(vertices);
        if (!keys.has(key)) continue;
        counts.set(key, counts.get(key)! + 1);
        let set = matches.get(p); if (!set) matches.set(p, set = new Set()); set.add(i);
      }
    }
  }
  for (const [key, count] of counts) assert.equal(count, 1, `Source Parliament wall ${key} matched ${count} times; expected exactly once`);
  const changes: { mesh: string; removedTriangles: number; beforeIndexSha256: string; afterIndexSha256: string }[] = [];
  for (const [p, selected] of matches) {
    const old = p.getIndices()!, I = old.getArray()!, kept: number[] = [];
    for (let i = 0; i < I.length; i += 3) if (!selected.has(i)) kept.push(Number(I[i]), Number(I[i + 1]), Number(I[i + 2]));
    const next = doc.createAccessor(`${old.getName()}_parliament_wall_removed`).setType('SCALAR').setBuffer(doc.getRoot().listBuffers()[0]!)
      .setArray(I instanceof Uint32Array ? Uint32Array.from(kept) : I instanceof Uint16Array ? Uint16Array.from(kept) : Uint8Array.from(kept));
    p.setIndices(next);
    changes.push({ mesh: doc.getRoot().listMeshes().find(m => m.listPrimitives().includes(p))?.getName() ?? '', removedTriangles: selected.size, beforeIndexSha256: arrayHash(old), afterIndexSha256: arrayHash(next) });
  }
  assert.equal(changes.reduce((n, p) => n + p.removedTriangles, 0), 3);
  return changes;
}

export async function replaceParliamentFacade(cellsArgument: string, facadeArgument: string) {
  const cellsDir = path.resolve(cellsArgument), facadeDir = path.resolve(facadeArgument);
  assert.ok(cellsDir.startsWith(path.resolve('data/work') + path.sep), 'Only unpublished data/work builds may be changed');
  const evidenceDir = path.join(cellsDir, 'parliament-integration'); assert.ok(!existsSync(evidenceDir), 'Use a fresh unpublished cell copy');
  const indexFile = path.join(cellsDir, 'cells.json'), reportFile = path.join(cellsDir, 'report.json');
  const index = json(indexFile) as { originId: string; cells: CellDescriptor[] }, report = json(reportFile), facade = json(path.join(facadeDir, 'build-report.json'));
  assert.equal(facade.building, PARLIAMENT_ID); assert.equal(facade.vtj, PARLIAMENT_VTJ); assert.equal(index.originId, facade.originId);
  const boundSource = readParliamentSource(path.dirname(facade.source.cityJson.path));
  assert.equal(boundSource.source.cityJson.sha256, facade.source.cityJson.sha256, 'Facade source JSON changed');
  assert.equal(boundSource.source.binary.sha256, facade.source.binary.sha256, 'Facade source binary changed');
  assert.equal(report.inputs.cityModelSha256, boundSource.source.binary.sha256, 'Cell and facade were built from different city geometry');
  assert.deepEqual(facade.source.removedTriangleKeys, boundSource.source.removedTriangleKeys, 'Removal keys are not the verified three source wall triangles');
  const owners = index.cells.filter(c => c.buildings.some(b => b.vtj === PARLIAMENT_VTJ && b.id === PARLIAMENT_ID));
  assert.equal(owners.length, 1, 'Parliament must have exactly one owner cell'); const cell = owners[0]!;
  assert.equal(cell.buildings.find(b => b.id === PARLIAMENT_ID)!.collider, 'citymodel', 'Parliament descriptor must name its measured source shell collider');
  assert.ok(!cell.visual.lod1 && !cell.visual.lod2, 'Integrate before generating LOD tiers; existing owner tiers would be stale');
  const visualPath = path.resolve(cellsDir, cell.visual.lod0.path), collisionPath = path.resolve(cellsDir, cell.collision.path);
  for (const p of [visualPath, collisionPath]) assert.ok(p.startsWith(cellsDir + path.sep), 'Cell payload escapes build');
  const beforeVisual = readFileSync(visualPath), collisionBytes = readFileSync(collisionPath), collisionHash = sha(collisionBytes);
  assert.equal(sha(beforeVisual), cell.visual.lod0.sha256); assert.equal(collisionHash, cell.collision.sha256);
  const sourceShell = verifySourceCitymodelShell(collisionBytes, boundSource.triangles, boundSource.source.removedTriangleKeys);
  const facadeBytes = readFileSync(path.join(facadeDir, facade.output.file)); assert.equal(sha(facadeBytes), facade.output.sha256);
  const supportHash = report.supportTerrain ? sha(readFileSync(path.join(cellsDir, report.supportTerrain.path))) : null;
  if (supportHash) assert.equal(supportHash, report.supportTerrain.sha256);
  await Promise.all([MeshoptEncoder.ready, MeshoptDecoder.ready]);
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });
  const doc = await io.readBinary(beforeVisual), addition = await io.readBinary(facadeBytes);
  const originalAttributes = doc.getRoot().listMeshes().map(m => m.listPrimitives().map(p => p.listSemantics().sort().map(s => ({ s, hash: arrayHash(p.getAttribute(s)!) }))));
  const changes = removeSourceWallTriangles(doc, facade.source.removedTriangleKeys);
  assert.deepEqual(doc.getRoot().listMeshes().map(m => m.listPrimitives().map(p => p.listSemantics().sort().map(s => ({ s, hash: arrayHash(p.getAttribute(s)!) })))), originalAttributes, 'Removal modified an existing vertex attribute');
  const expected = { geometry: [...geometryProof(doc), ...geometryProof(addition)], nodes: [...nodeProof(doc), ...nodeProof(addition)], textures: [...textureProof(doc), ...textureProof(addition)], materials: [...materialProof(doc), ...materialProof(addition)] };
  assert.equal(doc.getRoot().listScenes().length, 1); assert.equal(addition.getRoot().listScenes().length, 1);
  const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0]!;
  const mapping = mergeDocuments(doc, addition), imported = mapping.get(addition.getRoot().listScenes()[0]!)!;
  assert.ok(imported.propertyType === 'Scene');
  for (const child of (imported as typeof scene).listChildren()) scene.addChild(child);
  imported.dispose(); doc.getRoot().setDefaultScene(scene); await doc.transform(unpartition());
  if (doc.getRoot().listMeshes().some(m => m.listPrimitives().some(p => ['POSITION', 'NORMAL', 'TANGENT'].some(s => p.getAttribute(s) && p.getAttribute(s)!.getComponentType() !== 5126)))) doc.createExtension(KHRMeshQuantization).setRequired(true);
  doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
  const bytes = await io.writeBinary(doc), reopened = await io.readBinary(bytes);
  assert.deepEqual(geometryProof(reopened), expected.geometry, 'Preserved or added decoded geometry changed');
  assert.deepEqual(nodeProof(reopened), expected.nodes, 'World transforms or mesh bindings changed');
  assert.deepEqual(textureProof(reopened), expected.textures, 'Encoded image bytes changed');
  assert.deepEqual(materialProof(reopened), expected.materials, 'Material properties or texture bindings changed');
  assert.equal(reopened.getRoot().listScenes().length, 1);
  let visible = 0; reopened.getRoot().listScenes()[0]!.traverse(n => { if (n.getMesh()) visible++; });
  assert.equal(visible, reopened.getRoot().listNodes().filter(n => n.getMesh()).length, 'Imported facade is not in the default scene');
  const validation = await validateBytes(bytes, { maxIssues: 100 }); assert.equal(validation.issues.numErrors, 0, 'Integrated Parliament GLB failed validation');
  const beforeCell = structuredClone(cell), beforeCells = structuredClone(index.cells), stat = report.cells.find((s: { cell: string }) => s.cell === cell.id); assert.ok(stat);
  const next: CellDescriptor = { ...cell, buildings: cell.buildings.map(b => b.id === PARLIAMENT_ID ? { ...b, triangles: b.triangles - 3 + facade.triangles, landmark: 'parliament-mannerheim-facade' } : b), visual: { lod0: { ...cell.visual.lod0, bytes: bytes.length, sha256: sha(bytes), triangles: cell.visual.lod0.triangles - 3 + facade.triangles, drawCalls: cell.visual.lod0.drawCalls + facade.drawCalls } } };
  index.cells[index.cells.indexOf(cell)] = next;
  assert.deepEqual(index.cells.filter(c => c.id !== cell.id), beforeCells.filter(c => c.id !== cell.id), 'Another cell descriptor changed');
  Object.assign(stat, { drawCalls: next.visual.lod0.drawCalls, triangles: next.visual.lod0.triangles, glbBytes: bytes.length });
  report.totals.drawCalls += facade.drawCalls;
  report.budgets.drawCallsPerCellMax = Math.max(...report.cells.map((s: { drawCalls: number }) => s.drawCalls));
  report.budgets.pass = report.budgets.pass && report.budgets.drawCallsPerCellMax <= report.budgets.drawCallsPerCellLimit;
  assert.ok(report.budgets.pass, 'Parliament facade exceeds draw-call budget');
  report.inputs.parliamentFacade = { source: facade.source, assetSha256: facade.output.sha256, toolSha256: sha(readFileSync(import.meta.filename)) };
  const proof = { status: 'PASS', runtimeVisualReview: 'REQUIRED', building: PARLIAMENT_ID, vtj: PARLIAMENT_VTJ, cell: cell.id, toolSha256: sha(readFileSync(import.meta.filename)), assetSha256: facade.output.sha256,
    beforeCell, afterCell: next, changes, removedSourceTriangleKeys: facade.source.removedTriangleKeys,
    preserved: { allRemainingDecodedAttributesExact: true, allRemainingTopologyAndWindingExact: true, encodedImagesExact: true, materialPropertiesAndBindingsExact: true, worldTransformsExact: true, otherCellDescriptorsExact: true, collisionSha256: collisionHash, sourceShell, supportTerrainSha256: supportHash },
    added: { triangles: facade.triangles, drawCalls: facade.drawCalls, textures: 0 }, limitations: facade.authoredApproximation, validator: validation.issues };
  // Validate before mutating this unpublished copy; archive exact rollback bytes.
  mkdirSync(evidenceDir); writeFileSync(path.join(evidenceDir, 'before.lod0.glb'), beforeVisual); writeFileSync(path.join(evidenceDir, 'before-cells.json'), readFileSync(indexFile)); writeFileSync(path.join(evidenceDir, 'before-report.json'), readFileSync(reportFile));
  writeFileSync(visualPath, bytes); writeFileSync(indexFile, JSON.stringify(index, null, 1) + '\n'); writeFileSync(reportFile, JSON.stringify(report, null, 1) + '\n');
  assert.equal(sha(readFileSync(collisionPath)), collisionHash); if (supportHash) assert.equal(sha(readFileSync(path.join(cellsDir, report.supportTerrain.path))), supportHash);
  writeFileSync(path.join(evidenceDir, 'proof.json'), JSON.stringify(proof, null, 2) + '\n'); return proof;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { cells: { type: 'string' }, facade: { type: 'string' } } });
  assert.ok(values.cells && values.facade, '--cells and --facade required'); const proof = await replaceParliamentFacade(values.cells, values.facade);
  console.log(JSON.stringify({ status: proof.status, cell: proof.cell, added: proof.added }));
}
