// Change a selected atlas URI without serializing any decoded geometry.
import assert from 'node:assert/strict';
import type {Node} from '@gltf-transform/core';
import {readFacadeGlb} from './facade-glb.ts';
import {packGlb} from './shared-textures.ts';
import {deliverySha,reduceNewCityImage} from './delivery-city-payloads.ts';

export interface ExternalOwnerImage {nodeName:string;imageIndex:number;uri:string}
const uriPattern=/^\.\.\/textures\/[a-f0-9]{64}\.ktx2$/;
function imageSource(json:any,material:number){const t=json.materials?.[material]?.pbrMetallicRoughness?.baseColorTexture;assert.ok(t&&(t.texCoord??0)===0,'Owner requires TEXCOORD_0 base colour');const texture=json.textures?.[t.index],source=texture?.extensions?.KHR_texture_basisu?.source;assert.ok(Number.isSafeInteger(source),'Owner requires a KTX2 image source');assert.equal(texture.source,undefined,'Ambiguous fallback image source');return source as number;}
export function externalOwnerImage(bytes:Uint8Array,nodeName:string):ExternalOwnerImage{
 const {json:raw}=readFacadeGlb(bytes),json=raw as any,nodes=json.nodes??[],found=nodes.filter((n:any)=>n.name===nodeName);assert.equal(found.length,1,'External owner node must be unique');
 const active=new Set<number>();const visit=(i:number)=>{assert.ok(nodes[i],'Invalid scene node');if(active.has(i))return;active.add(i);for(const child of nodes[i].children??[])visit(child);};
 assert.ok(json.scenes?.length===1||Number.isSafeInteger(json.scene),'Ambiguous active scene');const scene=json.scenes[json.scene??0];assert.ok(scene);for(const i of scene.nodes??[])visit(i);assert.ok(active.has(nodes.indexOf(found[0])),'Owner node is inactive');
 const primitives=json.meshes?.[found[0].mesh]?.primitives;assert.equal(primitives?.length,1,'Owner requires one atlas primitive');const imageIndex=imageSource(json,primitives[0].material),image=json.images?.[imageIndex];assert.ok(image);assert.equal(image.bufferView,undefined,'Expected external image');assert.equal(image.mimeType,'image/ktx2');assert.match(image.uri,uriPattern);
 return{nodeName,imageIndex,uri:image.uri};
}
/** Welding may change array layout; the oriented per-corner attributes must remain exact.
 * Repeated identical source faces are allowed to be removed by the native optimizer. */
export function ownerFacadeSurface(node:Node){
 const mesh=node.getMesh();assert.ok(mesh);assert.equal(mesh.listPrimitives().length,1);const p=mesh.listPrimitives()[0]!;assert.equal(p.getMode(),4);assert.equal(p.listTargets().length,0);const I=p.getIndices();assert.ok(I);const semantics=p.listSemantics().sort(),faces=new Set<string>();
 for(let t=0;t<I.getCount();t+=3){const corners=[0,1,2].map(k=>{const index=I.getScalar(t+k);return JSON.stringify(semantics.map(s=>[s,p.getAttribute(s)!.getElement(index,[])]));});faces.add([0,1,2].map(s=>[0,1,2].map(k=>corners[(k+s)%3]).join('|')).sort()[0]!);}
 return{matrix:node.getWorldMatrix(),semantics,faces:[...faces].sort()};
}
export function assertOwnerFacadeSurface(native:Node,delivery:Node){assert.deepEqual(ownerFacadeSurface(delivery),ownerFacadeSurface(native),'Optimized facade source surface/UV correspondence changed');}
export function replaceExternalOwnerImages(bytes:Uint8Array,replacements:readonly {binding:ExternalOwnerImage;uri:string}[]){
 assert.ok(replacements.length);const original=readFacadeGlb(bytes),json=structuredClone(original.json)as any,selectedNodes=new Set(replacements.map(r=>r.binding.nodeName)),byImage=new Map<number,string>();
 assert.equal(selectedNodes.size,replacements.length,'Duplicate selected node');
 for(const r of replacements){assert.deepEqual(externalOwnerImage(bytes,r.binding.nodeName),r.binding,'External owner binding changed');assert.match(r.uri,uriPattern);assert.notEqual(r.uri,r.binding.uri,'Replacement image did not change');const previous=byImage.get(r.binding.imageIndex);assert.ok(previous===undefined||previous===r.uri,'Conflicting image replacements');byImage.set(r.binding.imageIndex,r.uri);}
 // One image slot can feed multiple nodes/material slots. Updating it must not recolour an unselected user.
 for(const node of json.nodes??[])for(const p of json.meshes?.[node.mesh]?.primitives??[]){const material=json.materials?.[p.material];if(!material)continue;for(const [textureIndex,texture]of(json.textures??[]).entries()){const image=texture.extensions?.KHR_texture_basisu?.source??texture.source;if(!byImage.has(image))continue;
   const references=(value:any):boolean=>!!value&&typeof value==='object'&&(value.index===textureIndex||Object.values(value).some(references));
   if(references(material)){assert.ok(selectedNodes.has(node.name)&&material.pbrMetallicRoughness?.baseColorTexture?.index===textureIndex,'Selected image is aliased by an unselected texture user');const otherUses=structuredClone(material);delete otherUses.pbrMetallicRoughness.baseColorTexture;assert.ok(!references(otherUses),'Selected image is also used outside base colour');}
 }}
 for(const[index,uri]of byImage)json.images[index].uri=uri;const out=packGlb(json,original.bin),parsed=readFacadeGlb(out);assert.deepEqual(parsed.bin,original.bin,'Physical geometry BIN changed');const restored=structuredClone(parsed.json)as any;for(const[index]of byImage)restored.images[index]=(original.json.images as any[])[index];assert.deepEqual(restored,original.json,'Non-image GLB JSON changed');return out;
}
export function ownerImageMipPair(native:Uint8Array){const digest=deliverySha(native);return reduceNewCityImage({path:`textures/${digest}.ktx2`,bytes:native,sha256:digest});}
export function assertOwnerImageBaseline(native:Uint8Array,standard:Uint8Array,low?:Uint8Array){const reduced=ownerImageMipPair(native);assert.ok(Buffer.from(standard).equals(Buffer.from(reduced.standard.bytes)),'Native baseline does not match delivery standard image');assert.equal(!!low,!!reduced.low,'Low image mapping presence changed');if(low)assert.ok(Buffer.from(low).equals(Buffer.from(reduced.low!.bytes)),'Native baseline does not match delivery Low image');return reduced;}
