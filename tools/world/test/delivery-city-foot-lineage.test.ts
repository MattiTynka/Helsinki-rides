import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {encodeCollisionBundle,type WorldManifest} from '../../../packages/world-schema/src/index.ts';
import {verifyDeliveryRoadPhysicalLineage} from '../lib/delivery-city-road-lineage.ts';
import {deliverySha} from '../lib/delivery-city-payloads.ts';
import {junctionFaceSha} from '../lib/delivery-bridge-junction-mouths.ts';

const road=[[10,12,0],[10,12,2],[12,12,0]],foot=[[0,12.3,0],[0,12.3,2],[2,12.3,0]];
function fixture(t:any,mode='exact'){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'helsinki-tagged-foot-'));
 t.after(()=>{assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(root,{recursive:true,force:true});});
 const put=(dir:string,name:string,bytes:Uint8Array)=>{fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,name),bytes);return{path:name,bytes:bytes.length,sha256:deliverySha(bytes)};};
 const collision=(withFoot:boolean)=>{
  const f=mode==='reversed'?[foot[0]!,foot[2]!,foot[1]!]:mode==='lower'?foot.map(p=>[p[0]!,1,p[2]!]):foot;
  const faces=[road,...(withFoot&&mode!=='missing'?[f]:[])],positions=Float32Array.from(faces.flat(2));
  return encodeCollisionBundle({originId:'origin',frame:'X-east,Y-up,Z-south',cell:'actual',surfaceTags:['road:asphalt:bridge-reconstruction',mode==='mistag'?'road:asphalt':'raised:slabs:bridge-junction']},[{id:'floor',group:'ground',ref:null,positions,indices:Uint32Array.from(positions.length/3?Array.from({length:positions.length/3},(_,i)=>i):[]),triangleTags:Uint16Array.from(faces.map((_,i)=>i?1:0))}]);
 };
 const before=path.join(root,'before'),world=path.join(root,'after'),sourceRef=put(before,'floor.hcol',collision(false)),finalRef=put(world,'floor.hcol',collision(true));
 const sourceManifest={cells:[{id:'actual',collision:sourceRef}]},manifestBytes=Buffer.from(JSON.stringify(sourceManifest));put(before,'manifest.json',manifestBytes);
 const derivative:any={ref:{path:'publication/walk.json',bytes:1,sha256:'a'.repeat(64)},sourceManifestSha256:deliverySha(manifestBytes),profile:{sourceCells:[{id:'actual',collision:sourceRef}],recipes:[]},newRoadFaces:[],newFootFaces:[{cell:'actual',points:foot,sha256:junctionFaceSha(foot),parentBridge:'hameentie-junatie',recipeId:'walk',surfaceTag:'raised:slabs:bridge-junction'}],cuts:[],nonRoadCuts:[]};
 const contracts:any=[{id:'hameentie-junatie',floorTag:'road:asphalt:bridge-reconstruction',collisionFiles:[{cell:'actual',...sourceRef}],masks:[{id:'source',polygon:road.map(p=>[p[0],p[2]])}],junctionDerivatives:[derivative]}];
 return()=>verifyDeliveryRoadPhysicalLineage(world,{cells:[{id:'actual',collision:finalRef}]} as unknown as WorldManifest,contracts,[{world:before,manifestSha256:deliverySha(manifestBytes)}]);
}
test('actual final tagged FOOT HCOL is required independently of unchanged canonical ROAD',t=>{
 const result=fixture(t)();assert.equal(result.walking.finalTaggedFaces,1);assert.equal(result.bridges[0].missingCanonicalFaces,0);
});
test('a missing, reverse-wound, lower-level or mistagged FOOT floor fails despite exact driving floor',t=>{
 for(const mode of['missing','reversed','lower','mistag'])assert.throws(fixture(t,mode),/exact oriented tagged FOOT/);
});
