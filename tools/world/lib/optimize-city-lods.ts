// Offline index-only ground LODs. Collision and accepted source files are never changed.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Logger, NodeIO, type Document, type Primitive} from '@gltf-transform/core';
import {ALL_EXTENSIONS, EXTMeshoptCompression} from '@gltf-transform/extensions';
import {compactPrimitive, prune, weldPrimitive} from '@gltf-transform/functions';
import {MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier} from 'meshoptimizer';

type Bounds = readonly [number, number, number, number];
type Vec = readonly [number, number, number];
interface PrimitiveStats {
  node: string;
  before: number;
  after: number;
  protectedTriangles: number;
  duplicateTrianglesRemoved: number;
  lockedVertices: number;
  maxMeasuredDeviationMetres: number;
  maxAttributeDeviation: number;
  accepted: boolean;
}
export interface CityLodStats {
  beforeTriangles: number;
  afterTriangles: number;
  /** Candidate count before the optional 2% intermediate/far export threshold. */
  trialAfterTriangles?: number;
  beforeBytes: number;
  afterBytes: number;
  errorLimitMetres: number;
  maxMeasuredDeviationMetres: number;
  maxAttributeDeviation: number;
  boundaryPreserved: true;
  primitives: PrimitiveStats[];
}
export interface OptimizedCityLods {
  /** Null when a separate intermediate file would save fewer than 2% of triangles. */
  lod1: Uint8Array | null;
  lod2: Uint8Array;
  stats: {mid: CityLodStats; far: CityLodStats; matchedFarGroundTriangles: number};
}
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const vertexKey = (p: ArrayLike<number>, i: number) => `${p[i * 3]},${p[i * 3 + 1]},${p[i * 3 + 2]}`;
function triangleKey(p: ArrayLike<number>, a: number, b: number, c: number): string {
  const keys = [vertexKey(p, a), vertexKey(p, b), vertexKey(p, c)];
  // Opposite winding is deliberately a different triangle.
  return [0, 1, 2].map(i => [keys[i], keys[(i + 1) % 3], keys[(i + 2) % 3]].join('|')).sort()[0]!;
}
function indices(p: Primitive): Uint32Array {
  return p.getIndices() ? Uint32Array.from(p.getIndices()!.getArray()!) : Uint32Array.from({length: p.getAttribute('POSITION')!.getCount()}, (_, i) => i);
}
function normal(p: Float32Array, a: number, b: number, c: number): Vec {
  const ux = p[b * 3]! - p[a * 3]!, uy = p[b * 3 + 1]! - p[a * 3 + 1]!, uz = p[b * 3 + 2]! - p[a * 3 + 2]!;
  const vx = p[c * 3]! - p[a * 3]!, vy = p[c * 3 + 1]! - p[a * 3 + 1]!, vz = p[c * 3 + 2]! - p[a * 3 + 2]!;
  const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx, length = Math.hypot(x, y, z);
  return length ? [x / length, y / length, z / length] : [0, 0, 0];
}
function edgeMap(ids: Uint32Array, positions: Float32Array) {
  const edges = new Map<string, {count: number; a: number; b: number; normals: Vec[]}>();
  for (let i = 0; i < ids.length; i += 3) {
    const n = normal(positions, ids[i]!, ids[i + 1]!, ids[i + 2]!);
    for (let k = 0; k < 3; k++) {
      const a = ids[i + k]!, b = ids[i + (k + 1) % 3]!, ka = vertexKey(positions, a), kb = vertexKey(positions, b), key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      const edge = edges.get(key) ?? {count: 0, a, b, normals: []};
      edge.count++; edge.normals.push(n); edges.set(key, edge);
    }
  }
  return edges;
}
function boundary(ids: Uint32Array, p: Float32Array): string[] {
  // Include non-manifold edges: simplification must not "repair" authored overlapping closures.
  return [...edgeMap(ids, p)].filter(([, e]) => e.count !== 2).map(([key, e]) => `${key}:${e.count}`).sort();
}
function imageHashes(doc: Document): string[] {
  return doc.getRoot().listTextures().map(texture => `${texture.getName()}:${texture.getMimeType()}:${hash(texture.getImage()!)}`).sort();
}
function triangleCount(doc: Document): number {
  return doc.getRoot().listNodes().reduce((sum, node) => sum + (node.getMesh()?.listPrimitives().reduce((n, p) => n + indices(p).length / 3, 0) ?? 0), 0);
}
function isGround(node: string, mesh: string, material: string): boolean {
  return [node, mesh, material].some(name => /_ground_/.test(name));
}
function deduplicatePrimitive(doc: Document, primitive: Primitive, far: boolean, groundKeys?: Set<string>) {
  const positions = primitive.getAttribute('POSITION')!.getArray()!, welded = indices(primitive), uniqueIds: number[] = [], seen = new Set<string>(), material = primitive.getMaterial();
  const reversible = far && material?.getDoubleSided() && !!material.getExtension('KHR_materials_unlit') && material.getAlphaMode() === 'OPAQUE';
  let removed = 0;
  for (let i = 0; i < welded.length; i += 3) {
    const a = welded[i]!, b = welded[i + 1]!, c = welded[i + 2]!;
    // Matching welded indices prove identical position, UV, normal and colour data.
    const ground = !groundKeys || groundKeys.has(triangleKey(positions, a, b, c));
    const key = reversible ? [a, b, c].sort((x, y) => x - y).join(',') : [0, 1, 2].map(k => [welded[i + k], welded[i + (k + 1) % 3], welded[i + (k + 2) % 3]].join(',')).sort()[0]!;
    if (ground && material?.getAlphaMode() !== 'BLEND' && seen.has(key)) {removed++; continue;}
    seen.add(key); uniqueIds.push(a, b, c);
  }
  if (removed) primitive.setIndices(doc.createAccessor().setBuffer(doc.getRoot().listBuffers()[0]!).setType('SCALAR').setArray(Uint32Array.from(uniqueIds)));
  return removed;
}

/** Compare original vertex, edge-midpoint and centroid samples to the candidate surface.
 * This supplements Meshopt's approximate error metric with measured world-space height and
 * interpolated attribute checks, including vertical risers and retaining walls. */
function measureDeviation(before: Uint32Array, after: Uint32Array, p: Float32Array, attrs: Float32Array, stride: number, limit: number, attributeLimit: number) {
  const bins = new Map<string, number[]>(), size = 4;
  for (let t = 0; t < after.length; t += 3) {
    const a = after[t]!, b = after[t + 1]!, c = after[t + 2]!;
    const x0 = Math.floor((Math.min(p[a * 3]!, p[b * 3]!, p[c * 3]!) - limit) / size), x1 = Math.floor((Math.max(p[a * 3]!, p[b * 3]!, p[c * 3]!) + limit) / size);
    const z0 = Math.floor((Math.min(p[a * 3 + 2]!, p[b * 3 + 2]!, p[c * 3 + 2]!) - limit) / size), z1 = Math.floor((Math.max(p[a * 3 + 2]!, p[b * 3 + 2]!, p[c * 3 + 2]!) + limit) / size);
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
      const key = `${x},${z}`, bin = bins.get(key) ?? []; bin.push(t); bins.set(key, bin);
    }
  }
  let maxMeasuredDeviationMetres = 0, maxAttributeDeviation = 0;
  const weights = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [.5, .5, 0], [0, .5, .5], [.5, 0, .5], [1 / 3, 1 / 3, 1 / 3]];
  for (let t = 0; t < before.length; t += 3) for (const w of weights) {
    const old = [before[t]!, before[t + 1]!, before[t + 2]!];
    const x = old.reduce((v, id, i) => v + p[id * 3]! * w[i]!, 0), y = old.reduce((v, id, i) => v + p[id * 3 + 1]! * w[i]!, 0), z = old.reduce((v, id, i) => v + p[id * 3 + 2]! * w[i]!, 0);
    const expected = Array.from({length: stride}, (_, k) => old.reduce((v, id, i) => v + attrs[id * stride + k]! * w[i]!, 0));
    let bestError = Infinity, bestAttribute = Infinity;
    for (const candidate of bins.get(`${Math.floor(x / size)},${Math.floor(z / size)}`) ?? []) {
      const a = after[candidate]!, b = after[candidate + 1]!, c = after[candidate + 2]!;
      const ax = p[a * 3]!, ay = p[a * 3 + 1]!, az = p[a * 3 + 2]!;
      const ux = p[b * 3]! - ax, uy = p[b * 3 + 1]! - ay, uz = p[b * 3 + 2]! - az, vx = p[c * 3]! - ax, vy = p[c * 3 + 1]! - ay, vz = p[c * 3 + 2]! - az;
      const wx = x - ax, wy = y - ay, wz = z - az, d00 = ux * ux + uy * uy + uz * uz, d01 = ux * vx + uy * vy + uz * vz, d11 = vx * vx + vy * vy + vz * vz;
      const d20 = wx * ux + wy * uy + wz * uz, d21 = wx * vx + wy * vy + wz * vz, d = d00 * d11 - d01 * d01; if (Math.abs(d) < 1e-20) continue;
      const v = (d11 * d20 - d01 * d21) / d, q = (d00 * d21 - d01 * d20) / d, u = 1 - v - q;
      if (Math.min(u, v, q) < -1e-7 || Math.max(u, v, q) > 1 + 1e-7) continue;
      const error = Math.hypot(x - (u * ax + v * p[b * 3]! + q * p[c * 3]!), y - (u * ay + v * p[b * 3 + 1]! + q * p[c * 3 + 1]!), z - (u * az + v * p[b * 3 + 2]! + q * p[c * 3 + 2]!));
      let attributeError = 0;
      for (let k = 0; k < stride; k++) attributeError = Math.max(attributeError, Math.abs(expected[k]! - (u * attrs[a * stride + k]! + v * attrs[b * stride + k]! + q * attrs[c * stride + k]!)));
      if (error <= limit + 1e-7 && attributeError <= attributeLimit + 1e-7 && error + attributeError < bestError + bestAttribute) {bestError = error; bestAttribute = attributeError;}
    }
    if (!Number.isFinite(bestError)) return null;
    maxMeasuredDeviationMetres = Math.max(maxMeasuredDeviationMetres, bestError); maxAttributeDeviation = Math.max(maxAttributeDeviation, bestAttribute);
  }
  return {maxMeasuredDeviationMetres, maxAttributeDeviation};
}

function simplifyGround(doc: Document, primitive: Primitive, node: string, bounds: Bounds, far: boolean, groundKeys?: Set<string>): PrimitiveStats {
  const originalCount = indices(primitive).length / 3;
  const rejected: PrimitiveStats = {node, before: originalCount, after: originalCount, protectedTriangles: 0, duplicateTrianglesRemoved: 0, lockedVertices: 0, maxMeasuredDeviationMetres: 0, maxAttributeDeviation: 0, accepted: false};
  if (primitive.getMaterial()?.getAlphaMode() === 'BLEND') return rejected;
  assert.equal(primitive.getMode(), 4, 'Only triangle city primitives are supported');
  assert.equal(primitive.listTargets().length, 0, 'City ground must not have morph targets');
  const attributeNames = primitive.listSemantics();
  assert.ok(attributeNames.every(s => ['POSITION', 'NORMAL', 'TEXCOORD_0', 'COLOR_0'].includes(s)), 'Unknown city ground attribute');
  // Exact all-attribute welding respects material, normal, UV and colour seams.
  weldPrimitive(primitive, {overwrite: true});
  const position = primitive.getAttribute('POSITION')!;
  assert.ok(position.getArray() instanceof Float32Array && !position.getNormalized(), 'Unquantized native Float32 POSITION required');
  const positions = position.getArray() as Float32Array, vertices = position.getCount(), locks = new Uint8Array(vertices), eligible: number[] = [], protectedIds: number[] = [];
  rejected.duplicateTrianglesRemoved = deduplicatePrimitive(doc, primitive, far, groundKeys);
  const old = indices(primitive);
  if (rejected.duplicateTrianglesRemoved) {
    rejected.after = old.length / 3; rejected.accepted = true;
  }
  const selectedAttrs = attributeNames.filter(s => s !== 'POSITION').map(s => primitive.getAttribute(s)!);
  const stride = selectedAttrs.reduce((sum, a) => sum + a.getElementSize(), 0), attributes = new Float32Array(vertices * stride);
  for (let i = 0; i < vertices; i++) {let offset = i * stride; for (const attr of selectedAttrs) {const values = attr.getElement(i, []); attributes.set(values, offset); offset += values.length;}}
  for (let i = 0; i < old.length; i += 3) {
    const a = old[i]!, b = old[i + 1]!, c = old[i + 2]!, n = normal(positions, a, b, c);
    // Exact triangle provenance is necessary in the merged distant primitive. Never
    // simplify an architectural face merely because it happens to be horizontal.
    const isMatchedGround = !groundKeys || groundKeys.has(triangleKey(positions, a, b, c));
    if (!isMatchedGround || Math.hypot(...n) === 0) {protectedIds.push(a, b, c); locks[a] = locks[b] = locks[c] = 1;}
    else eligible.push(a, b, c);
  }
  rejected.protectedTriangles = protectedIds.length / 3;
  if (eligible.length < 18) return rejected;
  const source = Uint32Array.from(eligible), edges = edgeMap(source, positions);
  for (const edge of edges.values()) {
    const crease = edge.normals.some(n => Math.abs(n[0] * edge.normals[0]![0] + n[1] * edge.normals[0]![1] + n[2] * edge.normals[0]![2]) < (far ? .9659258262890683 : .9961946980917455));
    if (edge.count !== 2 || crease) locks[edge.a] = locks[edge.b] = 1;
  }
  for (let i = 0; i < vertices; i++) {
    const x = positions[i * 3]!, z = positions[i * 3 + 2]!;
    if (Math.abs(x - bounds[0]) < 1e-6 || Math.abs(x - bounds[2]) < 1e-6 || Math.abs(z - bounds[1]) < 1e-6 || Math.abs(z - bounds[3]) < 1e-6) locks[i] = 1;
  }
  rejected.lockedVertices = locks.reduce((sum, value) => sum + value, 0);
  const limit = far ? .01 : .001, target = Math.floor(source.length * (far ? .08 : .3) / 3) * 3;
  const [candidate, error] = MeshoptSimplifier.simplifyWithAttributes(source, positions, 3, attributes, stride, Array(stride).fill(1), locks, target, limit, ['LockBorder', 'ErrorAbsolute', 'Sparse']);
  if (candidate.length >= source.length || error > limit + 1e-7) return rejected;
  if (JSON.stringify(boundary(candidate, positions)) !== JSON.stringify(boundary(source, positions))) return rejected;
  const deviation = measureDeviation(source, candidate, positions, attributes, stride, limit, far ? .02 : .002);
  if (!deviation) return rejected;
  const output = Uint32Array.from([...protectedIds, ...candidate]);
  const outputKeys = new Set<string>();
  for (let i = 0; i < output.length; i += 3) outputKeys.add(triangleKey(positions, output[i]!, output[i + 1]!, output[i + 2]!));
  for (let i = 0; i < protectedIds.length; i += 3) assert.ok(outputKeys.has(triangleKey(positions, protectedIds[i]!, protectedIds[i + 1]!, protectedIds[i + 2]!)), 'Protected stair, wall or architectural triangle changed');
  primitive.setIndices(doc.createAccessor().setBuffer(doc.getRoot().listBuffers()[0]!).setType('SCALAR').setArray(output));
  compactPrimitive(primitive);
  return {...rejected, ...deviation, after: output.length / 3, accepted: true};
}

/** Builds optional intermediate and far derivatives in memory, one cell per call.
 * Preserves retained vertices/attributes bit for bit; only indices and unused resources change.
 * Stair/curb crease vertices, primitive outlines and cell boundaries remain exact. */
export async function optimizeCityLods(input: {lod0: Uint8Array; lod2: Uint8Array; boundsXZ: Bounds}): Promise<OptimizedCityLods> {
  assert.ok(input.boundsXZ.length === 4 && input.boundsXZ.every(Number.isFinite) && input.boundsXZ[0] < input.boundsXZ[2] && input.boundsXZ[1] < input.boundsXZ[3], 'Invalid cell bounds');
  await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready, MeshoptSimplifier.ready]);
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder});
  const mid = await io.readBinary(input.lod0), far = await io.readBinary(input.lod2), groundKeys = new Set<string>();
  mid.setLogger(new Logger(Logger.Verbosity.ERROR)); far.setLogger(new Logger(Logger.Verbosity.ERROR));
  const midImages = imageHashes(mid), farImages = imageHashes(far);
  const makeStats = (doc: Document, bytes: Uint8Array, error: number): CityLodStats => ({beforeTriangles: triangleCount(doc), afterTriangles: triangleCount(doc), beforeBytes: bytes.byteLength, afterBytes: bytes.byteLength, errorLimitMetres: error, maxMeasuredDeviationMetres: 0, maxAttributeDeviation: 0, boundaryPreserved: true, primitives: []});
  const midStats = makeStats(mid, input.lod0, .001), farStats = makeStats(far, input.lod2, .01);
  for (const node of mid.getRoot().listNodes()) if (node.getMesh()) {
    if (!node.getWorldMatrix().every((v, i) => v === identity[i])) continue;
    for (const primitive of node.getMesh()!.listPrimitives()) {
      if (!isGround(node.getName(), node.getMesh()!.getName(), primitive.getMaterial()?.getName() ?? '')) continue;
      const positions = primitive.getAttribute('POSITION')!.getArray()!;
      const ids = indices(primitive);
      for (let i = 0; i < ids.length; i += 3) groundKeys.add(triangleKey(positions, ids[i]!, ids[i + 1]!, ids[i + 2]!));
      midStats.primitives.push(simplifyGround(mid, primitive, node.getName(), input.boundsXZ, false));
    }
  }
  let matchedFarGroundTriangles = 0;
  for (const node of far.getRoot().listNodes()) if (node.getMesh()) {
    if (!node.getWorldMatrix().every((v, i) => v === identity[i])) continue;
    for (const primitive of node.getMesh()!.listPrimitives()) {
      const positions = primitive.getAttribute('POSITION')!.getArray()!, ids = indices(primitive);
      for (let i = 0; i < ids.length; i += 3) if (groundKeys.has(triangleKey(positions, ids[i]!, ids[i + 1]!, ids[i + 2]!))) matchedFarGroundTriangles++;
      farStats.primitives.push(simplifyGround(far, primitive, node.getName(), input.boundsXZ, true, groundKeys));
    }
  }
  async function finish(doc: Document, original: Uint8Array, stats: CityLodStats, images: string[]) {
    stats.afterTriangles = triangleCount(doc);
    stats.trialAfterTriangles = stats.afterTriangles;
    stats.maxMeasuredDeviationMetres = Math.max(0, ...stats.primitives.map(p => p.maxMeasuredDeviationMetres));
    stats.maxAttributeDeviation = Math.max(0, ...stats.primitives.map(p => p.maxAttributeDeviation));
    if (stats.afterTriangles >= stats.beforeTriangles * .98) return null;
    await doc.transform(prune({propertyTypes: ['Accessor'], keepAttributes: true, keepLeaves: true}));
    // No quantize(), no lossy meshopt position filter. Retained Float32 positions are exact.
    doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({method: EXTMeshoptCompression.EncoderMethod.QUANTIZE});
    const bytes = await io.writeBinary(doc), decoded = await io.readBinary(bytes);
    assert.deepEqual(imageHashes(decoded), images, 'Accepted image bytes changed');
    assert.equal(triangleCount(decoded), stats.afterTriangles);
    for (const mesh of decoded.getRoot().listMeshes()) for (const p of mesh.listPrimitives()) assert.equal(p.getAttribute('POSITION')!.getComponentType(), 5126, 'POSITION quantization is prohibited');
    stats.afterBytes = bytes.byteLength; return bytes;
  }
  const lod1 = await finish(mid, input.lod0, midStats, midImages), lod2 = await finish(far, input.lod2, farStats, farImages);
  // Aliased fallback stats describe the actual bytes returned, rather than an unexported trial.
  function restoreAliasedStats(stats: CityLodStats, bytes: Uint8Array) {
    stats.afterTriangles = stats.beforeTriangles; stats.afterBytes = bytes.byteLength;
    stats.maxMeasuredDeviationMetres = stats.maxAttributeDeviation = 0;
    for (const p of stats.primitives) {p.after = p.before; p.accepted = false; p.duplicateTrianglesRemoved = 0; p.maxMeasuredDeviationMetres = p.maxAttributeDeviation = 0;}
  }
  if (!lod1) restoreAliasedStats(midStats, input.lod0);
  if (!lod2) restoreAliasedStats(farStats, input.lod2);
  return {lod1, lod2: lod2 ?? input.lod2.slice(), stats: {mid: midStats, far: farStats, matchedFarGroundTriangles}};
}

/** Zero surface-error cleanup for the detailed tier. Opposite windings, differing
 * per-corner attributes, materials and blended surfaces remain distinct. */
export async function optimizeExactCityMesh(input: Uint8Array): Promise<{bytes: Uint8Array; stats: CityLodStats}> {
  await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready]);
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder});
  const doc = await io.readBinary(input), images = imageHashes(doc);
  doc.setLogger(new Logger(Logger.Verbosity.ERROR));
  assert.equal(doc.getRoot().listAnimations().length, 0, 'City cleanup is restricted to static models');
  assert.equal(doc.getRoot().listSkins().length, 0, 'City cleanup is restricted to static models');
  const beforeTriangles = triangleCount(doc), primitives: PrimitiveStats[] = [];
  for (const mesh of doc.getRoot().listMeshes()) for (const primitive of mesh.listPrimitives()) {
    if (primitive.getMode() !== 4 || primitive.getMaterial()?.getAlphaMode() === 'BLEND') continue;
    assert.equal(primitive.listTargets().length, 0, 'City cleanup must not alter morph targets');
    const before = indices(primitive).length / 3;
    weldPrimitive(primitive, {overwrite: true});
    const removed = deduplicatePrimitive(doc, primitive, false);
    if (removed) compactPrimitive(primitive);
    primitives.push({node: mesh.getName(), before, after: before - removed, protectedTriangles: 0, duplicateTrianglesRemoved: removed, lockedVertices: 0, maxMeasuredDeviationMetres: 0, maxAttributeDeviation: 0, accepted: removed > 0});
  }
  const stats: CityLodStats = {beforeTriangles, afterTriangles: triangleCount(doc), beforeBytes: input.byteLength, afterBytes: input.byteLength, errorLimitMetres: 0, maxMeasuredDeviationMetres: 0, maxAttributeDeviation: 0, boundaryPreserved: true, primitives};
  if (stats.afterTriangles === stats.beforeTriangles) return {bytes: input.slice(), stats};
  await doc.transform(prune({propertyTypes: ['Accessor'], keepAttributes: true, keepLeaves: true}));
  doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({method: EXTMeshoptCompression.EncoderMethod.QUANTIZE});
  const bytes = await io.writeBinary(doc), decoded = await io.readBinary(bytes);
  assert.deepEqual(imageHashes(decoded), images, 'Accepted image bytes changed');
  assert.equal(triangleCount(decoded), stats.afterTriangles);
  stats.afterBytes = bytes.byteLength;
  return {bytes, stats};
}
