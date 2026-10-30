import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import type {Response} from 'playwright';
import {createLoadedResponseCapture} from '../lib/loaded-responses.ts';
const url='http://127.0.0.1/world/fixture/manifest.json';
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
function response(options:{url?:string;status?:number;type?:string;body?:Buffer;length?:string;finished?:Error|null;onBody?:()=>void}={}) {
  return {url:()=>options.url??url,status:()=>options.status??200,request:()=>({resourceType:()=>options.type??'fetch'}),headers:()=>options.length===undefined?{}:{'content-length':options.length},finished:async()=>options.finished??null,body:async()=>{options.onBody?.();return options.body??Buffer.from('original bytes');}} as unknown as Response;
}
test('loaded response identity requires one original completed200, caches bytes and ignores unrelated resources',async()=>{
  const capture=createLoadedResponseCapture({maxResponses:2});let reads=0;
  capture.observe(response({body:Buffer.from('original'),onBody:()=>reads++}));
  for(let i=0;i<10;i++)capture.observe(response({url:`http://127.0.0.1/image${i}.png`,type:'image'}));
  assert.equal(await capture.sha256(url+'#ignored-request-fragment'),sha(Buffer.from('original')));assert.equal(await capture.sha256(url),sha(Buffer.from('original')));assert.equal(reads,1);
  await assert.rejects(capture.sha256('http://127.0.0.1/not-loaded.js'),/Exactly one original/);
  capture.observe(response());await assert.rejects(capture.sha256(url),/Exactly one original/);
  const errorStatus=createLoadedResponseCapture();errorStatus.observe(response({status:404}));await assert.rejects(errorStatus.sha256(url),/Exactly one original/);
  const incomplete=createLoadedResponseCapture();incomplete.observe(response({finished:new Error('aborted')}));await assert.rejects(incomplete.sha256(url),/did not complete/);
});
test('identity listener and decoded-body limits fail closed, including ambiguity during body read',async()=>{
  const capture=createLoadedResponseCapture({maxResponses:1});capture.observe(response());capture.observe(response({url:'http://127.0.0.1/main.js',type:'script'}));assert.ok(capture.error());await assert.rejects(capture.sha256(url),/response limit/);
  let reads=0;const announced=createLoadedResponseCapture({maxBodyBytes:4});announced.observe(response({length:'5',onBody:()=>reads++}));await assert.rejects(announced.sha256(url),/body byte limit/);assert.equal(reads,0);
  const decoded=createLoadedResponseCapture({maxBodyBytes:4});decoded.observe(response({length:'2',body:Buffer.alloc(5)}));await assert.rejects(decoded.sha256(url),/decoded body/);
  const concurrent=createLoadedResponseCapture();concurrent.observe(response({onBody:()=>concurrent.observe(response())}));await assert.rejects(concurrent.sha256(url),/became ambiguous/);
});

test('original bodies are hashed before delayed identity lookup and cumulative failures are observed eagerly',async()=>{
  let evicted=false,reads=0;const original=Buffer.from('before-eviction'),capture=createLoadedResponseCapture();
  capture.observe(response({body:original,onBody:()=>{assert.equal(evicted,false,'Original response was read too late');reads++;}}));
  await new Promise(resolve=>setImmediate(resolve));assert.equal(reads,1);evicted=true;
  assert.equal(await capture.sha256(url),sha(original));assert.equal(reads,1);
  const errors:Error[]=[],bounded=createLoadedResponseCapture({maxBodyBytes:8,maxTotalBodyBytes:10,onError:error=>errors.push(error)});
  bounded.observe(response({body:Buffer.alloc(6)}));bounded.observe(response({url:'http://127.0.0.1/main.js',type:'script',body:Buffer.alloc(6)}));
  await new Promise(resolve=>setImmediate(resolve));assert.equal(errors.length,1);assert.match(errors[0]!.message,/cumulative/);
  await assert.rejects(bounded.sha256(url),/cumulative/);
});
