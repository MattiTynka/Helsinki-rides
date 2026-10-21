import assert from'node:assert/strict';
import{test}from'node:test';
import{qualifyFullBarkStructureOmission,type FullBarkStructureBinding}from'../lib/tree-structural-registration.ts';
import{registrationSha256,type RegistrationTree}from'../lib/tree-ground-registration.ts';
import type{BarkTriangle,TreeBarkModel,TreeBarkProfile}from'../lib/tree-bark-registration.ts';
const tree:RegistrationTree={id:'TREE_SUMMER_3ea76f65-e162-4487-a74c-2ef309951fa6',model:'native-tree',position:[0,0,0],yaw:0,scale:[1,1,1],trunkRadius:.1,colliderHeight:5};
const wall:BarkTriangle=[[0,-2,-2],[0,8,-2],[0,8,2]],branch:BarkTriangle=[[-1,3,0],[1,3,0],[0,4,0]],model:TreeBarkModel={root:[[-.1,0,-.1],[.1,0,-.1],[0,0,.1]],triangles:[branch]},context={buildingIds:['104251989C'],retainingWallIds:[],waterPointIndices:[]},profile={range:[0,.1],missing:0,sha256:'pinned-dense-soil'}as TreeBarkProfile;
const ref={path:'cells/fixture.glb',bytes:1,sha256:'a'.repeat(64)};
function binding(actual=model):FullBarkStructureBinding{return{kind:'reviewed-full-height-bark-structure',model:tree.model,barkModelSha256:registrationSha256(JSON.stringify(actual)),buildingId:'104251989C',buildingRef:'BID_beda8ed1-eac1-42fb-bc09-5c57991bc871',visual:{cell:'fixture',file:ref,node:'native-wall',primitive:0,triangle:0,verticesSha256:registrationSha256(JSON.stringify(wall))},collision:{cell:'fixture',file:{...ref,path:'cells/fixture.hcol'},collider:'native-building',triangle:0,verticesSha256:registrationSha256(JSON.stringify(wall))}};}
test('reviewed woody branch crosses independently pinned visual and collision walls above the ordinary two-metre window at both heights',()=>{
  const proof=qualifyFullBarkStructureOmission(tree,model,profile,context,binding(),{visual:wall,collision:wall});assert.equal(proof.rows.length,2);assert.notEqual(proof.rows[0]!.y,proof.rows[1]!.y);assert.ok(proof.rows.every(r=>r.visualIntersections.length&&r.collisionIntersections.length));assert.ok(proof.rows.flatMap(r=>r.visualIntersections).every(p=>p[1]>2));
});
test('valid clear bark with a leaf canopy overhang cannot be omitted from a projected canopy conflict',()=>{
  // Leaf geometry is deliberately absent from decodeTreeBarkModels' woody model.
  const clear:TreeBarkModel={root:model.root,triangles:[[[-.2,0,0],[-.2,4,0],[-.1,4,.1]]]};assert.throws(()=>qualifyFullBarkStructureOmission(tree,clear,profile,context,binding(clear),{visual:wall,collision:wall}),/Actual above-soil bark/);
});
test('a buried horizontal soil or stacked roof floor is never a vertical structural omission',()=>{
  const soil:BarkTriangle=[[-2,-.3,-2],[2,-.3,-2],[0,-.3,2]],b=binding();b.visual.verticesSha256=registrationSha256(JSON.stringify(soil));b.collision.verticesSha256=b.visual.verticesSha256;assert.throws(()=>qualifyFullBarkStructureOmission(tree,model,profile,context,b,{visual:soil,collision:soil}),/vertical structural/);
});
test('each actual representation must intersect; mismatched or clear collision cannot hide behind visible geometry',()=>{
  const clear=wall.map(p=>[p[0]+20,p[1],p[2]])as BarkTriangle,b=binding();b.collision.verticesSha256=registrationSha256(JSON.stringify(clear));assert.throws(()=>qualifyFullBarkStructureOmission(tree,model,profile,context,b,{visual:wall,collision:clear}),/independently pinned/);
});
test('all per-ID, model, native-face and complete-soil bindings fail closed on drift',()=>{
  assert.throws(()=>qualifyFullBarkStructureOmission({...tree,id:'another-source-tree'},model,profile,context,binding(),{visual:wall,collision:wall}),/individually qualified/);
  const b=binding();b.barkModelSha256='f'.repeat(64);assert.throws(()=>qualifyFullBarkStructureOmission(tree,model,profile,context,b,{visual:wall,collision:wall}),/bark model changed/);
  assert.throws(()=>qualifyFullBarkStructureOmission(tree,model,{...profile,missing:1},context,binding(),{visual:wall,collision:wall}),/missing soil/);
  assert.throws(()=>qualifyFullBarkStructureOmission(tree,model,profile,{...context,buildingIds:[]},binding(),{visual:wall,collision:wall}),/actual source building/);
  const changed=structuredClone(wall);changed[0][2]+=.1;assert.throws(()=>qualifyFullBarkStructureOmission(tree,model,profile,context,binding(),{visual:changed,collision:wall}));
});
