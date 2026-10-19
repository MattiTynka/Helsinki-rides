// Append-only appearance partition: old physical bytes remain a literal BIN
// prefix. All rendered triangle coordinates/winding survive losslessly.
import assert from 'node:assert/strict';
import {NodeIO,type Node,type Primitive,type Document} from '@gltf-transform/core';
import {ALL_EXTENSIONS} from '@gltf-transform/extensions';
import {MeshoptDecoder,MeshoptEncoder} from 'meshoptimizer';
import {readFacadeGlb} from './facade-glb.ts';
import {pavingSha,pavingTriangleKey,pavingUv,type SurfaceTriangle,type SurfaceTarget,type PavingRegion} from './ground-resurfacing.ts';
import type {FacadeTriangle} from './facade-charts.ts';
import type {RgbaImage} from './gltf.ts';
import {pavingRgbaMipBytes,pavingBc7MipBytes} from './paving-textures.ts';
type Numeric=Float32Array|Uint32Array|Uint16Array|Int16Array|Uint8Array|Int8Array;
type Json=Record<string,any>;
const align=(n:number)=>(n+3)&~3;
const components=(t:string)=>({SCALAR:1,VEC2:2,VEC3:3,VEC4:4}[t]??0);
const component=(a:Numeric)=>a instanceof Float32Array?5126:a instanceof Uint32Array?5125:a instanceof Uint16Array?5123:a instanceof Int16Array?5122:a instanceof Int8Array?5120:5121;
async function decode(bytes:Uint8Array){await MeshoptDecoder.ready;return new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({'meshopt.decoder':MeshoptDecoder}).readBinary(bytes);}
function triangle(n:Node,p:Primitive,t:number):FacadeTriangle {
  const I=p.getIndices(),P=p.getAttribute('POSITION');assert.ok(I&&P&&p.getMode()===4);assert.ok(t>=0&&t*3+2<I.getCount());const M=n.getWorldMatrix();
  return [0,1,2].map(k=>{const v=P.getElement(I.getScalar(t*3+k),[]);return [Math.fround(M[0]*v[0]!+M[4]*v[1]!+M[8]*v[2]!+M[12]),Math.fround(M[1]*v[0]!+M[5]*v[1]!+M[9]*v[2]!+M[13]),Math.fround(M[2]*v[0]!+M[6]*v[1]!+M[10]*v[2]!+M[14])] as [number,number,number];}) as unknown as FacadeTriangle;
}
function geometry(doc:Document){const out:string[]=[];for(const n of doc.getRoot().listNodes())for(const p of n.getMesh()?.listPrimitives()??[])for(let t=0;t<(p.getIndices()?.getCount()??0)/3;t++)out.push(pavingTriangleKey(triangle(n,p,t)));return out.sort();}
export async function inspectGroundSurfaces(bytes:Uint8Array):Promise<SurfaceTriangle[]> {
  const doc=await decode(bytes),out:SurfaceTriangle[]=[];
  for(const n of doc.getRoot().listNodes()){
    const match=/_ground_(setts|cobble|asphalt|slabs)$/.exec(n.getName());if(!match)continue;
    assert.ok(n.getWorldMatrix().every((v,i)=>v===(i%5===0?1:0)),'Float32 source coverage requires identity world ground transforms');
    for(const [pi,p]of (n.getMesh()?.listPrimitives()??[]).entries()){
      assert.ok(p.getAttribute('POSITION')?.getArray() instanceof Float32Array,'Native coverage requires Float32 world-metre positions');
      for(let t=0;t<(p.getIndices()?.getCount()??0)/3;t++)out.push({node:n.getName(),primitive:pi,triangle:t,points:triangle(n,p,t),finish:match[1]!});
    }
  }return out;
}
export async function matchResurfacingTier(bytes:Uint8Array,source:readonly SurfaceTarget[],distant:boolean):Promise<SurfaceTarget[]> {
  const doc=await decode(bytes),wanted=new Map<string,SurfaceTarget>();for(const t of source){assert.ok(!wanted.has(t.key),'Ambiguous detailed source triangle');wanted.set(t.key,t);}
  const matches=new Map<string,SurfaceTarget[]>();
  for(const n of doc.getRoot().listNodes()){
    if(!distant&&!/_ground_(setts|cobble|asphalt|slabs)$/.test(n.getName()))continue;
    for(const [pi,p]of(n.getMesh()?.listPrimitives()??[]).entries())for(let t=0;t<(p.getIndices()?.getCount()??0)/3;t++){
      const key=pavingTriangleKey(triangle(n,p,t)),original=wanted.get(key);if(!original)continue;const a=matches.get(key)??[];a.push({...original,node:n.getName(),primitive:pi,triangle:t,key});matches.set(key,a);
    }
  }
  return source.map(t=>{const m=matches.get(t.key)??[];assert.equal(m.length,1,`Missing/ambiguous exact tier ownership: ${t.key}`);return m[0]!;});
}
export interface ResurfaceGlbOptions {
  expectedSha256:string;targets:readonly SurfaceTarget[];regions:readonly PavingRegion[];
  image:RgbaImage;encodedTexture?:Uint8Array;distant:boolean;extras:Readonly<Record<string,unknown>>;
}
export async function resurfaceGroundGlb(bytes:Uint8Array,o:ResurfaceGlbOptions) {
  assert.equal(pavingSha(bytes),o.expectedSha256,'Ground GLB hash mismatch');assert.ok(o.targets.length>0);
  await MeshoptEncoder.ready;const doc=await decode(bytes),before=geometry(doc),old=readFacadeGlb(bytes),j=structuredClone(old.json) as Json;
  assert.ok(j.extensionsRequired?.includes('EXT_meshopt_compression'));const virtual=j.buffers.findIndex((b:Json,i:number)=>i>0&&b.extensions?.EXT_meshopt_compression?.fallback);assert.ok(virtual>0);
  let physical=align(old.bin.length),logical=align(j.buffers[virtual].byteLength);const chunks:Uint8Array[]=[old.bin,new Uint8Array(physical-old.bin.length)];
  function payload(b:Uint8Array){const offset=physical;chunks.push(b,new Uint8Array(align(b.length)-b.length));physical+=align(b.length);return offset;}
  function accessor(a:Numeric,type:string,normalized=false,index=false){
    const size=components(type);assert.ok(size&&a.length>0&&a.length%size===0);for(const n of a)assert.ok(Number.isFinite(n));
    const count=a.length/size,element=size*a.BYTES_PER_ELEMENT,stride=index?element:align(element),raw=new Uint8Array(a.buffer,a.byteOffset,a.byteLength),src=new Uint8Array(count*stride);
    for(let k=0;k<count;k++)src.set(raw.subarray(k*element,(k+1)*element),k*stride);
    const mode=index?'INDICES':'ATTRIBUTES',encoded=MeshoptEncoder.encodeGltfBuffer(src,count,stride,mode),view=j.bufferViews.length;
    j.bufferViews.push({buffer:virtual,byteOffset:logical,byteLength:src.length,target:index?34963:34962,...(!index?{byteStride:stride}:{}),extensions:{EXT_meshopt_compression:{buffer:0,byteOffset:payload(encoded),byteLength:encoded.length,byteStride:stride,count,mode}}});logical+=align(src.length);
    const entry:Json={bufferView:view,byteOffset:0,componentType:component(a),count,type,...(normalized?{normalized:true}:{})};
    if(type==='VEC3'&&a instanceof Float32Array){entry.min=[Infinity,Infinity,Infinity];entry.max=[-Infinity,-Infinity,-Infinity];for(let k=0;k<a.length;k++){const c=k%3;entry.min[c]=Math.min(entry.min[c],a[k]!);entry.max[c]=Math.max(entry.max[c],a[k]!);}}
    const id=j.accessors.length;j.accessors.push(entry);return id;
  }
  let material:number|undefined;
  if(!o.distant){
    assert.ok(o.encodedTexture&&o.image.width===256&&o.image.height===256,'A 256px KTX2 albedo is required');const b=Buffer.from(o.encodedTexture);assert.ok(b.subarray(0,12).equals(Buffer.from([171,75,84,88,32,50,48,187,13,10,26,10])));assert.equal(b.readUInt32LE(20),256);assert.equal(b.readUInt32LE(24),256);
    const view=j.bufferViews.length;j.bufferViews.push({buffer:0,byteOffset:payload(b),byteLength:b.length});j.images??=[];const image=j.images.length;j.images.push({name:'original-granite-paving',mimeType:'image/ktx2',bufferView:view});
    j.samplers??=[];const sampler=j.samplers.length;j.samplers.push({magFilter:9729,minFilter:9987,wrapS:10497,wrapT:10497});j.textures??=[];const texture=j.textures.length;j.textures.push({name:'original-granite-paving',sampler,extensions:{KHR_texture_basisu:{source:image}}});
    j.extensionsUsed??=[];j.extensionsRequired??=[];for(const k of ['extensionsUsed','extensionsRequired'])if(!j[k].includes('KHR_texture_basisu'))j[k].push('KHR_texture_basisu');
    material=j.materials.length;j.materials.push({name:'original-granite-paving',pbrMetallicRoughness:{baseColorFactor:[1,1,1,1],baseColorTexture:{index:texture},metallicFactor:0,roughnessFactor:1},extras:{...o.extras,originalArt:true,license:'CC0-1.0',displacement:false}});
  }
  const linear=(v:number)=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4,mean=[0,0,0];for(let k=0;k<o.image.data.length;k+=4)for(let c=0;c<3;c++)mean[c]!+=linear(o.image.data[k+c]!/255)/(o.image.width*o.image.height);
  const groups=new Map<string,SurfaceTarget[]>(),seen=new Set<string>();
  for(const target of o.targets){const key=`${target.node}:${target.primitive}:${target.triangle}`;assert.ok(!seen.has(key),'Duplicate resurfacing target');seen.add(key);const a=groups.get(`${target.node}:${target.primitive}`)??[];a.push(target);groups.set(`${target.node}:${target.primitive}`,a);}
  type AttributeData={data:Numeric;type:string;normalized:boolean};
  const encodeAttributes=(data:Record<string,AttributeData>)=>Object.fromEntries(Object.entries(data).map(([s,a])=>[s,accessor(a.data,a.type,a.normalized)]));
  let addedPrimitives=0;const mutations:Json[]=[],partialBatches:{mesh:Json;template:Json;attrs:Record<string,AttributeData>;node:string;vertices:number}[]=[];
  for(const targets of groups.values()){
    const first=targets[0]!,nodes=doc.getRoot().listNodes().filter(n=>n.getName()===first.node);assert.equal(nodes.length,1);const n=nodes[0]!,mesh=n.getMesh();assert.ok(mesh&&doc.getRoot().listNodes().filter(q=>q.getMesh()===mesh).length===1&&!n.getSkin());
    if(!o.distant)assert.match(n.getName(),/_ground_(setts|cobble|asphalt|slabs)$/,'Only approved ground primitives may change');
    const p=mesh.listPrimitives()[first.primitive]!,node=j.nodes.find((q:Json)=>q.name===first.node),jm=j.meshes[node.mesh],jp=jm.primitives[first.primitive],I=p.getIndices()!.getArray()!;
    assert.ok(p.getMode()===4&&!p.listTargets().length&&!jp.extensions);
    for(const t of targets){const tri=triangle(n,p,t.triangle);assert.equal(pavingTriangleKey(tri),t.key,'Target coordinates/winding changed');assert.ok(o.regions.some(r=>r.id===t.region),'Unknown target region');
      const [a,b,c]=tri,ab=b.map((v,i)=>v-a[i]!),ac=c.map((v,i)=>v-a[i]!),nx=ab[1]!*ac[2]!-ab[2]!*ac[1]!,ny=ab[2]!*ac[0]!-ab[0]!*ac[2]!,nz=ab[0]!*ac[1]!-ab[1]!*ac[0]!;assert.ok(ny/Math.hypot(nx,ny,nz)>=.7,'Vertical/unsupported target is forbidden');}
    if(o.distant){
      assert.ok(!p.getMaterial()?.getBaseColorTexture()&&p.getAttribute('COLOR_0'),'Distant material must remain textureless');
      const order=targets.flatMap(t=>[0,1,2].map(k=>Number(I[t.triangle*3+k]))),start=p.getAttribute('POSITION')!.getCount(),newI=Uint32Array.from(I);
      targets.forEach((t,ti)=>{for(let k=0;k<3;k++)newI[t.triangle*3+k]=start+ti*3+k;});
      for(const semantic of p.listSemantics()){
        const a=p.getAttribute(semantic)!,src=a.getArray()! as Numeric,Type=src.constructor as {new(n:number):Numeric},size=a.getElementSize(),dst=new Type(src.length+order.length*size);dst.set(src);
        order.forEach((v,k)=>{dst.set(src.subarray(v*size,v*size+size),src.length+k*size);if(semantic==='COLOR_0')for(let c=0;c<3;c++)dst[src.length+k*size+c]=a.getNormalized()?Math.round(mean[c]!*((src instanceof Uint16Array)?65535:255)):mean[c]!;});
        jp.attributes[semantic]=accessor(dst,a.getType(),a.getNormalized());
      }jp.indices=accessor(newI,'SCALAR',false,true);
    }else{
      const selected=new Set(targets.map(t=>t.triangle)),kept:number[]=[];for(let k=0;k<I.length;k+=3)if(!selected.has(k/3))kept.push(Number(I[k]),Number(I[k+1]),Number(I[k+2]));
      const order=targets.flatMap(t=>[0,1,2].map(k=>Number(I[t.triangle*3+k]))),attrs:Record<string,AttributeData>={};
      for(const semantic of p.listSemantics())if(semantic!=='TEXCOORD_0'){
        const a=p.getAttribute(semantic)!,src=a.getArray()! as Numeric,size=a.getElementSize(),Type=src.constructor as {new(n:number):Numeric},dst=new Type(order.length*size);order.forEach((v,k)=>dst.set(src.subarray(v*size,v*size+size),k*size));attrs[semantic]={data:dst,type:a.getType(),normalized:a.getNormalized()};
      }
      const uv:number[]=[];for(const t of targets){const region=o.regions.find(r=>r.id===t.region)!;for(const v of triangle(n,p,t.triangle))uv.push(...pavingUv(v,region));}attrs.TEXCOORD_0={data:Float32Array.from(uv),type:'VEC2',normalized:false};
      const template={...structuredClone(jp),material,extras:{...jp.extras,groundResurfacing:true}};
      if(kept.length){
        assert.ok(n.getWorldMatrix().every((v,i)=>v===(i%5===0?1:0)),'Merged paving batches require identity world transforms');
        jp.indices=accessor(Uint32Array.from(kept),'SCALAR',false,true);partialBatches.push({mesh:jm,template,attrs,node:first.node,vertices:order.length});
      }else jm.primitives[first.primitive]={...template,attributes:encodeAttributes(attrs),indices:accessor(Uint32Array.from({length:order.length},(_,i)=>i),'SCALAR',false,true)};
    }
    mutations.push({node:first.node,primitive:first.primitive,triangles:targets.length});
  }
  if(partialBatches.length){
    const host=partialBatches[0]!,combined:Record<string,AttributeData>={},keys=Object.keys(host.attrs).sort(),vertices=partialBatches.reduce((n,b)=>n+b.vertices,0);
    for(const batch of partialBatches)assert.deepEqual(Object.keys(batch.attrs).sort(),keys,'Merged ground attribute semantics differ');
    for(const key of keys){const sample=host.attrs[key]!,Type=sample.data.constructor as {new(n:number):Numeric},data=new Type(partialBatches.reduce((n,b)=>n+b.attrs[key]!.data.length,0));let offset=0;
      for(const b of partialBatches){const a=b.attrs[key]!;assert.equal(a.data.constructor,sample.data.constructor);assert.equal(a.type,sample.type);assert.equal(a.normalized,sample.normalized);data.set(a.data,offset);offset+=a.data.length;}combined[key]={...sample,data};}
    host.mesh.primitives.push({...host.template,attributes:encodeAttributes(combined),indices:accessor(Uint32Array.from({length:vertices},(_,i)=>i),'SCALAR',false,true),extras:{...host.template.extras,sourceGroundNodes:partialBatches.map(b=>b.node)}});addedPrimitives=1;
  }
  const bin=Buffer.concat(chunks);assert.deepEqual(bin.subarray(0,old.bin.length),old.bin);j.buffers[0].byteLength=bin.length;j.buffers[virtual].byteLength=logical;
  const txt=Buffer.from(JSON.stringify(j)),padded=Buffer.alloc(align(txt.length),32);txt.copy(padded);const out=Buffer.alloc(28+padded.length+bin.length);out.writeUInt32LE(0x46546c67,0);out.writeUInt32LE(2,4);out.writeUInt32LE(out.length,8);out.writeUInt32LE(padded.length,12);out.writeUInt32LE(0x4e4f534a,16);padded.copy(out,20);out.writeUInt32LE(bin.length,20+padded.length);out.writeUInt32LE(0x004e4942,24+padded.length);bin.copy(out,28+padded.length);
  const next=readFacadeGlb(out).json as Json;for(const key of ['accessors','bufferViews','images','textures','samplers','materials'])assert.deepEqual(next[key]?.slice(0,(old.json as Json)[key]?.length??0)??[],(old.json as Json)[key]??[],`Old ${key} prefix changed`);
  assert.deepEqual(next.nodes,(old.json as Json).nodes);assert.deepEqual(next.scenes,(old.json as Json).scenes);assert.deepEqual(geometry(await decode(out)),before,'World geometry/winding changed');
  return {bytes:new Uint8Array(out),proof:{sourceSha256:o.expectedSha256,outputSha256:pavingSha(out),targetTriangles:o.targets.length,addedPrimitives,mutations,textureBytesEstimate:o.distant?0:pavingRgbaMipBytes(256),bc7Bytes:o.distant?0:pavingBc7MipBytes(256),originalBinPrefix:true,oldDescriptorsAndImages:true,worldTriangleCoordinatesAndWindingExact:true,distantMeanLinearColour:o.distant?mean:null}};
}
