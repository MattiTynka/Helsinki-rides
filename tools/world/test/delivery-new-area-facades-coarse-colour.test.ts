import fs from'node:fs';
import assert from'node:assert/strict';import test from'node:test';import{GlbBuilder}from'../lib/gltf.ts';import{decodeDeliveryCityGlb,deliverySha,deliveryGeometryStats}from'../lib/delivery-city-payloads.ts';import{readFacadeGlb}from'../lib/facade-glb.ts';import{facadeTriangleKey,type FacadeTriangle}from'../lib/facade-charts.ts';import{patchCoarseWallColours,qualifyCoarseColourFace,qualifyBulevardi11CoarseColourFace,type CoarseColourFace}from'../lib/delivery-new-area-facades-coarse-colour.ts';import{readFacadeChartTriangles}from'../lib/facade-chart-glb.ts';import{validateBytes}from'gltf-validator';
const a:FacadeTriangle=[[0,0,0],[2,0,0],[2,3,0]],b:FacadeTriangle=[[0,0,0],[2,3,0],[0,3,0]];
test('Coarse colour qualification rejects adjacent planes, reversed winding and unrelated vertices',()=>{
 const frame={origin:[0,0]as const,axis:[1,0]as const};assert.equal(qualifyCoarseColourFace(a,[a,b],frame).outsideAreaMetres2,0);
 assert.throws(()=>qualifyCoarseColourFace([[0,0,0],[2,3,0],[2,0,0]],[a,b],frame),/another plane or winding/);
 assert.throws(()=>qualifyCoarseColourFace([[0,0,0],[0,3,0],[0,0,2]],[a,b],frame),/exact selected native wall vertex/);
 assert.throws(()=>qualifyCoarseColourFace([[0,0,0],[3,0,0],[2,3,0]],[a,b],frame),/exact selected native wall vertex/);
});
async function fixture(){const builder=new GlbBuilder('colour-proof');await builder.addMesh({name:'native-wall',positions:Float32Array.from([0,0,0,2,0,0,2,3,0,0,3,0]),indices:Uint32Array.from([0,1,2,0,2,3]),materialName:'wall'},{name:'wall',unlit:true});const p=builder.doc.getRoot().listMeshes()[0]!.listPrimitives()[0]!;p.setAttribute('COLOR_0',builder.doc.createAccessor().setType('VEC3').setBuffer(builder.doc.getRoot().listBuffers()[0]!).setArray(new Float32Array(12).fill(.5)));return builder.toGlb('test wall',{},'exact');}
test('The colour-only patch preserves every accessor, position and index and rejects shared adjacent targets',async()=>{
 const bytes=await fixture(),F=await readFacadeChartTriangles(bytes),targets:CoarseColourFace[]=F.map(f=>({...f,colours:[[.2,.1,.05],[.2,.1,.05],[.2,.1,.05]]}));
 await assert.rejects(patchCoarseWallColours(bytes,{expected:deliverySha(bytes),targets:targets.slice(0,1)}),/shared with an unselected face/);
 await assert.rejects(patchCoarseWallColours(bytes,{expected:deliverySha(bytes),targets:targets.map((t,i)=>i? t:{...t,points:a,key:facadeTriangleKey(b)})}),/strictly equal|equal/);
 const result=await patchCoarseWallColours(bytes,{expected:deliverySha(bytes),targets}),old=readFacadeGlb(bytes),next=readFacadeGlb(result.bytes);assert.deepEqual(next.json.accessors,old.json.accessors);assert.deepEqual(next.json.meshes,old.json.meshes);assert.deepEqual(next.bin.subarray(0,old.bin.length),old.bin);assert.equal(deliveryGeometryStats(result.bytes).drawCalls,deliveryGeometryStats(bytes).drawCalls);assert.equal((await validateBytes(result.bytes,{maxIssues:50})).issues.numErrors,0);
 const before=await decodeDeliveryCityGlb(bytes),after=await decodeDeliveryCityGlb(result.bytes),p=before.getRoot().listMeshes()[0]!.listPrimitives()[0]!,q=after.getRoot().listMeshes()[0]!.listPrimitives()[0]!;assert.deepEqual(q.getIndices()!.getArray(),p.getIndices()!.getArray());assert.deepEqual(q.getAttribute('POSITION')!.getArray(),p.getAttribute('POSITION')!.getArray());assert.notDeepEqual(q.getAttribute('COLOR_0')!.getArray(),p.getAttribute('COLOR_0')!.getArray());
});

test('Only the pinned B11 simplification polygon has a colour-role exception',()=>{
 const p=JSON.parse(fs.readFileSync(new URL('../../../content/assets/facades/new-area/bulevardi/11/coarse-colour-plan.json',import.meta.url),'utf8'));
 for(const target of p.targets){const proof=qualifyBulevardi11CoarseColourFace(target.points,p.authorityNativeFaces,p.frame),expected=p.exactSimplificationDifference.find((d:any)=>d.targetKey===target.key);assert.deepEqual(proof.difference,expected.difference);assert.equal(proof.differenceSha256,expected.differenceSha256);assert.equal(proof.outsideAreaMetres2,expected.outsideAreaMetres2);}
 assert.throws(()=>qualifyCoarseColourFace(p.targets[1].points,p.authorityNativeFaces.map((f:any)=>f.points),p.frame),/extends outside/);
 const changed=structuredClone(p.targets[1].points);changed[0][0]+=.00001;assert.throws(()=>qualifyBulevardi11CoarseColourFace(changed,p.authorityNativeFaces,p.frame),/Unqualified B11/);
 assert.throws(()=>qualifyBulevardi11CoarseColourFace(p.targets[1].points,p.authorityNativeFaces.slice(1),p.frame),/equal/);
});
