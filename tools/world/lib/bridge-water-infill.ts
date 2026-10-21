import assert from 'node:assert/strict';
import type {Document} from '@gltf-transform/core';
import {reuseGroundGlb} from './reuse-ground-glb.ts';
import type {GroundAttributeArray} from './replace-ground-glb.ts';
import type {SupportTriangle} from './tram-support-repair.ts';
export function encodedBridgeWater(doc:Document){const faces:SupportTriangle[]=[],vertices=new Set<string>();for(const n of doc.getRoot().listNodes().filter(n=>n.getName().endsWith('_water')))for(const p of n.getMesh()?.listPrimitives()??[]){assert.equal(p.getMaterial()?.getName(),'coastal_water');const P=p.getAttribute('POSITION')!,I=p.getIndices()!;for(let i=0;i<I.getCount();i+=3){const T=[0,1,2].map(k=>P.getElement(I.getScalar(i+k),[])) as unknown as SupportTriangle;faces.push(T);for(const v of T)vertices.add(v.join(','));}}return{faces,vertices};}
/** Reuse the actual original water primitive (and its exact coarse colour),
 * rather than guessing a material or placing a collidable water floor. */
export async function appendBridgeWaterInfill(bytes:Uint8Array,doc:Document,faces:readonly SupportTriangle[],options:{cell:string;coarse:boolean;sourceWaterVertices:ReadonlySet<string>;waterY:number}){
 if(!faces.length)return bytes;let chosen:{node:string;primitive:number;p:any;sample:number}|undefined;
 for(const n of doc.getRoot().listNodes())for(const[i,p]of(n.getMesh()?.listPrimitives()??[]).entries()){
  const P=p.getAttribute('POSITION')!,I=p.getIndices()!;if(!options.coarse){if(n.getName().endsWith('_water')&&p.getMaterial()?.getName()==='coastal_water')chosen={node:n.getName(),primitive:i,p,sample:I.getScalar(0)};}
  else if(p.getAttribute('COLOR_0'))for(let t=0;t<I.getCount();t+=3){const ids=[0,1,2].map(k=>I.getScalar(t+k));if(ids.every(id=>options.sourceWaterVertices.has(P.getElement(id,[]).join(',')))){chosen={node:n.getName(),primitive:i,p,sample:ids[0]!};break;}}
  if(chosen)break;
 }
 assert.ok(chosen,`No encoded original water material/colour in ${options.cell}`);const count=faces.length*3,attributes:Record<string,GroundAttributeArray>={};for(const semantic of chosen.p.listSemantics() as string[]){const a=chosen.p.getAttribute(semantic),source=a.getArray() as GroundAttributeArray,components=a.getElementSize(),A=new(source.constructor as{new(n:number):GroundAttributeArray})(count*components),sample=Array.from(source.subarray(chosen.sample*components,(chosen.sample+1)*components));assert.ok(['POSITION','NORMAL','COLOR_0'].includes(semantic),'Water UV convention needs explicit source mapping');for(let i=0;i<count;i++){const v=faces[Math.floor(i/3)]![i%3]!;assert.equal(v[1],options.waterY,'Water infill changed global source level');A.set(semantic==='POSITION'?v:semantic==='NORMAL'?[0,1,0]:sample,i*components);}attributes[semantic]=A;}
 return reuseGroundGlb(bytes,[],[{sourceNode:chosen.node,sourcePrimitive:chosen.primitive,nodeName:`${options.cell}_bridge_infill_water`,attributes,indices:Uint32Array.from({length:count},(_,i)=>i)}]);
}
