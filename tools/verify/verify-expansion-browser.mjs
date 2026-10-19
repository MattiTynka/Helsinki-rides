// Opened captures and bounded-residency stress for the central expansion. Teleports
// are labelled fixtures; the optional walking route uses real keyboard input.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {parseArgs} from 'node:util';
import {game,openGame} from './lib/browser.ts';
const {values}=parseArgs({options:{url:{type:'string',default:'http://127.0.0.1:5317/'},release:{type:'string'},out:{type:'string'},preset:{type:'string',default:'low'},walk:{type:'boolean',default:false}}});
if(!values.release||!values.out||fs.existsSync(values.out))throw new Error('--release and fresh --out required');
fs.mkdirSync(values.out,{recursive:true});
const manifestBytes=fs.readFileSync(path.join(values.release,'manifest.json')),manifest=JSON.parse(manifestBytes),url=new URL(values.url);
url.searchParams.set('release',manifest.worldReleaseId);url.searchParams.set('review','1');url.searchParams.set('preset',values.preset);
const session=await openGame(url.href,{timeoutMs:240000}),{page}=session;
const runtimeUrl=await page.locator('script[type="module"][src]').first().getAttribute('src');
const runtimeBytes=runtimeUrl?await(await page.request.get(new URL(runtimeUrl,url).href)).body():null;
const binding={angle:process.env.HELSINKI_VERIFY_ANGLE??'d3d11',manifestSha256:createHash('sha256').update(manifestBytes).digest('hex'),runtimeUrl,runtimeSha256:runtimeBytes?createHash('sha256').update(runtimeBytes).digest('hex'):null,browser:session.browser.version(),viewport:page.viewportSize()};
const checks=[],samples=[],captures=[],route=[],views=[],gpuWarmup=[];
const check=(id,pass,detail)=>{checks.push({id,pass,detail});console.log(`${pass?'PASS':'FAIL'} ${id}: ${detail}`);};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const inspect=()=>page.evaluate(()=>({state:window.__HELSINKI_GAME__.state(),stream:window.__HELSINKI_GAME__.streaming(),textures:window.__HELSINKI_GAME__.textureMemory(),stats:window.__HELSINKI_GAME__.stats(),heap:performance.memory?.usedJSHeapSize??null}));
const settle=()=>page.evaluate(()=>window.__HELSINKI_GAME__.awaitVisuals());
// Match rendered view history even when the OS delays animation frames. Sleeping
// 150ms alone can sample the previous heading and never upload its visible meshes.
const settleView=()=>page.evaluate(()=>new Promise((resolve,reject)=>{
  let last=performance.now(),renderedMs=0,frames=0;
  const timeout=setTimeout(()=>reject(new Error('No settled rendered view within20s')),20000);
  function frame(now){renderedMs+=Math.min(100,Math.max(0,now-last));last=now;frames++;
    if(renderedMs>=300&&frames>=4){clearTimeout(timeout);resolve();}else requestAnimationFrame(frame);}
  requestAnimationFrame(frame);
}));
async function sample(label){const data=await inspect();samples.push({label,...data});return data;}
async function capture(label,yaw=0,pitch=-.08){await game.setCamera(page,yaw,pitch);await settleView();const file=`${label}.png`;await page.screenshot({path:path.join(values.out,file)});captures.push({label,file,state:await game.state(page),review:'CAPTURED_NOT_REVIEWED'});}
try{
  await game.start(page);await settle();
  const first=await sample('startup');
  check('release',await game.release(page)===manifest.worldReleaseId,manifest.worldReleaseId);
  check('bounded-startup',!!first.stream&&first.stream.detail.residentCells<manifest.cells.length&&first.stream.fallback.residentCells<manifest.cells.length,JSON.stringify(first.stream));
  const spawn=first.state.player.position;
  await capture('senate-monument',Math.atan2(-spawn[0],-spawn[2]),-.1);
  if(values.walk){
    // This continuous public-street route crosses the old west boundary into
    // Kluuvi and returns. No fixture teleport, entity mutation or reload.
    // Follow the street's bend on return. A straight line to z=65 clips the
    // north wall of BID_c1ed64dc near x=-116 (confirmed by capsule contacts).
    const targets=[[-63,24],[-63,58],[-260,64],[-370,70],[-260,64],[-63,58],[-35,18]];
    for(const target of targets){
      const start=Date.now();let arrived=false;
      await page.keyboard.down('KeyW');await page.keyboard.down('ShiftLeft');
      while(Date.now()-start<60000){
        const s=await game.state(page),p=s.player.position;
        if(Math.hypot(p[0]-target[0],p[2]-target[1])<3){arrived=true;break;}
        await game.setCamera(page,Math.atan2(target[0]-p[0],target[1]-p[2]),-.12);
        if(!route.length||Date.now()-route.at(-1).at>500){const a=await sample('keyboard-traversal');route.push({at:Date.now(),target,position:p,tick:s.tick,stream:a.stream,textures:a.textures,mode:s.player.mode});}
        await sleep(80);
      }
      await page.keyboard.up('KeyW');await page.keyboard.up('ShiftLeft');
      check(`walk-${target}`,arrived,JSON.stringify((await game.state(page)).player.position));
      if(!arrived)break;
    }
    await settle();await capture('returned-from-kluuvi',Math.PI,-.08);
  }
  await game.pause(page);
  const stops=[['Kluuvi / Aleksanterinkatu',-Math.PI/2],['Ateneum / Kaivokatu',0],['Helsinki Central Railway Station',Math.PI],['Kaisaniemenkatu',-Math.PI/2],['Esplanadi',-Math.PI/2],['Senate Square',Math.PI]];
  for(let round=0;round<2;round++)for(const[label,yaw]of stops){
    await game.dropIn(page,label);await page.evaluate(()=>window.__HELSINKI_GAME__.render());await settle();await page.evaluate(()=>window.__HELSINKI_GAME__.render());
    await game.setCamera(page,yaw,-.08);await settleView();
    const beforeWarmup=await inspect();
    // Three uploads geometry/textures lazily on the first visible draw. Render
    // the same headings on BOTH circuits before comparing allocated resources;
    // a cold single-heading view is not comparable with a warmed panorama.
    for(const heading of [0,Math.PI/2,Math.PI,-Math.PI/2]){
      await game.setCamera(page,heading,-.08);await settleView();
      if(round===0){const v=await game.stats(page);views.push({label,heading,...v});}
    }
    await game.setCamera(page,yaw,-.08);await settleView();
    const a=await sample(`fixture-${round}-${label}`);
    gpuWarmup.push({round,label,before:{textures:beforeWarmup.stats.textures,geometries:beforeWarmup.stats.geometries,retainedTextureMiB:beforeWarmup.textures.mib},after:{textures:a.stats.textures,geometries:a.stats.geometries,retainedTextureMiB:a.textures.mib}});
    check(`budget-${round}-${label}`,a.textures.mib<=(values.preset==='low'?160:320)+.01,`${a.textures.mib.toFixed(2)} MiB`);
    check(`covered-${round}-${label}`,a.stream?.fallback.pendingCells===0&&a.stream?.fallback.missingNearDetail.length===0&&a.stream?.fallback.failedLoads===0&&a.stream?.detail.failedLoads===0,JSON.stringify(a.stream));
    const allocated=a.stream.detail.residentTextureMiB+a.stream.fallback.residentTextureMiB+a.stream.persistentTextureMiB;
    check(`all-retained-textures-${round}-${label}`,allocated<=(values.preset==='low'?160:320)+.01,`${allocated.toFixed(2)} MiB including persistent hidden asset templates`);
    if(round===0){
      await capture(label.toLowerCase().replace(/[^a-z]+/g,'-'),yaw,-.08);
    }
  }
  const last=await sample('final');
  check('eviction',last.stream.detail.evicted>0&&last.stream.fallback.evicted>0,`${last.stream.detail.evicted} detailed / ${last.stream.fallback.evicted} distant retirements`);
  // Compare identical settled views after both circuits. Asset caches must not
  // retain old city copies; small platform allocator variance is not a leak.
  const returns=samples.filter(s=>s.label.endsWith('Senate Square'));
  check('stable-return-residency',returns.length===2&&Math.abs(returns[1].textures.mib-returns[0].textures.mib)<3,returns.map(s=>s.textures.mib.toFixed(2)).join(' -> '));
  check('stable-gpu-allocations',returns.length===2&&Math.abs(returns[1].stats.textures-returns[0].stats.textures)<=2&&Math.abs(returns[1].stats.geometries-returns[0].stats.geometries)<=5,JSON.stringify(returns.map(s=>({textures:s.stats.textures,geometries:s.stats.geometries}))));
  check('browser-errors',session.consoleErrors.length===0,session.consoleErrors.join('; ')||'none');
  check('visible-triangles',views.every(v=>v.triangles<=(values.preset==='low'?500000:1200000)),`max ${Math.max(...views.map(v=>v.triangles))}`);
}catch(e){check('harness',false,String(e.stack??e));}
finally{await page.keyboard.up('KeyW').catch(()=>{});await page.keyboard.up('ShiftLeft').catch(()=>{});await session.close();}
fs.writeFileSync(path.join(values.out,'results.json'),JSON.stringify({status:checks.every(c=>c.pass)?'PASS':'FAIL',release:manifest.worldReleaseId,...binding,harnessSha256:createHash('sha256').update(fs.readFileSync(new URL(import.meta.url))).digest('hex'),preset:values.preset,checks,samples,captures,route,views,gpuWarmup,consoleErrors:session.consoleErrors,limitations:'Fixture teleports test residency and views. Only keyboard-traversal records prove continuous reachability; screenshot files require opened visual review.'},null,1));
if(checks.some(c=>!c.pass))process.exitCode=1;
