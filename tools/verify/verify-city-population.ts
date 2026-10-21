// Review-build interaction check on the selected, unchanged city world. District setup uses native drop-ins;
// taking a generated civilian car and accelerating use keyboard input. Crimes use the normal simulated weapon.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { Button, NEUTRAL, yawOf } from '../../packages/sim/src/index.ts';
import { game, openGame } from './lib/browser.ts';

const {values}=parseArgs({options:{url:{type:'string'},out:{type:'string'}}});
if(!values.url||!values.out||existsSync(values.out))throw Error('--url and a fresh --out are required');
const url=new URL(values.url);
if(!['http:','https:'].includes(url.protocol)||!['127.0.0.1','localhost'].includes(url.hostname)||url.username||url.password)throw Error('Local review build required');
mkdirSync(values.out,{recursive:true});
const session=await openGame(values.url,{timeoutMs:300000}),{page}=session,records:object[]=[];
const districts=['Esplanadi','Mannerheimintie / Lasipalatsi','West Kamppi / Pohjoinen Rautatiekatu',
  'Uspenski Cathedral / Rahapajankatu','Hakaniementori','Mannerheimintie northern public sidewalk'];
const captures:string[]=[];
try{
 const script=await page.locator('script[type="module"]').getAttribute('src');
 if(!script?.startsWith('/Helsinki-rides/assets/index-'))throw Error('compiled review bundle required');
 const response=await page.request.get(new URL(script,url).href);assert.equal(response.status(),200);
 const bundle={path:script,sha256:createHash('sha256').update(await response.body()).digest('hex')};
 await game.start(page);await game.pause(page);
 for(const[labelIndex,label]of districts.entries()){
  await page.evaluate(()=>window.__HELSINKI_GAME__!.reset());await game.pause(page);
  await game.dropIn(page,label);let state=await game.step(page,600,NEUTRAL);
  const p=state.player.position;
  const cars=state.vehicles.filter(v=>v.id.startsWith('city-car-')&&Math.hypot(v.position[0]-p[0],v.position[2]-p[2])<180);
  assert.ok(cars.length>=1,`${label}: generated cars near the player`);
  assert.ok(state.vehicles.filter(v=>v.id.startsWith('city-car-')).length<=12,`${label}: bounded civilian population`);
  const car=cars.find(v=>v.definition==='lumi-gt')??cars[0]!,yaw=yawOf(car.rotation),sin=Math.sin(yaw),cos=Math.cos(yaw);
  const stage=[car.position[0]+2.1*cos-.95*sin,car.position[2]-.95*cos-2.1*sin];
  await game.teleport(page,stage[0]!,stage[1]!,180-yaw*180/Math.PI);
  state=await game.step(page,30,NEUTRAL);
  assert.equal(state.player.nearVehicle,car.id,`${label}: generated car is enterable`);
  await game.setCommand(page,null);await page.keyboard.press('KeyF');state=await game.step(page,1);
  for(let i=0;i<35&&state.player.mode==='entering';i++)state=await game.step(page,30);
  assert.equal(state.player.mode,'driving',`${label}: complete entry animation`);
  assert.equal(state.player.inVehicle,car.id);
  const before=state.vehicles.find(v=>v.id===car.id)!.position;
  await page.keyboard.down('KeyW');state=await game.step(page,90);await page.keyboard.up('KeyW');
  const after=state.vehicles.find(v=>v.id===car.id)!;
  assert.ok(Math.hypot(after.position[0]-before[0],after.position[2]-before[2])>2,`${label}: car drives`);
  assert.equal(state.player.inVehicle,car.id,`${label}: driven car retained`);
  const carFile=`${labelIndex+1}-car.png`;await game.awaitVisuals(page);await page.screenshot({path:path.join(values.out,carFile)});captures.push(carFile);
  const theft={cars:cars.length,id:car.id,definition:car.definition,before,after:after.position,mode:state.player.mode};

  await page.evaluate(()=>window.__HELSINKI_GAME__!.reset());await game.pause(page);await game.dropIn(page,label);
  state=await game.step(page,180,NEUTRAL);const firstTick=state.tick,initialIds=state.police.map(u=>u.id);
  for(let i=0;i<4;i++){
   await game.step(page,1,{...NEUTRAL,buttons:Button.fire,yaw:0,pitch:1.1});
   state=await game.step(page,100,NEUTRAL);
  }
  let maximumStars=state.wanted.stars,minimumDistance=Infinity,responded=false;
  for(let i=0;i<20;i++){
   state=await game.step(page,30,NEUTRAL);maximumStars=Math.max(maximumStars,state.wanted.stars);
   for(const u of state.police){const v=state.vehicles.find(v=>v.id===u.vehicleId),officer=state.characters.find(c=>c.id===u.officerId);
    const position=u.onFoot?officer?.position:v?.position;if(!position)continue;
    const d=Math.hypot(position[0]-state.player.position[0],position[2]-state.player.position[2]);minimumDistance=Math.min(minimumDistance,d);
    if(d<140&&u.state!=='patrol'&&!initialIds.includes(u.id))responded=true;
   }
   if(responded)break;
  }
  assert.ok(maximumStars>=2,`${label}: normal witness reports raise wanted level`);
  assert.ok(responded,`${label}: newly dispatched local unit responds, beyond initial patrol`);
  const policeFile=`${labelIndex+1}-police.png`;await game.awaitVisuals(page);await page.screenshot({path:path.join(values.out,policeFile)});captures.push(policeFile);
  records.push({label,theft,dispatch:{maximumStars,minimumDistance,initialIds,units:state.police,events:await game.events(page,firstTick)},stats:await game.stats(page)});
  console.log(`PASS ${label}: ${cars.length} cars; keyboard entry/drive; new responding police (${minimumDistance.toFixed(1)} m)`);
 }
 assert.deepEqual(session.consoleErrors,[]);
 writeFileSync(path.join(values.out,'result.json'),JSON.stringify({status:'PASS',release:await game.release(page),browser:session.browser.version(),bundle,records,captures,consoleErrors:session.consoleErrors,visualReview:'CAPTURED_NOT_REVIEWED'},null,2)+'\n');
}finally{await session.close();}
