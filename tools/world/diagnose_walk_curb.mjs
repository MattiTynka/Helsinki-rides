import fs from 'node:fs';
import {openNativeRouteWorld,runNativeRoute} from './lib/walk-native-route.mjs';
const dir='../evidence/stage-a-curb-diagnostic-v1';
const r=JSON.parse(fs.readFileSync('../evidence/stage-a-walk-review-v2-low-v4-retry1/results.json'));
const plan=JSON.parse(fs.readFileSync(dir+'/walk-v4-input.json'));
const s=await openNativeRouteWorld('../work/stage-a-review-v2/world',[-1170,760,-1125,805]);
const targets=plan.routes[0].waypoints.filter(p=>/^Circuit 4/.test(p.label)).filter(p=>Number(p.label.split(' ').at(-1))>=32).map(p=>p.xz);
const starts=[{label:'captured stuck',p:r.failureView.state.player.position,targets:[[-1147.93994140625,783.22998046875]]},{label:'captured checkpoint42',p:[-1146.9675555964932,-2.691175103280693,784.5683013382368],targets:targets.slice(4)},{label:'captured checkpoint32',p:[-1145.6179896732792,-2.7250882934662513,786.5642607863992],targets:targets.slice(1)}];
const runs=[];for(const a of starts)for(const cadence of[1,2,4,8]){const result=runNativeRoute(s,{start:a.p,targets:a.targets,headingUpdateTicks:cadence,maximumTicks:2000});runs.push({label:a.label,...result});console.log(JSON.stringify({label:a.label,passed:result.passed,ticks:result.ticks,reached:result.reached,cadence,last:result.lastPosition,remaining:result.remaining}));}
fs.writeFileSync(dir+'/quantized-approach-reproduction.json',JSON.stringify({manifest:s.manifestSha256,targets,runs},null,2));s.close();
