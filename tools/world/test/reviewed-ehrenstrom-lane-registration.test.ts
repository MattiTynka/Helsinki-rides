import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {decodeRoadGraph, type RoadLane} from '../../../packages/world-schema/src/index.ts';
import {readSourceFile} from '../lib/source-files.ts';
import {decodeDeliverySimulation} from '../lib/delivery-city-payloads.ts';
import {qualifyReviewedEhrenstromLaneRegistration, assertReviewedEhrenstromLaneProjection, type EhrenstromLaneRegistrationInputs} from '../lib/reviewed-ehrenstrom-lane-registration.ts';

const reviewPath = '../evidence/ehrenstrom-authoring-review-v2.json';
function fixture(): EhrenstromLaneRegistrationInputs {
  const read = (file:string) => fs.readFileSync(file), root = '../accepted-world/world/senate-20261025-civilian-flee', manifest = JSON.parse(read(root+'/manifest.json').toString());
  return {reviewBytes:read(reviewPath),registrationBytes:read('../evidence/ehrenstrom-curb-registration-composed-v3.json'),
    authoringGraphBytes:read('../work/ehrenstromintie-road-registration-v3/roads-source-registered.json'),projectedGraphBytes:read('../work/cumulative-south-coast-projection-v9/candidate-roads-native-projected.json'),projectionReceiptBytes:read('../work/cumulative-south-coast-projection-v9/road-projection-receipt.json'),
    accepted:decodeRoadGraph(decodeDeliverySimulation(readSourceFile(root,manifest.roads),manifest.roads)),acceptedCoverage:JSON.parse(decodeDeliverySimulation(readSourceFile(root,manifest.gameplay),manifest.gameplay).toString()),
    sourcePins:{streetPartsSha256:'1ac1409cf70cd6c3ad1ab7139fd6f365898d5c654e499616a1892d1b669645b2',osmSha256:'a6bf71bae890ab60b4249c8546e6b7185ce37c9ede4137e9c4aefbd9a755e65a'},vehicleDefinitionsSha256:'bdc7451dab6157088d952b942acbf73a80a6d4e780d6132fa48a1ad9f34a65f3'};
}
test('unverified new-lane authority cannot authorize any projection',()=>{
  assert.throws(()=>assertReviewedEhrenstromLaneProjection({kind:'reviewed-ehrenstrom-new-lane'},{}as RoadLane),/Unverified/);
});
test('literal local reviewed four-window geometry binds source and projection ancestry',{skip:!fs.existsSync(reviewPath)},()=>{
  const input=fixture(),result=qualifyReviewedEhrenstromLaneRegistration(input);
  assert.equal(result.registeredLane.id,'825173902:0:b0');assert.equal(result.witness.acceptedRecordsUnaffected,true);
  assert.equal(assertReviewedEhrenstromLaneProjection(result.authority,result.registeredLane).approvedPiecewiseXZPreserved,true);
  const altered=structuredClone(result.registeredLane),points=altered.points.map(p=>[...p]as[number,number,number]);points[20]![0]+=.002;
  assert.throws(()=>assertReviewedEhrenstromLaneProjection(result.authority,{...altered,points}),/source XZ|original XZ/);
  assert.throws(()=>assertReviewedEhrenstromLaneProjection(result.authority,{...altered,width:altered.width+.01}));
});
test('local review does not admit stale complete source, other vehicles or accepted records',{skip:!fs.existsSync(reviewPath)},()=>{
  const input=fixture(),result=qualifyReviewedEhrenstromLaneRegistration(input);
  assert.throws(()=>qualifyReviewedEhrenstromLaneRegistration({...input,sourcePins:{...input.sourcePins,osmSha256:'0'.repeat(64)}}),/complete OSM/);
  assert.throws(()=>qualifyReviewedEhrenstromLaneRegistration({...input,vehicleDefinitionsSha256:'0'.repeat(64)}),/Vehicle/);
  assert.throws(()=>qualifyReviewedEhrenstromLaneRegistration({...input,accepted:{...input.accepted,lanes:[...input.accepted.lanes,result.registeredLane]}}),/accepted lane/);
  assert.throws(()=>qualifyReviewedEhrenstromLaneRegistration({...input,registrationBytes:Buffer.from('{}')}),/input changed/);
});
