import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {qualifyDeliveryExtraBridge} from './lib/delivery-extra-bridges.ts';
import {applyDeliveryExtraBridge} from './lib/delivery-extra-bridges-apply.ts';
const{values}=parseArgs({options:{world:{type:'string'},'expected-manifest':{type:'string'},profile:{type:'string'},'source-root':{type:'string',default:'.'},out:{type:'string'},release:{type:'string'},apply:{type:'boolean'},'delivery-mode':{type:'string'},'world-budget-bytes':{type:'string'}}});
for(const k of['world','expected-manifest','profile','out'] as const)assert.ok(values[k],`--${k} required`);assert.ok(!fs.existsSync(values.out!),'Choose a fresh output');
assert.ok(!values['world-budget-bytes']||values['delivery-mode']==='external','Explicit byte budget is only valid for external delivery');assert.ok(!values['delivery-mode']||['pages','external'].includes(values['delivery-mode']));const delivery=values['delivery-mode']==='external'?{mode:'external' as const,worldBudgetBytes:Number(values['world-budget-bytes'])}:values['delivery-mode']==='pages'?{mode:'pages' as const}:undefined;
const options={delivery,world:values.world!,expectedManifestSha256:values['expected-manifest']!,profileFile:values.profile!,sourceRoot:values['source-root']!,out:values.out!,release:values.release!};
if(values.apply){assert.ok(values.release,'--apply requires --release');console.log(JSON.stringify(await applyDeliveryExtraBridge(options)));}else{const result=await qualifyDeliveryExtraBridge({...options,profile:JSON.parse(fs.readFileSync(options.profileFile,'utf8'))});fs.mkdirSync(path.dirname(options.out),{recursive:true});fs.writeFileSync(options.out,JSON.stringify(result.proof)+'\n',{flag:'wx'});console.log(JSON.stringify({status:result.proof.status,triangles:result.proof.triangles,clearance:result.proof.clearance.minimumMetres,bankJoins:result.proof.bankJoins.length}));}
