// Source/route preparation only. Writes no world payloads or accepted graph.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {decodeRoadGraph,parseCollisionBundle} from '../../packages/world-schema/src/index.ts';
import {prepareRuoholahtiRouteCandidates} from './lib/ruoholahti-route-candidates.ts';
import {readDeliveryFile} from './lib/delivery-city.ts';
import {decodeDeliverySimulation} from './lib/delivery-city-payloads.ts';
import {sourceSha256 as sha,writeSourceJson} from './lib/source-files.ts';
import {bindDeliveryProducer,publicDeliveryProducer,verifyDeliveryProducer} from './lib/delivery-city-provenance.ts';

const {values}=parseArgs({options:{plan:{type:'string'},out:{type:'string'}}});
assert.ok(values.plan&&values.out&&!fs.existsSync(values.out),'--plan and fresh --out required');
const producer=bindDeliveryProducer(new URL(import.meta.url));
const pins:{file:string;sha256:string}[]=[];
function read(ref:{file:string;sha256:string}){assert.match(ref.sha256,/^[a-f0-9]{64}$/);const info=fs.statSync(ref.file);assert.ok(info.isFile()&&info.size<128*1024*1024);const bytes=fs.readFileSync(ref.file);assert.equal(sha(bytes),ref.sha256,`Input changed: ${ref.file}`);pins.push(ref);return JSON.parse(bytes.toString());}
const planPin={file:values.plan,sha256:sha(fs.readFileSync(values.plan))},plan=read(planPin);
assert.deepEqual(Object.keys(plan).sort(),['accepted','boundsXZ','bridgeProfile','candidateRoads','kind','levelInventory','osm','routes','schemaVersion','serializedFloorWorld',...(plan.withheldLanes===undefined?[]:['withheldLanes'])].sort());
assert.equal(plan.schemaVersion,1);assert.equal(plan.kind,'ruoholahti-public-route-candidates');
const acceptedManifest=read({file:path.join(plan.accepted.directory,'manifest.json'),sha256:plan.accepted.manifestSha256});
const accepted=decodeRoadGraph(decodeDeliverySimulation(readDeliveryFile(plan.accepted.directory,acceptedManifest.roads),acceptedManifest.roads));
const candidate=read(plan.candidateRoads),osm=read(plan.osm),profile=read(plan.bridgeProfile),inventory=read(plan.levelInventory);
assert.equal(candidate.source.sha256,plan.osm.sha256);assert.equal(profile.sources.osm.sha256,plan.osm.sha256);
const finalManifest=read({file:path.join(plan.serializedFloorWorld.directory,'manifest.json'),sha256:plan.serializedFloorWorld.manifestSha256});
assert.equal(finalManifest.origin.id,acceptedManifest.origin.id);assert.equal(profile.id,'selkamerensilta');assert.equal(profile.frameAxis.wayId,27192169);
assert.equal(inventory.world.sha256,plan.serializedFloorWorld.manifestSha256);assert.equal(inventory.profile.sha256,plan.bridgeProfile.sha256);assert.equal(inventory.candidateRoads.sha256,plan.candidateRoads.sha256);
assert.equal(finalManifest.publicationFiles.find((r:any)=>r.path==='publication/extra-bridges/selkamerensilta/profile.json')?.sha256,plan.bridgeProfile.sha256);
// A selector candidate cannot outlive even one changed serialized face.
const floorGroups=[inventory.upperRoad,inventory.upperWalking,inventory.northernLower];assert.ok(floorGroups.every(group=>group.length>0));
for(const ref of inventory.cells){const cell=finalManifest.cells.find((c:any)=>c.id===ref.cell);assert.ok(cell);assert.deepEqual(cell.collision,ref.collision);const bytes=decodeDeliverySimulation(readDeliveryFile(plan.serializedFloorWorld.directory,cell.collision),cell.collision),bundle=parseCollisionBundle(bytes);
  for(const face of floorGroups.flat().filter(t=>t.cell===cell.id)){const collider=bundle.colliders.find(c=>c.id===face.collider);assert.ok(collider&&collider.group==='ground');const index=face.triangle*3;assert.ok(index>=0&&index+3<=collider.indices.length);const points=Array.from(collider.indices.subarray(index,index+3),i=>Array.from(collider.positions.subarray(i*3,i*3+3)));assert.deepEqual(points,face.points);assert.equal(sha(JSON.stringify(points)),face.triangleSha256);assert.equal(bundle.header.surfaceTags[collider.triangleTags[face.triangle]!],face.tag);}}
const sourceWay=osm.elements.find((e:any)=>e.type==='way'&&e.id===27192169);assert.ok(sourceWay);
const bridge={wayId:27192169,sourceWaySha256:sha(JSON.stringify(sourceWay)),profileSha256:plan.bridgeProfile.sha256,serializedManifestSha256:plan.serializedFloorWorld.manifestSha256,transitions:[{nodeId:292738276,otherWayId:22981559},{nodeId:298392332,otherWayId:1521846400}]};
const result=prepareRuoholahtiRouteCandidates(accepted,candidate,osm.elements,{boundsXZ:plan.boundsXZ,routes:plan.routes,bridges:[bridge],withheldLanes:plan.withheldLanes});
assert.ok(!candidate.footways.some((w:any)=>w.id==='w124124301'),'Hidden southern passage must be omitted from candidate graph');
for(const ref of pins)assert.equal(sha(fs.readFileSync(ref.file)),ref.sha256);verifyDeliveryProducer(producer);
fs.mkdirSync(values.out,{recursive:true});
const written=writeSourceJson(values.out,'route-candidates.json',{...result,planPin,candidateRoads:plan.candidateRoads,osm:plan.osm,acceptedManifestSha256:plan.accepted.manifestSha256,serializedFloorWorld:plan.serializedFloorWorld,levelInventory:plan.levelInventory,bridge,producer:publicDeliveryProducer(producer),exclusions:[{wayId:124124301,name:'Southern Selkamerensilta hidden lower passage',reason:'Unobserved floor; source-bound physical closure beneath retained upper deck.'},{name:'Other bridge, tunnel, highway, service or private driveway routes',reason:'Not admitted by this bounded source selection; rejectedLanes records exact source IDs.'}],remaining:['Project selected routes against exact serialized floor with per-record upper/lower selectors.','Compose source-contained public land with measured upper bridge floors and qualified northern lower corridor.','Check every new/exposed retained route with all accepted vehicle footprints and walking capsules.','Actual final-world keyboard driving, walking, level separation and closure checks.']});
console.log(JSON.stringify({file:path.join(values.out,written.path),sha256:written.sha256,retained:result.retainedLaneIds.length,new:result.newLaneIds.length,connectors:result.connectorIds.length,routes:result.routes.map(r=>({id:r.id,metres:r.lengthMetres,names:r.names}))}));
