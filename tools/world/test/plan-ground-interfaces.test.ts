import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {GlbBuilder} from '../lib/gltf.ts';
import {encodeCollisionBundle} from '../../../packages/world-schema/src/index.ts';
const sha=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
const planner=fileURLToPath(new URL('../plan_ground_interfaces.ts',import.meta.url));
async function fixture(visualSide:boolean){
 const temp=path.resolve(tmpdir()),dir=mkdtempSync(path.join(temp,'helsinki-interface-plan-')),cells=path.join(dir,'fresh-cells');mkdirSync(cells);
 const positions=new Float32Array([0,0,0,2,0,0,2,0,2,0,0,2,0,.14,0,2,.14,0,2,.3,0,0,.3,0]),indices=new Uint32Array([0,2,1,0,3,2,4,5,6,4,6,7]),builder=new GlbBuilder('test-cell');
 await builder.addMesh({name:'test_ground_slabs',positions,indices:visualSide?indices:indices.slice(0,6),materialName:'native-ground'},{name:'native-ground',unlit:false});
 const vb=await builder.toGlb('test-cell',{},'exact'),cb=encodeCollisionBundle({originId:'test-origin',cell:'c_p00_p00',frame:'X-east,Y-up,Z-south',surfaceTags:['raised:yard','curb']},[{id:'g:c_p00_p00',group:'ground',ref:null,positions,indices,triangleTags:new Uint16Array([0,0,1,1])}]);
 writeFileSync(path.join(cells,'visual.glb'),vb);writeFileSync(path.join(cells,'coarse.glb'),vb);writeFileSync(path.join(cells,'collision.hcol'),cb);
 const parts=path.join(dir,'source.geojson'),origin=path.join(dir,'origin.json'),config=path.join(dir,'config.json'),out=path.join(dir,'plan.json'),partsBytes=Buffer.from(JSON.stringify({type:'FeatureCollection',features:[{type:'Feature',properties:{osan_id:123,paatyyppi:'Kevyt liikenne',alatyyppi:'Jalankulkualue',alueen_nimi:'Source fixture'},geometry:{type:'Polygon',coordinates:[[[-1,-3],[3,-3],[3,1],[-1,1],[-1,-3]]]}}]}));writeFileSync(parts,partsBytes);
 const json=(p:string,v:unknown)=>writeFileSync(p,JSON.stringify(v));json(origin,{id:'test-origin',originProjected:[0,0,0]});json(config,{carriagewayGrade:{protectedArea:{minX:-20,maxX:-10,minZ:-20,maxZ:-10},protectedMarginMetres:0,gridMetres:4}});
 const descriptor=(p:string,b:Uint8Array)=>({path:p,sha256:sha(b),bytes:b.length,triangles:4});json(path.join(cells,'cells.json'),{schemaVersion:1,originId:'test-origin',cellSize:128,cells:[{id:'c_p00_p00',visual:{lod0:descriptor('visual.glb',vb),lod2:descriptor('coarse.glb',vb)},collision:descriptor('collision.hcol',cb)}]});json(path.join(cells,'report.json'),{originId:'test-origin',inputs:{streetParts:sha(partsBytes)}});
 const args=[planner,'--cells',cells,'--config',config,'--origin',origin,'--street-parts',parts,'--out',out],run=()=>spawnSync(process.execPath,args,{cwd:dir,encoding:'utf8',timeout:30000});
 return{dir,cells,parts,origin,config,out,run,cleanup(){assert.ok(path.resolve(dir).startsWith(temp+path.sep)&&path.basename(dir).startsWith('helsinki-interface-plan-'));rmSync(dir,{recursive:true,force:true});}};
}
test('generic CLI binds real visual/HCOL geometry, works outside repo cwd, preserves inputs and refuses output reuse',async()=>{
 const f=await fixture(true);try{const original=readFileSync(path.join(f.cells,'cells.json')),r=f.run();assert.equal(r.status,0,r.stderr);const plan=JSON.parse(readFileSync(f.out,'utf8')),row=plan.rows[0],receipt=readFileSync(row.receipt);assert.equal(plan.baseCellsIndexSha256,sha(original));assert.equal(row.sha256,sha(receipt));assert.equal(plan.totals.seals,1);assert.equal(plan.visualBinding.rejectedSeals,0);assert.equal(plan.visualBinding.matchedTriangles,plan.visualBinding.uniqueHcolTriangles);assert.ok(JSON.parse(receipt.toString()).seals[0].polygon.length);assert.deepEqual(readFileSync(path.join(f.cells,'cells.json')),original);assert.notEqual(f.run().status,0,'Existing immutable plans must never be overwritten');}finally{f.cleanup();}
});
test('a collision-only lower side cannot authorize a visible closure',async()=>{
 const f=await fixture(false);try{const r=f.run();assert.equal(r.status,0,r.stderr);const plan=JSON.parse(readFileSync(f.out,'utf8')),receipt=JSON.parse(readFileSync(plan.rows[0].receipt,'utf8'));assert.equal(plan.totals.seals,0);assert.equal(plan.visualBinding.rejectedSeals,1);assert.equal(receipt.visualBinding.rejected.length,1);}finally{f.cleanup();}
});
test('source register or origin drift fails before a plan can authorize changed cells',async()=>{
 const f=await fixture(true);try{writeFileSync(f.parts,'{"type":"FeatureCollection","features":[]}');const r=f.run();assert.notEqual(r.status,0);assert.match(r.stderr,/Street register differs/);}finally{f.cleanup();}
});
