import assert from 'node:assert/strict';
import fs from 'node:fs';
import {parseArgs} from 'node:util';
import {prepareDeliveryTreeSoil,planDeliveryTreeSoilChunk} from './lib/delivery-city-trees.ts';
const{values}=parseArgs({options:Object.fromEntries(['config','out','setup','expected-setup','chunk','plan','cases'].map(k=>[k,{type:'string' as const}]))});
const required=(key:string)=>{const value=values[key];assert.ok(typeof value==='string'&&value.length,`--${key} required`);return value;};
console.log(JSON.stringify(values.setup?await planDeliveryTreeSoilChunk({setup:required('setup'),expectedSetupSha256:required('expected-setup'),chunk:Number(required('chunk')),plan:required('plan'),cases:values.cases}):prepareDeliveryTreeSoil({...JSON.parse(fs.readFileSync(required('config'),'utf8')),out:required('out')})));
