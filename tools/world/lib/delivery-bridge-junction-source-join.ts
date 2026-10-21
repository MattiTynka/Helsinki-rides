import assert from 'node:assert/strict';
import {pointInPolygon} from './geometry.ts';
import type {JunctionSideEdgeJoin} from './delivery-bridge-junction-skins.ts';

/** The municipal relation is independent of the native-edge attachment.
 * A seam inside a named source carriageway must never be reported as its
 * boundary merely because a nearby ring edge was found. */
export function validateJunctionMunicipalJoin(join:JunctionSideEdgeJoin,partId:number,rings:[number,number][][]){
 const ref=join.municipalBoundary;assert.equal(ref.partId,partId);
 const ring=rings[ref.ringIndex];assert.ok(ring&&Number.isSafeInteger(ref.edgeIndex)&&ref.edgeIndex>=0&&ref.edgeIndex+1<ring.length);
 assert.deepEqual(ref.points,[ring[ref.edgeIndex],ring[ref.edgeIndex+1]],'Native join changed its literal municipal edge');
 const [a,b]=ref.points,dx=b[0]-a[0],dz=b[1]-a[1],lengthSquared=dx*dx+dz*dz;assert.ok(lengthSquared>0);
 const distance=(p:readonly number[])=>{const t=Math.max(0,Math.min(1,((p[0]!-a[0])*dx+(p[2]!-a[1])*dz)/lengthSquared));return Math.hypot(p[0]!-a[0]-dx*t,p[2]!-a[1]-dz*t);};
 const points=[...join.newBank,...join.literalOldBank],actual=Math.max(...points.map(distance));assert.equal(actual,join.municipalRelation.maximumDistanceMetres,'Municipal relation span changed');
 if(join.municipalRelation.kind==='source-boundary')assert.ok(actual<=.002,'An interior native seam was mislabeled as a municipal boundary');
 else{assert.equal(join.municipalRelation.kind,'interior-source-seam');for(const p of points)assert.ok(pointInPolygon([p[0],p[2]],rings),'An interior seam leaves its named carriageway source');}
 return{kind:join.municipalRelation.kind,maximumDistanceMetres:actual,sourcePartId:partId};
}
