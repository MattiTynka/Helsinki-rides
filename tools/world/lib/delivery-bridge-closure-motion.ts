import assert from 'node:assert/strict';
import {Character,CHARACTER,initPhysics,StaticWorld} from '../../../packages/sim/src/index.ts';
import {encodeCollisionBundle,parseCollisionBundle} from '../../../packages/world-schema/src/index.ts';
import {buildExtraBridgeDeck,type ExtraBridgeFace} from './delivery-extra-bridges-mesh.ts';
import {extraBridgeLocal,extraBridgeWorld,type ExtraBridgeFrame,type ExtraBridgeNativeFace} from './delivery-extra-bridges-source.ts';
import type {NativeBridgeMotionInput} from './delivery-bridge-native-motion.ts';
import {sourceSha256} from './source-files.ts';
import {layeredFloorSampler} from './layered-bridge-field.ts';
type Pair=[number,number];
export interface ClosureMotionPolicy {
  frame:ExtraBridgeFrame;gateStations:readonly[number,number];
  /** Complete source width, inset by the actual body plus skin. */
  acrossCoordinates:readonly number[];
  upperAxes:readonly {id:string;points:readonly Pair[]}[];
}
/** Prospective physical fixtures. Starting poses are explicit fixtures, never
 * claimed as real-world journey or spawned-player acceptance. */
export async function qualifyLowerClosureMotion(input:NativeBridgeMotionInput,closure:readonly ExtraBridgeFace[],native:readonly ExtraBridgeNativeFace[],policy:ClosureMotionPolicy){
 assert.ok(input.cells.length>0&&input.cells.length<=64&&closure.length>0&&closure.length<10000);assert.ok(policy.acrossCoordinates.length>=3&&policy.acrossCoordinates.length<=32);assert.ok(policy.upperAxes.length>=3&&policy.upperAxes.length<=8);
 const bundles=new Map(input.cells.map(c=>[c.id,parseCollisionBundle(c.bytes)]));for(const face of native){const bundle=bundles.get(face.cell),c=bundle?.colliders.find(c=>c.id===face.collider);assert.ok(c&&bundle);assert.equal(c.group,face.group);assert.equal(bundle.header.surfaceTags[c.triangleTags[face.triangle]!],face.tag);assert.deepEqual(face.points,[0,1,2].map(k=>Array.from(c.positions.subarray(c.indices[face.triangle*3+k]!*3,c.indices[face.triangle*3+k]!*3+3))),'Native closure support differs from serialized input');}
 const upper=buildExtraBridgeDeck(input.profile).faces.filter(f=>f.collision!==false),faces=[...upper,...closure],bytes=encodeCollisionBundle({originId:input.gameplay.originId,frame:'X-east,Y-up,Z-south',cell:'prospective-bridge-with-closure',surfaceTags:['authored-bridge']},[{id:'prospective-bridge-with-closure',group:'props',ref:null,positions:Float32Array.from(faces.flatMap(f=>f.points.flat())),indices:Uint32Array.from({length:faces.length*3},(_,i)=>i),triangleTags:new Uint16Array(faces.length)}]);
 const upperHeight=layeredFloorSampler(upper.filter(f=>f.role==='road'||f.role==='footway').map(f=>f.points)),all=faces.flatMap(f=>f.points),gameplay={...input.gameplay,playArea:{minX:Math.min(...all.map(p=>p[0]))-20,maxX:Math.max(...all.map(p=>p[0]))+20,minZ:Math.min(...all.map(p=>p[2]))-20,maxZ:Math.max(...all.map(p=>p[2]))+20}};delete(gameplay as {supportedArea?:unknown}).supportedArea;
 await initPhysics();const world=StaticWorld.fromBytes(input.terrainBytes,input.roads,gameplay),lowerRuns=[],upperRuns=[];
 const reset=()=>{world.physics.step();world.markStepped();};
 const character=(start:Pair,id:string)=>{const floor=world.groundBelow(start[0],100,start[1],200);assert.ok(floor&&floor.surface?.group!=='terrain','Fixture needs actual native or authored support');return new Character(world,id,[start[0],floor.y,start[1]],0,100);};
 try{
  for(const c of input.cells)world.addCell(c.id,c.bytes);world.addCell('prospective-bridge-with-closure',bytes);reset();
  for(const[side,station]of policy.gateStations.entries())for(const across of policy.acrossCoordinates)for(const jump of['none','normal','super']as const){
   const sign=side===0?1:-1,start=extraBridgeWorld(policy.frame,station-sign*2,across),target=extraBridgeWorld(policy.frame,station+sign*2,across),c=character(start,`lower-${side}-${across}-${jump}`);let maximumPastGate=-Infinity,maximumPastGateBelowUpperFloor=-Infinity,upperTransferTicks=0,minimumDistance=Infinity,highestFeet=-Infinity;const trace=[];
   try{for(let tick=0;tick<360;tick++){if(jump!=='none'&&(tick%90===30||jump==='super'&&tick%90===33))c.requestJump();const p=c.position,dx=target[0]-p[0],dz=target[1]-p[2],d=Math.hypot(dx,dz);c.move(world,dx/Math.max(d,1e-9)*CHARACTER.run,dz/Math.max(d,1e-9)*CHARACTER.run);reset();const q=c.position,st=extraBridgeLocal(policy.frame,[q[0],q[2]]),past=(st[0]-station)*sign,top=upperHeight(q[0],q[2]),upperTransfer=Number.isFinite(top)&&q[1]>=top-.05;maximumPastGate=Math.max(maximumPastGate,past);if(upperTransfer&&past>0)upperTransferTicks++;else maximumPastGateBelowUpperFloor=Math.max(maximumPastGateBelowUpperFloor,past);minimumDistance=Math.min(minimumDistance,Math.hypot(target[0]-q[0],target[1]-q[2]));highestFeet=Math.max(highestFeet,q[1]);trace.push({tick,position:[...q],phase:c.jumpPhase,upperTransfer});}
    assert.ok(maximumPastGateBelowUpperFloor<=.05,`Lower closure bypassed below upper floor ${side}/${across}/${jump}: ${maximumPastGateBelowUpperFloor}`);lowerRuns.push({side,station,across,jump,maximumPastGate,maximumPastGateBelowUpperFloor,upperTransferTicks,minimumTargetDistance:minimumDistance,highestFeet,trace});
   }finally{world.physics.removeCharacterController(c.controller);world.physics.removeRigidBody(c.body);reset();}
  }
  for(const axis of policy.upperAxes)for(const reverse of[false,true]){const points=axis.points.map(p=>[...p]as Pair);if(reverse)points.reverse();assert.ok(points.length>=2);const c=character(points[0]!,`upper-${axis.id}-${reverse}`);let target=1,ticks=0,best=Infinity,progress=0;const trace=[];
   try{while(target<points.length){assert.ok(ticks<6000&&ticks-progress<=240,`Upper bridge route blocked ${axis.id}/${reverse}: ${c.position.join(',')}`);const p=c.position,q=points[target]!,dx=q[0]-p[0],dz=q[1]-p[2],d=Math.hypot(dx,dz);if(d<.06){target++;best=Infinity;progress=ticks;continue;}if(d<best-.05){best=d;progress=ticks;}c.move(world,dx/d*CHARACTER.walk,dz/d*CHARACTER.walk);reset();ticks++;trace.push({tick:ticks,position:[...c.position]});}upperRuns.push({id:axis.id,reverse,ticks,trace});
   }finally{world.physics.removeCharacterController(c.controller);world.physics.removeRigidBody(c.body);reset();}
  }
 }finally{world.physics.free();}
 return{status:'PROSPECTIVE_CLOSURE_AND_UPPER_NATIVE_MOTION_PASS_FINAL_WORLD_PENDING',policy,nativeCollision:input.cells.map(c=>({id:c.id,sha256:sourceSha256(c.bytes)})),terrainSha256:sourceSha256(input.terrainBytes),roadsSha256:sourceSha256(JSON.stringify(input.roads)),profileSha256:sourceSha256(JSON.stringify(input.profile)),closureSha256:sourceSha256(JSON.stringify(closure)),prospectiveCollisionSha256:sourceSha256(bytes),lowerRuns,upperRuns,limitations:['Explicit fixtures; no supported-area admission, dynamic actors or real keyboard journey.','Lower approach attempts cover the declared source path width and normal/super jumps; final serialized side-boundary and route-graph gates remain required.']};
}
