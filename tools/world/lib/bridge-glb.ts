// Bounded bridge replacement: old encoded BIN bytes remain a literal prefix.
// Only explicit ground/kerb/rail drawing indices are partitioned; architecture,
// original material/image descriptors and all outside source fragments survive.
import assert from 'node:assert/strict';
import type {Document} from '@gltf-transform/core';
import {MeshoptEncoder} from 'meshoptimizer';
import {readFacadeGlb} from './facade-glb.ts';
import {packGlb} from './shared-textures.ts';
import {supportNormal,supportHeight,type TramSupportPatch,type SupportTriangle} from './tram-support-repair.ts';
import {retainOutsideBridge} from './bridge-ground-replacement.ts';
import {appendTramVisualGlb} from './append-tram-glb.ts';
import {BRIDGE_COLOURS,type BridgeFace,type BridgeMaterial} from './bridge-reconstruction.ts';
import type {TramMesh} from './tram-visuals.ts';
import type {TramGroundTriangle,TramVertex} from './tram-visuals.ts';
import type {CollisionBundle} from '../../../packages/world-schema/src/index.ts';
import {upwardTramTriangle} from './tram-cell-ground.ts';
type ArrayData=Float32Array|Uint32Array|Uint16Array|Int16Array|Uint8Array|Int8Array;
const align=(n:number)=>(n+3)&~3;
const typeOf=(a:ArrayData)=>a instanceof Float32Array?5126:a instanceof Uint32Array?5125:a instanceof Uint16Array?5123:a instanceof Int16Array?5122:a instanceof Uint8Array?5121:5120;
const triangleKey=(points:readonly number[][])=>points.map(p=>p.map(Math.fround).join(',')).sort().join('|');
export function bridgeFragmentNodeName(name:string,index:number):string{const suffix=name.match(/_(tram_visuals|ground_(?:slabs|cobble|asphalt|grass|setts|yard))$/)?.[1];return`${name}_bridge_clipped_${index}${suffix?'_'+suffix:''}`;}

/** Outside triangles keep the source accessors. Only clipped fragments need
 * new attribute bytes; retaining every old vertex again duplicates the BIN. */
export function partitionBridgeReplacementGeometry(mesh:{attributes:Record<string,ArrayData>;components:Record<string,number>;indices:Uint32Array},originalVertexCount:number){
 const original:number[]=[],fragment:number[]=[];
 for(let i=0;i<mesh.indices.length;i+=3){const t=Array.from(mesh.indices.subarray(i,i+3));(t.every(v=>v<originalVertexCount)?original:fragment).push(...t);}
 const vertices=[...new Set(fragment)],lookup=new Map(vertices.map((v,i)=>[v,i])),attributes:Record<string,ArrayData>={};
 for(const[semantic,array]of Object.entries(mesh.attributes)){
  const components=mesh.components[semantic]!,compact=new(array.constructor as{new(length:number):ArrayData})(vertices.length*components);
  for(let i=0;i<vertices.length;i++)compact.set(array.subarray(vertices[i]!*components,(vertices[i]!+1)*components),i*components);
  attributes[semantic]=compact;
 }
 return{originalIndices:Uint32Array.from(original),fragments:{attributes,indices:Uint32Array.from(fragment.map(v=>lookup.get(v)!))},originalVertexCount,fragmentVertexCount:vertices.length};
}

/** Newly authored floors use identical Float32 triangles in both payloads.
 * Binding those exact faces avoids inventing tiny intersection subfacets at
 * dense apron edges. A visual-only face cannot authorize rail placement. */
export function readExactBridgeRoadGround(doc:Document,bundle:CollisionBundle):TramGroundTriangle[]{
 const physical=new Map<string,{collider:string;triangles:number[];tag:string}>();
 for(const collider of bundle.colliders.filter(c=>c.group==='ground'))for(let triangle=0;triangle<collider.indices.length/3;triangle++){
  const tag=bundle.header.surfaceTags[collider.triangleTags[triangle]!]!;if(tag!=='road:asphalt:bridge-reconstruction')continue;
  const points=[0,1,2].map(k=>Array.from(collider.positions.slice(collider.indices[triangle*3+k]!*3,collider.indices[triangle*3+k]!*3+3))),key=triangleKey(points);assert.ok(!physical.has(key),'Duplicate reconstructed road floor');physical.set(key,{collider:collider.id,triangles:[triangle],tag});
 }
 const result:TramGroundTriangle[]=[];
 for(const node of doc.getRoot().listNodes().filter(n=>n.getName().includes('_ground_bridge_')))for(const[primitive,p]of(node.getMesh()?.listPrimitives()??[]).entries())for(let triangle=0;triangle<p.getIndices()!.getCount()/3;triangle++){
  const vertices=[0,1,2].map(k=>p.getAttribute('POSITION')!.getElement(p.getIndices()!.getScalar(triangle*3+k),[]) as unknown as TramVertex) as [TramVertex,TramVertex,TramVertex];if(!upwardTramTriangle(vertices))continue;const match=physical.get(triangleKey(vertices));if(!match)continue;
  result.push({id:`${node.getName()}:${primitive}:${triangle}`,vertices,visual:{node:node.getName(),primitive,triangle},collision:{collider:match.collider,triangles:match.triangles},tag:match.tag});
 }
 return result;
}
type P=[number,number];
const cross=(a:P,b:P,p:P)=>(b[0]-a[0])*(p[1]-a[1])-(b[1]-a[1])*(p[0]-a[0]);
const projectedArea=(p:readonly P[])=>Math.abs(p.reduce((n,a,i)=>{const b=p[(i+1)%p.length]!;return n+a[0]*b[1]-a[1]*b[0];},0))/2;
function halfPlane(r:readonly P[],value:(p:P)=>number){const out:P[]=[];for(let i=0;i<r.length;i++){const a=r[i]!,b=r[(i+1)%r.length]!,u=value(a),v=value(b);if(u>=0)out.push(a);if((u>=0)!==(v>=0)){const t=u/(u-v);out.push([a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t]);}}return out;}
/** Geometric qualification for simplified ground with different diagonals.
 * Every part must be covered by an actual authoritative HCOL floor plane. */
export function bridgeCoarseFloorMatches(triangle:SupportTriangle,floors:readonly SupportTriangle[]):boolean{
 try{if(supportNormal(triangle)[1]<=.3)return false;}catch{return false;}const ring=triangle.map(p=>[p[0],p[2]] as P);let remaining:P[][]=[ring];
 for(const floor of floors){try{if(supportNormal(floor)[1]<=.3)continue;}catch{continue;}const clip=floor.map(p=>[p[0],p[2]] as P),sign=Math.sign(cross(clip[0]!,clip[1]!,clip[2]!)),next:P[][]=[];
  for(const fragment of remaining){let common=fragment;for(let i=0;i<3&&common.length;i++)common=halfPlane(common,p=>cross(clip[i]!,clip[(i+1)%3]!,p)*sign);if(common.length<3||projectedArea(common)<1e-14||common.some(p=>Math.abs(supportHeight(floor,p)-supportHeight(triangle,p))>.00001)){next.push(fragment);continue;}
   let rest=fragment;for(let i=0;i<3&&rest.length>=3;i++){const value=(p:P)=>cross(clip[i]!,clip[(i+1)%3]!,p)*sign,outside=halfPlane(rest,p=>-value(p));if(outside.length>=3&&projectedArea(outside)>1e-14)next.push(outside);rest=halfPlane(rest,value);}
  }remaining=next;if(!remaining.length)return true;
 }return remaining.reduce((n,p)=>n+projectedArea(p),0)<=1e-8;
}

export function bridgeArchitectureFaceKeys(doc:Document):Set<string>{
 const keys=new Set<string>();for(const n of doc.getRoot().listNodes())if(!/_ground_|kerb|_tram_visuals/.test(n.getName()))for(const p of n.getMesh()?.listPrimitives()??[]){const P=p.getAttribute('POSITION')!,I=p.getIndices()!;for(let i=0;i<I.getCount();i+=3)keys.add(triangleKey([0,1,2].map(k=>P.getElement(I.getScalar(i+k),[]))));}return keys;
}

export function bridgeExclusiveGroundVertices(doc:Document):Set<string>{
 const ground=new Set<string>(),architecture=new Set<string>();for(const n of doc.getRoot().listNodes())for(const p of n.getMesh()?.listPrimitives()??[]){const P=p.getAttribute('POSITION')!,I=p.getIndices()!,target=/_ground_|kerb|_tram_visuals/.test(n.getName())?ground:architecture;for(let i=0;i<I.getCount();i++)target.add(P.getElement(I.getScalar(i),[]).map(Math.fround).join(','));}return new Set([...ground].filter(k=>!architecture.has(k)));
}

export function bridgeSourceFaceKeys(doc:Document):Set<string>{
 const keys=new Set<string>();for(const n of doc.getRoot().listNodes())if(/_ground_|kerb|_tram_visuals/.test(n.getName()))for(const p of n.getMesh()?.listPrimitives()??[]){const P=p.getAttribute('POSITION')!,I=p.getIndices()!;for(let i=0;i<I.getCount();i+=3)keys.add(triangleKey([0,1,2].map(k=>P.getElement(I.getScalar(i+k),[]))));}return keys;
}
export async function replaceBridgeGlb(bytes:Uint8Array,doc:Document,zones:readonly TramSupportPatch[],options:{coarse:boolean;sourceKeys:ReadonlySet<string>;sourceFloors?:readonly SupportTriangle[];protectedArchitecture?:ReadonlySet<string>;exclusiveGroundVertices?:ReadonlySet<string>}):Promise<{bytes:Uint8Array;removed:unknown[]}>{
 const floorBins=new Map<string,SupportTriangle[]>();for(const t of options.sourceFloors??[])for(let x=Math.floor(Math.min(...t.map(p=>p[0]))/8);x<=Math.floor(Math.max(...t.map(p=>p[0]))/8);x++)for(let z=Math.floor(Math.min(...t.map(p=>p[2]))/8);z<=Math.floor(Math.max(...t.map(p=>p[2]))/8);z++){const key=`${x},${z}`,list=floorBins.get(key)??[];list.push(t);floorBins.set(key,list);}
 await MeshoptEncoder.ready;const raw=readFacadeGlb(bytes),json=structuredClone(raw.json) as any,virtual=json.buffers.findIndex((b:any,i:number)=>i>0&&b.extensions?.EXT_meshopt_compression?.fallback===true);assert.ok(virtual>0);
 let physical=align(raw.bin.length),logical=align(json.buffers[virtual].byteLength);const payloads:Uint8Array[]=[raw.bin,new Uint8Array(physical-raw.bin.length)],removed:unknown[]=[];
 function accessor(array:ArrayData,oldId:number,indices=false){const old=json.accessors[oldId],components=({SCALAR:1,VEC2:2,VEC3:3,VEC4:4} as Record<string,number>)[old.type]!,count=array.length/components,elementBytes=components*array.BYTES_PER_ELEMENT,stride=indices?elementBytes:align(elementBytes);assert.ok(count&&Number.isSafeInteger(count));const rawArray=new Uint8Array(array.buffer,array.byteOffset,array.byteLength),data=new Uint8Array(count*stride);for(let i=0;i<count;i++)data.set(rawArray.subarray(i*elementBytes,(i+1)*elementBytes),i*stride);const encoded=MeshoptEncoder.encodeGltfBuffer(data,count,stride,indices?'INDICES':'ATTRIBUTES'),view=json.bufferViews.length;
  json.bufferViews.push({buffer:virtual,byteOffset:logical,byteLength:data.length,...(!indices?{byteStride:stride}:{}),target:indices?34963:34962,extensions:{EXT_meshopt_compression:{buffer:0,byteOffset:physical,byteLength:encoded.length,byteStride:stride,count,mode:indices?'INDICES':'ATTRIBUTES'}}});payloads.push(encoded,new Uint8Array(align(encoded.length)-encoded.length));physical+=align(encoded.length);logical+=align(data.length);
  const a={...structuredClone(old),bufferView:view,byteOffset:0,componentType:typeOf(array),count};if(a.min||a.max){a.min=Array(components).fill(Infinity);a.max=Array(components).fill(-Infinity);for(let i=0;i<array.length;i++){const k=i%components;a.min[k]=Math.min(a.min[k],array[i]!);a.max[k]=Math.max(a.max[k],array[i]!);}}const id=json.accessors.length;json.accessors.push(a);return id;
 }
 for(const n of doc.getRoot().listNodes()){
  const name=n.getName(),mesh=n.getMesh();if(!mesh||(!options.coarse&&!/_ground_|kerb|_tram_visuals/.test(name)))continue;
  assert.deepEqual(n.getWorldMatrix(),[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],'Bridge replacement requires baked native positions');
  const node=json.nodes.find((v:any)=>v.name===name);assert.ok(node);const next=structuredClone(json.meshes[node.mesh]),kept=[];
  for(const[i,p]of mesh.listPrimitives().entries()){
   const attributes:Record<string,ArrayData>={},components:Record<string,number>={},normalized:Record<string,boolean>={};for(const semantic of p.listSemantics()){const a=p.getAttribute(semantic)!;attributes[semantic]=a.getArray()! as ArrayData;components[semantic]=a.getElementSize();normalized[semantic]=a.getNormalized();}
   const selected=retainOutsideBridge({attributes,components,normalized,indices:p.getIndices()!.getArray()! as any},zones,options.coarse?index=>{const tri=[0,1,2].map(k=>p.getAttribute('POSITION')!.getElement(p.getIndices()!.getScalar(index*3+k),[])) as unknown as SupportTriangle,key=triangleKey(tri);if(options.protectedArchitecture?.has(key))return false;if(options.sourceKeys.has(key))return true;if(tri.every(p=>options.exclusiveGroundVertices?.has(p.map(Math.fround).join(','))))return true;const bounds=[Math.min(...tri.map(v=>v[0])),Math.min(...tri.map(v=>v[2])),Math.max(...tri.map(v=>v[0])),Math.max(...tri.map(v=>v[2]))];if(!zones.some(z=>bounds[0]!<=z.boundsXZ[2]&&bounds[2]!>=z.boundsXZ[0]&&bounds[1]!<=z.boundsXZ[3]&&bounds[3]!>=z.boundsXZ[1]))return false;const nearby=new Set<SupportTriangle>();for(let x=Math.floor(bounds[0]!/8);x<=Math.floor(bounds[2]!/8);x++)for(let z=Math.floor(bounds[1]!/8);z<=Math.floor(bounds[3]!/8);z++)for(const floor of floorBins.get(`${x},${z}`)??[])nearby.add(floor);return bridgeCoarseFloorMatches(tri,[...nearby]);}:undefined);
   if(!selected.proof.removedSourceTriangles.length&&!selected.proof.clippedSourceTriangles.length){kept.push(next.primitives[i]);continue;}
   removed.push({node:name,primitive:i,facets:selected.proof});
   if(!selected.mesh.indices.length)continue;
   const q=next.primitives[i],partition=partitionBridgeReplacementGeometry(selected.mesh,p.getAttribute('POSITION')!.getCount());
   if(partition.originalIndices.length){const outside=structuredClone(q);outside.indices=accessor(partition.originalIndices,q.indices,true);kept.push(outside);}
   if(partition.fragments.indices.length){const fragment=structuredClone(q);for(const semantic of p.listSemantics())fragment.attributes[semantic]=accessor(partition.fragments.attributes[semantic]!,q.attributes[semantic]);fragment.indices=accessor(partition.fragments.indices,q.indices,true);const fragmentName=bridgeFragmentNodeName(name,i),meshId=json.meshes.length;json.meshes.push({name:fragmentName,primitives:[fragment]});const nodeId=json.nodes.length;json.nodes.push({name:fragmentName,mesh:meshId});json.scenes[json.scene??0].nodes.push(nodeId);}
  }
  if(kept.length!==next.primitives.length||removed.some((v:any)=>v.node===name)){if(kept.length){next.primitives=kept;node.mesh=json.meshes.length;json.meshes.push(next);}else delete node.mesh;}
 }
 const bin=Buffer.concat(payloads);assert.deepEqual(bin.subarray(0,raw.bin.length),raw.bin);json.buffers[0].byteLength=physical;json.buffers[virtual].byteLength=logical;
 return{bytes:packGlb(json,bin),removed};
}

function asTramMesh(faces:readonly BridgeFace[]):TramMesh{
 const mesh:TramMesh={positions:[],normals:[],uvs:[],colours:[],indices:[],bindings:[],stats:{expectedArea:0,coveredArea:0,missingArea:0,maximumLiftError:0,triangles:faces.length}};
 for(const face of faces){const first=mesh.positions.length/3,n=supportNormal(face.points);for(let k=0;k<3;k++){mesh.positions.push(...face.points[k]!);mesh.normals.push(...n);mesh.uvs.push(...face.uvs[k]!);mesh.colours.push(...BRIDGE_COLOURS[face.material]);}mesh.indices.push(first,first+1,first+2);}return mesh;
}
export async function appendBridgeGlb(bytes:Uint8Array,faces:readonly BridgeFace[],options:{cell:string;coarse:boolean;graniteUri:string;revetmentUri?:string;externalImages:ReadonlyMap<string,Uint8Array>}):Promise<Uint8Array>{
 if(!faces.length)return bytes.slice();
 if(options.coarse)return appendTramVisualGlb(bytes,asTramMesh(faces),{cell:options.cell,coarse:true,externalImages:options.externalImages,coarseLimits:{meshes:32,primitivesPerMesh:16}});
 await MeshoptEncoder.ready;const raw=readFacadeGlb(bytes),json=structuredClone(raw.json) as any,virtual=json.buffers.findIndex((b:any,i:number)=>i>0&&b.extensions?.EXT_meshopt_compression?.fallback===true);assert.ok(virtual>0);
 let physical=align(raw.bin.length),logical=align(json.buffers[virtual].byteLength);const payloads:Uint8Array[]=[raw.bin,new Uint8Array(physical-raw.bin.length)];
 function accessor(a:Float32Array|Uint32Array,type:'SCALAR'|'VEC2'|'VEC3',indices=false){const components=type==='SCALAR'?1:type==='VEC2'?2:3,count=a.length/components,stride=components*4,data=new Uint8Array(a.buffer,a.byteOffset,a.byteLength),encoded=MeshoptEncoder.encodeGltfBuffer(data,count,stride,indices?'INDICES':'ATTRIBUTES'),view=json.bufferViews.length;
  json.bufferViews.push({buffer:virtual,byteOffset:logical,byteLength:data.length,...(!indices?{byteStride:stride}:{}),target:indices?34963:34962,extensions:{EXT_meshopt_compression:{buffer:0,byteOffset:physical,byteLength:encoded.length,byteStride:stride,count,mode:indices?'INDICES':'ATTRIBUTES'}}});payloads.push(encoded,new Uint8Array(align(encoded.length)-encoded.length));physical+=align(encoded.length);logical+=align(data.length);const min=Array(components).fill(Infinity),max=Array(components).fill(-Infinity);for(let i=0;i<a.length;i++){const k=i%components;min[k]=Math.min(min[k],a[i]!);max[k]=Math.max(max[k],a[i]!);}const id=json.accessors.length;json.accessors.push({bufferView:view,byteOffset:0,componentType:indices?5125:5126,count,type,...(!indices?{min,max}:{})});return id;
 }
 const groups=new Map<BridgeMaterial,BridgeFace[]>();for(const face of faces){const a=groups.get(face.material)??[];a.push(face);groups.set(face.material,a);}
 for(const[material,items]of groups){const mesh=asTramMesh(items),colour=BRIDGE_COLOURS[material],pbr:any={baseColorFactor:[...colour,material==='glass'?.3:1],roughnessFactor:material==='glass'?.2:material==='steel'?.65:.95,metallicFactor:material==='steel'?.45:0};
  if(material==='granite'||material==='revetment'){
   const imageUri=material==='revetment'?options.revetmentUri:options.graniteUri;assert.ok(imageUri);
   assert.match(imageUri,/^\.\.\/textures\/[a-f0-9]{64}\.ktx2$/);json.images??=[];json.textures??=[];json.samplers??=[];const image=json.images.length;json.images.push({name:'original-bridge-granite-courses',uri:imageUri,mimeType:'image/ktx2'});const sampler=json.samplers.length;json.samplers.push({magFilter:9729,minFilter:9987,wrapS:10497,wrapT:10497});const texture=json.textures.length;json.textures.push({sampler,extensions:{KHR_texture_basisu:{source:image}}});pbr.baseColorFactor=[1,1,1,1];pbr.baseColorTexture={index:texture};for(const key of ['extensionsUsed','extensionsRequired']){json[key]??=[];if(!json[key].includes('KHR_texture_basisu'))json[key].push('KHR_texture_basisu');}
  }
  const oldAsphalt=material==='asphalt'?json.materials.find((m:any)=>/asphalt/.test(m.name??'')&&m.pbrMetallicRoughness?.baseColorTexture):null;
  const definition=oldAsphalt?{...structuredClone(oldAsphalt),name:'bridge-source-asphalt',extras:{...oldAsphalt.extras,bridgeReconstruction:true,sourceMaterial:oldAsphalt.name}}:{name:`bridge-original-${material}`,pbrMetallicRoughness:pbr,...(material==='glass'?{alphaMode:'BLEND'}:{}),doubleSided:false,extras:{originalArtwork:'CC0-1.0'}};
  const mid=json.materials.length;json.materials.push(definition);
  const primitive={mode:4,attributes:{POSITION:accessor(Float32Array.from(mesh.positions),'VEC3'),NORMAL:accessor(Float32Array.from(mesh.normals),'VEC3'),TEXCOORD_0:accessor(Float32Array.from(mesh.uvs),'VEC2')},indices:accessor(Uint32Array.from(mesh.indices),'SCALAR',true),material:mid};
  const name=`${options.cell}_${items.some(f=>f.role==='road'||f.role==='footway')?'ground_bridge':'bridge_architecture'}_${material}`,meshId=json.meshes.length;json.meshes.push({name,primitives:[primitive]});const node=json.nodes.length;json.nodes.push({name,mesh:meshId,extras:{bridgeReconstruction:true}});json.scenes[json.scene??0].nodes.push(node);
 }
 const bin=Buffer.concat(payloads);assert.deepEqual(bin.subarray(0,raw.bin.length),raw.bin);json.buffers[0].byteLength=physical;json.buffers[virtual].byteLength=logical;return packGlb(json,bin);
}
