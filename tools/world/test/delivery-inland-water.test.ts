import assert from 'node:assert/strict';
import {test} from 'node:test';
import {pointInPolygon} from '../lib/geometry.ts';
import {encodeCollisionBundle,parseCollisionBundle,geodeticToGk25} from '../../../packages/world-schema/src/index.ts';
import {inlandPolygons,restoreInlandGround,appendInlandCollision,restoreInlandTerrain,sourceInlandBody,qualifyInlandDomain,selectInlandWaterFace,retainedInlandCoastalReport,type InlandWaterProfile} from '../lib/delivery-inland-water.ts';
const box=(x=0,n=1200)=>inlandPolygons([[[[x,n],[x+2,n],[x+2,n+2],[x,n+2]]]])[0]!;
test('downstream coastal classification retains independent water and exact decks without stale restored polygons',()=>{
 const retained=[box(8)],deck={...box(12),id:'actual-deck',properties:{privateAuthoringPath:'not-published'}},original={mask:{area:{minX:0,maxX:20,minZ:-1220,maxZ:-1180},water:[box(),...retained],sources:{coastlineWays:[],waterWays:[],waterRelations:[]},stats:{coastlineChains:0,openChains:0,landRings:0,waterArea:8}},decks:{polygons:[deck]},waterY:-7.5};
 const before=structuredClone(original),report=retainedInlandCoastalReport(original,retained);
 assert.deepEqual(report.coastal.mask.water,retained);assert.deepEqual(report.coastal.mask.area,original.mask.area);assert.deepEqual(report.coastal.decks.polygons[0],{id:deck.id,rings:deck.rings,bbox:deck.bbox,properties:{}});assert.equal(report.coastal.waterY,-7.5);assert.deepEqual(original,before);report.coastal.mask.water[0]!.rings[0]![0]![0]=99;assert.deepEqual(original,before);
});
test('inland restoration interpolates actual nonlevel source heights and UVs without restoring vertical walls',()=>{
 const piece={cell:'c',finish:'grass' as const,level:'raised' as const,tag:'terrain:grass',positions:[-1,10,-1200,3,14,-1200,-1,10,-1204,-1,10,-1200,-1,12,-1200,-1,10,-1204],uvs:[-1,1200,3,1200,-1,1204,-1,1200,-1,1200,-1,1204],indices:[0,1,2,3,4,5]},before=structuredClone(piece),result=restoreInlandGround([piece],[box()],{minX:-10,maxX:10,minZ:-1220,maxZ:-1180});assert.deepEqual(piece,before);assert.ok(result.pieces.length);for(const p of result.pieces)for(const i of p.indices){const [x,y,z]=p.positions.slice(i*3,i*3+3);assert.ok(x!>=0&&x!<=2&&z!>=-1202&&z!<=-1200);assert.ok(Math.abs(y!-(11+x!))<1e-6);assert.ok(Math.abs(p.uvs[i*2]!-x!)<1e-6);}
});
test('inland ground clipping retains inner holes and omits protected source decks',()=>{
 const outer=box(),hole=box(.5,1200.5);hole.rings[0]=hole.rings[0]!.map(([x,n])=>[.5+(x-.5)/2,1200.5+(n-1200.5)/2]);const domain=inlandPolygons([[outer.rings[0]!,hole.rings[0]!]]);assert.equal(selectInlandWaterFace([[.1,-7.5,-1200.1],[.2,-7.5,-1200.1],[.1,-7.5,-1200.2]],domain),true);assert.equal(selectInlandWaterFace([[.6,-7.5,-1200.6],[.7,-7.5,-1200.6],[.6,-7.5,-1200.7]],domain),false);
});
test('water removal rejects a triangle crossing dry terrain instead of deleting a broad bounding box',()=>{
 assert.throws(()=>selectInlandWaterFace([[-1,-7.5,-1200],[1,-7.5,-1200],[1,-7.5,-1201]],[box()]),/crosses outside/);assert.equal(selectInlandWaterFace([[4,-7.5,-1200],[5,-7.5,-1200],[4,-7.5,-1201]],[box()]),false);
});
test('a native Float32 water vertex may differ only by its own half-ULP from the exact projected boundary',()=>{
 const p=box(.10000001),x=Math.fround(.10000001);assert.equal(selectInlandWaterFace([[x,-7.5,-1200],[.5,-7.5,-1200],[.5,-7.5,-1201]],[p]),true);assert.throws(()=>selectInlandWaterFace([[x-.001,-7.5,-1200],[.5,-7.5,-1200],[.5,-7.5,-1201]],[p]),/crosses outside/);
});
test('appended native HCOL keeps original prefixes and every non-ground collider, with semantic duplicate rejection',()=>{
 const positions=new Float32Array([0,0,0,1,0,0,0,0,1]),indices=new Uint32Array([0,2,1]),items=[{id:'g:c',group:'ground' as const,ref:null,positions,indices,triangleTags:new Uint16Array([0])},{id:'b:a',group:'buildings' as const,ref:'a',positions,indices,triangleTags:new Uint16Array([1])}],bytes=encodeCollisionBundle({originId:'test',frame:'X-east,Y-up,Z-south',cell:'c',surfaceTags:['ground:grass','wall']},items),piece={cell:'c',finish:'grass' as const,level:'raised' as const,tag:'ground:grass',positions:[2,2,0,3,3,0,2,2,1],uvs:[2,0,3,0,2,1],indices:[0,2,1]},r=appendInlandCollision(bytes,[piece]),after=parseCollisionBundle(r.bytes);assert.equal(r.added,1);assert.deepEqual(after.colliders[1],items[1]);assert.deepEqual(after.colliders[0]!.positions.subarray(0,positions.length),positions);assert.equal(appendInlandCollision(r.bytes,[piece]).duplicates,1);assert.throws(()=>appendInlandCollision(r.bytes,[{...piece,tag:'wrong'}]),/conflicts/);
});
test('safety restoration changes only exact original sea-cut indices and rejects a later local change',()=>{
 const field={x0:0,z0:-1200,nx:2,nz:2,resolution:1,heights:new Float32Array([-30,4,5,6])},restored={...field,heights:new Float32Array([20,4,5,6])},copy=structuredClone(field),r=restoreInlandTerrain(field,field,restored);assert.deepEqual(field,copy);assert.deepEqual(r.changes,[{index:0,before:-30,after:20}]);assert.equal(r.terrain.heights[1],4);assert.throws(()=>restoreInlandTerrain({...field,heights:new Float32Array([-29,4,5,6])},field,restored),/Later geometry/);assert.throws(()=>restoreInlandTerrain(field,field,{...restored,heights:new Float32Array([-31,4,5,6])}),/erroneous inland/);
});
test('source domain requires the exact original tags and projected rings, excluding unrelated new or accepted ground',()=>{
 const origin=[...geodeticToGk25(60,25),0],nodes=[{id:1,lat:60.011,lon:25},{id:2,lat:60.011,lon:25.00004},{id:3,lat:60.01104,lon:25.00004},{id:4,lat:60.01104,lon:25}].map(e=>({type:'node',...e})),osm={elements:[...nodes,{type:'way',id:7,nodes:[1,2,3,4,1],tags:{natural:'water',intermittent:'yes'}}]},body={...sourceInlandBody(osm,'way',7,origin),reason:'Intermittent inland source is not a sea-level water elevation survey.'},profile:InlandWaterProfile={schemaVersion:1,kind:'source-bound-new-inland-water-separation',newRegionXZ:[-10,-1300,10,-1152],seaWaterY:-7.5,sourceOsmSha256:'0'.repeat(64),nativeMetadataSha256:'1'.repeat(64),bodies:[body]},mask={area:{minX:-10,maxX:10,minZ:-1300,maxZ:-1152},water:inlandPolygons([body.rings]),sources:{coastlineWays:[],waterWays:[7],waterRelations:[]},stats:{coastlineChains:0,openChains:0,landRings:0,waterArea:1}};assert.ok(qualifyInlandDomain(profile,osm,mask,[],origin,[]).restored.length);assert.throws(()=>qualifyInlandDomain({...profile,newRegionXZ:[-10,-1300,10,0]},osm,mask,[],origin,[]),/newly acquired/);assert.throws(()=>qualifyInlandDomain({...profile,bodies:[{...body,tags:{natural:'water'}}]},osm,mask,[],origin,[]),/original source tags/);const changed=structuredClone(profile);changed.bodies[0]!.rings[0]![0]![0]+=.1;assert.throws(()=>qualifyInlandDomain(changed,osm,mask,[],origin,[]),/exact projected/);
});

test('overlapping independent water remains wet when a selected inland source is separated',()=>{
 const origin=[...geodeticToGk25(60,25),0];
 const nodes=[{id:1,lat:60.011,lon:25},{id:2,lat:60.011,lon:25.00004},{id:3,lat:60.01104,lon:25.00004},{id:4,lat:60.01104,lon:25}].map(e=>({type:'node',...e}));
 const osm={elements:[...nodes,{type:'way',id:7,nodes:[1,2,3,4,1],tags:{natural:'water',intermittent:'yes'}}]};
 const body={...sourceInlandBody(osm,'way',7,origin),reason:'Reviewed intermittent inland source with a separately protected water overlap.'};
 const profile:InlandWaterProfile={schemaVersion:1,kind:'source-bound-new-inland-water-separation',newRegionXZ:[-10,-1300,10,-1152],seaWaterY:-7.5,sourceOsmSha256:'0'.repeat(64),nativeMetadataSha256:'1'.repeat(64),bodies:[body]};
 const area={minX:-10,maxX:10,minZ:-1300,maxZ:-1152},water=inlandPolygons([body.rings]),mask={area,water,sources:{coastlineWays:[],waterWays:[7],waterRelations:[]},stats:{coastlineChains:0,openChains:0,landRings:0,waterArea:1}};
 const x=body.rings[0]!.reduce((n,p)=>n+p[0]/body.rings[0]!.length,0),independent=inlandPolygons([[[[x,1152],[10,1152],[10,1300],[x,1300]]]]);
 const result=qualifyInlandDomain(profile,osm,mask,[],origin,independent);
 assert.ok(result.restored.length&&result.protectedIndependentWater.length);
 for(const p of result.restored)for(const ring of p.rings)for(const q of ring)assert.ok(q[0]<=x+1e-7);
 assert.ok(result.retainedWater.some(p=>pointInPolygon([x+.2,body.rings[0]![0]![1]+.2],p.rings)));
});
