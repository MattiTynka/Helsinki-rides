// Offline replay of an observed parked-vehicle obstruction; no actor is moved or world payload changed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {gunzipSync} from 'node:zlib';
import {RAPIER} from '../../packages/sim/src/world.ts';
import {parseCollisionBundle, supportsSegment, type Vec2} from '../../packages/world-schema/src/index.ts';
import {vehicleCoverageFootprint} from '../../packages/sim/src/coverage-footprint.ts';
import {readSourceFile, sourceSha256, writeSourceJson} from './lib/source-files.ts';
const {values} = parseArgs({options: {world: {type: 'string'}, 'observation-world': {type: 'string'}, failure: {type: 'string'}, out: {type: 'string'}}}); assert.ok(values.world && values.failure && values.out && !fs.existsSync(values.out));
const failureBytes = fs.readFileSync(values.failure), result = JSON.parse(failureBytes.toString()), manifestBytes = fs.readFileSync(path.join(values.world, 'manifest.json')), manifest = JSON.parse(manifestBytes.toString()); const observationRoot=values['observation-world']??values.world, observationManifestBytes=fs.readFileSync(path.join(observationRoot,'manifest.json')),observationManifest=JSON.parse(observationManifestBytes.toString());assert.equal(sourceSha256(observationManifestBytes),result.manifestSha256);const candidateManifestSha256=sourceSha256(manifestBytes);
const gameplay = JSON.parse(readSourceFile(values.world, manifest.gameplay).toString()), player = result.failureView.state.player, vehicle = result.failureView.state.vehicles.find((v: any) => v.id === player.nearVehicle); assert.ok(vehicle);
const definition = gameplay.vehicleDefinitions.find((d: any) => d.id === vehicle.definition), footprint = vehicleCoverageFootprint(definition, vehicle), minX = Math.min(...footprint.map(p => p[0])), maxX = Math.max(...footprint.map(p => p[0])), minZ = Math.min(...footprint.map(p => p[1])), maxZ = Math.max(...footprint.map(p => p[1]));
const originalLeg: Vec2[] = [[-165.043,125.222],[-164.348,139.295]], detour: Vec2[] = [originalLeg[0]!, [minX-.8,minZ-1.2], [minX-.8,maxZ+1.2], originalLeg[1]!];
assert.ok(Math.hypot(player.position[0]+164.8973,player.position[2]-128.3988)<.1,'This diagnostic is bound to the observed node7669521814 obstruction');
await RAPIER.init(); const physics = new RAPIER.World({x:0,y:-9.81,z:0}), surfaces = new Map<number, {group:string; tags:readonly string[]; triangleTags:Uint16Array; id:string}>(), pins=[];
for (const cell of manifest.cells) {
  const b=cell.collision.boundsXZ??cell.boundsXZ;if(b[0]>-155||b[2]<-175||b[1]>145||b[3]<120)continue;
  const stored=readSourceFile(values.world,cell.collision),decoded=cell.collision.compression==='gzip'?gunzipSync(stored):stored;if(cell.collision.decodedSha256)assert.equal(sourceSha256(decoded),cell.collision.decodedSha256);
  const originalCell=observationManifest.cells.find((c:any)=>c.id===cell.id);assert.ok(originalCell);assert.equal(cell.collision.sha256,originalCell.collision.sha256,'Detour authority collision changed since captured obstruction');pins.push({id:cell.id,storedSha256:cell.collision.sha256,decodedSha256:sourceSha256(decoded)});const bundle=parseCollisionBundle(new Uint8Array(decoded));
  for(const collider of bundle.colliders){const desc=RAPIER.ColliderDesc.trimesh(collider.positions,collider.indices,collider.group==='ground'?RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES:undefined);const c=physics.createCollider(desc);surfaces.set(c.handle,{group:collider.group,tags:bundle.header.surfaceTags,triangleTags:collider.triangleTags,id:collider.id});}
}
physics.step(); const shape=new RAPIER.Capsule(.58,.38), identity={x:0,y:0,z:0,w:1};
function segmentDistance(p:Vec2,a:Vec2,b:Vec2){const dx=b[0]-a[0],dz=b[1]-a[1],t=Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dz)/(dx*dx+dz*dz)));return Math.hypot(p[0]-a[0]-t*dx,p[1]-a[1]-t*dz);}
const diagnostics=[];
const eastDetour: Vec2[] = [originalLeg[0]!, [maxX+.8,minZ-1.2], [maxX+.8,maxZ+1.2], originalLeg[1]!];
for(const [name,points]of [['original',originalLeg],['west-detour',detour],['east-detour',eastDetour]]as const){const failures=[],samples=[];let minimumCarEdgeDistance=Infinity;const clearanceRadius=name==='original'?.38:.56,routeShape=new RAPIER.Capsule(.58,clearanceRadius);let previous:{x:number;z:number;floor:number}|undefined;
  for(let i=1;i<points.length;i++){const a=points[i-1]!,b=points[i]!,steps=Math.ceil(Math.hypot(b[0]-a[0],b[1]-a[1])/.1);assert.ok(supportsSegment(gameplay,a,b,clearanceRadius));
    for(let j=0;j<=steps;j++){const t=j/steps,x=a[0]+(b[0]-a[0])*t,z=a[1]+(b[1]-a[1])*t,p:[number,number]=[x,z],groundHeights=[];
      const carDistance=Math.min(...footprint.map((v,k)=>segmentDistance(p,v,footprint[(k+1)%footprint.length]!)));minimumCarEdgeDistance=Math.min(minimumCarEdgeDistance,carDistance);
      // Every capsule cross-section point has real authored hard ground, not fallback terrain.
      for(const [dx,dz]of [[0,0],...Array.from({length:16},(_,k)=>[Math.cos(k*Math.PI/8)*clearanceRadius,Math.sin(k*Math.PI/8)*clearanceRadius])]){
        const ray=new RAPIER.Ray({x:x+dx!,y:player.position[1]+2,z:z+dz!},{x:0,y:-1,z:0}),hit=physics.castRayAndGetNormal(ray,4,false,undefined,undefined,undefined,undefined,c=>surfaces.get(c.handle)?.group==='ground');
        if(!hit){failures.push({x,z,reason:'missing authored ground'});continue;}groundHeights.push(player.position[1]+2-hit.timeOfImpact);
      }
      const floor=Math.max(...groundHeights);const overlap=physics.intersectionWithShape({x,y:floor+.9+.06,z},identity,routeShape,undefined,undefined,undefined,undefined,c=>surfaces.get(c.handle)?.group!=='ground');
      if(overlap)failures.push({x,z,reason:'static capsule overlap',collider:surfaces.get(overlap.handle)?.id});if(Math.max(...groundHeights)-Math.min(...groundHeights)>.2)failures.push({x,z,reason:'cross-section ground range exceeds .20m'});
      if(previous){const hit=physics.castShape({x:previous.x,y:previous.floor+.9+.06,z:previous.z},identity,{x:x-previous.x,y:floor-previous.floor,z:z-previous.z},routeShape,0,1,true,undefined,undefined,undefined,undefined,c=>surfaces.get(c.handle)?.group!=='ground');if(hit)failures.push({x,z,reason:'continuous static capsule sweep overlap',collider:surfaces.get(hit.collider.handle)?.id});}previous={x,z,floor};samples.push({x,z,floor,carDistance});
    }
  }
  diagnostics.push({name,points,samples:samples.length,failures,minimumCarEdgeDistance,carClearanceRequired:clearanceRadius,walkingCapsuleRadius:.38,waypointArrivalAllowance:clearanceRadius-.38,continuousStaticSweeps:true,groundSamples:samples});
}
physics.free();fs.mkdirSync(values.out,{recursive:true});const ref=writeSourceJson(values.out,'vehicle-obstruction-diagnostic.json',{schemaVersion:1,status:'OBSERVED_DYNAMIC_OBSTRUCTION_OFFLINE_DETOUR_CANDIDATE_REAL_KEYS_PENDING',manifestSha256:candidateManifestSha256,observationManifestSha256:result.manifestSha256,failureSha256:sourceSha256(failureBytes),vehicle:{id:vehicle.id,definition:vehicle.definition,position:vehicle.position,rotation:vehicle.rotation,footprint},collisionPins:pins,sourceLeg:{wayId:28636497,fromNode:7669521812,toNode:7669521814},diagnostics});console.log(JSON.stringify({file:path.resolve(values.out,ref.path),sha256:ref.sha256,diagnostics:diagnostics.map(d=>({name:d.name,points:d.points,samples:d.samples,failures:d.failures.length,minimumCarEdgeDistance:d.minimumCarEdgeDistance}))}));

