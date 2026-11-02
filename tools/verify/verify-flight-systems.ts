// Native review observation, real keyboard boarding, flight, impacts and recovery.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {parseCollisionBundle} from '../../packages/world-schema/src/index.ts';
import {parseCellId} from '../../packages/sim/src/live-grid.ts';
import {openGame,game} from './lib/browser.ts';
import type {HelsinkiTestApi} from '../../apps/game/src/testapi.ts';

const {values}=parseArgs({options:{url:{type:'string',default:'http://127.0.0.1:5371/?review=1&audio=0&preset=low'},out:{type:'string'}}});
assert.ok(values.out&&!fs.existsSync(values.out),'Provide a fresh --out directory');
const out=values.out;fs.mkdirSync(out,{recursive:true});
const session=await openGame(values.url,{timeoutMs:240000}),{page}=session;
const checks:{id:string;detail:unknown}[]=[];
const record=(id:string,detail:unknown)=>{checks.push({id,detail});fs.writeFileSync(path.join(out,'checks.json'),JSON.stringify(checks,null,2));console.log(`PASS ${id}: ${JSON.stringify(detail)}`);};
const state=()=>game.state(page);
const aircraft=async()=>{const s=await state();return s.aircraft.find(a=>a.id===s.player.aircraftId)!;};
async function until(test:()=>Promise<boolean>,ms=60000){const end=Date.now()+ms;while(Date.now()<end){if(await test())return;await page.waitForTimeout(100);}throw new Error('Timed out: '+JSON.stringify(await aircraft()));}
async function shot(name:string){await page.screenshot({path:path.join(out,name+'.png')});}
async function hold(keys:string[],predicate:()=>Promise<boolean>,ms=60000){for(const k of keys)await page.keyboard.down(k);try{await until(predicate,ms);}finally{for(const k of keys)await page.keyboard.up(k);}}
async function board(id:string){await page.waitForTimeout(2000);await until(async()=>{if((await state()).player.aircraftId===id)return true;await page.keyboard.press('KeyF');await page.waitForTimeout(500);return false;},20000);}
const wrap=(a:number)=>Math.atan2(Math.sin(a),Math.cos(a));
async function turn(yaw:number){
  await until(async()=>{const a=await aircraft();assert.ok(!a.crashed,'A clear turn remains controllable');const error=wrap(yaw-a.yaw);if(Math.abs(error)<.035)return true;
    const key=error>0?'KeyA':'KeyD';await page.keyboard.down(key);await page.waitForTimeout(Math.min(80,Math.max(12,Math.abs(error)*500)));await page.keyboard.up(key);return false;});
}
async function liveObservation(){return page.evaluate(()=>{const api=(window as unknown as {__HELSINKI_GAME__:HelsinkiTestApi}).__HELSINKI_GAME__;return {streams:api.streaming(),ids:api.residentCells(),collision:api.collision(),stats:api.stats()};});}
async function mapObservation(){return page.evaluate(()=>{const c=document.querySelector<HTMLCanvasElement>('#minimap')!,d=c.getContext('2d')!.getImageData(0,0,c.width,c.height).data;const counts:Record<string,number>={};for(let i=0;i<d.length;i+=4){const key=[d[i],d[i+1],d[i+2]].join(',');counts[key]=(counts[key]??0)+1;}return {heading:document.querySelector('#compass-heading')!.textContent,colours:Object.entries(counts).sort((a,b)=>b[1]-a[1]).slice(0,15)};});}
async function crashIntoBuilding(kind:'plane'|'helicopter'){
  const parked=await aircraft();
  await hold(kind==='plane'?['KeyW','Space']:['Space'],async()=>{const a=await aircraft();return a.crashed||a.position[1]>parked.position[1]+2;});
  if(kind==='helicopter')await page.waitForTimeout(1200);
  const a=await aircraft();
  const data=await page.evaluate(()=>(window as unknown as {__HELSINKI_GAME__:HelsinkiTestApi}).__HELSINKI_GAME__.liveCells());
  fs.writeFileSync(path.join(out,`${kind}-live-collision.json`),JSON.stringify(data));
  assert.ok(data);const targets=new Map<string,{id:string;x:number;z:number;y:number;distance:number}>();
  for(const bytes of Object.values(data.cells))for(const c of parseCollisionBundle(Buffer.from(bytes,'base64')).colliders){
    if(!['buildings','citymodel','landmarks'].includes(c.group))continue;
    let minX=Infinity,maxX=-Infinity,minZ=Infinity,maxZ=-Infinity,maxY=-Infinity;
    for(let i=0;i<c.positions.length;i+=3){minX=Math.min(minX,c.positions[i]!);maxX=Math.max(maxX,c.positions[i]!);minZ=Math.min(minZ,c.positions[i+2]!);maxZ=Math.max(maxZ,c.positions[i+2]!);maxY=Math.max(maxY,c.positions[i+1]!);}
    const x=(minX+maxX)/2,z=(minZ+maxZ)/2,distance=Math.hypot(x-a.position[0],z-a.position[2]);
    if(distance>95&&distance<550&&maxY>a.position[1]+4&&maxX-minX>8&&maxZ-minZ>8)targets.set(c.id,{id:c.id,x,z,y:maxY,distance});
  }
  const target=[...targets.values()].sort((a,b)=>a.distance-b.distance)[0];assert.ok(target,'A real nearby building supports the crash journey');
  record(`${kind}-target`,target);await turn(Math.atan2(target.x-a.position[0],target.z-a.position[2]));
  await hold(['KeyW'],async()=>(await aircraft()).crashed,45000);
  const impact=await aircraft();record(`${kind}-physical-impact`,impact);await shot(`${kind}-impact`);
  let maximumAngular=0,rotationChange=0;
  for(let i=0;i<30;i++){const q=await aircraft();maximumAngular=Math.max(maximumAngular,Math.hypot(...q.angularVelocity));rotationChange=Math.max(rotationChange,1-Math.abs(q.rotation.reduce((sum,n,i)=>sum+n*impact.rotation[i]!,0)));await page.waitForTimeout(100);}
  assert.ok(maximumAngular>.05||rotationChange>.002,'Contact produces physical rotation');
  record(`${kind}-physical-tumble`,{maximumAngular,rotationChange,state:await aircraft()});await shot(`${kind}-wreck`);
  await hold(['KeyX'],async()=>!(await aircraft()).crashed,20000);assert.ok((await state()).player.alive);
  record(`${kind}-recover-with-keyboard`,await aircraft());
}
try{
  record('game-ready',true);
  await game.pause(page);await page.locator('#hud').evaluate(e=>e.classList.remove('hidden'));await page.locator('#dropin').selectOption('malmi-airfield');await game.resume(page);
  await until(async()=>(await state()).player.nearAircraft==='malmi-plane',120000);
  await until(async()=>/F \| Fly aircraft/.test(await page.locator('#prompt').textContent()??''));
  await board('malmi-plane');
  record('malmi-boarded',await aircraft());
  await turn(2.1);await turn(Math.PI);record('stationary-runway-turns',await aircraft());
  await crashIntoBuilding('plane');await page.keyboard.press('KeyF');await until(async()=>(await state()).player.mode==='onFoot');
  await game.pause(page);await game.dropIn(page,'malmi-airfield');
  await game.setCamera(page,Math.PI,-.12);await game.resume(page);
  // Walk around the Cessna's hull, then east into the helicopter's boarding area.
  await page.keyboard.down('KeyS');await page.waitForTimeout(4600);await page.keyboard.up('KeyS');
  await hold(['KeyD'],async()=>(await state()).player.nearAircraft==='malmi-helicopter',15000);await board('malmi-helicopter');
  await crashIntoBuilding('helicopter');
  const initial=await aircraft();await hold(['KeyW','Space'],async()=>{const a=await aircraft();return a.position[1]>initial.position[1]+115&&Math.hypot(a.position[0]-initial.position[0],a.position[2]-initial.position[2])>450;},90000);
  await page.waitForTimeout(3500);assert.ok(!(await aircraft()).crashed);
  await until(async()=>{const o=await liveObservation();return (o.streams?.live?.fallback.residentCells??0)>35&&(o.streams?.live?.fallback.pendingCells??1)===0;},180000);
  const north=await aircraft(),observation=await liveObservation(),map=await mapObservation();
  const farthest=Math.max(...(observation.ids?.live?.fallback??[]).map(id=>{const c=parseCellId(id)!;return Math.hypot(c[0]*128+64-north.position[0],c[1]*128+64-north.position[2]);}));
  assert.ok(farthest>600,'Actual mounted live cells reach beyond the ground range');assert.equal(observation.streams!.live!.fallback.residentTextureMiB,0);
  assert.ok(map.colours.some(([colour,count])=>colour==='201,210,227'&&count>20),'New live territory has real road pixels');
  record('live-flight-range-map-compass',{aircraft:north,farthest,map,...observation});await shot('live-flight-map');
  await turn(Math.PI/2);await page.waitForTimeout(6000);record('turn-compass-and-streams',{aircraft:await aircraft(),map:await mapObservation(),...await liveObservation()});await shot('live-flight-turned');
  assert.match((await mapObservation()).heading??'',/^E 0(8|9)/);
  await hold(['ControlLeft'],async()=>(await aircraft()).grounded,90000);assert.ok(!(await aircraft()).crashed,'Normal held-descent landing remains safe');await page.keyboard.press('KeyF');await until(async()=>(await state()).player.mode==='onFoot');
  record('normal-landing-and-exit',await state());await shot('landed-new-area');
  assert.deepEqual(session.consoleErrors,[]);record('browser-errors',session.consoleErrors);
  fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({status:'PASS',checks,review:'CAPTURED_NOT_REVIEWED'},null,2));
}catch(error){await shot('failure');fs.writeFileSync(path.join(out,'failure.json'),JSON.stringify({state:await state(),observation:await liveObservation(),errors:session.consoleErrors,console:session.consoleLines},null,2));throw error;}
finally{await session.close();}
