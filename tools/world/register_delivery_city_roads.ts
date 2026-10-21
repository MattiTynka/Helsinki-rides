import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {planDeliveryCityRoads,applyDeliveryCityRoads,type DeliveryRoadRegistrationConfig} from './lib/delivery-city-road-coordinator.ts';
function main(){const{values}=parseArgs({options:{config:{type:'string'},plan:{type:'string'},apply:{type:'boolean'},out:{type:'string'},release:{type:'string'},'receipt-sha256':{type:'string'}}});assert.ok(values.out);if(values.apply){assert.ok(values.plan&&values.release&&values['receipt-sha256']&&!values.config,'Apply requires --plan DIR --release ID --receipt-sha256 SHA --out FRESH');console.log(JSON.stringify(applyDeliveryCityRoads({plan:values.plan,out:values.out,release:values.release,expectedReceiptSha256:values['receipt-sha256']})));}else{assert.ok(values.config&&!values.plan&&!values.release&&!values['receipt-sha256'],'Plan requires --config JSON --out FRESH');console.log(JSON.stringify(planDeliveryCityRoads(JSON.parse(fs.readFileSync(values.config,'utf8'))as DeliveryRoadRegistrationConfig,values.out)));}}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main();
