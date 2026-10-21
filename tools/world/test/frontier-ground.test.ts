import assert from 'node:assert/strict';
import {test} from 'node:test';
import {encodeCollisionBundle,parseCollisionBundle} from '../../../packages/world-schema/src/index.ts';
import {clipFrontierMesh,frontierTriangleKey,addNativeFrontier,clipFrontierCollision,prepareNativeFrontier,planCityFrontier,frontierRuntimeLoweringAllowed,type FrontierMesh} from '../lib/frontier-ground.ts';
const mesh=():FrontierMesh=>({attributes:{POSITION:new Float32Array([-2,0,0,2,0,0,2,0,2]),NORMAL:new Int8Array([0,127,0,0,127,0,0,127,0]),TEXCOORD_0:new Float32Array([0,0,2,0,2,2])},components:{POSITION:3,NORMAL:3,TEXCOORD_0:2},normalized:{POSITION:false,NORMAL:true,TEXCOORD_0:false},indices:new Uint32Array([0,2,1])});
test('frontier clips the original plane, UVs, winding and raw normalized normals together',()=>{
 const before=mesh(),copy=structuredClone(before),out=clipFrontierMesh(before,{cutX:0,side:'east'});assert.deepEqual(before,copy);assert.equal(out.mesh.indices.length,6);assert.ok(out.mesh.attributes.POSITION!.every((v,i)=>i%3!==0||v>=0));assert.ok(out.mesh.attributes.NORMAL instanceof Int8Array);
 for(let i=0;i<out.mesh.attributes.POSITION!.length/3;i++){assert.equal(out.mesh.attributes.TEXCOORD_0![i*2],(out.mesh.attributes.POSITION![i*3]!+2)/2);assert.equal(out.mesh.attributes.NORMAL![i*3+1],127);}assert.deepEqual(out.sourceTriangles,[0,0]);
});
test('uncut and unselected triangles retain exact raw values; vertical walls survive clipping',()=>{
 const original=mesh(),out=clipFrontierMesh(original,{cutX:0,side:'east',selectTriangle:()=>false});for(const s of Object.keys(original.attributes)){const size=original.components[s]!;assert.deepEqual(out.mesh.attributes[s],new (original.attributes[s]!.constructor as any)([0,2,1].flatMap(i=>Array.from(original.attributes[s]!.subarray(i*size,(i+1)*size)))));}
 const wall:FrontierMesh={attributes:{POSITION:new Float32Array([-2,0,1,2,0,1,2,4,1])},components:{POSITION:3},normalized:{POSITION:false},indices:new Uint32Array([0,1,2])};assert.equal(clipFrontierMesh(wall,{cutX:0,side:'west'}).mesh.indices.length,3);assert.equal(clipFrontierMesh(wall,{cutX:2,side:'east'}).mesh.indices.length,0);
});
test('Float32 triangle ownership is cyclic and winding-sensitive and supports a Z cut',()=>{
 const p=[[1,2,3],[4,5,6],[7,8,9]];assert.equal(frontierTriangleKey(p),frontierTriangleKey([p[1]!,p[2]!,p[0]!]));assert.notEqual(frontierTriangleKey(p),frontierTriangleKey([p[0]!,p[2]!,p[1]!]));assert.equal(frontierTriangleKey([[0,0,0],[1,0,0],[0,0,1]]),frontierTriangleKey([[-0,0,0],[1,0,0],[0,0,1]]));
 assert.ok(clipFrontierMesh(mesh(),{cutX:1,cutAxis:2,side:'east'}).mesh.attributes.POSITION!.every((v,i)=>i%3!==2||v>=1));
});
test('native finish append preserves all retained attributes and excludes collision-only pieces',()=>{
 const old=mesh(),piece={cell:'c',finish:'grass' as const,level:'raised' as const,tag:'raised:grass',positions:[0,1,0,0,1,1,1,1,0],uvs:[0,0,0,1,1,0],indices:[0,1,2]},out=addNativeFrontier(old,[piece,{...piece,use:'collision'}]);for(const s of Object.keys(old.attributes))assert.deepEqual(out.attributes[s]!.subarray(0,old.attributes[s]!.length),old.attributes[s]);assert.equal(out.indices.length,old.indices.length+3);assert.deepEqual(out.indices.subarray(0,3),old.indices);
});
test('HCOL retains item identity/order and non-ground arrays while carrying original surface tags',()=>{
 const p=new Float32Array([-2,0,0,2,0,0,2,0,2]),idx=new Uint32Array([0,2,1]),items=[{id:'g:c',group:'ground' as const,ref:null,positions:p,indices:idx,triangleTags:new Uint16Array([1])},{id:'b:one',group:'buildings' as const,ref:'one',positions:p,indices:idx,triangleTags:new Uint16Array([0])}],bytes=encodeCollisionBundle({originId:'test',frame:'X-east,Y-up,Z-south',cell:'c',surfaceTags:['wall','road']},items),out=parseCollisionBundle(clipFrontierCollision(bytes,{cutX:0,side:'east'}).bytes);assert.deepEqual(out.header.surfaceTags,['wall','road']);assert.deepEqual(out.colliders.map(c=>c.id),items.map(c=>c.id));assert.deepEqual(out.colliders[1],items[1]);assert.deepEqual(out.colliders[0]!.triangleTags,new Uint16Array([1,1]));
});
test('invalid domains and attributes fail rather than omitting geometry',()=>{
 assert.throws(()=>clipFrontierMesh(mesh(),{cutX:NaN,side:'east'}));const invalid=mesh();invalid.indices[0]=99;assert.throws(()=>clipFrontierMesh(invalid,{cutX:0,side:'east'}),/out of range/);const nan=mesh();nan.attributes.POSITION![0]=NaN;assert.throws(()=>clipFrontierMesh(nan,{cutX:0,side:'east'}),/Nonfinite/);
});
test('only exactly Float32-degenerate new native triangles are discarded with complete witnesses',()=>{
 const p={cell:'c',finish:'slabs' as const,level:'raised' as const,tag:'raised',positions:[-1350,1,0,-1350+1e-8,1,0,-1350,1,1,-1350,1,0,-1350+.001,1,0,-1350,1,1],uvs:[0,0,1,0,0,1,0,0,1,0,0,1],indices:[0,1,2,3,4,5]},before=structuredClone(p),r=prepareNativeFrontier([p]);assert.deepEqual(p,before);assert.equal(r.discarded.length,1);assert.deepEqual(r.pieces[0]!.indices,[3,4,5]);assert.deepEqual(r.discarded[0]!.positions[0],r.discarded[0]!.positions[1]);
});
test('north native band is bound to the complete accepted edge and never widens into protected terrain',()=>{
 const p=planCityFrontier([-1792,-950,800,450],[-1792,-1152,800,-950],'z');assert.equal(p.cut,-945);assert.deepEqual(p.sourceBand,[-1792,-956,800,-945]);assert.deepEqual(p.groundRegion,[-1792,-1152,800,-945]);assert.equal(p.protectedSide,'south');
 assert.ok(frontierRuntimeLoweringAllowed(p,-1792,-950,10,9));assert.ok(frontierRuntimeLoweringAllowed(p,800,-946,10,9));
 for(const [x,z,b]of[[-1792,-945,9],[0,-944,9],[0,-950,11],[-1793,-950,9],[801,-950,9],[0,-951,9]])assert.equal(frontierRuntimeLoweringAllowed(p,x!,z!,10,b!),false);
 for(const r of[[-1791,-1152,800,-950],[-1792,-1152,800,-949],[-1792,-1152,799,-950]])assert.throws(()=>planCityFrontier([-1792,-950,800,450],r as [number,number,number,number],'z'),/full northern strip/);
 const west=planCityFrontier([-1350,-950,800,450],[-1792,-950,-1350,450]);assert.equal(west.cut,-1345);assert.deepEqual(west.sourceBand,[-1356,-950,-1345,450]);assert.ok(frontierRuntimeLoweringAllowed(west,-1350,0,10,9));assert.equal(frontierRuntimeLoweringAllowed(west,-1345,0,10,9),false);
});

test('southern native band mirrors the boundary authority without permitting northern or upward terrain changes',()=>{
 const accepted=[-1792,-1152,800,450]as const,region=[-1792,450,800,768]as const;
 const p=planCityFrontier(accepted,region,'z');assert.equal(p.cut,445);assert.equal(p.protectedSide,'north');assert.deepEqual(p.groundRegion,[-1792,445,800,768]);assert.deepEqual(p.sourceBand,[-1792,445,800,456]);
 assert.ok(frontierRuntimeLoweringAllowed(p,-1792,450,10,9));assert.ok(frontierRuntimeLoweringAllowed(p,800,446,10,9));
 for(const[x,z,next]of[[0,445,9],[0,444,9],[0,-1152,9],[0,450,11],[0,450,10],[-1793,450,9],[801,450,9],[0,451,9],[0,450,NaN]])assert.equal(frontierRuntimeLoweringAllowed(p,x!,z!,10,next!),false);
 for(const invalid of[[-1791,450,800,768],[-1792,449,800,768],[-1792,451,800,768],[-1792,450,799,768],[-1792,450,800,450]])assert.throws(()=>planCityFrontier(accepted,invalid as [number,number,number,number],'z'));
 const n=planCityFrontier([-1792,-450,800,1152],[-1792,-768,800,-450],'z');assert.equal(p.cut,-n.cut);assert.deepEqual(p.sourceBand,[n.sourceBand[0],-n.sourceBand[3],n.sourceBand[2],-n.sourceBand[1]]);
});
test('explicit north and south clipping preserves winding, UVs and non-ground HCOL on a Z frontier',()=>{
 const before=mesh(),south=clipFrontierMesh(before,{cut:1,axis:'z',side:'south'}),north=clipFrontierMesh(before,{cut:1,axis:'z',side:'north'});
 for(const [out,inside]of[[south,(z:number)=>z>=1],[north,(z:number)=>z<=1]]as const)for(let i=0;i<out.mesh.attributes.POSITION!.length/3;i++){const z=out.mesh.attributes.POSITION![i*3+2]!;assert.ok(inside(z));assert.equal(out.mesh.attributes.TEXCOORD_0![i*2+1],z);assert.equal(out.mesh.attributes.NORMAL![i*3+1],127);}
 const items=[{id:'g:c',group:'ground' as const,ref:null,positions:before.attributes.POSITION as Float32Array,indices:before.indices,triangleTags:new Uint16Array([1])},{id:'b:old-west-patch',group:'buildings' as const,ref:'old',positions:before.attributes.POSITION as Float32Array,indices:before.indices,triangleTags:new Uint16Array([0])}],bytes=encodeCollisionBundle({originId:'test',frame:'X-east,Y-up,Z-south',cell:'c',surfaceTags:['wall','road']},items),out=parseCollisionBundle(clipFrontierCollision(bytes,{cut:1,axis:'z',side:'south'}).bytes);assert.deepEqual(out.colliders[1],items[1]);assert.deepEqual(out.colliders[0]!.triangleTags,new Uint16Array([1]));
 assert.throws(()=>clipFrontierMesh(before,{cut:1,axis:'x',side:'south'}),/Z frontier/);assert.throws(()=>clipFrontierMesh(before,{cut:1,cutX:2,axis:'z',side:'south'}),/Conflicting frontier cuts/);assert.throws(()=>clipFrontierMesh(before,{cut:1,axis:'z',cutAxis:0,side:'south'}),/Conflicting frontier axes/);
});
