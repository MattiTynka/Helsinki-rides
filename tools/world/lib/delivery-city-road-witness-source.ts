import assert from'node:assert/strict';
import{createHash}from'node:crypto';
import{decodeRoadGraph,type SimulationFileRef,type Vec3}from'../../../packages/world-schema/src/index.ts';
import{densifyDeliveryMotorChords}from'./delivery-city-road-dense.ts';
import{deliveryRoadAuthorityCuts,type DeliveryBridgeRoadAuthority}from'./delivery-city-road-registration.ts';
import{bindDeliveryProducer,publicDeliveryProducer}from'./delivery-city-provenance.ts';
const sha=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
export interface DeliveryWitnessSourceContext{sourceBytes:Uint8Array;sourceRef:SimulationFileRef;authorities:readonly DeliveryBridgeRoadAuthority[]}
export function bindDeliveryWitnessSource(context:DeliveryWitnessSourceContext){
 const expected=context.sourceRef.compression?context.sourceRef.decodedSha256:context.sourceRef.sha256,bytes=context.sourceRef.compression?context.sourceRef.decodedBytes:context.sourceRef.bytes;
 assert.equal(context.sourceBytes.length,bytes,'Witness source decoded byte count changed');assert.equal(sha(context.sourceBytes),expected,'Witness source graph changed');
 return{algorithm:'delivery-source-knots-v1',sourceRef:context.sourceRef,sourceDecodedSha256:sha(context.sourceBytes),authoritySha256:sha(JSON.stringify(context.authorities)),producer:publicDeliveryProducer(bindDeliveryProducer(new URL('./delivery-city-road-census.ts',import.meta.url)))};
}
/** Independently repeats source densification and authority intersections.
 * No registered graph coordinates or writer-created coordinate table enter
 * this lookup. Ordered wire indices retain loopback occurrences exactly. */
export function reconstructDeliveryWitnessPoints(context:DeliveryWitnessSourceContext){
 bindDeliveryWitnessSource(context);const graph=densifyDeliveryMotorChords(decodeRoadGraph(context.sourceBytes)).roads,lanes=new Map(graph.lanes.map(l=>[l.id,l])),result=new Map<string,readonly Vec3[]>();
 for(const kind of['lanes','connectors','parking','nodes','footways']as const)for(const item of graph[kind]){
  const wire=item as any;let points:readonly Vec3[]=kind==='nodes'?[wire.position]:wire.points;
  if(kind==='lanes'||kind==='connectors'||kind==='footways'){
   const wayIds=kind==='lanes'?[wire.wayId]:kind==='connectors'?[lanes.get(wire.from)!.wayId,lanes.get(wire.to)!.wayId]:[Number(wire.id.match(/^w(\d+)/)?.[1])],expanded:Vec3[]=[];
   for(let i=1;i<points.length;i++){const a=points[i-1]!,b=points[i]!;expanded.push([...a]);for(const t of deliveryRoadAuthorityCuts(a,b,wayIds,context.authorities))expanded.push(a.map((v,k)=>v+(b[k]!-v)*t)as Vec3);}
   expanded.push([...points.at(-1)!]);points=expanded;
  }
  const key=kind+'/'+wire.id;assert.ok(!result.has(key),'Duplicate source witness wire');result.set(key,points);
 }
 return result;
}
export function deliveryWitnessCoordinateStream(points:readonly(readonly number[])[]){const hash=createHash('sha256'),bytes=Buffer.alloc(24);for(const point of points){assert.equal(point.length,3);for(let k=0;k<3;k++){assert.ok(Number.isFinite(point[k]));bytes.writeDoubleLE(point[k]!,k*8);}hash.update(bytes);}return{count:points.length,bytes:points.length*24,sha256:hash.digest('hex'),format:'ordered-little-endian-F64XYZ'};}
