import assert from 'node:assert/strict';
import {RoadIndex,parseCollisionBundle,parseTerrain,sampleTerrain,containsSupportedArea,type AddressEntry,type CellDescriptor,type GameplayBundle,type RoadGraph} from '../../../packages/world-schema/src/index.ts';
import {RAPIER,GROUP,groups,groundBelowBundle} from '../../../packages/sim/src/world.ts';
import {CHARACTER,CHARACTER_SKIN,FEET_TO_CENTRE} from '../../../packages/sim/src/character.ts';
import {resolveDropInTarget} from '../../../apps/game/src/world/drop-in.ts';
import {deliveryFloorCoverage,type DeliveryFloorTriangle} from './delivery-city-floor-coverage.ts';
import {sourceSha256} from './source-files.ts';

export interface AddressPhysicalAuthority {
  gameplay:GameplayBundle;roads:RoadGraph;terrainBytes:Uint8Array;terrainDecodedSha256:string;
  cells:readonly CellDescriptor[];readCollision:(cell:CellDescriptor)=>Uint8Array;
}
interface Surface {cell:string;id:string;group:string;tags:Uint16Array;names:readonly string[]}
const margin=CHARACTER.radius+.02,identity={x:0,y:0,z:0,w:1},staticGroups=groups(GROUP.bullet,GROUP.static);
const canonical=(value:unknown)=>sourceSha256(JSON.stringify(value));
const rectangle=(c:CellDescriptor)=>c.collision.boundsXZ??c.boundsXZ;
const inventory=(cells:readonly CellDescriptor[])=>cells.map(c=>({id:c.id,boundsXZ:rectangle(c),collision:c.collision})).sort((a,b)=>a.id.localeCompare(b.id,'en'));
type Point3=[number,number,number];
/** Keep only the literal part of a source face inside the local height slab.
 * Far-away vertices of a large sloping face do not describe the local support. */
function clipHeight(ring:readonly Point3[],height:number,above:boolean){const out:Point3[]=[];for(let i=0;i<ring.length;i++){const a=ring[i]!,b=ring[(i+1)%ring.length]!,u=(a[1]-height)*(above?1:-1),v=(b[1]-height)*(above?1:-1);if(u>=0)out.push(a);if((u>=0)!==(v>=0)){const t=u/(u-v);out.push([a[0]+(b[0]-a[0])*t,height,a[2]+(b[2]-a[2])*t]);}}return out;}
/** Conservative full-footprint coverage, not just a handful of floor probes.
 * The circumscribed 16-gon contains the actual character circle. */
function supportDisk(x:number,z:number,y:number,bundles:readonly ReturnType<typeof parseCollisionBundle>[]){
  const radius=margin/Math.cos(Math.PI/16),floors:DeliveryFloorTriangle[]=[];
  for(const bundle of bundles)for(const c of bundle.colliders){if(c.group!=='ground'&&c.group!=='kerbs')continue;for(let t=0;t<c.indices.length;t+=3){const tag=bundle.header.surfaceTags[c.triangleTags[t/3]!]!;if(/water|sea|ocean/i.test(tag))continue;const p=[0,1,2].map(k=>Array.from(c.positions.subarray(c.indices[t+k]!*3,c.indices[t+k]!*3+3))as[number,number,number]);if(Math.max(...p.map(v=>v[0]))<x-radius||Math.min(...p.map(v=>v[0]))>x+radius||Math.max(...p.map(v=>v[2]))<z-radius||Math.min(...p.map(v=>v[2]))>z+radius)continue;
    const[a,b,d]=p,u=b!.map((v,i)=>v-a![i]!),v=d!.map((n,i)=>n-a![i]!),normal=[u[1]!*v[2]!-u[2]!*v[1]!,u[2]!*v[0]!-u[0]!*v[2]!,u[0]!*v[1]!-u[1]!*v[0]!];if(normal[1]!/Math.hypot(...normal)<.75)continue;const local=clipHeight(clipHeight(p,y-.45,true),y+.45,false);for(let i=1;i+1<local.length;i++)floors.push([local[0]!,local[i]!,local[i+1]!].map(v=>[v[0],0,v[2]]));}}
  const ring=Array.from({length:16},(_,i)=>[x+Math.cos(i*Math.PI/8)*radius,0,z+Math.sin(i*Math.PI/8)*radius]as[number,number,number]);return ring.every((p,i)=>deliveryFloorCoverage([[x,0,z],p,ring[(i+1)%16]!],floors));
}
/** Only final serialized HCOL is physical authority. Terrain supplies the same
 * ray origin as the runtime, never a fallback surface that could bless water. */
export async function inspectAddressTargets(entries:readonly AddressEntry[],authority:AddressPhysicalAuthority){
  assert.ok(entries.length>0&&entries.length<=4096);assert.equal(sourceSha256(authority.terrainBytes),authority.terrainDecodedSha256,'Final address terrain differs');assert.ok(authority.gameplay.supportedArea,'Expanded addresses require reviewed supported coverage');assert.equal(authority.roads.originId,authority.gameplay.originId);assert.equal(new Set(authority.cells.map(c=>c.id)).size,authority.cells.length,'Duplicate final collision owner');
  const terrain=parseTerrain(authority.terrainBytes,{copy:false}),roads=new RoadIndex(authority.roads),used=new Map<string,{cell:CellDescriptor;sha256:string}>(),results:any[]=[],roadsHash=canonical(authority.roads),maskHash=canonical(authority.gameplay.supportedArea),cellsHash=canonical(inventory(authority.cells));await RAPIER.init();
  for(const entry of entries){
    const target=resolveDropInTarget(authority.gameplay,roads,...entry.position);if(!target){results.push({label:entry.label,status:'REJECTED',reason:'shared-resolver-has-no-supported-target'});continue;}
    const[x,z]=target,selected=authority.cells.filter(c=>{const b=rectangle(c);return b[0]<=x+1&&b[2]>=x-1&&b[1]<=z+1&&b[3]>=z-1;}),physics=new RAPIER.World({x:0,y:-9.81,z:0}),surfaces=new Map<number,Surface>(),bundles:ReturnType<typeof parseCollisionBundle>[]=[];let bytes=0,triangles=0;
    try{
      assert.ok(selected.length>0&&selected.length<=64,'Address target has no bounded complete collision selection');
      for(const cell of selected){const raw=authority.readCollision(cell),expected=cell.collision.decodedSha256??cell.collision.sha256;assert.equal(sourceSha256(raw),expected,'Final address collision differs');assert.equal(raw.length,cell.collision.decodedBytes??cell.collision.bytes);bytes+=raw.length;assert.ok(bytes<=128*1024*1024,'Address local collision byte budget exceeded');const bundle=parseCollisionBundle(raw);assert.equal(bundle.header.cell,cell.id);bundles.push(bundle);used.set(cell.id,{cell,sha256:expected});
        for(const c of bundle.colliders){triangles+=c.indices.length/3;assert.ok(triangles<=2_000_000,'Address local collision triangle budget exceeded');if(!c.indices.length)continue;const descriptor=RAPIER.ColliderDesc.trimesh(c.positions,c.indices,c.group==='ground'?RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES:undefined).setCollisionGroups(groups(GROUP.static,GROUP.all)),collider=physics.createCollider(descriptor);surfaces.set(collider.handle,{cell:cell.id,id:c.id,group:c.group,tags:c.triangleTags,names:bundle.header.surfaceTags});}}
      physics.step();const top=sampleTerrain(terrain,x,z)+30,probe=(px:number,pz:number)=>{const hit=physics.castRayAndGetNormal(new RAPIER.Ray({x:px,y:top,z:pz},{x:0,y:-1,z:0}),80,true,undefined,staticGroups);if(!hit)return null;const surface=surfaces.get(hit.collider.handle)!;return{y:top-hit.timeOfImpact,normalY:hit.normal.y,cell:surface.cell,collider:surface.id,group:surface.group,triangle:hit.featureId??null,tag:hit.featureId===undefined?surface.group:surface.names[surface.tags[hit.featureId]!]??surface.group};},central=probe(x,z);
      const reject=(reason:string)=>results.push({label:entry.label,status:'REJECTED',reason,target,central});
      if(!central||!['ground','kerbs'].includes(central.group)||/water|sea|ocean/i.test(central.tag)||central.normalY<.75||central.y<authority.gameplay.killHeight+2){reject('no-walkable-native-central-floor');continue;}
      const cold=bundles.reduce((best,b)=>Math.max(best,groundBelowBundle(b,x,top,z,80)??-Infinity),sampleTerrain(terrain,x,z)-.4);if(!Number.isFinite(cold)||Math.abs(cold-central.y)>.01){reject('cold-and-resident-drop-in-levels-differ');continue;}
      if(!containsSupportedArea(authority.gameplay,x,z,margin)||!supportDisk(x,z,central.y,bundles)){reject('character-footprint-lacks-complete-native-support');continue;}
      const ring=Array.from({length:16},(_,i)=>probe(x+Math.cos(i*Math.PI/8)*margin,z+Math.sin(i*Math.PI/8)*margin));if(ring.some(p=>!p||!['ground','kerbs'].includes(p.group)||/water|sea|ocean/i.test(p.tag)||p.normalY<.75||Math.abs(p.y-central.y)>.45)){reject('character-footprint-crosses-a-floor-or-level-boundary');continue;}
      const obstruction=physics.intersectionWithShape({x,y:central.y+CHARACTER_SKIN+FEET_TO_CENTRE,z},identity,new RAPIER.Capsule(CHARACTER.halfHeight,CHARACTER.radius),undefined,groups(GROUP.character,GROUP.static));if(obstruction){reject('character-capsule-or-headroom-blocked');continue;}
      results.push({label:entry.label,status:'QUALIFIED',target,feetY:central.y,coldFeetY:cold,central,footprintRadius:margin,fullFootprintNativeCoverage:true,capsuleClear:true,localCells:selected.map(c=>c.id),localDecodedBytes:bytes,localTriangles:triangles});
    }finally{physics.free();}
  }
  return{results,proof:{status:results.every(r=>r.status==='QUALIFIED')?'PASS_FINAL_SERIALIZED_ADDRESS_TARGETS':'REJECTED_ADDRESS_TARGETS',terrainDecodedSha256:authority.terrainDecodedSha256,roadsValueSha256:roadsHash,supportedAreaValueSha256:maskHash,finalCollisionInventorySha256:cellsHash,supportInputs:[...used.values()].map(v=>({cell:v.cell.id,decodedSha256:v.sha256})).sort((a,b)=>a.cell.localeCompare(b.cell,'en')),targets:results},verifyInputs:()=>{assert.equal(canonical(authority.roads),roadsHash,'Address roads changed');assert.equal(canonical(authority.gameplay.supportedArea),maskHash,'Address supported area changed');assert.equal(canonical(inventory(authority.cells)),cellsHash,'Address collision inventory changed');assert.equal(sourceSha256(authority.terrainBytes),authority.terrainDecodedSha256);for(const{cell,sha256}of used.values())assert.equal(sourceSha256(authority.readCollision(cell)),sha256,'Address collision changed before publication');}};
}
