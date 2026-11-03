// Sustained real-keyboard flight, measured from actual native presentation times.
// HELSINKI_VERIFY_ANGLE=vulkan node tools/verify/verify-flight-smoothness.mjs --out <fresh-directory>
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {openGame,game} from './lib/browser.ts';
import {summarizeFlightFrames} from './lib/flight-smoothness.mjs';

const {values}=parseArgs({options:{url:{type:'string',default:'http://127.0.0.1:5371/'},out:{type:'string'},
  preset:{type:'string',default:'standard'},seconds:{type:'string',default:'40'},'cpu-rate':{type:'string',default:'1'},
  'max-frame-ms':{type:'string',default:'100'},'p99-ms':{type:'string',default:'50'},profile:{type:'boolean',default:false}}});
assert.ok(values.out&&!fs.existsSync(values.out),'Provide a fresh --out directory');
assert.ok(['standard','low'].includes(values.preset),'Preset must be standard or low');
const seconds=Number(values.seconds),cpuRate=Number(values['cpu-rate']),maxFrame=Number(values['max-frame-ms']),p99Limit=Number(values['p99-ms']);
assert.ok(Number.isFinite(seconds)&&seconds>=10&&seconds<=60,'Flight duration must be 10–60 seconds');
assert.ok(Number.isFinite(cpuRate)&&cpuRate>=1&&cpuRate<=8,'CPU rate must be 1–8');
assert.ok([maxFrame,p99Limit].every(n=>Number.isFinite(n)&&n>0),'Frame limits must be positive');
const url=new URL(values.url);url.searchParams.set('review','1');url.searchParams.set('audio','0');url.searchParams.set('preset',values.preset);url.searchParams.set('fps','60');url.searchParams.set('dynres','0');
fs.mkdirSync(values.out,{recursive:true});const out=values.out;
const session=await openGame(url.href,{timeoutMs:240000}),{page}=session;
const cdp=await page.context().newCDPSession(page);
const aircraft=async()=>{const s=await game.state(page);return s.aircraft.find(a=>a.id===s.player.aircraftId);};
async function until(predicate,timeout=120000){const end=Date.now()+timeout;while(Date.now()<end){if(await predicate())return;await page.waitForTimeout(150);}throw new Error('Flight setup timed out');}
try{
  await game.pause(page);await page.locator('#hud').evaluate(e=>e.classList.remove('hidden'));await page.locator('#dropin').selectOption('malmi-airfield');await game.resume(page);
  await until(async()=>(await game.state(page)).player.nearAircraft==='malmi-plane');await page.waitForTimeout(2000);
  await until(async()=>{if((await game.state(page)).player.aircraftId==='malmi-plane')return true;await page.keyboard.press('KeyF');await page.waitForTimeout(400);return false;});
  const parked=await aircraft();await page.keyboard.down('KeyW');await page.keyboard.down('Space');
  await until(async()=>(await aircraft()).position[1]>parked.position[1]+105);await page.keyboard.up('Space');
  await cdp.send('Emulation.setCPUThrottlingRate',{rate:cpuRate});
  if(values.profile){await cdp.send('Profiler.enable');await cdp.send('Profiler.setSamplingInterval',{interval:1000});await cdp.send('Profiler.start');}
  await page.evaluate(()=>{
    const api=window.__HELSINKI_GAME__,first=api.presentation();
    const p=window.__flightSmoothness={active:true,start:performance.now(),end:null,startFrameTime:first.frameTime,lastFrameTime:first.frameTime,finalFrameTime:null,frames:[],samples:[],longTasks:[],error:null};
    let previous=first.frameTime,lastSample=-Infinity;
    function stateSample(){const s=api.state();return {t:performance.now(),tick:api.tick(),player:s.player,aircraft:s.aircraft.find(a=>a.id===s.player.aircraftId),stream:api.streaming(),collision:api.collision(),stats:api.stats()};}
    p.samples.push(stateSample());
    if(PerformanceObserver.supportedEntryTypes.includes('longtask'))new PerformanceObserver(list=>{if(p.active)for(const e of list.getEntries())p.longTasks.push({t:e.startTime,ms:e.duration});}).observe({type:'longtask'});
    function frame(){if(!p.active)return;const s=api.presentation();
      if(!Number.isFinite(s.frameTime)||s.frameTime<previous){p.error='Invalid or decreasing presentation time';p.active=false;return;}
      if(s.frameTime>previous){p.frames.push({t:s.frameTime,ms:s.frameTime-previous,tick:s.tick,position:s.player.position});previous=s.frameTime;p.lastFrameTime=previous;}
      if(performance.now()-lastSample>=250){lastSample=performance.now();p.samples.push(stateSample());}
      requestAnimationFrame(frame);
    }requestAnimationFrame(frame);
  });
  await page.keyboard.down('ShiftLeft');await page.waitForTimeout(seconds*1000);await page.keyboard.up('ShiftLeft');await page.keyboard.up('KeyW');
  const data=await page.evaluate(()=>{const p=window.__flightSmoothness,api=window.__HELSINKI_GAME__,s=api.state(),final=api.presentation();p.end=performance.now();p.active=false;
    if(final.frameTime>p.lastFrameTime)p.frames.push({t:final.frameTime,ms:final.frameTime-p.lastFrameTime,tick:final.tick,position:final.player.position});
    p.finalFrameTime=final.frameTime;p.samples.push({t:p.end,tick:api.tick(),player:s.player,aircraft:s.aircraft.find(a=>a.id===s.player.aircraftId),stream:api.streaming(),collision:api.collision(),stats:api.stats()});return p;});
  if(values.profile){const {profile}=await cdp.send('Profiler.stop');fs.writeFileSync(path.join(out,'cpu.cpuprofile'),JSON.stringify(profile));}
  await cdp.send('Emulation.setCPUThrottlingRate',{rate:1});
  const summary=summarizeFlightFrames(data,{expectedDurationMs:seconds*1000,p99Limit,maxFrame});
  const gates={...summary.gates,browserErrors:session.consoleErrors.length===0};
  const scripts=await page.evaluate(()=>[...document.scripts].filter(s=>s.type==='module'&&s.src).map(s=>s.src));
  const loaded=[];for(const script of scripts)loaded.push({url:script,sha256:await session.loadedResponseSha256(script)});
  const result={...summary,status:Object.values(gates).every(Boolean)?'PASS':'FAIL',url:url.href,cpuRate,profiled:values.profile,
    semantics:'Actual presentation().frameTime intervals; paced duplicate rAF callbacks excluded. CPU slowdown is a diagnostic proxy, not a device qualification.',
    gates,loaded,errors:session.consoleErrors};
  fs.writeFileSync(path.join(out,'frames.json'),JSON.stringify(data));fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(result,null,2));
  await page.screenshot({path:path.join(out,'flight.png')});console.log(JSON.stringify(result));if(result.status!=='PASS')process.exitCode=1;
}catch(error){await page.screenshot({path:path.join(out,'failure.png')});fs.writeFileSync(path.join(out,'failure.json'),JSON.stringify({message:String(error),errors:session.consoleErrors},null,2));throw error;}
finally{await session.close();}
