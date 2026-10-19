// Add faces without serializing/recompressing any original geometry or image.
// Original BIN bytes remain a literal prefix; only the selected primitive points
// at appended, losslessly encoded copies of its original arrays plus the repair.
import assert from 'node:assert/strict';
import {MeshoptEncoder} from 'meshoptimizer';
import {readFacadeGlb} from './facade-glb.ts';

type NumericArray = Float32Array | Uint32Array | Uint16Array | Int16Array | Uint8Array | Int8Array;
export interface GroundGlbAppend {
  nodeName:string;
  primitiveIndex:number;
  attributes:Readonly<Record<string,{original:NumericArray; appended:readonly number[]}>>;
  indices:{original:NumericArray; appended:readonly number[]};
}
const align4=(n:number)=>(n+3)&~3;
const componentType=(a:NumericArray)=>a instanceof Float32Array?5126:a instanceof Uint32Array?5125:a instanceof Uint16Array?5123:a instanceof Int16Array?5122:a instanceof Int8Array?5120:5121;
const sizeOf=(type:string)=>({SCALAR:1,VEC2:2,VEC3:3,VEC4:4}[type]);

export async function appendGroundGlb(bytes:Uint8Array, additions:readonly GroundGlbAppend[]):Promise<Uint8Array> {
  if(!additions.length)return bytes.slice();
  await MeshoptEncoder.ready;
  const original=readFacadeGlb(bytes),json=structuredClone(original.json) as any;
  assert.ok(json.extensionsRequired?.includes('EXT_meshopt_compression'),'Append requires existing meshopt contract');
  const virtual=json.buffers.findIndex((b:any,i:number)=>i>0&&b.extensions?.EXT_meshopt_compression?.fallback===true);
  assert.ok(virtual>0,'Missing meshopt fallback buffer');
  let physical=align4(original.bin.length),logical=align4(json.buffers[virtual].byteLength);
  const pieces:Uint8Array[]=[original.bin,new Uint8Array(physical-original.bin.length)];
  const changed=new Set<string>();
  function appendAccessor(oldId:number,old:NumericArray,extra:readonly number[],indices=false) {
    const accessor=structuredClone(json.accessors[oldId]);
    assert.equal(componentType(old),accessor.componentType,'Decoded accessor component mismatch');
    assert.equal(old.length,accessor.count*sizeOf(accessor.type)!,'Decoded accessor size mismatch');
    assert.ok(!accessor.sparse,'Sparse ground requires explicit implementation');
    const components=sizeOf(accessor.type)!;assert.ok(components);
    assert.equal(extra.length%components,0);
    let Type=old.constructor as {new(length:number):NumericArray};
    if(indices&&extra.some(i=>i>65535)&&old instanceof Uint16Array)Type=Uint32Array;
    const array=new Type(old.length+extra.length);array.set(old);array.set(extra,old.length);
    if(indices)for(const i of extra)assert.ok(Number.isSafeInteger(i)&&i>=0,'Invalid appended index');
    assert.deepEqual(Array.from(array.subarray(0,old.length)),Array.from(old),'Original accessor prefix changed');
    for(const x of array)assert.ok(Number.isFinite(x),'Nonfinite appended accessor');
    const count=array.length/components,elementBytes=array.BYTES_PER_ELEMENT*components,stride=indices?elementBytes:align4(elementBytes);
    const source=new Uint8Array(count*stride),raw=new Uint8Array(array.buffer,array.byteOffset,array.byteLength);
    for(let i=0;i<count;i++)source.set(raw.subarray(i*elementBytes,(i+1)*elementBytes),i*stride);
    const mode=indices?'INDICES':'ATTRIBUTES',encoded=MeshoptEncoder.encodeGltfBuffer(source,count,stride,mode);
    const view:any={buffer:virtual,byteOffset:logical,byteLength:source.length,target:indices?34963:34962,
      extensions:{EXT_meshopt_compression:{buffer:0,byteOffset:physical,byteLength:encoded.length,byteStride:stride,count,mode}}};
    if(!indices)view.byteStride=stride;
    const viewId=json.bufferViews.length;json.bufferViews.push(view);
    pieces.push(encoded,new Uint8Array(align4(encoded.length)-encoded.length));physical+=align4(encoded.length);logical+=align4(source.length);
    accessor.bufferView=viewId;accessor.byteOffset=0;accessor.componentType=componentType(array);accessor.count=count;
    if(accessor.min||accessor.max){const min=Array(components).fill(Infinity),max=Array(components).fill(-Infinity);for(let i=0;i<array.length;i++){const k=i%components;min[k]=Math.min(min[k],array[i]!);max[k]=Math.max(max[k],array[i]!);}accessor.min=min;accessor.max=max;}
    const id=json.accessors.length;json.accessors.push(accessor);return id;
  }
  for(const add of additions){
    const node=json.nodes.find((n:any)=>n.name===add.nodeName);assert.ok(node,`Missing node ${add.nodeName}`);
    const key=`${node.mesh}:${add.primitiveIndex}`;assert.ok(!changed.has(key),'Duplicate primitive append');changed.add(key);
    const p=json.meshes[node.mesh].primitives[add.primitiveIndex];assert.ok(p&&p.mode===4);
    assert.deepEqual(Object.keys(add.attributes).sort(),Object.keys(p.attributes).sort(),'Every attribute must grow together');
    let vertexCount:number|undefined;
    for(const [semantic,a]of Object.entries(add.attributes)){
      const count=a.appended.length/sizeOf(json.accessors[p.attributes[semantic]].type)!;
      if(vertexCount===undefined)vertexCount=count;else assert.equal(count,vertexCount,'Appended attribute count mismatch');
      p.attributes[semantic]=appendAccessor(p.attributes[semantic],a.original,a.appended);
    }
    const finalVertexCount=json.accessors[p.attributes.POSITION].count;
    for(const i of add.indices.appended)assert.ok(i<finalVertexCount,'Appended index exceeds vertex count');
    assert.equal(add.indices.appended.length%3,0);p.indices=appendAccessor(p.indices,add.indices.original,add.indices.appended,true);
  }
  const bin=Buffer.concat(pieces);assert.equal(bin.length,physical);assert.deepEqual(bin.subarray(0,original.bin.length),original.bin);
  json.buffers[0].byteLength=physical;json.buffers[virtual].byteLength=logical;
  const text=Buffer.from(JSON.stringify(json)),padded=Buffer.alloc(align4(text.length),0x20);text.copy(padded);
  const out=Buffer.alloc(28+padded.length+bin.length);
  out.writeUInt32LE(0x46546c67,0);out.writeUInt32LE(2,4);out.writeUInt32LE(out.length,8);
  out.writeUInt32LE(padded.length,12);out.writeUInt32LE(0x4e4f534a,16);padded.copy(out,20);
  out.writeUInt32LE(bin.length,20+padded.length);out.writeUInt32LE(0x004e4942,24+padded.length);bin.copy(out,28+padded.length);
  return out;
}
