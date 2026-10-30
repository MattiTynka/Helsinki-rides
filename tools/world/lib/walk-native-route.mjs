import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {Character,CHARACTER,CHARACTER_SKIN,initPhysics,StaticWorld} from '../../../packages/sim/src/index.ts';
import {supportedMotionFraction} from '../../../packages/world-schema/src/index.ts';
import {readSimulationPayload,readRoadGraph} from '../../verify/lib/simulation-payload.ts';
import {sourceSha256} from './source-files.ts';
export async function openNativeRouteWorld(root,bounds){
 const mb=fs.readFileSync(path.join(root,'manifest.json')),manifest=JSON.parse(mb),gameplay=JSON.parse(fs.readFileSync(path.join(root,manifest.gameplay.path)));assert.equal(sourceSha256(fs.readFileSync(path.join(root,manifest.gameplay.path))),manifest.gameplay.sha256);
 await initPhysics();const world=StaticWorld.fromBytes(await readSimulationPayload(root,manifest.terrain),await readRoadGraph(root,manifest.roads),gameplay),identities=new Map(),pins=[];
 for(const cell of manifest.cells){const q=cell.collision.boundsXZ??cell.boundsXZ;if(q[0]>bounds[2]||q[2]<bounds[0]||q[1]>bounds[3]||q[3]<bounds[1])continue;const bytes=await readSimulationPayload(root,cell.collision),bundle=world.addCell(cell.id,bytes),handles=world.cellColliders.get(cell.id);let i=0;for(const c of bundle.colliders)if(c.indices.length)identities.set(handles[i++],{cell:cell.id,id:c.id,group:c.group,ref:c.ref});pins.push({cell:cell.id,storedSha256:cell.collision.sha256,decodedSha256:sourceSha256(bytes)});}
 world.physics.step();world.markStepped();return{world,gameplay,manifest,manifestSha256:sourceSha256(mb),identities,pins,close:()=>world.physics.free()};
}
/** Continuous actual Character, including gravity/ground state, without resetting
 * onto the highest footprint support between steps. Fixture setup is not travel. */
export function runNativeRoute(scene,{start,targets,headingUpdateTicks=1,maximumTicks=6000,arrivalRadius=.06}){
 assert.ok(Number.isInteger(headingUpdateTicks)&&headingUpdateTicks>=1&&headingUpdateTicks<=30);assert.equal(arrivalRadius,.06);const{world}=scene,c=new Character(world,'native-route-probe',[start[0],start[1]-CHARACTER_SKIN,start[2]],0,100),trace=[];let index=0,ticks=0,lastProgress=0,best=Infinity,vx=0,vz=0;
 try{while(index<targets.length&&ticks<maximumTicks&&ticks-lastProgress<=240){const target=targets[index],p=c.position,dx=target[0]-p[0],dz=target[1]-p[2],distance=Math.hypot(dx,dz);if(distance<=arrivalRadius){index++;best=Infinity;lastProgress=ticks;continue;}if(distance<best-.01){best=distance;lastProgress=ticks;}if(ticks%headingUpdateTicks===0||!ticks){const speed=distance>3?CHARACTER.sprint:distance>1?CHARACTER.run:CHARACTER.walk;vx=dx/distance*speed;vz=dz/distance*speed;}
   const speed=Math.hypot(vx,vz),yaw=Math.round(Math.atan2(vx,vz)*10000)/10000,qx=Math.sin(yaw)*speed,qz=Math.cos(yaw)*speed;
   const requested=supportedMotionFraction(scene.gameplay,[p[0],p[2]],[p[0]+qx/60,p[2]+qz/60],CHARACTER.radius+.02);c.move(world,qx,qz);world.physics.step();world.markStepped();const contacts=[];for(let i=0;i<c.controller.numComputedCollisions();i++){const hit=c.controller.computedCollision(i);if(hit)contacts.push({identity:scene.identities.get(hit.collider.handle),surface:world.surfaceAt(hit.collider.handle,hit.featureId??null),normal:hit.normal1,point:hit.witness1});}
   ticks++;trace.push({tick:ticks,target:index,position:[...c.position],grounded:c.grounded,verticalSpeed:c.verticalSpeed,speed:c.speed,requestedFraction:requested,contacts});
  }
  return{passed:index===targets.length,reached:index,targets:targets.length,ticks,headingUpdateTicks,lastPosition:[...c.position],remaining:index<targets.length?Math.hypot(targets[index][0]-c.position[0],targets[index][1]-c.position[2]):0,trace};
 }finally{world.physics.removeCharacterController(c.controller);world.physics.removeRigidBody(c.body);world.physics.step();world.markStepped();}
}
