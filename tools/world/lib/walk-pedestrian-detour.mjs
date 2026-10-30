// Verification-only detours around observed people; never moves application actors.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import polygonClipping from 'polygon-clipping';
import {Character,CHARACTER,CHARACTER_SKIN} from '../../../packages/sim/src/index.ts';
import {vehicleCoverageFootprint} from '../../../packages/sim/src/coverage-footprint.ts';
import {openStaticWalkScene} from './walk-static-scene.mjs';
import {runNativeRoute} from './walk-native-route.mjs';
import {sourceSha256} from './source-files.ts';
import {bindDeliveryProducer,verifyDeliveryProducer,publicDeliveryProducer} from './delivery-city-provenance.ts';

export const DETOUR_POLICY={schemaVersion:1,radiusMetres:.44,arrivalRadiusMetres:.06,maximumOffsetMetres:2,maximumExtentMetres:8,maximumReplacedWaypoints:6,maximumDetours:12};
const pointSegmentDistance=(p,a,b)=>{const dx=b[0]-a[0],dz=b[1]-a[1],d=dx*dx+dz*dz,t=d?Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dz)/d)):0;return Math.hypot(p[0]-a[0]-t*dx,p[1]-a[1]-t*dz);};
const cross=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
const intersects=(a,b,c,d)=>cross(a,b,c)*cross(a,b,d)<=0&&cross(c,d,a)*cross(c,d,b)<=0&&Math.max(Math.min(a[0],b[0]),Math.min(c[0],d[0]))<=Math.min(Math.max(a[0],b[0]),Math.max(c[0],d[0]))&&Math.max(Math.min(a[1],b[1]),Math.min(c[1],d[1]))<=Math.min(Math.max(a[1],b[1]),Math.max(c[1],d[1]));
const segmentDistance=(a,b,c,d)=>intersects(a,b,c,d)?0:Math.min(pointSegmentDistance(a,c,d),pointSegmentDistance(b,c,d),pointSegmentDistance(c,a,b),pointSegmentDistance(d,a,b));
const inside=(p,ring)=>{let yes=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){const a=ring[i],b=ring[j];if((a[1]>p[1])!==(b[1]>p[1])&&p[0]<(b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0])yes=!yes;}return yes;};
const ring=p=>[[...p,p[0]]];
const disk=(p,r)=>ring(Array.from({length:16},(_,i)=>[p[0]+Math.cos(i*Math.PI/8)*r/Math.cos(Math.PI/16),p[1]+Math.sin(i*Math.PI/8)*r/Math.cos(Math.PI/16)]));
export function sweptBody(a,b,r=.44){const l=Math.hypot(b[0]-a[0],b[1]-a[1]);if(!l)return[disk(a,r)];const x=-(b[1]-a[1])*r/l,z=(b[0]-a[0])*r/l;return polygonClipping.union(disk(a,r),disk(b,r),ring([[a[0]+x,a[1]+z],[b[0]+x,b[1]+z],[b[0]-x,b[1]-z],[a[0]-x,a[1]-z]]));}
export function occupiedTargets(state,waypoints){
 const p=state.player.position,actors=state.characters.filter(c=>c.alive&&!c.inVehicle&&Math.abs(c.position[1]-p[1])<CHARACTER.height&&Math.hypot(c.position[0]-p[0],c.position[2]-p[2])<=10);
 const occupants=point=>actors.filter(c=>Math.abs(c.position[1]-p[1])<=2*CHARACTER.halfHeight&&Math.hypot(c.position[0]-point.xz[0],c.position[2]-point.xz[1])<2*CHARACTER.radius+CHARACTER_SKIN-DETOUR_POLICY.arrivalRadiusMetres);
 let count=0;const replaced=[];while(count<waypoints.length&&count<DETOUR_POLICY.maximumReplacedWaypoints){const w=waypoints[count],hits=occupants(w);if(!hits.length)break;if(w.capture)return null;replaced.push({label:w.label,xz:w.xz,originalSource:w.source,actors:hits.map(c=>({id:c.id,position:c.position,distance:Math.hypot(c.position[0]-w.xz[0],c.position[2]-w.xz[1])})),reason:'Entire 0.06m arrival disk overlaps a captured live character capsule including controller skin'});count++;}
 const rejoin=waypoints[count];if(!rejoin||occupants(rejoin).length||rejoin.radius!==.06||Math.hypot(rejoin.xz[0]-p[0],rejoin.xz[1]-p[2])>DETOUR_POLICY.maximumExtentMetres)return null;
 const blockers=actors.filter(c=>pointSegmentDistance([c.position[0],c.position[2]],[p[0],p[2]],rejoin.xz)<.85);if(!blockers.length)return null;
 return{actors,blockers,replaced,replaceCount:count+1,rejoin};
}
function readPin(ref){assert.ok(ref&&typeof ref.file==='string'&&/^[a-f0-9]{64}$/.test(ref.sha256));const bytes=fs.readFileSync(ref.file);assert.equal(sourceSha256(bytes),ref.sha256,`Detour input changed: ${ref.file}`);return JSON.parse(bytes);}
export async function openPedestrianDetours(worldRoot,config){
 const producerBindings=['./walk-pedestrian-detour.mjs','./walk-native-route.mjs','./walk-static-scene.mjs','./source-files.ts','./delivery-city-provenance.ts','../../verify/lib/simulation-payload.ts','../../../packages/sim/src/index.ts','../../../packages/sim/src/coverage-footprint.ts','../../../packages/world-schema/src/index.ts'].map(p=>bindDeliveryProducer(new URL(p,import.meta.url)));
 assert.deepEqual(config.policy,DETOUR_POLICY,'Unreviewed pedestrian detour policy');
 const staticProof=readPin(config.staticRouteQualification);const scene=await openStaticWalkScene(worldRoot,.44,.15);
 assert.equal(sourceSha256(fs.readFileSync(worldRoot+'/manifest.json')),config.manifestSha256);
 assert.equal(staticProof.manifestSha256,config.manifestSha256);assert.equal(staticProof.minimumVehicleHullSeparationMetres,.8);
 const osm=readPin(config.osm),roadMerge=readPin(config.roadMerge);assert.equal(roadMerge.status,'PASS_SOURCE_QUALIFIED_ROAD_MERGE_PENDING_RUNTIME');assert.equal(roadMerge.osmSha256,config.osm.sha256);assert.ok(config.streetParts.some(r=>r.sha256===roadMerge.streetPartsSha256));
 const exceptions=config.walkingExceptions.map(({wayId})=>{const way=osm.elements.find(x=>x.type==='way'&&x.id===wayId),audit=roadMerge.walking.newAudits.find(x=>x.id===`w${wayId}`);assert.equal(way?.tags?.highway,'footway');assert.ok(!['no','private'].includes(way.tags.foot??way.tags.access));assert.ok(!way.tags.bridge&&!way.tags.tunnel&&(!way.tags.layer||way.tags.layer==='0'));assert.ok(audit&&!audit.retained&&audit.admission.closedIntervals.length===0&&audit.physical.sourcePartIds.length);assert.equal(sourceSha256(JSON.stringify(way)),audit.physical.sourceWaySha256);return{wayId,partIds:audit.physical.sourcePartIds.map(Number),sourceWaySha256:audit.physical.sourceWaySha256};});
 const features=config.streetParts.flatMap(ref=>readPin(ref).features.filter(f=>f.properties.aluetieto==='Katu'&&((f.properties.paatyyppi==='Kevyt liikenne'&&/Jalankulku|Jalkak|Yhdistetty/.test(f.properties.alatyyppi))||(ref.sha256===roadMerge.streetPartsSha256&&exceptions.some(e=>e.partIds.includes(f.properties.osan_id))))).map(f=>{const geometry=(f.geometry.type==='Polygon'?[f.geometry.coordinates]:f.geometry.coordinates).map(p=>p.map(r=>r.map(v=>[v[0]-25497350,6672960-v[1]]))),flat=geometry.flat(2);return{id:f.properties.osan_id,exception:exceptions.find(e=>e.partIds.includes(f.properties.osan_id)),file:ref.file,sha256:ref.sha256,geometry,bounds:[Math.min(...flat.map(v=>v[0])),Math.min(...flat.map(v=>v[1])),Math.max(...flat.map(v=>v[0])),Math.max(...flat.map(v=>v[1]))]};}));
 const parkedVehicles=staticProof.vehicles;
 async function plan(state,waypoints){
  const disposition=occupiedTargets(state,waypoints);if(!disposition)return null;
  const currentVehicles=(state.vehicles??[]).map(v=>{const d=scene.gameplay.vehicleDefinitions.find(d=>d.id===v.definition);assert.ok(d);return{id:v.id,footprint:vehicleCoverageFootprint(d,v),position:v.position,rotation:v.rotation,definition:v.definition};}),vehicles=[...parkedVehicles,...currentVehicles];
  const {actors,replaced,replaceCount,rejoin}=disposition,p=state.player.position,start=[p[0],p[2]],end=rejoin.xz,l=Math.hypot(end[0]-start[0],end[1]-start[1]);if(l<.01)return null;
  const nx=-(end[1]-start[1])/l,nz=(end[0]-start[0])/l,rect=[Math.min(start[0],end[0])-3,Math.min(start[1],end[1])-3,Math.max(start[0],end[0])+3,Math.max(start[1],end[1])+3],local=features.filter(f=>(!f.exception||waypoints.slice(0,replaceCount).every(w=>w.source?.wayId===f.exception.wayId))&&f.bounds[0]<=rect[2]&&f.bounds[2]>=rect[0]&&f.bounds[1]<=rect[3]&&f.bounds[3]>=rect[1]);if(!local.length)return null;
  const domain=polygonClipping.union(local[0].geometry,...local.slice(1).map(f=>f.geometry));
  await scene.resident([rect[0],rect[1]],[rect[2],rect[3]]);
  // Keep the cylinder-overlap proof valid on the target's native floor, not only
  // the current player's height (a person on another level is not an obstruction).
  for(const point of replaced){const floor=scene.at(...point.xz);if(floor.error||!point.actors.some(a=>Math.abs(a.position[1]-(floor.floor+CHARACTER_SKIN))+.45<=2*CHARACTER.halfHeight))return null;}
  const captured=actors.map(a=>{const c=new Character(scene.world,a.id,[a.position[0],a.position[1]-CHARACTER_SKIN,a.position[2]],a.yaw,a.health);scene.identities.set(c.collider.handle,{id:a.id,group:'captured-live-character'});return c;});scene.world.physics.step();scene.world.markStepped();
  const failures=[];
  try{for(const offset of[.85,-.85,1.1,-1.1,1.4,-1.4,1.7,-1.7,2,-2]){
   const targets=[[Math.fround(start[0]+nx*offset),Math.fround(start[1]+nz*offset)],[Math.fround(end[0]+nx*offset),Math.fround(end[1]+nz*offset)],end],segments=[];let a=start,valid=true;
   for(const b of targets){const sourceGap=polygonClipping.difference(sweptBody(a,b),domain);if(sourceGap.length){failures.push({offset,reason:'outside source walking pavement',from:a,to:b,sourceGap});valid=false;break;}const blockedVehicle=vehicles.find(v=>inside(a,v.footprint)||inside(b,v.footprint)||v.footprint.some((c,i)=>segmentDistance(a,b,c,v.footprint[(i+1)%v.footprint.length])<=.8));if(blockedVehicle){failures.push({offset,reason:'parking envelope',id:blockedVehicle.id});valid=false;break;}const f=[...scene.check(a,b).failures,...scene.check(b,a).failures];if(f.length){failures.push({offset,reason:'native static capsule',detail:f[0]});valid=false;break;}segments.push({from:a,to:b});a=b;}
   if(!valid)continue;
   const motions=[];for(const headingUpdateTicks of[1,4,8]){const r=runNativeRoute(scene,{start:p,targets,headingUpdateTicks,maximumTicks:1500});motions.push({headingUpdateTicks,passed:r.passed,ticks:r.ticks,lastPosition:r.lastPosition,remaining:r.remaining});if(!r.passed){valid=false;failures.push({offset,reason:'actual continuous Character blocked',motion:motions.at(-1)});break;}}
   if(!valid)continue;
   return{schemaVersion:1,status:'SOURCE_STATIC_PARKING_AND_CAPTURED_CHARACTER_DETOUR_QUALIFIED_REAL_KEYBOARD_PENDING',manifestSha256:config.manifestSha256,sourcePins:config.streetParts,osmPin:config.osm,roadMergePin:config.roadMerge,walkingExceptions:[...new Map(local.filter(f=>f.exception).map(f=>[f.exception.wayId,f.exception])).values()],sourcePartIds:[...new Set(local.map(f=>f.id))],capturedTick:state.tick,capturedPlayer:state.player,capturedActors:actors,capturedVehicles:currentVehicles.filter(v=>v.footprint.some(p=>p[0]>=rect[0]&&p[0]<=rect[2]&&p[1]>=rect[1]&&p[1]<=rect[3])),replaced,replaceCount,offsetMetres:offset,segments,motions,collisionPins:scene.stats().collisionPins,previousCandidateFailures:failures,waypoints:[...targets.slice(0,-1).map((xz,i)=>({label:`Pedestrian bypass ${state.tick} bend ${i+1}`,xz,radius:.06,source:{kind:'qualified-live-pedestrian-detour',originalTarget:waypoints[0].label}})),rejoin],limitations:['Captured actors may move after qualification; stalled live travel must requalify from a fresh observation.','No world mutation, controller tolerance change, arrival-radius change or scripted simulation step is permitted.']};
  }return{status:'NO_QUALIFIED_DETOUR',failures};}
  finally{for(const c of captured){scene.identities.delete(c.collider.handle);scene.world.physics.removeCharacterController(c.controller);scene.world.physics.removeRigidBody(c.body);}scene.world.physics.step();scene.world.markStepped();}
 }
 return{plan,producerClosure:producerBindings.map(publicDeliveryProducer),verify:()=>producerBindings.forEach(verifyDeliveryProducer),close:scene.close};
}
