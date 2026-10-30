import fs from 'node:fs';
import {openNativeRouteWorld,runNativeRoute} from './lib/walk-native-route.mjs';
import {Character,CHARACTER_SKIN} from '../../packages/sim/src/index.ts';
const input='../evidence/stage-a-walk-review-v2-low-v4-retry1/results.json',r=JSON.parse(fs.readFileSync(input)),state=r.failureView.state;
const s=await openNativeRouteWorld('../work/stage-a-review-v2/world',[-1170,760,-1125,805]);
const actor=state.characters.find(c=>c.id==='civilian-rain-black-72');
const body=new Character(s.world,actor.id,[actor.position[0],actor.position[1]-CHARACTER_SKIN,actor.position[2]],actor.yaw,actor.health);
s.identities.set(body.collider.handle,{id:actor.id,group:'live-character',source:'failureView.state.characters'});
s.world.physics.step();s.world.markStepped();
const runs=[];for(const cadence of[1,4,8]){const result=runNativeRoute(s,{start:state.player.position,targets:[[-1147.93994140625,783.22998046875]],headingUpdateTicks:cadence,maximumTicks:720});runs.push(result);console.log(JSON.stringify({passed:result.passed,ticks:result.ticks,cadence,last:result.lastPosition,remaining:result.remaining,contacts:result.trace.at(-1).contacts}));}
fs.writeFileSync('../evidence/stage-a-curb-diagnostic-v1/captured-pedestrian-reproduction.json',JSON.stringify({input,manifest:s.manifestSha256,capturedActor:actor,runs},null,2));s.close();
