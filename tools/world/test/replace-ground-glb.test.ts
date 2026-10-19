import assert from 'node:assert/strict';
import {test} from 'node:test';
import {NodeIO} from '@gltf-transform/core';
import {ALL_EXTENSIONS} from '@gltf-transform/extensions';
import {MeshoptDecoder} from 'meshoptimizer';
import {GlbBuilder,flatNormals} from '../lib/gltf.ts';
import {readFacadeGlb} from '../lib/facade-glb.ts';
import {replaceGroundGlb,type GroundGlbReplacement} from '../lib/replace-ground-glb.ts';
import {appendCityGlb} from '../lib/append-city-cells.ts';

const align4=(n:number)=>(n+3)&~3;
function pack(json:any,bin:Uint8Array){const text=Buffer.from(JSON.stringify(json)),padded=Buffer.alloc(align4(text.length),32);text.copy(padded);const bytes=Buffer.alloc(28+padded.length+align4(bin.length));bytes.writeUInt32LE(0x46546c67,0);bytes.writeUInt32LE(2,4);bytes.writeUInt32LE(bytes.length,8);bytes.writeUInt32LE(padded.length,12);bytes.writeUInt32LE(0x4e4f534a,16);padded.copy(bytes,20);bytes.writeUInt32LE(align4(bin.length),20+padded.length);bytes.writeUInt32LE(0x004e4942,24+padded.length);bytes.set(bin,28+padded.length);return bytes;}
async function fixture(){
 const builder=new GlbBuilder('ground-repair-test'),positions=new Float32Array([-2,0,0,0,0,0,0,0,1]),indices=new Uint32Array([0,2,1]);
 for(const name of['test_ground_slabs','test_ground_other','building'])await builder.addMesh({name,positions,indices:new Uint32Array(indices),normals:flatNormals(positions,indices),uvs:new Float32Array([0,0,1,0,1,1]),materialName:name},{name,unlit:false,texture:{width:2,height:2,data:new Uint8Array(16).fill(175)}});
 const{json,bin}=readFacadeGlb(await builder.toGlb('fixture',{},'exact')),nodes=json.nodes as any[],ground=nodes.find(n=>n.name==='test_ground_slabs');ground.translation=[10,2,3];ground.scale=[2,3,4];ground.extras={must:'survive'};
 // Shared meshes are legal glTF. Repairing a ground instance must not also change an unselected node.
 nodes.find(n=>n.name==='building').mesh=ground.mesh;
 return pack(json,bin);
}
async function decoder(){await MeshoptDecoder.ready;return new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({'meshopt.decoder':MeshoptDecoder});}
function replacement(doc:Awaited<ReturnType<NodeIO['readBinary']>>):GroundGlbReplacement{
 const p=doc.getRoot().listNodes().find(n=>n.getName()==='test_ground_slabs')!.getMesh()!.listPrimitives()[0]!,attributes:any={};
 for(const semantic of p.listSemantics()){const a=p.getAttribute(semantic)!,source=a.getArray()!,Type=source.constructor as any;attributes[semantic]=new Type(a.getElementSize()*4);}
 attributes.POSITION.set([-2,0,0,0,0,0,0,0,1,-2,0,1]);attributes.TEXCOORD_0.set([0,0,1,0,1,1,0,1]);
 const normals=p.getAttribute('NORMAL')!.getArray()!;for(let i=0;i<4;i++)attributes.NORMAL.set(normals.subarray(0,3),i*3);
 return{nodeName:'test_ground_slabs',primitiveIndex:0,attributes,indices:new Uint32Array([0,2,1,0,3,2])};
}

test('ground replacement preserves encoded BIN/images, shared non-ground geometry and transforms while changing only the selected instance',async()=>{
 const bytes=await fixture(),before=bytes.slice(),io=await decoder(),doc=await io.readBinary(bytes),change=replacement(doc),out=await replaceGroundGlb(bytes,[change]),merged=await io.readBinary(out),a=readFacadeGlb(bytes),b=readFacadeGlb(out);
 assert.deepEqual(bytes,before);assert.deepEqual(b.bin.subarray(0,a.bin.length),a.bin);assert.deepEqual(b.json.images,a.json.images);assert.deepEqual(b.json.materials,a.json.materials);
 for(const name of['test_ground_slabs','test_ground_other','building']){
  const old=doc.getRoot().listNodes().find(n=>n.getName()===name)!,next=merged.getRoot().listNodes().find(n=>n.getName()===name)!;assert.deepEqual(next.getWorldMatrix(),old.getWorldMatrix());assert.deepEqual(next.getExtras(),old.getExtras());
  const p=old.getMesh()!.listPrimitives()[0]!,q=next.getMesh()!.listPrimitives()[0]!;
  for(const semantic of p.listSemantics()){assert.deepEqual(q.getAttribute(semantic)!.getArray(),name===change.nodeName?change.attributes[semantic]:p.getAttribute(semantic)!.getArray());assert.equal(q.getAttribute(semantic)!.getNormalized(),p.getAttribute(semantic)!.getNormalized());}
  assert.deepEqual(q.getIndices()!.getArray(),name===change.nodeName?change.indices:p.getIndices()!.getArray());assert.equal(q.getMaterial()!.getName(),p.getMaterial()!.getName());assert.deepEqual(q.getMaterial()!.getBaseColorTexture()!.getImage(),p.getMaterial()!.getBaseColorTexture()!.getImage());
 }
 const validator=await import('gltf-validator'),report=await validator.validateBytes(out);assert.equal(report.issues.numErrors,0,JSON.stringify(report.issues.messages));
});

test('ground replacement handles complete removal without empty accessors and rejects invalid geometry or unselected semantics',async()=>{
 const bytes=await fixture(),io=await decoder(),doc=await io.readBinary(bytes),change=replacement(doc),empty={...change,attributes:Object.fromEntries(Object.entries(change.attributes).map(([k,a])=>[k,a.slice(0,0)])),indices:new Uint32Array()},out=await replaceGroundGlb(bytes,[empty]),decoded=await io.readBinary(out);
 assert.equal(decoded.getRoot().listNodes().find(n=>n.getName()==='test_ground_slabs')!.getMesh(),null);assert.ok(decoded.getRoot().listNodes().find(n=>n.getName()==='building')!.getMesh());
 const validator=await import('gltf-validator');assert.equal((await validator.validateBytes(out)).issues.numErrors,0);
 await assert.rejects(replaceGroundGlb(bytes,[{...change,nodeName:'building'}]),/ground nodes/);
 await assert.rejects(replaceGroundGlb(bytes,[change,change]),/Duplicate/);
 await assert.rejects(replaceGroundGlb(bytes,[{...change,attributes:{POSITION:change.attributes.POSITION!}}]),/Every ground attribute/);
 await assert.rejects(replaceGroundGlb(bytes,[{...change,attributes:{...change.attributes,POSITION:new Float32Array([NaN,...change.attributes.POSITION!.slice(1)])}}]),/Nonfinite/);
 await assert.rejects(replaceGroundGlb(bytes,[{...change,attributes:{...change.attributes,NORMAL:change.attributes.NORMAL!.map(()=>0)}}]),/unit length/);
 await assert.rejects(replaceGroundGlb(bytes,[{...change,indices:new Uint32Array([0,1,99])}]),/exceeds vertex count/);
 await assert.rejects(replaceGroundGlb(bytes,[{...change,indices:new Uint32Array()}]),/must also be empty/);
 assert.deepEqual(await replaceGroundGlb(bytes,[]),bytes);
});

test('distant ground replacement requires the textureless native contract and keeps architectural colours exact',async()=>{
 const builder=new GlbBuilder('coarse'),positions=new Float32Array([0,0,0,1,0,0,1,0,1,0,4,0,1,4,0,1,4,1]);await builder.addMesh({name:'coarse',positions,indices:new Uint32Array([0,2,1,3,5,4]),materialName:'colours'},{name:'colours',unlit:true});
 const primitive=builder.doc.getRoot().listMeshes()[0]!.listPrimitives()[0]!;primitive.setAttribute('COLOR_0',builder.doc.createAccessor().setType('VEC3').setBuffer(builder.doc.getRoot().listBuffers()[0]!).setArray(new Float32Array([.1,.2,.3,.1,.2,.3,.1,.2,.3,.6,.7,.8,.6,.7,.8,.6,.7,.8])));
 const bytes=await builder.toGlb('fixture',{level:'distant',cell:'coarse'},'exact'),io=await decoder(),doc=await io.readBinary(bytes),p=doc.getRoot().listNodes()[0]!.getMesh()!.listPrimitives()[0]!,attributes:any={};
 // Keep the architectural triangle by its height, regardless of meshopt's vertex/index order.
 const pos=p.getAttribute('POSITION')!.getArray()!,ids=Array.from(p.getIndices()!.getArray()!).filter(i=>pos[i*3+1]===4);assert.equal(ids.length,3);
 for(const semantic of p.listSemantics()){const attr=p.getAttribute(semantic)!,raw=attr.getArray()!,components=attr.getElementSize(),Type=raw.constructor as any;attributes[semantic]=new Type(ids.flatMap(i=>Array.from(raw.subarray(i*components,(i+1)*components))));}
 const change:GroundGlbReplacement={kind:'distant-ground',nodeName:'coarse',primitiveIndex:0,attributes,indices:new Uint32Array([0,1,2])},out=await replaceGroundGlb(bytes,[change]),next=(await io.readBinary(out)).getRoot().listNodes()[0]!.getMesh()!.listPrimitives()[0]!;
 for(const semantic of Object.keys(attributes))assert.deepEqual(next.getAttribute(semantic)!.getArray(),attributes[semantic]);
 const validator=await import('gltf-validator');assert.equal((await validator.validateBytes(out)).issues.numErrors,0);
 await assert.rejects(replaceGroundGlb(bytes,[{...change,kind:'ground'}]),/ground nodes/);
 const read=readFacadeGlb(bytes),json=structuredClone(read.json) as any;delete json.extras.level;await assert.rejects(replaceGroundGlb(pack(json,read.bin),[change]),/native distant-cell contract/);
});

async function distantFixture(){
 const builder=new GlbBuilder('coarse'),positions=new Float32Array([0,0,0,1,0,0,1,0,1,0,4,0,1,4,0,1,4,1]);await builder.addMesh({name:'coarse',positions,indices:new Uint32Array([0,2,1,3,5,4]),materialName:'colours'},{name:'colours',unlit:true});
 const p=builder.doc.getRoot().listMeshes()[0]!.listPrimitives()[0]!;p.setAttribute('COLOR_0',builder.doc.createAccessor().setType('VEC3').setBuffer(builder.doc.getRoot().listBuffers()[0]!).setArray(new Float32Array([.1,.2,.3,.1,.2,.3,.1,.2,.3,.6,.7,.8,.6,.7,.8,.6,.7,.8])));return builder.toGlb('fixture',{level:'distant',cell:'coarse'},'exact');
}
function exactDistantChange(doc:Awaited<ReturnType<NodeIO['readBinary']>>,nodeName:string):GroundGlbReplacement{
 const p=doc.getRoot().listNodes().find(n=>n.getName()===nodeName)!.getMesh()!.listPrimitives()[0]!,attributes=Object.fromEntries(p.listSemantics().map(s=>[s,p.getAttribute(s)!.getArray()!.slice()])) as Record<string,Float32Array>;
 for(let i=0;i<attributes.POSITION!.length;i+=3)if(attributes.POSITION![i+1]===0)attributes.POSITION![i+1]=-.125;
 return{kind:'distant-ground',nodeName,primitiveIndex:0,attributes,indices:Uint32Array.from(p.getIndices()!.getArray()!)};
}
test('coarse ground replacement supports repeated append2/append3 owners while retaining all other nodes',async()=>{
 const source=await distantFixture(),io=await decoder();let bytes=source;for(let i=0;i<3;i++)bytes=appendCityGlb(bytes,source);
 const before=readFacadeGlb(bytes),doc=await io.readBinary(bytes),changes=['append2:coarse','append3:coarse'].map(name=>exactDistantChange(doc,name)),out=await replaceGroundGlb(bytes,changes),after=readFacadeGlb(out),decoded=await io.readBinary(out);
 assert.deepEqual(after.bin.subarray(0,before.bin.length),before.bin);assert.deepEqual(after.json.extras,before.json.extras);assert.deepEqual(after.json.materials,before.json.materials);
 for(const old of doc.getRoot().listNodes()){
  const next=decoded.getRoot().listNodes().find(n=>n.getName()===old.getName())!,p=old.getMesh()!.listPrimitives()[0]!,q=next.getMesh()!.listPrimitives()[0]!,change=changes.find(c=>c.nodeName===old.getName());assert.deepEqual(next.getMatrix(),old.getMatrix());
  for(const semantic of p.listSemantics())assert.deepEqual(q.getAttribute(semantic)!.getArray(),change?change.attributes[semantic]:p.getAttribute(semantic)!.getArray());assert.deepEqual(q.getIndices()!.getArray(),change?change.indices:p.getIndices()!.getArray());
 }
 const validator=await import('gltf-validator');assert.equal((await validator.validateBytes(out)).issues.numErrors,0);
});
test('coarse replacement rejects invalid append namespaces and wrong cell identities',async()=>{
 const bytes=await distantFixture(),io=await decoder(),doc=await io.readBinary(bytes),original=readFacadeGlb(bytes),change=exactDistantChange(doc,'coarse');
 for(const name of['append0:coarse','append1:coarse','append02:coarse','append-2:coarse','arbitrary:coarse','append2:other','append:other','append2:coarse-extra','append2:append:coarse']){
  const json=structuredClone(original.json)as any;json.nodes[0].name=name;await assert.rejects(replaceGroundGlb(pack(json,original.bin),[{...change,nodeName:name}]),/match its base or appended cell/);
 }
 for(const name of['append:coarse','append10:coarse']){const json=structuredClone(original.json)as any;json.nodes[0].name=name;const out=await replaceGroundGlb(pack(json,original.bin),[{...change,nodeName:name}]);assert.ok((await io.readBinary(out)).getRoot().listNodes().some(n=>n.getName()===name));}
 const json=structuredClone(original.json)as any;delete json.extras.cell;await assert.rejects(replaceGroundGlb(pack(json,original.bin),[change]),/named native cell/);
});
test('coastal water replacement requires the actual native material/node and retains the original water plane',async()=>{
 const builder=new GlbBuilder('c_p00_m01'),positions=new Float32Array([0,0,0,2,0,0,2,0,2,0,0,2]),indices=new Uint32Array([0,2,1,0,3,2]);await builder.addMesh({name:'c_p00_m01_water',positions,normals:flatNormals(positions,indices),indices,materialName:'coastal_water'},{name:'coastal_water',baseColor:[.07,.18,.23,1],unlit:false,roughness:.25,metallic:.15});const bytes=await builder.toGlb('fixture',{cell:'c_p00_m01'},'exact'),io=await decoder(),p=(await io.readBinary(bytes)).getRoot().listNodes()[0]!.getMesh()!.listPrimitives()[0]!,attributes=Object.fromEntries(p.listSemantics().map(s=>[s,p.getAttribute(s)!.getArray()!.slice()]))as any,change:GroundGlbReplacement={kind:'coastal-water',nodeName:'c_p00_m01_water',primitiveIndex:0,attributes,indices:Uint32Array.from(p.getIndices()!.getArray()!.subarray(0,3))},out=await replaceGroundGlb(bytes,[change]),before=readFacadeGlb(bytes),after=readFacadeGlb(out);assert.deepEqual(after.bin.subarray(0,before.bin.length),before.bin);assert.deepEqual(after.json.materials,before.json.materials);const validator=await import('gltf-validator');assert.equal((await validator.validateBytes(out)).issues.numErrors,0);
 const moved=attributes.POSITION.slice();for(let i=1;i<moved.length;i+=3)moved[i]=1;await assert.rejects(replaceGroundGlb(bytes,[{...change,attributes:{...attributes,POSITION:moved}}]),/retain its source plane/);
 for(const name of['facade_water','append1:c_p00_m01_water']){const json=structuredClone(before.json)as any;json.nodes[0].name=name;await assert.rejects(replaceGroundGlb(pack(json,before.bin),[{...change,nodeName:name}]),/native water node/);}
 const json=structuredClone(before.json)as any;json.materials[0].name='facade';await assert.rejects(replaceGroundGlb(pack(json,before.bin),[change]),/coastal_water/);
});
