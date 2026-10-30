import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import v8 from 'node:v8';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {validateBytes} from 'gltf-validator';
import {validateWorldManifest,type FileRef,type WorldManifest,type Vec3} from '../../packages/world-schema/src/index.ts';
import {deliveryFile,readDeliveryFile,freshDeliveryDirectory} from './lib/delivery-city.ts';
import {deliverySha,decodeDeliverySimulation,encodeDeliverySimulation,decodeDeliveryCityGlb,deliveryCollisionBounds,embedDeliveryImages} from './lib/delivery-city-payloads.ts';
import {linkOrCopyDeliveryFile,resolveAppendDeliveryBudget,type AppendDeliveryBudget} from './lib/delivery-city-files.ts';
import {bindDeliveryProducer,verifyDeliveryProducer,publicDeliveryProducer} from './lib/delivery-city-provenance.ts';
import {readFacadeGlb} from './lib/facade-glb.ts';
import {measuredFaceKey,validateMeasuredGroundFaces,replaceMeasuredGroundCollision,replaceMeasuredGroundVisual,type MeasuredGroundFace} from './lib/delivery-measured-ground.ts';

interface Pin {path:string;sha256:string}
interface Plan {
  schemaVersion:1;world:Pin;acceptedWorld:Pin;preflight:Pin;proposal:Pin;sourceHeightReview:Pin;physicalReview:Pin;
  nativeMetadata:Pin;nativeCache:Pin;candidateCache:Pin;meshTriangles:Pin;streetParts:Pin;sourcePins:Pin[];
  release:string;delivery:AppendDeliveryBudget;
}
type ChangedFace=MeasuredGroundFace&{originalPiece:number;triangle:number;key:string};
function isZero(points:Vec3[]){
  const u=points[1]!.map((v,i)=>v-points[0]![i]!)as Vec3,w=points[2]!.map((v,i)=>v-points[0]![i]!)as Vec3;
  return (u[1]*w[2]-u[2]*w[1])===0&&(u[2]*w[0]-u[0]*w[2])===0&&(u[0]*w[1]-u[1]*w[0])===0;
}

/** Replays the bounded, explicitly reviewed correction into exact existing delivery faces.
 * It does not admit roads or expand gameplay coverage. Every other payload stays exact. */
export async function applyDeliveryMeasuredGround(planFile:string,out:string){
  const producer=bindDeliveryProducer(new URL(import.meta.url)),planBytes=fs.readFileSync(planFile);
  assert.ok(planBytes.length<=128*1024);const plan=JSON.parse(planBytes.toString())as Plan;
  assert.deepEqual(Object.keys(plan).sort(),['schemaVersion','world','acceptedWorld','preflight','proposal','sourceHeightReview','physicalReview','nativeMetadata','nativeCache','candidateCache','meshTriangles','streetParts','sourcePins','release','delivery'].sort());
  assert.equal(plan.schemaVersion,1);assert.match(plan.release,/^[a-z0-9][a-z0-9-]{0,95}$/);const budget=resolveAppendDeliveryBudget(plan.delivery),pins=new Map<string,string>();
  const read=(pin:Pin,max=64*1024*1024)=>{assert.deepEqual(Object.keys(pin).sort(),['path','sha256']);assert.match(pin.sha256,/^[a-f0-9]{64}$/);const stat=fs.lstatSync(pin.path);assert.ok(stat.isFile()&&!stat.isSymbolicLink()&&stat.size>0&&stat.size<=max,'Review input must be a bounded regular file');const bytes=fs.readFileSync(pin.path);assert.equal(deliverySha(bytes),pin.sha256,`Pinned input changed:${path.basename(pin.path)}`);pins.set(path.resolve(pin.path),pin.sha256);return bytes;};
  const json=(pin:Pin)=>JSON.parse(read(pin).toString()),world=path.resolve(plan.world.path),accepted=path.resolve(plan.acceptedWorld.path);
  const manifest=json({path:path.join(world,'manifest.json'),sha256:plan.world.sha256})as WorldManifest&{publicationFiles?:FileRef[]},baseline=json({path:path.join(accepted,'manifest.json'),sha256:plan.acceptedWorld.sha256})as WorldManifest;
  assert.deepEqual(validateWorldManifest(manifest),[]);assert.deepEqual(validateWorldManifest(baseline),[]);assert.deepEqual(manifest.origin,baseline.origin);
  const acceptedGameplay=JSON.parse(decodeDeliverySimulation(readDeliveryFile(accepted,baseline.gameplay),baseline.gameplay).toString()),preflight=json(plan.preflight),proposal=json(plan.proposal),height=json(plan.sourceHeightReview),physical=json(plan.physicalReview),metadata=json(plan.nativeMetadata);
  assert.equal(preflight.status,'PASS_EXACT_NATIVE_TO_CURRENT_DELIVERY_REBASE');assert.equal(preflight.sourceManifestSha256,plan.world.sha256);assert.equal(preflight.proposalSha256,plan.proposal.sha256);
  assert.equal(height.status,'PASS_BOUNDED_MEASURED_SOURCE_HEIGHT_COVERAGE');assert.equal(height.proposalSha256,plan.proposal.sha256);assert.deepEqual(height.failures,[]);assert.equal(height.maximumRemainingArea,0);assert.ok(height.maximumHeightError<=.2&&height.maximumSourceHeightExtensionMetres<=.001);
  assert.equal(physical.proposalSha256,plan.proposal.sha256);assert.ok(physical.proofs.length>0);for(const p of physical.proofs){assert.deepEqual(p.failures,[]);assert.equal(p.heightToleranceMetres,.2);assert.ok(p.maxHeightDeviation<=.2);}
  assert.equal(proposal.boundaryPiecewiseGeometryPreserved,true);assert.equal(proposal.nativeMetadataSha256,plan.nativeMetadata.sha256);assert.equal(preflight.nativeMetadataSha256,plan.nativeMetadata.sha256);
  for(const value of [proposal.nativeCacheSha256,preflight.nativeCacheSha256,height.originalCacheSha256,physical.originalNativeCacheSha256,metadata.cache.sha256])assert.equal(value,plan.nativeCache.sha256);
  for(const value of [proposal.cache.sha256,preflight.candidateGroundCacheSha256])assert.equal(value,plan.candidateCache.sha256);
  assert.equal(proposal.meshTrianglesSha256,plan.meshTriangles.sha256);assert.equal(height.meshTrianglesSha256,plan.meshTriangles.sha256);assert.equal(proposal.streetPartsSha256,plan.streetParts.sha256);
  read(plan.meshTriangles);read(plan.streetParts);assert.ok(Array.isArray(plan.sourcePins)&&plan.sourcePins.length>0&&plan.sourcePins.length<=32);for(const pin of plan.sourcePins)read(pin,128*1024*1024);
  const original=v8.deserialize(read(plan.nativeCache,512*1024*1024)),candidate=v8.deserialize(read(plan.candidateCache,8*1024*1024)),changes:ChangedFace[]=[],discarded:unknown[]=[];
  // Recompute exact changed faces from the pinned producer cache, rather than trusting a list.
  for(const kind of ['pieces','kerbs']as const){assert.equal(proposal.pieceMapping[kind].length,candidate[kind].length);for(const[i,originalPiece]of(proposal.pieceMapping[kind]as number[]).entries()){
    const a=original.ground[kind][originalPiece],b=candidate[kind][i];const{positions:ap,...restA}=a,{positions:bp,...restB}=b;assert.deepEqual(restA,restB);assert.equal(ap.length,bp.length);
    for(let t=0;t<a.indices.length;t+=3){const points=(p:any)=>p.indices.slice(t,t+3).map((i:number)=>p.positions.slice(i*3,i*3+3).map(Math.fround))as Vec3[],before=points(a),after=points(b);if(measuredFaceKey(before)===measuredFaceKey(after))continue;
      if(isZero(before)){assert.ok(isZero(after),'Never resurrect discarded native geometry');discarded.push({kind,originalPiece,triangle:t/3,before,after});continue;}
      changes.push({cell:a.cell,kind,originalPiece,triangle:t/3,tag:a.tag,finish:a.finish,use:a.use??'both',before,after,key:measuredFaceKey(before)});
    }
  }}
  assert.deepEqual(changes,preflight.changes);assert.deepEqual(discarded,preflight.discardedExactDegenerate);
  const acceptedBounds=acceptedGameplay.playArea;validateMeasuredGroundFaces(changes,proposal.patchRegion,[acceptedBounds.minX,acceptedBounds.minZ,acceptedBounds.maxX,acceptedBounds.maxZ]);
  const affected=new Set(changes.map(f=>f.cell));assert.ok(affected.size>0&&affected.size<=4);assert.ok([...affected].every(id=>manifest.cells.some(c=>c.id===id)));
  freshDeliveryDirectory(world,path.resolve(out),[accepted]);const written=new Map<string,FileRef>(),next:any=structuredClone(manifest),proofs:any[]=[];
  const put=(relative:string,bytes:Uint8Array)=>{assert.ok(!written.has(relative));const file=deliveryFile(out,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes,{flag:'wx'});const ref={path:relative,bytes:bytes.length,sha256:deliverySha(bytes)};written.set(relative,ref);return ref;};
  const textures=new Map((manifest.sharedTextures??[]).map(ref=>[`../${ref.path}`,ref]));
  for(const cell of next.cells){if(!affected.has(cell.id))continue;const before=manifest.cells.find(c=>c.id===cell.id)!,faces=changes.filter(f=>f.cell===cell.id),images=new Map<string,Uint8Array>(),visual:any[]=[],aliases=new Map<string,any>();
    for(const[level,ref]of Object.entries(before.visual)){
      if(aliases.has(ref.path)){cell.visual[level]=aliases.get(ref.path);continue;}const bytes=readDeliveryFile(world,ref);
      for(const image of readFacadeGlb(bytes).json.images??[]){const uri=(image as any).uri;if(uri&&!images.has(uri)){const imageRef=textures.get(uri);assert.ok(imageRef);images.set(uri,readDeliveryFile(world,imageRef));}}
      const result=await replaceMeasuredGroundVisual(bytes,await decodeDeliveryCityGlb(bytes,images),faces,level==='lod2'),validation=await validateBytes(embedDeliveryImages(result.bytes,images),{maxIssues:100});assert.equal(validation.issues.numErrors,0,JSON.stringify(validation.issues.messages));
      assert.deepEqual(readFacadeGlb(result.bytes).bin.subarray(0,readFacadeGlb(bytes).bin.length),readFacadeGlb(bytes).bin);
      const after={...ref,...put(`cells/${cell.id}.${level}.measured.${deliverySha(result.bytes).slice(0,16)}.glb`,result.bytes),triangles:result.stats.triangles,drawCalls:result.stats.drawCalls};cell.visual[level]=after;aliases.set(ref.path,after);visual.push({level,before:ref,after,matchedNativeFaces:result.matchedNativeFaces,proofs:result.proofs,validator:{errors:0,warnings:validation.issues.numWarnings}});
    }
    const result=replaceMeasuredGroundCollision(decodeDeliverySimulation(readDeliveryFile(world,before.collision),before.collision),faces),encoded=encodeDeliverySimulation(result.bytes);cell.collision={...before.collision,...put(`cells/${cell.id}.measured.${deliverySha(encoded.bytes).slice(0,16)}.hcol.gz`,encoded.bytes),compression:encoded.compression,decodedBytes:encoded.decodedBytes,decodedSha256:encoded.decodedSha256,...deliveryCollisionBounds(result.bytes,before.boundsXZ)};
    proofs.push({cell:cell.id,collision:{before:before.collision,after:cell.collision,matchedNativeFaces:result.matchedNativeFaces,proofs:result.proofs},visual});console.log(JSON.stringify({cell:cell.id,changedNativeFaces:result.matchedNativeFaces,visualTiers:visual.length}));
  }
  const publicProof={schemaVersion:1,status:'MEASURED_NATIVE_FACES_SERIALIZED_ROAD_ADMISSION_AND_RUNTIME_PENDING',kind:'bounded-source-measured-ground-correction',producer:publicDeliveryProducer(producer),planSha256:deliverySha(planBytes),sourceManifestSha256:plan.world.sha256,acceptedManifestSha256:plan.acceptedWorld.sha256,
    source:{proposalSha256:plan.proposal.sha256,sourceHeightReviewSha256:plan.sourceHeightReview.sha256,physicalReviewSha256:plan.physicalReview.sha256,preflightSha256:plan.preflight.sha256,nativeMetadataSha256:plan.nativeMetadata.sha256,nativeCacheSha256:plan.nativeCache.sha256,candidateCacheSha256:plan.candidateCache.sha256,meshTrianglesSha256:plan.meshTriangles.sha256,streetPartsSha256:plan.streetParts.sha256,additionalSourceSha256:plan.sourcePins.map(p=>p.sha256),municipalParts:proposal.sourceParts.filter((p:any)=>['58981','621603'].includes(p.id)).map((p:any)=>({id:p.id,sha256:p.sha256,name:p.properties.alueen_nimi,type:p.properties.paatyyppi,subtype:p.properties.alatyyppi,material:p.properties.materiaali}))},
    method:'Exact existing Float32 native faces retain horizontal geometry, topology, UVs and finishes. Source-reviewed upward heights replace only their delivery collision and visual vertices. Existing coincident kerb/underlay vertical offsets remain unchanged. No supported-area or road admission follows from this operation.',patchRegion:proposal.patchRegion,correctionRegion:proposal.correctionRegion,sourceAgreementMetres:proposal.sourceAgreementMetres,sourceHeight:{maximumError:height.maximumHeightError,maximumHeightInterpolationExtensionMetres:height.maximumSourceHeightExtensionMetres,roadFaces:height.proofs.length},
    licenses:[{source:'Helsinki 2021 classified LiDAR',attribution:'Helsingin kaupunkimittauspalvelut 2021',license:'CC BY 4.0'},{source:'Helsinki 2024 city mesh',attribution:'City of Helsinki 2024',license:'CC BY 4.0'}],changes,discardedExactDegenerate:discarded,proofs,preserved:{terrain:true,roads:true,gameplay:true,trees:true,acceptedInterior:true,allOtherCells:true},delivery:budget};
  assert.deepEqual(next.terrain,manifest.terrain);assert.deepEqual(next.roads,manifest.roads);assert.deepEqual(next.gameplay,manifest.gameplay);
  for(const cell of manifest.cells)if(!affected.has(cell.id))assert.deepEqual(next.cells.find((c:any)=>c.id===cell.id),cell);
  const receiptBytes=Buffer.from(JSON.stringify(publicProof)+'\n'),receipt=encodeDeliverySimulation(receiptBytes);next.publicationFiles=[...manifest.publicationFiles??[],{...put(`publication/measured-ground.${deliverySha(receiptBytes).slice(0,16)}.json.gz`,receipt.bytes),compression:receipt.compression,decodedBytes:receipt.decodedBytes,decodedSha256:receipt.decodedSha256}];next.worldReleaseId=plan.release;next.builtAt=new Date().toISOString();assert.deepEqual(validateWorldManifest(next),[]);
  const refs=new Map<string,FileRef>();function collect(v:any){if(!v||typeof v!=='object')return;if(typeof v.path==='string'&&typeof v.bytes==='number'&&typeof v.sha256==='string'){const ref={path:v.path,bytes:v.bytes,sha256:v.sha256},old=refs.get(v.path);if(old)assert.deepEqual(old,ref);refs.set(v.path,ref);}for(const child of Object.values(v))collect(child);}collect(next);
  const final=Buffer.from(JSON.stringify(next,null,1)+'\n'),worldBytes=final.length+[...refs.values()].reduce((n,r)=>n+r.bytes,0);assert.ok(budget.inclusive?worldBytes<=budget.worldBudgetBytes:worldBytes<budget.worldBudgetBytes);assert.ok(refs.size+1<10000);
  for(const ref of refs.values()){const target=deliveryFile(out,ref.path);if(!written.has(ref.path)){fs.mkdirSync(path.dirname(target),{recursive:true});linkOrCopyDeliveryFile(deliveryFile(world,ref.path),target,ref);}else assert.equal(deliverySha(fs.readFileSync(target)),ref.sha256);}
  verifyDeliveryProducer(producer);for(const[file,digest]of pins)assert.equal(deliverySha(fs.readFileSync(file)),digest);fs.writeFileSync(path.join(out,'manifest.json'),final,{flag:'wx'});
  const summary={status:publicProof.status,manifestSha256:deliverySha(final),receiptDecodedSha256:deliverySha(receiptBytes),affectedCells:[...affected].sort(),files:refs.size+1,worldBytes,sourceManifestSha256:plan.world.sha256};fs.writeFileSync(out+'.receipt.json',JSON.stringify(summary,null,2)+'\n',{flag:'wx'});return summary;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){const{values}=parseArgs({options:{plan:{type:'string'},out:{type:'string'}}});assert.ok(values.plan&&values.out,'--plan --out required');console.log(JSON.stringify(await applyDeliveryMeasuredGround(values.plan,values.out)));}
