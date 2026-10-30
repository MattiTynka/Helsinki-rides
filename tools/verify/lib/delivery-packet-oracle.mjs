// Derived from the native optimized-world geometry verifier. New-only packets use separately verified lossless mip identity mappings.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const sha=b=>createHash('sha256').update(b).digest('hex');
let imageMap=new Map();
export function setImageMap(value){imageMap=value;}
const canonicalImageHash=b=>imageMap.get(sha(b))??sha(b);
function noNewWarnings(a, b, label) {for (const [code, count] of Object.entries(b.validation.warnings)) assert.ok(count <= (a.validation.warnings[code] ?? 0), `${label}: new ${code} warning`);}
function imageData(model, index) {
  const image = model.json.images[index];
  if (image.uri) return model.external.get(image.uri);
  const view = model.json.bufferViews[image.bufferView]; assert.equal(view.buffer, 0);
  return model.bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
}
function imageSignatures(model) {return model.document.getRoot().listTextures().map(texture => `${texture.getName()}:${texture.getMimeType()}:${canonicalImageHash(texture.getImage())}`).sort();}
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
    const image = index => {const item = structuredClone(model.json.images[index]); delete item.bufferView; delete item.uri; return {...item, contentSha256: canonicalImageHash(imageData(model, index))};};
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

export {compareCity,groundFaces};
