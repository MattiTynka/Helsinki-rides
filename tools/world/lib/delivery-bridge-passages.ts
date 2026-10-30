import assert from 'node:assert/strict';
import polygonClipping from 'polygon-clipping';
import {geodeticToGk25,type WorldManifest} from '../../../packages/world-schema/src/index.ts';
import {CHARACTER} from '../../../packages/sim/src/index.ts';
import {isSupportedSurfaceWay} from './surface-way.ts';
import {sourcePartsForTriangle,type LayeredSourcePart} from './layered-bridge-source.ts';
import {supportHeight,supportNormal,type SupportTriangle} from './tram-support-repair.ts';
import type {ExtraBridgeNativeFace} from './delivery-extra-bridges-source.ts';
import {qualifyBridgeNativeMotion,type NativeBridgeMotionInput} from './delivery-bridge-native-motion.ts';
import {sourceSha256} from './source-files.ts';
type Point=[number,number];
const area=(polygons:polygonClipping.MultiPolygon)=>polygons.reduce((sum,p)=>sum+p.reduce((n,r,i)=>n+(i?-1:1)*Math.abs(r.reduce((a,u,j)=>{const v=r[(j+1)%r.length]!;return a+u[0]*v[1]-u[1]*v[0];},0))/2,0),0);
const ring=(points:readonly Point[]):polygonClipping.Polygon=>[[...points.map(p=>[...p]as Point),[...points[0]!]as Point]];
const triangle=(p:SupportTriangle)=>ring(p.map(v=>[v[0],v[2]]));
const union=(polygons:polygonClipping.Polygon[])=>{assert.ok(polygons.length,'Empty native corridor coverage');return polygonClipping.union(polygons[0]!,...polygons.slice(1));};
function disk(p:Point,radius:number){const r=radius/Math.cos(Math.PI/16);return ring(Array.from({length:16},(_,i)=>[p[0]+Math.cos(i*Math.PI/8)*r,p[1]+Math.sin(i*Math.PI/8)*r]));}
/** This is the character's authored body envelope, not an inferred street width. */
export function bridgePassageBodyCorridor(axis:readonly Point[],radius:number){
  assert.ok(axis.length>=2&&axis.length<=512&&axis.every(p=>p.length===2&&p.every(Number.isFinite)));assert.ok(radius>=CHARACTER.radius+.15&&radius<=1,'Lower passage radius must cover the complete character safety footprint');const polygons=axis.map(p=>disk(p,radius));
  for(let i=1;i<axis.length;i++){const a=axis[i-1]!,b=axis[i]!,length=Math.hypot(b[0]-a[0],b[1]-a[1]);assert.ok(length>1e-6,'Duplicate lower passage axis points');const nx=-(b[1]-a[1])*radius/length,nz=(b[0]-a[0])*radius/length;polygons.push(ring([[a[0]+nx,a[1]+nz],[b[0]+nx,b[1]+nz],[b[0]-nx,b[1]-nz],[a[0]-nx,a[1]-nz]]));}
  return union(polygons);
}
export function sourceLowerBridgeAxis(osm:any,wayId:number,fromNodeId:number,toNodeId:number,origin:WorldManifest['origin']){
  const ways=osm.elements?.filter((e:any)=>e.type==='way'&&e.id===wayId);assert.ok(ways?.length===1,'Lower passage way identity missing or duplicated');const way=ways[0];assert.ok(isSupportedSurfaceWay(way.tags??{})&&['footway','pedestrian','path','cycleway'].includes(way.tags?.highway),'Lower passage is not an accessible source surface path');assert.ok(!['no','private'].includes(way.tags?.foot)&&!['no','private'].includes(way.tags?.access),'Lower passage is not public walking access');
  const from=way.nodes.indexOf(fromNodeId),to=way.nodes.indexOf(toNodeId);assert.ok(from>=0&&to>=0&&from!==to,'Lower passage endpoints must be actual way members');const ids=way.nodes.slice(Math.min(from,to),Math.max(from,to)+1);if(from>to)ids.reverse();const nodes=new Map<number,any>();for(const node of osm.elements.filter((e:any)=>e.type==='node')){assert.ok(!nodes.has(node.id),'Duplicate OSM node');nodes.set(node.id,node);}
  const axis:Point[]=ids.map((id:number)=>{const node=nodes.get(id);assert.ok(node&&Number.isFinite(node.lat)&&Number.isFinite(node.lon),'Missing lower passage source node');const[e,n]=geodeticToGk25(node.lat,node.lon);return[e-origin.originProjected[0],origin.originProjected[1]-n];});
  return{axis,proof:{wayId,fromNodeId,toNodeId,nodeIds:ids,sourceWaySha256:sourceSha256(JSON.stringify(way)),sourceNodesSha256:sourceSha256(JSON.stringify(ids.map((id:number)=>nodes.get(id)))),originId:origin.id}};
}
/** Exact planar intersections certify clearance only over the source-axis body
 * corridor. A higher abutment elsewhere in the same municipal part is not an
 * underpass, and cannot force the upper deck to be raised or lower terrain cut. */
export interface ScopedBridgePassageInput {axis:readonly Point[];bodyRadiusMetres:number;sourceParts:readonly LayeredSourcePart[];native:readonly ExtraBridgeNativeFace[];upperFloors:readonly SupportTriangle[];deckThicknessMetres:number;minimumClearanceMetres:number}
export function qualifyScopedBridgePassage(options:ScopedBridgePassageInput){return qualifyScopedBridgeGeometry(options,.75);}
function qualifyScopedBridgeGeometry(options:ScopedBridgePassageInput,minimumNormalY:.75|0){
  assert.ok(options.deckThicknessMetres>=.25&&options.deckThicknessMetres<=1.2);assert.ok(options.minimumClearanceMetres>=2.2&&options.minimumClearanceMetres<=5.5);assert.ok(options.sourceParts.length>0&&new Set(options.sourceParts.map(p=>p.id)).size===options.sourceParts.length);
  const corridor=bridgePassageBodyCorridor(options.axis,options.bodyRadiusMetres),sourceDomain=union(options.sourceParts.map(p=>p.rings)),upper=union(options.upperFloors.map(triangle));assert.ok(area(polygonClipping.difference(corridor,sourceDomain))<=1e-8,'Character corridor leaves the named municipal lower path');
  for(const endpoint of[options.axis[0]!,options.axis.at(-1)!])assert.ok(area(polygonClipping.intersection([disk(endpoint,options.bodyRadiusMetres)],upper))<=1e-8,'Lower passage must include both external approach footprints');assert.ok(area(polygonClipping.intersection(corridor,upper))>0,'Lower passage does not cross the upper source deck');
  const zeroAreaFaces:{cell:string;collider:string;triangle:number;sha256:string}[]=[];
  const native=options.native.filter(face=>{if(!['ground','kerbs'].includes(face.group)||!sourcePartsForTriangle(face.points,options.sourceParts,face.tag).length)return false;const[a,b,c]=face.points;assert.ok(face.points.flat().every(Number.isFinite),'Nonfinite native lower floor');const u=b.map((v,i)=>v-a[i]!),v=c.map((n,i)=>n-a[i]!),cross=[u[1]!*v[2]!-u[2]!*v[1]!,u[2]!*v[0]!-u[0]!*v[2]!,u[0]!*v[1]!-u[1]!*v[0]!];if(cross.every(n=>n===0)){zeroAreaFaces.push({cell:face.cell,collider:face.collider,triangle:face.triangle,sha256:sourceSha256(JSON.stringify(face.points))});return false;}const normalY=supportNormal(face.points)[1];return minimumNormalY===0?normalY>0:normalY>=minimumNormalY;}),coverage=union(native.map(face=>triangle(face.points)));assert.ok(area(polygonClipping.difference(corridor,coverage))<=1e-8,'Source lower body corridor lacks complete native floor coverage');
  let intersections=0,minimum=Infinity;const witnesses=[];
  for(const face of native){const clipped=polygonClipping.intersection([triangle(face.points)],corridor);if(!clipped.length)continue;let count=0,faceMinimum=Infinity;
    for(const floor of options.upperFloors){const overlap=polygonClipping.intersection(clipped,[triangle(floor)]);for(const polygon of overlap)for(const r of polygon)for(const point of r){const clearance=supportHeight(floor,point)-options.deckThicknessMetres-supportHeight(face.points,point);assert.ok(clearance>=options.minimumClearanceMetres,`Source lower passage clearance ${clearance} at ${point.join(',')}`);minimum=Math.min(minimum,clearance);faceMinimum=Math.min(faceMinimum,clearance);intersections++;count++;}}
    if(count)witnesses.push({cell:face.cell,collider:face.collider,triangle:face.triangle,sha256:sourceSha256(JSON.stringify(face.points)),minimumClearanceMetres:faceMinimum,intersectionVertices:count});
  }
  assert.ok(intersections>0&&Number.isFinite(minimum),'No actual lower-under-upper clearance witnesses');return{status:'PASS_SCOPED_NATIVE_LOWER_CORRIDOR_PENDING_SERIALIZED_RUNTIME',bodyRadiusMetres:options.bodyRadiusMetres,minimumClearanceMetres:minimum,requiredClearanceMetres:options.minimumClearanceMetres,sourcePartIds:options.sourceParts.map(p=>p.id),sourcePartsSha256:sourceSha256(JSON.stringify(options.sourceParts)),axisSha256:sourceSha256(JSON.stringify(options.axis)),corridor,completeNativeBodyCoverage:true,externalApproachFootprintsCovered:true,nativeLowerFloorsUnmodified:true,zeroAreaFacesExcludedFromCoverage:zeroAreaFaces,witnesses};
}

/** A slope-transition exception is earned by executing the actual controller,
 * never by trusting a supplied passed flag or changing the legacy normal gate. */
export async function qualifyScopedBridgePassageWithNativeMotion(options:ScopedBridgePassageInput,motionInput:NativeBridgeMotionInput,motionPolicy:{maximumTrackErrorMetres:number}){
  assert.equal(options.deckThicknessMetres,motionInput.profile.deckThicknessMetres);
  assert.ok(motionPolicy.maximumTrackErrorMetres>0&&motionPolicy.maximumTrackErrorMetres<=.25);
  assert.ok(options.bodyRadiusMetres>=CHARACTER.radius+.15+motionPolicy.maximumTrackErrorMetres,'Transition corridor must also contain controller track deviation');
  const geometry=qualifyScopedBridgeGeometry(options,0),motion=await qualifyBridgeNativeMotion(motionInput,{axis:options.axis,lateralOffsets:[-.15,0,.15],maximumTrackErrorMetres:motionPolicy.maximumTrackErrorMetres,bodyRadiusMetres:options.bodyRadiusMetres},options.native);
  assert.deepEqual(motion.upperFloors,options.upperFloors,'Clearance deck differs from actual motion collision');
  return{...geometry,status:'PASS_SCOPED_NATIVE_CHARACTER_TRANSITIONS_PENDING_FINAL_SERIALIZED_WORLD',walkabilityPolicy:'Complete unchanged upward native floor coverage plus actual Character traversal in both directions at centre and +/-0.15m, with continuous expanded static capsule sweeps',motion:motion.proof};
}
