import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {assertSupportedAreaPreservesAccepted,readQualifiedSupportedArea} from '../lib/delivery-supported-area.ts';
import {deliverySha} from '../lib/delivery-city-payloads.ts';
import type {SupportedArea} from '../../../packages/world-schema/src/index.ts';
const old={playArea:{minX:0,minZ:0,maxX:10,maxZ:10}},expanded={minX:0,minZ:0,maxX:12,maxZ:12};
const next:SupportedArea={schemaVersion:1,regions:[{id:'accepted-and-south',outer:[[0,0],[10,0],[10,10],[12,10],[12,12],[0,12]]}]};
test('supported-area attachment proves continuous accepted geometry containment rather than checking sampled corners',()=>{
 assert.doesNotThrow(()=>assertSupportedAreaPreservesAccepted(next,old,expanded));
 const smallHole:SupportedArea={schemaVersion:1,regions:[{...next.regions[0]!,holes:[[[4,4],[4.001,4],[4.001,4.001],[4,4.001]]]}]};assert.throws(()=>assertSupportedAreaPreservesAccepted(smallHole,old,expanded),/removes accepted/);
 const priorMask:SupportedArea={schemaVersion:1,regions:[{id:'old',outer:[[0,0],[10,0],[10,10],[0,10]],holes:[[[4,4],[4.001,4],[4.001,4.001],[4,4.001]]]}]};assert.doesNotThrow(()=>assertSupportedAreaPreservesAccepted(smallHole,{...old,supportedArea:priorMask},expanded));
 assert.throws(()=>assertSupportedAreaPreservesAccepted({...next,regions:[{id:'bad',outer:[[0,0],[10,10],[10,0],[0,10]]}]},old,expanded),/Invalid/);
});
test('supported-area review binds accepted world and exact source evidence, and rejects changed evidence',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'helsinki-supported-area-'));try{
  const source=Buffer.from('qualified geometry evidence'),sourceFile=path.join(root,'source.json');fs.writeFileSync(sourceFile,source);const document={schemaVersion:1,kind:'qualified-expansion-supported-area',acceptedManifestSha256:'a'.repeat(64),originId:'fixture',qualification:{status:'PASS_SOURCE_QUALIFIED_SUPPORTED_AREA'},sourceFiles:[{path:sourceFile,bytes:source.length,sha256:deliverySha(source)}],supportedArea:next},bytes=Buffer.from(JSON.stringify(document)),file=path.join(root,'review.json');fs.writeFileSync(file,bytes);
  const ref={path:file,sha256:deliverySha(bytes)},accepted={manifestSha256:'a'.repeat(64),originId:'fixture',gameplay:old},read=()=>readQualifiedSupportedArea(ref,accepted,expanded);assert.deepEqual(read().supportedArea,next);assert.equal(read().proof.acceptedPlayableGeometryPreserved,true);
  assert.throws(()=>readQualifiedSupportedArea(ref,{...accepted,manifestSha256:'b'.repeat(64)},expanded));fs.writeFileSync(sourceFile,Buffer.alloc(source.length));assert.throws(read,/source changed/);
 }finally{assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(root).startsWith('helsinki-supported-area-'));fs.rmSync(root,{recursive:true,force:true});}
});
