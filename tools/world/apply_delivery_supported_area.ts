// A qualified coverage-only derivative. Roads and every visual/physical asset stay exact.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {validateGameplayBundle,validateWorldManifest,type WorldManifest,type FileRef,type GameplayBundle} from '../../packages/world-schema/src/index.ts';
import {readQualifiedSupportedArea,assertSupportedAreaPreservesAccepted} from './lib/delivery-supported-area.ts';
import {deliverySha,decodeDeliverySimulation} from './lib/delivery-city-payloads.ts';
import {deliveryFile,readDeliveryFile,freshDeliveryDirectory} from './lib/delivery-city.ts';
import {linkOrCopyDeliveryFile,resolveAppendDeliveryBudget,type AppendDeliveryBudget} from './lib/delivery-city-files.ts';
import {bindDeliveryProducer,verifyDeliveryProducer,publicDeliveryProducer} from './lib/delivery-city-provenance.ts';

interface Pin{path:string;sha256:string}
export interface SupportedAreaPatchPlan{
  schemaVersion:1;world:Pin;acceptedWorld:Pin;supportedArea:Pin;roadMerge:Pin;
  release:string;delivery:AppendDeliveryBudget;
}
type MutableManifest={-readonly [K in keyof WorldManifest]:WorldManifest[K]}&{publicationFiles?:FileRef[]};
function pinnedFile(pin:Pin,maxBytes=64*1024*1024){
  assert.match(pin.sha256,/^[a-f0-9]{64}$/);const info=fs.lstatSync(pin.path);
  assert.ok(info.isFile()&&!info.isSymbolicLink()&&info.size>0&&info.size<=maxBytes,'Pinned review input must be a bounded regular file');
  const bytes=fs.readFileSync(pin.path);assert.equal(deliverySha(bytes),pin.sha256,'Pinned coverage input changed');return bytes;
}
export function applyDeliverySupportedArea(planFile:string,out:string){
  const producer=bindDeliveryProducer(new URL(import.meta.url)),planBytes=fs.readFileSync(planFile);
  assert.ok(planBytes.length<=64*1024,'Coverage patch plan exceeds64KiB');const plan=JSON.parse(planBytes.toString()) as SupportedAreaPatchPlan;
  assert.deepEqual(Object.keys(plan).sort(),['acceptedWorld','delivery','release','roadMerge','schemaVersion','supportedArea','world'].sort());
  assert.equal(plan.schemaVersion,1);assert.match(plan.release,/^[a-z0-9][a-z0-9-]{0,95}$/);
  const delivery=resolveAppendDeliveryBudget(plan.delivery),world=path.resolve(plan.world.path),accepted=path.resolve(plan.acceptedWorld.path);
  const currentBytes=pinnedFile({path:path.join(world,'manifest.json'),sha256:plan.world.sha256});
  const acceptedBytes=pinnedFile({path:path.join(accepted,'manifest.json'),sha256:plan.acceptedWorld.sha256});
  const manifest=JSON.parse(currentBytes.toString()) as WorldManifest,baseline=JSON.parse(acceptedBytes.toString()) as WorldManifest;
  assert.deepEqual(validateWorldManifest(manifest),[]);assert.deepEqual(validateWorldManifest(baseline),[]);assert.equal(manifest.origin.id,baseline.origin.id);
  const gameplay=JSON.parse(decodeDeliverySimulation(readDeliveryFile(world,manifest.gameplay),manifest.gameplay).toString()) as GameplayBundle;
  const acceptedGameplay=JSON.parse(decodeDeliverySimulation(readDeliveryFile(accepted,baseline.gameplay),baseline.gameplay).toString()) as GameplayBundle;
  assert.deepEqual(validateGameplayBundle(gameplay),[]);
  const qualified=readQualifiedSupportedArea(plan.supportedArea,{manifestSha256:plan.acceptedWorld.sha256,originId:manifest.origin.id,gameplay:acceptedGameplay},gameplay.playArea);
  assertSupportedAreaPreservesAccepted(qualified.supportedArea,gameplay,gameplay.playArea);
  const merge=JSON.parse(pinnedFile(plan.roadMerge).toString());
  assert.equal(merge.status,'PASS_SOURCE_QUALIFIED_ROAD_MERGE_PENDING_RUNTIME');
  assert.equal(merge.acceptedManifestSha256,plan.acceptedWorld.sha256);
  assert.equal(merge.expandedSupportedAreaSha256,plan.supportedArea.sha256);
  assert.equal(merge.acceptedPlayablePiecewiseGeometryPreserved,true);
  assert.equal(merge.mergedRoadsSha256,deliverySha(decodeDeliverySimulation(readDeliveryFile(world,manifest.roads),manifest.roads)),'Coverage-only patch cannot replace the qualified road graph');
  const nextGameplay={...gameplay,supportedArea:qualified.supportedArea};assert.deepEqual(validateGameplayBundle(nextGameplay),[]);
  const next=structuredClone(manifest) as MutableManifest,written=new Map<string,FileRef>();
  freshDeliveryDirectory(world,path.resolve(out),[accepted]);
  const put=(relative:string,bytes:Uint8Array)=>{
    const ref={path:relative,bytes:bytes.length,sha256:deliverySha(bytes)},target=deliveryFile(out,relative);
    assert.ok(!written.has(relative));fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes,{flag:'wx'});written.set(relative,ref);return ref;
  };
  const payload=Buffer.from(JSON.stringify(nextGameplay)+'\n');
  next.gameplay=put(`gameplay.coverage.${deliverySha(payload).slice(0,16)}.json`,payload);
  next.worldReleaseId=plan.release;next.builtAt=new Date().toISOString();
  const proof={schemaVersion:1,kind:'qualified-delivery-supported-area-patch',status:'SOURCE_NATIVE_QUALIFIED_PENDING_REAL_CONTROLS',
    producer:publicDeliveryProducer(producer),planSha256:deliverySha(planBytes),sourceManifestSha256:plan.world.sha256,acceptedManifestSha256:plan.acceptedWorld.sha256,
    previousSupportedAreaSha256:deliverySha(JSON.stringify(gameplay.supportedArea??null)),supportedAreaReviewSha256:plan.supportedArea.sha256,roadMergeSha256:plan.roadMerge.sha256,
    qualification:qualified.proof,preserved:{oldSupportedGeometry:true,roads:true,visuals:true,collision:true,terrain:true,trees:true,addressesAndGameplayFields:true},delivery};
  const receiptBytes=Buffer.from(JSON.stringify(proof)+'\n');
  next.publicationFiles=[...next.publicationFiles??[],put(`publication/supported-area.${deliverySha(receiptBytes).slice(0,16)}.json`,receiptBytes)];
  assert.deepEqual(validateWorldManifest(next),[]);
  const refs=new Map<string,FileRef>();
  const collect=(value:unknown)=>{
    if(!value||typeof value!=='object')return;const record=value as Record<string,unknown>;
    if(typeof record.path==='string'&&typeof record.bytes==='number'&&typeof record.sha256==='string'){
      const ref={path:record.path,bytes:record.bytes,sha256:record.sha256},prior=refs.get(ref.path);if(prior)assert.deepEqual(prior,ref);else refs.set(ref.path,ref);
    }
    for(const child of Object.values(record))if(child&&typeof child==='object')collect(child);
  };
  collect(next);
  for(const ref of refs.values())if(!written.has(ref.path)){
    const source=deliveryFile(world,ref.path),target=deliveryFile(out,ref.path);fs.mkdirSync(path.dirname(target),{recursive:true});linkOrCopyDeliveryFile(source,target,ref);written.set(ref.path,ref);
  }
  verifyDeliveryProducer(producer);assert.equal(deliverySha(fs.readFileSync(path.join(world,'manifest.json'))),plan.world.sha256);
  const final=Buffer.from(JSON.stringify(next,null,1)+'\n'),worldBytes=final.length+[...written.values()].reduce((sum,ref)=>sum+ref.bytes,0);
  assert.ok(delivery.inclusive?worldBytes<=delivery.worldBudgetBytes:worldBytes<delivery.worldBudgetBytes,'Coverage derivative exceeds explicit world budget');
  assert.ok(written.size+1<10000,'Coverage derivative exceeds file budget');
  fs.writeFileSync(path.join(out,'manifest.json'),final,{flag:'wx'});
  return{status:proof.status,manifestSha256:deliverySha(final),worldBytes,files:written.size+1,proof};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const{values}=parseArgs({options:{plan:{type:'string'},out:{type:'string'}}});assert.ok(values.plan&&values.out,'--plan --out required');console.log(JSON.stringify(applyDeliverySupportedArea(values.plan,values.out)));
}
