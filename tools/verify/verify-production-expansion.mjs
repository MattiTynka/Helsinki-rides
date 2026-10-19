// Ordinary-build UI smoke. Uses visible controls, never the review adapter.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {parseArgs} from 'node:util';
import {chromium} from 'playwright';

const {values}=parseArgs({options:{url:{type:'string',default:'http://127.0.0.1:5317/'},release:{type:'string'},out:{type:'string'},'drop-in':{type:'string',multiple:true}}});
if(!values.release||!values.out||fs.existsSync(values.out))throw new Error('--release and fresh --out required');
const url=new URL(values.url);
if(!['localhost','127.0.0.1'].includes(url.hostname)||url.search)throw new Error('Use an ordinary loopback URL without query parameters');
const manifestBytes=fs.readFileSync(path.join(values.release,'manifest.json')),manifest=JSON.parse(manifestBytes);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
fs.mkdirSync(values.out,{recursive:true});
const angle=process.env.HELSINKI_VERIFY_ANGLE??'d3d11';
if(!['d3d11','vulkan'].includes(angle))throw new Error('HELSINKI_VERIFY_ANGLE must be d3d11 or vulkan');
const browser=await chromium.launch({channel:'chromium',headless:true,args:['--enable-gpu','--ignore-gpu-blocklist',`--use-angle=${angle}`,'--enable-unsafe-swiftshader','--autoplay-policy=no-user-gesture-required']});
const browserVersion=browser.version();
let runtimeUrl=null,runtimeSha256=null;
const context=await browser.newContext({viewport:{width:1280,height:720},deviceScaleFactor:1});
const page=await context.newPage(),errors=[],requests=[],checks=[],captures=[];
page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
page.on('pageerror',e=>errors.push(e.message));
page.on('request',r=>requests.push(r.url()));
const check=(id,pass,detail)=>{checks.push({id,pass,detail});console.log(`${pass?'PASS':'FAIL'} ${id}: ${JSON.stringify(detail)}`);};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function ready(){
  await page.waitForFunction(()=>document.getElementById('loading-text')?.textContent==='Click to play'||!!window.__HELSINKI_ERROR__,undefined,{timeout:240000});
  const error=await page.evaluate(()=>window.__HELSINKI_ERROR__??null);
  if(error)throw new Error(error);
  await page.waitForFunction(()=>document.getElementById('world-stream-status')?.classList.contains('hidden'),undefined,{timeout:120000});
  await sleep(1200);
}
async function capture(label){const file=`${label}.png`;await page.screenshot({path:path.join(values.out,file)});captures.push({file,review:'CAPTURED_NOT_REVIEWED'});}
const detailPaths=new Set(manifest.cells.flatMap(cell=>[cell.visual.lod0.path,cell.visual.lod1?.path].filter(Boolean)).map(p=>new URL(`world/${manifest.worldReleaseId}/${p}`,url).href));
try{
  await page.goto(url.href,{waitUntil:'load'});await ready();
  runtimeUrl=await page.locator('script[type="module"][src]').first().getAttribute('src');
  runtimeSha256=sha(await(await page.request.get(new URL(runtimeUrl,url).href)).body());
  check('default-release',requests.some(r=>r.endsWith(`/world/${manifest.worldReleaseId}/manifest.json`)),manifest.worldReleaseId);
  check('ordinary-adapter-absent',await page.evaluate(()=>window.__HELSINKI_GAME__===undefined),'No review controls on the default page');
  const initialDetails=[...new Set(requests.filter(r=>detailPaths.has(r)))];
  check('bounded-detail-startup',initialDetails.length>0&&initialDetails.length<manifest.cells.length,{loaded:initialDetails.length,total:manifest.cells.length});
  await page.locator('#loading').click();
  await page.waitForFunction(()=>document.getElementById('loading')?.classList.contains('hidden'));
  await capture('default-senate');
  await page.keyboard.down('KeyW');await sleep(1500);await page.keyboard.up('KeyW');
  await page.keyboard.press('Escape');
  for(const label of values['drop-in']??['Esplanadi']){
    await page.locator('#dropin').selectOption({label});await ready();
    await capture(`ui-${label.toLowerCase().replace(/[^a-z0-9]+/g,'-')}`);
  }
  const laterDetails=[...new Set(requests.filter(r=>detailPaths.has(r)))];
  check('new-area-loads-on-demand',laterDetails.length>initialDetails.length,{startup:initialDetails.length,afterTravel:laterDetails.length});
  check('hud-present',await page.locator('#hud').isVisible(),await page.locator('#stats').textContent());
  check('credits-present',(await page.locator('#attribution').textContent()).includes('Helsinki'),'Rendered source attribution');
  const query=new URL(url);query.searchParams.set('review','1');
  await page.goto(query.href,{waitUntil:'load'});await ready();
  check('query-cannot-enable-adapter',await page.evaluate(()=>window.__HELSINKI_GAME__===undefined),'Production build rejects review API exposure even with ?review=1');
  check('browser-errors',errors.length===0,errors);
}catch(error){check('harness',false,String(error.stack??error));}
finally{await page.keyboard.up('KeyW').catch(()=>{});await context.close();await browser.close();}
const result={angle,browser:browserVersion,runtimeUrl,runtimeSha256,status:checks.every(c=>c.pass)?'PASS':'FAIL',release:manifest.worldReleaseId,manifestSha256:sha(manifestBytes),harnessSha256:sha(fs.readFileSync(new URL(import.meta.url))),checks,captures,errors,requests,limitations:'Ordinary UI startup and on-demand loading smoke. Detailed residency accounting and deterministic journeys are bound to the separately verified review build.'};
fs.writeFileSync(path.join(values.out,'results.json'),JSON.stringify(result,null,2)+'\n');
if(result.status!=='PASS')process.exitCode=1;
