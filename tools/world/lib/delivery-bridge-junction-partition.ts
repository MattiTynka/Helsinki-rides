import assert from'node:assert/strict';
import type{FrontierMesh}from'./frontier-ground.ts';
import type{TramSupportPatch}from'./tram-support-repair.ts';
import{retainJunctionSourceUnion}from'./delivery-bridge-junction-mesh.ts';
import{junctionFaceSha,type JunctionFloorBank}from'./delivery-bridge-junction-mouths.ts';
import{validateJunctionSkinAttachment}from'./delivery-bridge-junction-attachment.ts';
import type{JunctionFloorWitness}from'./delivery-bridge-junction-surfaces.ts';
export interface JunctionSkinVertexAttachment {source:JunctionFloorBank['source'];edge:0|1|2;parameter:number;point:[number,number,number];heightOffset:number}
export interface JunctionSourceSelection{triangle:number;orderedFloat32Sha256:string;group:'ground'|'kerbs'|'props';tag:string;role:'native-upper-carriageway'|'native-upper-walking'|'authored-upper-walking-floor'|'native-upper-curb'|'authored-approach-floor'|'authored-mouth-curb'|'authored-mouth-bottom-skin';masks:readonly[number,number][][];skinAttachment?:[JunctionSkinVertexAttachment,JunctionSkinVertexAttachment,JunctionSkinVertexAttachment]}
/** Source IDs and literal oriented XYZ faces authorize each individual cut.
 * Sharing XZ, Y or even a coplanar material never authorizes another level.
 * Every unselected triangle retains its exact original indices and arrays. */
export function partitionJunctionSourceMesh(mesh:FrontierMesh,group:string,tags:readonly string[],selection:readonly JunctionSourceSelection[],floorSources:readonly JunctionFloorWitness[]=[]){
 assert.equal(tags.length,mesh.indices.length/3);const patches=new Map<number,TramSupportPatch[]>(),selected=new Set<number>();
 for(const s of selection){assert.ok(Number.isSafeInteger(s.triangle)&&s.triangle>=0&&s.triangle<tags.length);assert.ok(!selected.has(s.triangle),'Duplicate junction source face');selected.add(s.triangle);assert.equal(group,s.group,'Junction source level/group changed');assert.equal(tags[s.triangle],s.tag,'Junction source semantic changed');
  if(s.role==='native-upper-carriageway')assert.ok(group==='ground'&&s.tag==='road:asphalt','Only named native upper carriageway floors qualify');
  else if(s.role==='native-upper-walking')assert.ok(group==='ground'&&['raised:asphalt','raised:slabs'].includes(s.tag),'Only the explicit native walking finishes qualify');
  else if(s.role==='authored-upper-walking-floor')assert.ok(group==='ground'&&['raised:asphalt:bridge-reconstruction','raised:slabs:bridge-junction'].includes(s.tag),'Walking repair cannot remove a ROAD floor');
  else if(s.role==='native-upper-curb')assert.ok((group==='ground'||group==='kerbs')&&s.tag==='curb'&&s.skinAttachment);
  else if(s.role==='authored-approach-floor')assert.ok(group==='ground'&&['road:asphalt:bridge-reconstruction','raised:asphalt:bridge-reconstruction'].includes(s.tag));
  else if(s.role==='authored-mouth-curb')assert.ok(group==='kerbs'&&s.tag==='wall:bridge-reconstruction'&&s.skinAttachment);
  else assert.ok(s.role==='authored-mouth-bottom-skin'&&group==='props'&&s.tag==='wall:bridge-reconstruction'&&s.skinAttachment);
  const points=[0,1,2].map(k=>Array.from(mesh.attributes.POSITION!.subarray(mesh.indices[s.triangle*3+k]!*3,mesh.indices[s.triangle*3+k]!*3+3)));assert.equal(junctionFaceSha(points),s.orderedFloat32Sha256,'Exact selected junction source face changed');if(!['native-upper-carriageway','authored-approach-floor','native-upper-walking','authored-upper-walking-floor'].includes(s.role))validateJunctionSkinAttachment(s,points,floorSources);assert.ok(s.masks.length>0);patches.set(s.triangle,s.masks.map((polygon,i)=>{assert.ok(polygon.length>=3&&polygon.every(p=>p.length===2&&p.every(Number.isFinite)));let sign=0;for(let j=0;j<polygon.length;j++){const a=polygon[j]!,b=polygon[(j+1)%polygon.length]!,c=polygon[(j+2)%polygon.length]!,det=(b[0]-a[0])*(c[1]-b[1])-(b[1]-a[1])*(c[0]-b[0]);if(det!==0){if(sign)assert.equal(Math.sign(det),sign,'Junction cut mask is not convex');sign=Math.sign(det);}}assert.ok(sign,'Zero-area junction mask has no removal authority');return{id:`junction-${s.triangle}-${i}`,cell:'c_p00_p00',footprint:polygon,boundsXZ:[Math.min(...polygon.map(p=>p[0])),Math.min(...polygon.map(p=>p[1])),Math.max(...polygon.map(p=>p[0])),Math.max(...polygon.map(p=>p[1]))],triangles:[],sourceNode:'exact-named-upper-junction',sourcePrimitive:0,observations:[]};}));
 }
 const result=retainJunctionSourceUnion(mesh,new Map([...patches].map(([triangle,masks])=>[triangle,masks.map(m=>m.footprint!)])));for(const[key,original]of Object.entries(mesh.attributes))assert.deepEqual(result.mesh.attributes[key]!.subarray(0,original.length),original,'Junction changed original native attribute prefix');
 const retained=result.sourceTriangles.map((source,index)=>({source,indices:Array.from(result.mesh.indices.subarray(index*3,index*3+3))}));for(let t=0;t<tags.length;t++)if(!selected.has(t)){const literal=Array.from(mesh.indices.subarray(t*3,t*3+3));assert.ok(retained.some(r=>r.source===t&&r.indices.every((v,i)=>v===literal[i])),'Unselected layer or architecture lost its literal source triangle');}
 return{...result,proof:{...result.proof,selectedSourceFaces:selection.map(s=>({triangle:s.triangle,orderedFloat32Sha256:s.orderedFloat32Sha256,group:s.group,tag:s.tag,role:s.role,masks:s.masks,skinAttachment:s.skinAttachment??null})),unselectedSourceFacesLiteral:true,allOriginalAttributesLiteralPrefixes:true}};
}
