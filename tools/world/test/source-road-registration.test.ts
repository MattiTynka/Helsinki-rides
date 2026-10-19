import assert from 'node:assert/strict';
import {readFileSync}from 'node:fs';
import test from 'node:test';
import{sourceAlignmentField,alignLaneEndpoint}from '../lib/source-lane-alignment.ts';
import{applySourceRoadRegistrations,vehicleSourceProof,type RoadRegistrations}from '../lib/source-road-registration.ts';
import{verifyUnsupportedPortalComponent}from '../lib/unsupported-portal-component.ts';
import type{LocalPolygon}from '../lib/geometry.ts';
import type{RoadLane,RoadNode}from '../../../packages/world-schema/src/index.ts';

const fixture=JSON.parse(readFileSync(new URL('./fixtures/source-road-registration.json',import.meta.url),'utf8')) as{parts:LocalPolygon[];declarations:RoadRegistrations&{portalComponents:{portalWayId:number;wayIds:number[];reason:string}[]};lanes:RoadLane[];nodes:RoadNode[];portalElements:{type:string;id:number;nodes:number[];tags:Record<string,string>}[]};

test('measured source Jaakonkatu preserves both lane tracks using one registration',()=>{
 const d=fixture.declarations.endpointAlignments.find(d=>d.wayId===124128289)!,field=sourceAlignmentField(d,fixture.parts),lanes=fixture.lanes.filter(l=>l.wayId===d.wayId),points=lanes.map(l=>{const p=l.to===`n${d.endpointNodeId}`?l.points.at(-1)!:l.points[0]!;return[p[0],-p[2]] as[number,number];}),match=field.nearestShared(points);
 assert.deepEqual(match.shift,[-1,-.5]);assert.ok(match.clearance>=1.067);
 assert.equal(Math.hypot(points[0]![0]-points[1]![0],points[0]![1]-points[1]![1]),Math.hypot(points[0]![0]+match.shift[0]-points[1]![0]-match.shift[0],points[0]![1]+match.shift[1]-points[1]![1]-match.shift[1]));
 const before=JSON.stringify(fixture.parts),lane=lanes[0]!,fit=alignLaneEndpoint(lane.points,'start',field,()=>0,match.shift);assert.ok(fit.points.length>2);assert.equal(JSON.stringify(fixture.parts),before);
});
test('explicit park driveway stays outside source walls with actual vehicle margin',()=>{
 const d=fixture.declarations.endpointAlignments.find(d=>d.wayId===313613088)!,field=sourceAlignmentField(d,fixture.parts),q:[number,number]=[-1131.383,394.307],match=field.nearestShared([q,q]);
 assert.deepEqual(match.shift,[-.25,1.5]);assert.ok(field.safe([q[0]+match.shift[0],q[1]+match.shift[1]]));assert.ok(!field.safe([-1132.4,394.5]));
});
test('reviewed survey classes fail closed and do not turn source grass into a road',()=>{
 const d=fixture.declarations.endpointAlignments[0]!;
 assert.throws(()=>sourceAlignmentField({...d,partIds:['absent']},fixture.parts),/reviewed surveyed/);
 assert.throws(()=>sourceAlignmentField({...d,partIds:['200599']},fixture.parts),/reviewed surveyed/);
 assert.throws(()=>sourceAlignmentField({...d,partIds:['48719']},fixture.parts),/reviewed surveyed/);
 assert.doesNotThrow(()=>sourceAlignmentField({...d,partIds:['48719'],pedestrianPartIds:['48719']},fixture.parts));
});
test('source width exception supports the accepted tyres and refuses off-source wheels',()=>{
 const d=fixture.declarations.fullCorridors[0]!,field=sourceAlignmentField({wayId:d.wayId,endpointNodeId:d.nodeIds[1],endpoint:'end',partIds:d.partIds,clearanceMetres:1.017,maxShiftMetres:8,blendMetres:10,reason:d.reason},fixture.parts);
 assert.ok(field.safe([340.05,728]));assert.ok(field.clearance([340.05,728])<1.067);
 const proof=vehicleSourceProof([[342,0,-725.5],[342,0,-728]],field);assert.ok(proof.wheelFailures>0);
});
test('production source registrations keep exact source polygons and connected lane identities',()=>{
 const lanes=structuredClone(fixture.lanes),nodes=new Map(fixture.nodes.map(n=>[n.id,structuredClone(n)])),before=JSON.stringify(fixture.parts),ids=lanes.map(l=>l.id),result=applySourceRoadRegistrations({lanes,nodes,parts:fixture.parts,buildings:[],registrations:fixture.declarations,heightAt:()=>0});
 assert.deepEqual(lanes.map(l=>l.id),ids);assert.equal(JSON.stringify(fixture.parts),before);assert.ok(result.report.corridorProofs.every(p=>p.proof.wheelFailures===0));assert.equal(result.report.corridorProofs[0]!.proof.failures,0);
 assert.deepEqual(nodes.get('n10537715309')!.position,[340.01,0,-732]);
});
test('source portal component records its only vehicle connection without access inference',()=>{
 const d=fixture.declarations.portalComponents[0]!,allowed=new Set(['service','residential']),result=verifyUnsupportedPortalComponent(fixture.portalElements,d,allowed);
 assert.deepEqual(result.wayIds,[444344430,444344432]);assert.ok(result.boundaries.every(b=>b.wayId===444344429));
 const extra={type:'way',id:999,nodes:[fixture.portalElements.find(w=>w.id===444344430)!.nodes[2]!,888],tags:{highway:'residential'}};
 assert.throws(()=>verifyUnsupportedPortalComponent([...fixture.portalElements,extra],d,allowed),/another vehicle connection/);
 assert.throws(()=>verifyUnsupportedPortalComponent(fixture.portalElements,{...d,portalWayId:444344430},allowed),/Invalid/);
});
