// Package the accepted original Snow/Rain derivatives for a small streamed street population.
// Never overwrites sources; Snow uses an index-only NPC reduction with exact retained skin attributes.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import sharp from 'sharp';
import { encodeToKTX2 } from 'ktx2-encoder';
import { readFacadeGlb, replaceFacadeImages } from '../world/lib/facade-glb.ts';
import { compressActor } from '../world/lib/compress-actor.ts';
import { simplifySnowCivilian } from './simplify_civilian.ts';
import { compactGlb } from '../world/lib/compact-glb.ts';
import { addJumpPoses, spliceLocomotionClips } from './civilian_clips.ts';

// --locomotion holds the motion-design exports civilian-{snow,rain}-locomotion.glb; --native is the hero Snow GLB the
// jump poses were authored on (content/assets/civilian-flee.motion.json records both).
const { values } = parseArgs({ options: { source: { type: 'string' }, out: { type: 'string' }, locomotion: { type: 'string' }, native: { type: 'string' } } });
assert.ok(values.source && values.out && values.locomotion && values.native, '--source, --locomotion, --native and --out required');
assert.ok(!existsSync(values.out), 'Use a new output directory');
mkdirSync(values.out, { recursive: true });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const align = n => Math.ceil(n / 4) * 4;
function pack(json, bin) {
  const text = Buffer.from(JSON.stringify(json)), padded = Buffer.alloc(align(text.length), 32); text.copy(padded);
  const out = Buffer.alloc(28 + padded.length + align(bin.length));
  out.writeUInt32LE(0x46546c67, 0); out.writeUInt32LE(2, 4); out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(padded.length, 12); out.writeUInt32LE(0x4e4f534a, 16); padded.copy(out, 20);
  out.writeUInt32LE(align(bin.length), 20 + padded.length); out.writeUInt32LE(0x004e4942, 24 + padded.length); out.set(bin, 28 + padded.length);
  return out;
}
const motion = JSON.parse(readFileSync(new URL('../../content/assets/civilian-flee.motion.json', import.meta.url), 'utf8'));
const poseBytes = readFileSync(new URL('../../content/assets/snow-jump-poses.json', import.meta.url));
assert.equal(sha(poseBytes), motion.jumps.posesSha256, 'Jump poses differ from the recorded set');
const jumpPoses = JSON.parse(poseBytes.toString('utf8')), nativeBytes = readFileSync(values.native), native = readFacadeGlb(nativeBytes);
const JUMP_CLIPS = Object.keys(jumpPoses.clips).filter(key => !key.startsWith('super_'));
const receipts = [];
for (const [variant, original] of [['rain-black', 'rain'], ['rain-white', 'rain'], ['snow-black', 'snow']]) {
  const originalSource = readFileSync(path.join(values.source, `character-${original}.glb`));
  const reduced = original === 'snow' ? await simplifySnowCivilian(originalSource) : null;
  // Walkers never drive or wield weapons. Preserve their three used clips exactly and remove only unreachable sampler
  // buffers, rather than shipping seven unused actions; fleeing adds the Kimodo run and sprint and Snow's jump poses.
  const selected = readFacadeGlb(reduced?.bytes ?? originalSource);
  selected.json.animations = selected.json.animations.filter(clip => ['idle', 'walk', 'death'].includes(clip.name));
  assert.deepEqual(selected.json.animations.map(clip => clip.name).sort(), ['death', 'idle', 'walk']);
  const rig = motion.rigs[original], exportBytes = readFileSync(path.join(values.locomotion, `civilian-${original}-locomotion.glb`));
  assert.equal(sha(originalSource), rig.sourceSha256, `${variant}: source differs from the recorded rig`);
  assert.equal(sha(exportBytes), rig.exportSha256, `${variant}: locomotion export differs from the reviewed one`);
  const locomotion = spliceLocomotionClips(selected, exportBytes, motion.clips.map(clip => ({ name: clip.name, clipSpeed: rig.clipSpeed[clip.name], naturalSpeed: clip.naturalSpeed })));
  const jumps = addJumpPoses(selected, jumpPoses, native);
  assert.deepEqual(selected.json.animations.map(clip => clip.name).sort(), ['death', 'idle', 'run', 'sprint', 'walk', ...JUMP_CLIPS].sort());
  const source = compactGlb(pack(selected.json, selected.bin)).bytes;
  const parsed = readFacadeGlb(source), replacements = new Map(), images = [];
  for (const [index, image] of parsed.json.images.entries()) {
    const view = parsed.json.bufferViews[image.bufferView];
    const bytes = parsed.bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
    const face = /skin|eyes/.test(image.name), cap = 512;
    const { data, info } = await sharp(bytes).resize({ width: cap, height: cap, fit: 'inside', withoutEnlargement: true }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let modified = 0;
    if (variant === 'rain-white' && /skin/.test(image.name)) {
      // Restrict the lighter complexion to warm skin texels, leaving dark eyebrows and neutral details intact.
      for (let p = 0; p < data.length; p += 4) {
        const [r, g, b] = [data[p], data[p + 1], data[p + 2]];
        if (r < 65 || r < g * 1.05 || g < b * 1.04) continue;
        const weight = Math.min(1, (r - 65) / 55);
        for (let c = 0; c < 3; c++) data[p + c] = Math.min(255, Math.round(data[p + c] + weight * (255 - data[p + c]) * [0.42, 0.37, 0.33][c]));
        modified++;
      }
      assert.ok(modified > 100, 'Skin variant must affect the actual source atlas');
    }
    const options = { isUASTC: face, generateMipmap: true, isPerceptual: true, isSetKTX2SRGBTransferFunc: true,
      needSupercompression: face, uastcLDRQualityLevel: 2, qualityLevel: 255, compressionLevel: 2 };
    const stdout = process.stdout.write;
    let encoded;
    process.stdout.write = () => true;
    try { encoded = await encodeToKTX2(data, { ...options, imageDecoder: async () => ({ width: info.width, height: info.height, data }) }); }
    finally { process.stdout.write = stdout; }
    replacements.set(index, encoded);
    images.push({ name: image.name, width: info.width, height: info.height, bytes: encoded.length, sha256: sha(encoded), modifiedSkinPixels: modified });
  }
  // This helper independently checks every non-image byte remains exact.
  const textureOnly = readFacadeGlb(replaceFacadeImages(source, replacements)), json = textureOnly.json;
  for (const image of json.images) image.mimeType = 'image/ktx2';
  for (const texture of json.textures) { texture.extensions = { KHR_texture_basisu: { source: texture.source } }; delete texture.source; }
  json.extensionsUsed = [...new Set([...(json.extensionsUsed ?? []), 'KHR_texture_basisu'])];
  json.extensionsRequired = [...new Set([...(json.extensionsRequired ?? []), 'KHR_texture_basisu'])];
  json.asset.copyright = `${original === 'rain' ? 'Rain' : 'Snow'} © Blender Studio, CC BY 4.0; civilian derivative by Helsinki Rides; movement adapted from Quaternius Universal Animation Library, CC0-1.0; run and sprint from Snow's supplied NVIDIA Kimodo-SOMA-RP-v1.2 motion; jump and climb poses adapted from Snow's`;
  const ready = pack(json, textureOnly.bin), compressed = await compressActor(ready);
  const id = `character-civilian-${variant}`, output = `${id}.glb`;
  writeFileSync(path.join(values.out, output), compressed.bytes, { flag: 'wx' });
  receipts.push({ id, output, sourceSha256: sha(originalSource), simplification: reduced?.receipt ?? null, sha256: sha(compressed.bytes), bytes: compressed.bytes.length,
    joints: json.skins[0].joints.length, triangles: json.meshes.flatMap(m => m.primitives).reduce((n, p) => n + json.accessors[p.indices].count / 3, 0),
    clips: json.animations.map(a => a.name), locomotion, jumps, images, compression: compressed.receipt });
  console.log(`${id}: ${compressed.bytes.length} bytes, ${json.skins[0].joints.length} joints`);
}
writeFileSync(path.join(values.out, 'receipt.json'), JSON.stringify({ status: 'PACKAGED_REQUIRES_RUNTIME_REVIEW', nativeSha256: sha(nativeBytes), assets: receipts }, null, 2) + '\n', { flag: 'wx' });
