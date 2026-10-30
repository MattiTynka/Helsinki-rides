import assert from 'node:assert/strict';
import fs from 'node:fs';
import type {FileRef} from '../../../packages/world-schema/src/index.ts';
import {deliverySha} from './delivery-city-payloads.ts';

/** Never overwrite an output, and only fall back for a cross-volume link. Source and destination
 * are both verified so a relocation cannot silently bless a truncated or changed payload. */
export function linkOrCopyDeliveryFile(source:string,target:string,ref:FileRef,link:typeof fs.linkSync=fs.linkSync){
  const verify=(file:string)=>{const info=fs.lstatSync(file);assert.ok(info.isFile()&&!info.isSymbolicLink(),'Delivery payload must be a regular file');const bytes=fs.readFileSync(file);assert.equal(bytes.length,ref.bytes,'Delivery payload byte count changed');assert.equal(deliverySha(bytes),ref.sha256,'Delivery payload hash changed');};
  verify(source);
  let method:'hardlink'|'verified-copy'='hardlink';
  try{link(source,target);}catch(error){
    if((error as NodeJS.ErrnoException).code!=='EXDEV')throw error;
    fs.copyFileSync(source,target,fs.constants.COPYFILE_EXCL);method='verified-copy';
  }
  try{verify(target);}catch(error){fs.unlinkSync(target);throw error;}
  return method;
}

export type AppendDeliveryBudget={mode:'pages'}|{mode:'external';worldBudgetBytes:number};
export function resolveAppendDeliveryBudget(value:unknown):{mode:'pages'|'external';worldBudgetBytes:number;inclusive:boolean}{
  if(value===undefined)return{mode:'pages',worldBudgetBytes:950_000_000,inclusive:false};
  assert.ok(value!==null&&typeof value==='object'&&!Array.isArray(value),'Invalid append delivery budget');
  const budget=value as Record<string,unknown>;
  if(budget.mode==='pages'){
    assert.deepEqual(Object.keys(budget).sort(),['mode'],'Pages budget cannot override the existing cap');
    return{mode:'pages',worldBudgetBytes:950_000_000,inclusive:false};
  }
  assert.equal(budget.mode,'external','Unknown append delivery mode');
  assert.deepEqual(Object.keys(budget).sort(),['mode','worldBudgetBytes'],'External delivery requires only an explicit world budget');
  assert.ok(Number.isSafeInteger(budget.worldBudgetBytes)&&Number(budget.worldBudgetBytes)>0&&Number(budget.worldBudgetBytes)<=4_000_000_000,'External world budget must be an integer from 1 to 4,000,000,000 bytes');
  return{mode:'external',worldBudgetBytes:Number(budget.worldBudgetBytes),inclusive:true};
}
