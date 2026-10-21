import assert from'node:assert/strict';
import fs from'node:fs';
import path from'node:path';
import{parseArgs}from'node:util';
import{readDeliveryFile}from'./lib/delivery-city.ts';
import{decodeDeliverySimulation,deliverySha}from'./lib/delivery-city-payloads.ts';
import{decodeDeliveryRoadCensus}from'./lib/delivery-city-road-census.ts';
const{values}=parseArgs({options:{'plan-dir':{type:'string'},'source-root':{type:'string'},'receipt-sha256':{type:'string'}}});
assert.ok(values['plan-dir']&&values['source-root']&&values['receipt-sha256'],'Supply exact plan-dir, source-root and receipt-sha256');assert.match(values['receipt-sha256'],/^[a-f0-9]{64}$/);
const receiptBytes=fs.readFileSync(path.join(values['plan-dir'],'plan-receipt.json'));assert.equal(deliverySha(receiptBytes),values['receipt-sha256'],'Road plan receipt changed');
const receipt=JSON.parse(receiptBytes.toString()),proof=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(decodeDeliverySimulation(readDeliveryFile(values['plan-dir'],receipt.proofRef),receipt.proofRef))),ref=proof.input.sourceRoadRef,sourceBytes=decodeDeliverySimulation(readDeliveryFile(values['source-root'],ref),ref),rows=decodeDeliveryRoadCensus(proof.registration.rows,{sourceBytes,sourceRef:ref,authorities:proof.authorities});
assert.equal(rows.length,proof.registration.registeredPoints);for(const row of rows){assert.ok(row.before.length===3&&row.before.every(Number.isFinite));assert.ok(row.chosen&&Number.isFinite(row.chosen.height)&&Number.isFinite(row.afterY),'Native chosen height or resulting navigation height missing');}
console.log(JSON.stringify({status:'FULL_SOURCE_WITNESS_STREAM_INDEPENDENTLY_RECONSTRUCTED',registeredRows:rows.length,coordinateStream:proof.registration.rows.coordinateSource.stream,unresolvedMotorPoints:proof.registration.unresolvedMotorPoints.length,proofRef:receipt.proofRef,nativeFloorHeightsAndSupportsRetained:true}));
