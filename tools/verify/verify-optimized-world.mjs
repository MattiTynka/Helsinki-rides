// Static, independent acceptance of an immutable model-optimization derivative.
// Run with: node --max-old-space-size=640 --max-semi-space-size=16 --expose-gc tools/verify/verify-optimized-world.mjs
//   --source SOURCE_RELEASE --release DERIVATIVE_RELEASE --build-report BUILD_JSON
//   --far-report FAR_REPORT_JSON --out FRESH_JSON
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {gunzipSync} from 'node:zlib';
import {getHeapStatistics} from 'node:v8';
import {GLB_BUFFER, NodeIO} from '@gltf-transform/core';
import {ALL_EXTENSIONS} from '@gltf-transform/extensions';
import {MeshoptDecoder} from 'meshoptimizer';
import validator from 'gltf-validator';
import {validateWorldManifest, validateGameplayBundle} from '../../packages/world-schema/src/index.ts';
import {readFacadeGlb} from '../world/lib/facade-glb.ts';

const {values} = parseArgs({options: {
  source: {type: 'string'}, release: {type: 'string'}, 'build-report': {type: 'string'},
  'far-report': {type: 'string'}, out: {type: 'string'}, 'max-rss-mib': {type: 'string', default: '960'},
  cells: {type: 'string'},
}});
assert.ok(values.source && values.release && values['build-report'] && values['far-report'] && values.out, 'All source, release, report and output paths are required');
assert.ok(global.gc, 'Use --expose-gc for bounded, sequential model verification');
assert.ok(getHeapStatistics().heap_size_limit < 768 * 1024 ** 2, 'Use --max-old-space-size=640 --max-semi-space-size=16 (heap limit below 768 MiB)');
assert.ok(!fs.existsSync(values.out), 'Evidence output must be fresh');
const maximumRss = Number(values['max-rss-mib']) * 1024 ** 2;
assert.ok(Number.isFinite(maximumRss) && maximumRss > 0 && maximumRss <= 1024 ** 3, 'RSS budget must not exceed 1 GiB');
const sha = data => createHash('sha256').update(data).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const stableFiles = ['tools/world/optimize_release.ts', 'tools/world/lib/optimize-city-lods.ts', 'tools/world/lib/compact-glb.ts', 'tools/world/lib/compress-actor.ts', 'tools/world/lib/shared-textures.ts', 'tools/world/build_far_vehicles.mjs'];
const toolPins = Object.fromEntries(stableFiles.map(file => [file, sha(fs.readFileSync(file))]));
let peakRss = 0;
function memory() {peakRss = Math.max(peakRss, process.memoryUsage().rss, process.resourceUsage().maxRSS * 1024); assert.ok(peakRss <= maximumRss, `Verifier exceeded RSS budget: ${peakRss}`);}
function safePath(root, name) {
  assert.ok(typeof name === 'string' && name.length <= 240 && name.split('/').every(part => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part)), `Unsafe payload path: ${name}`);
  const file = path.resolve(root, ...name.split('/')); assert.ok(file.startsWith(root + path.sep));
  let current = root;
  for (const part of name.split('/')) {current = path.join(current, part); assert.ok(!fs.lstatSync(current).isSymbolicLink(), 'Symbolic links are forbidden');}
  assert.ok(fs.lstatSync(file).isFile(), 'Payload must be a regular file'); return file;
}
function refs(value, result = new Map()) {
  if (!value || typeof value !== 'object') return result;
  if (typeof value.path === 'string' && typeof value.sha256 === 'string') {
    assert.match(value.sha256, /^[a-f0-9]{64}$/); assert.ok(Number.isSafeInteger(value.bytes) && value.bytes > 0);
    if (result.has(value.path)) assert.deepEqual(result.get(value.path), {path: value.path, sha256: value.sha256, bytes: value.bytes});
    else result.set(value.path, {path: value.path, sha256: value.sha256, bytes: value.bytes});
  }
  for (const item of Object.values(value)) refs(item, result); return result;
}
function inventory(directory, relative = '') {
  return fs.readdirSync(path.join(directory, relative), {withFileTypes: true}).flatMap(entry => {
    assert.ok(!entry.isSymbolicLink(), 'Release inventory contains a symbolic link');
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return inventory(directory, name);
    assert.ok(entry.isFile()); return [name];
  }).sort();
}
function release(directory) {
  const root = path.resolve(directory), manifestBytes = fs.readFileSync(path.join(root, 'manifest.json')), manifest = JSON.parse(manifestBytes.toString());
  assert.deepEqual(validateWorldManifest(manifest), []);
  const pinned = refs(manifest);
  let bytes = manifestBytes.length;
  for (const ref of pinned.values()) {const data = fs.readFileSync(safePath(root, ref.path)); assert.equal(data.length, ref.bytes, `${ref.path}: stored bytes`); assert.equal(sha(data), ref.sha256, `${ref.path}: SHA-256`); bytes += data.length;}
  assert.deepEqual(inventory(root), ['manifest.json', ...pinned.keys()].sort(), 'Manifest must close over the entire release inventory');
  return {root, manifest, pinned, manifestSha256: sha(manifestBytes), bytes, payload: ref => fs.readFileSync(safePath(root, ref.path))};
}
const source = release(values.source), candidate = release(values.release), build = read(values['build-report']), farBuild = read(values['far-report']);
assert.equal(build.sourceManifestSha256, source.manifestSha256); assert.equal(build.manifestSha256, candidate.manifestSha256);
assert.equal(build.worldBytes, candidate.bytes);
assert.ok(source.manifest.cells.length >= 304); assert.equal(candidate.manifest.cells.length, source.manifest.cells.length);
assert.equal(build.cells.length, source.manifest.cells.length);
const selectedCells = values.cells ? new Set(values.cells.split(',')) : null;
assert.ok(!selectedCells || [...selectedCells].every(id => source.manifest.cells.some(cell => cell.id === id)), 'Unknown diagnostic cell');
assert.deepEqual(candidate.manifest.assets.map(asset => asset.id).sort(), [...new Set([...source.manifest.assets.map(asset => asset.id), 'vehicle-revontuli-far-low'])].sort(), 'Unexpected derivative asset inventory');
for (const key of ['schemaVersion', 'status', 'coordinateFrame', 'origin', 'cellSize', 'boundsRuntimeXZ', 'simulation', 'sources', 'attribution', 'lighting']) assert.deepEqual(candidate.manifest[key], source.manifest[key], `${key} must remain unchanged`);
const sourcePublication = new Map((source.manifest.publicationFiles ?? []).map(ref => [ref.path, ref]));
for (const [name, ref] of sourcePublication) assert.deepEqual(candidate.manifest.publicationFiles.find(item => item.path === name), ref, `Publication/source credit changed: ${name}`);
for (const key of ['roads', 'gameplay', 'scenery']) {assert.deepEqual(candidate.manifest[key], source.manifest[key]); assert.deepEqual(candidate.payload(candidate.manifest[key]), source.payload(source.manifest[key]));}
assert.deepEqual(validateGameplayBundle(JSON.parse(candidate.payload(candidate.manifest.gameplay))), []);
const without = (object, keys) => Object.fromEntries(Object.entries(object).filter(([key]) => !keys.includes(key)));
function simulation(ref, owner) {
  const data = owner.payload(ref), decoded = ref.compression === 'gzip' ? gunzipSync(data, {maxOutputLength: 64 * 1024 ** 2}) : data;
  if (ref.compression) {assert.equal(ref.compression, 'gzip'); assert.equal(decoded.length, ref.decodedBytes); assert.equal(sha(decoded), ref.decodedSha256);}
  return decoded;
}
const storageKeys = ['path', 'sha256', 'bytes', 'compression', 'decodedBytes', 'decodedSha256'];
assert.deepEqual(without(candidate.manifest.terrain, storageKeys), without(source.manifest.terrain, storageKeys));
assert.deepEqual(simulation(candidate.manifest.terrain, candidate), simulation(source.manifest.terrain, source));
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({'meshopt.decoder': MeshoptDecoder});
const validationCache = new Map(), textureUsage = new Set(), cells = [], assets = [];
function textureResource(owner, modelRef, uri) {
  assert.match(uri, /^\.\.\/textures\/[a-f0-9]{64}\.(?:ktx2|png|jpe?g|webp)$/);
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(modelRef.path), uri));
  assert.match(resolved, /^textures\/[a-f0-9]{64}\.(?:ktx2|png|jpe?g|webp)$/);
  const pin = owner.pinned.get(resolved); assert.ok(pin && owner.manifest.sharedTextures?.some(ref => ref.path === resolved), 'Image URI must resolve to an exact sharedTextures pin');
  assert.equal(path.posix.basename(resolved).split('.')[0], pin.sha256); textureUsage.add(`${owner.manifestSha256}:${resolved}`);
  return owner.payload(pin);
}
async function model(owner, ref) {
  const bytes = owner.payload(ref), parsed = readFacadeGlb(bytes), json = parsed.json;
  for (const buffer of json.buffers) assert.equal(buffer.uri, undefined, 'External GLB buffers are prohibited');
  const external = new Map(); for (const image of json.images ?? []) if (image.uri) external.set(image.uri, textureResource(owner, ref, image.uri));
  if (!validationCache.has(ref.sha256)) {
    const result = await validator.validateBytes(bytes, {maxIssues: 10000, externalResourceFunction: async uri => {
      assert.ok(external.has(uri), 'Validator requested an unpinned resource'); return external.get(uri);
    }});
    assert.equal(result.issues.numErrors, 0, `${ref.path}: ${JSON.stringify(result.issues.messages.filter(item => item.severity === 0))}`);
    const warnings = {}; for (const message of result.issues.messages) if (message.severity === 1) warnings[message.code] = (warnings[message.code] ?? 0) + 1;
    validationCache.set(ref.sha256, {errors: 0, warnings, warningCount: result.issues.numWarnings});
  }
  const jsonDocument = {json: structuredClone(json), resources: {[GLB_BUFFER]: parsed.bin}}; for (const [uri, data] of external) jsonDocument.resources[uri] = data;
  const document = await io.readJSON(jsonDocument);
  return {document, json, bin: parsed.bin, validation: validationCache.get(ref.sha256), external};
}
function noNewWarnings(a, b, label) {for (const [code, count] of Object.entries(b.validation.warnings)) assert.ok(count <= (a.validation.warnings[code] ?? 0), `${label}: new ${code} warning`);}
function imageData(model, index) {
  const image = model.json.images[index];
  if (image.uri) return model.external.get(image.uri);
  const view = model.json.bufferViews[image.bufferView]; assert.equal(view.buffer, 0);
  return model.bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
}
function imageSignatures(model) {return model.document.getRoot().listTextures().map(texture => `${texture.getName()}:${texture.getMimeType()}:${sha(texture.getImage())}`).sort();}
function materialSignature(model, materialIndex) {
  if (materialIndex === undefined) return '';
  const material = structuredClone(model.json.materials[materialIndex]);
  const pbr = material.pbrMetallicRoughness ??= {};
  pbr.baseColorFactor ??= [1, 1, 1, 1]; pbr.metallicFactor ??= 1; pbr.roughnessFactor ??= 1;
  material.emissiveFactor ??= [0, 0, 0]; material.alphaMode ??= 'OPAQUE'; material.alphaCutoff ??= .5; material.doubleSided ??= false;
  if (material.normalTexture) material.normalTexture.scale ??= 1;
  if (material.occlusionTexture) material.occlusionTexture.strength ??= 1;
  const texture = index => {
    const value = structuredClone(model.json.textures[index]);
    // NodeIO stores this redundant texture label on its image. Render identity and image source
    // metadata are retained; it may omit the optional sampler-level name when serializing.
    delete value.name;
    const image = index => {const item = structuredClone(model.json.images[index]); delete item.bufferView; delete item.uri; return {...item, contentSha256: sha(imageData(model, index))};};
    if (value.sampler !== undefined) value.sampler = model.json.samplers[value.sampler];
    if (value.source !== undefined) value.source = image(value.source);
    for (const name of ['KHR_texture_basisu', 'EXT_texture_webp', 'EXT_texture_avif']) if (value.extensions?.[name]) value.extensions[name].source = image(value.extensions[name].source);
    return value;
  };
  const visit = value => {if (!value || typeof value !== 'object') return; for (const [name, item] of Object.entries(value)) {
    if (name === 'extras') continue;
    if (name.endsWith('Texture') && item?.index !== undefined) {item.index = texture(item.index); item.texCoord ??= 0;} else visit(item);
  }}; visit(material);
  const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
  return JSON.stringify(sorted(material));
}
function positionKey(points) {return points.map(point => point.join(',')).sort().join('|');}
function primitiveData(primitive, reversible = false) {
  const position = primitive.getAttribute('POSITION'), count = position.getCount(), attributes = primitive.listSemantics().sort().map(name => [name, primitive.getAttribute(name)]);
  const descriptor = attributes.map(([name, accessor]) => `${name}:${accessor.getType()}:${accessor.getComponentType()}:${accessor.getNormalized()}`).join('|');
  const corners = Array.from({length: count}, (_, i) => attributes.map(([, accessor]) => Array.from(accessor.getArray().subarray(i * accessor.getElementSize(), (i + 1) * accessor.getElementSize())).join(',')).join('|'));
  const ids = primitive.getIndices()?.getArray() ?? Uint32Array.from({length: count}, (_, i) => i), triangles = [];
  for (let i = 0; i < ids.length; i += 3) {
    const vertices = [ids[i], ids[i + 1], ids[i + 2]], keys = vertices.map(id => corners[id]);
    const canonical = reversible ? keys.slice().sort().join(';') : [0, 1, 2].map(k => [keys[k], keys[(k + 1) % 3], keys[(k + 2) % 3]].join(';')).sort()[0];
    const points = vertices.map(id => position.getElement(id, []));
    triangles.push({key: sha(canonical), positions: positionKey(points), points, vertices});
  }
  return {descriptor, corners: new Set(corners), triangles, attributes, primitive};
}
function compareExact(a, b, label, reversible = false) {
  assert.equal(a.descriptor, b.descriptor, `${label}: attribute types`);
  const sourceKeys = new Set(a.triangles.map(t => t.key)), candidateKeys = new Set(b.triangles.map(t => t.key));
  assert.equal(sourceKeys.size, candidateKeys.size, `${label}: unique triangle count`);
  for (const key of sourceKeys) assert.ok(candidateKeys.has(key), `${label}: missing unique triangle or changed per-corner attributes/winding`);
  assert.ok(b.triangles.length <= a.triangles.length, `${label}: triangle multiplicity increased`);
  if (a.primitive.getMaterial()?.getAlphaMode() === 'BLEND') assert.equal(b.triangles.length, a.triangles.length, `${label}: blended multiplicity changed`);
  return a.triangles.length - b.triangles.length;
}
function primitives(model) {
  const result = [];
  for (const [nodeIndex, node] of model.document.getRoot().listNodes().entries()) {
    const rawNode = model.json.nodes[nodeIndex];
    for (const [index, primitive] of (node.getMesh()?.listPrimitives() ?? []).entries()) result.push({node, nodeIndex, index, primitive,
      material: materialSignature(model, model.json.meshes[rawNode.mesh].primitives[index].material)});
  }
  return result;
}
function nodeInvariant(a, b, label) {
  const left = a.document.getRoot().listNodes(), right = b.document.getRoot().listNodes(); assert.equal(right.length, left.length, `${label}: named hierarchy`);
  for (let i = 0; i < left.length; i++) {assert.equal(right[i].getName(), left[i].getName()); assert.deepEqual(right[i].getWorldMatrix(), left[i].getWorldMatrix()); assert.deepEqual(right[i].getExtras(), left[i].getExtras());}
}
function cross(a, b) {return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];}
const sub = (a, b) => a.map((value, i) => value - b[i]), dot = (a, b) => a.reduce((n, v, i) => n + v * b[i], 0);
function normal(triangle) {const n = cross(sub(triangle.points[1], triangle.points[0]), sub(triangle.points[2], triangle.points[0])), length = Math.hypot(...n); return n.map(v => v / (length || 1));}
function projection(point, triangle) {
  const [a, b, c] = triangle.points, u = sub(b, a), v = sub(c, a), w = sub(point, a);
  const uu = dot(u, u), uv = dot(u, v), vv = dot(v, v), wu = dot(w, u), wv = dot(w, v), denominator = uu * vv - uv * uv;
  if (Math.abs(denominator) < 1e-20) return null;
  const y = (vv * wu - uv * wv) / denominator, z = (uu * wv - uv * wu) / denominator, x = 1 - y - z;
  if (Math.min(x, y, z) < -1e-5 || Math.max(x, y, z) > 1.00001) return null;
  const projected = a.map((value, axis) => value * x + b[axis] * y + c[axis] * z);
  return {weights: [x, y, z], distance: Math.hypot(...sub(point, projected))};
}
function samples(triangle) {return [[1, 0, 0], [0, 1, 0], [0, 0, 1], [.5, .5, 0], [0, .5, .5], [.5, 0, .5], [1 / 3, 1 / 3, 1 / 3]].map(weights => ({weights, point: [0, 1, 2].map(axis => triangle.points.reduce((n, p, i) => n + p[axis] * weights[i], 0))}));}
function surfaceSamples(original, changed, target, limit, reversible, attributeLimit) {
  const bins = new Map(), binSize = 4;
  for (const triangle of target.triangles) {
    const xs = triangle.points.map(p => p[0]), zs = triangle.points.map(p => p[2]);
    for (let x = Math.floor((Math.min(...xs) - limit) / binSize); x <= Math.floor((Math.max(...xs) + limit) / binSize); x++) for (let z = Math.floor((Math.min(...zs) - limit) / binSize); z <= Math.floor((Math.max(...zs) + limit) / binSize); z++) {
      const key = `${x},${z}`, list = bins.get(key) ?? []; list.push(triangle); bins.set(key, list);
    }
  }
  let maximumDistance = 0, maximumAttributeError = 0, count = 0;
  const attributeValues = (data, triangle, weights) => data.attributes.filter(([name]) => name !== 'POSITION').flatMap(([, accessor]) => Array.from({length: accessor.getElementSize()}, (_, component) => triangle.vertices.reduce((n, vertex, i) => n + accessor.getElement(vertex, [])[component] * weights[i], 0)));
  for (const triangle of changed) for (const sample of samples(triangle)) {
    const sourceNormal = normal(triangle), expected = attributeValues(original, triangle, sample.weights);
    let bestDistance = Infinity, bestAttribute = Infinity;
    for (const candidate of bins.get(`${Math.floor(sample.point[0] / binSize)},${Math.floor(sample.point[2] / binSize)}`) ?? []) {
      const alignment = dot(sourceNormal, normal(candidate));
      // Geometric face normals are not a shading input for unlit, double-sided opaque coarse
      // meshes. Their full COLOR attributes and sampled surface distances remain constrained.
      // Lit/single-sided materials additionally require consistent projected face orientation.
      if (!reversible && alignment < .99) continue;
      const projected = projection(sample.point, candidate); if (!projected || projected.distance > limit + 1e-6) continue;
      const actual = attributeValues(target, candidate, projected.weights), error = Math.max(0, ...actual.map((value, i) => Math.abs(value - expected[i])));
      if (error <= attributeLimit + 1e-6 && projected.distance < bestDistance) {bestDistance = projected.distance; bestAttribute = error;}
    }
    assert.ok(bestDistance <= limit + 1e-6, `Changed LOD surface sample exceeds ${limit} m or attribute bound at ${sample.point}`);
    maximumDistance = Math.max(maximumDistance, bestDistance); maximumAttributeError = Math.max(maximumAttributeError, bestAttribute); count++;
  }
  return {samples: count, maximumDistance, maximumAttributeError};
}
async function compareCity(a, b, label, options = {}) {
  nodeInvariant(a, b, label); noNewWarnings(a, b, label);
  const sourceImages = new Set(imageSignatures(a));
  for (const signature of imageSignatures(b)) assert.ok(sourceImages.has(signature), `${label}: changed or invented image payload`);
  // Dead-image definitions and identical duplicates may be pruned. Active image bindings and
  // complete source metadata are checked through every retained primitive's material below.
  const left = primitives(a), right = primitives(b); assert.equal(right.length, left.length, `${label}: primitive inventory`);
  let removed = 0, changedFaces = 0, sampleCount = 0, maximumDistance = 0, maximumAttributeError = 0;
  const originalToDerivative = {samples: 0, maximumDistance: 0, maximumAttributeError: 0}, derivativeToOriginal = {...originalToDerivative};
  for (let i = 0; i < left.length; i++) {
    const p = left[i], q = right[i]; assert.equal(q.node.getName(), p.node.getName()); assert.equal(q.index, p.index); assert.equal(q.material, p.material, `${label}: material ${i}`);
    const material = p.primitive.getMaterial(), reversible = !!options.ground && material?.getDoubleSided() && !!material.getExtension('KHR_materials_unlit') && material.getAlphaMode() === 'OPAQUE';
    const before = primitiveData(p.primitive, reversible), after = primitiveData(q.primitive, reversible);
    if (!options.ground) {removed += compareExact(before, after, label); continue;}
    assert.equal(after.descriptor, before.descriptor); for (const corner of after.corners) assert.ok(before.corners.has(corner), `${label}: changed vertex or attribute`);
    const outputPoints = new Set(after.triangles.flatMap(triangle => triangle.points.map(point => point.join(','))));
    for (const point of before.triangles.flatMap(triangle => triangle.points)) if (options.bounds && [Math.abs(point[0] - options.bounds[0]), Math.abs(point[0] - options.bounds[2]), Math.abs(point[2] - options.bounds[1]), Math.abs(point[2] - options.bounds[3])].some(distance => distance < 1e-6)) assert.ok(outputPoints.has(point.join(',')), `${label}: cell-boundary vertex removed`);
    const beforeSet = new Set(before.triangles.map(t => t.key)), afterSet = new Set(after.triangles.map(t => t.key));
    const missing = before.triangles.filter(t => !afterSet.has(t.key)), added = after.triangles.filter(t => !beforeSet.has(t.key));
    for (const triangle of missing) assert.ok(options.ground.has(triangle.positions), `${label}: protected architecture or unmatched ground face removed`);
    if (!missing.length && !added.length) {removed += before.triangles.length - after.triangles.length; continue;}
    assert.ok(options.limit > 0, `${label}: surface changed without a bounded LOD contract`);
    const forward = surfaceSamples(before, missing, after, options.limit, reversible, options.attributeLimit);
    const reverse = surfaceSamples(after, added, before, options.limit, reversible, options.attributeLimit);
    for (const [total, direction] of [[originalToDerivative, forward], [derivativeToOriginal, reverse]]) {total.samples += direction.samples; total.maximumDistance = Math.max(total.maximumDistance, direction.maximumDistance); total.maximumAttributeError = Math.max(total.maximumAttributeError, direction.maximumAttributeError);}
    changedFaces += missing.length + added.length; sampleCount += forward.samples + reverse.samples;
    maximumDistance = Math.max(maximumDistance, forward.maximumDistance, reverse.maximumDistance);
    maximumAttributeError = Math.max(maximumAttributeError, forward.maximumAttributeError, reverse.maximumAttributeError);
  }
  return {duplicateTrianglesRemoved: removed, changedFaces, independentSamples: sampleCount, maximumDistance, maximumAttributeError, originalToDerivative, derivativeToOriginal};
}
function groundFaces(model) {
  const result = new Set(); for (const item of primitives(model)) if ([item.node.getName(), item.node.getMesh().getName(), item.primitive.getMaterial()?.getName() ?? ''].some(name => /_ground_/.test(name))) for (const triangle of primitiveData(item.primitive).triangles) result.add(triangle.positions); return result;
}
for (let index = 0; index < source.manifest.cells.length; index++) {
  const original = source.manifest.cells[index], next = candidate.manifest.cells[index], receipt = build.cells.find(cell => cell.id === original.id);
  if (selectedCells && !selectedCells.has(original.id)) continue;
  assert.deepEqual(without(next, ['visual', 'collision']), without(original, ['visual', 'collision']), `${original.id}: cell/building metadata`);
  assert.deepEqual(without(next.collision, storageKeys), without(original.collision, storageKeys));
  assert.deepEqual(simulation(next.collision, candidate), simulation(original.collision, source), `${original.id}: collision bytes`);
  const a = await model(source, original.visual.lod0), b = await model(candidate, next.visual.lod0), near = await compareCity(a, b, `${original.id}/near`), ground = groundFaces(a);
  const midSource = original.visual.lod1 && original.visual.lod1.triangles <= next.visual.lod1.triangles ? original.visual.lod1 : original.visual.lod0;
  let mid;
  if (next.visual.lod1.path === next.visual.lod0.path) mid = {aliasNear: true};
  else {const left = midSource.path === original.visual.lod0.path ? a : await model(source, midSource); const right = await model(candidate, next.visual.lod1); mid = await compareCity(left, right, `${original.id}/mid`, {ground, limit: .001, attributeLimit: .002, bounds: original.boundsXZ});}
  const farA = await model(source, original.visual.lod2), farB = await model(candidate, next.visual.lod2);
  const far = await compareCity(farA, farB, `${original.id}/far`, {ground, limit: .01, attributeLimit: .02, bounds: original.boundsXZ});
  for (const tier of ['mid', 'far']) {const stats = receipt.stats[tier]; assert.ok(stats.boundaryPreserved && stats.maxMeasuredDeviationMetres <= stats.errorLimitMetres + 1e-6); assert.ok(stats.maxAttributeDeviation <= (tier === 'far' ? .02 : .002) + 1e-6);}
  cells.push({id: original.id, near, mid, far});
  console.log(`${index + 1}/${source.manifest.cells.length} ${original.id}: exact near; ${far.changedFaces} changed far faces; ${far.independentSamples} measured samples`);
  global.gc(); memory();
}
for (const original of source.manifest.assets) {
  if (original.id.endsWith('-far-low')) continue;
  const next = candidate.manifest.assets.find(item => item.id === original.id); assert.ok(next && next.kind === original.kind);
  const a = await model(source, original), b = await model(candidate, next); noNewWarnings(a, b, original.id);
  if (original.kind !== 'character' && original.kind !== 'vehicle') assert.equal(next.sha256, original.sha256);
  else {
    assert.equal(next.optimization?.sourceSha256, original.sha256); assert.equal(next.optimization?.lossless, true);
    const left = a.document.getRoot().listAccessors(), right = b.document.getRoot().listAccessors(); assert.equal(right.length, left.length);
    for (let i = 0; i < left.length; i++) {const p = left[i], q = right[i]; assert.equal(q.getName(), p.getName()); assert.equal(q.getType(), p.getType()); assert.equal(q.getComponentType(), p.getComponentType()); assert.equal(q.getNormalized(), p.getNormalized()); const x = p.getArray(), y = q.getArray(); assert.deepEqual(Buffer.from(y.buffer, y.byteOffset, y.byteLength), Buffer.from(x.buffer, x.byteOffset, x.byteLength), `${original.id}: accessor ${i} bit identity`);}
    for (const key of ['asset', 'accessors', 'nodes', 'scenes', 'skins', 'animations', 'meshes', 'materials', 'textures', 'samplers', 'extras']) assert.deepEqual(b.json[key], a.json[key], `${original.id}: ${key}`);
    assert.deepEqual(imageSignatures(b), imageSignatures(a));
    if (original.kind === 'character') assert.equal(b.document.getRoot().listAnimations().length, 17);
  }
  assets.push({id: original.id, accessorCount: b.document.getRoot().listAccessors().length, clips: b.document.getRoot().listAnimations().length, validation: b.validation});
  global.gc(); memory();
}
function lampGeometry(model) {
  return primitives(model).filter(item => item.primitive.getMaterial()?.getName().startsWith('car_lamp')).map(item => ({node: item.node.getName(), matrix: item.node.getWorldMatrix(), material: item.primitive.getMaterial().getName(), triangles: primitiveData(item.primitive).triangles.map(triangle => triangle.positions).sort()})).sort((a, b) => (a.node + a.material).localeCompare(b.node + b.material));
}
for (const id of ['vehicle-lumi-gt', 'vehicle-patrol', 'vehicle-revontuli']) {
  const original = source.manifest.assets.find(item => item.id === id), next = candidate.manifest.assets.find(item => item.id === `${id}-far-low`), report = farBuild.reports.find(item => item.id === `${id}-far-low`);
  assert.ok(next && report); assert.equal(report.sourceSha256, original.sha256); assert.equal(report.sha256, next.sha256); assert.ok(report.after <= 6500 && report.maxErrorMetres === .03); assert.ok(report.nodes.every(node => node.measuredErrorMetres <= .030001));
  const a = await model(source, original), b = await model(candidate, next); assert.deepEqual(lampGeometry(b), lampGeometry(a), `${id}: exact lamps/transforms`);
  assert.equal(b.json.extras.sourceSha256, original.sha256); assert.ok(b.document.getRoot().listAccessors().every(accessor => accessor.getCount() > 0));
  assets.push({id: next.id, triangles: report.after, measuredErrorMetres: Math.max(...report.nodes.map(node => node.measuredErrorMetres)), lampPrimitivesExact: lampGeometry(b).length, validation: b.validation});
  global.gc(); memory();
}
if (!selectedCells) for (const ref of candidate.manifest.sharedTextures ?? []) assert.ok(textureUsage.has(`${candidate.manifestSha256}:${ref.path}`), 'Unreferenced shared texture pin');
for (const [file, digest] of Object.entries(toolPins)) assert.equal(sha(fs.readFileSync(file)), digest, `${file}: tool changed during verification`);
assert.equal(sha(fs.readFileSync(path.join(source.root, 'manifest.json'))), source.manifestSha256);
assert.equal(sha(fs.readFileSync(path.join(candidate.root, 'manifest.json'))), candidate.manifestSha256);
const evidence = {schemaVersion: 1, status: selectedCells ? 'PARTIAL' : 'PASS', checkedCellSubset: selectedCells ? [...selectedCells] : null, sourceRelease: source.manifest.worldReleaseId, sourceManifestSha256: source.manifestSha256, derivativeRelease: candidate.manifest.worldReleaseId, derivativeManifestSha256: candidate.manifestSha256, sourceBytes: source.bytes, derivativeBytes: candidate.bytes, cellsChecked: cells.length, payloadsChecked: {source: source.pinned.size, derivative: candidate.pinned.size}, sharedTexturesChecked: candidate.manifest.sharedTextures?.length ?? 0, uniqueModelsValidated: validationCache.size, collisionAndTerrainDecodedExact: true, metadataGameplayRoadsSceneryCreditsExact: true, nearUniqueOrientedCompleteAttributeSurfacesExact: true, boundedFarSurfaceSamples: cells.reduce((n, cell) => n + cell.far.independentSamples, 0), maximumFarSurfaceDeviationMetres: Math.max(...cells.map(cell => cell.far.maximumDistance)), peakRssBytes: peakRss, maximumRssBytes: maximumRss, heapLimitBytes: getHeapStatistics().heap_size_limit, toolPins, verifierSha256: sha(fs.readFileSync(new URL(import.meta.url))), limitations: ['Static asset and sampled LOD surface verification; no GPU timing, visual route or runtime claim.', 'Source surfaces contain accepted overlaps and nonmanifold repairs; no full watertight/manifold claim.', 'Changed LOD faces sampled at vertices, edge midpoints and centroid in both directions; no mathematical continuous Hausdorff bound.'], cells, assets};
fs.mkdirSync(path.dirname(path.resolve(values.out)), {recursive: true}); fs.writeFileSync(values.out, JSON.stringify(evidence, null, 2) + '\n', {flag: 'wx'});
console.log(JSON.stringify({...evidence, cells: undefined, assets: undefined}));
