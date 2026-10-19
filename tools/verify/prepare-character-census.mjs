// Blender's glTF importer cannot read required KHR_texture_basisu. Produce a measurement-only
// copy with texture references removed; all binary data and every geometry/rig/action field stay exact.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { parseGlb } from './glb.ts';

const { values } = parseArgs({ options: { input: { type: 'string' }, out: { type: 'string' }, report: { type: 'string' } } });
if (!values.input || !values.out || !values.report) throw new Error('--input, --out and --report required');
if (existsSync(values.out) || existsSync(values.report)) throw new Error('Census copy/evidence must be new');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceBytes = readFileSync(values.input), source = parseGlb(sourceBytes);
assert.ok(source.bin);
const json = structuredClone(source.json);
delete json.images; delete json.textures;
for (const material of json.materials ?? []) {
  for (const key of ['normalTexture', 'occlusionTexture', 'emissiveTexture']) delete material[key];
  if (material.pbrMetallicRoughness) for (const key of ['baseColorTexture', 'metallicRoughnessTexture']) delete material.pbrMetallicRoughness[key];
}
for (const key of ['extensionsRequired', 'extensionsUsed']) if (json[key]) {
  json[key] = json[key].filter(name => name !== 'KHR_texture_basisu' && name !== 'EXT_texture_webp');
  if (!json[key].length) delete json[key];
}
const align = n => (n + 3) & ~3, text = Buffer.from(JSON.stringify(json)), jsonLength = align(text.length);
const output = Buffer.alloc(28 + jsonLength + align(source.bin.length));
output.writeUInt32LE(0x46546c67, 0); output.writeUInt32LE(2, 4); output.writeUInt32LE(output.length, 8);
output.writeUInt32LE(jsonLength, 12); output.writeUInt32LE(0x4e4f534a, 16); output.fill(0x20, 20, 20 + jsonLength); text.copy(output, 20);
output.writeUInt32LE(align(source.bin.length), 20 + jsonLength); output.writeUInt32LE(0x004e4942, 24 + jsonLength); Buffer.from(source.bin).copy(output, 28 + jsonLength);
const result = parseGlb(output);
assert.deepEqual(result.bin, source.bin, 'Census copy must retain every binary byte, including unreferenced image data');
const preservedFields = Object.keys(source.json).filter(key => !['images', 'textures', 'materials', 'extensionsRequired', 'extensionsUsed'].includes(key));
for (const key of preservedFields) assert.deepEqual(result.json[key], source.json[key], `${key} changed`);
assert.equal(result.json.materials.length, source.json.materials.length);
const report = { status: 'GEOMETRY_EQUIVALENT_MEASUREMENT_COPY', source: { file: values.input, sha256: sha(sourceBytes) }, copy: { file: values.out, sha256: sha(output) }, binarySha256: sha(source.bin), preservedFields,
  changes: 'Removed image/texture definitions, five PBR texture references and Basis/WebP extension declarations only. Original binary data, material count/names, all geometry, skin, transforms and animation are unchanged.',
  limits: 'Census can prove geometry/scale of this byte-equivalent representation; this copy must never be published or used as material/runtime appearance evidence.',
  verifierSha256: sha(readFileSync(new URL(import.meta.url))) };
mkdirSync(path.dirname(values.out), { recursive: true }); mkdirSync(path.dirname(values.report), { recursive: true });
writeFileSync(values.out, output, { flag: 'wx' }); writeFileSync(values.report, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(report, null, 2));
