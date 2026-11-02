// Repackage the licensed sampler without changing its mesh, pivots or animation data.
// Input is the extracted free sampler's root; download and license are in the contract.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { getBounds } from '@gltf-transform/functions';
import { validateBytes } from 'gltf-validator';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { compressActor } from '../world/lib/compress-actor.ts';
import { execFileSync } from 'node:child_process';

const input = process.argv[2];
if (!input) throw new Error('Usage: node tools/assets/prepare_aircraft.mjs INPUT_DIRECTORY');
const root = path.resolve(import.meta.dirname, '../..');
const output = path.join(root, 'apps/game/src/assets/aircraft');
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
await mkdir(output, { recursive: true });
const models = [];
const originalAtlas = await readFile(path.join(input, 'textures/atlas.png'));
const atlas = execFileSync('python', ['-c', [
  'import importlib.util,sys',
  "spec=importlib.util.spec_from_file_location('image_sanitizer',sys.argv[1])",
  'module=importlib.util.module_from_spec(spec)',
  'spec.loader.exec_module(module)',
  'sys.stdout.buffer.write(module.sanitize_png(sys.stdin.buffer.read())[0])',
].join(';'), path.join(root, 'tools/release/sanitize-images.py')], { input: originalAtlas });
for (const name of ['trainer', 'helicopter']) {
  const original = await readFile(path.join(input, 'glb', `${name}.glb`));
  const document = await io.read(path.join(input, 'glb', `${name}.glb`));
  if (document.getRoot().listTextures().length !== 1) throw new Error('Expected one aircraft atlas');
  document.getRoot().listTextures()[0].setImage(atlas);
  // The source contains no user metadata. Explicitly omit optional extras in future repacks too.
  for (const property of [document.getRoot(), ...document.getRoot().listNodes(), ...document.getRoot().listMaterials(), ...document.getRoot().listTextures()]) property.setExtras({});
  const embedded = await io.writeBinary(document);
  const { bytes, receipt: compression } = await compressActor(embedded);
  const report = await validateBytes(bytes, { uri: `${name}.glb` });
  if (report.issues.numErrors) throw new Error(`${name}: glTF validation failed`);
  await writeFile(path.join(output, `${name}.glb`), bytes);
  const jsonSize = new DataView(bytes.buffer, bytes.byteOffset).getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonSize)));
  const triangles = json.meshes.flatMap(mesh => mesh.primitives).reduce((n, primitive) => n + json.accessors[primitive.indices].count / 3, 0);
  models.push({ id: name === 'trainer' ? 'malmi-plane' : 'malmi-helicopter', title: name === 'trainer' ? 'Trainer plane' : 'Light helicopter',
    file: `apps/game/src/assets/aircraft/${name}.glb`, originalSha256: sha256(original), sha256: sha256(bytes), bytes: bytes.length,
    triangles, bounds: getBounds(document.getRoot().listScenes()[0]), materialCount: document.getRoot().listMaterials().length,
    nodes: json.nodes.map(node => node.name), animations: json.animations.map(animation => animation.name),
    articulation: 'Rigid-part transform rig, with named hinge and hub pivots; no deforming skeleton.',
    images: json.images.map(image => ({ mimeType: image.mimeType, embedded: image.bufferView !== undefined })),
    compression,
    validation: { errors: report.issues.numErrors, warnings: report.issues.numWarnings } });
}
const contract = { schemaVersion: 1, source: { title: 'Low-Poly Aircraft Kit Free', creator: 'heyheythere',
  url: 'https://heyheythere.itch.io/low-poly-aircraft-kit-free', retrievedOn: '2026-11-02', license: 'CC-BY-4.0',
  licenseUrl: 'https://creativecommons.org/licenses/by/4.0/', licenseFile: 'content/assets/aircraft-license.md' },
  axes: { forward: '+Z', up: '+Y', units: 'metres', origin: 'Ground under the wheels or skids' },
  changes: 'Removed non-rendering atlas metadata through the native lossless PNG sanitizer, embedded the atlas using glTF Transform 4.5.1, then applied the native lossless raw Meshopt buffer-view compressor. Every compressed view is decoded and checked byte-for-byte before acceptance. Mesh accessors, materials, hierarchy, pivots and animation clips are retained. Runtime supplies placement and flight-driven animation.',
  textures: { width: 512, height: 512, originalEncodedBytes: originalAtlas.length, originalSha256: sha256(originalAtlas), encodedBytes: atlas.length, sha256: sha256(atlas),
    description: 'One metadata-sanitized embedded PNG per model; compressed pixel chunks remain byte-exact. Standard and Low use identical small assets.', rgbaMipmappedBytesPerModel: 1398100 }, models };
await writeFile(path.join(root, 'content/assets/aircraft.contract.json'), JSON.stringify(contract, null, 2) + '\n');
await writeFile(path.join(root, 'content/assets/aircraft-license.md'), await readFile(path.join(input, 'LICENSE.txt')));
console.log(JSON.stringify(models.map(({id, bytes, triangles, validation}) => ({id, bytes, triangles, validation}))));
