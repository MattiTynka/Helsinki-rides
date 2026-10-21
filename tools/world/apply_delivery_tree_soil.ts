import assert from 'node:assert/strict';
import fs from 'node:fs';
import {parseArgs} from 'node:util';
import {applyDeliveryTreeSoil} from './lib/delivery-city-tree-application.ts';
const{values}=parseArgs({options:Object.fromEntries(['config','out','receipt'].map(k=>[k,{type:'string' as const}]))});for(const key of['config','out','receipt'])assert.ok(values[key],`--${key} required`);const result=await applyDeliveryTreeSoil({...JSON.parse(fs.readFileSync(values.config!,'utf8')),out:values.out});fs.writeFileSync(values.receipt!,JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(result));
