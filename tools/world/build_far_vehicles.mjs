// Optional low-preset distant geometry, derived without modifying the accepted near-car GLBs.
// Runtime retains the existing 30 m transition, material colours and animated lamps.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression } from '@gltf-transform/extensions';
import { prune, reorder, simplifyPrimitive, weldPrimitive } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import validator from 'gltf-validator';
import { declareQuantizedAttributes } from './lib/glb-quantization.ts';

const { values } = parseArgs({ options: { assets: { type: 'string' }, out: { type: 'string' } } });
if (!values.assets || !values.out || existsSync(values.out)) throw new Error('--assets and a fresh --out required');
mkdirSync(values.out, { recursive: true });
await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready, MeshoptSimplifier.ready]);
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const triangles = primitive => (primitive.getIndices()?.getCount() ?? primitive.getAttribute('POSITION').getCount()) / 3;
const reports = [], maxErrorMetres = .03;
function smoothNormals(document, primitive) {
  const positions = primitive.getAttribute('POSITION'), indices = primitive.getIndices(), values = new Float32Array(positions.getCount() * 3);
  for (let i = 0; i < indices.getCount(); i += 3) {
    const ids = [indices.getScalar(i), indices.getScalar(i + 1), indices.getScalar(i + 2)], points = ids.map(id => positions.getElement(id, []));
    const a = points[1].map((v, axis) => v - points[0][axis]), b = points[2].map((v, axis) => v - points[0][axis]);
    const n = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    for (const id of ids) for (let axis = 0; axis < 3; axis++) values[id * 3 + axis] += n[axis];
  }
  for (let i = 0; i < values.length; i += 3) {
    const length = Math.hypot(values[i], values[i + 1], values[i + 2]) || 1;
    for (let axis = 0; axis < 3; axis++) values[i + axis] /= length;
  }
  primitive.setAttribute('NORMAL', document.createAccessor().setType('VEC3').setBuffer(positions.getBuffer()).setArray(values));
}
for (const id of ['vehicle-lumi-gt', 'vehicle-patrol']) {
  const source = path.join(values.assets, `${id}.glb`), sourceBytes = readFileSync(source), document = await io.readBinary(sourceBytes);
  const nodes = [];
  for (const node of document.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    let ancestor = node, skip = false;
    while (ancestor) { if (ancestor.getName() === 'STEERING_WHEEL') skip = true; ancestor = ancestor.getParentNode(); }
    if (skip) { node.setMesh(null); continue; }
    for (const primitive of mesh.listPrimitives()) {
      const material = primitive.getMaterial(), name = material?.getName() ?? '';
      if (name === 'car_interior') { mesh.removePrimitive(primitive); continue; }
      const before = triangles(primitive); let measuredErrorMetres = 0;
      // Lamp shapes remain exact so head/brake/police lights still use the accepted geometry.
      if (!name.startsWith('car_lamp') && before > 24) {
        // Far cars use flat material factors. Remove UV/hard-normal seams before welding;
        // those seams otherwise prevent geometric simplification even on a planar body panel.
        for (const semantic of ['NORMAL', 'TANGENT', 'TEXCOORD_0', 'TEXCOORD_1']) primitive.setAttribute(semantic, null);
        weldPrimitive(primitive);
        const worldScale = Math.max(...node.getWorldScale().map(Math.abs));
        const scale = MeshoptSimplifier.getScale(primitive.getAttribute('POSITION').getArray(), 3) * worldScale;
        const measuredSimplifier = { ...MeshoptSimplifier, simplify(...args) { const result = MeshoptSimplifier.simplify(...args); measuredErrorMetres = result[1] * scale; return result; } };
        simplifyPrimitive(primitive, { simplifier: measuredSimplifier, ratio: .035, error: maxErrorMetres / scale, lockBorder: false });
        smoothNormals(document, primitive);
      }
      if (measuredErrorMetres > maxErrorMetres + 1e-6) throw new Error(`${node.getName()}: simplification error exceeds bound`);
      nodes.push({ node: node.getName(), material: name, before, after: triangles(primitive), measuredErrorMetres });
    }
    if (!mesh.listPrimitives().length) node.setMesh(null);
  }
  // The far-car renderer uses material factors; retaining unused maps would duplicate texture memory.
  for (const texture of document.getRoot().listTextures()) texture.dispose();
  for (const animation of document.getRoot().listAnimations()) animation.dispose();
  await document.transform(prune(), reorder({ encoder: MeshoptEncoder }));
  document.getRoot().setExtras({ sourceSha256: sha(sourceBytes), geometry: 'optional distant low-preset car', maxErrorMetres,
    nearAssetUnchanged: true, lampGeometryUnchanged: true });
  document.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.FILTER });
  const bytes = declareQuantizedAttributes(await io.writeBinary(document)), outputId = `${id}-far-low`, file = path.join(values.out, `${outputId}.glb`);
  const validation = await validator.validateBytes(bytes, { maxIssues: 100 });
  if (validation.issues.numErrors) throw new Error(`${id}: ${JSON.stringify(validation.issues.messages.filter(issue => issue.severity === 0))}`);
  const report = { id: outputId, source, sourceSha256: sha(sourceBytes), file, sha256: sha(bytes), bytes: bytes.length,
    before: nodes.reduce((sum, node) => sum + node.before, 0), after: nodes.reduce((sum, node) => sum + node.after, 0),
    maxErrorMetres, validatorErrors: validation.issues.numErrors, validatorWarnings: validation.issues.numWarnings, nodes };
  if (report.after > 6500) throw new Error(`${id}: far geometry ${report.after} exceeds 6500 triangles`);
  if (sha(readFileSync(source)) !== report.sourceSha256) throw new Error(`${id}: source changed during build`);
  writeFileSync(file, bytes); reports.push(report);
  console.log(`${outputId}: ${report.before} -> ${report.after} triangles, ${bytes.length} bytes, max error ${maxErrorMetres} m`);
}
writeFileSync(path.join(values.out, 'report.json'), JSON.stringify({ toolSha256: sha(readFileSync(new URL(import.meta.url))), reports }, null, 2) + '\n');
