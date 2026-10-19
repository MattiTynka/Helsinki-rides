// Material-only draw partition for frozen city cells. Old BIN data, accessors,
// images and materials stay literal prefixes; selected faces are drawn once with
// the very same local coordinates and winding, under the same node transform.
import assert from 'node:assert/strict';
import {NodeIO, type Document, type Node, type Primitive} from '@gltf-transform/core';
import {ALL_EXTENSIONS} from '@gltf-transform/extensions';
import {MeshoptDecoder, MeshoptEncoder} from 'meshoptimizer';
import {readFacadeGlb} from './facade-glb.ts';
import {facadeAtlasBytes, facadeAtlasBc7Bytes, facadeChartSha256, facadeChartUv, facadeTriangleKey, proveFacadeCoverage,
  sampleFacadeChartColour, validateFacadeTriangle, type FacadeChart, type FacadeChartTarget,
  type FacadePoint, type FacadeTriangle} from './facade-charts.ts';
import type {RgbaImage} from './gltf.ts';

type NumericArray = Float32Array | Uint32Array | Uint16Array | Int16Array | Uint8Array | Int8Array;
type Json = Record<string, any>;
export interface ChartGlbOptions {
  readonly expectedSha256: string;
  readonly charts: readonly FacadeChart[];
  readonly targets: readonly FacadeChartTarget[];
}
export interface FacadeAtlas {
  readonly name: string;
  readonly image: Uint8Array;
  readonly mimeType: 'image/png' | 'image/ktx2';
  readonly width: number;
  readonly height: number;
}
export interface DetailedChartOptions extends ChartGlbOptions {
  readonly atlas: FacadeAtlas;
  readonly maximumFallbackBytes: number;
  readonly material: {readonly name: string; readonly unlit: boolean; readonly roughness: number; readonly doubleSided: boolean};
  readonly extras: Readonly<Record<string, unknown>>;
}
export interface DistantChartOptions extends ChartGlbOptions {
  readonly image: RgbaImage;
  readonly detailedCoverage: ReadonlyMap<string, readonly FacadeTriangle[]>;
}
const align4 = (n: number) => (n+3)&~3;
const components = (type: string): number => ({SCALAR:1,VEC2:2,VEC3:3,VEC4:4}[type] ?? 0);
const componentType = (a: NumericArray) => a instanceof Float32Array ? 5126 : a instanceof Uint32Array ? 5125 : a instanceof Uint16Array ? 5123 : a instanceof Int16Array ? 5122 : a instanceof Int8Array ? 5120 : 5121;
const arrayTypes = {5126:Float32Array,5125:Uint32Array,5123:Uint16Array,5122:Int16Array,5121:Uint8Array,5120:Int8Array};
const array = (p: Primitive, semantic: string): NumericArray => {
  const a=p.getAttribute(semantic)?.getArray(); assert.ok(a && Object.values(arrayTypes).some(Type=>a instanceof Type), `Unsupported ${semantic} accessor`); return a as NumericArray;
};
async function decode(bytes: Uint8Array) {
  await MeshoptDecoder.ready;
  const io=new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({'meshopt.decoder':MeshoptDecoder});
  return {io,doc:await io.readBinary(bytes)};
}
function worldTriangle(node: Node, p: Primitive, triangle: number): FacadeTriangle {
  const a=p.getAttribute('POSITION'), indices=p.getIndices(); assert.ok(a && indices && p.getMode()===4);
  assert.ok(triangle >= 0 && triangle*3+2 < indices.getCount(), 'Facade triangle index out of bounds');
  const M=node.getWorldMatrix();
  return [0,1,2].map(k=>{const v=a.getElement(indices.getScalar(triangle*3+k),[]); return [
    Math.fround(M[0]*v[0]!+M[4]*v[1]!+M[8]*v[2]!+M[12]),
    Math.fround(M[1]*v[0]!+M[5]*v[1]!+M[9]*v[2]!+M[13]),
    Math.fround(M[2]*v[0]!+M[6]*v[1]!+M[10]*v[2]!+M[14]),
  ] as FacadePoint;}) as unknown as FacadeTriangle;
}
function geometry(doc: Document) {
  const keys:string[]=[];
  for(const n of doc.getRoot().listNodes())for(const p of n.getMesh()?.listPrimitives()??[]){
    assert.ok(p.getIndices() && p.getMode()===4,'Facade adapter requires indexed triangle cells');
    for(let t=0;t<p.getIndices()!.getCount()/3;t++)keys.push(facadeTriangleKey(worldTriangle(n,p,t)));
  }
  return keys.sort();
}

export async function inspectFacadeChartTargets(bytes: Uint8Array, options: ChartGlbOptions) {
  assert.equal(facadeChartSha256(bytes),options.expectedSha256,'Target GLB hash changed');
  const {doc}=await decode(bytes), seen=new Set<string>(), triangles=new Map<string,FacadeTriangle[]>();
  for(const target of options.targets){
    const id=`${target.node}:${target.primitive}:${target.triangle}`;assert.ok(!seen.has(id),'Duplicate target draw triangle');seen.add(id);
    const nodes=doc.getRoot().listNodes().filter(n=>n.getName()===target.node);assert.equal(nodes.length,1,'Target node must be unique');
    const n=nodes[0]!,mesh=n.getMesh();assert.ok(mesh);assert.equal(doc.getRoot().listNodes().filter(q=>q.getMesh()===mesh).length,1,'Instanced target mesh is forbidden');
    assert.equal(n.getSkin(),null,'Skinned architecture is not supported');
    const p=mesh.listPrimitives()[target.primitive];assert.ok(p,'Missing target primitive');assert.equal(p.listTargets().length,0,'Morph targets are forbidden');
    assert.ok(!n.getName().includes('_ground') && !mesh.getName().includes('_ground'),'Ground primitives cannot be chart targets');
    const chart=options.charts.find(c=>c.id===target.chart);assert.ok(chart,'Unknown facade chart');
    const tri=worldTriangle(n,p,target.triangle);assert.equal(facadeTriangleKey(tri),target.key,'Target triangle coordinates or winding changed');validateFacadeTriangle(tri,chart);
    const list=triangles.get(target.chart)??[];list.push(tri);triangles.set(target.chart,list);
  }
  assert.ok(options.targets.length>0,'At least one explicit facade target is required');
  return triangles;
}

function validateAtlas(atlas: FacadeAtlas) {
  assert.ok(atlas.name && atlas.width>0 && atlas.height>0 && atlas.width<=768 && atlas.height<=768);
  const b=Buffer.from(atlas.image);
  if(atlas.mimeType==='image/png'){
    assert.ok(b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),'Invalid PNG atlas');
    assert.equal(b.readUInt32BE(16),atlas.width);assert.equal(b.readUInt32BE(20),atlas.height);
  } else {
    assert.ok(b.subarray(0,12).equals(Buffer.from([171,75,84,88,32,50,48,187,13,10,26,10])),'Invalid KTX2 atlas');
    assert.equal(b.readUInt32LE(20),atlas.width);assert.equal(b.readUInt32LE(24),atlas.height);
  }
}

async function apply(bytes: Uint8Array, options: DetailedChartOptions | DistantChartOptions, distant: boolean) {
  await inspectFacadeChartTargets(bytes,options);await MeshoptEncoder.ready;
  const {io,doc}=await decode(bytes), beforeGeometry=geometry(doc), original=readFacadeGlb(bytes), json=structuredClone(original.json) as Json;
  assert.ok(json.extensionsRequired?.includes('EXT_meshopt_compression'),'Existing meshopt contract required');
  const virtual=json.buffers.findIndex((b:Json,i:number)=>i>0 && b.extensions?.EXT_meshopt_compression?.fallback===true);assert.ok(virtual>0,'Missing meshopt virtual fallback buffer');
  let physical=align4(original.bin.length),logical=align4(json.buffers[virtual].byteLength);
  const pieces:Uint8Array[]=[original.bin,new Uint8Array(physical-original.bin.length)];
  const appendPayload=(payload:Uint8Array)=>{const start=physical;pieces.push(payload,new Uint8Array(align4(payload.length)-payload.length));physical+=align4(payload.length);return start;};
  const appendAccessor=(values:NumericArray,type:string,normalized=false,indices=false)=>{
    const size=components(type);assert.ok(size && values.length>0 && values.length%size===0);for(const v of values)assert.ok(Number.isFinite(v));
    const count=values.length/size,elementBytes=size*values.BYTES_PER_ELEMENT,stride=indices?elementBytes:align4(elementBytes),raw=new Uint8Array(values.buffer,values.byteOffset,values.byteLength),source=new Uint8Array(count*stride);
    for(let i=0;i<count;i++)source.set(raw.subarray(i*elementBytes,(i+1)*elementBytes),i*stride);
    const mode=indices?'INDICES':'ATTRIBUTES',encoded=MeshoptEncoder.encodeGltfBuffer(source,count,stride,mode),offset=appendPayload(encoded);
    const view:Json={buffer:virtual,byteOffset:logical,byteLength:source.length,target:indices?34963:34962,extensions:{EXT_meshopt_compression:{buffer:0,byteOffset:offset,byteLength:encoded.length,byteStride:stride,count,mode}}};if(!indices)view.byteStride=stride;
    logical+=align4(source.length);const viewId=json.bufferViews.length;json.bufferViews.push(view);
    const accessor:Json={bufferView:viewId,byteOffset:0,componentType:componentType(values),count,type};if(normalized)accessor.normalized=true;
    if(type==='VEC3' && values instanceof Float32Array){const min=Array(3).fill(Infinity),max=Array(3).fill(-Infinity);for(let i=0;i<values.length;i++){const k=i%3;min[k]=Math.min(min[k],values[i]!);max[k]=Math.max(max[k],values[i]!);}accessor.min=min;accessor.max=max;}
    const id=json.accessors.length;json.accessors.push(accessor);return id;
  };
  let newMaterial:number|undefined,textureBytesEstimate=0,fallbackBytes=0;
  if(!distant){
    const o=options as DetailedChartOptions;validateAtlas(o.atlas);fallbackBytes=facadeAtlasBytes(o.atlas.width,o.atlas.height);
    assert.ok(fallbackBytes<=o.maximumFallbackBytes && o.maximumFallbackBytes<=3*1024*1024,'Atlas fallback memory exceeds declared cap');
    textureBytesEstimate=o.atlas.mimeType==='image/ktx2'?facadeAtlasBc7Bytes(o.atlas.width,o.atlas.height):fallbackBytes;
    const viewId=json.bufferViews.length,offset=appendPayload(o.atlas.image);json.bufferViews.push({buffer:0,byteOffset:offset,byteLength:o.atlas.image.length});
    json.images??=[];const image=json.images.length;json.images.push({name:o.atlas.name,mimeType:o.atlas.mimeType,bufferView:viewId});
    json.samplers??=[];const sampler=json.samplers.length;json.samplers.push({magFilter:9729,minFilter:9987,wrapS:33071,wrapT:33071});
    json.textures??=[];const texture=json.textures.length;json.textures.push(o.atlas.mimeType==='image/ktx2'?{name:o.atlas.name,sampler,extensions:{KHR_texture_basisu:{source:image}}}:{name:o.atlas.name,sampler,source:image});
    const extensions:Json={};if(o.material.unlit)extensions.KHR_materials_unlit={};
    const addExtension=(name:string)=>{json.extensionsUsed??=[];if(!json.extensionsUsed.includes(name))json.extensionsUsed.push(name);json.extensionsRequired??=[];if(!json.extensionsRequired.includes(name))json.extensionsRequired.push(name);};
    if(o.material.unlit)addExtension('KHR_materials_unlit');if(o.atlas.mimeType==='image/ktx2')addExtension('KHR_texture_basisu');
    json.materials??=[];newMaterial=json.materials.length;json.materials.push({name:o.material.name,pbrMetallicRoughness:{baseColorFactor:[1,1,1,1],baseColorTexture:{index:texture,texCoord:0},metallicFactor:0,roughnessFactor:o.material.roughness},doubleSided:o.material.doubleSided,...(Object.keys(extensions).length?{extensions}:{}),extras:structuredClone(o.extras)});
  }
  const groups=new Map<string,FacadeChartTarget[]>();for(const t of options.targets){const k=`${t.node}:${t.primitive}`,a=groups.get(k)??[];a.push(t);groups.set(k,a);}
  const changes:{node:string;primitive:number;targetTriangles:number;addedPrimitive:number;beforeIndicesSha256:string;keptIndicesSha256:string}[]=[];
  for(const targets of groups.values()){
    const target=targets[0]!,nodeId=json.nodes.findIndex((n:Json)=>n.name===target.node),node=json.nodes[nodeId],mesh=json.meshes[node.mesh],old=mesh.primitives[target.primitive];
    assert.ok(old && (old.mode??4)===4 && !old.targets && !old.extensions,'Unsupported target primitive extensions');
    const dn=doc.getRoot().listNodes().find(n=>n.getName()===target.node)!,p=dn.getMesh()!.listPrimitives()[target.primitive]!,idx=p.getIndices()!.getArray()!;
    assert.ok(array(p,'POSITION') instanceof Float32Array,'Source positions must retain native Float32 metres');
    const selected=new Set(targets.map(t=>t.triangle)),kept:number[]=[];for(let k=0;k<idx.length;k+=3)if(!selected.has(k/3))kept.push(Number(idx[k]),Number(idx[k+1]),Number(idx[k+2]));
    assert.ok(kept.length>0,'Cannot empty an original primitive; explicit empty-primitive policy required');
    const keptArray=Uint32Array.from(kept),newIndices=Uint32Array.from({length:targets.length*3},(_,i)=>i);
    old.indices=appendAccessor(keptArray,'SCALAR',false,true);
    const attrs:Json={},selectedVertices=targets.flatMap(t=>[0,1,2].map(k=>Number(idx[t.triangle*3+k]))),worlds=targets.flatMap(t=>[...worldTriangle(dn,p,t.triangle)]),chartFor=targets.flatMap(t=>Array(3).fill(options.charts.find(c=>c.id===t.chart)!)) as FacadeChart[];
    for(const semantic of p.listSemantics()){
      if(semantic===(distant?'COLOR_0':'TEXCOORD_0'))continue;
      const a=p.getAttribute(semantic)!,source=array(p,semantic),size=a.getElementSize(),ArrayType=source.constructor as {new(length:number):NumericArray},data=new ArrayType(selectedVertices.length*size);
      selectedVertices.forEach((v,i)=>data.set(source.subarray(v*size,(v+1)*size),i*size));attrs[semantic]=appendAccessor(data,a.getType(),a.getNormalized());
    }
    if(distant){
      const o=options as DistantChartOptions,mat=p.getMaterial();assert.ok(mat && !mat.getBaseColorTexture(),'Distant target must remain textureless');assert.deepEqual(mat.getBaseColorFactor(),[1,1,1,1]);
      const colours:number[]=[];for(let i=0;i<targets.length;i++){const t=targets[i]!,chart=chartFor[i*3]!;proveFacadeCoverage(worldTriangle(dn,p,t.triangle),o.detailedCoverage.get(t.chart)??[],chart);}
      worlds.forEach((v,i)=>colours.push(...sampleFacadeChartColour(v,chartFor[i]!,o.image)));attrs.COLOR_0=appendAccessor(Float32Array.from(colours),'VEC3');
    }else{
      const o=options as DetailedChartOptions,uvs:number[]=[];worlds.forEach((v,i)=>uvs.push(...facadeChartUv(v,chartFor[i]!,o.atlas.width,o.atlas.height)));attrs.TEXCOORD_0=appendAccessor(Float32Array.from(uvs),'VEC2');
    }
    const added=mesh.primitives.length;mesh.primitives.push({...structuredClone(old),attributes:attrs,indices:appendAccessor(newIndices,'SCALAR',false,true),material:distant?old.material:newMaterial,extras:{...old.extras,facadeCharts:[...new Set(targets.map(t=>t.chart))],materialOnly:true}});
    changes.push({node:target.node,primitive:target.primitive,targetTriangles:targets.length,addedPrimitive:added,beforeIndicesSha256:facadeChartSha256(new Uint8Array(idx.buffer,idx.byteOffset,idx.byteLength)),keptIndicesSha256:facadeChartSha256(new Uint8Array(keptArray.buffer,keptArray.byteOffset,keptArray.byteLength))});
  }
  const bin=Buffer.concat(pieces);assert.equal(bin.length,physical);assert.deepEqual(bin.subarray(0,original.bin.length),original.bin);
  json.buffers[0].byteLength=physical;json.buffers[virtual].byteLength=logical;
  const text=Buffer.from(JSON.stringify(json)),padded=Buffer.alloc(align4(text.length),0x20);text.copy(padded);const out=Buffer.alloc(28+padded.length+bin.length);
  out.writeUInt32LE(0x46546c67,0);out.writeUInt32LE(2,4);out.writeUInt32LE(out.length,8);out.writeUInt32LE(padded.length,12);out.writeUInt32LE(0x4e4f534a,16);padded.copy(out,20);out.writeUInt32LE(bin.length,20+padded.length);out.writeUInt32LE(0x004e4942,24+padded.length);bin.copy(out,28+padded.length);
  const result=readFacadeGlb(out),q=result.json as Json,b=original.json as Json;
  for(const name of ['accessors','bufferViews','images','textures','samplers','materials'])assert.deepEqual(q[name]?.slice(0,b[name]?.length??0)??[],b[name]??[],`Old ${name} payload descriptors changed`);
  assert.deepEqual(q.nodes,b.nodes);assert.deepEqual(q.scenes,b.scenes);
  for(let mi=0;mi<b.meshes.length;mi++)for(let pi=0;pi<b.meshes[mi].primitives.length;pi++){
    const old=b.meshes[mi].primitives[pi],next=q.meshes[mi].primitives[pi],changed=changes.some(c=>json.nodes.find((n:Json)=>n.name===c.node).mesh===mi && c.primitive===pi);
    assert.deepEqual({...next,indices:old.indices},old,'An existing primitive changed outside its drawing index partition');if(!changed)assert.equal(next.indices,old.indices);
  }
  const after=await io.readBinary(out);assert.deepEqual(geometry(after),beforeGeometry,'Facade adapter changed the world coordinate/winding triangle multiset');
  return {bytes:new Uint8Array(out),proof:{sourceSha256:options.expectedSha256,outputSha256:facadeChartSha256(out),targetTriangles:options.targets.length,addedPrimitives:changes.length,changes,textureBytesEstimate,fallbackBytes,
    preserved:{originalBinPrefix:true,oldAccessorAndImageDescriptors:true,untargetedAttributesAndUvs:true,nodesAndTransforms:true,worldTriangleCoordinateAndWindingMultiset:true},distantFidelity:distant?'Same coarse triangles, vertex-colour sampling; no window geometry or distant texture added':null}};
}

export const applyFacadeChartsToGlb = (bytes: Uint8Array, options: DetailedChartOptions) => apply(bytes,options,false);
export const applyFacadeChartColorsToLod2 = (bytes: Uint8Array, options: DistantChartOptions) => apply(bytes,options,true);
