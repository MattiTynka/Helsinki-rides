import assert from 'node:assert/strict';
import {test} from 'node:test';
import pc from 'polygon-clipping';
import {Character,CHARACTER_SKIN,StaticWorld,initPhysics} from '../../../packages/sim/src/index.ts';
import {encodeCollisionBundle,encodeTerrain} from '../../../packages/world-schema/src/index.ts';
import {occupiedTargets,sweptBody} from '../lib/walk-pedestrian-detour.mjs';
import {runNativeRoute} from '../lib/walk-native-route.mjs';
const actor=(x,z)=>({id:'person',alive:true,inVehicle:null,position:[x,.03,z],health:100,yaw:0});
const state={tick:1,player:{position:[0,.03,0]},characters:[actor(0,.67)]};
const target=(z,extra={})=>({label:`target ${z}`,xz:[0,z],radius:.06,...extra});
test('only a wholly occupied arrival disk can be replaced; a reachable disk retains its exact target',()=>{
 const occupied=occupiedTargets(state,[target(.2),target(.8),target(2)]);assert.equal(occupied.replaced.length,2);assert.equal(occupied.replaceCount,3);assert.equal(occupied.rejoin.xz[1],2);
 const edge=occupiedTargets(state,[target(0),target(2)]);assert.equal(edge.replaced.length,0);assert.equal(edge.replaceCount,1);
 assert.equal(occupiedTargets(state,[target(.2,{capture:true}),target(2)]),null);
 assert.equal(occupiedTargets(state,Array.from({length:8},()=>target(.67))),null);
 assert.equal(occupiedTargets({...state,characters:[{...actor(0,.67),position:[0,5,.67]}]},[target(.2),target(2)]),null);
});
test('the source envelope covers the full .44m body, including endpoints and unsampled holes',()=>{
 const body=sweptBody([0,0],[2,0]);assert.equal(pc.difference(body,[[[-1,-1],[3,-1],[3,1],[-1,1],[-1,-1]]]).length,0);
 assert.ok(pc.intersection(body,[[[.99,-.01],[1.01,-.01],[1.01,.01],[.99,.01],[.99,-.01]]]).length);
 assert.ok(pc.difference(body,[[[0,-.4],[2,-.4],[2,.4],[0,.4],[0,-.4]]]).length);
});
test('continuous native movement exposes a live capsule blocker that static ground alone does not; a side path passes',async()=>{
 await initPhysics();const gameplay={playArea:{minX:-8,maxX:8,minZ:-8,maxZ:8}},roads={schemaVersion:2,nodes:[],lanes:[],connectors:[],parking:[],footways:[]};
 const world=StaticWorld.fromBytes(encodeTerrain({x0:-8,z0:-8,nx:3,nz:3,resolution:8,heights:new Float32Array(9).fill(-1)}),roads,gameplay);
 world.addCell('floor',encodeCollisionBundle({originId:'fixture',frame:'X-east,Y-up,Z-south',cell:'floor',surfaceTags:['paving']},[{id:'ground',group:'ground',ref:null,positions:Float32Array.from([-5,0,-5,-5,0,5,5,0,5,5,0,-5]),indices:Uint32Array.from([0,1,2,0,2,3]),triangleTags:new Uint16Array(2)}]));world.physics.step();world.markStepped();const scene={world,gameplay,identities:new Map()};
 try{assert.equal(runNativeRoute(scene,{start:[0,.03,0],targets:[[0,.2]]}).passed,true);
 const c=new Character(world,'blocker',[0,0,.67],0,100);scene.identities.set(c.collider.handle,{id:'blocker',group:'live-character'});world.physics.step();world.markStepped();
 const blocked=runNativeRoute(scene,{start:[0,.03,0],targets:[[0,.2]],maximumTicks:300});assert.equal(blocked.passed,false);assert.ok(blocked.trace.at(-1).contacts.some(c=>c.identity?.id==='blocker'));
 for(const cadence of[1,4,8])assert.equal(runNativeRoute(scene,{start:[0,.03,0],targets:[[.9,0],[.9,2],[0,2]],headingUpdateTicks:cadence}).passed,true);
 }finally{world.physics.free();}
});
