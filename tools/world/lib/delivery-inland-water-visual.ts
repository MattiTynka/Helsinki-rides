import assert from 'node:assert/strict';
import type {Document} from '@gltf-transform/core';
import type {LocalPolygon} from './geometry.ts';
import type {Finish,GroundPiece} from './ground.ts';
import {deliveryFrontierMesh} from './delivery-city-frontier.ts';
import {addNativeFrontier,type FrontierMesh} from './frontier-ground.ts';
import type {GroundAttributeArray} from './replace-ground-glb.ts';
import {reuseGroundGlb,type GroundIndexEdit,type GroundPrimitiveAddition} from './reuse-ground-glb.ts';
import {readFacadeGlb} from './facade-glb.ts';
import {selectInlandWaterFace} from './delivery-inland-water.ts';
import {deliveryFloorCoverage} from './delivery-city-floor-coverage.ts';
import {groundTexture} from './textures.ts';
import {deliveryGeometryStats} from './delivery-city-payloads.ts';

const identity=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
type Triangle=readonly (readonly[number,number,number])[];
const points=(m:FrontierMesh,t:number)=>[0,1,2].map(k=>Array.from(m.attributes.POSITION!.subarray(m.indices[t*3+k]!*3,m.indices[t*3+k]!*3+3))as[number,number,number]);
const key=(P:Triangle)=>P.map(p=>p.map(Math.fround).join(',')).sort().join('|');
function empty(mesh:FrontierMesh):FrontierMesh {const attributes:Record<string,GroundAttributeArray>={};for(const[s,a]of Object.entries(mesh.attributes)){const Type=a.constructor as{new(length:number):GroundAttributeArray};attributes[s]=new Type(0);}return{...mesh,attributes,indices:new Uint32Array()};}

export function inlandWaterAuthority(doc:Document,domain:readonly LocalPolygon[],seaY:number){
  const keys=new Set<string>(),triangles:Triangle[]=[],nodes:{name:string;selected:number}[]=[];
  for(const node of doc.getRoot().listNodes())if(node.getMesh()&&/_water$/.test(node.getName())){
    assert.deepEqual(node.getWorldMatrix(),identity);assert.equal(node.getMesh()!.listPrimitives().length,1);const p=node.getMesh()!.listPrimitives()[0]!;assert.equal(p.getMaterial()?.getName(),'coastal_water');assert.deepEqual(p.listSemantics().sort(),['NORMAL','POSITION']);const m=deliveryFrontierMesh(p);let selected=0;
    for(let t=0;t<m.indices.length/3;t++){const P=points(m,t);assert.ok(P.every(p=>p[1]===seaY),'Only the original global sea plane is eligible');if(selectInlandWaterFace(P,domain)){keys.add(key(P));triangles.push(P);selected++;}}nodes.push({name:node.getName(),selected});
  }
  return{keys,triangles,nodes};
}
const textures=new Map<Finish,ReturnType<typeof groundTexture>>();
function colour(finish:Finish,u:number,v:number){let image=textures.get(finish);if(!image){image=groundTexture(finish,512);textures.set(finish,image);}const x=Math.min(image.width-1,Math.floor((u-Math.floor(u))*image.width)),y=Math.min(image.height-1,Math.floor((v-Math.floor(v))*image.height));return[0,1,2].map(k=>{const c=image!.data[(y*image!.width+x)*4+k]!/255;return c<=.04045?c/12.92:((c+.055)/1.055)**2.4;});}

function addCoarseGround(m:FrontierMesh,pieces:readonly GroundPiece[]){
  assert.deepEqual(Object.keys(m.attributes).sort(),['COLOR_0','POSITION']);const source=m.attributes.COLOR_0!,scale=m.normalized.COLOR_0?(source instanceof Uint8Array?255:source instanceof Uint16Array?65535:0):1;assert.ok(scale);assert.equal(m.components.COLOR_0,3);const P=Array.from(m.attributes.POSITION!),C=Array.from(source),I=Array.from(m.indices);
  for(const piece of pieces)if(piece.use!=='collision')for(const id of piece.indices){I.push(P.length/3);P.push(...piece.positions.slice(id*3,id*3+3));C.push(...colour(piece.finish,piece.uvs[id*2]!,piece.uvs[id*2+1]!).map(v=>scale===1?v:Math.round(v*scale)));}
  const Type=source.constructor as{new(values:number[]):GroundAttributeArray};return{...m,attributes:{POSITION:Float32Array.from(P),COLOR_0:new Type(C)},indices:Uint32Array.from(I)};
}

export async function restoreInlandVisual(options:{bytes:Uint8Array;doc:Document;pieces:readonly GroundPiece[];domain:readonly LocalPolygon[];seaY:number;coarse:boolean;authority:ReturnType<typeof inlandWaterAuthority>}){
  const edits:GroundIndexEdit[]=[],additions:GroundPrimitiveAddition[]=[],proofs:{node:string;removedWater:number;addedGround:number}[]=[],remaining=new Map<Finish,GroundPiece[]>();for(const p of options.pieces)if(p.use!=='collision'){const list=remaining.get(p.finish)??[];list.push(p);remaining.set(p.finish,list);}let coarseAdded=false;
  const names=new Set(options.doc.getRoot().listNodes().map(n=>n.getName())),cell=(readFacadeGlb(options.bytes).json as any).extras.cell;assert.ok(typeof cell==='string');
  for(const node of options.doc.getRoot().listNodes())if(node.getMesh())for(const[i,p]of node.getMesh()!.listPrimitives().entries()){
    const isWater=/_water$/.test(node.getName()),finish=/_ground_(?:frontier_)?(asphalt|setts|cobble|slabs|gravel|grass|yard)$/.exec(node.getName())?.[1]as Finish|undefined;
    if(!options.coarse&&!isWater&&!finish)continue;assert.deepEqual(node.getWorldMatrix(),identity);const old=deliveryFrontierMesh(p),removed=new Set<number>();
    if(isWater){assert.equal(p.getMaterial()?.getName(),'coastal_water');for(let t=0;t<old.indices.length/3;t++){const P=points(old,t);assert.ok(P.every(p=>p[1]===options.seaY));if(selectInlandWaterFace(P,options.domain))removed.add(t);}}
    else if(options.coarse)for(let t=0;t<old.indices.length/3;t++){const P=points(old,t);if(!P.every(p=>p[1]===options.seaY)||!selectInlandWaterFace(P,options.domain))continue;assert.ok(options.authority.keys.has(key(P))||deliveryFloorCoverage(P,options.authority.triangles),'A coarse water cut needs complete coplanar near-water provenance');removed.add(t);}
    if(removed.size)edits.push({nodeName:node.getName(),primitiveIndex:i,indices:Uint32Array.from(Array.from({length:old.indices.length/3},(_,t)=>t).filter(t=>!removed.has(t)).flatMap(t=>Array.from(old.indices.subarray(t*3,t*3+3))))});
    let added:FrontierMesh|undefined,addedGround=0,newName='';
    if(options.coarse&&!coarseAdded){added=addCoarseGround(empty(old),options.pieces);addedGround=options.pieces.filter(p=>p.use!=='collision').reduce((n,p)=>n+p.indices.length/3,0);let serial=1;do{newName=`append${serial===1?'':serial}:${cell}`;serial++;}while(names.has(newName));remaining.clear();coarseAdded=true;}
    else if(!options.coarse&&finish){const parts=remaining.get(finish)??[];if(parts.length){added=addNativeFrontier(empty(old),parts);addedGround=parts.reduce((n,p)=>n+p.indices.length/3,0);newName=`inland:${node.getName()}`;remaining.delete(finish);}}
    if(added?.indices.length){assert.ok(!names.has(newName));names.add(newName);additions.push({sourceNode:node.getName(),sourcePrimitive:i,nodeName:newName,attributes:added.attributes,indices:added.indices});}
    if(removed.size||addedGround)proofs.push({node:node.getName(),removedWater:removed.size,addedGround});
  }
  assert.equal(remaining.size,0,`Restored source finish requires its actual existing material: ${[...remaining.keys()]}`);
  const bytes=await reuseGroundGlb(options.bytes,edits,additions),stats=deliveryGeometryStats(bytes);assert.ok(stats.drawCalls<=(options.coarse?3:60),'Original delivery draw budgets exceeded');return{bytes,stats,proofs};
}
