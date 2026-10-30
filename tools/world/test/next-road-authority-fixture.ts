import assert from 'node:assert/strict';import fs from 'node:fs';
import {decodeRoadGraph,type RoadGraph}from '../../../packages/world-schema/src/index.ts';
import{decodeDeliverySimulation}from '../lib/delivery-city-payloads.ts';import{readSourceFile,sourceSha256}from '../lib/source-files.ts';
import{prepareAdditionalRoadInheritance,additionalInheritedWalkingSources}from '../lib/inherited-road-bundle-context.ts';
import{prepareRoadInheritance,composeReviewedRoadBaselines}from '../lib/road-inheritance-context.ts';
import{loadGeoJsonPolygons}from '../lib/geometry.ts';
export const nextFixtureAvailable=fs.existsSync('../work/inherited-next-bundle-integration-v1/projection-plan.json');
export const hash=(v:unknown)=>sourceSha256(JSON.stringify(v));
export const read=(p:{file:string;sha256:string},cap=128*1024*1024)=>{const stat=fs.lstatSync(p.file);assert.ok(stat.isFile()&&!stat.isSymbolicLink()&&stat.size>0&&stat.size<=cap);const b=fs.readFileSync(p.file);assert.equal(sourceSha256(b),p.sha256);return b;};
export const pin=(file:string)=>({file,sha256:sourceSha256(fs.readFileSync(file))});
let cached:any;
export function nextFixture(){if(cached)return cached;
 const plan=JSON.parse(fs.readFileSync('../work/inherited-next-bundle-integration-v1/projection-plan.json','utf8')),originalWorld={directory:plan.acceptedWorld,manifestSha256:plan.expectedManifestSha256},currentWorld=plan.serializedFloorWorld,manifest=(w:any)=>JSON.parse(fs.readFileSync(w.directory+'/manifest.json','utf8')),om=manifest(originalWorld),cm=manifest(currentWorld),graph=(w:any,m:any)=>decodeRoadGraph(decodeDeliverySimulation(readSourceFile(w.directory,m.roads),m.roads)),original=graph(originalWorld,om),current=graph(currentWorld,cm),coverage=JSON.parse(decodeDeliverySimulation(readSourceFile(originalWorld.directory,om.gameplay),om.gameplay).toString()),expanded=plan.expandedCoverage;
 const context={original,current,originalWorld,currentWorld,sourcePins:{osmSha256:'a6bf71bae890ab60b4249c8546e6b7185ce37c9ede4137e9c4aefbd9a755e65a',streetPartsSha256:'1ac1409cf70cd6c3ad1ab7139fd6f365898d5c654e499616a1892d1b669645b2'},otherRegistrationIds:['59804323:0:f0'],coverage:expanded};
 const additional=prepareAdditionalRoadInheritance(plan.inheritedRoadHeightBundle,context),first=prepareRoadInheritance(plan.inheritedRoadHeight,{...context,otherRegistrationIds:additional.witnesses.map(w=>w.id)}),composition=composeReviewedRoadBaselines(original,coverage,undefined,{authority:first.authority,current},{authority:additional.authority,current});
 const metadata=JSON.parse(read(plan.nativeMetadata).toString()),parts=loadGeoJsonPolygons(metadata.inputs.streetParts.path,om.origin.originProjected[0],om.origin.originProjected[1],p=>String(p.osan_id)),osm=JSON.parse(fs.readFileSync('../sources/raw-v2/osm/southwest-cumulative-20261029.json','utf8'));
 const sources=additionalInheritedWalkingSources(additional.authority,original,current,['59804323:0:f0']);
 return cached={plan,originalWorld,currentWorld,om,cm,original,current,coverage,expanded,context,additional,first,composition,metadata,parts,osm,sources};
}
