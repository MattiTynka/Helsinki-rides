// Append visual rail detail without reserializing any source accessor/image.
// Detailed tiers gain one cell-owned primitive; coarse tiers reuse their single
// vertex-colour primitive, so the existing coarse batching contract still works.
import assert from 'node:assert/strict';
import {NodeIO} from '@gltf-transform/core';
import {ALL_EXTENSIONS} from '@gltf-transform/extensions';
import {MeshoptDecoder,MeshoptEncoder} from 'meshoptimizer';
import {readFacadeGlb} from './facade-glb.ts';
import {appendGroundGlb,type GroundGlbAppend} from './append-ground-glb.ts';
import type {TramMesh} from './tram-visuals.ts';
import {tramStripePng} from './tram-texture.ts';
import polygonClipping from 'polygon-clipping';
import {signedArea,type Ring} from './geometry.ts';

const align4=(n:number)=>(n+3)&~3;
function serialize(json:any,bin:Uint8Array) {
  const text=Buffer.from(JSON.stringify(json)),padded=Buffer.alloc(align4(text.length),0x20);text.copy(padded);
  const out=Buffer.alloc(28+padded.length+bin.length);
  out.writeUInt32LE(0x46546c67,0);out.writeUInt32LE(2,4);out.writeUInt32LE(out.length,8);
  out.writeUInt32LE(padded.length,12);out.writeUInt32LE(0x4e4f534a,16);padded.copy(out,20);
  out.writeUInt32LE(bin.length,20+padded.length);out.writeUInt32LE(0x004e4942,24+padded.length);Buffer.from(bin).copy(out,28+padded.length);
  return out;
}
export async function appendTramVisualGlb(bytes:Uint8Array,mesh:TramMesh,options:{cell:string;coarse:boolean}):Promise<Uint8Array> {
  const vertexCount=mesh.positions.length/3;
  assert.equal(mesh.normals.length,mesh.positions.length);assert.equal(mesh.colours.length,mesh.positions.length);assert.equal(mesh.indices.length%3,0);
  assert.equal(mesh.uvs.length,vertexCount*2);
  for(const n of [...mesh.positions,...mesh.normals,...mesh.colours])assert.ok(Number.isFinite(n),'Nonfinite tram accessor');
  for(const n of mesh.indices)assert.ok(Number.isSafeInteger(n)&&n>=0&&n<vertexCount,'Tram index out of range');
  if(!mesh.indices.length)return bytes.slice();
  await Promise.all([MeshoptEncoder.ready,MeshoptDecoder.ready]);
  const raw=readFacadeGlb(bytes);
  if(options.coarse){
    const io=new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({'meshopt.decoder':MeshoptDecoder});
    const doc=await io.readBinary(bytes),nodes=doc.getRoot().listNodes().filter(n=>n.getMesh());
    assert.ok(nodes.length>=1&&nodes.length<=3,'Coarse rail append requires bounded existing meshes');
    // A boundary cell can retain multiple accepted coarse meshes after a city
    // append. Rails have baked world positions/colours, so one compatible old
    // primitive can hold them without touching or adding any other draw.
    for(const candidate of nodes){assert.deepEqual(candidate.getWorldMatrix(),[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);assert.equal(candidate.getMesh()!.listPrimitives().length,1);}
    const node=nodes.find(candidate=>candidate.getMesh()!.listPrimitives()[0]!.getAttribute('COLOR_0'));assert.ok(node,'Coarse source requires an existing vertex-colour primitive');
    assert.equal(node.getMesh()!.listPrimitives().length,1,'Coarse rail append must add no draw calls');
    const p=node.getMesh()!.listPrimitives()[0]!,attributes:GroundGlbAppend['attributes']={},first=p.getAttribute('POSITION')!.getCount();
    assert.ok(p.getAttribute('COLOR_0'),'Coarse source requires existing vertex colours');
    for(const semantic of p.listSemantics()){
      const a=p.getAttribute(semantic)!;let extra:number[];
      if(semantic==='POSITION')extra=mesh.positions;
      else if(semantic==='COLOR_0'){
        assert.ok(a.getElementSize()===3||a.getElementSize()===4);
        const scale=a.getNormalized()?(a.getComponentType()===5121?255:a.getComponentType()===5123?65535:NaN):a.getComponentType()===5126?1:NaN;assert.ok(Number.isFinite(scale));
        extra=[];for(let i=0;i<mesh.colours.length;i+=3){for(const c of mesh.colours.slice(i,i+3))extra.push(scale===1?c:Math.round(c*scale));if(a.getElementSize()===4)extra.push(scale);}
      }
      else if(semantic==='NORMAL'){
        const scale=a.getNormalized()?(a.getComponentType()===5120?127:a.getComponentType()===5122?32767:NaN):1;
        assert.ok(Number.isFinite(scale));extra=mesh.normals.map(n=>scale===1?n:Math.round(n*scale));
      }else throw Error(`Unsupported coarse tram attribute${semantic}`);
      (attributes as Record<string,any>)[semantic]={original:a.getArray()!,appended:extra};
    }
    return appendGroundGlb(bytes,[{nodeName:node.getName(),primitiveIndex:0,attributes,indices:{original:p.getIndices()!.getArray()! as any,appended:mesh.indices.map(i=>i+first)}}]);
  }
  const json=structuredClone(raw.json) as any;
  assert.ok(json.extensionsRequired?.includes('EXT_meshopt_compression'));
  const virtual=json.buffers.findIndex((b:any,i:number)=>i>0&&b.extensions?.EXT_meshopt_compression?.fallback===true);
  assert.ok(virtual>0,'Missing meshopt fallback buffer');
  const originalName=`${options.cell}_tram_visuals`,names=new Set<string>(json.nodes.map((n:any)=>n.name)),oldRailNames=[...names].filter(name=>name===originalName||(/^append(?:[2-9]|[1-9][0-9]+):/.test(name)&&name.endsWith(':'+originalName)));
  let nodeName=originalName;
  if(oldRailNames.length){
    // An extended cell can contain rails from the previously accepted area. Only
    // disjoint actual Float32 rail footprints may be appended in another phase.
    const io=new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({'meshopt.decoder':MeshoptDecoder}),doc=await io.readBinary(bytes);
    const incoming=[] as {ring:Ring;bounds:number[]}[];
    const projected=(p:readonly number[][]):Ring=>p.map(v=>[Math.fround(v[0]!),-Math.fround(v[2]!)]);
    const bounds=(r:Ring)=>[Math.min(...r.map(p=>p[0])),Math.min(...r.map(p=>p[1])),Math.max(...r.map(p=>p[0])),Math.max(...r.map(p=>p[1]))];
    for(let t=0;t<mesh.indices.length;t+=3){const ring=projected([0,1,2].map(k=>mesh.positions.slice(mesh.indices[t+k]!*3,mesh.indices[t+k]!*3+3)));incoming.push({ring,bounds:bounds(ring)});}
    for(const node of doc.getRoot().listNodes().filter(n=>oldRailNames.includes(n.getName()))){
      assert.deepEqual(node.getWorldMatrix(),[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],'Existing rails require world-baked coordinates');
      for(const primitive of node.getMesh()!.listPrimitives()){
        assert.equal(primitive.getMaterial()?.getName(),'tram_steel_and_groove','Existing rail ownership changed');
        const P=primitive.getAttribute('POSITION')!,I=primitive.getIndices()!;assert.ok(P&&I&&primitive.getMode()===4);
        for(let t=0;t<I.getCount();t+=3){const ring=projected([0,1,2].map(k=>P.getElement(I.getScalar(t+k),[]))),b=bounds(ring);
          for(const next of incoming){const a=next.bounds;if(a[2]!<=b[0]!||a[0]!>=b[2]!||a[3]!<=b[1]!||a[1]!>=b[3]!)continue;
            const overlap=polygonClipping.intersection([ring],[next.ring]),area=overlap.reduce((sum,p)=>sum+Math.abs(signedArea(p[0]!))-p.slice(1).reduce((n,r)=>n+Math.abs(signedArea(r)),0),0);
            assert.ok(area<=1e-9,'Trams already appended: incoming rail footprint overlaps existing rails');
          }
        }
      }
    }
    let ordinal=2;while(names.has(`append${ordinal}:${originalName}`))ordinal++;nodeName=`append${ordinal}:${originalName}`;
  }
  let physical=align4(raw.bin.length),logical=align4(json.buffers[virtual].byteLength);
  const pieces:Uint8Array[]=[raw.bin,new Uint8Array(physical-raw.bin.length)];
  function accessor(array:Float32Array|Uint32Array,type:'VEC3'|'VEC2'|'SCALAR',indices=false){
    const components=type==='VEC3'?3:type==='VEC2'?2:1,count=array.length/components,stride=components*4;
    const source=new Uint8Array(array.buffer,array.byteOffset,array.byteLength),mode=indices?'INDICES':'ATTRIBUTES';
    const encoded=MeshoptEncoder.encodeGltfBuffer(source,count,stride,mode),bufferView=json.bufferViews.length;
    json.bufferViews.push({buffer:virtual,byteOffset:logical,byteLength:source.length,...(!indices?{byteStride:stride}:{}),target:indices?34963:34962,
      extensions:{EXT_meshopt_compression:{buffer:0,byteOffset:physical,byteLength:encoded.length,byteStride:stride,count,mode}}});
    pieces.push(encoded,new Uint8Array(align4(encoded.length)-encoded.length));physical+=align4(encoded.length);logical+=align4(source.length);
    const min=Array(components).fill(Infinity),max=Array(components).fill(-Infinity);for(let i=0;i<array.length;i++){const k=i%components;min[k]=Math.min(min[k],array[i]!);max[k]=Math.max(max[k],array[i]!);}
    const id=json.accessors.length;json.accessors.push({bufferView,componentType:indices?5125:5126,count,type,min,max});return id;
  }
  const attributes={POSITION:accessor(Float32Array.from(mesh.positions),'VEC3'),NORMAL:accessor(Float32Array.from(mesh.normals),'VEC3'),TEXCOORD_0:accessor(Float32Array.from(mesh.uvs),'VEC2')},indices=accessor(Uint32Array.from(mesh.indices),'SCALAR',true);
  const png=await tramStripePng(),imageView=json.bufferViews.length;json.bufferViews.push({buffer:0,byteOffset:physical,byteLength:png.length});pieces.push(png,new Uint8Array(align4(png.length)-png.length));physical+=align4(png.length);
  json.images??=[];json.textures??=[];json.samplers??=[];
  const image=json.images.length;json.images.push({name:'original-tram-cross-section-44x4',mimeType:'image/png',bufferView:imageView});
  const sampler=json.samplers.length;json.samplers.push({wrapS:33071,wrapT:10497,magFilter:9729,minFilter:9987});
  const texture=json.textures.length;json.textures.push({name:'original-tram-cross-section-44x4',source:image,sampler});
  const material=json.materials.length;json.materials.push({name:'tram_steel_and_groove',pbrMetallicRoughness:{baseColorFactor:[1,1,1,1],baseColorTexture:{index:texture},roughnessFactor:1,metallicFactor:0},doubleSided:false,extras:{originalArtwork:'CC0-1.0'}});
  const meshId=json.meshes.length;json.meshes.push({name:nodeName,primitives:[{attributes,indices,material,mode:4}]});
  const node=json.nodes.length;json.nodes.push({name:nodeName,mesh:meshId});assert.ok(json.scenes[json.scene??0]?.nodes);json.scenes[json.scene??0].nodes.push(node);
  const bin=Buffer.concat(pieces);assert.deepEqual(bin.subarray(0,raw.bin.length),raw.bin);json.buffers[0].byteLength=physical;json.buffers[virtual].byteLength=logical;
  return serialize(json,bin);
}
