// Opt-in walking verification policy; the original route geometry remains literal.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {DETOUR_POLICY,openPedestrianDetours} from './lib/walk-pedestrian-detour.mjs';
import {sourceSha256,writeSourceJson} from './lib/source-files.ts';
const {values}=parseArgs({options:{world:{type:'string'},plan:{type:'string'},failure:{type:'string'},evidence:{type:'string'},out:{type:'string'}}});
for(const k of['world','plan','failure','evidence','out'])assert.ok(values[k]);assert.ok(!fs.existsSync(values.out)&&!fs.existsSync(values.evidence));
const pin=file=>({file:path.relative(process.cwd(),path.resolve(file)).replaceAll('\\','/'),sha256:sourceSha256(fs.readFileSync(file))});
const plan=JSON.parse(fs.readFileSync(values.plan)),failure=JSON.parse(fs.readFileSync(values.failure)),state=failure.failureView.state;
const route=plan.routes.find(r=>failure.samples.at(-1).label.startsWith(`walk:${r.id}:`));assert.ok(route);const label=failure.samples.at(-1).label.slice(`walk:${route.id}:`.length),index=route.waypoints.findIndex(w=>w.label===label);assert.ok(index>=0);
const config={policy:DETOUR_POLICY,manifestSha256:pin(values.world+'/manifest.json').sha256,staticRouteQualification:plan.binding.staticRouteQualification,streetParts:[pin('../sources/raw-v2/street-parts/southwest-cumulative-20261029.geojson'),pin('content/helsinki/city-expansion-20261021/street-parts-public-v1.geojson')],osm:pin('../sources/raw-v2/osm/southwest-cumulative-20261029.json'),roadMerge:pin('../evidence/stage-a-road-walk-merge-cumulative-v1/road-merge-receipt.json'),walkingExceptions:[{wayId:694281002}]};
assert.equal(config.manifestSha256,failure.manifestSha256);assert.equal(sourceSha256(JSON.stringify(plan.routes)),sourceSha256(JSON.stringify(JSON.parse(fs.readFileSync(values.plan)).routes)));
const scene=await openPedestrianDetours(values.world,config);
try{const result=await scene.plan(state,route.waypoints.slice(index));assert.equal(result?.status,'SOURCE_STATIC_PARKING_AND_CAPTURED_CHARACTER_DETOUR_QUALIFIED_REAL_KEYBOARD_PENDING');scene.verify();fs.mkdirSync(values.evidence,{recursive:true});const qualification=writeSourceJson(values.evidence,'qualification.json',{schemaVersion:1,inputPlan:pin(values.plan),failure:pin(values.failure),config,producerClosure:scene.producerClosure,result});
plan.pedestrianDetours={...config,producerClosure:scene.producerClosure};plan.binding.pedestrianDetourQualification={file:pin(path.join(values.evidence,qualification.path)).file,sha256:qualification.sha256};plan.evidencePolicy+=' When a live pedestrian blocks progress for two seconds, the verifier may author a bounded public-paving detour after fresh source, 0.44 m capsule, parked/current vehicle, supported-area and continuous native Character checks. Only a wholly occupied 0.06 m arrival disk may be replaced, recorded with its observed occupant; protected captures remain exact. Every chosen bend is reached by real camera and keyboard controls. Twelve attempts maximum, 2 m lateral bound and 8 m local extent; failure to qualify does not alter the world or widen arrival/collision tolerances.';
fs.writeFileSync(values.out,JSON.stringify(plan,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({plan:pin(values.out),qualification:{file:path.join(values.evidence,qualification.path).replaceAll('\\','/'),sha256:qualification.sha256},replaced:result.replaced.map(p=>p.label),offset:result.offsetMetres,motions:result.motions,producerFiles:new Set(scene.producerClosure.flatMap(c=>Object.keys(c.files))).size}));
}finally{scene.close();}
