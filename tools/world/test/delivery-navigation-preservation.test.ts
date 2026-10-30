import test from 'node:test';
import assert from 'node:assert/strict';
import type {Vec3,RoadGraph} from '../../../packages/world-schema/src/index.ts';
import {protectedRoadPieces,assertCurrentPlayableNavigationPreserved} from '../lib/delivery-navigation-preservation.ts';
const coverage={playArea:{minX:0,minZ:0,maxX:10,maxZ:10}};
test('continuous protected pieces retain boundary interpolation while allowing outside geometry to move',()=>{
 const old:Vec3[]=[[-2,-2,5],[0,0,5],[5,5,5],[10,10,5],[12,12,5]],next:Vec3[]=[[-2,50,4],[0,0,5],[2,2,5],[7,7,5],[10,10,5],[12,60,6]];
 assert.deepEqual(protectedRoadPieces(old,coverage),[[[0,0,5],[10,10,5]]]);assert.deepEqual(protectedRoadPieces(next,coverage),protectedRoadPieces(old,coverage));
 next[1]=[0,.001,5];assert.notDeepEqual(protectedRoadPieces(next,coverage),protectedRoadPieces(old,coverage));
});
test('tiny holes, source bends and reversed protected order cannot disappear through sampling or simplification',()=>{
 const mask={...coverage,supportedArea:{schemaVersion:1 as const,regions:[{id:'land',outer:[[0,0],[10,0],[10,10],[0,10]] as [number,number][],holes:[[[4,4],[4.00001,4],[4.00001,6],[4,6]] as [number,number][]]}]}};
 const pieces=protectedRoadPieces([[-1,0,5],[11,0,5]],mask);assert.equal(pieces.length,2);assert.deepEqual(pieces[0],[[0,0,5],[4,0,5]]);assert.ok(Math.abs(pieces[1]![0]![0]-4.00001)<1e-12);
 assert.notDeepEqual(protectedRoadPieces([[0,0,5],[5,.001,5],[10,0,5]],coverage),protectedRoadPieces([[0,0,5],[10,0,5]],coverage));
 assert.notDeepEqual(protectedRoadPieces([[10,0,5],[0,0,5]],coverage),protectedRoadPieces([[0,0,5],[10,0,5]],coverage));
});
test('isolated boundary contacts are retained without admitting the outside chord',()=>{
 assert.deepEqual(protectedRoadPieces([[-1,0,4],[0,0,5],[-1,0,6]],coverage),[[[0,0,5]]]);
});
test('earlier expansion records and metadata stay literal while original protected chords stay continuous',()=>{
 const lane={id:'old',points:[[-2,0,5],[0,0,5],[10,0,5],[12,0,5]] as Vec3[],source:'literal'},original={originId:'fixture',nodes:[{id:'node'}],lanes:[lane],connectors:[],parking:[{id:'parking'}],footways:[]} as unknown as RoadGraph;
 const current=structuredClone(original);(current.lanes as unknown[]).push({id:'earlier-addition',points:[[2,0,6],[8,0,6]]});const next=structuredClone(current);(next.lanes[0] as unknown as {points:Vec3[]}).points=[[-2,1,4],[0,0,5],[5,0,5],[10,0,5],[12,1,6]];
 assert.equal(assertCurrentPlayableNavigationPreserved(current,next,coverage,original).earlierExpansionRecordsPreserved,1);
 for(const edit of[(g:RoadGraph)=>{(g.lanes[1]!.points as Vec3[])[0]=[2,.01,6];},(g:RoadGraph)=>{(g.lanes[0]!.points as Vec3[])[1]=[0,.01,5];},(g:RoadGraph)=>{(g.parking as unknown[]).length=0;},(g:RoadGraph)=>{(g.lanes[0] as unknown as {source:string}).source='changed';}]){const changed=structuredClone(next);edit(changed);assert.throws(()=>assertCurrentPlayableNavigationPreserved(current,changed,coverage,original));}
});
test('only the detached registered original lane may use its exact approved length',()=>{
 const lane={id:'old',points:[[-2,0,5],[0,0,5],[10,0,5],[12,0,5]] as Vec3[],length:14},original={originId:'fixture',nodes:[],lanes:[lane],connectors:[],parking:[],footways:[]} as unknown as RoadGraph;
 const registered=structuredClone(original),next=structuredClone(original);(registered.lanes[0] as unknown as {length:number}).length=14.01;(registered.lanes[0]!.points as Vec3[])[0]=[-2,0,4.95];(next.lanes[0] as unknown as {length:number}).length=14.01;(next.lanes[0]!.points as Vec3[])[0]=[-2,0,4.95];
 assert.throws(()=>assertCurrentPlayableNavigationPreserved(original,next,coverage,original),/metadata changed/);assert.doesNotThrow(()=>assertCurrentPlayableNavigationPreserved(original,next,coverage,original,registered));
 (next.lanes[0] as unknown as {length:number}).length=14.02;assert.throws(()=>assertCurrentPlayableNavigationPreserved(original,next,coverage,original,registered),/metadata changed/);
});

test('reviewed current Y baseline stays explicit and cannot change XZ, metadata or first-area additions',()=>{
 const original={originId:'fixture',nodes:[],lanes:[{id:'old',length:10,points:[[0,0,5],[10,0,5]]}],connectors:[],parking:[],footways:[]}as unknown as RoadGraph;
 const current=structuredClone(original);(current.lanes as unknown[]).push({id:'first-area',points:[[2,0,6],[8,0,6]]});
 const reviewed=structuredClone(current);(reviewed.lanes[0]as unknown as{points:Vec3[]}).points=[[0,0,5],[5,.1,5],[10,.2,5]];
 const next=structuredClone(reviewed);
 assert.throws(()=>assertCurrentPlayableNavigationPreserved(current,next,coverage,original));
 const proof=assertCurrentPlayableNavigationPreserved(current,next,coverage,original,original,reviewed);
 assert.equal(proof.continuousCurrentPlayableGeometryPreserved,false);assert.equal(proof.continuousReviewedCurrentPlayableGeometryPreserved,true);
 assert.equal(proof.reviewedHeightCorrections.length,1);assert.equal(proof.reviewedHeightCorrections[0]!.id,'old');assert.equal(proof.earlierExpansionRecordsPreserved,1);
 for(const edit of[(g:RoadGraph)=>{(g.lanes[0]!.points as Vec3[])[1]=[5,.1,5.001];},(g:RoadGraph)=>{(g.lanes[0]as unknown as{length:number}).length=10.01;},(g:RoadGraph)=>{(g.lanes[1]!.points as Vec3[])[0]=[2,.01,6];}]){
  const bad=structuredClone(reviewed);edit(bad);assert.throws(()=>assertCurrentPlayableNavigationPreserved(current,bad,coverage,original,original,bad));
 }
 (next.lanes[0]!.points as Vec3[])[1]=[5,.1001,5];assert.throws(()=>assertCurrentPlayableNavigationPreserved(current,next,coverage,original,original,reviewed));
});

test('reviewed collinear height subdivision crosses implicit coverage boundaries without new knots',()=>{
 const original={originId:'fixture',nodes:[],lanes:[{id:'old',length:14,points:[[-2,0,5],[6,0,5],[12,0,5]]}],connectors:[],parking:[],footways:[]}as unknown as RoadGraph;
 const reviewed=structuredClone(original);(reviewed.lanes[0] as unknown as {points:Vec3[]}).points=[[-2,0,5],[-1,.02,5],[3,.1,5],[6,.2,5],[9,.3,5],[12,.4,5]];
 assert.ok(reviewed.lanes[0]!.points.every(p=>p[0]!==0&&p[0]!==10));
 assert.throws(()=>assertCurrentPlayableNavigationPreserved(original,reviewed,coverage,original));
 const result=assertCurrentPlayableNavigationPreserved(original,reviewed,coverage,original,original,reviewed);assert.equal(result.reviewedHeightCorrections.length,1);
 for(const points of [[[-2,0,5],[-1,.02,5],[3,.1,5.001],[6,.2,5],[9,.3,5],[12,.4,5]],[[-2,0,5],[6,.2,5],[3,.1,5],[9,.3,5],[12,.4,5]]] as Vec3[][]){const bad=structuredClone(reviewed);(bad.lanes[0] as unknown as {points:Vec3[]}).points=points;assert.throws(()=>assertCurrentPlayableNavigationPreserved(original,bad,coverage,original,original,bad));}
});
