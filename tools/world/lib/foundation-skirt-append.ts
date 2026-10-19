// Source-bound visual foundation extensions. The source palette primitive and distant colour primitive
// grow behind immutable accessor prefixes; ground geometry and collision are deliberately outside this API.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import sharp from 'sharp';
import {NodeIO,type Document,type Node,type Primitive} from '@gltf-transform/core';
import {ALL_EXTENSIONS} from '@gltf-transform/extensions';
import {MeshoptDecoder} from 'meshoptimizer';
import {buildFoundationClosure,foundationMaterial,type FoundationRepair} from './foundation-closure.ts';
import {appendGroundGlb,type GroundGlbAppend} from './append-ground-glb.ts';
import {frontierTriangleKey} from './frontier-ground.ts';
import {flatNormals} from './gltf.ts';
import {readFacadeGlb} from './facade-glb.ts';

export interface BoundFoundationRepair extends FoundationRepair {readonly node:string;readonly primitive:number;readonly triangle:number;readonly sourceTriangleKey:string;readonly coarsePaletteTexel?:{readonly node:string;readonly primitive:number}}
type RawArray=Float32Array|Uint32Array|Uint16Array|Int16Array|Uint8Array|Int8Array;
const identity=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
let basisPromise:Promise<any>|undefined;
async function paletteColour(p:Primitive,uv:readonly number[]){
 const material=p.getMaterial()!,texture=material.getBaseColorTexture(),info=material.getBaseColorTextureInfo();assert.ok(texture);assert.ok(!info?.getExtension('KHR_texture_transform'),'Palette transform needs an explicit sampling implementation');assert.ok(!p.getAttribute('COLOR_0'),'Vertex-modulated palette requires explicit sampling');const image=texture.getImage()!;let width:number,height:number,data:Uint8Array;
 if(texture.getMimeType()==='image/ktx2'){
  basisPromise??=(async()=>{const gameRequire=createRequire(new URL('../../../apps/game/package.json',import.meta.url)),dir=path.resolve(path.dirname(gameRequire.resolve('three')),'../examples/jsm/libs/basis'),temporary=fs.mkdtempSync(path.join(tmpdir(),'helsinki-foundation-palette-')),modulePath=path.join(temporary,'basis.cjs');fs.writeFileSync(modulePath,fs.readFileSync(path.join(dir,'basis_transcoder.js'),'utf8')+'\nmodule.exports = BASIS;\n');try{const basis=await createRequire(import.meta.url)(modulePath)({wasmBinary:fs.readFileSync(path.join(dir,'basis_transcoder.wasm'))});basis.initializeBasis();return basis;}finally{fs.unlinkSync(modulePath);fs.rmdirSync(temporary);}})();
  const basis=await basisPromise,file=new basis.KTX2File(image);try{assert.ok(file.isValid()&&file.startTranscoding(),'Existing palette KTX2 decode failed');width=file.getWidth();height=file.getHeight();data=new Uint8Array(file.getImageTranscodedSizeInBytes(0,0,0,13));assert.ok(file.transcodeImage(data,0,0,0,13,0,-1,-1),'Existing palette transcode failed');}finally{file.close();file.delete();}
 }else{const decoded=await sharp(image).ensureAlpha().raw().toBuffer({resolveWithObject:true});width=decoded.info.width;height=decoded.info.height;data=decoded.data;}
 const x=Math.min(width-1,Math.max(0,Math.floor(uv[0]!*width))),y=Math.min(height-1,Math.max(0,Math.floor(uv[1]!*height))),rgba=Array.from(data.subarray((y*width+x)*4,(y*width+x)*4+4)),factor=material.getBaseColorFactor(),linear=(v:number)=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4;
 return{colour:rgba.slice(0,3).map((v,i)=>linear(v/255)*factor[i]!),binding:{method:'exact existing source palette texel, decoded as for native distant-cell production',imageSha256:createHash('sha256').update(image).digest('hex'),width,height,pixel:[x,y],rgba,baseColorFactor:factor}};
}
function meshPrimitive(doc:Document,name:string,index:number){const nodes=doc.getRoot().listNodes().filter(n=>n.getName()===name);assert.equal(nodes.length,1,'Foundation source node must be unique');const node=nodes[0]!,mesh=node.getMesh();assert.ok(mesh);assert.equal(doc.getRoot().listNodes().filter(n=>n.getMesh()===mesh).length,1,'Shared source meshes require a separate explicit instance implementation');assert.deepEqual(node.getWorldMatrix(),identity,'Native world-space palette coordinates required');const p=mesh.listPrimitives()[index];assert.ok(p);assert.equal(p.getMode(),4);assert.equal(p.listTargets().length,0);assert.ok(p.getAttribute('POSITION')!.getArray()instanceof Float32Array,'Exact native Float32 source positions required');return{node,p};}
function triangle(p:Primitive,t:number){const I=p.getIndices()!,P=p.getAttribute('POSITION')!;assert.ok(Number.isInteger(t)&&t>=0&&t*3+2<I.getCount());return[0,1,2].map(k=>P.getElement(I.getScalar(t*3+k),[]));}
function append(p:Primitive,node:Node,positions:number[],uvs:number[],indices:number[],colour?:readonly number[]):GroundGlbAppend{
 const attributes:GroundGlbAppend['attributes']={},normals=flatNormals(Float32Array.from(positions),Uint32Array.from(indices));
 for(const s of p.listSemantics()){const a=p.getAttribute(s)!,raw=a.getArray()! as RawArray;let extra:number[];
  if(s==='POSITION'){assert.ok(raw instanceof Float32Array);extra=positions;}
  else if(s==='NORMAL'){const scale=a.getNormalized()?(raw instanceof Int8Array?127:raw instanceof Int16Array?32767:NaN):1;assert.ok(Number.isFinite(scale));extra=Array.from(normals,n=>scale===1?n:Math.round(n*scale));}
  else if(s==='TEXCOORD_0'){const scale=a.getNormalized()?(raw instanceof Uint16Array?65535:raw instanceof Uint8Array?255:NaN):1;assert.ok(Number.isFinite(scale));extra=uvs.map(u=>scale===1?u:Math.round(u*scale));}
  else if(s==='COLOR_0'){assert.ok(colour);const scale=a.getNormalized()?(raw instanceof Uint8Array?255:raw instanceof Uint16Array?65535:NaN):raw instanceof Float32Array?1:NaN;assert.ok(Number.isFinite(scale));extra=Array.from({length:positions.length/3},()=>colour.map(c=>scale===1?c:Math.round(c*scale))).flat();}
  else throw Error(`Unsupported foundation attribute ${s}`);
  (attributes as Record<string,{original:RawArray;appended:number[]}>)[s]={original:raw,appended:extra};
 }
 return{nodeName:node.getName(),primitiveIndex:node.getMesh()!.listPrimitives().indexOf(p),attributes,indices:{original:p.getIndices()!.getArray()! as RawArray,appended:indices.map(i=>i+p.getAttribute('POSITION')!.getCount())}};
}
function verifyPrefixes(before:Document,after:Document,bytes:Uint8Array,result:Uint8Array){
 const a=readFacadeGlb(bytes),b=readFacadeGlb(result);assert.deepEqual(b.bin.subarray(0,a.bin.length),a.bin);for(const k of['materials','textures','images','samplers'])assert.deepEqual(b.json[k],a.json[k]);
 for(const node of before.getRoot().listNodes()){const next=after.getRoot().listNodes().find(n=>n.getName()===node.getName());assert.ok(next);assert.deepEqual(next.getMatrix(),node.getMatrix());assert.equal(next.getMesh()?.listPrimitives().length,node.getMesh()?.listPrimitives().length);for(const[pi,p]of(node.getMesh()?.listPrimitives()??[]).entries()){const q:Primitive=next.getMesh()!.listPrimitives()[pi]!;for(const s of[...p.listSemantics(),'indices']){const old=(s==='indices'?p.getIndices():p.getAttribute(s))!.getArray()!,now:RawArray=(s==='indices'?q.getIndices():q.getAttribute(s))!.getArray()! as RawArray;assert.deepEqual(Array.from(now.subarray(0,old.length)),Array.from(old),'Old decoded foundation input changed');if(node.getName().includes('_ground_'))assert.equal(now.length,old.length,'Ground arrays must remain unchanged');}}}
}

export async function appendFoundationSkirts(lod0:Uint8Array,lod2:Uint8Array,repairs:readonly BoundFoundationRepair[],supportAt:(x:number,z:number)=>number|null,buryMetres=.3){
 assert.equal(repairs.length,1,'One explicitly qualified foundation edge per invocation');assert.equal(buryMetres,.3,'Approved foundation burial is exactly .3m');await MeshoptDecoder.ready;const io=new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({'meshopt.decoder':MeshoptDecoder}),doc=await io.readBinary(lod0),coarse=await io.readBinary(lod2),detailedAdds:GroundGlbAppend[]=[],coarseAdds:GroundGlbAppend[]=[],audits=[];
 for(const repair of repairs){assert.ok(!repair.node.includes('_ground_'),'Existing source palette required');const{node,p}=meshPrimitive(doc,repair.node,repair.primitive);assert.equal(frontierTriangleKey(triangle(p,repair.triangle)),repair.sourceTriangleKey,'Actual source triangle drift');const material=foundationMaterial(doc,repair);assert.equal(p.getMaterial(),material,'Selected source primitive material differs');assert.deepEqual([...repair.uv[0]],[...repair.uv[1]],'Foundation must retain one original palette texel');
  const matches:{node:Node;p:Primitive;triangle:number}[]=[];for(const n of coarse.getRoot().listNodes())for(const prim of n.getMesh()?.listPrimitives()??[]){assert.deepEqual(n.getWorldMatrix(),identity);for(let t=0;t<prim.getIndices()!.getCount()/3;t++)if(frontierTriangleKey(triangle(prim,t))===repair.sourceTriangleKey)matches.push({node:n,p:prim,triangle:t});}assert.ok(matches.length<=1,'Ambiguous distant source triangle');let target:{node:Node;p:Primitive;triangle:number|null},colour:number[],colourBinding:unknown;
  if(matches.length){target=matches[0]!;const C=target.p.getAttribute('COLOR_0');assert.ok(C);const colours=[0,1,2].map(k=>C.getElement(target.p.getIndices()!.getScalar(target.triangle!*3+k),[]));assert.deepEqual(colours[0],colours[1]);assert.deepEqual(colours[0],colours[2],'One exact source palette colour required');colour=colours[0]!;colourBinding={method:'exact distant source triangle'};}
  else{assert.ok(repair.coarsePaletteTexel,'Absent distant source face requires explicit original palette-texel authority');const bound=meshPrimitive(coarse,repair.coarsePaletteTexel.node,repair.coarsePaletteTexel.primitive);assert.deepEqual(bound.p.listSemantics().sort(),['COLOR_0','POSITION'],'Explicit textureless coarse target required');target={...bound,triangle:null};const sampled=await paletteColour(p,repair.uv[0]);colour=sampled.colour;colourBinding=sampled.binding;}
  const checked=meshPrimitive(coarse,target.node.getName(),target.node.getMesh()!.listPrimitives().indexOf(target.p));assert.equal(checked.p,target.p);
  const built=buildFoundationClosure(repair,supportAt,buryMetres);const positions:number[]=[],uvs:number[]=[],indices:number[]=[];let discarded=0;
  for(let i=0;i<built.indices.length;i+=3){const v=built.indices.slice(i,i+3).map(id=>Array.from(Float32Array.from(built.positions.slice(id*3,id*3+3)))),[a,b,c]=v as [number[],number[],number[]],u=b.map((x,k)=>x-a[k]!),w=c.map((x,k)=>x-a[k]!);assert.ok((u[2]!*w[0]!-u[0]!*w[2]!)===0,'Serialized foundation must stay exactly vertical');if(Math.hypot(u[1]!*w[2]!-u[2]!*w[1]!,u[0]!*w[1]!-u[1]!*w[0]!)===0){discarded++;continue;}for(let k=0;k<3;k++){const source=built.indices[i+k]!;indices.push(positions.length/3);positions.push(...v[k]!);uvs.push(...built.uvs.slice(source*2,source*2+2));}}
  if(indices.length){detailedAdds.push(append(p,node,positions,uvs,indices));coarseAdds.push(append(target.p,target.node,positions,[],indices,colour));}
  audits.push({...built.audit,node:repair.node,primitive:repair.primitive,sourceTriangle:repair.triangle,sourceTriangleKey:repair.sourceTriangleKey,coarseNode:target.node.getName(),coarsePrimitive:target.node.getMesh()!.listPrimitives().indexOf(target.p),coarseSourceTriangle:target.triangle,sourceColour:colour,colourBinding,addedTriangles:indices.length/3,discardedFloat32DegenerateTriangles:discarded,maximumNormalY:0});
 }
 const detailed=await appendGroundGlb(lod0,detailedAdds),distant=await appendGroundGlb(lod2,coarseAdds);verifyPrefixes(doc,await io.readBinary(detailed),lod0,detailed);verifyPrefixes(coarse,await io.readBinary(distant),lod2,distant);return{lod0:detailed,lod2:distant,audits,addedTriangles:audits.reduce((n,a)=>n+a.addedTriangles,0),groundArraysUnchanged:true,originalArraysAndPhysicalBinPrefixesPreserved:true};
}
