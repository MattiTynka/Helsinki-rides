import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import v8 from 'node:v8';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {validateBytes} from 'gltf-validator';
import {validateWorldManifest,type FileRef,type WorldManifest} from '../../packages/world-schema/src/index.ts';
import {deliveryFile,readDeliveryFile,freshDeliveryDirectory} from './lib/delivery-city.ts';
import {deliverySha,decodeDeliverySimulation,encodeDeliverySimulation,decodeDeliveryCityGlb,deliveryCollisionBounds,embedDeliveryImages} from './lib/delivery-city-payloads.ts';
import {linkOrCopyDeliveryFile,resolveAppendDeliveryBudget,type AppendDeliveryBudget} from './lib/delivery-city-files.ts';
import {bindDeliveryProducer,verifyDeliveryProducer,publicDeliveryProducer} from './lib/delivery-city-provenance.ts';
import {readFacadeGlb} from './lib/facade-glb.ts';
import {replaceMeasuredGroundCollision,replaceMeasuredGroundVisual} from './lib/delivery-measured-ground.ts';

import {readReviewedRoadGradeAuthoring,assertReviewedRoadGradeFaces,assertReviewedRoadGradeSerializedCollision} from './lib/reviewed-road-grade-authoring.ts';
import {replayAuthoredRoadGradeDelta} from './lib/authored-road-grade-replay.ts';
import {EHRENSTROM_AUTHORING_REVIEW_SHA256,readReviewedEhrenstromRoadGrade,assertReviewedEhrenstromParent,assertReviewedEhrenstromFaces,replayReviewedEhrenstromTerrain,assertReviewedEhrenstromCollision} from './lib/reviewed-ehrenstrom-road-grade.ts';
interface Pin {path:string;sha256:string}
interface Plan {schemaVersion:1;world:Pin;acceptedWorld:Pin;authoringReview:Pin;nativeMetadata:Pin;nativeCache:Pin;candidateCache:Pin;release:string;delivery:AppendDeliveryBudget}
/** Replays the bounded, explicitly reviewed correction into exact existing delivery faces.
 * It does not admit roads or expand gameplay coverage. Every other payload stays exact. */
export async function applyDeliveryAuthoredRoadGrade(planFile:string,out:string){
  const producer=bindDeliveryProducer(new URL(import.meta.url)),planBytes=fs.readFileSync(planFile);
  assert.ok(planBytes.length<=128*1024);const plan=JSON.parse(planBytes.toString())as Plan;
  assert.deepEqual(Object.keys(plan).sort(),['schemaVersion','world','acceptedWorld','authoringReview','nativeMetadata','nativeCache','candidateCache','release','delivery'].sort());
  assert.equal(plan.schemaVersion,1);assert.match(plan.release,/^[a-z0-9][a-z0-9-]{0,95}$/);const budget=resolveAppendDeliveryBudget(plan.delivery),pins=new Map<string,string>();
  const read=(pin:Pin,max=64*1024*1024)=>{assert.deepEqual(Object.keys(pin).sort(),['path','sha256']);assert.match(pin.sha256,/^[a-f0-9]{64}$/);const stat=fs.lstatSync(pin.path);assert.ok(stat.isFile()&&!stat.isSymbolicLink()&&stat.size>0&&stat.size<=max,'Review input must be a bounded regular file');const bytes=fs.readFileSync(pin.path);assert.equal(deliverySha(bytes),pin.sha256,`Pinned input changed:${path.basename(pin.path)}`);pins.set(path.resolve(pin.path),pin.sha256);return bytes;};
  const json=(pin:Pin)=>JSON.parse(read(pin).toString()),world=path.resolve(plan.world.path),accepted=path.resolve(plan.acceptedWorld.path);
  const manifest=json({path:path.join(world,'manifest.json'),sha256:plan.world.sha256})as WorldManifest&{publicationFiles?:FileRef[]},baseline=json({path:path.join(accepted,'manifest.json'),sha256:plan.acceptedWorld.sha256})as WorldManifest;
  assert.deepEqual(validateWorldManifest(manifest),[]);assert.deepEqual(validateWorldManifest(baseline),[]);assert.deepEqual(manifest.origin,baseline.origin);
  const acceptedGameplay=JSON.parse(decodeDeliverySimulation(readDeliveryFile(accepted,baseline.gameplay),baseline.gameplay).toString());
  const reviewPin={file:plan.authoringReview.path,sha256:plan.authoringReview.sha256},readReview=(pin:{file:string;sha256:string},cap?:number)=>read({path:pin.file,sha256:pin.sha256},cap);
  const ehren=plan.authoringReview.sha256===EHRENSTROM_AUTHORING_REVIEW_SHA256?readReviewedEhrenstromRoadGrade(reviewPin,readReview):null;
  const telakka=ehren?null:readReviewedRoadGradeAuthoring(reviewPin,readReview),bound=ehren??telakka!;
  const {review,proposal,preflight}=bound,metadata=json(plan.nativeMetadata);
  assert.equal(review.sourceWorld.manifestSha256,plan.world.sha256);
  if(ehren)assertReviewedEhrenstromParent(ehren.authority,manifest);else assert.equal(preflight.sourceManifestSha256,plan.world.sha256);
  assert.equal(proposal.nativeMetadataSha256,plan.nativeMetadata.sha256);assert.equal(preflight.nativeMetadataSha256,plan.nativeMetadata.sha256);
  for(const value of [proposal.nativeCacheSha256,preflight.nativeCacheSha256,metadata.cache.sha256])assert.equal(value,plan.nativeCache.sha256);
  for(const value of [proposal.cache.sha256,preflight.candidateGroundCacheSha256])assert.equal(value,plan.candidateCache.sha256);
  const original=v8.deserialize(read(plan.nativeCache,512*1024*1024)),candidate=v8.deserialize(read(plan.candidateCache,8*1024*1024)),replay=replayAuthoredRoadGradeDelta(original.ground,candidate,proposal.pieceMapping),changes=replay.changes,discarded=replay.discardedExactDegenerate;
  assert.deepEqual(changes,preflight.changes);assert.deepEqual(discarded,preflight.discardedExactDegenerate);
  if(ehren){assert.equal(proposal.witnesses.length,121);assert.equal(replay.coincidentGroups.length,119);}
  const terrainBytes=decodeDeliverySimulation(readDeliveryFile(world,manifest.terrain),manifest.terrain),acceptedBounds=acceptedGameplay.playArea;
  const acceptedRectangle=[acceptedBounds.minX,acceptedBounds.minZ,acceptedBounds.maxX,acceptedBounds.maxZ];
  const approvedScope=ehren?assertReviewedEhrenstromFaces(ehren.authority,changes,proposal.patchRegion,acceptedRectangle,deliverySha(terrainBytes)):assertReviewedRoadGradeFaces(telakka!.authority,changes,proposal.patchRegion,acceptedRectangle,deliverySha(terrainBytes));
  const terrainPatch=ehren?replayReviewedEhrenstromTerrain(ehren.authority,terrainBytes,ehren.terrainProposal.changes):null;
  const affected=new Set(changes.map(f=>f.cell));assert.ok(affected.size>0&&affected.size<=4);assert.ok([...affected].every(id=>manifest.cells.some(c=>c.id===id)));
  freshDeliveryDirectory(world,path.resolve(out),[accepted]);const written=new Map<string,FileRef>(),next:any=structuredClone(manifest),proofs:any[]=[];
  const put=(relative:string,bytes:Uint8Array)=>{assert.ok(!written.has(relative));const file=deliveryFile(out,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes,{flag:'wx'});const ref={path:relative,bytes:bytes.length,sha256:deliverySha(bytes)};written.set(relative,ref);return ref;};
  if(terrainPatch){const encoded=encodeDeliverySimulation(terrainPatch.bytes);next.terrain={...manifest.terrain,...put(`terrain.authored-grade.${deliverySha(encoded.bytes).slice(0,16)}.bin.gz`,encoded.bytes),compression:encoded.compression,decodedBytes:encoded.decodedBytes,decodedSha256:encoded.decodedSha256};}
  const textures=new Map((manifest.sharedTextures??[]).map(ref=>[`../${ref.path}`,ref]));
  for(const cell of next.cells){if(!affected.has(cell.id))continue;const before=manifest.cells.find(c=>c.id===cell.id)!,faces=changes.filter(f=>f.cell===cell.id),images=new Map<string,Uint8Array>(),visual:any[]=[],aliases=new Map<string,any>();
    for(const[level,ref]of Object.entries(before.visual)){
      if(aliases.has(ref.path)){cell.visual[level]=aliases.get(ref.path);continue;}const bytes=readDeliveryFile(world,ref);
      for(const image of readFacadeGlb(bytes).json.images??[]){const uri=(image as any).uri;if(uri&&!images.has(uri)){const imageRef=textures.get(uri);assert.ok(imageRef);images.set(uri,readDeliveryFile(world,imageRef));}}
      const result=await replaceMeasuredGroundVisual(bytes,await decodeDeliveryCityGlb(bytes,images),faces,level==='lod2'),validation=await validateBytes(embedDeliveryImages(result.bytes,images),{maxIssues:100});assert.equal(validation.issues.numErrors,0,JSON.stringify(validation.issues.messages));
      assert.deepEqual(readFacadeGlb(result.bytes).bin.subarray(0,readFacadeGlb(bytes).bin.length),readFacadeGlb(bytes).bin);
      const after={...ref,...put(`cells/${cell.id}.${level}.authored-grade.${deliverySha(result.bytes).slice(0,16)}.glb`,result.bytes),triangles:result.stats.triangles,drawCalls:result.stats.drawCalls};cell.visual[level]=after;aliases.set(ref.path,after);visual.push({level,before:ref,after,matchedNativeFaces:result.matchedNativeFaces,proofs:result.proofs,validator:{errors:0,warnings:validation.issues.numWarnings}});
    }
    const result=replaceMeasuredGroundCollision(decodeDeliverySimulation(readDeliveryFile(world,before.collision),before.collision),faces);
    if(ehren)assertReviewedEhrenstromCollision(ehren.authority,cell.id,result.bytes);else assertReviewedRoadGradeSerializedCollision(telakka!.authority,cell.id,result.bytes);
    const encoded=encodeDeliverySimulation(result.bytes);cell.collision={...before.collision,...put(`cells/${cell.id}.authored-grade.${deliverySha(encoded.bytes).slice(0,16)}.hcol.gz`,encoded.bytes),compression:encoded.compression,decodedBytes:encoded.decodedBytes,decodedSha256:encoded.decodedSha256,...deliveryCollisionBounds(result.bytes,before.boundsXZ)};
    proofs.push({cell:cell.id,collision:{before:before.collision,after:cell.collision,matchedNativeFaces:result.matchedNativeFaces,proofs:result.proofs},visual});console.log(JSON.stringify({cell:cell.id,changedNativeFaces:result.matchedNativeFaces,visualTiers:visual.length}));
  }
  const publicProof={schemaVersion:1,status:'AUTHORED_NATIVE_ROAD_GRADE_SERIALIZED_ADMISSION_AND_RUNTIME_PENDING',kind:'bounded-source-crossfall-road-authoring',producer:publicDeliveryProducer(producer),planSha256:deliverySha(planBytes),sourceManifestSha256:plan.world.sha256,acceptedManifestSha256:plan.acceptedWorld.sha256,approvedScope,
    source:{authoringReviewSha256:plan.authoringReview.sha256,proposalSha256:review.proposal.sha256,preflightSha256:review.preflight.sha256,physicalReviewSha256:review.physical.sha256,nativeMetadataSha256:plan.nativeMetadata.sha256,nativeCacheSha256:plan.nativeCache.sha256,candidateCacheSha256:plan.candidateCache.sha256,inputs:review.sourceInputs.map((p:any)=>({sha256:p.sha256})),municipalParts:proposal.sourceParts.map((p:any)=>({id:p.id,sha256:p.sha256,name:p.properties.alueen_nimi,type:p.properties.paatyyppi,subtype:p.properties.alatyyppi,material:p.properties.materiaali}))},
    method:review.interpretation,authoring:review.authoring,validation:review.validation,patchRegion:proposal.patchRegion,correctionRegion:proposal.correctionRegion,licenses:[{source:'Helsinki 2024 city mesh',attribution:'City of Helsinki 2024',license:'CC BY 4.0'}],changes,discardedExactDegenerate:discarded,coincidentGroups:replay.coincidentGroups,proofs,...(terrainPatch?{terrainAuthoring:terrainPatch.proof}:{}),...(ehren?{nativeReplay:{reviewedCandidateXZGroups:121,actualNonzeroXZGroups:119,changedFaceRecords:changes.length,discardedExactDegenerateRecords:discarded.length,explanation:'Two reviewed candidate groups retreat to zero; the complete literal sealed face delta is unchanged.'}}:{}),preserved:{terrain:terrainPatch===null,roads:true,gameplay:true,trees:true,acceptedInterior:true,allOtherCells:true,nativeIndicesUVsFinishesAndCoincidentOffsets:replay.nativeIndicesUVsFinishesAndCoincidentOffsetsPreserved},delivery:budget};
  if(!terrainPatch)assert.deepEqual(next.terrain,manifest.terrain);else assert.equal(next.terrain.decodedSha256,terrainPatch.proof.afterDecodedSha256);
  assert.deepEqual(next.roads,manifest.roads);assert.deepEqual(next.gameplay,manifest.gameplay);
  for(const cell of manifest.cells)if(!affected.has(cell.id))assert.deepEqual(next.cells.find((c:any)=>c.id===cell.id),cell);
  const receiptBytes=Buffer.from(JSON.stringify(publicProof)+'\n'),receipt=encodeDeliverySimulation(receiptBytes);next.publicationFiles=[...manifest.publicationFiles??[],{...put(`publication/authored-road-grade.${deliverySha(receiptBytes).slice(0,16)}.json.gz`,receipt.bytes),compression:receipt.compression,decodedBytes:receipt.decodedBytes,decodedSha256:receipt.decodedSha256}];next.worldReleaseId=plan.release;next.builtAt=new Date().toISOString();assert.deepEqual(validateWorldManifest(next),[]);
  const refs=new Map<string,FileRef>();function collect(v:any){if(!v||typeof v!=='object')return;if(typeof v.path==='string'&&typeof v.bytes==='number'&&typeof v.sha256==='string'){const ref={path:v.path,bytes:v.bytes,sha256:v.sha256},old=refs.get(v.path);if(old)assert.deepEqual(old,ref);refs.set(v.path,ref);}for(const child of Object.values(v))collect(child);}collect(next);
  const final=Buffer.from(JSON.stringify(next,null,1)+'\n'),worldBytes=final.length+[...refs.values()].reduce((n,r)=>n+r.bytes,0);assert.ok(budget.inclusive?worldBytes<=budget.worldBudgetBytes:worldBytes<budget.worldBudgetBytes);assert.ok(refs.size+1<10000);
  for(const ref of refs.values()){const target=deliveryFile(out,ref.path);if(!written.has(ref.path)){fs.mkdirSync(path.dirname(target),{recursive:true});linkOrCopyDeliveryFile(deliveryFile(world,ref.path),target,ref);}else assert.equal(deliverySha(fs.readFileSync(target)),ref.sha256);}
  verifyDeliveryProducer(producer);for(const[file,digest]of pins)assert.equal(deliverySha(fs.readFileSync(file)),digest);fs.writeFileSync(path.join(out,'manifest.json'),final,{flag:'wx'});
  const summary={status:publicProof.status,manifestSha256:deliverySha(final),receiptDecodedSha256:deliverySha(receiptBytes),affectedCells:[...affected].sort(),files:refs.size+1,worldBytes,sourceManifestSha256:plan.world.sha256};fs.writeFileSync(out+'.receipt.json',JSON.stringify(summary,null,2)+'\n',{flag:'wx'});return summary;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){const{values}=parseArgs({options:{plan:{type:'string'},out:{type:'string'}}});assert.ok(values.plan&&values.out,'--plan --out required');console.log(JSON.stringify(await applyDeliveryAuthoredRoadGrade(values.plan,values.out)));}
