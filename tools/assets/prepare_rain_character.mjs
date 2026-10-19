// Adapt the supplied Poliisi Rain without retargeting or changing its eleven native animations.
// Preserve geometry, skin and uniform materials; append gameplay clips and encode textures.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import sharp from 'sharp';
import { encodeToKTX2 } from 'ktx2-encoder';
import { readFacadeGlb, replaceFacadeImages } from '../world/lib/facade-glb.ts';

const { values } = parseArgs({ options: Object.fromEntries(['source', 'supplement', 'profile', 'out', 'texture-cache', 'uniform-patch'].map(k => [k, { type: 'string' }])) });
for (const key of ['source', 'supplement', 'profile', 'out']) if (!values[key]) throw new Error(`--${key} required`);
if (existsSync(values.out)) throw new Error('Use a fresh output directory');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceBytes = readFileSync(values.source);
const sourceSha256 = sha(sourceBytes);
assert.equal(sourceSha256, 'c2aec924a23100aeae0d1ea9d006af5aea3dd6b37c76359a3bf262b679fe1e58', 'Unexpected Rain source revision');
const original = readFacadeGlb(sourceBytes);
const supplementBytes = readFileSync(values.supplement);
const supplement = JSON.parse(supplementBytes);
assert.equal(supplement.sourceSha256, sourceSha256, 'Gameplay supplement must use this source rig');
const profileBytes = readFileSync(values.profile);
const profile = JSON.parse(profileBytes);
assert.equal(profile.id, 'rain-native-v1');
assert.equal(profile.upperBodyRoot, 'DEF-Spine1');
const nativeClips = ['idle', 'jog', 'jog_back', 'jog_left', 'jog_right', 'run', 'sprint', 'strafe_left', 'strafe_right', 'walk', 'walk_back'];
assert.deepEqual(original.json.animations.map(a => a.name).sort(), nativeClips.slice().sort());
const requiredAdditions = ['aim', 'fire', 'hit', 'death', 'drive', 'arrested'];
assert.deepEqual(supplement.clips.map(a => a.name).sort(), requiredAdditions.slice().sort());

const imageUses = new Map();
for (const material of original.json.materials) {
  for (const [kind, info] of [['baseColor', material.pbrMetallicRoughness?.baseColorTexture], ['linear', material.pbrMetallicRoughness?.metallicRoughnessTexture], ['normal', material.normalTexture]]) {
    if (!info) continue;
    const texture = original.json.textures[info.index];
    const image = texture.extensions?.EXT_texture_webp?.source ?? texture.source;
    assert.ok(Number.isInteger(image));
    if (imageUses.has(image)) assert.equal(imageUses.get(image), kind, 'Image used in incompatible colour spaces');
    imageUses.set(image, kind);
  }
}
const replacements = new Map(), textures = [];
const patchBytes = values['uniform-patch'] ? readFileSync(values['uniform-patch']) : null;
const uniformPatch = patchBytes ? JSON.parse(patchBytes) : null;
if (uniformPatch) {
  assert.equal(uniformPatch.schemaVersion, 1);
  assert.equal(uniformPatch.sourceSha256, sourceSha256);
  assert.equal(uniformPatch.affectedMesh, 'RAIN-body_game');
  assert.equal(uniformPatch.image.name, 'rain_skin_basecolor');
  assert.ok(Number.isInteger(uniformPatch.image.index));
  assert.equal(original.json.images[uniformPatch.image.index]?.name, uniformPatch.image.name);
}
const encoderSha256 = sha(readFileSync('node_modules/ktx2-encoder/package.json'));
if (values['texture-cache']) mkdirSync(values['texture-cache'], { recursive: true });
// Encode serially: Basis' WASM allocation and logging are process-wide.
for (const [i, image] of original.json.images.entries()) {
  const use = imageUses.get(i);
  assert.ok(use, `Unclassified source image ${image.name}`);
  const view = original.json.bufferViews[image.bufferView];
  const source = original.bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
  let colourSource = source;
  if (uniformPatch?.image.index === i) {
    assert.equal(use, 'baseColor'); assert.equal(image.name, uniformPatch.image.name);
    assert.equal(sha(source), uniformPatch.image.sourceImageSha256);
    const replacement = readFileSync(uniformPatch.replacement.path), maskBytes = readFileSync(uniformPatch.mask.path);
    assert.equal(sha(replacement), uniformPatch.replacement.sha256); assert.equal(sha(maskBytes), uniformPatch.mask.sha256);
    const before = await sharp(source).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const after = await sharp(replacement).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const mask = await sharp(maskBytes).removeAlpha().greyscale().raw().toBuffer({ resolveWithObject: true });
    for (const decoded of [before, after, mask]) {
      assert.equal(decoded.info.width, uniformPatch.image.width); assert.equal(decoded.info.height, uniformPatch.image.height);
    }
    let changed = 0;
    for (let pixel = 0; pixel < mask.data.length; pixel++) {
      const offset = pixel * 4;
      assert.equal(before.data[offset + 3], after.data[offset + 3], 'uniform correction cannot alter alpha');
      const differs = [0, 1, 2].some(channel => before.data[offset + channel] !== after.data[offset + channel]);
      assert.equal(differs, mask.data[pixel] !== 0, 'changed pixels must exactly match the reviewed uniform mask');
      if (differs) changed++;
    }
    assert.equal(changed, uniformPatch.changedPixels);
    assert.ok(changed > 0 && changed < mask.data.length * .03, 'bounded underarm colour correction only');
    colourSource = replacement;
  }
  const cap = use === 'baseColor' ? 1024 : 512;
  const { data, info } = await sharp(colourSource).resize({ width: cap, height: cap, fit: 'inside', withoutEnlargement: true }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  // Keep face/eyes and vector/data maps in UASTC. High-quality ETC1S on the clothing
  // albedo saves transfer/GPU memory while retaining the original material and UVs.
  const uastc = use !== 'baseColor' || !/rain_(top|jeans|shoes|scarf)_basecolor/.test(image.name);
  const options = { isUASTC: uastc, generateMipmap: true, isPerceptual: use === 'baseColor', isSetKTX2SRGBTransferFunc: use === 'baseColor', isNormalMap: use === 'normal', needSupercompression: uastc, uastcLDRQualityLevel: 2, qualityLevel: 255, compressionLevel: 2 };
  const key = sha(JSON.stringify({ rgba: sha(data), width: info.width, height: info.height, options, encoderSha256 }));
  const cache = values['texture-cache'] ? path.join(values['texture-cache'], `${key}.ktx2`) : null;
  let encoded;
  if (cache && existsSync(cache)) {
    encoded = readFileSync(cache);
    assert.equal(sha(encoded), JSON.parse(readFileSync(`${cache}.json`)).sha256, 'Texture cache hash mismatch');
  } else {
    const stdout = process.stdout.write;
    process.stdout.write = () => true;
    try { encoded = await encodeToKTX2(data, { ...options, imageDecoder: async () => ({ width: info.width, height: info.height, data }) }); }
    finally { process.stdout.write = stdout; }
    if (cache) {
      writeFileSync(cache, encoded, { flag: 'wx' });
      writeFileSync(`${cache}.json`, JSON.stringify({ sha256: sha(encoded), key }) + '\n', { flag: 'wx' });
    }
  }
  replacements.set(i, encoded);
  textures.push({ name: image.name, use, width: info.width, height: info.height, sourceSha256: sha(source), colourSourceSha256: sha(colourSource), encodedSha256: sha(encoded), bytes: encoded.length, options });
  console.log(`Encoded ${image.name}: ${info.width}x${info.height} ${use}, ${encoded.length} bytes`);
}
const textureOnly = readFacadeGlb(replaceFacadeImages(sourceBytes, replacements));
const json = textureOnly.json;
for (const image of json.images) image.mimeType = 'image/ktx2';
for (const texture of json.textures) {
  const source = texture.extensions.EXT_texture_webp.source;
  delete texture.extensions.EXT_texture_webp;
  texture.extensions.KHR_texture_basisu = { source };
}
for (const key of ['extensionsUsed', 'extensionsRequired']) json[key] = [...new Set(json[key].map(x => x === 'EXT_texture_webp' ? 'KHR_texture_basisu' : x))];

// Keep every source buffer view and accessor, appending gameplay tracks to the BIN tail.
const align = n => (n + 3) & ~3;
const pieces = [Buffer.from(textureOnly.bin), Buffer.alloc(align(textureOnly.bin.length) - textureOnly.bin.length)];
let length = align(textureOnly.bin.length);
const appendAccessor = (values, width, type, bounds = false) => {
  assert.ok(values.length > 0 && values.length % width === 0 && values.every(Number.isFinite));
  const array = new Float32Array(values);
  const bytes = Buffer.from(array.buffer);
  const bufferView = json.bufferViews.length;
  json.bufferViews.push({ buffer: 0, byteOffset: length, byteLength: bytes.length });
  pieces.push(bytes); length += bytes.length;
  const accessor = { bufferView, componentType: 5126, count: values.length / width, type };
  if (bounds) { accessor.min = [Math.min(...values)]; accessor.max = [Math.max(...values)]; }
  json.accessors.push(accessor);
  return json.accessors.length - 1;
};
for (const clip of supplement.clips) {
  const channels = [], samplers = [];
  for (const track of clip.tracks) {
    const node = json.nodes.findIndex(n => n.name === track.node);
    assert.ok(node >= 0, `Missing native animation target ${track.node}`);
    assert.ok(['translation', 'rotation', 'scale'].includes(track.path));
    const width = track.path === 'rotation' ? 4 : 3;
    assert.equal(track.values.length, track.times.length * width);
    assert.ok(track.times.every((v, i) => v >= 0 && (!i || v > track.times[i - 1])));
    const input = appendAccessor(track.times, 1, 'SCALAR', true);
    const output = appendAccessor(track.values, width, width === 4 ? 'VEC4' : 'VEC3');
    channels.push({ sampler: samplers.length, target: { node, path: track.path } });
    samplers.push({ input, output, interpolation: 'LINEAR' });
  }
  json.animations.push({ name: clip.name, channels, samplers });
}
for (const socket of supplement.sockets) {
  const parent = json.nodes.findIndex(n => n.name === socket.parent);
  assert.ok(parent >= 0 && !json.nodes.some(n => n.name === socket.name));
  const index = json.nodes.length;
  json.nodes.push({ name: socket.name, translation: socket.translation, rotation: socket.rotation, scale: socket.scale ?? [1, 1, 1] });
  (json.nodes[parent].children ??= []).push(index);
}
assert.deepEqual(supplement.sockets.map(s => s.name).sort(), ['SOCKET_HAND_R', 'SOCKET_HEAD']);
for (const scene of json.scenes) scene.extras = { characterProfile: profile };
json.asset.copyright = 'Rain: Blender Studio, CC BY 4.0; supplied Poliisi uniform and native motion adaptation. See source ledger.';
json.asset.generator = 'Helsinki Rain adapter; preserves native Rain rig and eleven supplied animation tracks';
json.buffers[0].byteLength = length;
const bin = Buffer.concat(pieces), text = Buffer.from(JSON.stringify(json)), jsonLength = align(text.length);
const result = Buffer.alloc(28 + jsonLength + align(bin.length));
result.writeUInt32LE(0x46546c67, 0); result.writeUInt32LE(2, 4); result.writeUInt32LE(result.length, 8);
result.writeUInt32LE(jsonLength, 12); result.writeUInt32LE(0x4e4f534a, 16); result.fill(0x20, 20, 20 + jsonLength); text.copy(result, 20);
result.writeUInt32LE(align(bin.length), 20 + jsonLength); result.writeUInt32LE(0x004e4942, 24 + jsonLength); bin.copy(result, 28 + jsonLength);
const final = readFacadeGlb(result);
assert.deepEqual(final.json.meshes, original.json.meshes, 'Mesh declarations changed');
assert.deepEqual(final.json.materials, original.json.materials, 'Material properties changed');
assert.deepEqual(final.json.skins, original.json.skins, 'Skin declarations changed');
assert.deepEqual(final.json.animations.slice(0, nativeClips.length), original.json.animations, 'Supplied animation channels changed');
assert.deepEqual(final.json.accessors.slice(0, original.json.accessors.length), original.json.accessors, 'Original accessors changed');
const imageViews = new Set(original.json.images.map(i => i.bufferView));
let preservedViews = 0;
for (const [i, before] of original.json.bufferViews.entries()) {
  if (imageViews.has(i)) continue;
  const after = final.json.bufferViews[i];
  assert.deepEqual(Buffer.from(final.bin.subarray(after.byteOffset ?? 0, (after.byteOffset ?? 0) + after.byteLength)), Buffer.from(original.bin.subarray(before.byteOffset ?? 0, (before.byteOffset ?? 0) + before.byteLength)), `Source buffer view ${i} changed`);
  preservedViews++;
}
for (const [i, node] of original.json.nodes.entries()) {
  const after = structuredClone(final.json.nodes[i]);
  if (after.children) after.children = after.children.filter(n => n < original.json.nodes.length);
  if (!node.children && after.children?.length === 0) delete after.children;
  assert.deepEqual(after, node, `Source rest node ${node.name} changed`);
}
const { validateBytes } = await import('gltf-validator');
const validation = await validateBytes(result, { maxIssues: 100 });
assert.equal(validation.issues.numErrors, 0, JSON.stringify(validation.issues));
mkdirSync(values.out, { recursive: true });
writeFileSync(path.join(values.out, 'character-rain.glb'), result, { flag: 'wx' });
const report = { status: 'EXPORTED_REQUIRES_RUNTIME_REVIEW', assetId: 'character-rain', displayName: 'Rain', source: { file: values.source, sha256: sourceSha256 }, supplement: { file: values.supplement, sha256: sha(supplementBytes) }, profile: { file: values.profile, sha256: sha(profileBytes) }, output: { bytes: result.length, sha256: sha(result) }, nativeClips, additionalClips: requiredAdditions, textures, uniformPatch: uniformPatch ? { file: values['uniform-patch'], sha256: sha(patchBytes), changedPixels: uniformPatch.changedPixels, image: uniformPatch.image.name } : null, preservation: { vertexAttributes: 'byte-exact', topology: 'byte-exact', inverseBindsAndRestSkeleton: 'exact', skinWeights: 'byte-exact', suppliedAnimationTracks: 'byte-exact', sourceNonImageBufferViews: preservedViews, byteExactNonImageBufferViews: preservedViews }, validation: validation.issues, sourceFiles: Object.fromEntries(['tools/assets/prepare_rain_character.mjs', 'tools/world/lib/facade-glb.ts'].map(f => [f, sha(readFileSync(f))])) };
writeFileSync(path.join(values.out, 'rain-build-report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ status: report.status, bytes: result.length, sha256: sha(result), nativeClips: nativeClips.length, additionalClips: requiredAdditions.length, preservedViews }));
