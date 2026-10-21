// Read-only exact-key coverage in every existing native delivery tier.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {readFacadeChartTriangles} from './lib/facade-chart-glb.ts';
import {deliveryFacadeImages} from './apply_delivery_facade_charts.ts';
import {deliverySha as sha} from './lib/delivery-city-payloads.ts';
import {readDeliveryFile} from './lib/delivery-city.ts';
import {classifyFacadeTriangle} from './lib/delivery-new-area-facades.ts';
import {validateWorldManifest} from '../../packages/world-schema/src/index.ts';

export async function censusNativeFacadeTiers(a:{world:string;expected:string;profile:string;profileSha256:string;out:string}) {
  assert.ok(!fs.existsSync(a.out));
  const manifestBytes=fs.readFileSync(path.join(a.world,'manifest.json'));
  assert.equal(sha(manifestBytes),a.expected);
  const m=JSON.parse(manifestBytes.toString());assert.deepEqual(validateWorldManifest(m),[]);
  const profileBytes=fs.readFileSync(a.profile);assert.equal(sha(profileBytes),a.profileSha256);
  const p=JSON.parse(profileBytes.toString());assert.equal(p.source.originId,m.origin.id);
  const byOwner=new Map<string,any[]>();
  for(const b of p.buildings) {
    const owners=m.cells.filter((c:any)=>c.buildings.some((v:any)=>v.id===b.id&&v.vtj===b.vtj));
    assert.equal(owners.length,1);
    const rows=byOwner.get(owners[0].id)??[];rows.push(b);byOwner.set(owners[0].id,rows);
  }
  const records:{cell:string;tiers:{tier:string;source:unknown;buildings:{requestedFaces:number;exactMatchedFaces:number;missingWallArea:number;missingFaces:unknown[];duplicateKeys:unknown[]}[]}[]}[]=[];
  for(const[id,buildings]of byOwner) {
    const c=m.cells.find((c:any)=>c.id===id),tiers=[];
    for(const[tier,ref]of Object.entries(c.visual)as[string,any][]) {
      const bytes=readDeliveryFile(a.world,ref),faces=await readFacadeChartTriangles(bytes,deliveryFacadeImages(a.world,ref,bytes,m.sharedTextures));
      const counts=new Map<string,number>();for(const f of faces)counts.set(f.key,(counts.get(f.key)??0)+1);
      const rows=buildings.map(b=>{
        const missing=b.faces.filter((f:any)=>!counts.has(f.key)),duplicates=b.faces.filter((f:any)=>(counts.get(f.key)??0)>1);
        return{id:b.id,vtj:b.vtj,requestedFaces:b.faces.length,requestedWallArea:b.faces.reduce((s:number,f:any)=>s+classifyFacadeTriangle(f.points).area,0),
          exactMatchedFaces:b.faces.length-missing.length,missingFaces:missing.map((f:any)=>({part:f.part,triangle:f.triangle,key:f.key,area:classifyFacadeTriangle(f.points).area})),
          missingWallArea:missing.reduce((s:number,f:any)=>s+classifyFacadeTriangle(f.points).area,0),duplicateKeys:duplicates.map((f:any)=>f.key)};
      });
      tiers.push({tier,source:ref,buildings:rows});
    }
    records.push({cell:id,tiers});
  }
  const result={schemaVersion:1,status:'READ_ONLY_EXACT_SOURCE_KEY_COVERAGE_NOT_APPEARANCE_ACCEPTANCE',
    manifestSha256:a.expected,profileSha256:a.profileSha256,ownerCells:records.length,
    summary:['lod0','lod1','lod2'].map(tier=>{
      const rows=records.flatMap(r=>r.tiers.filter(t=>t.tier===tier).flatMap(t=>t.buildings));
      return{tier,requestedFaces:rows.reduce((s,r)=>s+r.requestedFaces,0),exactMatchedFaces:rows.reduce((s,r)=>s+r.exactMatchedFaces,0),
        missingWallArea:rows.reduce((s,r)=>s+r.missingWallArea,0),affectedBuildings:rows.filter(r=>r.missingFaces.length).length,
        duplicateKeys:rows.reduce((s,r)=>s+r.duplicateKeys.length,0)};
    }),records};
  const output=Buffer.from(JSON.stringify(result,null,2)+'\n');fs.mkdirSync(path.dirname(a.out),{recursive:true});fs.writeFileSync(a.out,output,{flag:'wx'});
  assert.equal(sha(fs.readFileSync(path.join(a.world,'manifest.json'))),a.expected);
  return{sha256:sha(output),ownerCells:records.length,summary:result.summary};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const{values}=parseArgs({options:Object.fromEntries(['world','expected','profile','profile-sha256','out'].map(k=>[k,{type:'string'as const}]))});
  for(const k of['world','expected','profile','profile-sha256','out'])assert.ok(values[k]);
  console.log(JSON.stringify(await censusNativeFacadeTiers({world:values.world!,expected:values.expected!,profile:values.profile!,profileSha256:values['profile-sha256']!,out:values.out!})));
}
