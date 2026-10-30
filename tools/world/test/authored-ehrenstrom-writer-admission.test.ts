import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {applyDeliveryAuthoredRoadGrade} from '../apply_delivery_authored_road_grade.ts';

const planFile=fileURLToPath(new URL('../../../../work/cumulative-city-ehrenstrom-grade-v1/plan.json',import.meta.url));
test('actual writer rejects arbitrary signed authority and alternate cache before creating a world',{skip:!fs.existsSync(planFile)},async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ehren-admission-'));
  try{
    const original=JSON.parse(fs.readFileSync(planFile,'utf8'));
    for(const[k,mutate]of [
      ['review',(p:any)=>{p.authoringReview.sha256='0'.repeat(64);}],
      ['cache',(p:any)=>{p.candidateCache.sha256='0'.repeat(64);}],
    ]as const){const p=structuredClone(original);mutate(p);const file=path.join(dir,k+'.json'),out=path.join(dir,k+'-world');fs.writeFileSync(file,JSON.stringify(p));await assert.rejects(applyDeliveryAuthoredRoadGrade(file,out));assert.equal(fs.existsSync(out),false,'Rejection must precede output creation');}
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
