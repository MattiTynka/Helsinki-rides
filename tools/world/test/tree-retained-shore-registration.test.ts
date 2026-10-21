import assert from'node:assert/strict';
import{readFileSync}from'node:fs';
import{fileURLToPath}from'node:url';
import{test}from'node:test';
import{Document,NodeIO}from'@gltf-transform/core';
import{encodeCollisionBundle,type CellDescriptor}from'../../../packages/world-schema/src/index.ts';
import{loadGeoJsonPolygons}from'../lib/geometry.ts';
import{registrationSha256 as sha}from'../lib/tree-ground-registration.ts';
import{transformedTreeBark,barkTriangleIntersections,type BarkTriangle,type TreeBarkModel}from'../lib/tree-bark-registration.ts';
import{qualifyRetainedPreciseLakeBank,readRetainedShoreBarkNative,type RetainedShoreTreeBinding}from'../lib/tree-retained-shore-registration.ts';

const fixture=JSON.parse(readFileSync(new URL('./fixtures/reviewed-retained-shore-tree.json',import.meta.url),'utf8'));
const model=JSON.parse(readFileSync(new URL('./fixtures/reviewed-native-birch-bark.json',import.meta.url),'utf8'))as TreeBarkModel;
const file=fileURLToPath(new URL('../../../content/helsinki/city-expansion-20261021/native-shore/municipal-water-bank-v1.geojson',import.meta.url)),polygons=loadGeoJsonPolygons(file,25497350,6672960,p=>String(p.sourceFeatureId)),lake=polygons.find(p=>p.id==='Maavesi_muut_vesialueet.1631')!;
function setup(){const f=structuredClone(fixture),binding=f.binding as RetainedShoreTreeBinding,water=[lake],classification={sha256:binding.preciseMunicipalWater.retainedWaterReport.sha256,report:{nativeShore:{profileSha256:'772a9c509fe3a40b67dd5bda04fafb9d72654aa228663d7861ccac7d5648596f',preciseMunicipalWaterSha256:sha(readFileSync(file))},nativeMetadataSha256:'38442ad1254e59fa21b99d1adf3d750a1f65065f9407139bbab38c8625dd3c56',coastal:{mask:{water}}}},evidence={...f,source:{sha256:sha(readFileSync(file)),polygons,classification},water,waterY:-7.5};return{tree:f.tree,binding,evidence};}
const qualify=(s:ReturnType<typeof setup>)=>qualifyRetainedPreciseLakeBank(s.tree,model,s.binding,s.evidence);
function addNative(s:ReturnType<typeof setup>,points:BarkTriangle){s.evidence.native.faces.push({kind:'visual',cell:'c_m08_m12',name:'independent-test-face',primitive:0,triangle:0,points});s.binding.native.candidateInventorySha256=s.evidence.native.candidateInventorySha256=sha(JSON.stringify(s.evidence.native.faces));}

test('the measured partial bank keeps the original XZ despite a wet centre and minority dry root support',()=>{
 const s=setup(),before=structuredClone(s.tree),proof=qualify(s);assert.deepEqual(s.tree,before);assert.equal(proof.rootDry,3);assert.equal(proof.rootCount,10);assert.equal(proof.denseDry,150);assert.equal(proof.denseCount,505);assert.equal(proof.target,-7.52);assert.equal(proof.rows.length,2);assert.ok(proof.rows.every(r=>r.hits.some(h=>h.kind==='visual')&&r.hits.some(h=>h.kind==='collision')));assert.ok(Math.max(...proof.rows.flatMap(r=>r.hits.map(h=>h.maximumIntersectionY)))<proof.aboveSoilGate);
});
test('unknown trees and changed positions, orientation, model or precise source cannot inherit retention',()=>{
 for(const change of[{id:'another-tree'},{position:[-920.223,-7.002,-1484.782]},{yaw:.5002}]){const s=setup();Object.assign(s.tree,change);assert.throws(()=>qualify(s),/individually measured|placement changed/);}
 const s=setup(),changed=structuredClone(model);changed.triangles.pop();assert.throws(()=>qualifyRetainedPreciseLakeBank(s.tree,changed,s.binding,s.evidence),/Actual bark model changed/);
 s.evidence.source.sha256='f'.repeat(64);assert.throws(()=>qualify(s),/source bytes changed/);
});
test('paired visual/collision support, exact dense domain and independently wet missing points are mandatory',()=>{
 const mismatch=setup();mismatch.evidence.visual[1]=null;assert.throws(()=>qualify(mismatch),/support mismatch|height mismatch/);
 const shortened=setup();shortened.evidence.profile.gridPoints.pop();assert.throws(()=>qualify(shortened),/dense domain changed/);
 const dryHole=setup();dryHole.evidence.water=[];dryHole.evidence.source.classification.report.coastal.mask.water=[];assert.throws(()=>qualify(dryHole),/unsupported dry point/);
 const structure=setup();structure.evidence.context.buildingIds=['a-source-building'];assert.throws(()=>qualify(structure),/mapped structure/);
});
test('the full-height census rejects an obstruction above the ordinary two-metre root window',()=>{
 const s=setup(),bark=transformedTreeBark(model,s.tree,s.tree.position[1]),high=bark.find(t=>t.every(p=>p[1]>s.evidence.profile.range[1]+3))!;assert.ok(high);
 const c=high[0].map((_,i)=>high.reduce((n,p)=>n+p[i]!,0)/3),candidates:BarkTriangle[]=[[[c[0]!-.2,c[1]!-.2,c[2]!],[c[0]!+.2,c[1]!-.2,c[2]!],[c[0]!,c[1]!+.2,c[2]!]],[[c[0]!,c[1]!-.2,c[2]!-.2],[c[0]!,c[1]!+.2,c[2]!-.2],[c[0]!,c[1]!,c[2]!+.2]]],wall=candidates.find(t=>barkTriangleIntersections(high,t).length);assert.ok(wall);addNative(s,wall);assert.throws(()=>qualify(s),/above-soil bark intersects/);
});
test('a stacked horizontal floor crossing the upper trunk rejects, while nonintersecting canopy-side structure does not',()=>{
 const blocked=setup(),[x,,z]=blocked.tree.position,y=blocked.evidence.profile.range[1]+1;addNative(blocked,[[x-1,y,z-1],[x+1,y,z-1],[x,y,z+1]]);assert.throws(()=>qualify(blocked),/above-soil bark intersects/);
 const clear=setup();addNative(clear,[[x+4,-5,z],[x+4,8,z],[x+4,8,z+1]]);assert.equal(qualify(clear).id,clear.tree.id);
});
test('the exact current payload and complete native candidate inventory cannot drift',()=>{
 const refs=setup();refs.binding.native.cells[0]!.visual={...refs.binding.native.cells[0]!.visual,sha256:'0'.repeat(64)};assert.throws(()=>qualify(refs),/payload authority changed/);
 const inventory=setup();inventory.evidence.native.faces.pop();assert.throws(()=>qualify(inventory));
});
test('native reading ignores inactive geometry but includes high active geometry and excludes only the same tree collider',async()=>{
 const s=setup(),[x,,z]=s.tree.position,doc=new Document(),buffer=doc.createBuffer(),mesh=(name:string)=>doc.createMesh(name).addPrimitive(doc.createPrimitive().setAttribute('POSITION',doc.createAccessor().setType('VEC3').setArray(new Float32Array([x,-5,z,x+.1,-5,z,x,-4.9,z+.1])).setBuffer(buffer)).setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array([0,1,2])).setBuffer(buffer))),active=doc.createNode('active-high-face').setMesh(mesh('active')),inactive=doc.createNode('inactive-face').setMesh(mesh('inactive'));doc.createScene().addChild(active);doc.getRoot().setDefaultScene(doc.getRoot().listScenes()[0]!);assert.ok(inactive);
 const visual=await new NodeIO().writeBinary(doc),collision=encodeCollisionBundle({originId:'o',frame:'X-east,Y-up,Z-south',cell:'c',surfaceTags:['ground']},[{id:'t:'+s.tree.id,ref:s.tree.id,group:'trees',positions:new Float32Array([x,-5,z,x+.1,-5,z,x,-4.9,z+.1]),indices:new Uint32Array([0,1,2]),triangleTags:new Uint16Array([0])}]),cell={id:'c',boundsXZ:[x-1,z-1,x+1,z+1],collision:{path:'c.hcol',bytes:collision.length,sha256:sha(collision)},visual:{lod0:{path:'c.glb',bytes:visual.length,sha256:sha(visual)}},buildings:[]}as unknown as CellDescriptor,native=await readRetainedShoreBarkNative(s.tree,model,-7.52,[cell],(_c,kind)=>kind==='visual'?visual:collision);
 assert.equal(native.faces.length,1);assert.equal(native.faces[0]!.name,'active-high-face');assert.equal(native.faces[0]!.kind,'visual');
});
