import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {parseArgs} from 'node:util';
import {validateBytes} from 'gltf-validator';
import {parseCollisionBundle,validateWorldManifest,type FileRef} from '../../packages/world-schema/src/index.ts';
import {freshDeliveryDirectory,readDeliveryFile,deliveryFile} from './lib/delivery-city.ts';
import {deliverySha,decodeDeliveryCityGlb,decodeDeliverySimulation,encodeDeliverySimulation,deliveryCollisionBounds,embedDeliveryImages} from './lib/delivery-city-payloads.ts';
import {buildCoastalMask} from './lib/coastal-mask.ts';
import {deliveryCoastalAuthorityPlan,deliveryBankPieces} from './lib/delivery-coastal-banks.ts';
import {restoreInlandVisual} from './lib/delivery-inland-water-visual.ts';
import {appendInlandCollision} from './lib/delivery-inland-water.ts';
import {bindDeliveryProducer,verifyDeliveryProducer,publicDeliveryProducer} from './lib/delivery-city-provenance.ts';
import type {ShoreMesh} from './lib/coastal-shore-seals.ts';

const{values:o}=parseArgs({options:{world:{type:'string'},'manifest-sha256':{type:'string'},osm:{type:'string'},profile:{type:'string'},'profile-sha256':{type:'string'},'retained-water':{type:'string'},'retained-water-sha256':{type:'string'},out:{type:'string'},release:{type:'string'}}});
for(const k of['world','manifest-sha256','osm','profile','profile-sha256','out','release'] as const)assert.ok(o[k],`--${k} required`);
const producer=bindDeliveryProducer(new URL(import.meta.url)),mb=fs.readFileSync(path.join(o.world!,'manifest.json'));assert.equal(deliverySha(mb),o['manifest-sha256']);const m=JSON.parse(mb.toString());assert.deepEqual(validateWorldManifest(m),[]);
const pb=fs.readFileSync(o.profile!);assert.equal(deliverySha(pb),o['profile-sha256']);const profile=JSON.parse(pb.toString());assert.equal(profile.kind,'native-new-strip-coastal-bank-closure');assert.deepEqual(profile.regionXZ,[-1792,-2304,800,-1152]);assert.equal(profile.waterY,-7.5);
const ob=fs.readFileSync(o.osm!);assert.equal(deliverySha(ob),profile.sourceOsmSha256);const osm=JSON.parse(ob.toString());
const inlandRef=m.publicationFiles.find((r:any)=>r.path==='publication/inland-water-profile.json');assert.ok(inlandRef,'Apply inland separation first');assert.equal(inlandRef.sha256,profile.inlandProfileSha256);const inland=JSON.parse(readDeliveryFile(o.world!,inlandRef).toString());
const selected=new Set(inland.bodies.map((b:any)=>b.type+'/'+b.id)),source={elements:osm.elements.map((e:any)=>{if(!selected.has(e.type+'/'+e.id))return e;const tags={...e.tags};delete tags.natural;delete tags.waterway;return{...e,tags};})};
assert.equal(Boolean(o['retained-water']),Boolean(o['retained-water-sha256']),'Explicit water classification needs both path and hash');
const retainedRef=m.publicationFiles.find((r:any)=>r.path===(o['retained-water']??'publication/inland-retained-coastal-report.json'));assert.ok(retainedRef&&retainedRef.bytes<=8_000_000,'Pinned repaired water classification required');if(o['retained-water-sha256'])assert.equal(retainedRef.sha256,o['retained-water-sha256']);
const retained=JSON.parse(readDeliveryFile(o.world!,retainedRef).toString());assert.equal(retained.kind,'inland-separated-coastal-classification');assert.equal(retained.profileSha256,inlandRef.sha256);assert.equal(retained.nativeMetadataSha256,inland.nativeMetadataSha256);assert.equal(retained.coastal.waterY,profile.waterY);
if(retained.nativeShore){assert.ok(o['retained-water-sha256'],'Native shoreline classification must be explicitly pinned');assert.equal(m.publicationFiles.find((r:any)=>r.path==='publication/native-shore-profile.json')?.sha256,retained.nativeShore.profileSha256);assert.equal(m.publicationFiles.find((r:any)=>r.path==='publication/inland-retained-coastal-report.json')?.sha256,retained.nativeShore.previousRetainedWaterSha256);}
const area={minX:profile.regionXZ[0],minZ:profile.regionXZ[1],maxX:profile.regionXZ[2],maxZ:768};assert.deepEqual(retained.coastal.mask.area,area,'Coast and tree classification must use the same actual world domain');
// Shore closure and tree registration share the inland repair's exact retained
// union, including independently overlapping water protected by that repair.
const mask={...buildCoastalMask(source,{area,originProjected:m.origin.originProjected}),water:retained.coastal.mask.water},authorityPlan=deliveryCoastalAuthorityPlan(mask.water,area,profile.regionXZ),authority=authorityPlan.segments;
const images=new Map<string,Uint8Array>(m.sharedTextures.map((r:any)=>['../'+r.path,readDeliveryFile(o.world!,r)]));freshDeliveryDirectory(o.world!,o.out!);
const put=(name:string,bytes:Uint8Array)=>{const file=deliveryFile(o.out!,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes,{flag:'wx'});return{path:name,bytes:bytes.length,sha256:deliverySha(bytes)};};
const final=structuredClone(m),proofs:any[]=[],validations:any[]=[];
const key=(P:number[][])=>P.map(p=>p.join(',')).sort().join('|');
for(const cell of final.cells){
  const B=cell.boundsXZ;if(B[1]>=profile.regionXZ[3])continue;
  const shores=authority.filter(s=>Math.min(s.a[0],s.b[0])<=B[2]+.001&&Math.max(s.a[0],s.b[0])>=B[0]-.001&&Math.min(s.a[1],s.b[1])<=B[3]+.001&&Math.max(s.a[1],s.b[1])>=B[1]-.001);if(!shores.length)continue;
  const old=m.cells.find((c:any)=>c.id===cell.id),doc=await decodeDeliveryCityGlb(readDeliveryFile(o.world!,old.visual.lod0),images),meshes:ShoreMesh[]=[];
  for(const node of doc.getRoot().listNodes())if(node.getMesh()&&/_ground_(?:frontier_)?(asphalt|setts|cobble|slabs|gravel|grass|yard)$/.test(node.getName())){
    assert.deepEqual(node.getWorldMatrix(),[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);for(const[i,p]of node.getMesh()!.listPrimitives().entries()){const positions=p.getAttribute('POSITION')!.getArray();assert.ok(positions instanceof Float32Array,'Native bank authority must use decoded Float32 positions');meshes.push({cell:cell.id,primitiveName:node.getName(),primitiveIndex:i,positions,indices:Uint32Array.from(p.getIndices()!.getArray()!)});}
  }
  const raw=decodeDeliverySimulation(readDeliveryFile(o.world!,old.collision),old.collision),bundle=parseCollisionBundle(raw),collisionKeys=new Set<string>();
  for(const collider of bundle.colliders)if(collider.group==='ground'||collider.group==='kerbs')for(let t=0;t<collider.indices.length;t+=3)collisionKeys.add(key([0,1,2].map(k=>Array.from(collider.positions.subarray(collider.indices[t+k]!*3,collider.indices[t+k]!*3+3)))));
  const result=deliveryBankPieces(meshes,shores,profile.waterY,collisionKeys);if(!result.pieces.length)continue;
  for(const p of result.pieces)for(let i=2;i<p.positions.length;i+=3)assert.ok(p.positions[i]!<=profile.regionXZ[3]+.0002,'Coastal addition escaped the new strip');
  const aliases=new Map<string,any>(),visual:any[]=[];
  for(const[tier,ref]of Object.entries(old.visual)as[string,any][]){if(aliases.has(ref.path)){cell.visual[tier]=aliases.get(ref.path);continue;}const bytes=readDeliveryFile(o.world!,ref),d=tier==='lod0'?doc:await decodeDeliveryCityGlb(bytes,images),changed=await restoreInlandVisual({bytes,doc:d,pieces:result.pieces,domain:[],seaY:profile.waterY,coarse:tier==='lod2',authority:{keys:new Set(),triangles:[],nodes:[]}}),validation=await validateBytes(embedDeliveryImages(changed.bytes,images),{maxIssues:100});assert.equal(validation.issues.numErrors,0,JSON.stringify(validation.issues.messages));
    const next={...ref,...put(`cells/${cell.id}.${tier}.coast-bank.${deliverySha(changed.bytes).slice(0,16)}.glb`,changed.bytes),triangles:changed.stats.triangles,drawCalls:changed.stats.drawCalls};cell.visual[tier]=next;aliases.set(ref.path,next);visual.push({tier,proof:changed.proofs});validations.push({cell:cell.id,tier,errors:0,warnings:validation.issues.numWarnings});}
  const collision=appendInlandCollision(raw,result.pieces,true),encoded=encodeDeliverySimulation(collision.bytes);cell.collision={...old.collision,...put(`cells/${cell.id}.coast-bank.${deliverySha(encoded.bytes).slice(0,16)}.hcol.gz`,encoded.bytes),compression:encoded.compression,decodedBytes:encoded.decodedBytes,decodedSha256:encoded.decodedSha256,...deliveryCollisionBounds(collision.bytes,old.boundsXZ)};
  proofs.push({cell:cell.id,before:old,after:structuredClone(cell),shoreAuthority:shores,qualification:result.qualified,unsupportedVisualOnly:result.unsupported,addedCollisionTriangles:collision.added,visual});console.log(JSON.stringify({cell:cell.id,bankTriangles:collision.added,seals:result.qualified.seals.length}));
}
assert.ok(proofs.length,'No actual native shoreline gaps were found');verifyDeliveryProducer(producer);
const receipt={schemaVersion:1,status:'NATIVE_COAST_BANKS_WRITTEN_RUNTIME_PENDING',sourceManifestSha256:o['manifest-sha256'],profileSha256:o['profile-sha256'],producer:publicDeliveryProducer(producer),waterSources:mask.sources,retainedWaterClassification:retainedRef,shoreTopology:authorityPlan.topology,method:'Canonical current-water boundaries; highest actual encoded native dry floor envelope; existing vertical faces subtracted and open wet-side spans protected. Only vertical paired faces between literal ground cuts and the existing water elevation. Native HCOL source-floor twins required. No old BIN/resources/collider prefixes, terrain, horizontal floor, coastline XZ or water level changed.',proofs,validations};
const packed=encodeDeliverySimulation(Buffer.from(JSON.stringify(receipt)+'\n'));final.publicationFiles=[...m.publicationFiles,put('publication/coastal-bank-profile.json',pb),{...put('publication/coastal-bank-closure.json.gz',packed.bytes),compression:packed.compression,decodedBytes:packed.decodedBytes,decodedSha256:packed.decodedSha256}];final.worldReleaseId=o.release;final.builtAt=new Date().toISOString();assert.deepEqual(validateWorldManifest(final),[]);
const refs=new Map<string,FileRef>();function visit(v:any){if(!v||typeof v!=='object')return;if(typeof v.path==='string'&&typeof v.bytes==='number'&&typeof v.sha256==='string'){const prior=refs.get(v.path);if(prior){assert.equal(prior.bytes,v.bytes);assert.equal(prior.sha256,v.sha256);}refs.set(v.path,v);}for(const x of Object.values(v))visit(x);}visit(final);const fb=Buffer.from(JSON.stringify(final,null,1)+'\n');assert.ok(refs.size+1<10000);assert.ok(fb.length+[...refs.values()].reduce((n,r)=>n+r.bytes,0)<=950_000_000,'World byte cap exceeded');
for(const ref of refs.values()){const target=deliveryFile(o.out!,ref.path);if(!fs.existsSync(target)){readDeliveryFile(o.world!,ref);fs.mkdirSync(path.dirname(target),{recursive:true});fs.linkSync(deliveryFile(o.world!,ref.path),target);}assert.equal(deliverySha(fs.readFileSync(target)),ref.sha256);}
verifyDeliveryProducer(producer);assert.equal(deliverySha(fs.readFileSync(path.join(o.world!,'manifest.json'))),o['manifest-sha256']);assert.equal(deliverySha(fs.readFileSync(o.profile!)),o['profile-sha256']);assert.equal(deliverySha(fs.readFileSync(o.osm!)),profile.sourceOsmSha256);fs.writeFileSync(path.join(o.out!,'manifest.json'),fb,{flag:'wx'});const summary={status:receipt.status,manifestSha256:deliverySha(fb),cells:proofs.map(p=>p.cell),validations};fs.writeFileSync(o.out+'.receipt.json',JSON.stringify(summary,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(summary,null,2));
