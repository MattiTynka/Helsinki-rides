import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import {chromium} from 'playwright';
import {openGame} from '../lib/browser.ts';

test('loopback page identity uses originally loaded script and manifest when a refetch returns newer bytes', {skip:!existsSync(chromium.executablePath())?'Playwright Chromium is not installed':false},async()=>{
  const sha=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex'),release='loaded-fixture';
  const oldManifest=JSON.stringify({worldReleaseId:release,geometry:'old'}),newManifest=JSON.stringify({worldReleaseId:release,geometry:'new'});
  const originalScript=`const manifest=await(await fetch('/world/${release}/manifest.json')).json();window.__loadedManifest=manifest;window.__HELSINKI_GAME__={ready:true,release:manifest.worldReleaseId};`,newScript=originalScript+'\n// changed server script';
  let manifestRequests=0,scriptRequests=0;
  const server=createServer((request,response)=>{
    response.setHeader('Cache-Control','no-store');
    if(request.url===`/world/${release}/manifest.json`){response.setHeader('Content-Type','application/json');response.end(++manifestRequests===1?oldManifest:newManifest);}
    else if(request.url==='/main.js'){response.setHeader('Content-Type','text/javascript');response.end(++scriptRequests===1?originalScript:newScript);}
    else {response.setHeader('Content-Type','text/html');response.end('<script type="module" src="/main.js"></script>');}
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert.ok(address&&typeof address==='object');const origin=`http://127.0.0.1:${address.port}`;
  let session:Awaited<ReturnType<typeof openGame>>|undefined;
  try {
    session=await openGame(origin);const page=session.page;
    const urls=await page.evaluate(release=>[...new Set(performance.getEntriesByType('resource').map(entry=>entry.name).filter(name=>new URL(name).pathname.endsWith(`/${release}/manifest.json`)))],release);assert.equal(urls.length,1);
    const scriptUrl=new URL((await page.locator('script[type="module"][src]').getAttribute('src'))!,origin).href;
    // These fresh requests demonstrate the old check's false match. They are never
    // accepted as proof of the page's original responses by BrowserSession.
    assert.equal(sha(await(await page.request.get(urls[0]!)).body()),sha(newManifest));
    assert.equal(sha(await(await page.request.get(scriptUrl)).body()),sha(newScript));
    assert.equal(await session.loadedResponseSha256(urls[0]!),sha(oldManifest));assert.equal(await session.loadedResponseSha256(scriptUrl),sha(originalScript));
    await assert.rejects(async()=>assert.equal(await session!.loadedResponseSha256(urls[0]!),sha(newManifest)));
    await assert.rejects(async()=>assert.equal(await session!.loadedResponseSha256(scriptUrl),sha(newScript)));
    assert.equal(manifestRequests,2);assert.equal(scriptRequests,2);assert.deepEqual(session.consoleErrors,[]);
  } finally {await session?.close();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});
