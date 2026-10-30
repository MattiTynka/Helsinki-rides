import assert from 'node:assert/strict';
import {createHash, randomBytes} from 'node:crypto';
import type {Page, Request as NetworkRequest, Response as NetworkResponse} from 'playwright';

const CAPS = {maxResponses:2048, maxBodyBytes:32*1024*1024, maxTotalBodyBytes:128*1024*1024};
type Limits = typeof CAPS;
interface Init extends Limits {manifestUrl:string; bridge:string; nonce:string}
interface Scope {
  fetch:typeof fetch; location:{href:string}; top:unknown; crypto:Crypto; Response:typeof Response;
  [key:string]:unknown;
}
type Event = {kind:'document'|'start'|'complete'|'error'; documentId:string; documentUrl:string;
  id?:number; url?:string; requestUrl?:string; method?:string; status?:number; bytes?:number; sha256?:string; message?:string};
type CloneRecord = {id:number; url:string; requestUrl:string; method:string; status:number; bytes?:number; sha256?:string};
type NetworkRecord = {url:string; status:number; method:string; resourceType:string; mainFrame:true;
  requestId:number; fromServiceWorker:boolean; frameDocumentUrl:string; serviceWorkerOwner:boolean; redirectedFromUrl:string|null;
  completed:boolean; readback?:{bytes:number; sha256:string}; readbackError?:string};
type Provenance = {requestId:string;url:string;method:string;frameId:string;loaderId:string;documentUrl:string;
  resourceType:string;initiatorType:string;initiatorUrl:string|null;isLinkPreload:boolean;
  status?:number;fromServiceWorker?:boolean;completed:boolean};

/** Self-contained init script: no expected digest, text decoding, refetch, public
 * result object, or change to the application's original fetch promise/Response. */
export function installOriginalFetchObserverInPage(config:Init, scope:Scope = window as unknown as Scope) {
  if (scope.top !== scope) return;
  const originalFetch=scope.fetch, clone=scope.Response.prototype.clone;
  const digest=scope.crypto.subtle.digest.bind(scope.crypto.subtle);
  const send=scope[config.bridge] as (nonce:string,event:Event)=>Promise<unknown>;
  const documentId=scope.crypto.randomUUID(), documentUrl=scope.location.href;
  let count=0,total=0,failed=false;
  const report=(event:Omit<Event,'documentId'|'documentUrl'>) => {
    // A bridge rejection must never become an application unhandled rejection.
    try {void send(config.nonce,{...event,documentId,documentUrl}).catch(()=>{});} catch {/* Host observes missing evidence. */}
  };
  const fail=(message:string) => {if (!failed) {failed=true;report({kind:'error',message});}};
  report({kind:'document'});
  async function consume(copy:Response,id:number) {
    const reader=copy.body?.getReader();
    if (!reader) throw new Error('Original Fetch response has no readable body');
    const chunks:Uint8Array[]=[];let bytes=0;
    try {
      while (true) {
        const part=await reader.read();if (part.done) break;
        bytes+=part.value.byteLength;total+=part.value.byteLength;
        if (bytes>config.maxBodyBytes || total>config.maxTotalBodyBytes || failed) {
          void reader.cancel().catch(()=>{});
          throw new Error(bytes>config.maxBodyBytes?'Original Fetch decoded body limit exceeded':'Original Fetch cumulative body limit exceeded');
        }
        chunks.push(part.value);
      }
      const body=new Uint8Array(bytes);let offset=0;
      for (const chunk of chunks) {body.set(chunk,offset);offset+=chunk.byteLength;}
      const hash=Array.from(new Uint8Array(await digest('SHA-256',body)),b=>b.toString(16).padStart(2,'0')).join('');
      if (!failed) report({kind:'complete',id,bytes,sha256:hash});
    } finally {reader.releaseLock();}
  }
  scope.fetch=function(this:unknown,...args:Parameters<typeof fetch>):ReturnType<typeof fetch> {
    const promise=Reflect.apply(originalFetch,this,args) as ReturnType<typeof fetch>;
    // Observe asynchronously, while cloning before the application's .then can
    // consume the original body. Return the very same promise, not its observer.
    void promise.then(response=>{
      try {
        const input=args[0], requestUrl=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url,scope.location.href).href;
        if (requestUrl!==config.manifestUrl && response.url!==config.manifestUrl) return;
        if (failed) return;
        if (++count>config.maxResponses) throw new Error('Original Fetch response count limit exceeded');
        const method=(args[1]?.method??(typeof input==='object'&&'method' in input?input.method:'GET')).toUpperCase();
        report({kind:'start',id:count,url:response.url,requestUrl,method,status:response.status});
        if (requestUrl!==config.manifestUrl || response.url!==config.manifestUrl || response.redirected || response.status!==200 || method!=='GET') {
          throw new Error('Original Fetch manifest must be a direct HTTP200 GET at the exact URL');
        }
        const length=response.headers.get('content-length');
        if (length!==null && (!/^\d+$/.test(length)||Number(length)>config.maxBodyBytes)) throw new Error('Original Fetch declared body limit exceeded');
        const copy=Reflect.apply(clone,response,[]) as Response;
        void consume(copy,count).catch(error=>fail(error instanceof Error?error.message:'Original Fetch observer failed'));
      } catch (error) {fail(error instanceof Error?error.message:'Original Fetch observer failed');}
    },()=>{});
    return promise;
  };
}

const installed=new WeakSet<Page>();
/** Main-frame, document- and nonce-bound collection. CDP bytes remain diagnostic:
 * Chrome may re-encode UTF-8 preload text when reading Network.getResponseBody. */
export async function installOriginalFetchResponseCapture(page:Page, options:{manifestUrl:string}&Partial<Limits>) {
  assert.ok(!installed.has(page),'Original Fetch observer is already installed on this page');
  const manifestUrl=new URL(options.manifestUrl).href;
  assert.ok(['http:','https:'].includes(new URL(manifestUrl).protocol));
  const limits={...CAPS};
  for (const key of Object.keys(CAPS) as (keyof Limits)[]) {
    const value=options[key]??CAPS[key];assert.ok(Number.isSafeInteger(value)&&value>0&&value<=CAPS[key],`Invalid ${key}`);limits[key]=value;
  }
  const nonce=randomBytes(32).toString('hex'),bridge='__originalFetch_'+randomBytes(16).toString('hex');
  type Visit={generation:number;documentUrl:string;documentId?:string;clones:CloneRecord[];network:NetworkRecord[];provenance:Provenance[];failure?:Error;cloneBytes:number;networkBytes:number;requests:number};
  let visit:Visit|undefined;
  let generation=0;
  const seenDocuments=new Set<string>();
  const requested=new WeakMap<NetworkRequest,{visit:Visit;id:number;frameDocumentUrl:string}>();
  const fail=(state:Visit,error:unknown) => {state.failure??=error instanceof Error?error:new Error(String(error));};
  const cdp=await page.context().newCDPSession(page);
  const mainFrameId=(await cdp.send('Page.getFrameTree')).frameTree.frame.id;
  const protocolRequests=new Map<string,{visit:Visit;record:Provenance}>();
  cdp.on('Network.requestWillBeSent',event=>{
    if (!visit || event.request.url!==manifestUrl || event.frameId!==mainFrameId || event.documentURL!==visit.documentUrl) return;
    const state=visit;
    try {
      assert.ok(state.provenance.length<limits.maxResponses,'Manifest protocol response count limit exceeded');
      assert.ok(!protocolRequests.has(event.requestId),'Ambiguous redirected manifest request');
      const record:Provenance={requestId:event.requestId,url:event.request.url,method:event.request.method,frameId:event.frameId,
        loaderId:event.loaderId,documentUrl:event.documentURL,resourceType:event.type??'',initiatorType:event.initiator.type,
        initiatorUrl:event.initiator.url??null,isLinkPreload:event.request.isLinkPreload===true,completed:false};
      state.provenance.push(record);protocolRequests.set(event.requestId,{visit:state,record});
    } catch (error) {fail(state,error);}
  });
  cdp.on('Network.responseReceived',event=>{
    const entry=protocolRequests.get(event.requestId);if (!entry || entry.visit!==visit) return;
    try {
      assert.equal(event.frameId,mainFrameId);assert.equal(event.loaderId,entry.record.loaderId);assert.equal(event.response.url,manifestUrl);
      assert.equal(event.type,entry.record.resourceType);assert.equal(event.response.status,200);
      entry.record.status=event.response.status;entry.record.fromServiceWorker=event.response.fromServiceWorker===true;
    } catch (error) {fail(entry.visit,error);}
  });
  cdp.on('Network.loadingFinished',event=>{const entry=protocolRequests.get(event.requestId);if (entry&&entry.visit===visit) entry.record.completed=true;});
  cdp.on('Network.loadingFailed',event=>{const entry=protocolRequests.get(event.requestId);if (entry&&entry.visit===visit) fail(entry.visit,new Error('Original manifest protocol request failed'));});
  await cdp.send('Network.enable');
  await page.exposeBinding(bridge,(source,providedNonce:unknown,value:unknown)=>{
    // An application caller can enumerate the bridge name, but cannot obtain the
    // closure-held nonce. Ignore unauthenticated and child-frame submissions.
    if (providedNonce!==nonce || source.page!==page || source.frame!==page.mainFrame() || !visit) return;
    const state=visit;
    try {
      assert.ok(value&&typeof value==='object'&&!Array.isArray(value));const event=value as Event;
      assert.ok(typeof event.documentId==='string'&&/^[a-f0-9-]{36}$/.test(event.documentId));
      if (event.documentUrl!==state.documentUrl) return; // A late, prior-document observer.
      if (event.kind==='document') {
        assert.deepEqual(Object.keys(event).sort(),['documentId','documentUrl','kind']);
        if (seenDocuments.has(event.documentId)) return;
        assert.ok(!state.documentId,'Unexpected second main-frame document');seenDocuments.add(event.documentId);state.documentId=event.documentId;return;
      }
      if (event.documentId!==state.documentId) return;
      if (event.kind==='error') {
        assert.deepEqual(Object.keys(event).sort(),['documentId','documentUrl','kind','message']);
        assert.ok(typeof event.message==='string'&&event.message.length<=256);throw new Error(event.message);
      }
      assert.ok(Number.isSafeInteger(event.id)&&event.id!>0&&event.id!<=limits.maxResponses);
      if (event.kind==='start') {
        assert.deepEqual(Object.keys(event).sort(),['documentId','documentUrl','id','kind','method','requestUrl','status','url']);
        assert.equal(event.id,state.clones.length+1);assert.equal(event.url,manifestUrl);assert.equal(event.requestUrl,manifestUrl);
        assert.equal(event.status,200);assert.equal(event.method,'GET');
        state.clones.push({id:event.id!,url:event.url!,requestUrl:event.requestUrl!,method:event.method!,status:event.status!});
      } else {
        assert.equal(event.kind,'complete');assert.deepEqual(Object.keys(event).sort(),['bytes','documentId','documentUrl','id','kind','sha256']);
        assert.ok(Number.isSafeInteger(event.bytes)&&event.bytes!>=0&&event.bytes!<=limits.maxBodyBytes);
        assert.ok(typeof event.sha256==='string'&&/^[a-f0-9]{64}$/.test(event.sha256));
        const record=state.clones[event.id!-1];assert.ok(record&&!record.sha256,'Unknown or duplicate Fetch completion');
        state.cloneBytes+=event.bytes!;assert.ok(state.cloneBytes<=limits.maxTotalBodyBytes,'Original Fetch cumulative body limit exceeded');
        record.bytes=event.bytes!;record.sha256=event.sha256;
      }
    } catch (error) {fail(state,error);}
  });
  await page.addInitScript(installOriginalFetchObserverInPage,{...limits,manifestUrl,bridge,nonce});
  installed.add(page);
  page.on('request',request=>{
    if (!visit || request.url()!==manifestUrl) return;
    try {if (request.frame()===page.mainFrame()) {
      assert.ok(++visit.requests<=limits.maxResponses,'Original manifest request count limit exceeded');
      requested.set(request,{visit,id:visit.requests,frameDocumentUrl:request.frame().url()});
    }} catch (error) {fail(visit,error);}
  });
  const observe=(response:NetworkResponse) => {
    if (!visit || response.url()!==manifestUrl) return;
    const requestBinding=requested.get(response.request()),state=requestBinding?.visit;if (!state || state!==visit) return;
    try {
      const request=response.request();if (request.frame()!==page.mainFrame()) return;
      assert.ok(state.network.length<limits.maxResponses,'Original manifest network response count limit exceeded');
      const record:NetworkRecord={url:response.url(),status:response.status(),method:request.method(),resourceType:request.resourceType(),mainFrame:true,
        requestId:requestBinding!.id,fromServiceWorker:response.fromServiceWorker(),frameDocumentUrl:requestBinding!.frameDocumentUrl,
        serviceWorkerOwner:request.serviceWorker()!==null,redirectedFromUrl:request.redirectedFrom()?.url()??null,completed:false};
      state.network.push(record);
      void (async()=>{
        assert.equal(record.status,200,'Original manifest network status must be200');assert.equal(record.method,'GET');
        assert.equal(await response.finished(),null,'Original manifest network response did not complete');
        record.completed=true;
        let body:Buffer;
        try {body=await response.body();} catch {record.readbackError='CDP original response body unavailable';return;}
        assert.ok(body.length<=limits.maxBodyBytes,'CDP manifest readback body limit exceeded');
        state.networkBytes+=body.length;assert.ok(state.networkBytes<=limits.maxTotalBodyBytes,'CDP manifest cumulative readback limit exceeded');
        record.readback={bytes:body.length,sha256:createHash('sha256').update(body).digest('hex')};
      })().catch(error=>fail(state,error));
    } catch (error) {fail(state,error);}
  };
  page.on('response',observe);
  return {
    beginNavigation(documentUrl:string) {
      protocolRequests.clear();
      visit={generation:++generation,documentUrl:new URL(documentUrl).href,clones:[],network:[],provenance:[],cloneBytes:0,networkBytes:0,requests:0};
    },
    journal() {
      return visit?JSON.parse(JSON.stringify({...visit,failure:visit.failure?.message??null})):null;
    },
    async receipt(timeoutMs=10000) {
      assert.ok(Number.isSafeInteger(timeoutMs)&&timeoutMs>0&&timeoutMs<=30000);const state=visit;assert.ok(state,'Begin a navigation before requesting original Fetch identity');
      const deadline=Date.now()+timeoutMs;
      while (true) {
        assert.equal(visit,state,'Navigation changed during original Fetch identity lookup');if (state.failure) throw state.failure;
        assert.ok(state.clones.length<=1&&state.network.length<=2&&state.provenance.length<=2,`Exactly one original manifest Fetch required; only one proven auxiliary preload allowed (Fetch=${state.clones.length}, network=${state.network.length})`);
        const clone=state.clones[0];
        if (state.documentId&&clone?.sha256&&state.network.length>0&&state.network.length===state.provenance.length&&
            state.network.every(n=>n.completed&&(n.readback||n.readbackError))&&state.provenance.every(p=>p.completed&&p.status===200)) {
          assert.equal(page.url(),state.documentUrl,'Main-frame document changed');
          // Match public Playwright observations bijectively to protocol roles,
          // never to payload digests. An unconsumed warm SW preload is auxiliary
          // only when Chrome itself proves isLinkPreload + parser provenance.
          const matched=state.network.map(network=>{
            assert.equal(network.frameDocumentUrl,state.documentUrl);assert.equal(network.serviceWorkerOwner,false);assert.equal(network.redirectedFromUrl,null);
            const candidates=state.provenance.filter(p=>p.url===network.url&&p.method===network.method&&p.status===network.status&&
              p.resourceType.toLowerCase()===network.resourceType&&p.fromServiceWorker===network.fromServiceWorker);
            assert.equal(candidates.length,1,'Ambiguous manifest network/protocol role matching');return {network,protocol:candidates[0]!};
          });
          assert.equal(new Set(matched.map(m=>m.protocol.requestId)).size,matched.length,'Manifest protocol role was reused');
          let selected=matched[0]!,auxiliary:typeof selected|undefined;
          if (matched.length===2) {
            const fetches=matched.filter(m=>m.protocol.resourceType==='Fetch'&&m.protocol.initiatorType==='script'&&!m.protocol.isLinkPreload);
            const preloads=matched.filter(m=>m.protocol.resourceType==='Other'&&m.protocol.initiatorType==='parser'&&m.protocol.isLinkPreload&&m.protocol.initiatorUrl===state.documentUrl);
            assert.equal(fetches.length,1,'Warm manifest requires one authoritative application Fetch');
            assert.equal(preloads.length,1,'Auxiliary manifest must be an explicit parser link preload');
            selected=fetches[0]!;auxiliary=preloads[0]!;
            assert.ok(selected.network.fromServiceWorker&&auxiliary.network.fromServiceWorker,'Auxiliary manifest branch requires the observed warm service-worker path');
            assert.ok(selected.protocol.loaderId&&selected.protocol.loaderId===auxiliary.protocol.loaderId,'Manifest roles have different document loaders');
          }
          return {method:'Original application Fetch Response.clone raw bytes; no refetch or text normalization',documentUrl:state.documentUrl,mainFrame:true,
            originalFetch:{...clone},networkObservation:structuredClone(selected.network),networkProvenance:structuredClone(selected.protocol),
            ...(auxiliary?{auxiliaryPreload:structuredClone(auxiliary)}:{})};
        }
        assert.ok(Date.now()<deadline,'Original manifest Fetch/network capture did not complete');
        await new Promise(resolve=>setTimeout(resolve,10));
      }
    },
  };
}
