import {openStaticWalkScene} from './lib/walk-static-scene.mjs';
// Diagnostic only: actual StaticWorld HCOL, immutable world, complete route capsule sweeps.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {initPhysics, StaticWorld, RAPIER, CHARACTER, FEET_TO_CENTRE, CHARACTER_SKIN} from '../../packages/sim/src/index.ts';
import {groups, GROUP} from '../../packages/sim/src/world.ts';
import {supportsSegment} from '../../packages/world-schema/src/index.ts';
import {readSimulationPayload, readRoadGraph} from '../verify/lib/simulation-payload.ts';
import {readSourceFile, sourceSha256, writeSourceJson} from './lib/source-files.ts';
const {values}=parseArgs({options:{world:{type:'string'},plan:{type:'string'},out:{type:'string'},'arrival-radius':{type:'string',default:'.12'},'sample-metres':{type:'string',default:'.2'}}});
assert.ok(values.world&&values.plan&&values.out&&!fs.existsSync(values.out),'Fresh output required');
const read=file=>{const bytes=fs.readFileSync(file);return {file,sha256:sourceSha256(bytes),value:JSON.parse(bytes)};};
const manifest=read(path.join(values.world,'manifest.json')),plan=read(values.plan),gameplay=JSON.parse(readSourceFile(values.world,manifest.value.gameplay));
const radius=.38+Number(values['arrival-radius']),spacing=Number(values['sample-metres']);assert.ok(radius>=.38&&radius<=.8&&spacing>0&&spacing<=.25);
const scene=await openStaticWalkScene(values.world,radius,spacing),{world,resident,check}=scene;
const segments=[];for(const route of plan.value.routes){let previous={label:'Actual native player spawn',xz:gameplay.player.spawn.position,source:{kind:'accepted-player-spawn'}};for(let i=0;i<route.waypoints.length;i++){const point=route.waypoints[i];await resident(previous.xz,point.xz);const result=check(previous.xz,point.xz);segments.push({route:route.id,index:i,from:previous,to:point,...result});if(i%40===0)console.log(JSON.stringify({index:i,blocked:segments.filter(s=>s.failures.length).length,samples:scene.stats().samples,peakRss:scene.stats().peakRss}));previous=point;}}
const summary={schemaVersion:1,status:segments.some(s=>s.failures.length)?'STATIC_ROUTE_OBSTRUCTIONS_FOUND':'STATIC_ROUTE_SWEEPS_PASS_REAL_KEYBOARD_PENDING',manifestSha256:manifest.sha256,planSha256:plan.sha256,producerSha256:sourceSha256(fs.readFileSync(new URL(import.meta.url))),arrivalAllowance:radius-.38,capsuleRadius:radius,capsuleHalfHeight:FEET_TO_CENTRE-radius,...scene.stats(),segments,limitations:['Static snapshot only; captured and future dynamic vehicle positions require separate hull checks and real keyboard validation.','Hard native floor is sampled every <=0.2 m at centre and 12 perimeter points. Obstacle capsule sweeps between samples are continuous. Native character-controller casts also include ground walls and terrain.','The widened capsule preserves full body height and contains the actual capsule. Arrival allowance is valid only after all waypoint radii are limited accordingly.']};fs.mkdirSync(values.out,{recursive:true});writeSourceJson(values.out,'static-route-scan.json',summary);scene.close();console.log(JSON.stringify({status:summary.status,segments:segments.length,blocked:segments.filter(s=>s.failures.length).length,samples:scene.stats().samples,peakRss:scene.stats().peakRss}));
