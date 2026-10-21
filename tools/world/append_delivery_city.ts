// New-only staging and append delivery. Frozen worlds must never enter optimize_release again.
import assert from 'node:assert/strict';
import {parseArgs} from 'node:util';
import fs from 'node:fs';
import {prepareNewDeliveryCells} from './lib/delivery-city.ts';
import {appendDeliveryCity} from './lib/delivery-city-append.ts';
const{values}=parseArgs({options:Object.fromEntries(['native-cells','expected-index','out','plan','receipt','accepted-world','expected-manifest'].map(k=>[k,{type:'string' as const}]))});
function required(key:string){const value=values[key];assert.ok(typeof value==='string'&&value.length,`--${key} is required`);return value;}
const result=values.plan?await appendDeliveryCity({...JSON.parse(fs.readFileSync(required('plan'),'utf8')),out:required('out')}):await prepareNewDeliveryCells({nativeCells:required('native-cells'),expectedIndexSha256:required('expected-index'),acceptedWorld:required('accepted-world'),expectedManifestSha256:required('expected-manifest'),out:required('out')});
if(values.receipt)fs.writeFileSync(values.receipt,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({...result,...('proofs'in result?{proofs:undefined}: {})}));
