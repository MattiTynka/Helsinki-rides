import assert from 'node:assert/strict';
import fs from 'node:fs';
import {parseArgs} from 'node:util';
import {planDeliveryRoadSoil} from './lib/delivery-city-road-soil.ts';
const{values}=parseArgs({options:{config:{type:'string'},out:{type:'string'}}});assert.ok(values.config&&values.out,'--config and --out required');console.log(JSON.stringify(planDeliveryRoadSoil({...JSON.parse(fs.readFileSync(values.config,'utf8')),out:values.out})));
