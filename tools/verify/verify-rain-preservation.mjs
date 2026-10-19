// Independent preservation gate. There are no approved Rain geometry, skin or motion exceptions.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { parseGlb } from './glb.ts';

export const RAIN_SOURCE_SHA256 = 'c2aec924a23100aeae0d1ea9d006af5aea3dd6b37c76359a3bf262b679fe1e58';
const ADDITIONS = ['aim', 'fire', 'hit', 'death', 'drive', 'arrested'];
const SOCKETS = { SOCKET_HAND_R: 'DEF-Hand.R', SOCKET_HEAD: 'DEF-Head' };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const omit = (value, keys) => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));

function viewBytes(glb, index) {
  const view = glb.json.bufferViews[index], offset = view?.byteOffset ?? 0;
  assert.ok(view && view.buffer === 0 && Number.isInteger(offset) && offset >= 0 && Number.isInteger(view.byteLength) && view.byteLength > 0 && offset + view.byteLength <= glb.bin.length, `Invalid embedded buffer view ${index}`);
  return Buffer.from(glb.bin.subarray(offset, offset + view.byteLength));
}

/** Keep texture identity and sampler mapping while allowing WEBP -> KTX2 re-encoding. */
function logicalTexture(texture) {
  const result = structuredClone(texture);
  const sources = [result.source, result.extensions?.EXT_texture_webp?.source, result.extensions?.KHR_texture_basisu?.source].filter(value => value !== undefined);
  assert.equal(sources.length, 1, 'A texture must retain one unambiguous source image');
  result.source = sources[0];
  if (result.extensions) {
    delete result.extensions.EXT_texture_webp; delete result.extensions.KHR_texture_basisu;
    if (!Object.keys(result.extensions).length) delete result.extensions;
  }
  return result;
}

export function verifyNativeRainData(sourceBytes, candidateBytes) {
  assert.equal(sha(sourceBytes), RAIN_SOURCE_SHA256, 'Unexpected supplied Rain source revision');
  const source = parseGlb(sourceBytes), candidate = parseGlb(candidateBytes);
  const before = source.json, after = candidate.json;
  assert.ok(source.bin && candidate.bin, 'Both GLBs require embedded binary data');
  assert.equal(before.skins.length, 1); assert.equal(before.skins[0].joints.length, 70);
  assert.equal(before.animations.length, 11);
  for (const section of ['meshes', 'skins', 'materials', 'samplers'])
    assert.deepEqual(after[section], before[section], `Original ${section} declarations changed`);
  assert.deepEqual(after.accessors.slice(0, before.accessors.length), before.accessors, 'Original accessor declarations changed');
  assert.deepEqual(after.animations.slice(0, before.animations.length), before.animations, 'Original animation channels or samplers changed');
  assert.equal(after.animations.length, before.animations.length + ADDITIONS.length, 'Exactly six gameplay clips may be appended');
  assert.deepEqual(after.animations.slice(before.animations.length).map(clip => clip.name).sort(), [...ADDITIONS].sort(), 'Unexpected gameplay clip additions');
  for (const clip of after.animations.slice(before.animations.length)) {
    assert.ok(clip.channels.length > 0 && clip.samplers.length > 0, `${clip.name}: empty gameplay clip`);
    for (const channel of clip.channels) {
      assert.ok(Number.isInteger(channel.target.node) && channel.target.node >= 0 && channel.target.node < before.nodes.length, `${clip.name}: unexpected animation target`);
      assert.ok(['translation', 'rotation', 'scale'].includes(channel.target.path), `${clip.name}: unexpected channel path`);
      assert.ok(clip.samplers[channel.sampler], `${clip.name}: missing sampler`);
    }
  }

  const imageViews = new Set(before.images.map(image => image.bufferView));
  let exactViews = 0, exactBytes = 0;
  for (const [index, original] of before.bufferViews.entries()) {
    if (imageViews.has(index)) continue;
    const next = after.bufferViews[index];
    assert.ok(next, `Missing original buffer view ${index}`);
    assert.deepEqual(omit(next, ['byteOffset']), omit(original, ['byteOffset']), `Original buffer view ${index} layout changed`);
    const bytes = viewBytes(source, index), nextBytes = viewBytes(candidate, index);
    assert.ok(bytes.equals(nextBytes), `Original non-image buffer view ${index} bytes changed; no geometry/skin/motion exceptions are permitted`);
    exactViews++; exactBytes += bytes.length;
  }

  assert.equal(after.nodes.length, before.nodes.length + 2, 'Only the two gameplay sockets may be appended');
  const socketIndices = new Map(after.nodes.slice(before.nodes.length).map((node, i) => [node.name, before.nodes.length + i]));
  assert.deepEqual([...socketIndices.keys()].sort(), Object.keys(SOCKETS).sort(), 'Unexpected appended nodes');
  for (const [name, parentName] of Object.entries(SOCKETS)) {
    const index = socketIndices.get(name), socket = after.nodes[index];
    assert.deepEqual(Object.keys(socket).sort(), ['name', 'rotation', 'scale', 'translation'], `${name}: socket cannot add mesh, skin, hierarchy or runtime extensions`);
    assert.ok(socket.translation.length === 3 && socket.translation.every(Number.isFinite), `${name}: invalid position`);
    assert.ok(socket.rotation.length === 4 && socket.rotation.every(Number.isFinite) && Math.abs(Math.hypot(...socket.rotation) - 1) <= 1e-5, `${name}: invalid rotation`);
    assert.deepEqual(socket.scale, [1, 1, 1], `${name}: unexpected scale`);
    const parents = after.nodes.flatMap((node, i) => node.children?.includes(index) ? [i] : []);
    assert.deepEqual(parents, [before.nodes.findIndex(node => node.name === parentName)], `${name}: incorrect socket parent`);
  }
  for (const [index, node] of before.nodes.entries()) {
    const next = structuredClone(after.nodes[index]);
    if (next.children) next.children = next.children.filter(child => child < before.nodes.length);
    if (!node.children && !next.children?.length) delete next.children;
    assert.deepEqual(next, node, `Original rest node ${node.name} changed`);
  }
  assert.equal(after.scene, before.scene, 'Default scene changed');
  assert.equal(after.scenes.length, before.scenes.length, 'Scene count changed');
  for (const [index, scene] of before.scenes.entries()) {
    assert.deepEqual(omit(after.scenes[index], ['extras']), omit(scene, ['extras']), `Scene ${index} graph changed`);
    const extras = after.scenes[index].extras;
    assert.deepEqual(Object.keys(extras ?? {}), ['characterProfile'], 'Only declared runtime profile extras replace the source authoring metadata');
    assert.equal(extras.characterProfile.id, 'rain-native-v1');
    assert.equal(extras.characterProfile.upperBodyRoot, 'DEF-Spine1');
    assert.equal(extras.characterProfile.phaseGroup, 'left-strike');
  }

  assert.equal(after.images.length, before.images.length, 'Image count changed');
  const reencodedImages = [];
  for (const [index, image] of before.images.entries()) {
    const next = after.images[index];
    assert.deepEqual(omit(next, ['mimeType']), omit(image, ['mimeType']), `Image ${index} identity or buffer mapping changed`);
    assert.ok(['image/webp', 'image/ktx2'].includes(next.mimeType), `Unexpected image encoding ${next.mimeType}`);
    const original = viewBytes(source, image.bufferView), encoded = viewBytes(candidate, next.bufferView);
    reencodedImages.push({ name: image.name, sourceSha256: sha(original), candidateSha256: sha(encoded), sourceBytes: original.length, candidateBytes: encoded.length, encoding: next.mimeType });
  }
  assert.deepEqual(after.textures.map(logicalTexture), before.textures.map(logicalTexture), 'Texture image or sampler mapping changed');
  const codecNames = extensions => (extensions ?? []).map(name => ['EXT_texture_webp', 'KHR_texture_basisu'].includes(name) ? 'IMAGE_ENCODING' : name).sort();
  for (const section of ['extensionsUsed', 'extensionsRequired']) assert.deepEqual(codecNames(after[section]), codecNames(before[section]), `Unexpected ${section} change`);
  assert.deepEqual(omit(after.asset, ['generator', 'copyright']), omit(before.asset, ['generator', 'copyright']), 'Asset metadata changed outside generator/attribution');
  assert.equal(after.buffers.length, 1, 'An external or additional buffer is not permitted');
  assert.deepEqual(omit(after.buffers[0], ['byteLength']), omit(before.buffers[0], ['byteLength']), 'Buffer declaration changed beyond repacking length');
  assert.ok(Number.isInteger(after.buffers[0].byteLength) && candidate.bin.length - after.buffers[0].byteLength >= 0 && candidate.bin.length - after.buffers[0].byteLength < 4, 'Declared binary length does not match embedded data');
  const handled = ['asset', 'scene', 'scenes', 'nodes', 'animations', 'meshes', 'skins', 'materials', 'samplers', 'accessors', 'bufferViews', 'images', 'textures', 'buffers', 'extensionsUsed', 'extensionsRequired'];
  assert.deepEqual(omit(after, handled), omit(before, handled), 'Unexpected top-level document change');
  return {
    sourceNodes: before.nodes.length, nativeJoints: 70, meshes: before.meshes.length, materials: before.materials.length,
    nativeClips: before.animations.map(clip => clip.name), appendedClips: after.animations.slice(before.animations.length).map(clip => clip.name),
    originalAccessors: before.accessors.length, byteExactNonImageBufferViews: exactViews, byteExactNonImageBytes: exactBytes,
    approvedGeometrySkinMotionExceptions: [], appendedSockets: [...socketIndices.keys()], images: reencodedImages,
    scope: 'All original mesh attributes, topology, skin weights/joints, inverse binds, rest nodes, material properties, texture assignments and all eleven native animation sampler bytes remain exact.',
    limits: ['Image re-encoding is allowed; texture appearance needs separate visual review.', 'New gameplay pose quality, collisions, runtime behavior and source garment seams are not certified by byte preservation.'],
  };
}

function main() {
  const { values } = parseArgs({ options: {
    source: { type: 'string', default: 'data/raw/rain-native-20261017/rain.glb' }, candidate: { type: 'string' }, out: { type: 'string' },
  } });
  if (!values.candidate || !values.out) throw new Error('--candidate and a fresh --out report are required');
  if (existsSync(values.out)) throw new Error('Evidence report already exists');
  const source = readFileSync(values.source), candidate = readFileSync(values.candidate);
  const report = { status: 'FAIL', checkedAt: new Date().toISOString(), source: { path: values.source, sha256: sha(source) }, candidate: { path: values.candidate, sha256: sha(candidate) }, verifierSha256: sha(readFileSync(new URL(import.meta.url))) };
  try {
    report.preservation = verifyNativeRainData(source, candidate);
    report.status = 'PASS';
    console.log(`PASS Rain: ${report.preservation.byteExactNonImageBufferViews} original views exact; 70 joints, 11 native clips; no geometry, skin or motion exceptions`);
  } catch (error) {
    report.failure = error instanceof Error ? error.message : String(error);
    console.error(`FAIL Rain preservation: ${report.failure}`); process.exitCode = 1;
  }
  mkdirSync(path.dirname(values.out), { recursive: true });
  writeFileSync(values.out, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
