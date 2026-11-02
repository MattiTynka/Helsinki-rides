// Optimize clean Blender exports; source archives stay outside the published repository.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { getBounds, dedup, prune } from '@gltf-transform/functions';
import { validateBytes } from 'gltf-validator';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { compressActor } from '../world/lib/compress-actor.ts';

const input = process.argv[2];
if (!input) throw new Error('Usage: node tools/assets/prepare_polished_aircraft.mjs CONVERTED_DIRECTORY');
const root = path.resolve(import.meta.dirname, '../..');
const output = path.join(root, 'apps/game/src/assets/aircraft');
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const sources = [
  { name: 'trainer', id: 'malmi-plane', title: 'Cessna 172', source: {
    title: 'Plane', creator: 'osmosikum', url: 'https://sketchfab.com/3d-models/plane-cedc8a07370747f7b0d14400cdf2faf9',
    license: 'CC-BY-4.0', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    archiveSha256: '3a47f30b4246113facefbfa3a1c72dac8588801ca55fdf93a0f1224c71678ac3', archiveBytes: 16864998,
    sourceFileSha256: '8c37ad1283b3747773e0829d40ed948b1c0acc854444b6259947120170edeeb3',
  } },
  { name: 'helicopter', id: 'malmi-helicopter', title: 'Mi-17', source: {
    title: 'Mi-17 Helicopter', creator: 'Blendsteve', url: 'https://blendswap.com/blend/12696',
    license: 'CC-BY-3.0', licenseUrl: 'https://creativecommons.org/licenses/by/3.0/',
    additionalNotice: 'Original distribution marks this as Fan Art and states that commercial use is not allowed. Retained for this free, noncommercial game release.',
    archiveSha256: '09497b7f2eec124d7fcd52ecb0f38814eb89a876df73e81a6c00661645d1e3dc', archiveBytes: 40643151,
    sourceFileSha256: '7da490069c58a5fafb7aa04584362b43e14fb654e1dd1691b8199c0772f7c980',
  } },
];
await mkdir(output, { recursive: true });
const models = [];
for (const { name, id, title, source } of sources) {
  const original = await readFile(path.join(input, `${name}.glb`));
  const document = await io.readBinary(original);
  for (const [index, texture] of document.getRoot().listTextures().entries()) {
    const optimized = await sharp(texture.getImage(), {limitInputPixels:4096*4096})
      .resize({width:1024,height:1024,fit:'inside',withoutEnlargement:true})
      .png({palette:true,colours:256,dither:0.5,compressionLevel:9}).toBuffer();
    texture.setImage(optimized).setMimeType('image/png').setName(`${name}_colour_${index}`);
  }
  await document.transform(dedup(), prune());
  const scene = document.getRoot();
  for (const property of [scene, ...scene.listNodes(), ...scene.listMeshes(), ...scene.listMaterials(), ...scene.listTextures(), ...scene.listAnimations(), ...scene.listAccessors()]) property.setExtras({});
  Object.assign(scene.getAsset(), {generator:'Helsinki aircraft pipeline', copyright:`${source.creator}; ${source.license}`});
  const embedded = await io.writeBinary(document);
  const { bytes, receipt: compression } = await compressActor(embedded);
  const report = await validateBytes(bytes, {uri:`${name}.glb`});
  if (report.issues.numErrors || report.issues.numWarnings) throw new Error(`${name}: glTF validation failed: ${JSON.stringify(report.issues.messages)}`);
  if (bytes.length > 2*1024*1024) throw new Error(`${name}: exceeds 2 MiB web budget`);
  const jsonSize = new DataView(bytes.buffer, bytes.byteOffset).getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20,20+jsonSize)));
  const triangles = json.meshes.flatMap(mesh=>mesh.primitives).reduce((n,p)=>n+json.accessors[p.indices].count/3,0);
  if (triangles > 50000) throw new Error(`${name}: exceeds triangle budget`);
  const textures = await Promise.all(scene.listTextures().map(async texture => {
    const image = texture.getImage(), {width,height} = await sharp(image).metadata();
    return {width,height,encodedBytes:image.length,sha256:sha256(image),rgbaMipmappedBytes:Math.ceil(width*height*4*4/3)};
  }));
  models.push({id,title,source:{...source,retrievedOn:'2026-11-02',licenseFile:'content/assets/aircraft-license.md'},
    file:`apps/game/src/assets/aircraft/${name}.glb`,originalSha256:sha256(original),sha256:sha256(bytes),bytes:bytes.length,
    triangles,bounds:getBounds(scene.listScenes()[0]),materialCount:scene.listMaterials().length,
    nodes:scene.listNodes().map(node=>node.getName()),animations:scene.listAnimations().map(a=>a.getName()),
    articulation:'Rigid-part mechanical rig; original moving geometry retained around normalized hub and hinge pivots.',textures,
    images:json.images.map(image=>({mimeType:image.mimeType,embedded:image.bufferView!==undefined})),compression,
    validation:{errors:report.issues.numErrors,warnings:report.issues.numWarnings}});
  await writeFile(path.join(output,`${name}.glb`),bytes);
}
if (models.reduce((n,m)=>n+m.bytes,0) > 4*1024*1024) throw new Error('Combined aircraft exceed 4 MiB');
const contract = {schemaVersion:2,axes:{forward:'+Z',up:'+Y',units:'metres',origin:'Ground under the landing gear; helicopter horizontal origin at main rotor hub'},
  toolchain:{blender:'5.2.1',gltfTransform:'4.5.1',sharp:'0.35.5'},
  changes:'Normalized geometry and mechanical pivots; rebuilt PBR materials; baked legacy helicopter colours; simplified helicopter geometry; removed authoring geometry; resized and palette-encoded metadata-free PNG textures; lossless Meshopt buffer compression with byte-for-byte decode verification.',models};
await writeFile(path.join(root,'content/assets/aircraft.contract.json'),JSON.stringify(contract,null,2)+'\n');
console.log(JSON.stringify(models.map(({id,bytes,triangles,textures,animations})=>({id,bytes,triangles,textures,animations})),null,2));
