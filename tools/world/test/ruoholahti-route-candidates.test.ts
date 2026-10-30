import assert from 'node:assert/strict';import {test} from 'node:test';
import type {RoadGraph,RoadLane,RoadConnector} from '../../../packages/world-schema/src/index.ts';
import {prepareRuoholahtiRouteCandidates,type RuoholahtiRoutePlan} from '../lib/ruoholahti-route-candidates.ts';
import {sourceSha256} from '../lib/source-files.ts';
const hash=(v:unknown)=>sourceSha256(JSON.stringify(v));
function fixture(){
  const ways:{type:string;id:number;nodes:number[];tags:Record<string,string>}[]=[{type:'way',id:1,nodes:[1,2],tags:{highway:'residential'}},{type:'way',id:2,nodes:[2,3],tags:{highway:'residential',bridge:'yes',layer:'1'}},{type:'way',id:3,nodes:[3,4],tags:{highway:'residential'}}];
  const lane=(wayId:number,from:number,to:number):RoadLane=>({id:`${wayId}:0:f0`,wayId,from:`n${from}`,to:`n${to}`,index:0,count:1,name:'Test public street',highway:'residential',surface:'asphalt',speedLimit:8,width:3,points:[[from,0,0],[to,0,0]],length:1});
  const lanes=[lane(1,1,2),lane(2,2,3),lane(3,3,4)];
  const connector=(a:RoadLane,b:RoadLane):RoadConnector=>({id:`${a.id}>${b.id}`,node:a.to,from:a.id,to:b.id,turn:'straight',points:[a.points.at(-1)!,b.points[0]!],length:0});
  const candidate={lanes,connectors:[connector(lanes[0]!,lanes[1]!),connector(lanes[1]!,lanes[2]!)],footways:[],nodes:[],parking:[]} as unknown as RoadGraph,accepted={...candidate,lanes:[lanes[0]!,lanes[2]!],connectors:[]} as RoadGraph;
  const plan:RuoholahtiRoutePlan={boundsXZ:[0,-2,5,2],routes:[{id:'crossing',laneGoals:['1:0:f0','3:0:f0']}],bridges:[{wayId:2,sourceWaySha256:hash(ways[1]),profileSha256:'a'.repeat(64),serializedManifestSha256:'b'.repeat(64),transitions:[{nodeId:2,otherWayId:1},{nodeId:3,otherWayId:3}]}]};
  return{ways,candidate,accepted,plan};
}
test('source-bound upper bridge connects only through both exact shared-node approaches',()=>{const f=fixture(),r=prepareRuoholahtiRouteCandidates(f.accepted,f.candidate,f.ways,f.plan);assert.deepEqual(r.newLaneIds,['2:0:f0']);assert.equal(r.levelTransitions.length,2);assert.match(r.status,/PENDING_SERIALIZED/);
  const wrong={...f.candidate,connectors:f.candidate.connectors.map((c,i)=>i===0?{...c,node:'n999'}:c)};assert.throws(()=>prepareRuoholahtiRouteCandidates(f.accepted,wrong,f.ways,f.plan),/No source-connected/);
});
test('bridge provenance, source access and separate levels fail closed',()=>{const f=fixture();assert.throws(()=>prepareRuoholahtiRouteCandidates(f.accepted,f.candidate,f.ways,{...f.plan,bridges:[]}),/No source-connected/);
  const wrong=structuredClone(f.plan);wrong.bridges[0]!.sourceWaySha256='c'.repeat(64);assert.throws(()=>prepareRuoholahtiRouteCandidates(f.accepted,f.candidate,f.ways,wrong),/source identity/);
  const privateWays=structuredClone(f.ways);privateWays[1]!.tags={...privateWays[1]!.tags,access:'private'};const privatePlan=structuredClone(f.plan);privatePlan.bridges[0]!.sourceWaySha256=hash(privateWays[1]);assert.throws(()=>prepareRuoholahtiRouteCandidates(f.accepted,f.candidate,privateWays,privatePlan),/No source-connected/);
});
test('accepted identity and bounded source corridor cannot be silently changed',()=>{const f=fixture(),changed={...f.candidate,lanes:f.candidate.lanes.map((l,i)=>i===0?{...l,to:'n20'}:l)};assert.throws(()=>prepareRuoholahtiRouteCandidates(f.accepted,changed,f.ways,f.plan),/accepted source segmentation/);
  const escaped={...f.candidate,connectors:f.candidate.connectors.map((c,i)=>i===0?{...c,points:[[2,0,10],[2,0,0]] as [number,number,number][]}:c)};assert.throws(()=>prepareRuoholahtiRouteCandidates(f.accepted,escaped,f.ways,f.plan),/No source-connected/);
});
test('named withheld lane removes a route and is bound to the exact candidate record',()=>{const f=fixture(),plan={...f.plan,withheldLanes:[{id:'2:0:f0',recordSha256:hash(f.candidate.lanes[1]),reason:'Unqualified longitudinal transit-strip use is withheld.'}]};
  assert.throws(()=>prepareRuoholahtiRouteCandidates(f.accepted,f.candidate,f.ways,plan),/No source-connected/);
  plan.withheldLanes[0]!.recordSha256='a'.repeat(64);assert.throws(()=>prepareRuoholahtiRouteCandidates(f.accepted,f.candidate,f.ways,plan),/Withheld source lane changed/);
});
