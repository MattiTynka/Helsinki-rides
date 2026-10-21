import assert from 'node:assert/strict';import test from 'node:test';
import {GlbBuilder} from '../lib/gltf.ts';
import {generatedSkirtQuad,literalWallFaces,sourceSkirtEdges,qualifyDuplicateUpwardSkirt,findDuplicateSkirts,type SkirtEdge} from '../lib/delivery-duplicate-skirts.ts';
import {removeDuplicateSkirts} from '../lib/delivery-duplicate-skirts-glb.ts';
import {deliverySha,decodeDeliveryCityGlb,deliveryGeometryStats} from '../lib/delivery-city-payloads.ts';
import {readFacadeGlb} from '../lib/facade-glb.ts';import {validateBytes} from 'gltf-validator';
const edge:SkirtEdge=[0,-2,0,4,-2,0],wall={positions:Float32Array.from([0,-2,0,4,-2,0,4,6,0,0,6,0]),indices:Uint32Array.from([0,1,2,0,2,3])},faces=literalWallFaces([wall]),buildings=[{id:'exact-new-source',faces,minimumY:-2}];
test('Exact source wall coverage rejects even a positive submillimetre hole or a different plane',()=>{
 const q=qualifyDuplicateUpwardSkirt(edge,2,faces);assert.ok(q);assert.equal(q.coverage.exactPositiveResiduals,0);assert.equal(q.projectedArea,16);assert.equal(qualifyDuplicateUpwardSkirt(edge,-3,faces),null);assert.equal(qualifyDuplicateUpwardSkirt(edge,-2,faces),null);
 const shorter=literalWallFaces([{positions:Float32Array.from([0,-2,0,4,-2,0,4,2-2**-20,0,0,2-2**-20,0]),indices:wall.indices}]);assert.equal(qualifyDuplicateUpwardSkirt(edge,2,shorter),null,'No positive residual may be rounded away');
 const neighboring=literalWallFaces([{positions:Float32Array.from(Array.from(wall.positions,(n,i)=>i%3===2?2**-20:n)),indices:wall.indices}]);assert.equal(qualifyDuplicateUpwardSkirt(edge,2,neighboring),null,'Nearby walls are not exact source coverage');
 assert.equal(qualifyDuplicateUpwardSkirt(edge,2,[faces[0]!]),null,'Half a triangulated wall cannot cover the whole generated quad');
 assert.deepEqual(sourceSkirtEdges(faces,-2),[edge]);
});
async function fixture(withWall=true,duplicate=false){
 const b=new GlbBuilder('exact-new-source');if(withWall)await b.addMesh({name:'c_test_facades_0',...wall,uvs:new Float32Array(8),materialName:'source-wall'},{name:'source-wall',unlit:true});
 const up=generatedSkirtQuad(edge,2),down=generatedSkirtQuad(edge,-3),triangles=[...up.triangles,...down.triangles,...(duplicate?[up.triangles[0]!]:[])],positions=Float32Array.from(triangles.flatMap(t=>t.flat()));
 await b.addMesh({name:'c_test_flat',positions,uvs:new Float32Array(positions.length/3*2).fill(.125),indices:Uint32Array.from({length:positions.length/3},(_,i)=>i),materialName:'palette'},{name:'c_test_palette',unlit:true});
 await b.addMesh({name:'c_test_ground_stone',positions:Float32Array.from([8,0,0,8,0,2,10,0,0]),indices:Uint32Array.from([0,1,2]),materialName:'ground'},{name:'ground',unlit:false});return b.toGlb('source fixture',{},'exact');
}
test('Actual compressed GLB removal preserves the native wall, downward skirt, ground, original BIN and all materials',async()=>{
 const before=await fixture(),doc=await decodeDeliveryCityGlb(before),plan=findDuplicateSkirts(doc,buildings);assert.equal(plan.selections.length,1);assert.equal(plan.selections[0]!.quads.length,1);assert.equal(plan.selections[0]!.triangles.length,4);
 const result=await removeDuplicateSkirts(before,{expected:deliverySha(before),images:new Map(),buildings,selections:plan.selections}),a=readFacadeGlb(before),b=readFacadeGlb(result.bytes);assert.equal(result.proof.removedGeneratedQuads,1);assert.equal(deliveryGeometryStats(result.bytes).triangles,deliveryGeometryStats(before).triangles-4);assert.deepEqual(b.bin.subarray(0,a.bin.length),a.bin);assert.deepEqual(b.json.materials,a.json.materials);assert.deepEqual(b.json.images,a.json.images);assert.deepEqual(b.json.nodes,a.json.nodes);assert.equal((await validateBytes(result.bytes,{maxIssues:50})).issues.numErrors,0);
 const after=await decodeDeliveryCityGlb(result.bytes);assert.equal(findDuplicateSkirts(after,buildings).selections.length,0);
 await assert.rejects(removeDuplicateSkirts(before,{expected:deliverySha(before),images:new Map(),buildings:[{...buildings[0]!,faces:[faces[0]!]}],selections:plan.selections}),/qualification changed/);
 const wrong=plan.selections.map(s=>({...s,triangles:s.triangles.map((t,i)=>i===0?{...t,key:'0'.repeat(64)}:t)}));await assert.rejects(removeDuplicateSkirts(before,{expected:deliverySha(before),images:new Map(),buildings,selections:wrong}),/qualification changed/);
});
test('An absent native render wall or an ambiguous generated triangle holds the entire quartet',async()=>{
 const noWall=findDuplicateSkirts(await decodeDeliveryCityGlb(await fixture(false)),buildings);assert.equal(noWall.selections.length,0);assert.ok(noWall.census.some(c=>c.status==='HELD_NATIVE_WALL_EXACT_COVERAGE_NOT_PROVEN'));
 const duplicate=findDuplicateSkirts(await decodeDeliveryCityGlb(await fixture(true,true)),buildings);assert.equal(duplicate.selections.length,0);assert.ok(duplicate.census.some(c=>c.status==='HELD_GENERATED_QUARTET_ABSENT_OR_AMBIGUOUS'));
});
