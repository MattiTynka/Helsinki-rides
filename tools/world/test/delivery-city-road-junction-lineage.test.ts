import assert from'node:assert/strict';import test from'node:test';
import{qualifyDeliveryJunctionRoadSupersession as qualify}from'../lib/delivery-city-road-junction-lineage.ts';
import{qualifyDeliveryJunctionNonRoadSupersession as qualifyNonRoad}from'../lib/delivery-city-road-junction-lineage.ts';
import{junctionFaceSha}from'../lib/delivery-bridge-junction-mouths.ts';
import{partitionJunctionSourceMesh,type JunctionSourceSelection}from'../lib/delivery-bridge-junction-partition.ts';
const source=[[0,12,0],[0,12,2],[2,12,0]],mask:[[number,number],[number,number],[number,number]]=[[0,0],[0,1],[1,0]],selection:JunctionSourceSelection={triangle:17,orderedFloat32Sha256:junctionFaceSha(source),group:'ground',tag:'road:asphalt:bridge-reconstruction',role:'authored-approach-floor',masks:[mask]};
function fixture(){const part=partitionJunctionSourceMesh({attributes:{POSITION:Float32Array.from(source.flat())},components:{POSITION:3},normalized:{POSITION:false},indices:Uint32Array.of(0,1,2)},'ground',[selection.tag],[{...selection,triangle:0}]),complement=Array.from({length:part.mesh.indices.length/3},(_,t)=>[0,1,2].map(k=>Array.from(part.mesh.attributes.POSITION!.subarray(part.mesh.indices[t*3+k]!*3,part.mesh.indices[t*3+k]!*3+3))));return{parent:'hameentie-junatie',expectedParent:'hameentie-junatie',sourcePoints:source,selection,declaredComplement:complement,finalFaces:complement,newRoadFaces:[[[0,12.2,0],[0,12.2,1],[1,12.2,0]]]};}
test('only an exact oriented source face and its explicit cut region may be superseded; all complementary source geometry remains literal',()=>{const o=fixture(),r=qualify(o);assert.ok(r.outsideFragments>0);assert.equal(r.coverage.unexplainedArea,0);});
test('wrong bridge, lower level, unrelated source face and reversed source winding cannot gain a removal exception',()=>{const o=fixture();assert.throws(()=>qualify({...o,parent:'hakaniemensilta'}),/Wrong junction parent/);assert.throws(()=>qualify({...o,sourcePoints:source.map(p=>[p[0]!,1,p[2]!])}),/literal oriented/);assert.throws(()=>qualify({...o,sourcePoints:source.map(p=>[p[0]!+5,p[1]!,p[2]!])}),/literal oriented/);assert.throws(()=>qualify({...o,sourcePoints:[source[0]!,source[2]!,source[1]!]}),/literal oriented/);});
test('partial-mask claims do not excuse missing outside geometry or reversed final winding',()=>{const o=fixture();assert.throws(()=>qualify({...o,declaredComplement:[]}),/outside source-plane/);assert.throws(()=>qualify({...o,finalFaces:[]}),/outside fragment/);assert.throws(()=>qualify({...o,finalFaces:o.finalFaces.map(p=>[p[0]!,p[2]!,p[1]!])}),/outside fragment/);});
test('an incomplete new floor or a mask unrelated to the source cannot authorize removal',()=>{const o=fixture();assert.throws(()=>qualify({...o,newRoadFaces:[]}),/New parent ROAD/);assert.throws(()=>qualify({...o,selection:{...selection,masks:[[[8,8],[8,9],[9,8]]]}}));});
test('native walking cuts retain exact tagged outside fragments and cannot enter the canonical ROAD exception path',()=>{
 const o=fixture(),s={...o.selection,tag:'raised:slabs',role:'native-upper-walking' as const},walking={...o,selection:s};
 const proof=qualifyNonRoad(walking);assert.ok(proof.outsideFragments>0);assert.equal(proof.coverage.unexplainedArea,0);
 assert.throws(()=>qualify(walking));
 assert.throws(()=>qualifyNonRoad({...walking,selection:{...s,tag:'road:asphalt:bridge-reconstruction'}}),/Unqualified/);
 assert.throws(()=>qualifyNonRoad({...walking,selection:{...s,role:'authored-approach-floor'}}),/Unqualified/);
 assert.throws(()=>qualifyNonRoad({...walking,declaredComplement:[]}),/outside source-plane/);
 assert.throws(()=>qualifyNonRoad({...walking,finalFaces:[]}),/outside fragment/);
 assert.throws(()=>qualifyNonRoad({...walking,newRoadFaces:[]}),/does not cover/);
});
