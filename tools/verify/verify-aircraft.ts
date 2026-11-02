// Real keyboard flight journey against a local game build, using the native review adapter for observation.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {openGame, game} from './lib/browser.ts';
import {AIRCRAFT_DEFINITIONS} from '../../packages/sim/src/index.ts';

const {values} = parseArgs({options: {url: {type:'string',default:'http://127.0.0.1:5371/?review=1&audio=0&preset=low'},out:{type:'string'}}});
if (!values.out || fs.existsSync(values.out)) throw new Error('Provide a fresh --out directory');
fs.mkdirSync(values.out,{recursive:true});
const session = await openGame(values.url,{timeoutMs:240000});
const {page} = session, checks: {id:string; detail:unknown}[] = [], captures:string[] = [];
const record = (id:string,detail:unknown) => {checks.push({id,detail});console.log(`PASS ${id}: ${JSON.stringify(detail)}`);};
const snapshot = () => game.state(page);
async function until(predicate: (state:Awaited<ReturnType<typeof snapshot>>) => boolean, timeout = 60000) {
  const end=Date.now()+timeout;
  while(Date.now()<end) {const state=await snapshot();if(predicate(state))return state;await page.waitForTimeout(200);}
  throw new Error('Timed out waiting for flight state: '+JSON.stringify((await snapshot()).player));
}
async function capture(name:string) {await page.screenshot({path:path.join(values.out!,`${name}.png`)});captures.push(`${name}.png`);}
try {
  await game.pause(page);
  // Review mode hides the HUD for captures; show the ordinary location menu without altering game state.
  await page.locator('#hud').evaluate(element=>element.classList.remove('hidden'));
  assert.equal((await snapshot()).aircraft.length,0);
  assert.equal(await page.evaluate(()=>performance.getEntriesByType('resource').filter(entry=>/\/(trainer|helicopter)-[^/]+\.glb/.test(entry.name)).length),0);
  record('aircraft-deferred-at-city-start',true);
  await page.locator('#dropin').selectOption('malmi-airfield');
  await game.resume(page);
  await until(s=>s.player.grounded && s.player.nearAircraft==='malmi-plane');
  await page.waitForTimeout(2000);
  await capture('malmi-airfield');
  record('malmi-plane-ready',(await snapshot()).aircraft);
  for(const definition of AIRCRAFT_DEFINITIONS) {
    if(definition.kind==='helicopter') {
      const position=(await snapshot()).player.position;
      await game.setCamera(page,Math.atan2(definition.position[0]-position[0],definition.position[1]-position[2]),-0.12);
      await game.resume(page);
      await page.keyboard.down('KeyW');
      try {await until(s=>s.player.grounded && s.player.nearAircraft===definition.id,30000);}
      finally {await page.keyboard.up('KeyW');}
      record('walk-to-helicopter-with-real-controls',(await snapshot()).player.position);
    }
    await page.keyboard.press('KeyF');
    await until(s=>s.player.aircraftId===definition.id);
    await page.waitForTimeout(800);
    await capture(`${definition.kind}-seated`);
    record(`${definition.kind}-real-keyboard-board`,(await snapshot()).player.mode);
    const initial=(await snapshot()).aircraft.find(a=>a.id===definition.id)!;
    await page.keyboard.down('KeyW');await page.keyboard.down('Space');
    let flown;
    try {flown=await until(s=>{const a=s.aircraft.find(a=>a.id===definition.id)!;return !a.grounded && a.position[1]>initial.position[1]+18;},90000);}
    finally {await page.keyboard.up('Space');await page.keyboard.up('KeyW');}
    const flight=flown.aircraft.find(a=>a.id===definition.id)!;
    assert.ok(Math.hypot(flight.position[0]-initial.position[0],flight.position[2]-initial.position[2])>5 || definition.kind==='helicopter');
    record(`${definition.kind}-takeoff`,flight);
    await page.keyboard.press('KeyF');await page.waitForTimeout(400);
    assert.equal((await snapshot()).player.mode,'flying');record(`${definition.kind}-airborne-exit-refused`,true);
    await page.keyboard.down('KeyD');await page.waitForTimeout(1500);await page.keyboard.up('KeyD');
    const turned=(await snapshot()).aircraft.find(a=>a.id===definition.id)!;
    assert.ok(Math.abs(turned.yaw-flight.yaw)>.2);record(`${definition.kind}-real-turn`,turned.yaw);
    await capture(`${definition.kind}-flight`);
    if(definition.kind==='plane') await page.keyboard.down('KeyS');
    await page.keyboard.down('ControlLeft');
    try {await until(s=>{const a=s.aircraft.find(a=>a.id===definition.id)!;return a.grounded && Math.abs(a.speed)<1;},90000);}
    finally {await page.keyboard.up('KeyS');await page.keyboard.up('ControlLeft');}
    record(`${definition.kind}-real-landing`,(await snapshot()).aircraft.find(a=>a.id===definition.id));
    await page.keyboard.press('KeyF');await until(s=>s.player.mode==='onFoot');
    assert.ok((await snapshot()).player.alive);record(`${definition.kind}-grounded-exit`,true);
    await capture(`${definition.kind}-landed`);
    if(definition.kind==='plane') {await game.pause(page);await game.dropIn(page,'malmi-airfield');}
  }
  assert.equal(session.consoleErrors.length,0,session.consoleErrors.join('\n'));
  const modelTransfers=await page.evaluate(()=>performance.getEntriesByType('resource').filter(entry=>/\/(trainer|helicopter)-[^/]+\.glb/.test(entry.name))
    .map(entry=>({name:new URL(entry.name).pathname,bytes:(entry as PerformanceResourceTiming).decodedBodySize})));
  assert.equal(modelTransfers.length,2);
  const contract=JSON.parse(fs.readFileSync(new URL('../../content/assets/aircraft.contract.json',import.meta.url),'utf8')) as {models:{bytes:number}[]};
  assert.equal(modelTransfers.reduce((sum,entry)=>sum+entry.bytes,0),contract.models.reduce((sum,model)=>sum+model.bytes,0));
  record('optimized-models-loaded-on-demand',modelTransfers);
  record('browser-errors',session.consoleErrors);
  fs.writeFileSync(path.join(values.out,'results.json'),JSON.stringify({status:'PASS',url:values.url,checks,captures,review:'CAPTURED_NOT_REVIEWED',state:await snapshot()},null,2));
} catch(error) {
  await capture('failure');
  fs.writeFileSync(path.join(values.out,'failure.json'),JSON.stringify({state:await snapshot(),errors:session.consoleErrors,console:session.consoleLines},null,2));
  throw error;
} finally {await session.close();}
