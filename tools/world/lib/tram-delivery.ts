import assert from 'node:assert/strict';
import {NodeIO,type Document,type Primitive} from '@gltf-transform/core';
import {ALL_EXTENSIONS} from '@gltf-transform/extensions';
import {MeshoptDecoder} from 'meshoptimizer';
import type {MultiPolygon} from 'polygon-clipping';
import {readFacadeGlb} from './facade-glb.ts';

export async function decodeDeliveryTramGlb(bytes:Uint8Array,images:ReadonlyMap<string,Uint8Array>):Promise<Document>{
  await MeshoptDecoder.ready;
  const {json,bin}=readFacadeGlb(bytes),resources:Record<string,Uint8Array<ArrayBuffer>>={'@glb.bin':new Uint8Array(bin)};
  for(const image of (json.images??[]) as {uri?:string}[])if(image.uri){const data=images.get(image.uri);assert.ok(data?.length,`Missing manifest-pinned tram image:${image.uri}`);resources[image.uri]=new Uint8Array(data);}
  return new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({'meshopt.decoder':MeshoptDecoder}).readJSON({json:json as any,resources});
}
const identity=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
export const EXISTING_RAIL_CLEARANCE=.0005;
/** A bounded 0.5mm L-infinity margin prevents Float32 roundoff from duplicating
 * an old rail at crossings. A square Minkowski sum has no long acute miters. */
function protectedTriangle(points:number[][]){
 const p=points.flatMap(([x,z])=>[[-1,-1],[-1,1],[1,-1],[1,1]].map(([a,b])=>[x!+a!*EXISTING_RAIL_CLEARANCE,z!+b!*EXISTING_RAIL_CLEARANCE]));
 p.sort((a,b)=>a[0]!-b[0]!||a[1]!-b[1]!);const cross=(a:number[],b:number[],c:number[])=>(b[0]!-a[0]!)*(c[1]!-a[1]!)-(b[1]!-a[1]!)*(c[0]!-a[0]!);
 const lower:number[][]=[],upper:number[][]=[];for(const q of p){while(lower.length>1&&cross(lower.at(-2)!,lower.at(-1)!,q)<=0)lower.pop();lower.push(q);}
 for(const q of [...p].reverse()){while(upper.length>1&&cross(upper.at(-2)!,upper.at(-1)!,q)<=0)upper.pop();upper.push(q);}
 const hull=[...lower.slice(0,-1),...upper.slice(0,-1)];return [[...hull,hull[0]!] as [number,number][]];
}
export function existingDeliveryRailMask(doc:Document):{polygons:MultiPolygon;triangles:number;nodes:string[]}{
 const polygons:MultiPolygon=[],nodes:string[]=[];let triangles=0;
 for(const n of doc.getRoot().listNodes())if(n.getName().endsWith('_tram_visuals')){
  assert.deepEqual(n.getWorldMatrix(),identity,'Existing rail transform changed');nodes.push(n.getName());
  for(const p of n.getMesh()?.listPrimitives()??[]){assert.equal(p.getMaterial()?.getName(),'tram_steel_and_groove');const P=p.getAttribute('POSITION'),I=p.getIndices();assert.ok(P&&I&&p.getMode()===4);
   for(let i=0;i<I.getCount();i+=3){const points=[0,1,2].map(k=>{const v=P.getElement(I.getScalar(i+k),[]);return[v[0]!,v[2]!];});polygons.push(protectedTriangle(points));triangles++;}
  }
 }
 return {polygons,triangles,nodes};
}
export function proveDeliveryTramPreservation(before:Uint8Array,after:Uint8Array,old:Document,next:Document,coarse:boolean){
 const a=readFacadeGlb(before),b=readFacadeGlb(after),j=a.json as any,k=b.json as any;
 assert.deepEqual(b.bin.subarray(0,a.bin.length),a.bin,'Old compressed/image BIN bytes changed');
 for(const key of ['accessors','bufferViews','images','textures','samplers','materials'])assert.deepEqual((k[key]??[]).slice(0,(j[key]??[]).length),j[key]??[],`Old${key} changed`);
 assert.deepEqual(k.nodes.slice(0,j.nodes.length),j.nodes);assert.deepEqual(k.asset,j.asset);
 let grown=0;
 for(const node of old.getRoot().listNodes()){
  const nn=next.getRoot().listNodes().find(n=>n.getName()===node.getName());assert.ok(nn);assert.deepEqual(nn.getMatrix(),node.getMatrix());if(!node.getMesh())continue;
  assert.equal(nn.getMesh()!.listPrimitives().length,node.getMesh()!.listPrimitives().length);
  for(const [i,p]of node.getMesh()!.listPrimitives().entries()){
   const q:Primitive=nn.getMesh()!.listPrimitives()[i]!;assert.deepEqual(q.listSemantics(),p.listSemantics());assert.equal(q.getMaterial()?.getName(),p.getMaterial()?.getName());
   const changed=q.getIndices()!.getCount()!==p.getIndices()!.getCount();if(changed){assert.ok(coarse);grown++;}
   for(const semantic of [...p.listSemantics(),'indices']){const aa=(semantic==='indices'?p.getIndices():p.getAttribute(semantic))!.getArray()!,bb=(semantic==='indices'?q.getIndices():q.getAttribute(semantic))!.getArray()!;assert.deepEqual(bb.subarray(0,aa.length),aa,'Old decoded geometry changed');if(!changed)assert.equal(bb.length,aa.length);}
  }
 }
 assert.equal(next.getRoot().listNodes().length,old.getRoot().listNodes().length+(coarse?0:1));
 assert.equal(next.getRoot().listTextures().length,old.getRoot().listTextures().length+(coarse?0:1));
 assert.equal(grown,coarse?1:0);
 return {originalBinPrefix:true,originalMaterialImageDefinitions:true,originalDecodedGeometryPrefixes:true,originalNodesAndTransforms:true,coarsePrimitivesGrown:grown};
}
