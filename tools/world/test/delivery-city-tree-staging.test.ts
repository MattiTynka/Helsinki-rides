import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {encodeCollisionBundle,parseCollisionBundle} from '../../../packages/world-schema/src/index.ts';
import {prepareDeliveryTreeSoil} from '../lib/delivery-city-trees.ts';
import {applyDeliveryTreeSoil} from '../lib/delivery-city-tree-application.ts';
import {deliverySha,decodeDeliverySimulation} from '../lib/delivery-city-payloads.ts';

test('tree setup and application support verified cross-volume copies with explicit bounded delivery',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'helsinki-tree-staging-'));
  t.after(()=>{const target=path.resolve(root);assert.ok(target.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(target).startsWith('helsinki-tree-staging-'));fs.rmSync(target,{recursive:true,force:true});});
  let copies=0;t.mock.method(fs,'linkSync',()=>{copies++;throw Object.assign(new Error('cross-volume fixture'),{code:'EXDEV'});});
  const put=(folder:string,name:string,bytes:Uint8Array)=>{const target=path.join(folder,name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes);return{path:name,bytes:bytes.length,sha256:deliverySha(bytes)};};
  const json=(folder:string,name:string,value:unknown)=>put(folder,name,Buffer.from(JSON.stringify(value)+'\n'));
  const pin=(folder:string,ref:{path:string;sha256:string})=>({path:path.join(folder,ref.path),sha256:ref.sha256});
  const collider=(id:string,group:'ground'|'trees',ref:string|null)=>({id,group,ref,positions:Float32Array.from([1,0,1,2,0,1,2,3,2]),indices:Uint32Array.from([0,1,2]),triangleTags:Uint16Array.from([0])});
  const oldTree={id:'old',asset:'tree-asset',node:'birch',model:'birch',position:[2,0,2],yaw:0,scale:[1,1,1]},newTree={...oldTree,id:'new',trunkRadius:.2,colliderHeight:3};
  function world(folder:string,isAccepted:boolean){
    const asset={...put(folder,'assets/trees.glb',Buffer.from('retained asset fixture')),id:'tree-asset',kind:'scenery'},visual=put(folder,'cells/c_p00_p00.glb',Buffer.from('unchanged visual fixture'));
    const collision=put(folder,'cells/c_p00_p00.hcol',encodeCollisionBundle({originId:'fixture',frame:'X-east,Y-up,Z-south',cell:'c_p00_p00',surfaceTags:['soil']},[collider('ground','ground',null),collider('t:old','trees','old'),...isAccepted?[]:[collider('t:new','trees','new')]]));
    const scenery=json(folder,'scenery.json',{originId:'fixture',assets:[asset],instances:isAccepted?[oldTree]:[oldTree,newTree]});
    const manifest={schemaVersion:2,worldReleaseId:'tree-fixture',origin:{id:'fixture',originProjected:[0,0,0]},cellSize:128,boundsRuntimeXZ:[0,0,128,128],cells:[{id:'c_p00_p00',cx:0,cz:0,boundsXZ:[0,0,128,128],visual:{lod0:visual},collision,buildings:[],buildingIds:[]}],terrain:{...put(folder,'terrain.bin',Buffer.from('unchanged terrain fixture')),resolution:1},roads:json(folder,'roads.json',{}),gameplay:json(folder,'gameplay.json',{}),assets:[asset],scenery,sharedTextures:[],sources:[{id:'fixture'}],attribution:['fixture'],lighting:'unlit-facades'};
    return{manifest,ref:json(folder,'manifest.json',manifest)};
  }
  const accepted=path.join(root,'accepted'),candidate=path.join(root,'candidate'),a=world(accepted,true),c=world(candidate,false),sourceTrees=json(root,'source-trees.json',{originId:'fixture',asset:'tree-asset',assetSha256:c.manifest.assets[0]!.sha256,trees:[newTree]}),sourceReport=json(root,'source-report.json',{trees:[{id:'new'}]}),coast=json(root,'coast.json',{coastal:null}),geo=json(root,'source.geojson',{type:'FeatureCollection',features:[]}),setupDir=path.join(root,'setup');
  const setupResult=prepareDeliveryTreeSoil({world:candidate,manifestSha256:c.ref.sha256,acceptedWorld:accepted,acceptedManifestSha256:a.ref.sha256,sourceTrees:[{trees:pin(root,sourceTrees),report:pin(root,sourceReport)}],coastalReport:pin(root,coast),streetParts:pin(root,geo),footprints:pin(root,geo),out:setupDir});
  assert.equal(copies,2);assert.equal(setupResult.sourceTrees,1);assert.equal(setupResult.acceptedTrees,1);assert.equal(setupResult.chunks,1);
  const setup=JSON.parse(fs.readFileSync(path.join(setupDir,'setup.json'),'utf8')),chunk=setup.chunks[0],batchPin=pin(setupDir,chunk.trees),plan=json(root,'qualified-fixture-plan.json',{authority:{kind:'new-tree-final-soil-registration',sourceIndexSha256:setup.viewIndexSha256,counts:{unresolved:0,acceptedSceneryPresent:1},inputs:[batchPin],rows:[{id:'new',sourcePosition:newTree.position,status:'QUALIFIED_Y_CORRECTION',correction:{id:'new',policy:'intended-soil-sink',beforeY:0,afterY:1,delta:1,baselineOffset:null,baselineSamples:[],finalSamples:[],finalSupportRange:[1.3,1.3],maximumRimOffsetChange:null,anchorHeight:1.3,applied:true}}]}});
  const options={setup:{path:path.join(setupDir,'setup.json'),sha256:setupResult.setupSha256},plans:[{chunk:0,plan:pin(root,plan)}],release:'tree-soil-fixture'},out=path.join(root,'external');
  const result=await applyDeliveryTreeSoil({...options,out,delivery:{mode:'external',worldBudgetBytes:1_000_000}});
  assert.deepEqual(result.delivery,{mode:'external',worldBudgetBytes:1_000_000,inclusive:true});assert.ok(result.worldBytes<=1_000_000);assert.ok(copies>2);assert.equal(result.acceptedSceneryExact,1);assert.equal(result.acceptedTrunkColliderArraysExact,1);assert.equal(result.qualifiedY,1);
  const next=JSON.parse(fs.readFileSync(path.join(out,'manifest.json'),'utf8')),scenery=JSON.parse(fs.readFileSync(path.join(out,next.scenery.path),'utf8'));
  assert.deepEqual(scenery.instances[0],oldTree);assert.deepEqual(scenery.instances[1].position,[2,1,2]);
  const ref=next.cells[0].collision,bundle=parseCollisionBundle(decodeDeliverySimulation(fs.readFileSync(path.join(out,ref.path)),ref)),original=parseCollisionBundle(fs.readFileSync(path.join(candidate,c.manifest.cells[0]!.collision.path)));
  assert.deepEqual(bundle.colliders.slice(0,2),original.colliders.slice(0,2));assert.deepEqual(Array.from(bundle.colliders[2]!.positions),[1,1,1,2,1,1,2,4,2]);
  assert.deepEqual(fs.readFileSync(path.join(out,c.manifest.cells[0]!.visual.lod0.path)),fs.readFileSync(path.join(candidate,c.manifest.cells[0]!.visual.lod0.path)));
  const receipt=JSON.parse(fs.readFileSync(path.join(out,'publication/new-tree-soil.json'),'utf8'));assert.deepEqual(receipt.delivery,result.delivery);
  const defaultResult=await applyDeliveryTreeSoil({...options,out:path.join(root,'pages')});assert.deepEqual(defaultResult.delivery,{mode:'pages',worldBudgetBytes:950_000_000,inclusive:false});
  await assert.rejects(applyDeliveryTreeSoil({...options,out:path.join(root,'too-small'),delivery:{mode:'external',worldBudgetBytes:1}}),/exceeds external budget of 1 bytes/);assert.equal(fs.existsSync(path.join(root,'too-small','manifest.json')),false);
  assert.equal(deliverySha(fs.readFileSync(path.join(candidate,'manifest.json'))),c.ref.sha256);assert.equal(deliverySha(fs.readFileSync(path.join(accepted,'manifest.json'))),a.ref.sha256);
});

test('tree application rejects missing, weakened Pages or unbounded external policy before inputs or output',async()=>{
  const options={setup:{path:'missing-fixture-setup.json',sha256:'a'.repeat(64)},plans:[],release:'test',out:'unused-tree-output'};
  for(const delivery of [{mode:'external'},{mode:'external',worldBudgetBytes:4_000_000_001},{mode:'pages',worldBudgetBytes:2_000_000_000},{mode:'external',worldBudgetBytes:1,unbounded:true}])await assert.rejects(applyDeliveryTreeSoil({...options,delivery} as Parameters<typeof applyDeliveryTreeSoil>[0]),error=>error instanceof Error&&!error.message.includes('ENOENT'));
});
