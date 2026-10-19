// Append the calibrated Alexander model and closed granite collision to a completed, unpublished cell build.
// Existing decoded geometry, material bindings, texture bytes, support terrain and every other cell stay exact.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Document, NodeIO, type Accessor } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions';
import { mergeDocuments, unpartition } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer';
import { validateBytes } from 'gltf-validator';
import { parseCollisionBundle, encodeCollisionBundle, type CellDescriptor, type TriMeshCollider } from '../../packages/world-schema/src/index.ts';

const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const json = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const arrayHash = (a: Accessor) => { const v = a.getArray()!; return sha(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)); };
const triangleHash = (a: Accessor) => {
  const indices = a.getArray()!, triangles = [];
  for (let i = 0; i < indices.length; i += 3) {
    const t = [Number(indices[i]), Number(indices[i + 1]), Number(indices[i + 2])];
    const at = t.indexOf(Math.min(...t)); triangles.push([t[at], t[(at + 1) % 3], t[(at + 2) % 3]]);
  }
  return sha(JSON.stringify(triangles));
};
function geometryProof(doc: Document) {
  return doc.getRoot().listMeshes().map(m => ({ name: m.getName(), primitives: m.listPrimitives().map(p => ({
    mode: p.getMode(), material: p.getMaterial()?.getName(), indices: p.getIndices() ? triangleHash(p.getIndices()!) : null,
    attributes: p.listSemantics().sort().map(s => { const a = p.getAttribute(s)!; return { semantic: s, type: a.getType(), component: a.getComponentType(), normalized: a.getNormalized(), hash: arrayHash(a) }; }),
  })) }));
}
function nodeProof(doc: Document) { return doc.getRoot().listNodes().map(n => ({ name: n.getName(), world: n.getWorldMatrix(), mesh: n.getMesh()?.getName() ?? null })); }
const textureProof = (doc: Document) => doc.getRoot().listTextures().map(t => ({ name: t.getName(), mime: t.getMimeType(), hash: sha(t.getImage()!) }));

export async function addCellMonument(cellsArgument: string, monumentArgument: string) {
  const cellsDir = path.resolve(cellsArgument), monumentDir = path.resolve(monumentArgument);
  const workRoot = path.resolve('data/work') + path.sep;
  assert.ok(cellsDir.startsWith(workRoot), 'Only unpublished builds under data/work may be modified');
  const evidenceDir = path.join(cellsDir, 'alexander-integration');
  assert.ok(!existsSync(evidenceDir), 'Monument already integrated or prior attempt exists; use a fresh cell build');
  const indexFile = path.join(cellsDir, 'cells.json'), reportFile = path.join(cellsDir, 'report.json');
  const index = json(indexFile) as { originId: string; cells: CellDescriptor[] }, report = json(reportFile);
  const placement = json(path.join(monumentDir, 'placement.json')), build = json(path.join(monumentDir, 'build-report.json'));
  assert.equal(index.originId, placement.originId);
  const cell = index.cells.find(c => c.cx === 0 && c.cz === 0); assert.ok(cell, 'Origin cell (0,0) absent');
  const sourceVisual = path.resolve(cellsDir, cell.visual.lod0.path), sourceCollision = path.resolve(cellsDir, cell.collision.path);
  for (const p of [sourceVisual, sourceCollision]) assert.ok(p.startsWith(cellsDir + path.sep), 'Cell payload escapes build');
  const oldVisual = readFileSync(sourceVisual), oldCollision = readFileSync(sourceCollision);
  assert.equal(sha(oldVisual), cell.visual.lod0.sha256); assert.equal(sha(oldCollision), cell.collision.sha256);
  const monumentBytes = readFileSync(path.join(monumentDir, build.output.file)); assert.equal(sha(monumentBytes), build.output.sha256);
  await Promise.all([MeshoptEncoder.ready, MeshoptDecoder.ready]);
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });
  const doc = await io.readBinary(oldVisual), addition = await io.readBinary(monumentBytes);
  const expected = { geometry: [...geometryProof(doc), ...geometryProof(addition)], nodes: [...nodeProof(doc), ...nodeProof(addition)], textures: [...textureProof(doc), ...textureProof(addition)] };
  assert.equal(doc.getRoot().listScenes().length, 1); assert.equal(addition.getRoot().listScenes().length, 1);
  const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0]!;
  const mapping = mergeDocuments(doc, addition), importedScene = mapping.get(addition.getRoot().listScenes()[0]!)!;
  assert.ok(importedScene.propertyType === 'Scene');
  for (const child of (importedScene as typeof scene).listChildren()) scene.addChild(child);
  importedScene.dispose(); doc.getRoot().setDefaultScene(scene);
  await doc.transform(unpartition()); await MeshoptEncoder.ready;
  // FILTER-compressed source cells can expose normalized BYTE normals without this required declaration.
  // Preserve those bytes and repair their format metadata, instead of re-quantizing/dequantizing geometry.
  const quantizedGeometry = doc.getRoot().listMeshes().some(m => m.listPrimitives().some(p => ['POSITION', 'NORMAL', 'TANGENT'].some(s => p.getAttribute(s) && p.getAttribute(s)!.getComponentType() !== 5126)));
  if (quantizedGeometry) doc.createExtension(KHRMeshQuantization).setRequired(true);
  // No quantize/reorder transform: keep decoded positions and every other attribute exact.
  doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
  const visual = await io.writeBinary(doc), reopened = await io.readBinary(visual);
  assert.deepEqual(geometryProof(reopened), expected.geometry, 'Decoded existing or monument geometry changed');
  assert.deepEqual(nodeProof(reopened), expected.nodes, 'World node transforms or mesh ownership changed');
  assert.deepEqual(textureProof(reopened), expected.textures, 'Encoded texture payloads changed');
  assert.equal(reopened.getRoot().listScenes().length, 1);
  let visibleMeshes = 0; reopened.getRoot().listScenes()[0]!.traverse(n => { if (n.getMesh()) visibleMeshes++; });
  assert.equal(visibleMeshes, reopened.getRoot().listNodes().filter(n => n.getMesh()).length, 'Merged geometry is not reachable from default scene');
  const validation = await validateBytes(visual, { maxIssues: 100 }); assert.equal(validation.issues.numErrors, 0, `Merged GLB validator errors: ${JSON.stringify(validation.issues.messages.filter(m => m.severity === 0))}`);

  const originalCollision = parseCollisionBundle(oldCollision), granite = json(path.join(monumentDir, 'granite-collider.json'));
  assert.equal(granite.sourceSha256, placement.source.sha256);
  assert.ok(!originalCollision.colliders.some(c => c.id === granite.id), 'Duplicate monument collider');
  const tags = [...originalCollision.header.surfaceTags]; if (!tags.includes('landmark')) tags.push('landmark');
  const positions = new Float32Array(granite.positions), indices = new Uint32Array(granite.indices);
  assert.equal(indices.length % 3, 0); assert.ok(positions.every(Number.isFinite)); assert.ok(indices.every(i => i * 3 < positions.length));
  const collider: TriMeshCollider = { id: granite.id, group: 'landmarks', ref: granite.id, positions, indices, triangleTags: new Uint16Array(indices.length / 3).fill(tags.indexOf('landmark')) };
  const collision = encodeCollisionBundle({ originId: originalCollision.header.originId, frame: originalCollision.header.frame, cell: originalCollision.header.cell, surfaceTags: tags }, [...originalCollision.colliders, collider]);
  const reopenedCollision = parseCollisionBundle(collision);
  for (let i = 0; i < originalCollision.colliders.length; i++) assert.deepEqual(reopenedCollision.colliders[i], originalCollision.colliders[i], 'Original collision changed');
  assert.deepEqual(reopenedCollision.colliders.at(-1), collider);
  const supportBefore = report.supportTerrain ? sha(readFileSync(path.join(cellsDir, report.supportTerrain.path))) : null;
  if (supportBefore) assert.equal(supportBefore, report.supportTerrain.sha256);
  const oldCell = structuredClone(cell), stat = report.cells.find((c: { cell: string }) => c.cell === cell.id); assert.ok(stat);
  const textureTexels = build.textures.reduce((n: number, t: { dimensions: number[] }) => n + t.dimensions[0]! * t.dimensions[1]!, 0);
  const textureBytes = build.textures.reduce((n: number, t: { bytes: number }) => n + t.bytes, 0);
  // Cell schema's existing estimate is RGBA fallback residency, not measured compressed GPU memory.
  const nextCell: CellDescriptor = { ...cell, visual: { ...cell.visual, lod0: { ...cell.visual.lod0, bytes: visual.length, sha256: sha(visual), triangles: cell.visual.lod0.triangles + build.triangles, drawCalls: cell.visual.lod0.drawCalls + build.drawCalls, textureBytesEstimate: cell.visual.lod0.textureBytesEstimate + textureTexels * 4 * 1.333 } }, collision: { ...cell.collision, bytes: collision.length, sha256: sha(collision), triangles: cell.collision.triangles + indices.length / 3 } };
  index.cells[index.cells.indexOf(cell)] = nextCell;
  Object.assign(stat, { drawCalls: nextCell.visual.lod0.drawCalls, triangles: nextCell.visual.lod0.triangles, glbBytes: visual.length, ktx2Bytes: stat.ktx2Bytes + textureBytes, textureTexels: stat.textureTexels + textureTexels, collisionTriangles: nextCell.collision.triangles });
  report.totals.drawCalls += build.drawCalls; report.totals.ktx2Bytes += textureBytes; report.totals.textureTexels += textureTexels; report.totals.uniqueTextures += build.textures.length;
  report.totals.residentTextureMiBEstimate = Math.round((report.totals.residentTextureMiBEstimate + build.residentBytesEstimate / 1048576) * 10) / 10;
  report.budgets.drawCallsPerCellMax = Math.max(...report.cells.map((c: { drawCalls: number }) => c.drawCalls));
  report.budgets.pass = report.budgets.pass && report.budgets.drawCallsPerCellMax <= report.budgets.drawCallsPerCellLimit && (report.budgets.residencyMode === 'bounded-runtime-window' || report.totals.residentTextureMiBEstimate <= report.budgets.residentTextureLimitMiB);
  assert.ok(report.budgets.pass, 'Monument exceeds cell build budgets');
  report.inputs.alexanderMonument = { sourceSha256: placement.source.sha256, placedGlbSha256: build.output.sha256, placementSha256: sha(readFileSync(path.join(monumentDir, 'placement.json'))) };
  const proof = { status: 'PASS', id: placement.id, cell: cell.id, scriptSha256: sha(readFileSync(import.meta.filename)), assetSha256: build.output.sha256, sourceCell: oldCell, cellAfter: nextCell,
    preserved: { sourceMeshCount: expected.geometry.length - addition.getRoot().listMeshes().length, sourceColliders: originalCollision.colliders.length, decodedGeometryExact: true, topologyAndWindingExact: true, encodedTexturesExact: true, worldTransformsExact: true, supportTerrainSha256: supportBefore }, added: { triangles: build.triangles, drawCalls: build.drawCalls, collisionTriangles: indices.length / 3, residentTextureBytesEstimate: build.residentBytesEstimate }, validator: validation.issues };
  // All validation occurs before touching payloads. Keep exact before bytes for reproducible rollback/audit.
  mkdirSync(evidenceDir); writeFileSync(path.join(evidenceDir, 'before.lod0.glb'), oldVisual); writeFileSync(path.join(evidenceDir, 'before.hcol'), oldCollision);
  writeFileSync(path.join(evidenceDir, 'before-cells.json'), readFileSync(indexFile)); writeFileSync(path.join(evidenceDir, 'before-report.json'), readFileSync(reportFile));
  writeFileSync(sourceVisual, visual); writeFileSync(sourceCollision, collision); writeFileSync(indexFile, JSON.stringify(index, null, 1) + '\n'); writeFileSync(reportFile, JSON.stringify(report, null, 1) + '\n');
  writeFileSync(path.join(evidenceDir, 'proof.json'), JSON.stringify(proof, null, 2) + '\n');
  return proof;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { cells: { type: 'string' }, monument: { type: 'string' } } });
  assert.ok(values.cells && values.monument, '--cells and --monument required');
  const proof = await addCellMonument(values.cells, values.monument); console.log(JSON.stringify({ status: proof.status, cell: proof.cell, added: proof.added }));
}
