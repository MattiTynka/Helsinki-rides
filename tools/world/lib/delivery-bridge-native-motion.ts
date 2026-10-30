import assert from 'node:assert/strict';
import {Character,CHARACTER,FEET_TO_CENTRE,initPhysics,RAPIER,StaticWorld} from '../../../packages/sim/src/index.ts';
import {encodeCollisionBundle,parseCollisionBundle,type GameplayBundle,type RoadGraph} from '../../../packages/world-schema/src/index.ts';
import {buildExtraBridgeDeck,type ExtraBridgeDeckProfile} from './delivery-extra-bridges-mesh.ts';
import type {ExtraBridgeNativeFace} from './delivery-extra-bridges-source.ts';
import {sourceSha256} from './source-files.ts';

type Point=[number,number];
export interface NativeBridgeMotionInput {
  terrainBytes:Uint8Array;roads:RoadGraph;gameplay:GameplayBundle;
  cells:readonly{id:string;bytes:Uint8Array}[];profile:ExtraBridgeDeckProfile;
}
export interface NativeBridgeMotionPolicy {
  axis:readonly Point[];lateralOffsets:readonly number[];
  maximumTrackErrorMetres:number;bodyRadiusMetres:number;
}
const distanceToSegment=(p:Point,a:Point,b:Point)=>{const dx=b[0]-a[0],dz=b[1]-a[1],n=dx*dx+dz*dz,t=n?Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dz)/n)):0;return Math.hypot(p[0]-a[0]-t*dx,p[1]-a[1]-t*dz);};

/** Authoring gate, not a substitute for live-world travel. Every run uses the
 * actual Character controller and immutable serialized native collision. */
export async function qualifyBridgeNativeMotion(input:NativeBridgeMotionInput,policy:NativeBridgeMotionPolicy,native:readonly ExtraBridgeNativeFace[]){
  assert.ok(policy.axis.length>=2&&policy.axis.length<=512);assert.deepEqual([...policy.lateralOffsets],[-.15,0,.15]);assert.ok(policy.maximumTrackErrorMetres>0&&policy.maximumTrackErrorMetres<=.25);assert.ok(policy.bodyRadiusMetres>=CHARACTER.radius+.15+policy.maximumTrackErrorMetres&&policy.bodyRadiusMetres<=.8);
  assert.ok(input.cells.length>0&&input.cells.length<=64&&new Set(input.cells.map(c=>c.id)).size===input.cells.length);assert.ok(input.cells.reduce((n,c)=>n+c.bytes.byteLength,0)<=256*1024*1024);
  const bundles=new Map(input.cells.map(c=>[c.id,parseCollisionBundle(c.bytes)]));
  for(const face of native){const bundle=bundles.get(face.cell),collider=bundle?.colliders.find(c=>c.id===face.collider);assert.ok(bundle&&collider,'Lower qualification face has no actual motion collider');assert.equal(collider.group,face.group);assert.equal(bundle.header.surfaceTags[collider.triangleTags[face.triangle]!],face.tag);assert.deepEqual(face.points,[0,1,2].map(k=>Array.from(collider.positions.subarray(collider.indices[face.triangle*3+k]!*3,collider.indices[face.triangle*3+k]!*3+3))),'Lower floor differs from serialized motion world');}
  const faces=buildExtraBridgeDeck(input.profile).faces.filter(f=>f.collision!==false),upperFloors=faces.filter(f=>f.role==='road'||f.role==='footway').map(f=>f.points),upperBytes=encodeCollisionBundle({originId:input.gameplay.originId,frame:'X-east,Y-up,Z-south',cell:'prospective-bridge',surfaceTags:['authored-bridge']},[{id:'prospective-bridge',group:'props',ref:null,positions:Float32Array.from(faces.flatMap(f=>f.points.flat())),indices:Uint32Array.from({length:faces.length*3},(_,i)=>i),triangleTags:new Uint16Array(faces.length)}]);
  const points=policy.axis,gameplay={...input.gameplay,playArea:{minX:Math.min(...points.map(p=>p[0]))-10,maxX:Math.max(...points.map(p=>p[0]))+10,minZ:Math.min(...points.map(p=>p[1]))-10,maxZ:Math.max(...points.map(p=>p[1]))+10}};delete(gameplay as {supportedArea?:unknown}).supportedArea;
  await initPhysics();const world=StaticWorld.fromBytes(input.terrainBytes,input.roads,gameplay),runs=[];
  try{
    for(const cell of input.cells)world.addCell(cell.id,cell.bytes);world.addCell('prospective-bridge',upperBytes);world.physics.step();world.markStepped();
    const rotation={x:0,y:0,z:0,w:1},shape=new RAPIER.Capsule(FEET_TO_CENTRE-policy.bodyRadiusMetres,policy.bodyRadiusMetres),obstacle=(c:RAPIER.Collider)=>{const surface=world.surfaceAt(c.handle,null);return world.isStatic(c.handle)&&!['ground','kerbs','terrain'].includes(surface?.group??'');};
    for(const offset of policy.lateralOffsets)for(const reverse of[false,true]){
      const route=points.map(([x,z])=>[x,z+offset]as Point);if(reverse)route.reverse();const start=route[0]!,floor=world.groundBelow(start[0],100,start[1],200);assert.ok(floor&&floor.surface?.group!=='terrain','Motion fixture needs actual native external approach');
      const character=new Character(world,'bridge-motion-probe',[start[0],floor.y,start[1]],0,100),trace=[];let target=1,ticks=0,lastProgress=0,best=Infinity,maximumTrackError=0;
      try{
        while(target<route.length){assert.ok(ticks<6000&&ticks-lastProgress<=240,`Native passage movement blocked ${offset}/${reverse} at ${character.position.join(',')}`);const next=route[target]!,previous=route[target-1]!,p=character.position,dx=next[0]-p[0],dz=next[1]-p[2],length=Math.hypot(dx,dz);if(length<.06){target++;best=Infinity;lastProgress=ticks;continue;}if(length<best-.05){best=length;lastProgress=ticks;}
          const from={x:p[0],y:p[1]+FEET_TO_CENTRE,z:p[2]};character.move(world,dx/length*CHARACTER.walk,dz/length*CHARACTER.walk);world.physics.step();world.markStepped();ticks++;
          const q=character.position,track=distanceToSegment([q[0],q[2]],previous,next);maximumTrackError=Math.max(maximumTrackError,track);assert.ok(track<=policy.maximumTrackErrorMetres,`Native passage leaves its qualified source corridor ${offset}/${reverse}/${ticks}: ${track} at ${q.join(',')}`);
          const under=world.groundBelow(q[0],q[1]+.15,q[2],.65);assert.ok(under&&['ground','kerbs'].includes(under.surface?.group??''),'Native passage loses actual lower-floor support');
          const hit=world.physics.castShape(from,rotation,{x:q[0]-from.x,y:q[1]+FEET_TO_CENTRE-from.y,z:q[2]-from.z},shape,0,1,true,undefined,undefined,undefined,undefined,obstacle);assert.ok(!hit,'Complete passage capsule meets an actual static obstacle or upper bridge');
          trace.push({tick:ticks,position:[...q],groundHeight:under.y,groundSurface:under.surface,trackError:track});
        }
        runs.push({offsetZ:offset,reverse,ticks,maximumTrackError,continuousExpandedCapsuleSweeps:trace.length,trace});
      }finally{world.physics.removeCharacterController(character.controller);world.physics.removeRigidBody(character.body);world.physics.step();}
    }
  }finally{world.physics.free();}
  return{upperFloors,proof:{schemaVersion:1,status:'PASS_NATIVE_CHARACTER_TRANSITIONS_PENDING_FINAL_SERIALIZED_WORLD',terrainSha256:sourceSha256(input.terrainBytes),roadsSha256:sourceSha256(JSON.stringify(input.roads)),profileSha256:sourceSha256(JSON.stringify(input.profile)),upperCollisionSha256:sourceSha256(upperBytes),nativeCollision:input.cells.map(c=>({id:c.id,sha256:sourceSha256(c.bytes)})),policy,runs,limitation:'Static authoring fixtures with actual controller, no supported-area admission or dynamic actors. Final published-world physical/live gates remain required.'}};
}
