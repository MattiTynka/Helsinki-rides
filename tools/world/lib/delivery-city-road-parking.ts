import assert from 'node:assert/strict';
import type {RoadGraph}from'../../../packages/world-schema/src/index.ts';
import {deliverySha}from'./delivery-city-payloads.ts';
import type {RoadProtectionRectangle}from'./delivery-city-road-preservation.ts';
/** Existing gameplay parking is an accepted-record authority. Source expansion
 * may append points outside the former map, but may not silently expand an old
 * spawn area. Every old point must remain literal and in source order. */
export function preserveDeliveryAcceptedParking(source:RoadGraph,accepted:RoadGraph,rectangle:RoadProtectionRectangle){
 const roads=structuredClone(source)as any,proof:any[]=[];
 for(const old of accepted.parking){const index=roads.parking.findIndex((p:any)=>p.id===old.id);assert.ok(index>=0,'Accepted parking ID missing from new source');const current=roads.parking[index],metadata=(p:any)=>{const n={...p};delete n.points;return n;};assert.deepEqual(metadata(current),metadata(old),'Accepted parking metadata changed');let prior=0;const extension:any[]=[];
  for(const point of current.points){if(prior<old.points.length&&JSON.stringify(point)===JSON.stringify(old.points[prior]))prior++;else{assert.ok(point[0]<rectangle[0]||point[0]>rectangle[2]||point[2]<rectangle[1]||point[2]>rectangle[3],'New source parking point inside protected extent is not an accepted extension');extension.push(point);}}
  assert.equal(prior,old.points.length,'Accepted ordered parking points changed in source');const hash=(v:unknown)=>deliverySha(Buffer.from(JSON.stringify(v)+'\n'));
  proof.push({id:old.id,sourceRecordSha256:hash(current),acceptedRecordSha256:hash(old),sourcePointCount:current.points.length,acceptedPointCount:old.points.length,discardedOutsideExtension:extension,oldOrderedXYZPointsLiteral:true,oldRecordRetainedLiteral:true});roads.parking[index]=structuredClone(old);
 }
 return{roads:roads as RoadGraph,proof:{kind:'accepted-parking-record-authority',acceptedRecords:proof,newSourceParkingIds:source.parking.filter(p=>!accepted.parking.some(a=>a.id===p.id)).map(p=>p.id),scope:'Only matching exact accepted IDs; new IDs stay source/native-qualified. Source extension points must lie strictly outside former protected extent.'}};
}
