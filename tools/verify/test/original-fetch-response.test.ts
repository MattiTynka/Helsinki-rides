import assert from 'node:assert/strict';
import {createHash,webcrypto} from 'node:crypto';
import {test} from 'node:test';
import type {Page} from 'playwright';
import {installOriginalFetchResponseCapture,installOriginalFetchObserverInPage} from '../lib/original-fetch-response.ts';

const manifestUrl='https://assets.example.test/world/final/manifest.json',documentUrl='https://game.example.test/';
const sha=(b:Uint8Array|string)=>createHash('sha256').update(b).digest('hex');
const tick=()=>new Promise(resolve=>setTimeout(resolve,25));
type Config=Parameters<typeof installOriginalFetchObserverInPage>[0];
type Scope=NonNullable<Parameters<typeof installOriginalFetchObserverInPage>[1]>;
type Role={type?:string;initiator?:string;preload?:boolean;loader?:string;worker?:boolean;initiatorUrl?:string};
async function fixture(limits:Partial<Config>={}) {
  const events=new Map<string,((value:any)=>void)[]>(),mainFrame={url:()=>currentUrl},childFrame={url:()=>currentUrl};
  const protocol=new Map<string,(value:any)=>void>();let requestCount=0;
  let currentUrl=documentUrl,config!:Config,binding!:(source:any,nonce:unknown,event:unknown)=>unknown,initCount=0;
  const fake={mainFrame:()=>mainFrame,url:()=>currentUrl,
    context:()=>({newCDPSession:async()=>({send:async(name:string)=>name==='Page.getFrameTree'?{frameTree:{frame:{id:'main'}}}:{},on:(name:string,fn:(v:any)=>void)=>protocol.set(name,fn)})}),
    exposeBinding:async(_name:string,fn:typeof binding)=>{binding=fn;},
    addInitScript:async(_fn:unknown,arg:Config)=>{config=arg;initCount++;},
    on:(name:string,fn:(v:any)=>void)=>{events.set(name,[...events.get(name)??[],fn]);}} as unknown as Page;
  const capture=await installOriginalFetchResponseCapture(fake,{manifestUrl,...limits});
  const emit=(name:string,value:unknown)=>events.get(name)?.forEach(fn=>fn(value));
  let calls=0,lastPromise!:Promise<Response>,lastResponse!:Response;
  function navigate(url=documentUrl,options:{body?:string;cdpBody?:string;status?:number;responseUrl?:string;redirected?:boolean;declared?:string;frame?:unknown;bodyRead?:Promise<Buffer>;finished?:Promise<Error|null>;role?:Role;auxiliary?:Role[]}={}) {
    currentUrl=url;capture.beginNavigation(url);
    const nativeFetch=(input:RequestInfo|URL,init?:RequestInit)=>{
      calls++;const requestUrl=typeof input==='string'?input:input instanceof URL?input.href:input.url;
      const bytes=Buffer.from(options.body??'Etelä — € 🦊');
      const response=new Response(bytes,{status:options.status??200,headers:options.declared?{'content-length':options.declared}:{}});
      Object.defineProperties(response,{url:{value:options.responseUrl??manifestUrl},redirected:{value:options.redirected??false}});
      lastResponse=response;lastPromise=Promise.resolve(response);
      function observation(role:Role={}) {
        const type=role.type??'Other',id=String(++requestCount),loader=role.loader??url;
        const request={url:()=>requestUrl,frame:()=>options.frame??mainFrame,method:()=>init?.method??'GET',resourceType:()=>type.toLowerCase(),serviceWorker:()=>null,redirectedFrom:()=>null};
        emit('request',request);
        protocol.get('Network.requestWillBeSent')?.({requestId:id,frameId:options.frame===childFrame?'child':'main',loaderId:loader,documentURL:url,type,
          request:{url:requestUrl,method:request.method(),isLinkPreload:role.preload??true},initiator:{type:role.initiator??'parser',url:role.initiatorUrl??url}});
        protocol.get('Network.responseReceived')?.({requestId:id,frameId:options.frame===childFrame?'child':'main',loaderId:loader,type,response:{url:options.responseUrl??manifestUrl,status:options.status??200,fromServiceWorker:role.worker??false}});
        protocol.get('Network.loadingFinished')?.({requestId:id});
        emit('response',{url:()=>options.responseUrl??manifestUrl,status:()=>options.status??200,request:()=>request,
          fromServiceWorker:()=>role.worker??false,finished:async()=>options.finished??null,body:async()=>options.bodyRead??Buffer.from(options.cdpBody??bytes)});
      }
      for(const role of options.auxiliary??[])observation(role);observation(options.role);
      return lastPromise;
    };
    const scope={fetch:nativeFetch,location:{href:url},crypto:webcrypto as unknown as Crypto,Response} as unknown as Scope;
    scope.top=scope;scope[config.bridge]=async(nonce:unknown,event:unknown)=>binding({page:fake,frame:options.frame??mainFrame},nonce,event);
    installOriginalFetchObserverInPage(config,scope);
    return scope;
  }
  return {capture,navigate,page:fake,config:()=>config,mainFrame,childFrame,
    bridge:(nonce:unknown,event:unknown,frame=mainFrame)=>binding({page:fake,frame},nonce,event),
    calls:()=>calls,lastPromise:()=>lastPromise,lastResponse:()=>lastResponse,initCount:()=>initCount};
}

test('raw UTF8 clone identity preserves original promise/Response and records distinct CDP readback without refetch',async()=>{
  const f=await fixture(),body='Etelä — € 🦊',corrupt=Buffer.from(body).toString('latin1'),scope=f.navigate(documentUrl,{body,cdpBody:corrupt,declared:'2'});
  const promise=scope.fetch(manifestUrl);assert.equal(promise,f.lastPromise());const response=await promise;assert.equal(response,f.lastResponse());assert.equal(await response.text(),body);
  const receipt=await f.capture.receipt(1000);assert.equal(receipt.originalFetch.sha256,sha(body));assert.equal(receipt.originalFetch.bytes,Buffer.byteLength(body));
  assert.equal(receipt.networkObservation.readback?.sha256,sha(corrupt));assert.notEqual(receipt.originalFetch.sha256,receipt.networkObservation.readback?.sha256);
  assert.equal(receipt.networkObservation.completed,true);assert.equal(f.calls(),1);assert.ok(!JSON.stringify(f.config()).includes(sha(body)));
  assert.deepEqual(await f.capture.receipt(1000),receipt);assert.equal(f.calls(),1);
});

test('capture bounds decoded bytes, aggregate bytes and response count, without breaking application consumption',async()=>{
  const body=await fixture({maxBodyBytes:4});const s=body.navigate(documentUrl,{body:'12345',cdpBody:'ok'});assert.equal(await(await s.fetch(manifestUrl)).text(),'12345');await tick();await assert.rejects(body.capture.receipt(100),/body limit/);
  const total=await fixture({maxBodyBytes:8,maxTotalBodyBytes:5});const t=total.navigate(documentUrl,{body:'123',cdpBody:'a'});await Promise.all([t.fetch(manifestUrl),t.fetch(manifestUrl)]);await tick();await assert.rejects(total.capture.receipt(100),/cumulative/);
  const count=await fixture({maxResponses:1});const c=count.navigate();await c.fetch(manifestUrl);await c.fetch(manifestUrl);await tick();await assert.rejects(count.capture.receipt(100),/count limit|response count limit/);
  const announced=await fixture({maxBodyBytes:4});await announced.navigate(documentUrl,{body:'ok',declared:'5'}).fetch(manifestUrl);await tick();await assert.rejects(announced.capture.receipt(100),/declared body limit/);
});

test('duplicate manifests, redirects, non200 and nonGET cannot provide identity',async()=>{
  const duplicate=await fixture(),s=duplicate.navigate();await s.fetch(manifestUrl);await s.fetch(manifestUrl);await tick();await assert.rejects(duplicate.capture.receipt(100),/Exactly one/);
  for(const options of [{status:404},{responseUrl:manifestUrl+'?other=1'},{redirected:true}]) {
    const f=await fixture();await f.navigate(documentUrl,options).fetch(manifestUrl);await tick();await assert.rejects(f.capture.receipt(100));
  }
  const post=await fixture();await post.navigate().fetch(manifestUrl,{method:'POST'});await tick();await assert.rejects(post.capture.receipt(100));
});

test('bridge forgery and child-frame responses cannot supply main-frame evidence',async()=>{
  const f=await fixture();f.capture.beginNavigation(documentUrl);
  const event={kind:'document',documentId:'00000000-0000-4000-8000-000000000000',documentUrl};
  f.bridge('caller-invented-nonce',event);f.bridge(f.config().nonce,event,f.childFrame);
  await assert.rejects(f.capture.receipt(30),/did not complete/);
  const scope=f.navigate(documentUrl,{frame:f.childFrame});await scope.fetch(manifestUrl);await tick();await assert.rejects(f.capture.receipt(30),/did not complete/);
});

test('query navigation resets closed evidence once and discards late prior-document completions',async()=>{
  const f=await fixture();let finish!:(b:Buffer)=>void;const delayed=new Promise<Buffer>(resolve=>{finish=resolve;});
  const first=f.navigate(documentUrl,{body:'old',bodyRead:delayed});await first.fetch(manifestUrl);await tick();
  const second=f.navigate(documentUrl+'?review=1',{body:'new'});const wrapper=second.fetch;await second.fetch(manifestUrl);finish(Buffer.from('old CDP'));
  const receipt=await f.capture.receipt(1000);assert.equal(receipt.originalFetch.sha256,sha('new'));assert.equal(receipt.networkObservation.readback?.sha256,sha('new'));
  assert.equal(receipt.documentUrl,documentUrl+'?review=1');assert.equal(second.fetch,wrapper);assert.equal(f.initCount(),1);assert.equal(f.calls(),2);
  await assert.rejects(installOriginalFetchResponseCapture(f.page,{manifestUrl}),/already installed/);
});

test('missing network completion and unknown limits fail closed',async()=>{
  const f=await fixture();f.navigate();await assert.rejects(f.capture.receipt(30),/did not complete/);
  const unfinished=await fixture();await unfinished.navigate(documentUrl,{finished:new Promise(()=>{})}).fetch(manifestUrl);
  await assert.rejects(unfinished.capture.receipt(40),/did not complete/);
  for(const limits of [{maxResponses:2049},{maxBodyBytes:32*1024*1024+1},{maxTotalBodyBytes:128*1024*1024+1},{maxResponses:0}]) await assert.rejects(fixture(limits),/Invalid/);
});

test('oversized clone fails promptly with its original tee branch unconsumed',async()=>{
  const f=await fixture({maxBodyBytes:4}),scope=f.navigate(documentUrl,{body:'123456789',cdpBody:'ok'});
  const promise=scope.fetch(manifestUrl);assert.equal(promise,f.lastPromise());const response=await promise;
  assert.equal(response.bodyUsed,false);await assert.rejects(f.capture.receipt(250),/body limit/);
  assert.equal(response.bodyUsed,false);assert.equal(await response.text(),'123456789');
});

test('one warm SW application Fetch plus one protocol-proven link preload has one authoritative identity',async()=>{
  const f=await fixture(),scope=f.navigate(documentUrl+'?review=1',{role:{type:'Fetch',initiator:'script',preload:false,worker:true},auxiliary:[{worker:true}]});
  await scope.fetch(manifestUrl);const proof=await f.capture.receipt(1000);
  assert.equal(proof.networkObservation.resourceType,'fetch');assert.equal(proof.networkProvenance.initiatorType,'script');
  assert.equal(proof.auxiliaryPreload?.protocol.isLinkPreload,true);assert.equal(proof.auxiliaryPreload?.protocol.initiatorType,'parser');
  assert.equal(f.calls(),1);assert.equal(f.capture.journal().clones.length,1);assert.equal(f.capture.journal().network.length,2);
});

test('warm attribution rejects duplicate Fetch, unproven preload, third response, foreign loader and nonSW substitutions',async()=>{
  const fetchRole={type:'Fetch',initiator:'script',preload:false,worker:true};
  for(const auxiliary of [[fetchRole],[{worker:true,preload:false}],[{worker:true},{worker:true}],[{worker:true,loader:'other'}],[{worker:false}],[{worker:true,initiatorUrl:'https://other.test/'}]]) {
    const f=await fixture();await f.navigate(documentUrl+'?review=1',{role:fetchRole,auxiliary}).fetch(manifestUrl);await tick();
    await assert.rejects(f.capture.receipt(100));
  }
  const duplicate=await fixture(),scope=duplicate.navigate(documentUrl+'?review=1',{role:fetchRole,auxiliary:[{worker:true}]});
  await scope.fetch(manifestUrl);await scope.fetch(manifestUrl);await tick();await assert.rejects(duplicate.capture.receipt(100),/Exactly one/);
});
