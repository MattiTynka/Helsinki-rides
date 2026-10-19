// Replace explicitly selected ground geometry without reserializing any accepted image or other mesh.
import assert from 'node:assert/strict';
import {MeshoptEncoder} from 'meshoptimizer';
import {readFacadeGlb} from './facade-glb.ts';

export type GroundAttributeArray=Float32Array|Uint32Array|Uint16Array|Int16Array|Uint8Array|Int8Array;
export interface GroundGlbReplacement {
  nodeName:string;
  primitiveIndex:number;
  /** Distant cells combine exact ground and architecture; caller must retain every architectural face. */
  kind?:'ground'|'distant-ground'|'coastal-water';
  /** Raw accessor values, including the original integer representation of normalized attributes. */
  attributes:Readonly<Record<string,GroundAttributeArray>>;
  /** Empty indices and attributes explicitly remove this primitive. */
  indices:Uint32Array|Uint16Array|Uint8Array;
}
const align4=(n:number)=>(n+3)&~3;
const componentType=(a:GroundAttributeArray)=>a instanceof Float32Array?5126:a instanceof Uint32Array?5125:a instanceof Uint16Array?5123:a instanceof Int16Array?5122:a instanceof Int8Array?5120:5121;
const componentCount=(type:string)=>({SCALAR:1,VEC2:2,VEC3:3,VEC4:4}[type]);

/** Returns a new GLB; never writes a file. Node transforms and material references stay unchanged. Each
 *  selected node receives an appended mesh, so even a mesh shared with an unselected node is preserved. */
export async function replaceGroundGlb(bytes:Uint8Array,replacements:readonly GroundGlbReplacement[]):Promise<Uint8Array>{
  if(!replacements.length)return bytes.slice();
  await MeshoptEncoder.ready;
  const original=readFacadeGlb(bytes),json=structuredClone(original.json) as any;
  assert.ok(json.extensionsRequired?.includes('EXT_meshopt_compression'),'Replacement requires existing meshopt contract');
  const virtual=json.buffers.findIndex((b:any,i:number)=>i>0&&b.extensions?.EXT_meshopt_compression?.fallback===true);
  assert.ok(virtual>0,'Missing meshopt fallback buffer');
  let physical=align4(original.bin.length),logical=align4(json.buffers[virtual].byteLength);
  const pieces:Uint8Array[]=[original.bin,new Uint8Array(physical-original.bin.length)];
  const changes=new Map<number,Map<number,GroundGlbReplacement>>();
  for(const replacement of replacements){
    if(replacement.kind!=='distant-ground'&&replacement.kind!=='coastal-water')assert.match(replacement.nodeName,/_ground_/,'Only explicitly selected ground nodes may be replaced');
    const nodes=json.nodes.map((n:any,i:number)=>n.name===replacement.nodeName?i:-1).filter((i:number)=>i>=0);assert.equal(nodes.length,1,`Ground node must be unique: ${replacement.nodeName}`);
    const nodeId=nodes[0]!,node=json.nodes[nodeId];assert.ok(Number.isInteger(node.mesh),'Ground node has no mesh');
    assert.ok(node.skin===undefined&&!node.weights,'Skinned or morphing ground is unsupported');
    const primitive=json.meshes[node.mesh].primitives[replacement.primitiveIndex];assert.ok(primitive&&Number.isInteger(replacement.primitiveIndex),'Missing selected ground primitive');
    if(replacement.kind==='coastal-water'){
      assert.match(replacement.nodeName,/^(?:append(?:[2-9]|[1-9]\d+)?:)?c_[mp]\d+_[mp]\d+_water$/,'Coastal replacement requires a native water node');assert.equal(json.meshes[node.mesh].primitives.length,1);const material=json.materials[primitive.material];assert.equal(material?.name,'coastal_water');assert.deepEqual(material.pbrMetallicRoughness?.baseColorFactor,[.07,.18,.23,1]);assert.equal(material.pbrMetallicRoughness?.roughnessFactor,.25);assert.equal(material.pbrMetallicRoughness?.metallicFactor,.15);assert.ok(!material.extensions?.KHR_materials_unlit);assert.equal(material.pbrMetallicRoughness?.baseColorTexture,undefined);assert.deepEqual(Object.keys(primitive.attributes).sort(),['NORMAL','POSITION']);
      const originalPosition=json.accessors[primitive.attributes.POSITION],waterY=originalPosition.min?.[1];assert.ok(typeof waterY==='number'&&Number.isFinite(waterY));assert.equal(originalPosition.max?.[1],waterY,'Original coastal water must be flat');assert.ok(json.scenes[0].nodes.includes(nodeId),'Native coastal water must be a scene root');assert.deepEqual(node.translation??[0,0,0],[0,0,0]);assert.deepEqual(node.rotation??[0,0,0,1],[0,0,0,1]);assert.deepEqual(node.scale??[1,1,1],[1,1,1]);assert.deepEqual(node.matrix??[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);
      const position=replacement.attributes.POSITION;assert.ok(position instanceof Float32Array);for(let i=1;i<position.length;i+=3)assert.equal(position[i],waterY,'Coastal water must retain its source plane');
    }
    if(replacement.kind==='distant-ground'){
      assert.equal(json.extras?.level,'distant','Distant ground requires the native distant-cell contract');
      const cell=json.extras?.cell;assert.ok(typeof cell==='string'&&cell.length,'Distant ground requires a named native cell');
      const namespace=replacement.nodeName.endsWith(`:${cell}`)?replacement.nodeName.slice(0,-cell.length):'';
      assert.ok(replacement.nodeName===cell||/^append(?:[2-9]|[1-9]\d+)?:$/.test(namespace),'Distant ground node must match its base or appended cell');
      assert.equal(json.meshes[node.mesh].primitives.length,1);
      assert.ok(!json.images?.length&&!json.textures?.length,'Distant ground must be textureless');
      assert.deepEqual(Object.keys(primitive.attributes).sort(),['COLOR_0','POSITION'],'Distant ground requires POSITION and COLOR_0 only');
    }
    assert.equal(primitive.mode??4,4,'Only triangle ground is supported');assert.ok(!primitive.targets?.length,'Morphing ground is unsupported');
    assert.deepEqual(Object.keys(replacement.attributes).sort(),Object.keys(primitive.attributes).sort(),'Every ground attribute must be replaced together');
    assert.ok(replacement.indices instanceof Uint8Array||replacement.indices instanceof Uint16Array||replacement.indices instanceof Uint32Array,'Indices must use an unsigned integer typed array');
    assert.equal(replacement.indices.length%3,0,'Ground indices must be triangles');
    let vertices:number|undefined;
    for(const[semantic,array]of Object.entries(replacement.attributes)){
      const accessor=json.accessors[primitive.attributes[semantic]],components=componentCount(accessor.type);assert.ok(components,'Unsupported ground accessor shape');assert.ok(!accessor.sparse,'Sparse ground requires explicit implementation');
      assert.equal(componentType(array),accessor.componentType,`${semantic} must preserve accessor component type`);assert.equal(array.length%components,0);
      const count=array.length/components;if(vertices===undefined)vertices=count;else assert.equal(count,vertices,'Replacement attribute vertex counts differ');
      assert.ok(array.every(Number.isFinite),`Nonfinite ${semantic}`);
      if(semantic==='NORMAL'){
        assert.equal(components,3);const scale=accessor.normalized?(array instanceof Int8Array?127:array instanceof Int16Array?32767:0):1;assert.ok(scale,'Unsupported normalized normal type');
        for(let i=0;i<array.length;i+=3){const length=Math.hypot(...Array.from(array.subarray(i,i+3),v=>accessor.normalized?Math.max(-1,v/scale):v));assert.ok(Math.abs(length-1)<(scale===127?.015:scale===32767?.0001:.0001),'Replacement normal must remain unit length');}
      }
    }
    assert.ok(vertices!==undefined&&replacement.attributes.POSITION,'Ground POSITION required');
    assert.ok(replacement.indices.every(i=>i<vertices!),'Replacement index exceeds vertex count');
    if(!replacement.indices.length)assert.equal(vertices,0,'Removed primitive attributes must also be empty');else assert.ok(vertices>0);
    const nodeChanges=changes.get(nodeId)??new Map<number,GroundGlbReplacement>();assert.ok(!nodeChanges.has(replacement.primitiveIndex),'Duplicate primitive replacement');nodeChanges.set(replacement.primitiveIndex,replacement);changes.set(nodeId,nodeChanges);
  }
  function appendAccessor(oldId:number,array:GroundAttributeArray,indices=false){
    const accessor=structuredClone(json.accessors[oldId]);assert.ok(accessor,'Missing source accessor');assert.ok(!accessor.sparse);const components=componentCount(accessor.type)!;assert.ok(components);
    const count=array.length/components,elementBytes=array.BYTES_PER_ELEMENT*components,stride=indices?elementBytes:align4(elementBytes);
    const source=new Uint8Array(count*stride),raw=new Uint8Array(array.buffer,array.byteOffset,array.byteLength);
    for(let i=0;i<count;i++)source.set(raw.subarray(i*elementBytes,(i+1)*elementBytes),i*stride);
    const mode=indices?'INDICES':'ATTRIBUTES',encoded=MeshoptEncoder.encodeGltfBuffer(source,count,stride,mode),viewId=json.bufferViews.length;
    const view:any={buffer:virtual,byteOffset:logical,byteLength:source.length,target:indices?34963:34962,extensions:{EXT_meshopt_compression:{buffer:0,byteOffset:physical,byteLength:encoded.length,byteStride:stride,count,mode}}};if(!indices)view.byteStride=stride;
    json.bufferViews.push(view);pieces.push(encoded,new Uint8Array(align4(encoded.length)-encoded.length));physical+=align4(encoded.length);logical+=align4(source.length);
    accessor.bufferView=viewId;accessor.byteOffset=0;accessor.componentType=componentType(array);accessor.count=count;
    if(accessor.min||accessor.max){const min=Array(components).fill(Infinity),max=Array(components).fill(-Infinity);for(let i=0;i<array.length;i++){const k=i%components;min[k]=Math.min(min[k],array[i]!);max[k]=Math.max(max[k],array[i]!);}accessor.min=min;accessor.max=max;}
    const id=json.accessors.length;json.accessors.push(accessor);return id;
  }
  for(const[nodeId,nodeChanges]of changes){
    const node=json.nodes[nodeId],mesh=structuredClone(json.meshes[node.mesh]);
    mesh.primitives=mesh.primitives.flatMap((primitive:any,i:number)=>{
      const replacement=nodeChanges.get(i);if(!replacement)return[primitive];if(!replacement.indices.length)return[];
      for(const[semantic,array]of Object.entries(replacement.attributes))primitive.attributes[semantic]=appendAccessor(primitive.attributes[semantic],array);
      primitive.indices=appendAccessor(primitive.indices,replacement.indices,true);return[primitive];
    });
    if(mesh.primitives.length){node.mesh=json.meshes.length;json.meshes.push(mesh);}else delete node.mesh;
  }
  const bin=Buffer.concat(pieces);assert.equal(bin.length,physical);assert.deepEqual(bin.subarray(0,original.bin.length),original.bin,'Original BIN prefix changed');
  json.buffers[0].byteLength=physical;json.buffers[virtual].byteLength=logical;
  // Every old resource definition is kept, including replaced but now unused ground accessors/meshes.
  for(const key of['accessors','bufferViews','meshes'])assert.deepEqual(json[key].slice(0,(original.json[key] as any[]).length),original.json[key],`Original ${key} prefix changed`);
  const normalized=structuredClone(json);for(const[nodeId]of changes)normalized.nodes[nodeId]=structuredClone((original.json.nodes as any[])[nodeId]);
  for(const key of['accessors','bufferViews','meshes'])normalized[key]=normalized[key].slice(0,(original.json[key] as any[]).length);
  normalized.buffers=original.json.buffers;assert.deepEqual(normalized,original.json,'Unselected GLB semantics changed');
  const text=Buffer.from(JSON.stringify(json)),padded=Buffer.alloc(align4(text.length),0x20);text.copy(padded);
  const out=Buffer.alloc(28+padded.length+bin.length);out.writeUInt32LE(0x46546c67,0);out.writeUInt32LE(2,4);out.writeUInt32LE(out.length,8);out.writeUInt32LE(padded.length,12);out.writeUInt32LE(0x4e4f534a,16);padded.copy(out,20);out.writeUInt32LE(bin.length,20+padded.length);out.writeUInt32LE(0x004e4942,24+padded.length);bin.copy(out,28+padded.length);
  return out;
}
